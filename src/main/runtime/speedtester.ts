/**
 * 节点真连测速器（主进程）
 *
 * 为什么不用「TCP 握手延迟」当网速：握手只证明服务器端口开了，
 * 完全不反映加密协商、传输层、线路质量与出站是否真能上网。
 *
 * 这里的做法：给每个节点单独起一个临时内核实例（独立空闲端口、不碰系统代理），
 * 再通过它的本地 HTTP 入站做一次 CONNECT 隧道 + 真实下载，量出首字节时间与带宽。
 *
 * 安全边界：
 * - 只接受白名单测速目标（见 core/runtime/speedtest.ts 的 SPEEDTEST_TARGETS）；
 * - 临时内核监听 127.0.0.1 随机端口，mode = 'none'，绝不改写系统代理 / 路由；
 * - 结束时无论成功失败都杀进程、删配置，用户取消时同样清理。
 */

import fs from 'node:fs';
import net from 'node:net';
import { tcpProbe } from './net-probe.js';
import tls from 'node:tls';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { KernelType, UnifiedNode } from '../../core/hub/model.js';
import { buildRuntimeConfig } from '../../core/runtime/config-builder.js';
import {
  KERNEL_BIN_NAMES, mergeRuntimeSettings, type RuntimeSettings,
} from '../../core/runtime/types.js';
import {
  DEFAULT_SPEEDTEST_OPTIONS, bytesToMbps, buildConnectRequest, contentLengthOf,
  gradeSpeed, isAllowedTarget, parseConnectReply, parseTarget,
  type ParsedTarget, type SpeedTestOptions, type SpeedTestRow,
} from '../../core/runtime/speedtest.js';
import { ensureRuntimeDirs, scanBinaries } from './binaries.js';

export type SpeedTestEventSender = (channel: string, payload: unknown) => void;

interface Options {
  userData: string;
  projectRoot: string;
  send: SpeedTestEventSender;
  /** 读取当前运行设置（为了拿到用户自定义的内核路径） */
  getSettings: () => RuntimeSettings;
}

interface DownloadResult {
  ttfbMs: number | null;
  bytes: number;
  elapsedMs: number;
  mbps: number | null;
  error?: string;
}

