/**
 * 实时遥测 —— 纯逻辑层
 *
 * 红线：只做「内核真实返回值 → 统一模型」的归一化与计算。
 * 拿不到数据就是拿不到，绝不生成随机数、绝不沿用上一帧的速率冒充实时值。
 *
 * 数据来源：Mihomo / sing-box 的 clash_api `GET /connections`；
 * Xray 走其 gRPC StatsService（见 xray-stats.ts），两者都归一化为同一模型。
 * 该响应含累计字节，因此速率 = 两次采样的累计字节差 / 时间差，不需要 WebSocket /traffic。
 */

import type { KernelType } from '../hub/model.js';

export type TelemetryState = 'idle' | 'active' | 'unavailable';
export type OutboundKind = 'proxy' | 'direct' | 'reject' | 'unknown';

export interface RuntimeConnection {
  id: string;
  network: string;
  /** 入站类型，如 HTTP / SOCKS / TUN */
  inbound: string;
  process: string;
  processPath: string;
  /** 目标域名（优先）或目标 IP */
  host: string;
  destinationIp: string;
  destinationPort: number;
  sourceIp: string;
  sourcePort: number;
  chains: string[];
  rule: string;
  rulePayload: string;
  outbound: OutboundKind;
  /** 该连接自身的累计字节 */
  upload: number;
  download: number;
  startedAt: number;
}

export interface TrafficPoint {
  ts: number;
  /** 字节 / 秒 */
  up: number;
  down: number;
}

export interface TelemetrySnapshot {
  ts: number;
  state: TelemetryState;
  kernel: KernelType | null;
  supported: boolean;
  /** 不支持 / 出错时的具体原因，必须能直接展示给用户 */
  reason: string;
  /** B/s */
  upSpeed: number;
  downSpeed: number;
  /** 内核启动以来的累计字节 */
  uploadTotal: number;
  downloadTotal: number;
  activeConnections: number;
  connections: RuntimeConnection[];
  history: TrafficPoint[];
  memory: number | null;
  kernelVersion: string;
  error: string | null;
  /** 本次采样是否发生了累计量回退（内核重启 / 计数器重置） */
  reset: boolean;
}

export const MAX_HISTORY = 60;

export interface TelemetryCapability {
  supported: boolean;
  level: 'full' | 'none';
  reason: string;
}

export function kernelTelemetryCapability(kernel: KernelType | null | undefined): TelemetryCapability {
  if (!kernel) return { supported: false, level: 'none', reason: '内核未启动，暂无实时数据' };
  if (kernel === 'xray') {
    return {
      supported: true, level: 'full',
      reason: '实时数据来自 Xray StatsService gRPC 统计接口（每秒采样）；Xray 无法按连接列出 / 关闭，连接监控请用 sing-box 或 Mihomo。',
    };
  }
  if (kernel === 'sing-box') {
    return {
      supported: true, level: 'full',
      reason: '使用 clash_api 的 /connections 接口；若内核版本较旧未提供该接口，会在首次采样时明确报错。',
    };
  }
  return { supported: true, level: 'full', reason: '使用 Mihomo RESTful API /connections' };
}

export function emptyTelemetry(kernel: KernelType | null = null, reason = '内核未连接，等待用户点击「开始连接」'): TelemetrySnapshot {
  const cap = kernelTelemetryCapability(kernel);
  return {
    ts: Date.now(), state: 'idle', kernel: kernel ?? null,
    supported: cap.supported, reason: reason || cap.reason,
    upSpeed: 0, downSpeed: 0, uploadTotal: 0, downloadTotal: 0,
    activeConnections: 0, connections: [], history: [],
    memory: null, kernelVersion: '', error: null, reset: false,
  };
}

/* ───────────────────── Clash API 归一化 ───────────────────── */

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function str(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v); }

export function classifyOutbound(chains: string[], rule: string, rulePayload: string): OutboundKind {
  const all = [...chains, rule, rulePayload].map(s => String(s ?? '').toUpperCase()).join('|');
  if (/REJECT|BLOCK|DROP/.test(all)) return 'reject';
  if (/DIRECT|NO_RESOLVE/.test(all) && !/PROXY/.test(all)) return 'direct';
  if (chains.length && chains.every(c => /^(DIRECT|REJECT)$/i.test(c))) return 'direct';
  if (/PROXY|SELECT|RELAY|FALLBACK|LOAD-BALANCE|节点|GLOBAL/.test(all)) return 'proxy';
  if (!chains.length && !rule) return 'unknown';
  return 'proxy';
}

