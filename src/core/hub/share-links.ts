/**
 * 统一配置解析中心 —— 分享链接解析器
 *
 * 覆盖：VMess / VLESS(Reality、XTLS Vision) / Trojan / Shadowsocks / SSR /
 *       SOCKS4 / SOCKS5 / HTTP / HTTPS / Hysteria / Hysteria2 / TUIC /
 *       WireGuard / AnyTLS / NaiveProxy / SSH
 * 以及 v2rayN 家族包装格式（见 formats.ts 的 wrapper 解包）。
 *
 * 所有无法映射到统一模型的参数都会进入 extras 并生成 issue，绝不静默丢弃。
 */

import type {
  DetectedFormat, ParseIssue, Protocol, RejectedItem, Security, Transport, UnifiedNode,
} from './model.js';
import {
  decodeBase64Utf8, issue, makeNode, mapFields, parseQuery, qBool,
  qStr, requireFields, safeJson, safeURL, splitHostPort, stripFragment, isProxyLikeHttpUrl,
} from './util.js';

export interface LinkContext {
  source?: string;
  rawFormat?: DetectedFormat;
  location?: string;
}

export type LinkOutcome = { node: UnifiedNode } | { rejected: RejectedItem };

class LinkError extends Error {
  issues: ParseIssue[];
  constructor(message: string, issues: ParseIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** 分享链接 scheme 白名单（不含包装格式，包装格式在 formats.ts 处理） */
export const SHARE_SCHEMES = [
  'vmess', 'vless', 'trojan', 'ss', 'ssr',
  'socks', 'socks4', 'socks4a', 'socks5', 'socks5h', 'http', 'https',
  'hysteria', 'hysteria2', 'hy2', 'tuic',
  'wireguard', 'wg', 'anytls', 'naive', 'naive+https', 'naive+quic', 'ssh',
] as const;

export function isShareLink(raw: string): boolean {
  const s = raw.trim();
  return SHARE_SCHEMES.some(scheme => s.toLowerCase().startsWith(scheme + '://'));
}

/** 标准化传输层名称 */
export function normTransport(v: unknown, fallback: Transport = 'tcp'): Transport {
  const s = String(v ?? '').toLowerCase().trim();
  if (!s || s === 'none' || s === 'raw' || s === 'tcp') return s === 'none' ? 'none' : 'tcp';
  if (s === 'ws' || s === 'websocket') return 'ws';
  if (s === 'grpc' || s === 'gun') return 'grpc';
  if (s === 'h2' || s === 'http2' || s === 'http/2') return 'h2';
  if (s === 'http' || s === 'http1') return 'http';
  if (s === 'httpupgrade') return 'httpupgrade';
  if (s === 'xhttp') return 'xhttp';
  if (s === 'splithttp') return 'splithttp';
  if (s === 'kcp' || s === 'mkcp') return 'kcp';
  if (s === 'quic') return 'quic';
  return fallback;
}

export function normSecurity(v: unknown, tlsFlag?: unknown): Security {
  const s = String(v ?? '').toLowerCase().trim();
  if (s === 'reality') return 'reality';
  if (s === 'xtls') return 'xtls';
  if (s === 'tls' || s === 'true' || s === '1') return 'tls';
  if (tlsFlag !== undefined && String(tlsFlag).toLowerCase() === 'tls') return 'tls';
  return 'none';
}

export function normAlpn(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return v.split(',').map(x => x.trim()).filter(Boolean);
  return undefined;
}

/** 公共参数映射表：所有已知别名集中在这里，未命中的进 extras */
const COMMON_SPEC: Record<string, string[]> = {
  transportFrom: ['type', 'net', 'network', 'transport'],
  securityFrom: ['security'],
  tlsFlag: ['tls'],
  sni: ['sni', 'peer', 'serverName', 'servername', 'server_name'],
  alpn: ['alpn'],
  fp: ['fp', 'fingerprint', 'client-fingerprint', 'client_fingerprint'],
  insecure: ['allowInsecure', 'insecure', 'skip-cert-verify', 'allow_insecure', 'skip_cert_verify'],
  host: ['host', 'Host', 'headers.Host', 'ws-host'],
  path: ['path'],
  serviceName: ['serviceName', 'service_name', 'grpc-service-name', 'grpcServiceName'],
  authority: ['authority', 'grpc-authority'],
  mode: ['mode', 'xhttp-mode'],
  headerType: ['headerType', 'header_type'],
  seed: ['seed', 'kcp-seed'],
  pbk: ['pbk', 'publicKey', 'public-key', 'public_key'],
  sid: ['sid', 'shortId', 'short-id', 'short_id'],
  spx: ['spx', 'spiderX', 'spider-x', 'spider_x'],
  mldsa: ['mldsa65Verify', 'mldsa65-verify'],
  flow: ['flow'],
  encryption: ['encryption', 'scy', 'cipher'],
  level: ['level'],
  // 协议专属但常见的字段，统一收进 protocolSettings
  obfs: ['obfs', 'obfs-type'],
  obfsPassword: ['obfs-password', 'obfs_password', 'obfsParam', 'obfsparam'],
  upMbps: ['upmbps', 'up_mbps', 'up'],
  downMbps: ['downmbps', 'down_mbps', 'down'],
  congestion: ['congestion_control', 'congestion-control', 'congestion'],
  udpRelayMode: ['udp_relay_mode', 'udp-relay-mode'],
  disableSni: ['disable_sni', 'disable-sni'],
  zeroRtt: ['zero_rtt', 'zero-rtt'],
  version: ['version'],
  token: ['token'],
  pinSHA256: ['pinSHA256', 'pin_sha256'],
  mtu: ['mtu'],
  keepalive: ['keepalive', 'persistent-keepalive'],
  reserved: ['reserved'],
  privateKey: ['privateKey', 'private-key', 'private_key'],
  publicKey: ['publickey', 'publicKey', 'peer-public-key'],
  preSharedKey: ['presharedkey', 'preSharedKey'],
  allowedIPs: ['allowedips', 'allowedIPs', 'allowed_ips'],
  address: ['address', 'local-address'],
  dns: ['dns'],
  plugin: ['plugin'],
  pluginOpts: ['plugin-opts', 'plugin_opts', 'pluginOpts'],
  protocolParam: ['protoparam', 'protocol-param', 'protocolParam'],
  obfsParam: ['obfsparam', 'obfs-param'],
  remarks: ['remarks'],
  passwordAlias: ['auth', 'password', 'pass', 'pwd'],
  uuidAlias: ['uuid', 'id'],
  padding: ['padding'],
  hostKey: ['hostKey', 'host-key', 'host_key'],
  privateKeyFile: ['privateKeyFile', 'private-key-file'],
  passphrase: ['passphrase', 'key-passphrase'],
  extra: ['extra'],
};

interface CommonOptions {
  /** VMess 的 type 是伪装头而非传输层 */
  typeAsHeader?: boolean;
  /** 排除某些 key（已由协议自己处理） */
  ignore?: string[];
  location?: string;
}

/**
 * 把 query / JSON 参数应用到节点：结构化字段落到对应位置，其余全部保留并提示。
 */
function applyCommon(node: UnifiedNode, params: Record<string, any>, opts: CommonOptions = {}): void {
  const spec = { ...COMMON_SPEC };
  if (opts.typeAsHeader) {
    delete spec.transportFrom;
    spec.headerType = ['type', 'headerType', 'header_type'];
    spec.transportFromNet = ['net', 'network', 'transport'];
  }
  const { known, extras, unknownIssues } = mapFields(params, spec, { ignore: opts.ignore, location: opts.location });

  // 传输层
  const transportSource = known.transportFrom ?? known.transportFromNet;
  if (transportSource !== undefined) node.transport = normTransport(transportSource, node.transport);

  // 安全层
  const sec = normSecurity(known.securityFrom, known.tlsFlag);
  if (sec !== 'none' || known.securityFrom !== undefined || known.tlsFlag !== undefined) node.security = sec;
  const tls: Record<string, unknown> = { ...(node.tls ?? {}) };
  if (known.sni !== undefined) tls.sni = String(known.sni);
  const alpn = normAlpn(known.alpn);
  if (alpn) tls.alpn = alpn;
  if (known.fp !== undefined) tls.fingerprint = String(known.fp);
  if (known.insecure !== undefined) tls.allowInsecure = qBool(String(known.insecure)) ?? false;
  if (Object.keys(tls).length) node.tls = tls as UnifiedNode['tls'];

  const reality: Record<string, unknown> = { ...(node.reality ?? {}) };
  if (known.pbk !== undefined) reality.publicKey = String(known.pbk);
  if (known.sid !== undefined) reality.shortId = String(known.sid);
  if (known.spx !== undefined) reality.spiderX = String(known.spx);
  if (known.mldsa !== undefined) reality.mldsa65Verify = String(known.mldsa);
  if (Object.keys(reality).length) node.reality = reality as UnifiedNode['reality'];
  if (node.security === 'reality') {
    const miss = requireFields({ publicKey: reality.publicKey }, ['publicKey'], opts.location);
    node.issues.push(...miss);
  }

  if (known.flow !== undefined) {
    node.flow = String(known.flow);
    if (/vision/i.test(node.flow) && node.security === 'none') {
      node.issues.push(issue('warning', 'PARTIAL_COMPAT',
        `检测到 XTLS Vision 流控（${node.flow}），但未声明 TLS/Reality 安全层；该组合通常无法连接，请确认 security 参数。`,
        { field: 'flow', value: node.flow, location: opts.location }));
    }
  }

  const ts: Record<string, unknown> = { ...node.transportSettings };
  for (const k of ['host', 'path', 'serviceName', 'authority', 'mode', 'headerType', 'seed']) {
    if (known[k] !== undefined) ts[k] = known[k];
  }
  if (known.extra !== undefined) {
    try {
      const parsed = typeof known.extra === 'string' ? JSON.parse(known.extra) : known.extra;
      ts.extra = parsed;
    } catch {
      ts.extra = known.extra;
      node.issues.push(issue('warning', 'INVALID_VALUE', 'extra 参数不是合法 JSON，已按原始字符串保留，XHTTP 等传输层扩展参数可能不生效', { field: 'extra', value: known.extra, location: opts.location }));
    }
  }
  node.transportSettings = ts;

  const ps: Record<string, unknown> = { ...node.protocolSettings };
  for (const k of [
    'obfs', 'obfsPassword', 'upMbps', 'downMbps', 'congestion', 'udpRelayMode', 'disableSni',
    'zeroRtt', 'version', 'token', 'pinSHA256', 'mtu', 'keepalive', 'reserved', 'privateKey',
    'publicKey', 'preSharedKey', 'allowedIPs', 'address', 'dns', 'plugin', 'pluginOpts',
    'protocolParam', 'obfsParam', 'encryption', 'level', 'padding', 'hostKey',
    'privateKeyFile', 'passphrase', 'passwordAlias', 'uuidAlias',
  ]) {
    if (known[k] !== undefined) ps[k] = known[k];
  }
  node.protocolSettings = ps;

  // 关键：未映射字段一律保留 + 明确提示
  node.extras = { ...node.extras, ...extras };
  node.issues.push(...unknownIssues);
  if (Object.keys(node.extras).length) {
    node.lossless = false;
    node.issues.push(issue('warning', 'UNKNOWN_FIELD',
      `有 ${Object.keys(node.extras).length} 个参数未能映射到统一模型（${Object.keys(node.extras).join('、')}）；原始值已保留在 extras，请人工确认后再连接`,
      { location: opts.location }));
  }
}

/** 通用必填字段校验 */
function validate(node: UnifiedNode, required: string[], ctx: LinkContext): void {
  node.issues.push(...requireFields(node as unknown as Record<string, unknown>, required, ctx.location));
}

function nameOrHost(name: string, server: string, port: number): string {
  return name || `${server}:${port}`;
}

/* ================================ 各协议解析 ================================ */

function parseVMess(raw: string, ctx: LinkContext): UnifiedNode {
  let body = raw.slice('vmess://'.length).trim();
  const frag = stripFragment(body);
  body = frag.body;
  let obj: Record<string, any> | null = null;
  const decoded = decodeBase64Utf8(body);
  if (decoded) obj = safeJson<Record<string, any>>(decoded);
  if (!obj && body.trim().startsWith('{')) obj = safeJson<Record<string, any>>(body.trim());
  if (!obj) throw new LinkError('VMess 链接既不是合法 Base64-JSON，也不是明文 JSON；无法解码');

  // VMess 特有：net = 传输层，type = 伪装头；scy/security = 加密方式，不是传输安全层
  const knownKeys = [
    'v', 'ps', 'name', 'remarks', 'add', 'server', 'host', 'port', 'id', 'uuid',
    'aid', 'alterId', 'net', 'network', 'type', 'headerType', 'tls', 'security',
    'sni', 'peer', 'serverName', 'servername', 'alpn', 'fp', 'fingerprint',
    'allowInsecure', 'insecure', 'skip-cert-verify', 'host', 'path',
    'serviceName', 'authority', 'mode', 'seed', 'scy', 'encryption', 'cipher',
    'level', 'flow', 'pbk', 'publicKey', 'sid', 'shortId', 'spx', 'spiderX',
    'mldsa65Verify', 'extra', 'host', 'path',
  ];
  const { extras, unknownIssues } = mapFields(obj, {}, { ignore: knownKeys, location: ctx.location });

  const hp = splitHostPort(String(obj.add ?? obj.server ?? ''), Number(obj.port ?? 443));
  const secFromSecurity = /^(tls|reality|xtls)$/i.test(String(obj.security ?? '')) ? obj.security : undefined;
  const alpn = normAlpn(obj.alpn);
  const tls: Record<string, unknown> = {};
  const sni = obj.sni ?? obj.peer ?? obj.serverName ?? obj.servername;
  if (sni) tls.sni = String(sni);
  if (alpn) tls.alpn = alpn;
  if (obj.fp ?? obj.fingerprint) tls.fingerprint = String(obj.fp ?? obj.fingerprint);
  const insecure = obj.allowInsecure ?? obj.insecure ?? obj['skip-cert-verify'];
  if (insecure !== undefined) tls.allowInsecure = /^(1|true|yes)$/i.test(String(insecure));

  const reality: Record<string, unknown> = {};
  if (obj.pbk ?? obj.publicKey) reality.publicKey = String(obj.pbk ?? obj.publicKey);
  if (obj.sid ?? obj.shortId) reality.shortId = String(obj.sid ?? obj.shortId);
  if (obj.spx ?? obj.spiderX) reality.spiderX = String(obj.spx ?? obj.spiderX);
  if (obj.mldsa65Verify) reality.mldsa65Verify = String(obj.mldsa65Verify);

  const ts: Record<string, unknown> = {};
  for (const k of ['host', 'path', 'serviceName', 'authority', 'mode', 'seed']) if (obj[k] !== undefined) ts[k] = obj[k];
  if (obj.type !== undefined && obj.type !== 'none') ts.headerType = obj.type;
  if (obj.extra !== undefined) {
    try { ts.extra = typeof obj.extra === 'string' ? JSON.parse(obj.extra) : obj.extra; }
    catch { ts.extra = obj.extra; }
  }

  const node = makeNode({
    protocol: 'vmess', server: hp.server, port: hp.port,
    name: frag.name || String(obj.ps ?? obj.name ?? obj.remarks ?? '') || nameOrHost('', hp.server, hp.port),
    uuid: obj.id ?? obj.uuid ? String(obj.id ?? obj.uuid) : undefined,
    alterId: Number(obj.aid ?? obj.alterId ?? 0),
    transport: normTransport(obj.net ?? obj.network ?? 'tcp'),
    security: normSecurity(secFromSecurity, obj.tls),
    tls: Object.keys(tls).length ? (tls as UnifiedNode['tls']) : undefined,
    reality: Object.keys(reality).length ? (reality as UnifiedNode['reality']) : undefined,
    flow: obj.flow ? String(obj.flow) : undefined,
    transportSettings: ts,
    protocolSettings: {
      ...(obj.scy ?? obj.encryption ?? obj.cipher ? { encryption: String(obj.scy ?? obj.encryption ?? obj.cipher) } : {}),
      ...(obj.level !== undefined ? { level: obj.level } : {}),
      ...(obj.v !== undefined ? { version: obj.v } : {}),
    },
    extras,
    raw,
    rawDecoded: decoded ?? (body.trim().startsWith('{') ? body.trim() : undefined),
    rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  node.issues.push(...unknownIssues);
  if (Object.keys(extras).length) {
    node.lossless = false;
    node.issues.push(issue('warning', 'UNKNOWN_FIELD',
      `VMess 配置有 ${Object.keys(extras).length} 个字段未映射（${Object.keys(extras).join('、')}），原值已完整保留在 extras`,
      { location: ctx.location }));
  }
  if (node.security === 'reality') node.issues.push(...requireFields({ publicKey: reality.publicKey }, ['publicKey'], ctx.location));
  validate(node, ['server', 'uuid'], ctx);
  return node;
}

function parseVLESS(raw: string, ctx: LinkContext): UnifiedNode {
  const { body, name } = stripFragment(raw.slice('vless://'.length));
  const at = body.lastIndexOf('@');
  if (at < 0) throw new LinkError('VLESS 链接缺少 uuid@host:port 结构');
  const uuidPart = decodeURIComponent(body.slice(0, at));
  const rest = body.slice(at + 1);
  const u = safeURL(rest);
  if (!u) throw new LinkError('VLESS 链接的服务器地址无法解析（host:port 格式错误）');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), 443);
  const q = parseQuery(u.search);
  const node = makeNode({
    protocol: 'vless', server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    uuid: uuidPart,
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  applyCommon(node, q as Record<string, any>, { location: ctx.location });
  if (qStr(q, 'encryption') === undefined) {
    node.issues.push(issue('info', 'DEGRADED', 'VLESS 链接未声明 encryption，按标准默认 none 处理', { field: 'encryption', location: ctx.location }));
  }
  validate(node, ['server', 'uuid'], ctx);
  return node;
}

function parseTrojan(raw: string, ctx: LinkContext): UnifiedNode {
  const { body, name } = stripFragment(raw.slice('trojan://'.length));
  const u = safeURL(body);
  if (!u) throw new LinkError('Trojan 链接的服务器地址无法解析');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), 443);
  const q = parseQuery(u.search);
  const node = makeNode({
    protocol: 'trojan', server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    password: decodeURIComponent(u.username || ''),
    security: 'tls',
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  applyCommon(node, q as Record<string, any>, { location: ctx.location });
  if (!node.password) node.issues.push(issue('error', 'MISSING_REQUIRED', '缺少必填字段「password」，Trojan 无法连接', { field: 'password', location: ctx.location }));
  return node;
}

/** SS 加密方式白名单：不在表内的不拒绝，但必须提示内核兼容风险 */
const SS_METHODS = new Set([
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
  'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
  'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb', 'aes-128-ctr', 'aes-256-ctr',
  'camellia-128-cfb', 'camellia-192-cfb', 'camellia-256-cfb',
  'rc4-md5', 'salsa20', 'chacha20', 'chacha20-ietf',
  'bf-cfb', 'none', 'plain',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305', '2022-blake3-chacha8-poly1305',
]);

function parseSS(raw: string, ctx: LinkContext): UnifiedNode {
  const frag = stripFragment(raw.slice('ss://'.length));
  const body = frag.body;
  let name = frag.name;
  let userinfo = '';
  let hostport = '';
  let plugin = '';
  let pluginOpts = '';

  // 形态 A：SIP002  ss://base64(method:pass)@host:port/?plugin=...
  const at = body.lastIndexOf('@');
  const qIdx = body.indexOf('?');
  const base = qIdx >= 0 ? body.slice(0, qIdx) : body;
  const query = qIdx >= 0 ? parseQuery(body.slice(qIdx + 1)) : {};
  if (at >= 0) {
    userinfo = base.slice(0, at);
    hostport = base.slice(at + 1);
  } else {
    // 形态 B：旧式整体 Base64  ss://base64(method:pass@host:port)
    const decoded = decodeBase64Utf8(base);
    if (!decoded) throw new LinkError('Shadowsocks 链接既不是 SIP002（userinfo@host:port），也不是合法的旧式 Base64 编码');
    const inner = stripFragment(decoded);
    const idx = inner.body.lastIndexOf('@');
    if (idx < 0) throw new LinkError('Shadowsocks Base64 解码后缺少 @host:port 结构');
    userinfo = inner.body.slice(0, idx);
    hostport = inner.body.slice(idx + 1);
    if (inner.name && !name) name = inner.name;
  }
  // userinfo 可能是 method:password 明文，也可能是方法+密码的 Base64（SIP002）
  let methodPass = userinfo;
  const uDecoded = decodeBase64Utf8(decodeURIComponent(userinfo));
  if (uDecoded && uDecoded.includes(':')) methodPass = uDecoded;
  else {
    try { methodPass = decodeURIComponent(userinfo); } catch { /* 保留 */ }
  }
  const colon = methodPass.indexOf(':');
  if (colon < 0) throw new LinkError('Shadowsocks 无法拆出 method:password（加密方式或密码缺失）');
  const method = methodPass.slice(0, colon);
  const password = methodPass.slice(colon + 1);
  const hp = splitHostPort(hostport.replace(/\/+$/, ''), 8388);
  plugin = String(qStr(query, 'plugin') ?? '');
  pluginOpts = String(qStr(query, 'plugin-opts') ?? qStr(query, 'plugin_opts') ?? '');

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (!['plugin', 'plugin-opts', 'plugin_opts'].includes(k)) extras[k] = v;
  }
  const node = makeNode({
    protocol: 'ss', server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    method, password,
    protocolSettings: {
      ...(plugin ? { plugin } : {}),
      ...(pluginOpts ? { pluginOpts } : {}),
    },
    extras,
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  if (Object.keys(extras).length) {
    node.lossless = false;
    node.issues.push(issue('warning', 'UNKNOWN_FIELD',
      `Shadowsocks 查询参数 ${Object.keys(extras).join('、')} 未映射，原值已保留`, { location: ctx.location }));
  }
  if (!SS_METHODS.has(method.toLowerCase())) {
    node.issues.push(issue('warning', 'PARTIAL_COMPAT',
      `加密方式「${method}」不在常见支持列表内，Xray / sing-box / Mihomo 可能拒绝该算法；原值已保留，请在导入前确认内核支持`,
      { field: 'method', value: method, location: ctx.location }));
  }
  if (/^(rc4-md5|salsa20|chacha20|bf-cfb)$/i.test(method)) {
    node.issues.push(issue('warning', 'KERNEL_LIMIT',
      `加密方式「${method}」属于已废弃算法，新版 Xray/sing-box 默认禁用，通常只有 Mihomo 或旧内核可用`,
      { field: 'method', value: method, location: ctx.location }));
  }
  if (plugin) {
    node.issues.push(issue('warning', 'PARTIAL_COMPAT',
      `检测到插件「${plugin}」（${pluginOpts || '无参数'}）；插件参数已保留，但需对应插件可执行文件，内核本身不内置`,
      { field: 'plugin', value: plugin, location: ctx.location }));
  }
  validate(node, ['server', 'password', 'method'], ctx);
  return node;
}

function parseSSR(raw: string, ctx: LinkContext): UnifiedNode {
  const body = raw.slice('ssr://'.length).trim();
  const decoded = decodeBase64Utf8(body);
  if (!decoded) throw new LinkError('SSR 链接不是合法 Base64URL 编码');
  // server:port:protocol:method:obfs:base64(pass)/?remarks=&protoparam=&obfsparam=
  const [main, queryPart] = decoded.split('/?');
  const parts = main.split(':');
  if (parts.length < 6) throw new LinkError('SSR 结构不完整，应为 server:port:protocol:method:obfs:base64(password)');
  const pass = decodeBase64Utf8(parts.slice(5).join(':')) ?? parts.slice(5).join(':');
  const q = parseQuery(queryPart ?? '');
  const hp = splitHostPort(`${parts[0]}:${parts[1]}`, 8388);
  const remarksB64 = String(qStr(q, 'remarks') ?? '');
  const remarks = decodeBase64Utf8(remarksB64) ?? remarksB64;
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (!['remarks', 'protoparam', 'obfsparam', 'protoparam', 'udpport', 'uot'].includes(k)) extras[k] = v;
  }
  const node = makeNode({
    protocol: 'ssr', server: hp.server, port: hp.port,
    name: remarks || nameOrHost('', hp.server, hp.port),
    method: parts[3], password: pass,
    protocolSettings: {
      ssrProtocol: parts[2],
      obfs: parts[4],
      protocolParam: decodeBase64Utf8(String(qStr(q, 'protoparam') ?? '')) ?? String(qStr(q, 'protoparam') ?? ''),
      obfsParam: decodeBase64Utf8(String(qStr(q, 'obfsparam') ?? '')) ?? String(qStr(q, 'obfsparam') ?? ''),
      udpOverTcp: qBool(String(qStr(q, 'uot') ?? '')) ?? false,
    },
    extras,
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  node.issues.push(issue('warning', 'PARTIAL_COMPAT',
    'SSR 不在 Xray / sing-box 原生支持范围内，仅 Mihomo(Clash.Meta) 可承载；且 auth_chain / 部分 obfs 组合在新内核已不维护，导入后需实测',
    { field: 'protocol', value: 'ssr', location: ctx.location }));
  if (Object.keys(extras).length) {
    node.lossless = false;
    node.issues.push(issue('info', 'UNKNOWN_FIELD', `SSR 参数 ${Object.keys(extras).join('、')} 未映射，原值已保留`, { location: ctx.location }));
  }
  validate(node, ['server', 'password', 'method'], ctx);
  return node;
}

function parseSocks(raw: string, ctx: LinkContext): UnifiedNode {
  const scheme = raw.slice(0, raw.indexOf('://')).toLowerCase();
  const protocol: Protocol = scheme.startsWith('socks4') ? 'socks4' : 'socks5';
  const { body, name } = stripFragment(raw.slice(raw.indexOf('://') + 3));
  const u = safeURL(body);
  if (!u) throw new LinkError('SOCKS 链接的服务器地址无法解析');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), 1080);
  // 有些客户端把 user:pass 整体 Base64 放在 username 位
  let username = decodeURIComponent(u.username || '');
  let password = decodeURIComponent(u.password || '');
  if (username && !password) {
    const d = decodeBase64Utf8(username);
    if (d && d.includes(':')) { username = d.slice(0, d.indexOf(':')); password = d.slice(d.indexOf(':') + 1); }
  }
  const q = parseQuery(u.search);
  const node = makeNode({
    protocol, server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    password: password || undefined,
    protocolSettings: { ...(username ? { username } : {}) },
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  applyCommon(node, q as Record<string, any>, { ignore: [], location: ctx.location });
  if (protocol === 'socks4' && u.username) {
    node.issues.push(issue('info', 'PARTIAL_COMPAT', 'SOCKS4 只支持 userid，不支持密码认证；密码字段已保留但可能不生效', { field: 'password', location: ctx.location }));
  }
  return node;
}

function parseHttpProxy(raw: string, ctx: LinkContext): UnifiedNode {
  const isHttps = raw.toLowerCase().startsWith('https://');
  const { body, name } = stripFragment(raw.slice(raw.indexOf('://') + 3));
  const u = safeURL(body);
  if (!u) throw new LinkError('HTTP 代理链接的服务器地址无法解析');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), isHttps ? 443 : 8080);
  const node = makeNode({
    protocol: isHttps ? 'https' : 'http', server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    password: decodeURIComponent(u.password || '') || undefined,
    protocolSettings: { ...(u.username ? { username: decodeURIComponent(u.username) } : {}) },
    security: isHttps ? 'tls' : 'none',
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  if (isHttps) node.tls = { sni: hp.server };
  return node;
}

function parseHysteria(raw: string, ctx: LinkContext, v2: boolean): UnifiedNode {
  const prefix = raw.slice(0, raw.indexOf('://') + 3);
  const { body, name } = stripFragment(raw.slice(prefix.length));
  const u = safeURL(body);
  if (!u) throw new LinkError('Hysteria 链接的服务器地址无法解析');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), 443);
  const q = parseQuery(u.search);
  const auth = decodeURIComponent(u.username || '') || String(qStr(q, 'auth') ?? '') || decodeURIComponent(u.password || '');
  const protocol: Protocol = v2 ? 'hysteria2' : 'hysteria';
  const node = makeNode({
    protocol, server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    password: auth || undefined,
    security: 'tls',
    transport: 'quic',
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  applyCommon(node, q as Record<string, any>, { ignore: ['auth'], location: ctx.location });
  if (!auth) node.issues.push(issue('error', 'MISSING_REQUIRED', `缺少必填字段「auth / 认证密码」，${v2 ? 'Hysteria2' : 'Hysteria'} 无法连接`, { field: 'auth', location: ctx.location }));
  if (!v2) {
    node.issues.push(issue('warning', 'KERNEL_LIMIT',
      'Hysteria v1 协议已被 sing-box / Mihomo 逐步弃用（mihomo 仍部分兼容），建议改用 Hysteria2；v1 参数已完整保留',
      { field: 'protocol', value: 'hysteria', location: ctx.location }));
  }
  return node;
}

function parseTUIC(raw: string, ctx: LinkContext): UnifiedNode {
  const { body, name } = stripFragment(raw.slice('tuic://'.length));
  const u = safeURL(body);
  if (!u) throw new LinkError('TUIC 链接的服务器地址无法解析');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), 443);
  const q = parseQuery(u.search);
  let uuid = decodeURIComponent(u.username || '');
  let password = decodeURIComponent(u.password || '');
  // TUIC v4 用 token，v5 用 uuid:password
  const token = qStr(q, 'token');
  const node = makeNode({
    protocol: 'tuic', server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    uuid: uuid || undefined,
    password: password || token || undefined,
    security: 'tls', transport: 'quic',
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  applyCommon(node, q as Record<string, any>, { location: ctx.location });
  if (!uuid) node.issues.push(issue('error', 'MISSING_REQUIRED', '缺少必填字段「uuid」，TUIC 无法连接', { field: 'uuid', location: ctx.location }));
  if (token && !password) node.issues.push(issue('info', 'PARTIAL_COMPAT', '链接使用 TUIC v4 token 认证；sing-box / Mihomo 当前主要实现 v5（uuid:password），v4 可能不兼容，token 原值已保留', { field: 'token', location: ctx.location }));
  return node;
}

function parseWireGuardLink(raw: string, ctx: LinkContext): UnifiedNode {
  const { body, name } = stripFragment(raw.slice(raw.indexOf('://') + 3));
  const u = safeURL(body);
  if (!u) throw new LinkError('WireGuard 链接的服务器地址无法解析');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), 51820);
  const q = parseQuery(u.search);
  const priv = decodeBase64Utf8(decodeURIComponent(u.username || '')) ?? decodeURIComponent(u.username || '');
  const node = makeNode({
    protocol: 'wireguard', server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    transport: 'none', security: 'none',
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  applyCommon(node, q as Record<string, any>, { location: ctx.location });
  node.protocolSettings.privateKey = priv || undefined;
  if (!priv) node.issues.push(issue('error', 'MISSING_REQUIRED', '缺少必填字段「privateKey」，WireGuard 无法握手', { field: 'privateKey', location: ctx.location }));
  if (!qStr(q, 'publickey') && !qStr(q, 'publicKey')) {
    node.issues.push(issue('error', 'MISSING_REQUIRED', '缺少必填字段「对端 publicKey」，WireGuard 无法握手', { field: 'publicKey', location: ctx.location }));
  }
  return node;
}

function parseAnyTLS(raw: string, ctx: LinkContext): UnifiedNode {
  const { body, name } = stripFragment(raw.slice('anytls://'.length));
  const u = safeURL(body);
  if (!u) throw new LinkError('AnyTLS 链接的服务器地址无法解析');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), 443);
  const q = parseQuery(u.search);
  let password = decodeURIComponent(u.username || '');
  const d = decodeBase64Utf8(password);
  if (d && d.includes(':')) password = d.split(':').slice(1).join(':');
  const node = makeNode({
    protocol: 'anytls', server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    password: password || undefined, security: 'tls',
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  applyCommon(node, q as Record<string, any>, { location: ctx.location });
  if (!password) node.issues.push(issue('error', 'MISSING_REQUIRED', '缺少必填字段「password」，AnyTLS 无法连接', { field: 'password', location: ctx.location }));
  node.issues.push(issue('info', 'KERNEL_LIMIT', 'AnyTLS 需 sing-box ≥1.12 或 Mihomo ≥1.19，Xray 不支持；已自动按可用内核选择', { field: 'protocol', location: ctx.location }));
  return node;
}

function parseNaive(raw: string, ctx: LinkContext): UnifiedNode {
  const schemeEnd = raw.indexOf('://');
  const scheme = raw.slice(0, schemeEnd).toLowerCase();
  const { body, name } = stripFragment(raw.slice(schemeEnd + 3));
  const u = safeURL(body);
  if (!u) throw new LinkError('NaiveProxy 链接的服务器地址无法解析');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), 443);
  const q = parseQuery(u.search);
  const node = makeNode({
    protocol: 'naive', server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    password: decodeURIComponent(u.password || '') || undefined,
    security: scheme.includes('quic') ? 'tls' : 'tls',
    transport: scheme.includes('quic') ? 'quic' : 'h2',
    protocolSettings: { ...(u.username ? { username: decodeURIComponent(u.username) } : {}), scheme },
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  applyCommon(node, q as Record<string, any>, { location: ctx.location });
  node.issues.push(issue('warning', 'PARTIAL_COMPAT',
    'NaiveProxy 依赖 Chrome 网络栈，Xray / sing-box 均不原生支持；仅 Mihomo 的部分分支或独立 naive 客户端可用，导入后需确认客户端支持',
    { field: 'protocol', value: 'naive', location: ctx.location }));
  return node;
}

function parseSSH(raw: string, ctx: LinkContext): UnifiedNode {
  const { body, name } = stripFragment(raw.slice('ssh://'.length));
  const u = safeURL(body);
  if (!u) throw new LinkError('SSH 链接的服务器地址无法解析');
  const hp = splitHostPort(u.hostname + (u.port ? ':' + u.port : ''), 22);
  const q = parseQuery(u.search);
  const node = makeNode({
    protocol: 'ssh', server: hp.server, port: hp.port,
    name: nameOrHost(name, hp.server, hp.port),
    password: decodeURIComponent(u.password || '') || undefined,
    protocolSettings: { ...(u.username ? { username: decodeURIComponent(u.username) } : {}) },
    raw, rawFormat: ctx.rawFormat ?? 'share-link', source: ctx.source ?? 'paste',
  });
  applyCommon(node, q as Record<string, any>, { location: ctx.location });
  node.issues.push(issue('warning', 'PARTIAL_COMPAT',
    'SSH 隧道不属于三大内核的原生出站协议；已保留用户名/密码/私钥/hostKey 等全部参数，仅能交给外部 SSH 客户端或插件处理',
    { field: 'protocol', value: 'ssh', location: ctx.location }));
  return node;
}

/* ================================ 统一入口 ================================ */

/** 解析单条分享链接。永远返回结果对象，不抛异常给调用方。 */
export function parseShareLink(raw: string, ctx: LinkContext = {}): LinkOutcome {
  const text = (raw ?? '').trim();
  const location = ctx.location;
  if (!text) return { rejected: { raw, reason: '空内容', issues: [issue('error', 'PARSE_ERROR', '空内容，无法解析')], location } };

  // 普通网页 / 订阅 URL 不能误报成 HTTP 代理节点
  if (/^https?:\/\//i.test(text) && !isProxyLikeHttpUrl(text)) {
    return { rejected: {
      raw: text,
      reason: '这是普通 HTTP(S) URL，不是 HTTP 代理节点分享链接；若它是订阅地址，请用「订阅导入」通道，解析中心不会把它误判为节点',
      issues: [issue('warning', 'UNSUPPORTED_PROTOCOL', '普通网页/订阅 URL 不会被当作 HTTP 代理节点导入，避免误报成功', { location })],
      location,
    } } as LinkOutcome;
  }

  const lower = text.toLowerCase();
  try {
    let node: UnifiedNode;
    if (lower.startsWith('vmess://')) node = parseVMess(text, ctx);
    else if (lower.startsWith('vless://')) node = parseVLESS(text, ctx);
    else if (lower.startsWith('trojan://')) node = parseTrojan(text, ctx);
    else if (lower.startsWith('ss://')) node = parseSS(text, ctx);
    else if (lower.startsWith('ssr://')) node = parseSSR(text, ctx);
    else if (/^socks(4|4a|5|5h)?:\/\//.test(lower)) node = parseSocks(text, ctx);
    else if (lower.startsWith('http://') || lower.startsWith('https://')) node = parseHttpProxy(text, ctx);
    else if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://')) node = parseHysteria(text, ctx, true);
    else if (lower.startsWith('hysteria://')) node = parseHysteria(text, ctx, false);
    else if (lower.startsWith('tuic://')) node = parseTUIC(text, ctx);
    else if (lower.startsWith('wireguard://') || lower.startsWith('wg://')) node = parseWireGuardLink(text, ctx);
    else if (lower.startsWith('anytls://')) node = parseAnyTLS(text, ctx);
    else if (lower.startsWith('naive://') || lower.startsWith('naive+https://') || lower.startsWith('naive+quic://')) node = parseNaive(text, ctx);
    else if (lower.startsWith('ssh://')) node = parseSSH(text, ctx);
    else {
      return { rejected: {
        raw: text,
        reason: `不支持的分享链接协议「${text.split(':')[0]}」；解析中心不会把无法识别的格式伪装成导入成功`,
        issues: [issue('error', 'UNSUPPORTED_PROTOCOL', `不支持的协议前缀：${text.slice(0, 40)}`, { location })],
        location,
      } } as LinkOutcome;
    }

    if (!node.server || !Number.isFinite(node.port) || node.port <= 0) {
      node.issues.push(issue('error', 'MISSING_REQUIRED', '服务器地址或端口无效', { location }));
    }
    return { node };
  } catch (e) {
    const err = e as LinkError;
    return { rejected: {
      raw: text,
      reason: err.message || String(e),
      issues: err.issues?.length ? err.issues : [issue('error', 'PARSE_ERROR', err.message || String(e), { location })],
      location,
    } } as LinkOutcome;
  }
}

/** 批量解析多行分享链接 */
export function parseShareLinks(text: string, ctx: LinkContext = {}): { nodes: UnifiedNode[]; rejected: RejectedItem[] } {
  const nodes: UnifiedNode[] = [];
  const rejected: RejectedItem[] = [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
  lines.forEach((line, i) => {
    const out = parseShareLink(line, { ...ctx, location: `第 ${i + 1} 行` });
    if ('node' in out) nodes.push(out.node);
    else rejected.push(out.rejected);
  });
  return { nodes, rejected };
}