/** TCP 握手耗时；失败返回 null，不抛错 */
function tcpLatencyOnce(host: string, port: number, timeout: number): Promise<number | null> {
  return new Promise(resolve => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok ? Date.now() - start : null);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

/** 临时内核用的空闲端口（23000~24999 随机段，避开主内核的 21808~21811） */
async function pickTempPort(used: Set<number>): Promise<number> {
  for (let i = 0; i < 120; i++) {
    const p = 23000 + Math.floor(Math.random() * 2000);
    if (used.has(p)) continue;
    if (!(await tcpProbe(p, '127.0.0.1', 300))) { used.add(p); return p; }
  }
  throw new Error('找不到空闲端口来启动临时测速内核');
}

/** 通过本地 HTTP 代理建 CONNECT 隧道，再真实下载；返回首字节时间与带宽（导出供回归测试） */
export function downloadThroughProxy(
  proxyPort: number,
  target: ParsedTarget,
  opts: { durationMs: number; maxBytes: number; timeoutMs: number },
  signal: { cancelled: boolean },
): Promise<DownloadResult> {
  return new Promise(resolve => {
    let settled = false;
    let socket: net.Socket | null = null;
    let ttfbMs: number | null = null;
    let bodyBytes = 0;
    let headerDone = false;
    let requestSentAt = 0;
    let declaredLength: number | null = null;
    let stopTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;

    const done = (r: Partial<DownloadResult>) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (stopTimer) clearTimeout(stopTimer);
      try { socket?.destroy(); } catch { /* 忽略 */ }
      const elapsedMs = requestSentAt ? Date.now() - requestSentAt : 0;
      const bytes = bodyBytes;
      resolve({
        ttfbMs, bytes, elapsedMs,
        mbps: bytesToMbps(bytes, elapsedMs),
        ...r,
      });
    };

    const fail = (msg: string) => done({ error: msg, mbps: null });

    // 兜底硬超时：隧道 / TLS / 下载任何一步卡死都不会拖住整个队列
    hardTimer = setTimeout(() => fail(`测速超时（${opts.timeoutMs + opts.durationMs} ms 内未完成）`), opts.timeoutMs + opts.durationMs + 4000);

    const startDownload = (sock: net.Socket, already: Buffer) => {
      socket = sock;
      sock.setNoDelay(true);
      sock.write(target.requestText);
      requestSentAt = Date.now();
      stopTimer = setTimeout(() => done({}), opts.durationMs);
      const feed = (chunk: Buffer) => {
        if (settled) return;
        if (signal.cancelled) { fail('已取消'); return; }
        if (ttfbMs === null) ttfbMs = Date.now() - requestSentAt!;
        if (!headerDone) {
          const idx = chunk.indexOf('\r\n\r\n');
          if (idx >= 0) {
            headerDone = true;
            bodyBytes += chunk.length - (idx + 4);
            const head = chunk.subarray(0, idx).toString('latin1');
            declaredLength = contentLengthOf(`\r\n${head}`);
            // 204 / Content-Length: 0：只证明通了，没必要等满整段时长
            if (declaredLength === 0) { done({}); return; }
          }
          return;
        }
        bodyBytes += chunk.length;
        if (bodyBytes >= opts.maxBytes || (declaredLength !== null && bodyBytes >= declaredLength)) {
          done({});
        }
      };
      if (already.length) feed(already);
      sock.on('data', feed);
    };

    let raw = '';
    const earlyChunks: Buffer[] = [];
    const sock = net.connect({ host: '127.0.0.1', port: proxyPort });
    socket = sock;
    sock.setTimeout(opts.timeoutMs, () => fail(`代理 ${proxyPort} 响应超时`));
    sock.once('error', e => fail(`连接本地代理失败：${e.message}`));
    sock.once('connect', () => {
      sock.write(buildConnectRequest(target.authority));
    });
    const onHead = (chunk: Buffer) => {
      earlyChunks.push(chunk);
      raw += chunk.toString('latin1');
      const idx = raw.indexOf('\r\n\r\n');
      if (idx < 0) return;
      sock.removeListener('data', onHead);
      sock.setTimeout(0);
      const reply = parseConnectReply(raw);
      if (!reply.ok) { fail(reply.error ?? `代理返回 ${reply.status}`); return; }
      // 隧道建立后，头部之后可能已经带了目标数据，原样交给下载阶段
      const total = Buffer.concat(earlyChunks);
      const offset = raw.indexOf('\r\n\r\n') + 4;
      const leftover = total.subarray(Math.min(offset, total.length));

      if (target.protocol === 'https:') {
        const t = tls.connect({
          socket: sock as unknown as net.Socket,
          servername: target.host,
          // 仅用于带宽测量，不读取也不上传任何敏感数据，证书链不影响测速结论
          rejectUnauthorized: false,
        });
        t.setTimeout(opts.timeoutMs, () => fail('经代理到目标的 TLS 握手超时（节点出站可能不可用）'));
        t.once('error', e => fail(`经代理到目标的 TLS 握手失败（节点出站可能不可用）：${e.message}`));
        t.once('secureConnect', () => { t.setTimeout(0); startDownload(t as unknown as net.Socket, leftover); });
      } else {
        startDownload(sock, leftover);
      }
    };
    sock.on('data', onHead);

    if (signal.cancelled) fail('已取消');
  });
}

export class SpeedTester {
  private readonly userData: string;
  private readonly projectRoot: string;
  private readonly send: SpeedTestEventSender;
  private readonly getSettings: () => RuntimeSettings;
  private children = new Set<ChildProcess>();
  private signal = { cancelled: false };
  private running = false;

  constructor(opts: Options) {
    this.userData = opts.userData;
    this.projectRoot = opts.projectRoot;
    this.send = opts.send;
    this.getSettings = opts.getSettings;
  }


  /** 取消：杀掉所有临时内核并让正在下载的请求立即失败 */
  cancel(): void {
    this.signal.cancelled = true;
    for (const c of this.children) {
      try { c.kill(); } catch { /* 忽略 */ }
    }
    this.children.clear();
  }

