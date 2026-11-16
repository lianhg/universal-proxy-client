/**
 * 统一配置解析中心 —— 多内核架构
 *
 * Xray / sing-box / Mihomo(Clash.Meta) 能力矩阵 + 自动选核 + 配置导出。
 * 明确原则：不能仅凭协议名称就保证配置可用，还要检查传输层、安全层、流控、加密算法。
 * 内核无法表达的字段不静默丢弃，一律记入 issue 并保留在 raw / extras。
 */

import type { KernelType, ParseIssue, Protocol, Transport, UnifiedNode } from './model.js';
import { issue } from './util.js';

export type SupportLevel = 'native' | 'versioned' | 'partial' | 'unsupported';

export interface Capability {
  level: SupportLevel;
  /** 最低内核版本要求 */
  since?: string;
  note: string;
}

type Matrix = Record<Protocol, Record<KernelType, Capability>>;

const N = (note = '原生支持'): Capability => ({ level: 'native', note });
const V = (since: string, note: string): Capability => ({ level: 'versioned', since, note });
const P = (note: string): Capability => ({ level: 'partial', note });
const U = (note: string): Capability => ({ level: 'unsupported', note });

/**
 * 协议支持矩阵。标注为 versioned / partial 的会额外生成 KERNEL_LIMIT 提示。
 * 版本门槛按各内核公开的能力整理，实际可用性仍需内核二进制校验（本轮不含内核进程管理）。
 */
export const KERNEL_MATRIX: Matrix = {
  vmess: {
    xray: N(), 'sing-box': N(), mihomo: N(),
  },
  vless: {
    xray: N('VLESS / Reality / XTLS Vision 的参考实现'),
    'sing-box': N(), mihomo: N('Reality / XHTTP 需较新版本'),
  },
  trojan: {
    xray: N(), 'sing-box': N(), mihomo: N(),
  },
  ss: {
    xray: N('常见 AEAD 加密；rc4-md5 等废弃算法不支持'),
    'sing-box': N('含 shadowsocks2022；废弃算法不支持'),
    mihomo: N('对旧加密算法兼容最好'),
  },
  ssr: {
    xray: U('Xray 不含 SSR 出站实现'),
    'sing-box': U('sing-box 不含 SSR 出站实现'),
    mihomo: P('仅 Mihomo(Clash.Meta) 保留 SSR 支持；auth_chain / 部分 obfs 组合已不维护，需实测'),
  },
  socks4: {
    xray: P('SOCKS 出站主要面向 SOCKS5，SOCKS4/4a 支持有限'),
    'sing-box': P('主要实现 SOCKS5，SOCKS4 需确认版本'),
    mihomo: P('Clash 侧仅实现 SOCKS5'),
  },
  socks5: {
    xray: N(), 'sing-box': N(), mihomo: N(),
  },
  http: {
    xray: N(), 'sing-box': N(), mihomo: N(),
  },
  https: {
    xray: V('1.8.0', 'HTTP 出站叠加 TLS'),
    'sing-box': N(), mihomo: P('通常以 http + tls 组合表达'),
  },
  hysteria: {
    xray: U('Xray 不含 Hysteria v1'),
    'sing-box': P('sing-box 新版聚焦 Hysteria2，v1 支持已移除或需回退版本'),
    mihomo: P('Mihomo 保留部分 v1 兼容，建议升级到 Hysteria2'),
  },
  hysteria2: {
    xray: U('Xray 不含 Hysteria2 出站'),
    'sing-box': N(), mihomo: N(),
  },
  tuic: {
    xray: U('Xray 不含 TUIC 出站'),
    'sing-box': V('1.9.0', 'TUIC v5'),
    mihomo: V('1.18.0', 'TUIC v5；v4 token 认证不通用'),
  },
  wireguard: {
    // Xray 虽有 wireguard 出站（1.8.6+），但它需要本机私钥 secretKey、接口地址、
    // peer 公钥等完整 WireGuard 接口参数，通用分享链接 / 订阅不携带这些字段，
    // 按 Xray schema 生成的配置会被内核整体拒绝（连累其它正常节点）。
    // 因此明确判不支持，WireGuard 节点请用 sing-box / Mihomo 承载。
    xray: U('Xray 的 wireguard 出站需要本机私钥（secretKey）与 peer 公钥等完整接口参数，分享链接 / 订阅不携带；请用 sing-box 或 Mihomo'),
    'sing-box': N(), mihomo: N(),
  },
  anytls: {
    xray: U('Xray 不含 AnyTLS'),
    'sing-box': V('1.12.0', 'AnyTLS 出站'),
    mihomo: V('1.19.0', 'AnyTLS 出站'),
  },
  naive: {
    xray: U('NaiveProxy 依赖 Chrome 网络栈，Xray 不实现'),
    'sing-box': U('sing-box 不实现 NaiveProxy'),
    mihomo: P('仅部分分支 / 外部 naive 客户端可用'),
  },
  ssh: {
    xray: U('Xray 不含 SSH 隧道出站'),
    'sing-box': U('sing-box 不含 SSH 隧道出站'),
    mihomo: P('需外部 SSH 客户端或插件，参数已保留'),
  },
  unknown: {
    xray: U('协议未识别'), 'sing-box': U('协议未识别'), mihomo: U('协议未识别'),
  },
};

