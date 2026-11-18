/**
 * 实时遥测 —— 主进程采集层
 *
 * - 每秒拉取一次 clash_api GET /connections，用累计字节差分算速率（不依赖 WebSocket / 第三方库）
 * - 每 30 次采样拉一次 /version 拿内核版本
 * - 失败时速率归零并给出具体错误，绝不沿用上一帧数值冒充实时数据
 * - Xray 无 HTTP 统计接口，直接给出原因，不启动轮询
 *
 * 所有请求只发往 127.0.0.1 本机控制端口，不访问任何外部服务（站点探测除外，且必须由用户点击触发）。
 */

import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import { tcpProbe } from './net-probe.js';
import tls from 'node:tls';
import type { KernelType } from '../../core/hub/model.js';
import { localProxyHost } from '../../core/runtime/types.js';
import {
  applySample, DEFAULT_PROBE_SITES, classifyProbeError, diagnoseProbe, emptyTelemetry,
  failedAttempt, kernelTelemetryCapability, parseClashConnections, probeGroupOf, verdictOf,
  type ConnectionsPayload, type ProbeAttempt, type ProbeFailureKind, type ProbeReport,
  type ProbeResult, type TelemetrySnapshot,
} from '../../core/runtime/telemetry.js';
import {
  EMPTY_QUERY_STATS_FRAME, QUERY_STATS_PATH, parseQueryStats, stripGrpcPrefix, sumXrayTraffic,
  type XrayStat,
} from '../../core/runtime/xray-stats.js';

export type RuntimeEventSender = (channel: string, payload: unknown) => void;

interface CollectorOptions {
  send: RuntimeEventSender;
  /** 本地 HTTP 代理端口，用于站点连通性探测 */
  getHttpPort: () => number;
  /** 内核实时运行状态：探测结论必须知道「有没有连上节点」 */
  getRuntimeState?: () => { running: boolean; kernel: KernelType | null; nodeName: string };
}

interface Ctx {
  kernel: KernelType;
  controllerPort: number;
  listen: string;
}

const SAMPLE_MS = 1000;
const REQUEST_TIMEOUT_MS = 2200;

export class TelemetryCollector {
  private readonly send: RuntimeEventSender;
  private readonly getHttpPort: () => number;
  private readonly getRuntimeState: () => { running: boolean; kernel: KernelType | null; nodeName: string };
  private snapshot: TelemetrySnapshot = emptyTelemetry();
  private ctx: Ctx | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  /** 当前正在采样的上下文代次；切换节点时允许新旧上下文短暂并行，旧结果会被丢弃。 */
  private generation = 0;
  private pollingGeneration: number | null = null;

  constructor(opts: CollectorOptions) {
    this.send = opts.send;
    this.getHttpPort = opts.getHttpPort;
    this.getRuntimeState = opts.getRuntimeState ?? (() => ({ running: false, kernel: null, nodeName: '' }));
  }

  getSnapshot(): TelemetrySnapshot { return JSON.parse(JSON.stringify(this.snapshot)) as TelemetrySnapshot; }

  private emit() { this.send('runtime:event', { type: 'telemetry', snapshot: this.getSnapshot() }); }

  private base(): string {
    const c = this.ctx!;
    const host = c.listen && c.listen !== '0.0.0.0' ? c.listen : '127.0.0.1';
    return `http://${host}:${c.controllerPort}`;
  }

  /** Xray 采样：对本机 api 入站发一次 gRPC QueryStats，归一化成统一的累计字节模型 */
  private async pollXrayStats(): Promise<ConnectionsPayload> {
    const c = this.ctx!;
    const host = c.listen && c.listen !== '0.0.0.0' ? c.listen : '127.0.0.1';
    const totals = sumXrayTraffic(await queryXrayStats(host, c.controllerPort));
    return { uploadTotal: totals.uploadTotal, downloadTotal: totals.downloadTotal, connections: [], memory: null };
  }

