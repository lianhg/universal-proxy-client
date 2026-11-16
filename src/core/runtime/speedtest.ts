/**
 * 节点真连测速 —— 共享类型与判定逻辑
 *
 * 这一层是纯数据 / 纯函数，不 import node 内置模块，渲染层与测试都能直接用。
 * 设计原则：
 * 1. 「TCP 握手通」不等于「代理可用」—— 必须先起内核、真正通过代理拿到数据才算可用。
 * 2. 任何数字都必须有来源：没测出速度就显示「未测/不可用」，绝不填随机值或估算值。
 * 3. 测速目标 URL 必须白名单化，避免把用户流量发到任意地址。
 */

export type SpeedTestPhase =
  | 'pending'     // 排队中
  | 'tcp'         // 探测 TCP 握手
  | 'starting'    // 启动临时内核
  | 'download'    // 经代理下载测速
  | 'done'        // 完成
  | 'error'       // 失败（不可用）
  | 'cancelled'   // 用户取消

export type SpeedGrade = 'fast' | 'ok' | 'slow' | 'bad' | 'unknown'

export interface SpeedTestRow {
  id: string
  name: string
  protocol: string
  kernel: string | null
  server: string
  port: number
  phase: SpeedTestPhase
  /** TCP 握手延迟（三次取最小值），ms */
  latencyMs: number | null
  /** 经代理拿到首字节的时间，ms */
  ttfbMs: number | null
  /** 实测下载速度，Mbps */
  mbps: number | null
  /** 本次实际下载字节数 */
  bytes: number
  grade: SpeedGrade
  error?: string
  startedAt: number
  finishedAt?: number
}

export interface SpeedTestOptions {
  /** 并发测速的节点数（每个节点会起一个临时内核，别开太大） */
  concurrency?: number
  /** 单节点测速时长上限，ms */
  durationMs?: number
  /** 单节点下载字节上限 */
  maxBytes?: number
  /** 测速目标 URL（必须在白名单里） */
  targetUrl?: string
  /** TCP 握手 / 内核启动的超时，ms */
  timeoutMs?: number
}

export const DEFAULT_SPEEDTEST_OPTIONS: Required<SpeedTestOptions> = {
  concurrency: 3,
  durationMs: 6000,
  maxBytes: 8 * 1024 * 1024,
  targetUrl: 'https://speed.cloudflare.com/__down?bytes=10485760',
  timeoutMs: 8000,
};

/** 白名单测速目标：都是公开的测速 / 小文件端点，不涉及用户隐私数据 */
export const SPEEDTEST_TARGETS: { id: string; url: string; label: string; note: string }[] = [
  {
    id: 'cloudflare',
    url: 'https://speed.cloudflare.com/__down?bytes=10485760',
    label: 'Cloudflare 测速（10MB，推荐）',
    note: '全球节点，HTTPS，最能反映真实带宽',
  },
  {
    id: 'cachefly',
    url: 'http://cachefly.cachefly.net/5mb.test',
    label: 'CacheFly（5MB，HTTP）',
    note: '纯 HTTP，TLS 握手有问题的节点也能测出带宽',
  },
  {
    id: 'gstatic',
    url: 'https://www.gstatic.com/generate_204',
    label: 'Google gstatic（204，仅测延迟）',
    note: '只测首字节，不测带宽；适合快速筛掉不通的节点',
  },
];

export function isAllowedTarget(url: string): boolean {
  return SPEEDTEST_TARGETS.some(t => t.url === url);
}

/** 速度分级（Mbps）：≥8 优秀 / ≥2 可用 / ≥0.5 偏慢 / 其余不可用 */
export function gradeSpeed(mbps: number | null): SpeedGrade {
  if (mbps === null || !Number.isFinite(mbps) || mbps <= 0) return 'bad';
  if (mbps >= 8) return 'fast';
  if (mbps >= 2) return 'ok';
  if (mbps >= 0.5) return 'slow';
  return 'bad';
}

export const SPEED_GRADE_LABELS: Record<SpeedGrade, string> = {
  fast: '优秀',
  ok: '可用',
  slow: '偏慢',
  bad: '不可用',
  unknown: '未测',
};

export const SPEED_GRADE_HINTS: Record<SpeedGrade, string> = {
  fast: '≥ 8 Mbps：看视频、下文件都够用',
  ok: '2~8 Mbps：网页 / 1080p 视频基本够用',
  slow: '0.5~2 Mbps：能连上但会很卡',
  bad: '＜ 0.5 Mbps 或连不通：建议换节点',
  unknown: '尚未测速',
};