export const KERNEL_LABELS: Record<KernelType, string> = {
  xray: 'Xray-core', 'sing-box': 'sing-box', mihomo: 'Mihomo (Clash.Meta)',
};

/** 传输层 / 安全层的额外门槛 */
interface FeatureGate {
  kernel: KernelType;
  since: string;
  note: string;
  match: (n: UnifiedNode) => boolean;
}

const FEATURE_GATES: FeatureGate[] = [
  { kernel: 'xray', since: '1.8.0', note: 'VLESS Reality', match: n => n.security === 'reality' },
  { kernel: 'sing-box', since: '1.8.0', note: 'VLESS Reality', match: n => n.security === 'reality' },
  { kernel: 'mihomo', since: '1.18.0', note: 'VLESS Reality', match: n => n.security === 'reality' },
  { kernel: 'xray', since: '25.3.6', note: 'XHTTP 传输', match: n => n.transport === 'xhttp' },
  { kernel: 'sing-box', since: '1.12.0', note: 'XHTTP 传输', match: n => n.transport === 'xhttp' },
  { kernel: 'mihomo', since: '1.19.0', note: 'XHTTP 传输', match: n => n.transport === 'xhttp' },
  { kernel: 'sing-box', since: '1.11.0', note: 'XTLS Vision 流控', match: n => /vision/i.test(n.flow ?? '') },
  { kernel: 'mihomo', since: '1.19.0', note: 'XTLS Vision 流控', match: n => /vision/i.test(n.flow ?? '') },
  { kernel: 'xray', since: '1.8.0', note: 'gRPC 传输', match: n => n.transport === 'grpc' },
  { kernel: 'mihomo', since: '1.15.0', note: 'HTTPUpgrade 传输', match: n => n.transport === 'httpupgrade' },
  { kernel: 'sing-box', since: '1.10.0', note: 'SplitHTTP 传输', match: n => n.transport === 'splithttp' },
];

const LEGACY_SS_METHODS = /^(rc4-md5|salsa20|chacha20|bf-cfb|camellia-\d+-cfb|aes-\d+-(cfb|ctr))$/i;

/**
 * 为节点选择可用内核（按推荐顺序）。结果写回 node.kernels / node.kernel / node.kernelReason。
 * 返回新增的提示，供报告汇总。
 */