export function parseClashConnection(raw: unknown, index: number): RuntimeConnection {
  const o = (raw ?? {}) as Record<string, any>;
  const meta = (o.metadata ?? {}) as Record<string, any>;
  const chains: string[] = Array.isArray(o.chains) ? o.chains.map(str).filter(Boolean) : [];
  const host = str(meta.host ?? meta.sniffHost ?? o.host) || str(meta.destinationIP ?? o.destinationIP);
  const startRaw = o.start;
  const startedAt = typeof startRaw === 'string'
    ? (Date.parse(startRaw) || 0)
    : num(startRaw) ? Number(startRaw) * 1000 : 0;
  const rule = str(o.rule), rulePayload = str(o.rulePayload);
  return {
    id: str(o.id) || `conn-${index}`,
    network: str(meta.network ?? o.network) || 'tcp',
    inbound: str(meta.type ?? o.type) || '',
    process: str(meta.process ?? o.process),
    processPath: str(meta.processPath ?? o.processPath),
    host,
    destinationIp: str(meta.destinationIP ?? o.destinationIP),
    destinationPort: num(meta.destinationPort ?? o.destinationPort),
    sourceIp: str(meta.sourceIP ?? o.sourceIP),
    sourcePort: num(meta.sourcePort ?? o.sourcePort),
    chains,
    rule, rulePayload,
    outbound: classifyOutbound(chains, rule, rulePayload),
    upload: num(o.upload), download: num(o.download),
    startedAt,
  };
}

export interface ConnectionsPayload {
  uploadTotal: number;
  downloadTotal: number;
  connections: RuntimeConnection[];
  memory: number | null;
}

/** 归一化 GET /connections 的响应；结构不对时抛明确错误，不返回半成品 */
export function parseClashConnections(raw: unknown): ConnectionsPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('/connections 返回的不是 JSON 对象');
  }
  const o = raw as Record<string, any>;
  if (!Array.isArray(o.connections)) {
    throw new Error('/connections 响应缺少 connections 数组（内核版本可能不支持该接口）');
  }
  return {
    uploadTotal: num(o.uploadTotal),
    downloadTotal: num(o.downloadTotal),
    connections: o.connections.map((c: unknown, i: number) => parseClashConnection(c, i)),
    memory: Number.isFinite(o.memory) ? Number(o.memory) : null,
  };
}

/* ───────────────────── 速率与历史 ───────────────────── */

export interface SpeedResult {
  upSpeed: number;
  downSpeed: number;
  reset: boolean;
  uploadTotal: number;
  downloadTotal: number;
}

/**
 * 由累计字节差分算速率。
 * 内核重启 / 计数器重置时累计量会回退，此时速率记 0 且 reset=true，绝不输出负数或尖峰。
 */
export function computeSpeed(
  prev: Pick<TelemetrySnapshot, 'uploadTotal' | 'downloadTotal' | 'ts'> | null,
  next: Pick<ConnectionsPayload, 'uploadTotal' | 'downloadTotal'>,
  now: number,
): SpeedResult {
  const dt = prev ? (now - prev.ts) / 1000 : 0;
  const reset = !!prev && (next.uploadTotal < prev.uploadTotal || next.downloadTotal < prev.downloadTotal);
  if (!prev || dt <= 0 || dt > 30 || reset) {
    return {
      upSpeed: 0, downSpeed: 0, reset,
      uploadTotal: next.uploadTotal, downloadTotal: next.downloadTotal,
    };
  }
  const up = Math.max(0, next.uploadTotal - prev.uploadTotal) / dt;
  const down = Math.max(0, next.downloadTotal - prev.downloadTotal) / dt;
  return {
    upSpeed: Math.round(up * 100) / 100,
    downSpeed: Math.round(down * 100) / 100,
    reset: false, uploadTotal: next.uploadTotal, downloadTotal: next.downloadTotal,
  };
}