  private async request(pathname: string, method = 'GET'): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(this.base() + pathname, {
        method, signal: ac.signal,
        headers: { Accept: 'application/json' },
      });
      if (!resp.ok) {
        if (resp.status === 404 || resp.status === 501) {
          throw new Error(`内核未提供 ${pathname} 接口（HTTP ${resp.status}）；请升级内核或改用 Mihomo。当前不显示模拟数据`);
        }
        throw new Error(`clash_api ${pathname} 返回 HTTP ${resp.status} ${resp.statusText}`);
      }
      const text = await resp.text();
      if (!text.trim()) return {};
      try { return JSON.parse(text) as unknown; }
      catch { throw new Error(`clash_api ${pathname} 返回的不是合法 JSON：${text.slice(0, 120)}`); }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error(`clash_api ${pathname} 请求超时（${REQUEST_TIMEOUT_MS}ms）`);
      throw e;
    } finally { clearTimeout(timer); }
  }

  /** 立即采样一次；供测试与手动刷新调用 */
  async pollOnce(): Promise<TelemetrySnapshot> {
    const ctx = this.ctx;
    if (!ctx) return this.getSnapshot();
    const generation = this.generation;
    if (this.pollingGeneration === generation) return this.getSnapshot();
    this.pollingGeneration = generation;
    try {
      const payload = ctx.kernel === 'xray'
        ? await this.pollXrayStats()
        : parseClashConnections(await this.request('/connections'));
      let version = this.snapshot.kernelVersion;
      if (ctx.kernel !== 'xray' && this.tick % 30 === 0) {
        try {
          const v = await this.request('/version') as Record<string, unknown>;
          version = String(v.version ?? v.meta ?? v.kernel ?? '').slice(0, 80) || version;
        } catch { /* 版本接口可选，失败不影响统计 */ }
      }
      if (generation !== this.generation || this.ctx !== ctx) return this.getSnapshot();
      this.tick++;
      this.snapshot = applySample(this.snapshot, payload, Date.now(), version);
    } catch (e) {
      if (generation !== this.generation || this.ctx !== ctx) return this.getSnapshot();
      const error = e instanceof Error ? e.message : String(e);
      // ctx 可能在本轮采样途中被 stop() / start() 置空（切换节点时必然发生）：
      // 这里若直接读 this.ctx.kernel 会再抛一次 TypeError，变成 unhandledRejection。
      const kernel = ctx.kernel ?? this.snapshot.kernel ?? 'xray';
      // 失败时速率必须归零，历史与累计值保留，界面显示具体错误
      this.snapshot = {
        ...emptyTelemetry(kernel, `采样失败：${error}`),
        state: 'unavailable',
        supported: kernelTelemetryCapability(kernel).supported,
        history: this.snapshot.history,
        uploadTotal: this.snapshot.uploadTotal,
        downloadTotal: this.snapshot.downloadTotal,
        kernelVersion: this.snapshot.kernelVersion,
        error,
      };
    } finally {
      if (this.pollingGeneration === generation) this.pollingGeneration = null;
      if (generation === this.generation && this.ctx === ctx) this.emit();
    }
    return this.getSnapshot();
  }

  start(kernel: KernelType, controllerPort: number, listen: string): void {
    this.stop(true);
    this.ctx = { kernel, controllerPort, listen };
    this.tick = 0;
    const cap = kernelTelemetryCapability(kernel);
    this.snapshot = cap.supported
      ? emptyTelemetry(kernel, kernel === 'xray'
        ? `正在连接 ${kernel} StatsService gRPC（127.0.0.1:${controllerPort}）…`
        : `正在连接 ${kernel} clash_api（127.0.0.1:${controllerPort}）…`)
      : emptyTelemetry(kernel, cap.reason);
    this.emit();
    if (!cap.supported) return; // 理论上不再触达：三类内核都已支持，保留兜底

    void this.pollOnce();
    this.timer = setInterval(() => { void this.pollOnce(); }, SAMPLE_MS);
  }

  /** 停止采集；silent=true 时不推事件（用于内部重启） */
  stop(silent = false, reason = '内核已断开，实时数据停止采样'): void {
    this.generation++;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const kernel = this.ctx?.kernel ?? this.snapshot.kernel;
    this.ctx = null;
    this.tick = 0;
    this.snapshot = emptyTelemetry(kernel, reason);
    if (!silent) this.emit();
  }

  /** 关闭单条连接：DELETE /connections/{id} */
  async closeConnection(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.ctx) return { ok: false, error: '内核未运行，无法关闭连接' };
    if (this.ctx.kernel === 'xray') {
      return { ok: false, error: 'Xray 内核不支持按连接关闭（StatsService 无连接列表）；需要该能力请改用 sing-box / Mihomo' };
    }
    const safe = String(id ?? '').trim();
    if (!safe || !/^[\w.-]+$/.test(safe)) return { ok: false, error: '连接 ID 不合法' };
    try {
      await this.request(`/connections/${encodeURIComponent(safe)}`, 'DELETE');
      this.snapshot.connections = this.snapshot.connections.filter(c => c.id !== safe);
      this.snapshot.activeConnections = this.snapshot.connections.length;
      this.emit();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 站点连通性 + 节点体检。
   *
   * 每个站点发两次真实请求：直连 HTTPS GET、经本地 HTTP 代理的 CONNECT 隧道 + TLS + GET。
   * 拿到任意 HTTP 响应即证明「链路通了」（403/404 也算通，但会记下状态码）；
   * 只有网络层失败 / 超时 / 代理明确拒绝才算「不通」，并归类原因。
   * 只读响应头、不下载正文、不上传任何用户数据；必须由用户点击才触发。
   */
  async probeSites(hosts: string[]): Promise<ProbeReport> {
    const proxyPort = this.getHttpPort();
    const state = this.getRuntimeState();
    // 光看 status.running 不够：内核可能起了但 HTTP 入站没监听，必须真连一次端口
    const proxyHost = localProxyHost(this.ctx?.listen ?? '127.0.0.1');
    const listening = state.running ? await tcpProbe(proxyPort, proxyHost, 400) : false;
    const proxyRunning = state.running && listening;
    const cleaned: string[] = [];
    for (const raw of (hosts ?? []).slice(0, 8)) {
      const host = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
      if (!host || !/^[a-z0-9.-]+$/i.test(host) || cleaned.includes(host)) continue;
      cleaned.push(host);
    }

    const results: ProbeResult[] = await Promise.all(cleaned.map(async host => {
      const group = probeGroupOf(host);
      const [direct, viaProxy] = await Promise.all([
        probeReachability({ host, port: 443, useTls: true, timeoutMs: PROBE_TIMEOUT_MS }),
        proxyRunning
          ? probeReachability({ host, port: 443, useTls: true, proxyPort, proxyHost, timeoutMs: PROBE_TIMEOUT_MS + 1500 })
          : Promise.resolve(failedAttempt(
              'not-running',
              state.running
                ? `内核进程在跑，但本地 HTTP 代理端口 ${proxyPort} 未监听（检查 HTTP 入站配置）`
                : `内核未运行，本地 HTTP 代理端口 ${proxyPort} 无人监听`,
            )),
      ]);
      return { host, group, direct, viaProxy, verdict: verdictOf(direct.ok, viaProxy.ok), probedAt: Date.now() };
    }));

    return {
      results,
      diagnosis: diagnoseProbe(results, {
        proxyRunning, kernelRunning: state.running, proxyPort,
        kernel: state.kernel, nodeName: state.nodeName,
      }),
      checkedAt: Date.now(),
      proxyRunning, proxyPort, kernel: state.kernel, nodeName: state.nodeName,
    };
  }
}