export function selectKernels(node: UnifiedNode): ParseIssue[] {
  const added: ParseIssue[] = [];
  const base = KERNEL_MATRIX[node.protocol] ?? KERNEL_MATRIX.unknown;
  const scored: { kernel: KernelType; score: number; caps: Capability }[] = [];

  for (const kernel of ['xray', 'sing-box', 'mihomo'] as KernelType[]) {
    const cap = base[kernel];
    let score = cap.level === 'native' ? 100 : cap.level === 'versioned' ? 80 : cap.level === 'partial' ? 45 : -1;
    if (score < 0) continue;
    // Reality + Vision 优先 Xray（参考实现）
    if (kernel === 'xray' && (node.security === 'reality' || /vision/i.test(node.flow ?? ''))) score += 12;
    // Hysteria2 / TUIC / WireGuard / AnyTLS 优先 sing-box
    if (kernel === 'sing-box' && ['hysteria2', 'tuic', 'wireguard', 'anytls'].includes(node.protocol)) score += 12;
    // SSR 只能 Mihomo
    if (kernel === 'mihomo' && node.protocol === 'ssr') score += 60;
    // 老 SS 加密算法：Xray / sing-box 降级
    if (node.protocol === 'ss' && LEGACY_SS_METHODS.test(node.method ?? '') && kernel !== 'mihomo') score -= 55;
    // 版本门槛
    const gates = FEATURE_GATES.filter(g => g.kernel === kernel && g.match(node));
    for (const g of gates) {
      score -= 3;
      added.push(issue('info', 'KERNEL_LIMIT',
        `${KERNEL_LABELS[kernel]} 承载「${g.note}」需要版本 ≥ ${g.since}，请在高级设置中确认内核版本`,
        { kernel, field: g.note, value: g.since }));
    }
    if (cap.level !== 'native') {
      added.push(issue(cap.level === 'unsupported' ? 'error' : 'warning', 'KERNEL_LIMIT',
        `${KERNEL_LABELS[kernel]} 对 ${node.protocol.toUpperCase()} 的兼容性：${cap.note}${cap.since ? `（需 ≥ ${cap.since}）` : ''}`,
        { kernel, field: 'protocol', value: node.protocol }));
    }
    scored.push({ kernel, score, caps: cap });
  }

  scored.sort((a, b) => b.score - a.score);
  const usable = scored.filter(s => s.score > 0);
  node.kernels = usable.map(s => s.kernel);
  node.kernel = usable[0]?.kernel ?? null;
  const chosen = usable[0]?.caps;
  node.kernelReason = chosen
    ? `推荐 ${KERNEL_LABELS[usable[0].kernel]}：${chosen.note}${chosen.since ? `（≥ ${chosen.since}）` : ''}`
    : '当前三大内核均无法完整承载该节点，需要额外兼容处理或外部客户端；配置已完整保留，未做任何丢弃';

  if (!node.kernel) {
    added.push(issue('error', 'KERNEL_LIMIT',
      `节点「${node.name}」(协议 ${node.protocol.toUpperCase()}) 在 Xray / sing-box / Mihomo 中均无可用实现；请更换节点或安装对应外部内核。配置未被丢弃。`,
      { field: 'protocol', value: node.protocol }));
  }
  node.issues.push(...added);
  return added;
}

/* ================================ 配置导出 ================================ */

export interface ExportResult {
  kernel: KernelType;
  config: Record<string, unknown>;
  issues: ParseIssue[];
  /** 生成配置里未表达的原字段（调用方必须展示给用户） */
  unmapped: string[];
}

function hostPortOf(n: UnifiedNode): string {
  return /:/.test(n.server) && !n.server.startsWith('[') ? `[${n.server}]` : n.server;
}