  /**
   * 批量测速。按并发上限跑，每完成一个节点的某个阶段就推送一次进度。
   * 返回全部行（含失败），失败的节点带 error 而不是被静默丢弃。
   */
  async run(nodes: UnifiedNode[], options: SpeedTestOptions = {}): Promise<{ ok: boolean; rows: SpeedTestRow[]; error?: string }> {
    if (this.running) return { ok: false, rows: [], error: '已有测速任务在运行，请等待完成或先取消' };
    const opts = { ...DEFAULT_SPEEDTEST_OPTIONS, ...options };
    if (!isAllowedTarget(opts.targetUrl)) {
      return { ok: false, rows: [], error: `测速目标不在白名单内：${opts.targetUrl}` };
    }
    if (!nodes.length) return { ok: false, rows: [], error: '没有可测速的节点' };

    this.running = true;
    this.signal = { cancelled: false };
    const startedAt = Date.now();
    const rows: SpeedTestRow[] = nodes.map(n => ({
      id: n.id, name: n.name, protocol: String(n.protocol),
      kernel: (n.kernel ?? null) as string | null,
      server: n.server, port: n.port,
      phase: 'pending', latencyMs: null, ttfbMs: null, mbps: null,
      bytes: 0, grade: 'unknown', startedAt,
    }));
    const indexById = new Map(rows.map((r, i) => [r.id, i]));
    const emit = (row: SpeedTestRow) => {
      const i = indexById.get(row.id);
      if (i !== undefined) rows[i] = row;
      this.send('runtime:event', { type: 'speedtest', row });
    };
    rows.forEach(emit);

    const queue = [...nodes];
    const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency, nodes.length)) }, async () => {
      while (queue.length && !this.signal.cancelled) {
        const node = queue.shift()!;
        const row = rows[indexById.get(node.id)!];
        try {
          await this.testOne(node, row, opts, emit);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          emit({ ...row, phase: this.signal.cancelled ? 'cancelled' : 'error', error: msg, grade: 'bad', finishedAt: Date.now() });
        }
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      this.running = false;
    }
    // 还没轮到的节点如实标记为已取消，而不是永远停在「排队中」
    for (const r of rows) {
      if (r.phase === 'pending') emit({ ...r, phase: 'cancelled', finishedAt: Date.now() });
    }
    return { ok: true, rows };
  }

  /* ─────────────── 单节点流程 ─────────────── */

  private async testOne(
    node: UnifiedNode,
    input: SpeedTestRow,
    opts: Required<SpeedTestOptions>,
    emit: (row: SpeedTestRow) => void,
  ): Promise<void> {
    let row: SpeedTestRow = { ...input, phase: 'tcp', startedAt: Date.now() };
    emit(row);

    // 1) TCP 握手（3 次取最小值，抖动大的线路更公平）
    const probes: (number | null)[] = [];
    for (let i = 0; i < 3 && !this.signal.cancelled; i++) {
      probes.push(await tcpLatencyOnce(node.server, node.port, Math.min(opts.timeoutMs, 4000)));
      if (probes.at(-1) !== null && probes.length === 1) {
        // 第一次就通说明线路没问题，不必等满三次超时
        break;
      }
    }
    const reachable = probes.filter((x): x is number => x !== null);
    row = { ...row, latencyMs: reachable.length ? Math.min(...reachable) : null };
    emit(row);
    if (!reachable.length) {
      emit({ ...row, phase: 'error', grade: 'bad', error: 'TCP 握手失败：服务器端口不通（被墙 / 端口错 / 服务器下线）', finishedAt: Date.now() });
      return;
    }

    const kernel = (node.kernel ?? 'xray') as KernelType;
    if (!node.kernels?.includes(kernel)) {
      emit({ ...row, phase: 'error', grade: 'bad', error: `节点不支持 ${kernel} 内核，无法测速`, finishedAt: Date.now() });
      return;
    }

    // 2) 找二进制
    const inv = await scanBinaries(this.userData, this.projectRoot, this.getSettings());
    const binary = inv.items.find(b => b.kernel === kernel);
    if (!binary?.found) {
      emit({ ...row, phase: 'error', grade: 'bad', error: `${kernel} 内核二进制缺失，无法真连测速：${binary?.reason ?? '未找到'}`, finishedAt: Date.now() });
      return;
    }

    // 3) 生成临时配置（独立端口、不改系统）
    const used = new Set<number>();
    const socksPort = await pickTempPort(used);
    const httpPort = await pickTempPort(used);
    const mixedPort = await pickTempPort(used);
    const controllerPort = await pickTempPort(used);
    const settings = mergeRuntimeSettings({
      ...this.getSettings(),
      mode: 'none',
      logLevel: 'error',
      listenAddress: '127.0.0.1',
      socksPort, httpPort, mixedPort, controllerPort,
      dnsEnabled: false,
      bypassLan: false,
    });
    let built: ReturnType<typeof buildRuntimeConfig>;
    try {
      built = buildRuntimeConfig(node, kernel, settings, [], undefined);
    } catch (e) {
      emit({ ...row, phase: 'error', grade: 'bad', error: `配置生成失败：${e instanceof Error ? e.message : String(e)}`, finishedAt: Date.now() });
      return;
    }
    if (built.blockers.length) {
      emit({ ...row, phase: 'error', grade: 'bad', error: built.blockers[0], finishedAt: Date.now() });
      return;
    }

    const dir = path.join(ensureRuntimeDirs(this.userData).runtimeDir, 'speedtest');
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, `${node.id}-${Date.now()}-${built.filename}`);
    fs.writeFileSync(configPath, built.text, 'utf8');

    row = { ...row, phase: 'starting' };
    emit(row);

    // 4) 起临时内核
    const args = KERNEL_BIN_NAMES[kernel].runArgs(configPath, dir);
    const child = spawn(binary.path, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    let kernOut = '';
    child.stdout?.on('data', (b: Buffer) => { kernOut = (kernOut + b.toString('utf8')).slice(-4000); });
    child.stderr?.on('data', (b: Buffer) => { kernOut = (kernOut + b.toString('utf8')).slice(-4000); });

    const cleanup = () => {
      try { child.kill(); } catch { /* 忽略 */ }
      this.children.delete(child);
      try { fs.unlinkSync(configPath); } catch { /* 忽略 */ }
    };

    try {
      const proxyPort = kernel === 'xray' ? httpPort : mixedPort;
      const deadline = Date.now() + opts.timeoutMs;
      let listening = false;
      while (Date.now() < deadline) {
        if (this.signal.cancelled) break;
        if (await tcpProbe(proxyPort, '127.0.0.1', 120)) { listening = true; break; }
        if (child.exitCode !== null) break;
        await new Promise(r => setTimeout(r, 150));
      }
      if (this.signal.cancelled) {
        emit({ ...row, phase: 'cancelled', finishedAt: Date.now() });
        return;
      }
      if (!listening) {
        const reason = kernOut.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 220);
        emit({
          ...row, phase: 'error', grade: 'bad',
          error: `临时内核未能在 ${opts.timeoutMs} ms 内监听 ${proxyPort}，节点配置可能被内核拒绝${reason ? `（${reason}）` : ''}`,
          finishedAt: Date.now(),
        });
        return;
      }

      // 5) 真连下载
      row = { ...row, phase: 'download' };
      emit(row);
      const target = parseTarget(opts.targetUrl);
      const dl = await downloadThroughProxy(proxyPort, target, opts, this.signal);
      if (this.signal.cancelled) {
        emit({ ...row, phase: 'cancelled', finishedAt: Date.now() });
        return;
      }
      if (dl.error) {
        emit({
          ...row, phase: 'error', grade: 'bad',
          ttfbMs: dl.ttfbMs, bytes: dl.bytes,
          error: `经代理下载失败：${dl.error}`, finishedAt: Date.now(),
        });
        return;
      }
      // 204 / 极小响应只证明通，不构成带宽结论
      const noBandwidth = target.path.includes('generate_204') || dl.bytes < 20 * 1024;
      const mbps = noBandwidth ? null : dl.mbps;
      emit({
        ...row,
        phase: 'done',
        ttfbMs: dl.ttfbMs,
        bytes: dl.bytes,
        mbps,
        grade: noBandwidth ? (dl.ttfbMs !== null ? 'ok' : 'bad') : gradeSpeed(mbps),
        finishedAt: Date.now(),
      });
    } finally {
      cleanup();
    }
  }
}