export function pushHistory(history: TrafficPoint[], point: TrafficPoint, max = MAX_HISTORY): TrafficPoint[] {
  const out = [...history, point];
  return out.length > max ? out.slice(out.length - max) : out;
}

/** 把一次采样合并进快照（纯函数，便于测试） */
export function applySample(
  prev: TelemetrySnapshot,
  payload: ConnectionsPayload,
  now = Date.now(),
  kernelVersion = '',
): TelemetrySnapshot {
  const speed = computeSpeed(prev.state === 'active' ? prev : null, payload, now);
  const point: TrafficPoint = { ts: now, up: speed.upSpeed, down: speed.downSpeed };
  const source = prev.kernel === 'xray'
    ? '实时数据来自 Xray StatsService gRPC（每秒采样）'
    : `实时数据来自 ${prev.kernel} clash_api /connections（每秒采样）`;
  return {
    ts: now,
    state: 'active',
    kernel: prev.kernel,
    supported: true,
    reason: source,
    upSpeed: speed.upSpeed,
    downSpeed: speed.downSpeed,
    uploadTotal: speed.uploadTotal,
    downloadTotal: speed.downloadTotal,
    activeConnections: payload.connections.length,
    connections: payload.connections,
    history: pushHistory(speed.reset ? [] : prev.history, point),
    memory: payload.memory,
    kernelVersion: kernelVersion || prev.kernelVersion,
    error: null,
    reset: speed.reset,
  };
}

/* ───────────────────── 聚合排行 ───────────────────── */

export type AggregateKey = 'process' | 'host' | 'rule' | 'outbound' | 'chain';

export interface AggregateRow {
  key: string;
  connections: number;
  upload: number;
  download: number;
  total: number;
}

export function aggregateConnections(connections: RuntimeConnection[], by: AggregateKey, limit = 8): AggregateRow[] {
  const map = new Map<string, AggregateRow>();
  for (const c of connections) {
    let key = '';
    if (by === 'chain') key = c.chains[c.chains.length - 1] || '未知链路';
    else if (by === 'outbound') key = c.outbound;
    else key = c[by] || '未知';
    const row = map.get(key) ?? { key, connections: 0, upload: 0, download: 0, total: 0 };
    row.connections++;
    row.upload += c.upload;
    row.download += c.download;
    row.total += c.upload + c.download;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || b.connections - a.connections).slice(0, limit);
}

export function outboundRatio(connections: RuntimeConnection[]): { proxy: number; direct: number; reject: number; unknown: number; total: number } {
  const r = { proxy: 0, direct: 0, reject: 0, unknown: 0, total: connections.length };
  for (const c of connections) r[c.outbound]++;
  return r;
}

/* ───────────────────── 展示格式化 ───────────────────── */

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/* ───────────────────── 站点连通性探测与节点诊断 ───────────────────── */

/** 失败原因分类：让「不通」能说清是哪里不通，而不是只有三个字 */
export type ProbeFailureKind =
  | 'timeout'        // 建连 / 首字节超时
  | 'refused'        // 端口没人监听、连接被拒
  | 'dns'            // 域名解析失败
  | 'tls'            // TLS 握手 / 证书协商失败
  | 'proxy-reject'   // 代理 CONNECT 被内核拒绝（502/503/407…）
  | 'empty-reply'    // 连接被重置、没拿到任何响应
  | 'not-running'    // 内核未运行 / 本地代理端口未监听
  | 'blocked'        // 站点明确拒绝（4xx/5xx），链路通但目标不通
  | 'unknown';

/** 单条链路的一次真实探测结果 */
export interface ProbeAttempt {
  ok: boolean;
  ms: number | null;
  /** HTTP 状态码；0 表示压根没收到响应 */
  status: number;
  /** ok 时为 null；失败时标明原因类别 */
  failure: ProbeFailureKind | null;
  /** 人类可读的失败原因，直接展示在界面上 */
  error?: string;
  /** 实际使用的通道 */
  via: 'https-direct' | 'https-proxy' | 'http-direct' | 'http-proxy' | 'none';
}