/** Xray outbound */
export function buildXrayOutbound(n: UnifiedNode): { outbound: Record<string, unknown>; unmapped: string[] } {
  const unmapped: string[] = [];
  const addr = hostPortOf(n);
  const settings: Record<string, unknown> = {};
  const user: Record<string, unknown> = {};
  if (n.uuid) user.id = n.uuid;
  if (n.alterId !== undefined) user.alterId = n.alterId;
  if (n.flow) user.flow = n.flow;
  // VLESS 的 encryption 只支持 "none"，且 Xray 26.x 缺字段时直接拒载
  //（"please add/set encryption:none for every user"），缺省时主动补齐。
  if (n.protocol === 'vless') user.encryption = n.protocolSettings.encryption || 'none';
  else if (n.protocolSettings.encryption) user.encryption = n.protocolSettings.encryption;
  if (n.protocol === 'vmess' || n.protocol === 'vless') {
    settings.vnext = [{ address: addr, port: n.port, users: [user] }];
  } else {
    const server: Record<string, unknown> = { address: addr, port: n.port };
    if (n.password) server.password = n.password;
    if (n.method) server.method = n.method;
    if (n.protocolSettings.username) server.users = [{ user: n.protocolSettings.username, pass: n.password ?? '' }];
    settings.servers = [server];
  }

  const stream: Record<string, unknown> = { network: n.transport === 'none' ? 'tcp' : n.transport };
  if (n.security !== 'none') stream.security = n.security;
  if (n.tls) {
    stream.tlsSettings = {
      ...(n.tls.sni ? { serverName: n.tls.sni } : {}),
      ...(n.tls.alpn ? { alpn: n.tls.alpn } : {}),
      ...(n.tls.fingerprint ? { fingerprint: n.tls.fingerprint } : {}),
      ...(n.tls.allowInsecure !== undefined ? { allowInsecure: n.tls.allowInsecure } : {}),
    };
  }
  if (n.reality) {
    stream.realitySettings = {
      ...(n.reality.publicKey ? { publicKey: n.reality.publicKey } : {}),
      ...(n.reality.shortId ? { shortId: n.reality.shortId } : {}),
      ...(n.reality.spiderX ? { spiderX: n.reality.spiderX } : {}),
      ...(n.reality.serverName ? { serverName: n.reality.serverName } : {}),
      ...(n.reality.fingerprint ? { fingerprint: n.reality.fingerprint } : {}),
    };
  }
  const ts = n.transportSettings;
  if (n.transport === 'ws') stream.wsSettings = { ...(ts.path ? { path: ts.path } : {}), ...(ts.host ? { headers: { Host: ts.host } } : {}) };
  if (n.transport === 'grpc') stream.grpcSettings = { ...(ts.serviceName ? { serviceName: ts.serviceName } : {}), ...(ts.authority ? { authority: ts.authority } : {}) };
  if (n.transport === 'xhttp' || n.transport === 'splithttp') {
    stream.xhttpSettings = { ...(ts.path ? { path: ts.path } : {}), ...(ts.mode ? { mode: ts.mode } : {}), ...(ts.host ? { host: ts.host } : {}), ...(ts.extra ? { extra: ts.extra } : {}) };
  }
  if (ts.header || ts.headerType) stream.tcpSettings = { header: ts.header ?? { type: ts.headerType } };
  if (ts.sockopt) stream.sockopt = ts.sockopt;

  // Xray 出站协议名与统一模型的命名不同（"ss"/"socks5" 是 Clash 系叫法）
  const XRAY_PROTOCOL: Record<string, string> = {
    ss: 'shadowsocks',
    socks4: 'socks',
    socks5: 'socks',
    https: 'http',
  };
  const outbound: Record<string, unknown> = {
    tag: n.name, protocol: XRAY_PROTOCOL[n.protocol] ?? n.protocol,
    settings, streamSettings: stream,
  };
  for (const key of Object.keys(n.extras)) unmapped.push(key);
  // 协议专属参数中，Xray schema 无法表达的部分
  for (const key of Object.keys(n.protocolSettings)) {
    if (['encryption', 'level', 'ota', 'mux', 'username'].includes(key)) continue;
    unmapped.push(`protocolSettings.${key}`);
  }
  return { outbound, unmapped };
}