const PROBE_TIMEOUT_MS = 4000;
const PROBE_USER_AGENT = 'universal-proxy-client/reachability-probe';

interface ReachabilityOpts {
  host: string;
  port: number;
  useTls: boolean;
  /** 有值 = 经本地 HTTP 代理（CONNECT 隧道），无值 = 直连 */
  proxyPort?: number;
  /** 本地 HTTP 代理的监听地址；通配地址会由调用方映射为回环地址 */
  proxyHost?: string;
  timeoutMs?: number;
  path?: string;
}

function failureKindOf(message: string, status = 0): ProbeFailureKind {
  return classifyProbeError(message, status);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 真实可达性探测（导出供回归测试直接驱动，测试可用本地 HTTP 假站 / 假 CONNECT 代理）。
 * 只关心「有没有拿到 HTTP 响应头」，因此收到响应立刻销毁连接，不读正文。
 */
export function probeReachability(opts: ReachabilityOpts): Promise<ProbeAttempt> {
  const {
    host, port, useTls, proxyPort, proxyHost = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS, path = '/',
  } = opts;
  const via: ProbeAttempt['via'] = proxyPort
    ? (useTls ? 'https-proxy' : 'http-proxy')
    : (useTls ? 'https-direct' : 'http-direct');
  // SNI 不允许填 IP（RFC 6066），本地回环测试时不带 servername
  const servername = net.isIP(host) ? undefined : host;
  const start = Date.now();
  return new Promise(resolve => {
    let settled = false;
    let socket: net.Socket | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (r: Omit<ProbeAttempt, 'via' | 'ms'> & { ms?: number | null }) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      try { socket?.destroy(); } catch { /* 连接已释放 */ }
      resolve({ ...r, ms: r.ok ? (r.ms ?? Date.now() - start) : null, via });
    };
    const succeed = (status: number) => finish({
      ok: true, status, failure: null, ms: Date.now() - start,
      ...(status >= 400 ? { error: `站点返回 HTTP ${status}（链路已通，但目标拒绝了这次请求）` } : {}),
    });
    const fail = (kind: ProbeFailureKind, message: string) => finish({ ok: false, status: 0, failure: kind, error: message });

    hardTimer = setTimeout(() => fail('timeout', `请求超时（${timeoutMs}ms 内未收到响应头）`), timeoutMs);

    const requestText =
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${PROBE_USER_AGENT}\r\nAccept: */*\r\nConnection: close\r\n\r\n`;

    // 收到任意 HTTP 响应头就算链路通；CONNECT 隧道里提前到达的数据也要一起算
    const waitForResponse = (stream: net.Socket, initial = '') => {
      let raw = initial.slice(0, 8192);
      const check = () => {
        const idx = raw.indexOf('\r\n\r\n');
        if (idx < 0) return false;
        const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(raw);
        succeed(m ? Number(m[1]) : 200);
        return true;
      };
      const onData = (chunk: Buffer) => {
        if (settled) return;
        raw = (raw + chunk.toString('latin1')).slice(0, 8192);
        if (check()) stream.removeListener('data', onData);
      };
      stream.on('data', onData);
      if (raw && check()) stream.removeListener('data', onData);
    };

    const sendGet = (stream: net.Socket, leftover?: Buffer) => {
      socket = stream;
      stream.setTimeout(0);
      waitForResponse(stream, leftover && leftover.length ? leftover.toString('latin1') : '');
      if (!settled) stream.write(requestText);
    };

    if (!proxyPort) {
      // ── 直连 ──
      try {
        const req = (useTls ? https : http).request({
          host, port, method: 'GET', path, agent: false, timeout: timeoutMs,
          ...(useTls ? { servername, rejectUnauthorized: false } : {}),
          headers: {
            Host: host, 'User-Agent': PROBE_USER_AGENT, Accept: '*/*', Connection: 'close',
          },
        }, res => {
          res.resume();
          succeed(res.statusCode ?? 200);
        });
        socket = req as unknown as net.Socket;
        req.once('timeout', () => { req.destroy(); fail('timeout', `直连 ${host}:${port} 超时（${timeoutMs}ms）`); });
        req.once('error', e => fail(failureKindOf(e.message), `直连失败：${e.message}`));
        req.end();
      } catch (e) { fail(failureKindOf(errorText(e)), `直连请求发起失败：${errorText(e)}`); }
      return;
    }

    // ── 经本地 HTTP 代理：CONNECT 隧道 →（可选 TLS）→ GET ──
    let headRaw = '';
    const chunks: Buffer[] = [];
    let sock: net.Socket;
    try {
      sock = net.connect({ host: proxyHost, port: proxyPort });
    } catch (e) {
      fail('refused', `连不上本地代理 ${proxyHost}:${proxyPort}：${errorText(e)}`);
      return;
    }
    socket = sock;
    sock.setNoDelay(true);
    sock.setTimeout(timeoutMs, () => fail('timeout', `本地代理 ${proxyPort} 响应超时`));
    sock.once('error', e => fail(failureKindOf(e.message), `经代理连接失败：${e.message}`));
    sock.once('connect', () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: ${PROBE_USER_AGENT}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    });

    const onHead = (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      headRaw += chunk.toString('latin1');
      const idx = headRaw.indexOf('\r\n\r\n');
      if (idx < 0) {
        if (headRaw.length > 8192) fail('empty-reply', '代理返回的 CONNECT 响应头异常（超过 8KB 或没有结束标记）');
        return;
      }
      const statusM = /^HTTP\/1\.[01]\s+(\d{3})/.exec(headRaw);
      const status = statusM ? Number(statusM[1]) : 0;
      if (status !== 200) {
        fail('proxy-reject', `内核拒绝建立 CONNECT 隧道：HTTP ${status || '无状态行'}（出站规则拒绝 / 节点不可用 / 需要认证）`);
        return;
      }
      sock.removeListener('data', onHead);
      const all = Buffer.concat(chunks);
      const leftover = all.subarray(Math.min(idx + 4, all.length));
      if (useTls) {
        const secure = tls.connect({
          socket: sock, servername, rejectUnauthorized: false,
        });
        socket = secure as unknown as net.Socket;
        secure.setTimeout(timeoutMs, () => fail('timeout', `经节点到 ${host} 的 TLS 握手超时`));
        secure.once('error', e => fail(failureKindOf(e.message, 0), `经节点 TLS 握手失败：${e.message}`));
        secure.once('secureConnect', () => sendGet(secure as unknown as net.Socket, leftover));
      } else {
        sendGet(sock, leftover);
      }
    };
    sock.on('data', onHead);
  });
}

