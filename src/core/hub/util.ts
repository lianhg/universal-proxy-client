/** 统一配置解析中心 —— 编码 / URL / 字段映射工具（浏览器 + Node 双端可用，零依赖） */

import type { ParseIssue, UnifiedNode, ImportReport, ImportStats } from './model.js';

/* ---------------------------------- Base64 ---------------------------------- */

/**
 * 经过 globalThis 取 Node 的 Buffer：渲染层（Electron 无 nodeIntegration）打包后
 * 不能出现裸 Buffer 调用，否则模块一加载就会抛 ReferenceError 黑屏。
 * 这里的写法既保留 Node 侧的性能，又在浏览器里天然降级到 atob / btoa。
 */
const nodeB64 = (globalThis as unknown as {
  Buffer?: {
    from(data: string, enc: 'base64'): Uint8Array;
    from(data: Uint8Array): { toString(enc: 'base64'): string };
  };
}).Buffer;

export function decodeBase64Bytes(input: string): Uint8Array | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!s || !/^[A-Za-z0-9+/=]+$/.test(s)) return null;
  while (s.length % 4) s += '=';
  try {
    if (nodeB64) return new Uint8Array(nodeB64.from(s, 'base64'));
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

export function decodeBase64Utf8(input: string): string | null {
  const bytes = decodeBase64Bytes(input);
  if (!bytes) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // 乱码率过高说明不是文本型 Base64（可能是二进制/图片）
    if (/\uFFFD/.test(text)) return null;
    return text;
  } catch { return null; }
}

export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (nodeB64) return nodeB64.from(bytes).toString('base64');
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

/** 判断字符串是否"像" Base64 文本，避免把普通分享链接误判成 Base64 */
export function isLikelyBase64(input: string): boolean {
  const s = input.trim().replace(/\s+/g, '');
  if (s.length < 8 || s.length % 4 === 1) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(s)) return false;
  if (/^(vmess|vless|trojan|ss|ssr|tuic|hy2|hysteria2?|http|socks|wireguard|anytls|naive|ssh|clash|sing-box|v2rayn):\/\//i.test(s)) return false;
  return true;
}

/* ----------------------------------- URL ----------------------------------- */

export function splitHostPort(input: string, defaultPort = 443): { server: string; port: number; ok: boolean } {
  let s = (input || '').trim();
  if (!s) return { server: '', port: defaultPort, ok: false };
  // [IPv6]:port / [IPv6]
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end > 0) {
      const host = s.slice(1, end);
      const rest = s.slice(end + 1).replace(/^:/, '');
      const port = rest ? Number(rest) : defaultPort;
      return { server: host, port: Number.isFinite(port) ? port : defaultPort, ok: !!host };
    }
  }
  // 无括号的纯 IPv6 地址
  if ((s.match(/:/g) || []).length > 1) return { server: s, port: defaultPort, ok: true };
  const idx = s.lastIndexOf(':');
  if (idx > 0) {
    const port = Number(s.slice(idx + 1));
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      return { server: s.slice(0, idx), port, ok: !!s.slice(0, idx) };
    }
  }
  return { server: s, port: defaultPort, ok: !!s };
}

/** 解析查询串：重复键聚合为数组，保留全部原始键值 */
export function parseQuery(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw;
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodePlus(eq < 0 ? pair : pair.slice(0, eq));
    const v = decodePlus(eq < 0 ? '' : pair.slice(eq + 1));
    if (!k) continue;
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else out[k] = [prev, v];
  }
  return out;
}

function decodePlus(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

export function qStr(q: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = q[key];
  return Array.isArray(v) ? v[0] : v;
}

export function qBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}

/** 安全地构造 URL（分享链接常有非法字符 / 缺少 scheme） */
export function safeURL(raw: string): URL | null {
  try {
    const s = raw.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return new URL(s);
    if (s.startsWith('//')) return new URL('http:' + s);
    return new URL('http://' + s);
  } catch { return null; }
}