/** sing-box outbound */
export function buildSingBoxOutbound(n: UnifiedNode): { outbound: Record<string, unknown>; unmapped: string[] } {
  const unmapped: string[] = [];
  const typeMap: Partial<Record<Protocol, string>> = {
    ss: 'shadowsocks', ssr: 'shadowsocksr', socks4: 'socks', socks5: 'socks',
    http: 'http', https: 'http', hysteria2: 'hysteria2', wireguard: 'wireguard',
  };
  // WireGuard 是"本机即接口"的协议：需要本机私钥 / 接口地址 / peer 公钥，
  // 与普通 client-server 协议的 schema 完全不同，必须走专属分支。
  if (n.protocol === 'wireguard') {
    const ps = (n.protocolSettings ?? {}) as Record<string, unknown>;
    const pick = (...keys: string[]): unknown => {
      for (const k of keys) { const v = ps[k]; if (v !== undefined && v !== null && v !== '') return v; }
      return undefined;
    };
    const privateKey = pick('privateKey', 'private-key') as string | undefined;
    const peerKey = pick('publicKey', 'public-key', 'peerPublicKey') as string | undefined;
    const localAddr = pick('address', 'localAddress', 'local-address');
    const ob: Record<string, unknown> = { type: 'wireguard', tag: n.name, server: n.server, server_port: n.port };
    if (privateKey) ob.private_key = privateKey;
    if (peerKey) ob.peer_public_key = peerKey;
    if (localAddr !== undefined) {
      ob.local_address = Array.isArray(localAddr)
        ? localAddr.map(String)
        : String(localAddr).split(',').map(s => s.trim()).filter(Boolean);
    }
    const psk = pick('preSharedKey', 'pre-shared-key', 'presharedkey') as string | undefined;
    if (psk) ob.pre_shared_key = psk;
    const reserved = pick('reserved');
    if (reserved !== undefined) {
      ob.reserved = Array.isArray(reserved)
        ? reserved
        : String(reserved).split(',').map(s => Number(s.trim())).filter(Number.isFinite);
    }
    const mtu = pick('mtu');
    if (mtu !== undefined && Number.isFinite(Number(mtu))) ob.mtu = Number(mtu);
    for (const key of Object.keys(n.extras)) unmapped.push(key);
    // 缺密钥 = 必然握手失败，如实登记而不是假装能连
    if (!privateKey) unmapped.push('wireguard.privateKey（缺失，无法握手）');
    if (!peerKey) unmapped.push('wireguard.publicKey（缺失，无法握手）');
    return { outbound: ob, unmapped };
  }
  const ob: Record<string, unknown> = {
    type: typeMap[n.protocol] ?? n.protocol,
    tag: n.name, server: n.server, server_port: n.port,
  };
  if (n.uuid) ob.uuid = n.uuid;
  if (n.password) ob.password = n.password;
  if (n.method) ob.method = n.method;
  if (n.flow) ob.flow = n.flow;
  if (n.security !== 'none' || n.tls || n.reality) {
    ob.tls = {
      enabled: true,
      ...(n.tls?.sni || n.reality?.serverName ? { server_name: n.tls?.sni ?? n.reality?.serverName } : {}),
      ...(n.tls?.alpn ? { alpn: n.tls.alpn } : {}),
      ...(n.tls?.fingerprint ? { utls: { enabled: true, fingerprint: n.tls.fingerprint } } : {}),
      ...(n.tls?.allowInsecure ? { insecure: true } : {}),
      ...(n.reality ? { reality: {
        enabled: true,
        ...(n.reality.publicKey ? { public_key: n.reality.publicKey } : {}),
        ...(n.reality.shortId ? { short_id: n.reality.shortId } : {}),
      } } : {}),
    };
  }
  const ts = { ...n.transportSettings };
  delete ts.network;
  // sing-box 的 transport 字段名与 Xray 风格不同，必须逐类型映射；
  // 直接展开 transportSettings 会产出 "unknown field"（如 ws 顶层 host）被内核拒绝。
  if (n.transport === 'ws') {
    ob.transport = {
      type: 'ws',
      ...(ts.path ? { path: ts.path } : {}),
      ...(ts.host ? { headers: { Host: ts.host } } : {}),
      ...(ts.maxEarlyData ? { max_early_data: Number(ts.maxEarlyData) } : {}),
      ...(ts.earlyDataHeaderName ? { early_data_header_name: ts.earlyDataHeaderName } : {}),
    };
  } else if (n.transport === 'grpc') {
    ob.transport = {
      type: 'grpc',
      ...(ts.serviceName ? { service_name: ts.serviceName } : {}),
    };
  } else if (n.transport === 'h2' || n.transport === 'http') {
    ob.transport = {
      type: 'http',
      ...(ts.host ? { host: Array.isArray(ts.host) ? ts.host : [ts.host] } : {}),
      ...(ts.path ? { path: ts.path } : {}),
    };
  } else if (n.transport === 'httpupgrade') {
    ob.transport = {
      type: 'httpupgrade',
      ...(ts.host ? { host: ts.host } : {}),
      ...(ts.path ? { path: ts.path } : {}),
    };
  } else if (n.transport !== 'tcp' && n.transport !== 'none' && Object.keys(ts).length) {
    // 未知 transport 原样透传，字段问题交由内核在启动时报明确错误
    ob.transport = { type: n.transport, ...ts };
  }
  for (const key of Object.keys(n.extras)) unmapped.push(key);
  for (const [k, v] of Object.entries(n.protocolSettings)) {
    if (['plugin', 'multiplex', 'packetEncoding', 'udpOverTcp', 'mtu', 'congestionControl', 'privateKey'].includes(k)) {
      ob[k === 'packetEncoding' ? 'packet_encoding' : k === 'udpOverTcp' ? 'udp_over_tcp' : k === 'congestionControl' ? 'congestion_control' : k === 'privateKey' ? 'private_key' : k] = v;
    } else unmapped.push(`protocolSettings.${k}`);
  }
  return { outbound: ob, unmapped };
}