/** 默认站点列表给 UI 用，保证主进程与界面同一份定义 */
export function defaultProbeHosts(): string[] {
  return DEFAULT_PROBE_SITES.map(s => s.host);
}

/**
 * 调 Xray StatsService.QueryStats（gRPC over HTTP/2，Node 原生 http2，零依赖）。
 * 只连 127.0.0.1 的 api 入站；失败抛明确错误，由 pollOnce 统一归零速率并展示原因。
 * 导出供端到端测试直接驱动。
 */
export function queryXrayStats(host: string, port: number, timeoutMs = REQUEST_TIMEOUT_MS): Promise<XrayStat[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let session: http2.ClientHttp2Session | null = null;
    const finish = (ok: boolean, stats?: XrayStat[], error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session?.close(); } catch { /* 会话已死时 close 会抛，忽略 */ }
      if (ok) resolve(stats ?? []);
      else reject(new Error(error ?? 'QueryStats 调用失败'));
    };
    const timer = setTimeout(() => finish(false, undefined, `QueryStats 请求超时（${timeoutMs}ms，api 入站 ${host}:${port} 无响应）`), timeoutMs);

    try {
      session = http2.connect(`http://${host}:${port}`);
      session.once('error', e => finish(false, undefined, `gRPC 连接失败：${e.message}`));
      const req = session.request({
        [http2.constants.HTTP2_HEADER_METHOD]: 'POST',
        [http2.constants.HTTP2_HEADER_PATH]: QUERY_STATS_PATH,
        [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
        [http2.constants.HTTP2_HEADER_TE]: 'trailers',
      });
      req.once('error', e => finish(false, undefined, `gRPC 请求失败：${e.message}`));
      const chunks: Buffer[] = [];
      let grpcStatus = '';
      const takeStatus = (h: Record<string, unknown>) => {
        const v = h['grpc-status'];
        if (typeof v === 'string' && v) grpcStatus = v;
      };
      req.on('data', (c: Buffer) => chunks.push(c));
      req.once('response', takeStatus);
      req.on('trailers', takeStatus);
      req.on('close', () => {
        // grpc-status 出现在 response headers 或 trailers；非 0 视为内核拒绝
        if (grpcStatus && grpcStatus !== '0') {
          finish(false, undefined, `Xray StatsService 返回 gRPC 状态 ${grpcStatus}（配置未启用 stats？请重新生成运行配置）`);
          return;
        }
        try {
          const buf = Buffer.concat(chunks);
          // 必须走 finish() 而不是直接 resolve：否则 settled 不置位、超时定时器不撤销、
          // HTTP/2 会话不关闭。每秒采样一次会累积大量会话和定时器，最终拖垮进程。
          finish(true, parseQueryStats(stripGrpcPrefix(buf)));
        } catch (e) {
          finish(false, undefined, e instanceof Error ? e.message : String(e));
        }
      });
      req.write(EMPTY_QUERY_STATS_FRAME);
      req.end();
    } catch (e) {
      finish(false, undefined, e instanceof Error ? e.message : String(e));
    }
  });
}

/* 旧版 headProbe（HTTP 80 明文 HEAD）已移除：
   多数站点强制 HTTPS 且拒绝 HEAD，会把「其实通了」误判成「不通」，
   无法用来检验节点。现由 probeReachability（HTTPS GET / CONNECT 隧道）替代。 */