/**
 * 判断 HTTP(S) URL 是"HTTP 代理分享链接"还是"订阅 / 网页地址"。
 * 判据：带用户名密码、带 #节点备注、显式 type/proxy 参数、或非标准端口且无路径。
 * 两种格式共用此函数，避免 detectFormat 与 parseShareLink 判定不一致。
 */
export function isProxyLikeHttpUrl(raw: string): boolean {
  const text = (raw ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return false;
  if (text.includes('#') || /[?&](type|proxy)=/i.test(text)) return true;
  const u = safeURL(text);
  return !!u?.username || (!!u?.port && !['80', '443'].includes(u.port) && (!u.pathname || u.pathname === '/'));
}

/** 去掉分享链接 #fragment 并解码名称，返回主体与名称 */
export function stripFragment(raw: string): { body: string; name: string } {
  const i = raw.indexOf('#');
  if (i < 0) return { body: raw, name: '' };
  let name = raw.slice(i + 1);
  try { name = decodeURIComponent(name); } catch { /* 保留原文 */ }
  return { body: raw.slice(0, i), name };
}

/* --------------------------------- JSON / ID -------------------------------- */

/**
 * 剥离响应式 Proxy，返回可被 structuredClone / contextBridge 克隆的纯数据。
 *
 * 为什么需要：Vue 的 reactive / Pinia 的 state 取出来的都是 Proxy，
 * 而 Electron 的 contextBridge 与 structuredClone 都不接受 Proxy，
 * 直接经 ipcRenderer.invoke 传参会抛
 * "An object could not be cloned."（Vue 错误参考 runtime-5）。
 *
 * toRaw 只能脱最外层，嵌套对象仍是 Proxy，所以这里做全深度展开。
 * Date / Map / Set 保留类型并递归处理；其他非普通对象（Blob、ArrayBuffer、类实例）原样返回。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map(item => toPlain(item)) as unknown as T;
  if (value instanceof Map) {
    const m = new Map<unknown, unknown>();
    value.forEach((v, k) => { m.set(toPlain(k), toPlain(v)); });
    return m as unknown as T;
  }
  if (value instanceof Set) {
    const s = new Set<unknown>();
    value.forEach(v => { s.add(toPlain(v)); });
    return s as unknown as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    out[key] = toPlain((value as Record<string, unknown>)[key]);
  }
  return out as T;
}

export function safeJson<T = any>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

export function uuid(): string {
  const g = globalThis as any;
  if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ------------------------------ 字段映射（核心） ------------------------------ */

/**
 * 按映射表把源对象的已知字段搬到结构化模型，剩下的一律进 extras。
 * 这是"不静默丢失参数"的关键实现：unknown 字段不会被丢弃，同时生成 issue。
 */
export function mapFields<T extends Record<string, any>>(
  source: T,
  spec: Record<string, string[]>,
  opts: { ignore?: string[]; location?: string } = {},
): { known: Record<string, any>; extras: Record<string, unknown>; unknownIssues: ParseIssue[] } {
  const known: Record<string, any> = {};
  const consumed = new Set<string>(opts.ignore ?? []);
  for (const [target, aliases] of Object.entries(spec)) {
    for (const alias of aliases) {
      if (alias in source && source[alias] !== undefined && source[alias] !== null) {
        known[target] = source[alias];
        consumed.add(alias);
        break;
      }
    }
  }
  const extras: Record<string, unknown> = {};
  const unknownIssues: ParseIssue[] = [];
  for (const [key, value] of Object.entries(source ?? {})) {
    if (consumed.has(key) || value === undefined || value === null || value === '') continue;
    extras[key] = value;
    unknownIssues.push({
      level: 'info',
      code: 'UNKNOWN_FIELD',
      message: `字段「${key}」未能映射到统一模型，原始值已完整保留在 extras（不会丢失，但需人工确认是否影响连接）`,
      field: key,
      value,
      location: opts.location,
    });
  }
  return { known, extras, unknownIssues };
}

export function issue(
  level: ParseIssue['level'],
  code: ParseIssue['code'],
  message: string,
  extra: Partial<ParseIssue> = {},
): ParseIssue {
  return { level, code, message, ...extra };
}

/** 必填字段检查：缺失时明确报出字段名，而不是给个空串糊弄过去 */
export function requireFields(
  fields: Record<string, unknown>,
  required: string[],
  location?: string,
): ParseIssue[] {
  const out: ParseIssue[] = [];
  for (const key of required) {
    const v = fields[key];
    if (v === undefined || v === null || v === '') {
      out.push(issue('error', 'MISSING_REQUIRED', `缺少必填字段「${key}」，该配置无法连接。请检查导入内容或手动补全。`, { field: key, location }));
    }
  }
  return out;
}

/* ------------------------------ 节点构造 / 指纹 ------------------------------ */

export function nodeFingerprint(n: Pick<UnifiedNode, 'protocol' | 'server' | 'port'> & Partial<UnifiedNode>): string {
  const key = [
    n.protocol, n.server, n.port,
    n.uuid ?? '', n.password ?? '', n.method ?? '',
    n.transport ?? '', n.security ?? '', n.flow ?? '',
    (n.tls?.sni ?? '') + (n.tls?.alpn?.join(',') ?? ''),
    n.reality?.publicKey ?? '',
    stableHash(JSON.stringify(n.transportSettings ?? {})),
  ].join('|');
  return stableHash(key);
}

export function makeNode(partial: Partial<UnifiedNode> & { protocol: UnifiedNode['protocol']; server: string; port: number; raw: string }): UnifiedNode {
  const node: UnifiedNode = {
    id: uuid(),
    name: partial.name || `${partial.server}:${partial.port}`,
    protocol: partial.protocol,
    protocolAlias: partial.protocolAlias,
    server: partial.server,
    port: partial.port,
    uuid: partial.uuid,
    password: partial.password,
    method: partial.method,
    alterId: partial.alterId,
    transport: partial.transport ?? 'tcp',
    security: partial.security ?? 'none',
    tls: partial.tls,
    reality: partial.reality,
    flow: partial.flow,
    transportSettings: partial.transportSettings ?? {},
    protocolSettings: partial.protocolSettings ?? {},
    extras: partial.extras ?? {},
    raw: partial.raw,
    rawDecoded: partial.rawDecoded,
    rawFormat: partial.rawFormat ?? 'unknown',
    source: partial.source ?? 'paste',
    issues: partial.issues ?? [],
    lossless: partial.lossless ?? true,
    kernels: partial.kernels ?? [],
    kernel: partial.kernel ?? null,
    kernelReason: partial.kernelReason,
    fingerprint: '',
    addedAt: partial.addedAt ?? Date.now(),
  };
  node.fingerprint = nodeFingerprint(node);
  return node;
}

export function emptyStats(): ImportStats {
  return { total: 0, parsed: 0, failed: 0, duplicates: 0, warnings: 0, byProtocol: {}, byFormat: {} };
}

export function buildReport(
  format: ImportReport['format'],
  formatLabel: string,
  nodes: UnifiedNode[],
  rejected: ImportReport['rejected'],
  issues: ParseIssue[],
  duplicates: UnifiedNode[] = [],
  requiresFetch?: ImportReport['requiresFetch'],
): ImportReport {
  const stats = emptyStats();
  const lines = rejected.length + nodes.length;
  stats.total = lines;
  stats.parsed = nodes.length;
  stats.failed = rejected.length;
  stats.duplicates = duplicates.length;
  stats.warnings = issues.filter(i => i.level === 'warning').length + nodes.reduce((n, x) => n + x.issues.filter(i => i.level === 'warning').length, 0);
  for (const n of nodes) stats.byProtocol[n.protocol] = (stats.byProtocol[n.protocol] ?? 0) + 1;
  stats.byFormat[format] = (stats.byFormat[format] ?? 0) + nodes.length;
  return {
    ok: nodes.length > 0 || (!!requiresFetch && rejected.length === 0),
    format,
    formatLabel,
    nodes,
    rejected,
    duplicates,
    issues,
    stats,
    previewOnly: true,
    ...(requiresFetch ? { requiresFetch } : {}),
  };
}
