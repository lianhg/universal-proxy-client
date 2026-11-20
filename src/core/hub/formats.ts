/**
 * 统一配置解析中心 —— 配置格式解析 + 格式自动判定
 *
 * 支持：Clash/Mihomo YAML、sing-box JSON、Xray/V2Ray JSON、WireGuard .conf、
 *       订阅返回体（Base64 批量 / YAML / JSON / 多行链接 / SSD）、
 *       v2rayn:// 及同类客户端包装格式、订阅/配置 URL。
 *
 * 安全边界：解析中心只做"识别 → 转换 → 预览"，遇到 URL 只返回 requiresFetch，
 * 绝不自动发起网络请求，也绝不自动执行导入的配置。
 */

import type {
  DetectedFormat, ImportReport, ParseIssue, Protocol, RejectedItem, Security,
  Transport, UnifiedNode,
} from './model.js';
import {
  decodeBase64Utf8, encodeBase64Utf8, isLikelyBase64, issue, looksLikeSSBody, makeNode, parseQuery,
  qStr, requireFields, safeJson, splitHostPort, isProxyLikeHttpUrl,
} from './util.js';
import { isShareLink, normAlpn, normSecurity, normTransport, parseShareLink, parseShareLinks } from './share-links.js';
import { extractListBlocks, listItemToYaml, parseYaml } from './yaml.js';

export interface FormatOutcome {
  nodes: UnifiedNode[];
  rejected: RejectedItem[];
  issues: ParseIssue[];
  requiresFetch?: ImportReport['requiresFetch'];
}

export interface FormatContext {
  source?: string;
  rawFormat?: DetectedFormat;
  location?: string;
  maxDepth?: number;
  _depth?: number;
}

/** 递归解包回调（由 index.ts 提供，避免循环依赖） */
export type RecurseFn = (text: string, ctx: FormatContext) => ImportReport;

export interface DetectResult {
  format: DetectedFormat;
  label: string;
  detail: string;
}

/* ================================ 协议名归一 ================================ */

const PROTO_MAP: Record<string, Protocol> = {
  vmess: 'vmess', vless: 'vless', trojan: 'trojan',
  ss: 'ss', shadowsocks: 'ss', ss2022: 'ss',
  ssr: 'ssr', shadowsocksr: 'ssr',
  socks: 'socks5', socks5: 'socks5', socks5h: 'socks5', socks4: 'socks4', socks4a: 'socks4',
  http: 'http', https: 'https', 'http-proxy': 'http',
  hysteria: 'hysteria', hy: 'hysteria', hysteria2: 'hysteria2', hy2: 'hysteria2',
  tuic: 'tuic', wireguard: 'wireguard', wg: 'wireguard',
  anytls: 'anytls', naive: 'naive', naïveproxy: 'naive', ssh: 'ssh',
};

export function normProtocol(v: unknown): Protocol | undefined {
  return PROTO_MAP[String(v ?? '').toLowerCase().trim()];
}

/** 非出站节点（路由选择器 / 直连 / 拒绝），不算导入失败但必须说明被跳过 */
const NON_NODE_TYPES = new Set(['selector', 'urltest', 'direct', 'block', 'dns', 'reject', 'load-balance', 'fallback', 'relay', 'blackhole', 'freedom', 'loopback']);

/* ================================ 通用小工具 ================================ */

function collectExtras(
  obj: Record<string, any>,
  consumed: Iterable<string>,
  location?: string,
): { extras: Record<string, unknown>; issues: ParseIssue[] } {
  const set = new Set(consumed);
  const extras: Record<string, unknown> = {};
  const issues: ParseIssue[] = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (set.has(k) || v === undefined || v === null || v === '') continue;
    extras[k] = v;
    issues.push(issue('info', 'UNKNOWN_FIELD',
      `字段「${k}」未映射到统一模型，原始值已完整保留在 extras（不会丢失，需人工确认是否影响连接）`,
      { field: k, value: v, location }));
  }
  return { extras, issues };
}

function applyExtras(node: UnifiedNode, extras: Record<string, unknown>, issues: ParseIssue[], location?: string): void {
  if (!Object.keys(extras).length) return;
  node.extras = { ...node.extras, ...extras };
  node.issues.push(...issues);
  node.lossless = false;
  node.issues.push(issue('warning', 'UNKNOWN_FIELD',
    `有 ${Object.keys(extras).length} 个参数未能映射到统一模型（${Object.keys(extras).join('、')}）；原始值已保留在 extras，导入前请核对`,
    { location }));
}

function reject(raw: string, reason: string, location?: string, code: ParseIssue['code'] = 'PARSE_ERROR'): RejectedItem {
  return { raw, reason, location, issues: [issue('error', code, reason, { location })] };
}

function hostPort(server: unknown, port: unknown, fallback = 443): { server: string; port: number } {
  const s = String(server ?? '').trim();
  const hp = splitHostPort(s, fallback);
  const p = Number(port ?? hp.port);
  return { server: hp.server, port: Number.isFinite(p) && p > 0 ? p : hp.port };
}

function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
}

/* ================================ 格式自动判定 ================================ */

export const WRAPPER_SCHEMES = [
  'v2rayn', 'v2rayng', 'sub', 'ssrsub', 'clash', 'clashmeta', 'clash-verge',
  'sing-box', 'shadowrocket', 'quantumult', 'surge', 'ssd',
] as const;