/** Mihomo / Clash proxy */
export function buildMihomoProxy(n: UnifiedNode): { proxy: Record<string, unknown>; unmapped: string[] } {
  const unmapped: string[] = [];
  const p: Record<string, unknown> = {
    name: n.name, type: n.protocol === 'socks4' ? 'socks5' : n.protocol,
    server: n.server, port: n.port,
  };
  // WireGuard 专属 schema：本机接口地址 + 双方密钥，缺密钥等于无法握手
  if (n.protocol === 'wireguard') {
    const ps = (n.protocolSettings ?? {}) as Record<string, unknown>;
    const pick = (...keys: string[]): unknown => {
      for (const k of keys) { const v = ps[k]; if (v !== undefined && v !== null && v !== '') return v; }
      return undefined;
    };
    const privateKey = pick('privateKey', 'private-key') as string | undefined;
    const peerKey = pick('publicKey', 'public-key', 'peerPublicKey') as string | undefined;
    const localAddr = pick('address', 'localAddress', 'local-address', 'ip');
    if (privateKey) p['private-key'] = privateKey;
    if (peerKey) p['public-key'] = peerKey;
    if (localAddr !== undefined) p.ip = Array.isArray(localAddr) ? String(localAddr[0]) : String(localAddr).split(',')[0].trim();
    const psk = pick('preSharedKey', 'pre-shared-key', 'presharedkey') as string | undefined;
    if (psk) p['pre-shared-key'] = psk;
    const allowed = pick('allowedIPs', 'allowed-ips', 'allowedips');
    if (allowed !== undefined) {
      p['allowed-ips'] = Array.isArray(allowed) ? allowed.map(String) : String(allowed).split(',').map(s => s.trim()).filter(Boolean);
    }
    const reserved = pick('reserved');
    if (reserved !== undefined) {
      p.reserved = Array.isArray(reserved)
        ? reserved
        : String(reserved).split(',').map(s => Number(s.trim())).filter(Number.isFinite);
    }
    const mtu = pick('mtu');
    if (mtu !== undefined && Number.isFinite(Number(mtu))) p.mtu = Number(mtu);
    for (const key of Object.keys(n.extras)) unmapped.push(key);
    if (!privateKey) unmapped.push('wireguard.privateKey（缺失，无法握手）');
    if (!peerKey) unmapped.push('wireguard.publicKey（缺失，无法握手）');
    return { proxy: p, unmapped };
  }
  if (n.uuid) p.uuid = n.uuid;
  if (n.password) p.password = n.password;
  if (n.method) p.cipher = n.method;
  if (n.alterId !== undefined) p.alterId = n.alterId;
  if (n.flow) p.flow = n.flow;
  if (n.transport !== 'tcp' && n.transport !== 'none') p.network = n.transport;
  if (n.security !== 'none') p.tls = true;
  if (n.tls?.sni) p.sni = n.tls.sni;
  if (n.tls?.alpn) p.alpn = n.tls.alpn;
  if (n.tls?.fingerprint) p['client-fingerprint'] = n.tls.fingerprint;
  if (n.tls?.allowInsecure !== undefined) p['skip-cert-verify'] = n.tls.allowInsecure;
  if (n.reality) p['reality-opts'] = {
    ...(n.reality.publicKey ? { 'public-key': n.reality.publicKey } : {}),
    ...(n.reality.shortId ? { 'short-id': n.reality.shortId } : {}),
    ...(n.reality.spiderX ? { 'spider-x': n.reality.spiderX } : {}),
  };
  const ts = n.transportSettings;
  if (ts.path) p['ws-opts'] = { path: ts.path, ...(ts.host ? { headers: { Host: ts.host } } : {}) };
  if (ts.serviceName) p['grpc-opts'] = { 'grpc-service-name': ts.serviceName };
  for (const key of Object.keys(n.extras)) unmapped.push(key);
  for (const key of Object.keys(n.protocolSettings)) {
    if (['plugin', 'udp', 'flow', 'encryption'].includes(key)) continue;
    unmapped.push(`protocolSettings.${key}`);
  }
  return { proxy: p, unmapped };
}