export function formatMbps(mbps: number | null): string {
  if (mbps === null || !Number.isFinite(mbps)) return '—';
  if (mbps >= 100) return `${Math.round(mbps)} Mbps`;
  if (mbps >= 10) return `${mbps.toFixed(1)} Mbps`;
  return `${mbps.toFixed(2)} Mbps`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 把字节数 + 耗时换算成 Mbps（1 Mbps = 1e6 bit/s） */
export function bytesToMbps(bytes: number, ms: number): number | null {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms) || bytes <= 0 || ms <= 0) return null;
  return (bytes * 8) / (ms / 1000) / 1e6;
}

/** 解析后的测速目标：主进程据此拼 CONNECT 隧道与原始 HTTP 请求 */
export interface ParsedTarget {
  url: string;
  protocol: 'http:' | 'https:';
  host: string;
  port: number;
  /** 请求行里的 path（含 query） */
  path: string;
  /** CONNECT 隧道的 host:port */
  authority: string;
  /** 发往目标的原始请求文本（\r\n 结尾，不含 body） */
  requestText: string;
}

/**
 * 解析并校验测速目标 URL，产出可直接写入 socket 的请求文本。
 * 只支持 http/https，且必须能被 new URL 解析，否则明确抛错。
 */
export function parseTarget(url: string): ParsedTarget {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`测速目标 URL 无效：${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`测速目标只支持 http/https，收到 ${u.protocol}`);
  }
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port || (isHttps ? 443 : 80));
  const path = `${u.pathname || '/'}${u.search || ''}`;
  const authority = `${u.hostname}:${port}`;
  const requestText = [
    `GET ${path} HTTP/1.1`,
    `Host: ${u.hostname}`,
    'User-Agent: universal-proxy-client/speedtest',
    'Accept: */*',
    'Accept-Encoding: identity',
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  return { url, protocol: u.protocol as 'http:' | 'https:', host: u.hostname, port, path, authority, requestText };
}

/** CONNECT 隧道请求文本（经 HTTP 代理访问 https 目标时必须先建隧道） */
export function buildConnectRequest(authority: string): string {
  return [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    'Proxy-Connection: keep-alive',
    '',
    '',
  ].join('\r\n');
}

export interface ConnectReply {
  /** true 表示代理返回 200，隧道已建立 */
  ok: boolean;
  status: number;
  /** 状态行之后的剩余字节（可能已经包含隧道数据，不能丢） */
  rest: string;
  error?: string;
}

/** 解析代理对 CONNECT 的响应头（只要拿到完整头部就返回，不等待后续数据） */
export function parseConnectReply(raw: string): ConnectReply {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) return { ok: false, status: 0, rest: '', error: '代理未返回完整的 CONNECT 响应头' };
  const head = raw.slice(0, end);
  const rest = raw.slice(end + 4);
  const firstLine = head.split('\r\n')[0] ?? '';
  const m = firstLine.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
  const status = m ? Number(m[1]) : 0;
  if (!status) return { ok: false, status, rest, error: `无法解析代理响应：${firstLine.slice(0, 80)}` };
  if (status !== 200) {
    const reason = firstLine.split(/\s+/).slice(2).join(' ') || '隧道建立失败';
    return { ok: false, status, rest, error: `代理返回 ${status} ${reason}` };
  }
  return { ok: true, status, rest };
}

/** 从目标响应头里读 Content-Length（没有则返回 null，说明是分块或未知长度） */
export function contentLengthOf(head: string): number | null {
  const m = head.match(/\r\ncontent-length:\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 测速结果的一句话结论（给界面 / 日志用） */
export function describeRow(r: SpeedTestRow): string {
  if (r.phase === 'error') return `${r.name}：不可用（${r.error ?? '未知原因'}）`;
  if (r.phase === 'cancelled') return `${r.name}：已取消`;
  if (r.phase !== 'done') return `${r.name}：测速中…`;
  const parts = [
    r.latencyMs !== null ? `握手 ${r.latencyMs} ms` : '握手 —',
    r.ttfbMs !== null ? `首字节 ${r.ttfbMs} ms` : '首字节 —',
    r.mbps !== null ? `${formatMbps(r.mbps)}（${SPEED_GRADE_LABELS[r.grade]}）` : '带宽未测出',
  ];
  return `${r.name}：${parts.join(' · ')}`;
}