export function detectFormat(text: string): DetectResult {
  const raw = (text ?? '').trim();
  if (!raw) return { format: 'unknown', label: '空内容', detail: '没有可解析的内容' };

  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase() ?? '';
  if ((WRAPPER_SCHEMES as readonly string[]).includes(scheme)) {
    return { format: 'v2rayn-wrapper', label: `${scheme.toUpperCase()} 客户端包装格式`, detail: '需先解包，再按内容判定真实配置格式' };
  }
  // 多行分享链接优先于单行判定（否则批量订阅会被当成一条链接）
  const previewLines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
  if (previewLines.length > 1 && previewLines.some(l => isShareLink(l))) {
    return { format: 'share-link-batch', label: '多行分享链接（批量节点）', detail: `共 ${previewLines.length} 行` };
  }
  // HTTP(S) 既是 HTTP 代理分享链接，也可能是订阅地址：按结构区分，避免误报
  if (/^https?:\/\//i.test(raw) && !raw.includes('\n')) {
    if (!isProxyLikeHttpUrl(raw)) {
      const isConfigFile = /\.(json|ya?ml|conf|txt)(\?|$)/i.test(raw) || /[?&](config|url|token|sub)=/i.test(raw);
      return {
        format: 'subscription-url',
        label: isConfigFile ? '配置文件 URL' : '订阅地址',
        detail: '需要显式拉取；解析中心不会自动请求，也不会自动执行远端配置',
      };
    }
  }
  if (isShareLink(raw)) {
    return { format: 'share-link', label: '标准分享链接', detail: `协议前缀 ${scheme || '未识别'}` };
  }
  // JSON 配置
  if (/^[[{]/.test(raw)) {
    const obj = safeJson<any>(raw);
    if (obj) {
      if (Array.isArray(obj) && obj.length && (obj[0].type || obj[0].protocol)) {
        return { format: 'xray-json', label: 'Outbound 数组（JSON）', detail: '按 Xray / sing-box outbound 逐条解析' };
      }
      if (obj.outbounds && Array.isArray(obj.outbounds)) {
        const types = obj.outbounds.map((o: any) => String(o?.type ?? o?.protocol ?? '')).filter(Boolean);
        const singBoxOnly = types.some((t: string) => ['wireguard', 'anytls', 'hysteria2', 'tuic', 'naive', 'selector', 'urltest'].includes(t));
        const hasXrayShape = obj.outbounds.some((o: any) => o?.settings?.vnext || o?.streamSettings || o?.settings?.servers);
        if (singBoxOnly && !hasXrayShape) return { format: 'sing-box-json', label: 'sing-box 配置（JSON）', detail: '含 outbounds，按 sing-box schema 解析' };
        return { format: 'xray-json', label: 'Xray / V2Ray 配置（JSON）', detail: '含 outbounds / streamSettings，按 Xray schema 解析' };
      }
      if (obj.proxies || obj['proxy-providers']) return { format: 'clash-yaml', label: 'Clash 配置（JSON 写法）', detail: '含 proxies 列表' };
      if (obj.url || obj.config || obj.subscription) return { format: 'v2rayn-wrapper', label: '配置包装对象', detail: '含 url / config 字段，需解包' };
      if (obj.type || obj.protocol) return { format: 'xray-json', label: '单个 Outbound（JSON）', detail: '按单条出站解析' };
      return { format: 'unknown', label: '无法识别的 JSON', detail: 'JSON 语法合法，但既不含 outbounds / proxies，也不是节点对象' };
    }
  }
  if (/^\[Interface\]/im.test(raw)) return { format: 'wireguard-conf', label: 'WireGuard 配置（.conf）', detail: '含 [Interface] / [Peer] 段' };
  if (/^\s*proxies\s*:/im.test(raw)) return { format: 'clash-yaml', label: 'Clash / Mihomo 配置（YAML）', detail: '含 proxies 列表' };
  if (/^\s*(port|socks-port|mixed-port|mode|rules)\s*:/im.test(raw) && raw.includes('\n')) {
    return { format: 'clash-yaml', label: 'Clash 配置（YAML，未发现 proxies）', detail: '配置文件存在，但没有可导入的节点列表' };
  }
  // Base64 批量（订阅返回体 / 多节点二维码）
  if (!raw.includes('\n') && isLikelyBase64(raw)) {
    const decoded = decodeBase64Utf8(raw);
    if (decoded && (decoded.includes('://') || /^\s*proxies\s*:/im.test(decoded) || /^\s*[[{]/.test(decoded))) {
      return { format: 'subscription-content', label: 'Base64 订阅内容 / 批量节点', detail: '解码后为多行节点或完整配置，需二次判定' };
    }
    return { format: 'unknown', label: '无法识别的 Base64', detail: 'Base64 解码成功但内容不是节点链接、订阅或配置，拒绝误报成功' };
  }
  // 多行分享链接
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
  if (lines.length > 1 && lines.some(l => isShareLink(l))) {
    return { format: 'share-link-batch', label: '多行分享链接（批量节点）', detail: `共 ${lines.length} 行` };
  }
  if (lines.length === 1 && /^[a-z][a-z0-9+.-]*:\/\//i.test(lines[0])) {
    return { format: 'unknown', label: '不支持的链接协议', detail: `前缀 ${lines[0].split(':')[0]} 不在支持列表内` };
  }
  // 缺协议头的 Shadowsocks 链接主体（网页复制剥离 ss:// 是高频场景）：整体都像 SIP002 主体时
  // 转交分享链接通道，parseShareLink 会自动补全 ss://；认不出就不进这里，维持 unknown 拒绝。
  if (lines.length > 1 && lines.every(l => looksLikeSSBody(l))) {
    return { format: 'share-link-batch', label: 'Shadowsocks 分享链接（批量，缺 ss:// 协议头）', detail: `共 ${lines.length} 行，自动补全协议头解析` };
  }
  if (lines.length === 1 && looksLikeSSBody(lines[0])) {
    return { format: 'share-link', label: 'Shadowsocks 分享链接（缺 ss:// 协议头）', detail: 'SIP002 主体，自动补全协议头解析' };
  }
  return { format: 'unknown', label: '无法识别的内容', detail: '既不是分享链接、订阅内容，也不是已知配置文件格式；不会伪装成导入成功' };
}

/* ================================ Clash YAML ================================ */

const CLASH_CONSUMED = new Set([
  'name', 'type', 'server', 'port', 'cipher', 'method', 'password', 'uuid', 'alterId', 'alterid',
  'network', 'tls', 'sni', 'servername', 'alpn', 'fp', 'client-fingerprint', 'skip-cert-verify',
  'flow', 'encryption', 'packet-encoding', 'packet_encoding', 'udp', 'udp-over-tcp', 'tfo',
  'reality-opts', 'ws-opts', 'ws-path', 'ws-headers', 'grpc-opts', 'http-opts', 'h2-opts',
  'xhttp-opts', 'splithttp-opts', 'headers', 'path', 'host', 'serviceName', 'grpc-service-name',
  'plugin', 'plugin-opts', 'obfs', 'obfs-password', 'obfs-password', 'protocol', 'protocol-param',
  'obfs-param', 'auth', 'auth-str', 'auth_str', 'up', 'down', 'up-speed', 'down-speed',
  'congestion-controller', 'udp-relay-mode', 'reduce-rtt', 'request-timeout', 'max-open-streams',
  'heartbeat-interval', 'recv-window-conn', 'recv-window', 'disable-mtu-discovery', 'fast-open',
  'private-key', 'public-key', 'preshared-key', 'pre-shared-key', 'ip', 'ipv6', 'reserved',
  'peers', 'allowed-ips', 'mtu', 'dns', 'persistent-keepalive', 'remote-dns-resolve',
  'ca', 'ca-str', 'ports', 'hop-interval', 'sni', 'client-fingerprint', 'username',
  'private-key-passphrase', 'host-key', 'host-key-algorithms', 'servername', 'version',
  'token', 'ip-version', 'tcp-fast-open', 'disable-sni', 'allow-insecure', 'interface-name',
]);

function fromClashProxy(obj: Record<string, any>, ctx: FormatContext, raw: string): { node: UnifiedNode } | { rejected: RejectedItem } {
  const typeStr = String(obj.type ?? '').toLowerCase();
  const protocol = normProtocol(typeStr);
  if (!protocol || protocol === 'unknown') {
    return { rejected: reject(raw,
      `Clash 节点类型「${obj.type ?? '空'}」不在支持的协议列表内（已排除 direct/reject/snell 等非代理类型）；原配置已保留，不会误报成功`,
      ctx.location, 'UNSUPPORTED_PROTOCOL') };
  }

  const hp = hostPort(obj.server, obj.port, 443);
  const realityOpts = asRecord(obj['reality-opts']);
  const tlsEnabled = obj.tls === true || obj.tls === 'true' || !!realityOpts['public-key'];
  const alpn = normAlpn(obj.alpn);
  const tls: Record<string, unknown> = {};
  const sni = obj.sni ?? obj.servername ?? realityOpts['server-name'] ?? realityOpts.serverName;
  if (sni) tls.sni = String(sni);
  if (alpn) tls.alpn = alpn;
  const fp = obj.fp ?? obj['client-fingerprint'] ?? realityOpts.fingerprint;
  if (fp) tls.fingerprint = String(fp);
  if (obj['skip-cert-verify'] !== undefined) tls.allowInsecure = !!obj['skip-cert-verify'];

  const reality: Record<string, unknown> = {};
  if (realityOpts['public-key']) reality.publicKey = String(realityOpts['public-key']);
  if (realityOpts['short-id']) reality.shortId = String(realityOpts['short-id']);
  if (realityOpts['spider-x']) reality.spiderX = String(realityOpts['spider-x']);
  if (realityOpts['mldsa65-verify']) reality.mldsa65Verify = String(realityOpts['mldsa65-verify']);

  const wsOpts = asRecord(obj['ws-opts']);
  const grpcOpts = asRecord(obj['grpc-opts']);
  const httpOpts = asRecord(obj['http-opts']);
  const h2Opts = asRecord(obj['h2-opts']);
  const xhttpOpts = asRecord(obj['xhttp-opts'] ?? obj['splithttp-opts']);
  const ts: Record<string, unknown> = {};
  if (obj.network) ts.network = obj.network;
  if (obj.path) ts.path = obj.path;
  if (obj.host) ts.host = obj.host;
  if (wsOpts.path) ts.path = wsOpts.path;
  if (wsOpts.headers) ts.host = asRecord(wsOpts.headers).Host ?? asRecord(wsOpts.headers).host;
  if (wsOpts['max-early-data'] !== undefined) ts.maxEarlyData = wsOpts['max-early-data'];
  if (wsOpts['early-data-header-name']) ts.earlyDataHeaderName = wsOpts['early-data-header-name'];
  if (grpcOpts['grpc-service-name']) ts.serviceName = grpcOpts['grpc-service-name'];
  if (httpOpts.path) ts.path = Array.isArray(httpOpts.path) ? httpOpts.path : [httpOpts.path];
  if (httpOpts.headers) ts.headers = httpOpts.headers;
  if (h2Opts.host) ts.host = Array.isArray(h2Opts.host) ? h2Opts.host : [h2Opts.host];
  if (h2Opts.path) ts.path = h2Opts.path;
  if (xhttpOpts.path) ts.path = xhttpOpts.path;
  if (xhttpOpts.mode) ts.mode = xhttpOpts.mode;
  if (xhttpOpts.host) ts.host = xhttpOpts.host;
  if (xhttpOpts.headers) ts.headers = xhttpOpts.headers;
  if (obj.headers) ts.headers = { ...asRecord(ts.headers), ...asRecord(obj.headers) };
  const pluginMode = asRecord(obj['plugin-opts']).mode;
  let transport: Transport = normTransport(obj.network ?? (pluginMode === 'websocket' ? 'ws' : 'tcp'));
  if (obj['xhttp-opts'] || obj['splithttp-opts']) transport = 'xhttp';
  if (['wireguard', 'hysteria', 'hysteria2', 'tuic'].includes(String(obj.type).toLowerCase())) {
    transport = obj.type === 'wireguard' ? 'none' : 'quic';
  }

  const ps: Record<string, unknown> = {};
  for (const k of ['plugin', 'plugin-opts', 'obfs', 'obfs-password', 'protocol', 'protocol-param',
    'obfs-param', 'auth', 'auth-str', 'up', 'down', 'congestion-controller', 'udp-relay-mode',
    'reduce-rtt', 'request-timeout', 'private-key', 'public-key', 'preshared-key', 'pre-shared-key',
    'ip', 'ipv6', 'reserved', 'peers', 'allowed-ips', 'mtu', 'dns', 'persistent-keepalive',
    'ca', 'ca-str', 'ports', 'hop-interval', 'username', 'host-key', 'host-key-algorithms',
    'version', 'token', 'disable-sni', 'allow-insecure', 'udp', 'packet-encoding', 'flow']) {
    if (obj[k] !== undefined) ps[k] = obj[k];
  }

  const node = makeNode({
    protocol, protocolAlias: String(obj.type),
    server: hp.server, port: hp.port,
    name: String(obj.name ?? '') || `${hp.server}:${hp.port}`,
    uuid: obj.uuid ? String(obj.uuid) : undefined,
    password: obj.password ?? obj.auth ?? obj.token ? String(obj.password ?? obj.auth ?? obj.token) : undefined,
    method: obj.cipher ?? obj.method ? String(obj.cipher ?? obj.method) : undefined,
    alterId: obj.alterId !== undefined ? Number(obj.alterId) : undefined,
    transport,
    security: realityOpts['public-key'] ? 'reality' : (tlsEnabled ? 'tls' : 'none'),
    tls: Object.keys(tls).length ? (tls as UnifiedNode['tls']) : undefined,
    reality: Object.keys(reality).length ? (reality as UnifiedNode['reality']) : undefined,
    flow: obj.flow ? String(obj.flow) : undefined,
    transportSettings: ts,
    protocolSettings: ps,
    extras: {},
    raw, rawFormat: 'clash-yaml', source: ctx.source ?? 'paste',
  });

  const { extras, issues } = collectExtras(obj, CLASH_CONSUMED, ctx.location);
  applyExtras(node, extras, issues, ctx.location);
  if (node.security === 'reality') node.issues.push(...requireFields({ publicKey: reality.publicKey }, ['publicKey'], ctx.location));
  node.issues.push(...requireFields({ server: node.server, port: node.port }, ['server', 'port'], ctx.location));
  if (['vmess', 'vless'].includes(protocol)) node.issues.push(...requireFields({ uuid: node.uuid }, ['uuid'], ctx.location));
  if (protocol === 'trojan' || protocol === 'ss' || protocol === 'ssr') node.issues.push(...requireFields({ password: node.password }, ['password'], ctx.location));
  if (protocol === 'wireguard' && !ps['private-key']) node.issues.push(issue('error', 'MISSING_REQUIRED', 'WireGuard 节点缺少 private-key，无法握手', { field: 'private-key', location: ctx.location }));
  return { node };
}

export function parseClashYaml(text: string, ctx: FormatContext = {}): FormatOutcome {
  const out: FormatOutcome = { nodes: [], rejected: [], issues: [] };
  const blocks = extractListBlocks(text, 'proxies');
  if (!blocks.length) {
    const parsed = parseYaml(text);
    const proxies = asRecord(parsed.value).proxies;
    if (Array.isArray(proxies)) {
      proxies.forEach((p, i) => {
        const r = fromClashProxy(asRecord(p), { ...ctx, location: `proxies[${i}]` }, JSON.stringify(p, null, 2));
        if ('node' in r) out.nodes.push(r.node); else out.rejected.push(r.rejected);
      });
    } else {
      out.rejected.push(reject(text.slice(0, 200), '未发现 proxies 节点列表：该 Clash 配置里没有可导入的节点（若是纯规则配置，请通过订阅导入）', ctx.location, 'UNSUPPORTED_PROTOCOL'));
    }
    out.issues.push(...parsed.warnings.map(w => issue('warning', 'PARTIAL_COMPAT', `YAML 解析提示：${w}`, { location: ctx.location })));
    return out;
  }
  blocks.forEach((block, i) => {
    const parsed = parseYaml(listItemToYaml(block));
    const obj = asRecord(parsed.value);
    if (!obj || !Object.keys(obj).length) {
      out.rejected.push(reject(block, `第 ${i + 1} 个 proxies 项无法解析（可能是 YAML 语法不受支持），原始片段已保留`, ctx.location));
      return;
    }
    out.issues.push(...parsed.warnings.map(w => issue('warning', 'PARTIAL_COMPAT', `YAML 解析提示：${w}`, { location: `proxies[${i}]` })));
    const r = fromClashProxy(obj, { ...ctx, location: `proxies[${i}]` }, block);
    if ('node' in r) out.nodes.push(r.node); else out.rejected.push(r.rejected);
  });
  return out;
}

/* ============================== sing-box / Xray JSON ============================== */

const SB_CONSUMED = new Set([
  'type', 'tag', 'server', 'server_port', 'uuid', 'password', 'method', 'alter_id', 'flow',
  'encryption', 'security', 'tls', 'transport', 'multiplex', 'packet_encoding', 'plugin',
  'plugin_opts', 'udp_over_tcp', 'local_address', 'private_key', 'peer_public_key',
  'pre_shared_key', 'reserved', 'mtu', 'workers', 'congestion_control', 'udp_relay_mode',
  'zero_rtt_handshake', 'heartbeat', 'up_mbps', 'down_mbps', 'obfs', 'auth', 'token',
  'version', 'disable_sni', 'insecure', 'detour', 'bind_interface', 'domain_strategy',
  'tcp_fast_open', 'tcp_multi_path', 'udp_fragment', 'server_name', 'system_interface',
  'gso', 'connect_timeout', 'tls_fragment', 'tls_record_fragment', 'address', 'addresses',
]);

function fromSingBoxOutbound(ob: Record<string, any>, ctx: FormatContext, raw: string): { node: UnifiedNode } | { rejected: RejectedItem } | null {
  const type = String(ob.type ?? '').toLowerCase();
  if (NON_NODE_TYPES.has(type)) return null;
  const protocol = normProtocol(type);
  if (!protocol) return { rejected: reject(raw, `sing-box outbound 类型「${ob.type ?? '空'}」不在支持列表内；原始对象已保留，不会误报成功`, ctx.location, 'UNSUPPORTED_PROTOCOL') };

  const hp = hostPort(ob.server, ob.server_port ?? ob.port, 443);
  const tlsObj = asRecord(ob.tls);
  const realityObj = asRecord(tlsObj.reality);
  const utls = asRecord(tlsObj.utls);
  const transportObj = asRecord(ob.transport);
  const security: Security = realityObj.enabled || realityObj.public_key ? 'reality'
    : (tlsObj.enabled || tlsObj.server_name || ob.security === 'tls' ? 'tls' : 'none');
  const tls: Record<string, unknown> = {};
  if (tlsObj.server_name) tls.sni = String(tlsObj.server_name);
  if (tlsObj.alpn) tls.alpn = normAlpn(tlsObj.alpn);
  if (utls.fingerprint ?? tlsObj.fingerprint) tls.fingerprint = String(utls.fingerprint ?? tlsObj.fingerprint);
  if (tlsObj.insecure !== undefined) tls.allowInsecure = !!tlsObj.insecure;
  const reality: Record<string, unknown> = {};
  if (realityObj.public_key) reality.publicKey = String(realityObj.public_key);
  if (realityObj.short_id) reality.shortId = String(realityObj.short_id);
  if (asRecord(tlsObj.reality).spider_x) reality.spiderX = String(tlsObj.reality.spider_x);

  const ts: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(transportObj)) if (k !== 'type') ts[k] = v;
  const transport: Transport = normTransport(transportObj.type ?? ob.transport_type ?? (ob.network), 'tcp');

  const node = makeNode({
    protocol, protocolAlias: type,
    server: hp.server, port: hp.port,
    name: String(ob.tag ?? '') || `${hp.server}:${hp.port}`,
    uuid: ob.uuid ? String(ob.uuid) : undefined,
    password: ob.password ?? ob.auth ?? ob.token ? String(ob.password ?? ob.auth ?? ob.token) : undefined,
    method: ob.method ? String(ob.method) : undefined,
    alterId: ob.alter_id !== undefined ? Number(ob.alter_id) : undefined,
    transport, security,
    tls: Object.keys(tls).length ? (tls as UnifiedNode['tls']) : undefined,
    reality: Object.keys(reality).length ? (reality as UnifiedNode['reality']) : undefined,
    flow: ob.flow ? String(ob.flow) : undefined,
    transportSettings: ts,
    protocolSettings: {
      ...(ob.multiplex !== undefined ? { multiplex: ob.multiplex } : {}),
      ...(ob.packet_encoding !== undefined ? { packetEncoding: ob.packet_encoding } : {}),
      ...(ob.udp_over_tcp !== undefined ? { udpOverTcp: ob.udp_over_tcp } : {}),
      ...(ob.plugin !== undefined ? { plugin: ob.plugin } : {}),
      ...(ob.plugin_opts !== undefined ? { pluginOpts: ob.plugin_opts } : {}),
      ...(ob.private_key !== undefined ? { privateKey: ob.private_key } : {}),
      ...(ob.peer_public_key !== undefined ? { peerPublicKey: ob.peer_public_key } : {}),
      ...(ob.local_address !== undefined ? { localAddress: ob.local_address } : {}),
      ...(ob.mtu !== undefined ? { mtu: ob.mtu } : {}),
      ...(ob.congestion_control !== undefined ? { congestionControl: ob.congestion_control } : {}),
    },
    raw, rawFormat: 'sing-box-json', source: ctx.source ?? 'paste',
  });
  const { extras, issues } = collectExtras(ob, SB_CONSUMED, ctx.location);
  applyExtras(node, extras, issues, ctx.location);
  // 嵌套对象里未映射的字段也要保留
  for (const [key, objValue] of [['tls', tlsObj], ['transport', transportObj]] as const) {
    for (const [k, v] of Object.entries(objValue)) {
      if (['enabled', 'server_name', 'alpn', 'insecure', 'utls', 'reality', 'fingerprint', 'type'].includes(k)) continue;
      node.extras[`${key}.${k}`] = v;
      node.lossless = false;
      node.issues.push(issue('info', 'UNKNOWN_FIELD', `嵌套字段「${key}.${k}」未映射，原值已保留`, { field: `${key}.${k}`, value: v, location: ctx.location }));
    }
  }
  node.issues.push(...requireFields({ server: node.server, port: node.port }, ['server', 'port'], ctx.location));
  return { node };
}

export function parseSingBoxJson(text: string, ctx: FormatContext = {}): FormatOutcome {
  const out: FormatOutcome = { nodes: [], rejected: [], issues: [] };
  const obj = safeJson<any>(text);
  if (!obj) { out.rejected.push(reject(text.slice(0, 200), 'sing-box JSON 语法错误', ctx.location)); return out; }
  const list: any[] = Array.isArray(obj) ? obj : (Array.isArray(obj.outbounds) ? obj.outbounds : [obj]);
  let skipped = 0;
  list.forEach((ob, i) => {
    const r = fromSingBoxOutbound(asRecord(ob), { ...ctx, location: `outbounds[${i}]` }, JSON.stringify(ob, null, 2));
    if (r === null) { skipped++; return; }
    if ('node' in r) out.nodes.push(r.node); else out.rejected.push(r.rejected);
  });
  if (skipped) out.issues.push(issue('info', 'PARTIAL_COMPAT', `已跳过 ${skipped} 个非节点 outbound（selector / urltest / direct 等，属于路由配置，不是代理节点）；原配置仍完整保留在各节点 raw 中`, { location: ctx.location }));
  if (!out.nodes.length && !out.rejected.length) out.rejected.push(reject(text.slice(0, 200), 'sing-box 配置中没有可导入的代理 outbound', ctx.location, 'UNSUPPORTED_PROTOCOL'));
  return out;
}

const XRAY_STREAM_KEYS = [
  'network', 'security', 'tlsSettings', 'realitySettings', 'wsSettings', 'grpcSettings',
  'xhttpSettings', 'splithttpSettings', 'tcpSettings', 'kcpSettings', 'quicSettings',
  'httpSettings', 'httpupgradeSettings', 'sockopt', 'dsSettings', 'xtlsSettings',
];

function applyXrayStream(node: UnifiedNode, stream: Record<string, any>, location?: string): void {
  node.transport = normTransport(stream.network, node.transport);
  node.security = normSecurity(stream.security, undefined);
  const tlsObj = asRecord(stream.tlsSettings);
  const reality = asRecord(stream.realitySettings);
  const tls: Record<string, unknown> = { ...(node.tls ?? {}) };
  if (tlsObj.serverName) tls.sni = String(tlsObj.serverName);
  if (tlsObj.alpn) tls.alpn = normAlpn(tlsObj.alpn);
  if (tlsObj.fingerprint) tls.fingerprint = String(tlsObj.fingerprint);
  if (tlsObj.allowInsecure !== undefined) tls.allowInsecure = !!tlsObj.allowInsecure;
  if (Object.keys(tls).length) node.tls = tls as UnifiedNode['tls'];
  const r: Record<string, unknown> = {};
  if (reality.publicKey) r.publicKey = String(reality.publicKey);
  if (reality.shortId) r.shortId = String(reality.shortId);
  if (reality.spiderX) r.spiderX = String(reality.spiderX);
  if (reality.serverName) r.serverName = String(reality.serverName);
  if (reality.fingerprint) r.fingerprint = String(reality.fingerprint);
  if (reality.mldsa65Verify) r.mldsa65Verify = String(reality.mldsa65Verify);
  if (Object.keys(r).length) node.reality = r as UnifiedNode['reality'];
  if (node.security === 'reality') node.issues.push(...requireFields({ publicKey: r.publicKey }, ['publicKey'], location));

  const ts: Record<string, unknown> = { ...node.transportSettings };
  const ws = asRecord(stream.wsSettings), grpc = asRecord(stream.grpcSettings);
  const xhttp = asRecord(stream.xhttpSettings ?? stream.splithttpSettings);
  const tcp = asRecord(stream.tcpSettings), kcp = asRecord(stream.kcpSettings);
  const http = asRecord(stream.httpSettings);
  if (ws.path) ts.path = ws.path;
  if (ws.host) ts.host = ws.host;
  if (ws.headers) ts.host = asRecord(ws.headers).Host ?? asRecord(ws.headers).host;
  if (grpc.serviceName) ts.serviceName = grpc.serviceName;
  if (grpc.authority) ts.authority = grpc.authority;
  if (grpc.multiMode !== undefined) ts.multiMode = grpc.multiMode;
  if (xhttp.path) ts.path = xhttp.path;
  if (xhttp.mode) ts.mode = xhttp.mode;
  if (xhttp.host) ts.host = xhttp.host;
  if (xhttp.extra) ts.extra = xhttp.extra;
  if (tcp.header) ts.header = tcp.header;
  if (kcp.header) ts.header = kcp.header;
  if (kcp.seed) ts.seed = kcp.seed;
  if (http.host) ts.host = http.host;
  if (http.path) ts.path = http.path;
  if (stream.sockopt) ts.sockopt = stream.sockopt;
  node.transportSettings = ts;

  for (const [k, v] of Object.entries(stream)) {
    if (XRAY_STREAM_KEYS.includes(k) || v === undefined || v === null) continue;
    node.extras[`streamSettings.${k}`] = v;
    node.lossless = false;
    node.issues.push(issue('info', 'UNKNOWN_FIELD', `streamSettings 字段「${k}」未映射，原值已保留`, { field: `streamSettings.${k}`, value: v, location }));
  }
}

const XRAY_CONSUMED = new Set(['protocol', 'tag', 'settings', 'streamSettings', 'mux', 'proxySettings', 'sendThrough', 'tag']);

function fromXrayOutbound(ob: Record<string, any>, ctx: FormatContext, raw: string): ({ node: UnifiedNode } | { rejected: RejectedItem } | null)[] {
  const type = String(ob.protocol ?? ob.type ?? '').toLowerCase();
  if (NON_NODE_TYPES.has(type)) return [null];
  // 有 type 没有 protocol 且是 sing-box 特有 schema → 交给 sing-box 解析
  if (!ob.protocol && ob.type && (ob.server_port || ob.transport)) {
    const r = fromSingBoxOutbound(ob, ctx, raw);
    return [r];
  }
  const protocol = normProtocol(type);
  if (!protocol) return [{ rejected: reject(raw, `Xray outbound 协议「${ob.protocol ?? ob.type ?? '空'}」不在支持列表内；原始对象已保留`, ctx.location, 'UNSUPPORTED_PROTOCOL') }];

  const settings = asRecord(ob.settings);
  const vnext: any[] = Array.isArray(settings.vnext) ? settings.vnext : [];
  const servers: any[] = Array.isArray(settings.servers) ? settings.servers : [];
  const entries: any[] = vnext.length ? vnext : (servers.length ? servers : [settings]);
  const result: ({ node: UnifiedNode } | { rejected: RejectedItem } | null)[] = [];

  entries.forEach((entry, i) => {
    const e = asRecord(entry);
    const users = Array.isArray(e.users) ? e.users : [];
    const user = asRecord(users[0] ?? {});
    const hp = hostPort(e.address ?? ob.server ?? e.server, e.port ?? ob.server_port ?? e.server_port, 443);
    const node = makeNode({
      protocol, protocolAlias: type,
      server: hp.server, port: hp.port,
      name: String(ob.tag ?? '') || `${hp.server}:${hp.port}`,
      uuid: user.id ?? e.id ?? ob.uuid ? String(user.id ?? e.id ?? ob.uuid) : undefined,
      password: e.password ?? user.pass ?? user.password ?? ob.password ? String(e.password ?? user.pass ?? user.password ?? ob.password) : undefined,
      method: e.method ?? ob.method ? String(e.method ?? ob.method) : undefined,
      alterId: user.alterId !== undefined ? Number(user.alterId) : undefined,
      flow: user.flow ?? ob.flow ? String(user.flow ?? ob.flow) : undefined,
      transport: 'tcp', security: 'none',
      raw, rawFormat: 'xray-json', source: ctx.source ?? 'paste',
      protocolSettings: {
        ...(user.encryption !== undefined ? { encryption: user.encryption } : {}),
        ...(user.level !== undefined ? { level: user.level } : {}),
        ...(user.security !== undefined ? { userSecurity: user.security } : {}),
        ...(e.ota !== undefined ? { ota: e.ota } : {}),
        ...(e.users && users.length > 1 ? { additionalUsers: users.slice(1) } : {}),
        ...(ob.mux !== undefined ? { mux: ob.mux } : {}),
      },
    });
    applyXrayStream(node, asRecord(ob.streamSettings), `${ctx.location ?? 'outbound'}[${i}]`);
    const { extras, issues } = collectExtras(ob, XRAY_CONSUMED, ctx.location);
    applyExtras(node, extras, issues, ctx.location);
    for (const [k, v] of Object.entries(settings)) {
      if (['vnext', 'servers'].includes(k) || v === undefined || v === null) continue;
      node.extras[`settings.${k}`] = v;
      node.lossless = false;
      node.issues.push(issue('info', 'UNKNOWN_FIELD', `settings 字段「${k}」未映射，原值已保留`, { field: `settings.${k}`, value: v, location: ctx.location }));
    }
    node.issues.push(...requireFields({ server: node.server, port: node.port }, ['server', 'port'], ctx.location));
    if (['vmess', 'vless'].includes(protocol)) node.issues.push(...requireFields({ uuid: node.uuid }, ['uuid'], ctx.location));
    result.push({ node });
  });
  return result.length ? result : [null];
}

export function parseXrayJson(text: string, ctx: FormatContext = {}): FormatOutcome {
  const out: FormatOutcome = { nodes: [], rejected: [], issues: [] };
  const obj = safeJson<any>(text);
  if (!obj) { out.rejected.push(reject(text.slice(0, 200), 'Xray / V2Ray JSON 语法错误', ctx.location)); return out; }
  const list: any[] = Array.isArray(obj) ? obj : (Array.isArray(obj.outbounds) ? obj.outbounds : [obj]);
  let skipped = 0;
  list.forEach((ob, i) => {
    const results = fromXrayOutbound(asRecord(ob), { ...ctx, location: `outbounds[${i}]` }, JSON.stringify(ob, null, 2));
    for (const r of results) {
      if (r === null) { skipped++; continue; }
      if ('node' in r) out.nodes.push(r.node); else out.rejected.push(r.rejected);
    }
  });
  if (skipped) out.issues.push(issue('info', 'PARTIAL_COMPAT', `已跳过 ${skipped} 个非节点 outbound（blackhole / freedom / dokodemo-door 等）`, { location: ctx.location }));
  if (!out.nodes.length && !out.rejected.length) out.rejected.push(reject(text.slice(0, 200), 'Xray 配置中没有可导入的代理 outbound', ctx.location, 'UNSUPPORTED_PROTOCOL'));
  return out;
}

/* ================================ WireGuard .conf ================================ */

export function parseWireGuardConf(text: string, ctx: FormatContext = {}): FormatOutcome {
  const out: FormatOutcome = { nodes: [], rejected: [], issues: [] };
  const sections: Record<string, Record<string, string>> = { Interface: {}, Peer: {} };
  let current = '';
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const sec = t.match(/^\[(\w+)\]$/i);
    if (sec) { current = sec[1]; if (!sections[current]) sections[current] = {}; continue; }
    const kv = t.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && current) sections[current][kv[1].trim()] = kv[2].trim();
  }
  const iface = sections.Interface ?? {}, peer = sections.Peer ?? {};
  const endpoint = peer.Endpoint ?? iface.Endpoint ?? '';
  const hp = splitHostPort(endpoint, 51820);
  if (!hp.server) {
    out.rejected.push(reject(text, 'WireGuard 配置缺少 [Peer] Endpoint，无法确定服务器地址；原始配置已保留', ctx.location, 'MISSING_REQUIRED'));
    return out;
  }
  const extraSections: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sections)) if (!['Interface', 'Peer'].includes(k)) extraSections[k] = v;
  const node = makeNode({
    protocol: 'wireguard', server: hp.server, port: hp.port,
    name: `${hp.server}:${hp.port}`,
    transport: 'none', security: 'none',
    raw: text, rawFormat: 'wireguard-conf', source: ctx.source ?? 'paste',
    protocolSettings: {
      privateKey: iface.PrivateKey,
      address: iface.Address,
      dns: iface.DNS,
      mtu: iface.MTU,
      publicKey: peer.PublicKey,
      preSharedKey: peer.PresharedKey ?? peer.PreSharedKey,
      allowedIPs: peer.AllowedIPs,
      persistentKeepalive: peer.PersistentKeepalive,
      reserved: peer.Reserved ?? iface.Reserved,
      ...extraSections,
    },
  });
  for (const [field, label] of [['privateKey', 'PrivateKey'], ['publicKey', 'PublicKey']] as const) {
    if (!node.protocolSettings[field]) node.issues.push(issue('error', 'MISSING_REQUIRED', `缺少必填字段「${label}」，WireGuard 无法握手`, { field: label, location: ctx.location }));
  }
  if (Object.keys(extraSections).length) {
    node.lossless = false;
    node.issues.push(issue('warning', 'UNKNOWN_FIELD', `配置含额外段 [${Object.keys(extraSections).join('、')}]，原值已保留在 protocolSettings，需人工确认`, { location: ctx.location }));
  }
  out.nodes.push(node);
  return out;
}