export type ProbeGroup = 'overseas' | 'domestic';
export type ProbeVerdict = 'proxy-only' | 'both-ok' | 'direct-only' | 'all-fail' | 'not-probed';

/** 站点探测结果（真实发起请求才有值，未探测一律显示 —） */
export interface ProbeResult {
  host: string;
  /** 境外站用来判断节点能否出海，境内站用来判断分流规则 */
  group: ProbeGroup;
  direct: ProbeAttempt;
  viaProxy: ProbeAttempt;
  /** 本行结论 */
  verdict: ProbeVerdict;
  probedAt: number | null;
}

export interface ProbeDiagnosis {
  level: 'good' | 'warn' | 'bad' | 'idle';
  title: string;
  detail: string;
  advice: string[];
  /** null = 数据不足，无法判断节点好坏（绝不硬猜） */
  nodeOk: boolean | null;
  /** 顶部概览用的短句 */
  summary: string;
}

export interface ProbeReport {
  results: ProbeResult[];
  diagnosis: ProbeDiagnosis;
  checkedAt: number;
  proxyRunning: boolean;
  proxyPort: number;
  kernel: KernelType | null;
  nodeName: string;
}

export interface ProbeContext {
  /** 内核在跑 且 本地 HTTP 代理端口确实在监听 */
  proxyRunning: boolean;
  /** 内核进程是否在跑（用于区分「没连」和「连了但入站没起」） */
  kernelRunning?: boolean;
  proxyPort: number;
  kernel: KernelType | null;
  nodeName?: string;
}

/** 默认检测站点：两个境外（看节点能否出海）+ 两个境内（看分流规则/基线网络） */
export const DEFAULT_PROBE_SITES: { host: string; group: ProbeGroup }[] = [
  { host: 'google.com', group: 'overseas' },
  { host: 'youtube.com', group: 'overseas' },
  { host: 'baidu.com', group: 'domestic' },
  { host: 'bilibili.com', group: 'domestic' },
];

const DOMESTIC_SUFFIXES = [
  'baidu.com', 'bilibili.com', 'qq.com', 'taobao.com', 'tmall.com', 'jd.com',
  'weibo.com', '163.com', 'sina.com.cn', 'douyin.com', 'zhihu.com', 'aliyun.com',
  'tencent.com', 'cn', 'com.cn', 'gov.cn', 'edu.cn',
];

/** 站点分组：判断「经节点不通」是节点坏了，还是分流规则让国内站走直连 */
export function probeGroupOf(host: string): ProbeGroup {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  return DOMESTIC_SUFFIXES.some(s => h === s || h.endsWith(`.${s}`)) ? 'domestic' : 'overseas';
}

/** 构造一条未执行的失败结果（内核没起 / 端口没监听时不要假装发过请求） */
export function failedAttempt(kind: ProbeFailureKind, error: string, via: ProbeAttempt['via'] = 'none'): ProbeAttempt {
  return { ok: false, ms: null, status: 0, failure: kind, error, via };
}

/**
 * 把底层报错文本归一为失败类别。
 * 主进程探测时会直接给出结构化类别，这里用于兜底与日志文本归类。
 */