/** 为节点生成指定内核的完整配置骨架（只生成文本，不启动内核、不写文件） */
export function generateKernelConfig(nodes: UnifiedNode[], kernel: KernelType): ExportResult {
  const issues: ParseIssue[] = [];
  const unmapped = new Set<string>();
  const unsupported: string[] = [];

  const builders = {
    xray: buildXrayOutbound,
    'sing-box': buildSingBoxOutbound,
    mihomo: buildMihomoProxy,
  };
  const items: Record<string, unknown>[] = [];
  for (const n of nodes) {
    if (!n.kernels.includes(kernel)) {
      unsupported.push(`${n.name} (${n.protocol.toUpperCase()})`);
      issues.push(issue('error', 'KERNEL_LIMIT',
        `节点「${n.name}」不能由 ${KERNEL_LABELS[kernel]} 承载：${n.kernelReason ?? '内核能力矩阵中不支持'}；该节点未写入生成配置，原配置仍完整保留`,
        { kernel, field: 'protocol', value: n.protocol }));
      continue;
    }
    const r = (builders[kernel] as any)(n);
    items.push(r.outbound ?? r.proxy);
    r.unmapped.forEach((x: string) => unmapped.add(x));
  }

  let config: Record<string, unknown>;
  if (kernel === 'xray') {
    config = {
      log: { loglevel: 'warning' },
      inbounds: [{ tag: 'socks-in', port: 10808, listen: '127.0.0.1', protocol: 'socks', settings: { udp: true } }],
      outbounds: [...items, { tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }],
      routing: { domainStrategy: 'IPIfNonMatch', rules: [] },
    };
  } else if (kernel === 'sing-box') {
    config = {
      log: { level: 'warn' },
      inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 7890 }],
      outbounds: [...items, { type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' }],
      route: { rules: [] },
    };
  } else {
    config = {
      'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
      proxies: items, 'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: items.map((i: any) => i.name ?? i.tag) }],
      rules: ['MATCH,PROXY'],
    };
  }

  if (unmapped.size) {
    issues.push(issue('warning', 'UNSUPPORTED_FIELD',
      `生成 ${KERNEL_LABELS[kernel]} 配置时有 ${unmapped.size} 类字段无法表达（${[...unmapped].slice(0, 12).join('、')}${unmapped.size > 12 ? '…' : ''}）。这些字段没有静默丢弃：原值仍保存在节点的 raw / extras 中，需人工确认是否影响连接。`,
      { kernel }));
  }
  if (unsupported.length) {
    issues.push(issue('warning', 'KERNEL_LIMIT',
      `${unsupported.length} 个节点因内核不支持被排除：${unsupported.join('、')}。建议切换到自动选核模式，或为这些节点单独指定内核。`,
      { kernel }));
  }
  issues.push(issue('info', 'SECURITY',
    '此处只生成配置对象，不启动内核、不写系统代理、不开启 TUN。配置需用户确认后才能落盘执行。',
    { kernel }));
  return { kernel, config, issues, unmapped: [...unmapped] };
}

/** 能力表（供 UI 渲染协议 × 内核矩阵） */
export function capabilityTable(): Array<{ protocol: Protocol; label: string; xray: Capability; 'sing-box': Capability; mihomo: Capability }> {
  return Object.entries(KERNEL_MATRIX).map(([protocol, caps]) => ({
    protocol: protocol as Protocol,
    label: protocol.toUpperCase(),
    ...caps,
  }));
}