/* ================================ 订阅内容 ================================ */

export function parseSubscriptionContent(text: string, ctx: FormatContext, recurse?: RecurseFn): FormatOutcome {
  const out: FormatOutcome = { nodes: [], rejected: [], issues: [] };
  const raw = text.trim();
  let inner = decodeBase64Utf8(raw);
  if (inner && inner === raw) inner = null;
  const content = inner ?? raw;
  const detected = detectFormat(content);
  if (detected.format === 'unknown') {
    out.rejected.push(reject(raw.slice(0, 200), `订阅内容解码后仍无法识别：${detected.detail}`, ctx.location, 'UNSUPPORTED_PROTOCOL'));
    return out;
  }
  if (detected.format === 'subscription-url') {
    out.requiresFetch = { url: content.trim(), kind: 'subscription' };
    out.issues.push(issue('info', 'SECURITY', '订阅内容是一个 URL，解析中心未自动发起请求；请确认后再拉取', { location: ctx.location, value: content.trim() }));
    return out;
  }
  if (recurse && (detected.format === 'clash-yaml' || detected.format === 'sing-box-json' || detected.format === 'xray-json' || detected.format === 'wireguard-conf' || detected.format === 'v2rayn-wrapper' || detected.format === 'subscription-content')) {
    const report = recurse(content, { ...ctx, rawFormat: 'subscription-content', _depth: (ctx._depth ?? 0) + 1 });
    out.nodes.push(...report.nodes);
    out.rejected.push(...report.rejected);
    out.issues.push(...report.issues);
    if (report.requiresFetch) out.requiresFetch = report.requiresFetch;
    return out;
  }
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
  const parsed = parseShareLinks(lines.join('\n'), { ...ctx, rawFormat: 'subscription-content' });
  out.nodes.push(...parsed.nodes);
  out.rejected.push(...parsed.rejected);
  if (!out.nodes.length && !out.rejected.length) {
    out.rejected.push(reject(raw.slice(0, 200), '订阅内容中没有可识别的节点链接（可能已过期、需要鉴权，或返回了 HTML 错误页）', ctx.location, 'UNSUPPORTED_PROTOCOL'));
  }
  return out;
}