export function classifyProbeError(message: string | undefined, status = 0): ProbeFailureKind {
  const m = String(message ?? '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS|域名解析/i.test(m)) return 'dns';
  if (/ETIMEDOUT|TIMEDOUT|超时|timeout|ESOCKETTIMEDOUT/i.test(m)) return 'timeout';
  if (/ECONNREFUSED|连接被拒绝|拒绝连接|not listening|未监听/i.test(m)) return 'refused';
  if (/CERT|TLS|SSL|EPROTO|ERR_TLS|wrong version/i.test(m)) return 'tls';
  if (/CONNECT|代理返回|proxy|502|503|407/i.test(m)) return 'proxy-reject';
  if (/ECONNRESET|socket hang up|空响应|RST|reset/i.test(m)) return 'empty-reply';
  if (status >= 400) return 'blocked';
  return 'unknown';
}

export function verdictOf(directOk: boolean, proxyOk: boolean): ProbeVerdict {
  if (directOk && proxyOk) return 'both-ok';
  if (proxyOk) return 'proxy-only';
  if (directOk) return 'direct-only';
  return 'all-fail';
}

/** 一行的中文结论：把「代 不通」到底算不算故障说清楚 */
export function describeVerdict(result: ProbeResult, proxyRunning: boolean): string {
  switch (result.verdict) {
    case 'proxy-only': return '只能走节点，节点生效';
    case 'both-ok': return '两条路都通';
    case 'direct-only':
      if (!proxyRunning) return '内核未运行';
      return result.group === 'domestic' ? '直连可达，多为分流规则' : '经节点不可达，需排查';
    case 'all-fail': return '两条路都不通';
    default: return '未检测';
  }
}

function dominantFailure(results: ProbeResult[]): ProbeFailureKind | null {
  const counts = new Map<ProbeFailureKind, number>();
  for (const r of results) {
    const k = r.viaProxy.failure;
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: ProbeFailureKind | null = null, n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
}

/** 针对主导失败原因给的那条「先做这个」建议 */
const KIND_ADVICE: Partial<Record<ProbeFailureKind, string>> = {
  timeout: '先看「节点测速」的真连结果：节点服务器本身连不上就换节点，别反复重测网站',
  refused: '重新生成运行配置后再连接一次，确认本地 HTTP 入站端口正常监听',
  dns: '检查运行配置里的 DNS / 分流 DNS 设置，或换一个支持远程解析的节点',
  tls: '核对节点的 SNI / 证书 / 传输层参数，参数不匹配就直接换节点',
  'proxy-reject': '检查出站规则是否把 CONNECT 请求指向了 DIRECT / REJECT，必要时重新生成运行配置',
  'empty-reply': '连接被重置多半是节点已失效，换一个节点重连再测',
  blocked: '链路是通的，只是目标站点拒绝了请求；换个目标站再确认',
  unknown: '打开内核日志看 outbound 报错，或直接换节点重试',
  'not-running': '先在首页点「开始连接」',
};

const FAILURE_TEXT: Record<ProbeFailureKind, string> = {
  timeout: '经节点请求普遍超时，通常是节点服务器连不上、出口被阻断或订阅已过期',
  refused: '本地代理端口连不上，说明内核没有正常监听 HTTP 入站（配置生成或启动有问题）',
  dns: '节点侧域名解析失败，检查运行配置里的 DNS / 分流 DNS 设置',
  tls: '经节点的 TLS 握手失败，节点出口可能被劫持或协议参数不匹配',
  'proxy-reject': '内核明确拒绝建立 CONNECT 隧道（出站规则拒绝或没有可用节点）',
  'empty-reply': '连接建立后立刻被重置，节点多半已失效或链路被干扰',
  'not-running': '内核未运行',
  blocked: '站点返回了错误状态码',
  unknown: '未能建立完整链路',
};

/**
 * 综合诊断：把每个站点「直连 / 经节点」两条路的结果，变成一句能落地的节点结论。
 * 判据是纯逻辑，不依赖时间、不猜数据；数据不足时 nodeOk=null。
 */
export function diagnoseProbe(results: ProbeResult[], ctx: ProbeContext): ProbeDiagnosis {
  const total = results.length;
  const directOk = results.filter(r => r.direct.ok).length;
  const proxyOk = results.filter(r => r.viaProxy.ok).length;
  const overseas = results.filter(r => r.group === 'overseas');
  const domestic = results.filter(r => r.group === 'domestic');
  const overseasProxyOk = overseas.filter(r => r.viaProxy.ok).length;
  const domesticProxyOk = domestic.filter(r => r.viaProxy.ok).length;
  const summary = `代理可达 ${proxyOk}/${total} · 直连可达 ${directOk}/${total}`;
  const node = ctx.nodeName ? `「${ctx.nodeName}」` : '当前节点';

  if (!total) {
    return {
      level: 'idle', nodeOk: null, summary: '—',
      title: '没有可检测的站点',
      detail: '输入的域名都不合法，本次没有发起任何网络请求。',
      advice: ['在检测列表里填入合法域名后重试'],
    };
  }

  if (!ctx.proxyRunning) {
    const kernelUp = !!ctx.kernelRunning;
    return {
      level: 'idle', nodeOk: null, summary,
      title: kernelUp ? '代理端口没监听，暂时判断不了节点好坏' : '内核未运行，暂时判断不了节点好坏',
      detail: kernelUp
        ? `内核进程在跑，但本地 HTTP 代理端口 ${ctx.proxyPort} 连不上（HTTP 入站没起来或端口被改过），「经节点」这一列不可达是必然的；本次仍测了直连（${directOk}/${total} 可达）。`
        : `本地 HTTP 代理端口 ${ctx.proxyPort} 没有内核监听，「经节点」这一列不可达是必然的；本次仍测了直连（${directOk}/${total} 可达），可用来判断本机是否断网。`,
      advice: kernelUp
        ? ['重新生成运行配置后再连接一次，确认 HTTP 入站端口与设置页一致', '去运行状态 / 内核日志看启动报错', '确认没有别的程序占用了这个端口']
        : ['先在首页点「开始连接」，连上节点后再回来点「开始真实检测」', '若连接一直失败，去看内核日志里的启动报错'],
    };
  }

  if (directOk === 0 && proxyOk === 0) {
    return {
      level: 'bad', nodeOk: null, summary,
      title: '两条路全不通：先排查本机网络',
      detail: `直连和经节点都拿不到任何响应（${dominantFailure(results) ? FAILURE_TEXT[dominantFailure(results)!] : '链路未建立'}）。这种组合下无法把锅甩给节点，通常是本机断网、DNS 全挂或系统代理残留指向了失效端口。`,
      advice: ['确认电脑本身能上网（浏览器打开任意国内网站）', '检查系统代理设置，必要时点「断开并恢复」清理残留', '查看运行状态与内核日志'],
    };
  }

  if (proxyOk === 0) {
    const kind = dominantFailure(results) ?? 'unknown';
    return {
      level: 'bad', nodeOk: false, summary,
      title: `节点不可用：${node}一个站点都没代理通`,
      detail: `直连 ${directOk}/${total} 可达，说明本机网络正常；但 ${total} 个站点经节点全部失败。${FAILURE_TEXT[kind]}。`,
      advice: [
        KIND_ADVICE[kind] ?? '去「节点测速」找一个能真连下载的节点，或直接换一个节点重连',
        '确认订阅没过期、节点地址/端口/协议参数没被改过',
        '看内核日志里 outbound / dial 相关的报错',
      ],
    };
  }

  if (overseas.length && overseasProxyOk === 0) {
    return {
      level: 'bad', nodeOk: false, summary,
      title: `节点连上了，但${node}出不了海`,
      detail: `境外 ${overseas.length} 个站点经节点全部不可达，境内经节点 ${domesticProxyOk}/${domestic.length} 可达，直连 ${directOk}/${total} 可达。常见于节点出口被封、订阅流量耗尽，或分流规则把境外域名误判成直连。`,
      advice: ['换一个境外节点重连后再测一次', '检查分流规则：境外域名是否被错误地指向 DIRECT', '若换节点仍不通，打开内核日志看 outbound 报错'],
    };
  }

  if (overseas.length && overseasProxyOk === overseas.length) {
    const domesticFallback = domestic.length > 0 && domesticProxyOk === 0;
    return {
      level: 'good', nodeOk: true, summary,
      title: `节点可用：${node}能正常访问境外站点`,
      detail: `境外 ${overseasProxyOk}/${overseas.length} 经节点可达，直连 ${directOk}/${total} 可达。`
        + (domesticFallback
          ? '境内站点「代 不通」是分流规则让国内流量走直连造成的，属于正常现象，不是节点故障。'
          : '境内、境外两条链路都正常。'),
      advice: ['节点工作正常，可以放心使用', '个别网站打不开时，看该行的失败原因：多为站点自身拒绝或 DNS 问题'],
    };
  }

  return {
    level: 'warn', nodeOk: true, summary,
    title: `节点部分可用：${node}只能通一部分境外站点`,
    detail: `境外经节点 ${overseasProxyOk}/${overseas.length} 可达、直连 ${directOk}/${total} 可达。部分目标不通，可能是节点被特定站点屏蔽、DNS 污染或规则分流差异。`,
    advice: ['多测几次确认是否稳定；持续只通一半建议换节点', '在节点测速里对比各节点的真连下载结果', '查看不通那一行的具体失败原因'],
  };
}

/* ─────────────── 网络连接监控：状态归一化（纯函数，渲染层可直接用） ─────────────── */

export type MonitorStatusLevel = 'good' | 'warn' | 'bad' | 'idle';

export interface MonitorStatusItem {
  level: MonitorStatusLevel;
  /** 短标签，直接显示在徽章上 */
  label: string;
  /** 鼠标悬停 / 状态条上的完整解释 */
  detail: string;
}

export interface MonitorStatusInput {
  connected: boolean;
  /** RuntimeStatus.state，用来区分「连接中 / 连接失败」 */
  runtimeState?: string;
  runtimeMessage?: string;
  kernel: KernelType | null;
  nodeName?: string | null;
  listenPort?: number | null;
  telemetry: TelemetrySnapshot;
  /** 首页「开始真实检测」的结果，没有就是没测过 */
  diagnosis?: ProbeDiagnosis | null;
  now?: number;
}

export interface MonitorStatus {
  connection: MonitorStatusItem;
  sampling: MonitorStatusItem;
  source: MonitorStatusItem;
  nodeCheck: MonitorStatusItem;
  /** 「3 秒前 / 2 分钟前」，没在采样就是 — */
  sampledAgo: string;
  /** 该内核能否给出逐条连接列表 */
  connectionList: boolean;
  /** 连接表为空时的标题 + 说明，绝不假装「节点坏了」 */
  emptyTitle: string;
  emptyDetail: string;
  advice: string[];
}

/** 相对时间只描述真实采样时刻；没有采样就返回 —，绝不补一个假时间 */
export function formatSampledAgo(ts: number, now: number): string {
  if (!ts || !now || now < ts) return '—';
  const sec = Math.floor((now - ts) / 1000);
  if (sec < 2) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

const DIAGNOSIS_LABEL: Record<ProbeDiagnosis['level'], string> = {
  good: '节点可用', warn: '部分可用', bad: '节点异常', idle: '判断不了',
};

/**
 * 把「内核在不在、采样有没有成功、数据源是什么、节点测过没有」摊成四个明确状态。
 * 红线：只描述已有事实；没有采样数据就不写「通」、不编速率、不编 PID。
 */
export function describeMonitorStatus(input: MonitorStatusInput): MonitorStatus {
  const {
    connected, runtimeState = '', runtimeMessage = '', kernel, nodeName = '',
    listenPort = null, telemetry: t, diagnosis = null, now = Date.now(),
  } = input;
  const samplingActive = connected && t.state === 'active' && !t.error;
  const sampledAgo = samplingActive ? formatSampledAgo(t.ts, now) : '—';
  const connectionList = !!kernel && kernel !== 'xray';
  const kernelText = kernel ?? '未选择内核';

  /* 1. 连接状态 */
  let connection: MonitorStatusItem;
  if (connected) {
    connection = {
      level: 'good', label: '已连接',
      detail: `内核 ${kernelText} 正在运行${nodeName ? ` · 节点 ${nodeName}` : ''}${listenPort ? ` · 本地端口 ${listenPort}` : ''}。`,
    };
  } else if (runtimeState === 'starting') {
    connection = { level: 'warn', label: '连接中…', detail: '正在生成配置并启动内核，就绪后自动开始采样。' };
  } else if (runtimeState === 'stopping') {
    connection = { level: 'warn', label: '断开中…', detail: '正在停止内核并按快照恢复系统代理。' };
  } else if (runtimeState === 'error') {
    connection = { level: 'bad', label: '连接失败', detail: runtimeMessage || '内核启动失败，请看运行日志里的具体报错。' };
  } else {
    connection = { level: 'idle', label: '未连接', detail: '内核没在运行，实时速率与连接列表都没有数据源。' };
  }

  /* 2. 采样状态 */
  let sampling: MonitorStatusItem;
  if (!connected) {
    sampling = { level: 'idle', label: '未采样', detail: '内核未运行，不会发起任何采样；点「开始连接」后每秒采样一次。' };
  } else if (t.error) {
    sampling = { level: 'bad', label: '采样异常', detail: `最近一次采样失败：${t.error}` };
  } else if (t.state === 'active') {
    sampling = {
      level: 'good', label: '实时采样中',
      detail: `每秒采样一次，最近一次 ${sampledAgo}；速率由两次累计字节差算出，不插值、不补随机数。`,
    };
  } else {
    sampling = { level: 'warn', label: '等待首次采样', detail: t.reason || '内核刚启动，正在等待第一次统计返回。' };
  }

  /* 3. 数据源能力：Xray 有速率、没有连接列表，必须分开说 */
  let source: MonitorStatusItem;
  if (!kernel) {
    source = { level: 'idle', label: '无数据源', detail: '还没有选定内核。' };
  } else if (kernel === 'xray') {
    source = {
      level: t.supported ? 'good' : 'warn', label: 'gRPC 速率统计',
      detail: 'Xray StatsService gRPC 提供实时速率与累计流量（已自动启用）；Xray 没有 /connections 接口，逐条连接列表与按连接关闭不可用，需要该能力请改用 sing-box / Mihomo。',
    };
  } else {
    source = {
      level: t.supported ? 'good' : 'warn', label: 'clash_api 全量',
      detail: `${kernelText} clash_api /connections 提供连接列表、出口链路、命中规则、进程名与累计字节。`,
    };
  }

  /* 4. 节点体检结论：没测过就写没测过 */
  const nodeCheck: MonitorStatusItem = diagnosis
    ? {
      level: diagnosis.level, label: DIAGNOSIS_LABEL[diagnosis.level],
      detail: `${diagnosis.title}。${diagnosis.detail}`,
    }
    : { level: 'idle', label: '未检测', detail: '还没检验过节点通不通；点首页「开始真实检测」会真发 HTTPS 请求并给出结论。' };

  /* 5. 空表原因 */
  let emptyTitle: string;
  let emptyDetail: string;
  let advice: string[];
  if (!connected) {
    emptyTitle = connection.label === '连接失败' ? '连接失败，暂无实时数据' : '内核未运行，暂无实时数据';
    emptyDetail = `${connection.detail} 这里不会出现模拟数据，连接成功后每秒刷新一次。`;
    advice = ['点首页「开始连接」启动内核', '若启动失败，打开「运行日志」看内核报错'];
  } else if (t.error) {
    emptyTitle = '统计接口采样失败';
    emptyDetail = t.error;
    advice = ['点右上角「刷新数据」立即重试一次', '确认控制端口没被别的程序占用', '看运行日志里 clash_api / gRPC 的报错'];
  } else if (kernel === 'xray') {
    emptyTitle = samplingActive ? '采样正常 · Xray 不提供逐条连接列表' : '等待统计接口首次返回';
    emptyDetail = samplingActive
      ? '实时速率与累计流量已从 Xray StatsService gRPC 正常采样（看上方状态条）；Xray 没有 /connections 接口，所以这张连接表必然是空的——这不是节点故障。要看每条连接请切换 sing-box / Mihomo 内核。'
      : t.reason;
    advice = ['看状态条里的实时速率，确认链路在跑', '想看逐条连接：改用 sing-box / Mihomo', '想检验节点好坏：点「开始真实检测」'];
  } else if (samplingActive && !t.connections.length) {
    emptyTitle = '采样正常 · 当前没有活跃连接';
    emptyDetail = '内核在线、统计接口返回正常，只是这一刻没有连接，或筛选条件把连接都过滤掉了。';
    advice = ['把左上角筛选切回「全部应用」', '打开一个网页产生流量后再看', '仍为空说明系统代理没生效，检查代理设置'];
  } else if (!t.supported) {
    emptyTitle = '当前内核不提供统计接口';
    emptyDetail = t.reason;
    advice = ['升级内核版本后重连', '或改用 sing-box / Mihomo'];
  } else {
    emptyTitle = '等待首次采样';
    emptyDetail = t.reason;
    advice = ['点右上角「刷新数据」立即采样一次'];
  }

  return { connection, sampling, source, nodeCheck, sampledAgo, connectionList, emptyTitle, emptyDetail, advice };
}