/* ================================ 包装格式 / URL ================================ */

/** v2rayn:// 等客户端包装格式解包。解出的内容一律走二次判定，绝不直接当节点。 */
export function parseWrapper(text: string, ctx: FormatContext, recurse?: RecurseFn): FormatOutcome {
  const out: FormatOutcome = { nodes: [], rejected: [], issues: [] };
  const raw = text.trim();
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase() ?? '';
  const rest = raw.slice(raw.indexOf('://') + 3);
  let payload = rest;
  let query: Record<string, string | string[]> = {};
  const qIdx = rest.indexOf('?');
  if (qIdx >= 0) {
    payload = rest.slice(0, qIdx);
    query = parseQuery(rest.slice(qIdx + 1));
  }
  const fromQuery = qStr(query, 'url') ?? qStr(query, 'config') ?? qStr(query, 'data') ?? qStr(query, 'sub') ?? qStr(query, 'payload');
  if (fromQuery) payload = fromQuery;
  try { payload = decodeURIComponent(payload); } catch { /* 保留原样 */ }

  // SSD 订阅：ssd://base64(JSON{servers:[...]})
  if (scheme === 'ssd') {
    const decoded = decodeBase64Utf8(payload);
    const obj = decoded ? safeJson<any>(decoded) : null;
    if (!obj || !Array.isArray(obj.servers)) {
      out.rejected.push(reject(raw, 'SSD 订阅不是合法的 Base64 JSON 或缺少 servers 数组', ctx.location));
      return out;
    }
    const lines = obj.servers.map((s: any) => {
      const userinfo = encodeBase64Utf8(`${obj.method ?? s.method}:${obj.password ?? s.password}`);
      const name = encodeURIComponent(s.remarks ?? s.name ?? '');
      return `ss://${userinfo}@${s.server ?? s.address}:${s.port ?? obj.port}${name ? '#' + name : ''}`;
    });
    const parsed = parseShareLinks(lines.join('\n'), { ...ctx, rawFormat: 'v2rayn-wrapper' });
    out.nodes.push(...parsed.nodes); out.rejected.push(...parsed.rejected);
    out.issues.push(...collectExtras(obj, ['servers', 'method', 'password', 'port', 'plugin', 'plugin_options'], ctx.location).issues);
    out.nodes.forEach(n => { n.raw = raw; n.rawFormat = 'v2rayn-wrapper'; });
    return out;
  }

  // 纯订阅/配置 URL：只返回 requiresFetch，不自动请求
  if (/^https?:\/\//i.test(payload)) {
    out.requiresFetch = { url: payload, kind: /[?&](url|config)=|\.(json|ya?ml|conf)(\?|$)/i.test(payload) ? 'config-url' : 'subscription' };
    out.issues.push(issue('warning', 'SECURITY',
      `识别到 ${scheme || '客户端'} 包装的远端配置地址。按导入安全规则，解析中心**不会自动拉取或执行**该地址，需用户确认后再导入。`,
      { location: ctx.location, value: payload }));
    return out;
  }

  // 解 Base64（可能多层）
  let decoded = decodeBase64Utf8(payload);
  let depth = 0;
  while (decoded && decoded !== payload && depth < 3) {
    payload = decoded;
    decoded = decodeBase64Utf8(payload);
    depth++;
  }
  if (!payload) {
    out.rejected.push(reject(raw, `${scheme || '包装'} 格式载荷为空或无法解码；解析中心不会把空内容伪装成导入成功`, ctx.location));
    return out;
  }
  const detected = detectFormat(payload);
  if (detected.format === 'unknown') {
    out.rejected.push(reject(raw, `${scheme || '包装'} 解包后内容无法识别：${detected.detail}`, ctx.location, 'UNSUPPORTED_PROTOCOL'));
    return out;
  }
  out.issues.push(issue('info', 'PARTIAL_COMPAT',
    `${scheme.toUpperCase()} 包装格式已解包 ${depth} 层，真实格式为「${detected.label}」；接下来按该格式解析`,
    { location: ctx.location }));
  if (detected.format === 'subscription-url') {
    out.requiresFetch = { url: payload.trim(), kind: 'subscription' };
    out.issues.push(issue('warning', 'SECURITY', '解包结果是远端订阅地址，未自动请求，需用户确认', { location: ctx.location, value: payload.trim() }));
    return out;
  }
  if (!recurse) {
    out.rejected.push(reject(raw, '包装格式需要二次解析，但当前调用未提供递归解析器', ctx.location));
    return out;
  }
  const report = recurse(payload, { ...ctx, rawFormat: 'v2rayn-wrapper', _depth: (ctx._depth ?? 0) + 1 });
  out.nodes.push(...report.nodes);
  out.rejected.push(...report.rejected);
  out.issues.push(...report.issues);
  if (report.requiresFetch) out.requiresFetch = report.requiresFetch;
  out.nodes.forEach(n => { n.rawFormat = 'v2rayn-wrapper'; });
  return out;
}

/** 订阅 / 配置 URL：只登记，不自动请求 */
export function parseSubscriptionUrl(text: string, ctx: FormatContext = {}): FormatOutcome {
  const out: FormatOutcome = { nodes: [], rejected: [], issues: [] };
  const url = text.trim();
  const kind = /\.(json|ya?ml|conf|txt)(\?|$)/i.test(url) || /[?&](config|url)=/i.test(url) ? 'config-url' : 'subscription';
  out.requiresFetch = { url, kind };
  out.issues.push(issue('warning', 'SECURITY',
    `识别为${kind === 'subscription' ? '订阅地址' : '配置文件 URL'}。按导入安全规则，解析中心不会自动请求该地址、也不会自动执行返回内容；请确认来源可信后再拉取。`,
    { location: ctx.location, value: url }));
  return out;
}
