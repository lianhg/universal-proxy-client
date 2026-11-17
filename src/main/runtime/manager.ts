/**
 * 内核运行层 —— 主进程门面
 *
 * 负责：配置落盘 → 启动内核进程 → 健康检查 → 可逆切换系统代理 → 日志流 → 断开时完整回滚。
 * 设计红线：
 * 1. 任何一步失败都必须回滚（杀进程 + 按快照恢复系统代理），并给出具体原因。
 * 2. 找不到二进制 / 无管理员权限 / 节点缺字段，一律明确拒绝，绝不假装连接成功。
 * 3. 应用退出时自动恢复系统设置，绝不把用户的系统代理留在被改写的状态。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { KernelType, UnifiedNode } from '../../core/hub/model.js';
import {
  DEFAULT_RUNTIME_SETTINGS, KERNEL_BIN_NAMES, boundPortsOf, emptyStatus, mergeRuntimeSettings,
  type BinaryInventory, type KernelBinary, type RuntimeLog, type RuntimeMode,
  type RuntimeResult, type RuntimeSettings, type RuntimeStartRequest, type RuntimeStatus,
  type SystemProxySnapshot,
} from '../../core/runtime/types.js';
import { buildRuntimeConfig } from '../../core/runtime/config-builder.js';
import {
  applySystemProxyScript, manualProxyHint, parseWindowsSnapshot,
  readSystemProxyScript, restoreSystemProxyScript, systemProxySupported,
} from '../../core/runtime/system-proxy.js';
import { ensureRuntimeDirs, runtimeDirOf, scanBinaries } from './binaries.js';
import { tcpProbe } from './net-probe.js';
import { TelemetryCollector } from './telemetry.js';
import type { ProbeReport, TelemetrySnapshot } from '../../core/runtime/telemetry.js';

const execFileAsync = promisify(execFile);
const MAX_LOGS = 500;

export type RuntimeEventSender = (channel: string, payload: unknown) => void;

interface Options {
  userData: string;
  projectRoot: string;
  send: RuntimeEventSender;
}

/** 查某个端口被哪个进程占着（Windows 用 netstat+tasklist，其他平台尽力而为，失败返回空串） */
async function findPortOwner(port: number): Promise<string> {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP']);
    const line = stdout.split(/\r?\n/)
      .find(l => l.includes(`:${port} `) && /LISTENING/i.test(l));
    const pid = line?.trim().split(/\s+/).pop();
    if (!pid || !/^\d+$/.test(pid)) return '';
    const { stdout: out2 } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = out2.match(/^"([^"]+)"/);
    return m ? `${m[1]}（PID ${pid}）` : `PID ${pid}`;
  } catch {
    return '';
  }
}

/* ─────────────── 端口自动避让 ─────────────── */

/** 冷门端口候选池起点：21808~22007，避开 7890/10808/10809/9090 这些大众端口 */
const COLD_PORT_POOL_START = 21808;
const COLD_PORT_POOL_SIZE = 200;
/** 冷门池也满时的兜底扫描区间 */
const FALLBACK_PORT_START = 30000;
const FALLBACK_PORT_END = 40000;

function isUsablePort(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * 挑一个可用端口：优先保留用户设定值；被占用则依次在冷门池、兜底区间里找第一个空闲的。
 * `skip` 里的端口视为可用（热切换时旧内核还占着，但那正是我们自己要复用的端口）。
 */
async function pickFreePort(preferred: number, used: Set<number>, skip: Set<number>): Promise<number> {
  const free = async (p: number) =>
    isUsablePort(p) && !used.has(p) && (skip.has(p) || !(await tcpProbe(p)));
  if (await free(preferred)) return preferred;
  for (let p = COLD_PORT_POOL_START; p < COLD_PORT_POOL_START + COLD_PORT_POOL_SIZE; p++) {
    if (await free(p)) return p;
  }
  for (let p = FALLBACK_PORT_START; p < FALLBACK_PORT_END; p++) {
    if (await free(p)) return p;
  }
  throw new Error(`找不到可用的本地端口（已扫描 ${COLD_PORT_POOL_START}-${COLD_PORT_POOL_START + COLD_PORT_POOL_SIZE - 1} 与 ${FALLBACK_PORT_START}-${FALLBACK_PORT_END - 1}），请关闭其他代理软件后重试`);
}

export class RuntimeManager {
  private readonly userData: string;
  private readonly projectRoot: string;
  private readonly send: RuntimeEventSender;
  private settings: RuntimeSettings;
  private status: RuntimeStatus;
  private proc: ChildProcess | null = null;
  private logs: RuntimeLog[] = [];
  private snapshot: SystemProxySnapshot | null = null;
  /** 系统代理写入是否「可能已改到一半」。读快照成功就置位，恢复成功才清除。
   *  不能用 status.systemProxy.applied 代替：applied 只在 apply 脚本成功后才置 true，
   *  若 apply 写到一半失败，applied 仍是 false，恢复会被跳过，注册表留下死端口代理导致断网。 */
  private proxyDirty = false;
  private stopping = false;
  /** 正在进行的 stop 任务。dispose 若撞上 stop，必须等它跑完再让进程退出，
   *  否则恢复系统代理的 PowerShell 会被中途终止，代理留在被改状态。 */
  private stopInFlight: Promise<void> | null = null;
  private disposed = false;
  /** 热切换期间为 true：此时进程退出不算「意外」，不触发自动重启 */
  private switching = false;
  /** 当前这次连接的启动参数（热切换回退 / 崩溃自动重启都用它） */
  private currentLaunch: {
    kernel: KernelType;
    binaryPath: string;
    configPath: string;
    configText: string;
    args: string[];
    node: UnifiedNode;
    peers: UnifiedNode[];
    routing?: unknown;
  } | null = null;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /**
   * 已被切换替换、但还没确认杀掉的旧内核。
   * 扶正候选后若进程在「杀旧内核」之前异常，旧内核会变成没人管的孤儿进程继续占用端口；
   * 断开 / 退出时统一在这里补一刀。
   */
  private retiredProc: ChildProcess | null = null;
  private readonly telemetry: TelemetryCollector;

  constructor(opts: Options) {
    this.userData = opts.userData;
    this.projectRoot = opts.projectRoot;
    this.send = opts.send;
    this.settings = this.readSettings();
    this.status = emptyStatus(this.settings);
    ensureRuntimeDirs(this.userData);
    this.telemetry = new TelemetryCollector({
      send: this.send,
      getHttpPort: () => this.settings.httpPort,
      getRuntimeState: () => ({
        running: this.status.state === 'running',
        kernel: this.status.kernel,
        nodeName: this.status.node?.name ?? '',
      }),
    });
  }

  /* ─────────────── 实时遥测（只读，除关闭单条连接外不改内核状态） ─────────────── */

  getTelemetry(): TelemetrySnapshot { return this.telemetry.getSnapshot(); }
  async closeConnection(id: string) { return this.telemetry.closeConnection(id); }
  async probeSites(hosts: string[]): Promise<ProbeReport> { return this.telemetry.probeSites(hosts); }

  /* ─────────────── 设置 ─────────────── */

  /**
   * 执行系统代理脚本。
   * 用临时 .ps1 + -File，而不是 -EncodedCommand：
   * - 脚本明文留在 userData/runtime 下，用户可随时审计
   * - 避免企业安全策略 / 杀软把 base64 编码命令当成可疑行为拦截
   * - 同样不需要处理引号与换行转义
   * 文件按用途固定命名、每次覆盖，不会无限堆积。
   */
  private async runPS(script: string, label: 'read' | 'apply' | 'restore'): Promise<string> {
    const file = path.join(runtimeDirOf(this.userData), `_ps_${label}.ps1`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, script, 'utf8');
    const { stdout, stderr } = await execFileAsync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { timeout: 12000, windowsHide: true, maxBuffer: 512 * 1024 });
    const out = String(stdout ?? '');
    const err = String(stderr ?? '').trim();
    // PowerShell 偶尔把无害提示写进 stderr，因此以「期望输出标记」为准，避免误判失败
    const expected = { read: '{', apply: 'OK', restore: 'RESTORED' }[label];
    if (!out.includes(expected)) {
      throw new Error(`系统代理脚本 ${label} 未返回预期结果。stdout=${out.slice(0, 200) || '(空)'} stderr=${err.slice(0, 200) || '(空)'}`);
    }
    return out;
  }

  private settingsPath(): string { return path.join(this.userData, 'runtime-settings.json'); }

  private readSettings(): RuntimeSettings {
    try {
      const raw = fs.readFileSync(this.settingsPath(), 'utf8');
      const stored = JSON.parse(raw) as Partial<RuntimeSettings>;
      const s = mergeRuntimeSettings(stored);
      // 旧版本默认端口是 7890/10808/10809/9090（Clash、v2rayN、Clash API 的常驻端口），
      // 完全没动过端口设置的老用户直接迁到冷门端口段，避免一启动就撞端口。
      const untouched =
        (stored.socksPort ?? 10808) === 10808 &&
        (stored.httpPort ?? 10809) === 10809 &&
        (stored.mixedPort ?? 7890) === 7890 &&
        (stored.controllerPort ?? 9090) === 9090;
      if (untouched) {
        s.socksPort = DEFAULT_RUNTIME_SETTINGS.socksPort;
        s.httpPort = DEFAULT_RUNTIME_SETTINGS.httpPort;
        s.mixedPort = DEFAULT_RUNTIME_SETTINGS.mixedPort;
        s.controllerPort = DEFAULT_RUNTIME_SETTINGS.controllerPort;
        try { fs.writeFileSync(this.settingsPath(), JSON.stringify(s, null, 2), 'utf8'); } catch { /* 首次启动目录可能还没建，交给 updateSettings 再落盘 */ }
      }
      return s;
    } catch {
      return mergeRuntimeSettings(DEFAULT_RUNTIME_SETTINGS);
    }
  }

  getSettings(): RuntimeSettings { return mergeRuntimeSettings(this.settings); }

  updateSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
    if (this.status.state === 'running' || this.status.state === 'starting') {
      throw new Error('内核运行中，请先断开连接再修改运行设置（避免配置与进程状态不一致）');
    }
    /**
     * 端口合法性清洗：界面上的 <input type="number"> 被清空时 v-model.number 会给空串，
     * 直接落盘会写出 "mixedPort": ""，下次启动 boundPortsOf 拿到空串、内核绑不上端口，
     * 表现成「明明没改设置却连不上」。非法值与重复端口一律忽略（保留原值）并记日志。
     */
    const clean: Partial<RuntimeSettings> = { ...patch };
    const portKeys = ['mixedPort', 'socksPort', 'httpPort', 'controllerPort'] as const;
    const seen = new Set<number>();
    // 先登记「本次没动」的端口：它们的值不会变，所以新值不能跟它们撞。
    // 反过来的话，把 socksPort 改成 httpPort 的原值会被漏过去，两个端口最终还是重复。
    for (const key of portKeys) if (!(key in clean)) seen.add(this.settings[key]);
    for (const key of portKeys) {
      if (!(key in clean)) continue;
      const n = Number(clean[key]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        this.emitLog('warn', 'runtime', `${key} 的值 ${JSON.stringify(patch[key])} 不是 1-65535 的整数，已忽略并保留 ${this.settings[key]}`);
        delete clean[key];
        continue;
      }
      if (seen.has(n)) {
        this.emitLog('warn', 'runtime', `${key} 与其他端口重复（${n}），已忽略并保留 ${this.settings[key]}`);
        delete clean[key];
        continue;
      }
      seen.add(n);
    }
    this.settings = mergeRuntimeSettings({ ...this.settings, ...clean });
    try { fs.writeFileSync(this.settingsPath(), JSON.stringify(this.settings, null, 2), 'utf8'); }
    catch (e) { this.emitLog('warn', 'runtime', `运行设置未能持久化：${e instanceof Error ? e.message : String(e)}`); }
    this.status.settings = this.getSettings();
    this.status.mode = this.settings.mode;
    this.emitStatus();
    return this.getSettings();
  }

  setMode(mode: RuntimeMode): RuntimeSettings {
    return this.updateSettings({ mode });
  }

  /* ─────────────── 状态 / 事件 ─────────────── */

  getStatus(): RuntimeStatus { return JSON.parse(JSON.stringify(this.status)) as RuntimeStatus; }
  getLogs(): RuntimeLog[] { return [...this.logs]; }

  private emitStatus() { this.send('runtime:event', { type: 'status', status: this.getStatus() }); }

  private emitLog(level: RuntimeLog['level'], source: RuntimeLog['source'], line: string) {
    const entry: RuntimeLog = { ts: Date.now(), level, source, line: line.slice(0, 1000) };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.send('runtime:event', { type: 'log', log: entry });
  }

  private setState(state: RuntimeStatus['state'], message: string, lastError: string | null = null) {
    this.status.state = state;
    this.status.message = message;
    this.status.lastError = lastError;
    this.emitStatus();
  }

  /* ─────────────── 二进制 ─────────────── */

  async scan(): Promise<BinaryInventory> {
    return scanBinaries(this.userData, this.projectRoot, this.settings);
  }

  async openBinDir(): Promise<string> {
    const { binDir } = ensureRuntimeDirs(this.userData);
    return binDir;
  }

  async openRuntimeDir(): Promise<string> {
    const dir = runtimeDirOf(this.userData);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async isElevated(): Promise<boolean> {
    if (process.platform !== 'win32') return process.getuid?.() === 0;
    try {
      await execFileAsync('net', ['session'], { timeout: 4000, windowsHide: true });
      return true;
    } catch { return false; }
  }

  /* ─────────────── 启动 ─────────────── */

  async start(req: RuntimeStartRequest): Promise<RuntimeResult> {
    if (this.status.state === 'starting') return { ok: false, status: this.getStatus(), error: '正在启动中，请稍候' };
    if (this.status.state === 'running') return { ok: false, status: this.getStatus(), error: '内核已在运行，请先断开再重新连接' };

    let settings = mergeRuntimeSettings({ ...this.settings, ...(req.settings ?? {}) });
    const listen = settings.listenAddress || '127.0.0.1';
    const node = req.node as UnifiedNode;
    const kernel: KernelType = req.kernel ?? (node?.kernel as KernelType) ?? 'xray';
    const blockers: string[] = [];
    this.logs = [];
    this.status.issues = [];
    this.status.unmapped = [];
    this.status.settings = settings;
    this.status.mode = settings.mode;
    this.setState('starting', `正在准备 ${kernel} 内核…`);
    try {
      // 端口自动避让：设定端口被占（v2rayN / Clash 等）时自动挪到冷门空闲端口，并把新端口同步给系统代理
      const picked = await this.resolveFreePorts(settings, kernel);
      settings = picked.settings;
      this.status.settings = settings;
      for (const c of picked.changes) this.emitLog('warn', 'runtime', c);
      // 自动换过的端口落盘，下次启动直接沿用，不必每次重新探测
      if (picked.changes.length) {
        try { fs.writeFileSync(this.settingsPath(), JSON.stringify(settings, null, 2), 'utf8'); }
        catch { /* 落盘失败不影响本次启动 */ }
      }

      if (!node || !node.server) {
        blockers.push('没有可用的节点：请先在「配置导入」或「节点管理」里导入并确认一个节点');
      }
      const built = node?.server
        ? buildRuntimeConfig(node, kernel, settings, req.peers ?? [], req.routing)
        : null;
      if (built) {
        blockers.push(...built.blockers);
        this.status.issues = built.issues;
        this.status.unmapped = built.unmapped;
      }

      const inv = await this.scan();
      const binary: KernelBinary | undefined = inv.items.find(b => b.kernel === kernel);
      if (!binary?.found) {
        blockers.push(`${kernel} 内核二进制缺失：${binary?.reason ?? '未找到'} ${binary?.hint ?? ''}`);
      }

      const isTun = settings.mode === 'tun';
      if (isTun && kernel === 'xray') blockers.push('Xray 不支持 TUN 入站，请改用 sing-box / Mihomo 内核或切回系统代理模式');
      if (isTun && !(await this.isElevated())) {
        blockers.push('TUN 模式需要创建虚拟网卡，当前进程不是管理员权限。请右键「以管理员身份运行」本程序，或改用系统代理模式');
      }
      if (settings.mode === 'system-proxy' && !systemProxySupported(process.platform)) {
        blockers.push(`当前平台（${process.platform}）未实现自动设置系统代理：${manualProxyHint(process.platform, '127.0.0.1:' + settings.mixedPort)}`);
      }

      if (blockers.length) {
        for (const b of blockers) this.emitLog('error', 'runtime', b);
        this.setState('error', `启动被拒绝（${blockers.length} 项前置条件未满足）`, blockers[0]);
        return { ok: false, status: this.getStatus(), error: blockers[0], blockers };
      }

      const cfg = built!;
      // 带覆盖参数启动时同步到持久设置，保证 spawnKernel / 健康检查 / 后续重启用的都是同一组端口
      this.settings = settings;
      this.emitLog('info', 'runtime', `配置已生成 ${cfg.filename}（${cfg.text.length} 字节）`);
      for (const n of cfg.notes) this.emitLog('info', 'runtime', n);
      for (const i of cfg.issues.filter(x => x.level !== 'info')) {
        this.emitLog(i.level === 'error' ? 'error' : 'warn', 'runtime', `[${i.code}] ${i.message}`);
      }

      this.currentLaunch = {
        kernel, binaryPath: binary!.path,
        configPath: '', configText: cfg.text,
        args: [], node, peers: req.peers ?? [], routing: req.routing,
      };
      await this.spawnKernel({ kernel, binaryPath: binary!.path, filename: cfg.filename, configText: cfg.text, node, message: `正在启动 ${kernel}…` });
      this.restartAttempts = 0;

      // 系统代理：先读快照，再写入；任何失败都回滚
      if (settings.mode === 'system-proxy') {
        const server = `127.0.0.1:${kernel === 'xray' ? settings.httpPort : settings.mixedPort}`;
        const read = readSystemProxyScript(process.platform);
        if (!read) throw new Error('当前平台不支持自动读取系统代理快照');
        const raw = await this.runPS(read.script, 'read');
        this.snapshot = parseWindowsSnapshot(raw, process.platform);
        // 读快照成功就标记「可能需要恢复」：apply 脚本是多步写注册表，任何一步失败都会抛错，
        // 但前面已写的项不会自动回滚。只有置位 proxyDirty，catch→stopInternal 才会真正恢复。
        this.proxyDirty = true;
        this.emitLog('info', 'system', `已保存原始系统代理快照：ProxyEnable=${this.snapshot.proxyEnable ?? '未设置'} / ${this.snapshot.proxyServer ?? '未设置'}`);
        const apply = applySystemProxyScript(process.platform, server);
        if (!apply) throw new Error('当前平台不支持自动写入系统代理');
        await this.runPS(apply.script, 'apply');
        this.status.systemProxy = {
          applied: true, server, snapshot: this.snapshot, restored: false,
          message: `系统代理已指向 ${server}（原始设置已保存，断开时恢复）`,
        };
        this.emitLog('info', 'system', this.status.systemProxy.message);
      } else if (isTun) {
        this.status.systemProxy = { applied: false, server: '', snapshot: null, restored: false, message: 'TUN 模式接管全局流量，未改动系统代理' };
        this.emitLog('info', 'system', 'TUN 模式：不改系统代理，由虚拟网卡接管流量');
      } else {
        this.status.systemProxy = { applied: false, server: '', snapshot: null, restored: false, message: '仅启动内核，未改动系统设置' };
      }

      this.setState('running', `已连接 · ${node.name} · ${kernel}`);
      // 启动实时遥测。Xray 无 HTTP 统计接口，采集器会明确给出原因且不轮询。
      this.telemetry.start(kernel, settings.controllerPort, listen || '127.0.0.1');
      return { ok: true, status: this.getStatus() };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emitLog('error', 'runtime', `启动失败：${message}`);
      await this.stopInternal(message);
      return { ok: false, status: this.getStatus(), error: message };
    }
  }

  /**
   * 端口自动避让：逐个检查内核真正要 bind 的端口，被占用就换到冷门空闲端口。
   * 返回调整后的设置和人类可读的变更说明（调用方负责写日志）。
   * `skip` 里的端口不探测（热切换时旧内核正占着自己的端口，那正是要复用的）。
   */
  private async resolveFreePorts(
    settings: RuntimeSettings,
    kernel: KernelType,
    skip: Set<number> = new Set(),
    /** 并行切换专用：连 Xray 的 controllerPort（api-in 也占端口）一起避让，四个端口互不冲突 */
    allPorts = false,
  ): Promise<{ settings: RuntimeSettings; changes: string[] }> {
    const next: RuntimeSettings = { ...settings };
    const changes: string[] = [];
    const used = new Set<number>();
    const label: Record<string, string> = {
      mixedPort: '混合端口', socksPort: 'SOCKS 端口', httpPort: 'HTTP 端口', controllerPort: '控制端口',
    };
    const keys: Array<'mixedPort' | 'socksPort' | 'httpPort' | 'controllerPort'> =
      allPorts
        ? ['mixedPort', 'socksPort', 'httpPort', 'controllerPort']
        : kernel === 'xray' ? ['socksPort', 'httpPort'] : ['mixedPort', 'socksPort', 'httpPort', 'controllerPort'];
    for (const key of keys) {
      const wanted = next[key];
      const port = await pickFreePort(wanted, used, skip);
      used.add(port);
      if (port !== wanted) {
        const owner = await findPortOwner(wanted);
        changes.push(`${label[key]} ${wanted} 已被${owner ? ` ${owner} ` : '其他程序'}占用，已自动改用 ${port}`);
        next[key] = port;
      }
    }
    return { settings: next, changes };
  }

  /**
   * 切换节点前先用真实内核校验新配置能否加载。
   *
   * 旧链路是「先杀旧进程 → 再起新内核 → 8 秒健康检查」：配置一旦被内核拒绝，
   * 当前连接已经被杀掉，回退也可能跟着失败，用户只看到「切换失败」甚至直接断线。
   * 现在把校验提到动刀之前，不通过就原样返回，当前连接毫发无损，并给出内核原始报错。
   */
  private async validateConfig(kernel: KernelType, binaryPath: string, configText: string): Promise<{ ok: boolean; error: string; skipped?: boolean }> {
    const dir = runtimeDirOf(this.userData);
    const tmp = path.join(dir, `_switch-check-${process.pid}-${Date.now()}.json`);
    const args = kernel === 'xray' ? ['-test', '-c', tmp]
      : kernel === 'sing-box' ? ['check', '-c', tmp]
        : ['-t', '-f', tmp, '-d', dir];
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, configText, 'utf8');
      // 退出码即结论：Xray `-test` / sing-box `check` / mihomo `-t` 对坏配置返回非 0
      await execFileAsync(binaryPath, args, { timeout: 8000, windowsHide: true, cwd: dir, maxBuffer: 1024 * 1024 });
      return { ok: true, error: '' };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const raw = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim();
      // 内核版本换了、不认校验参数时，这是「预检能力不可用」而不是「配置被拒」，必须放行，
      // 否则会把本来能切的节点全挡住（退回原来的启动健康检查路径）。
      if (/unknown flag|flag provided but not defined|unknown command|unknown shorthand|Usage of|incorrect usage/i.test(raw)) {
        return { ok: true, error: '', skipped: true };
      }
      const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const meaningful = lines.filter(l => !/deprecated|\[Warning\]|\[Info\]|A unified platform|Xray \d|sing-box \d|Clash/i.test(l));
      const detail = (meaningful.length ? meaningful : lines).slice(-3).join(' | ');
      return { ok: false, error: (detail || err.message || '内核拒绝该配置').slice(0, 400) };
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件删不掉不影响切换 */ }
    }
  }

  /** 日志文件超过这个大小就只保留末尾一段，避免长期使用无限增长（切节点多的人一天能写几百条） */
  private static readonly RUNTIME_LOG_MAX = 1024 * 1024;
  private static readonly RUNTIME_LOG_KEEP = 400 * 1024;

  /** 切换结果落盘：界面日志关掉软件就没了，排障时从这里能查到确切原因 */
  private appendRuntimeLog(line: string): void {
    try {
      const dir = path.join(this.userData, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'runtime.log');
      // 轮转：超过 1MB 时读末尾 400KB 覆盖写回，再追加本条。
      // 不删文件（用户可能正开着看），也不用 rename，避免被杀软 / 预览占用挡住。
      try {
        const st = fs.statSync(file);
        if (st.size > RuntimeManager.RUNTIME_LOG_MAX) {
          const all = fs.readFileSync(file, 'utf8');
          const tail = all.slice(-RuntimeManager.RUNTIME_LOG_KEEP);
          fs.writeFileSync(file, `[轮转] 日志超过 1MB，已丢弃更早内容\n${tail}`, 'utf8');
        }
      } catch { /* 文件不存在：首次写入，无需轮转 */ }
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch { /* 日志失败不能影响切换 */ }
  }

  /** 精确杀掉指定进程（含子进程树），不依赖 this.proc —— 用于清理候选内核 / 旧内核 */
  private async killChild(child: ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null) return;
    const pid = child.pid;
    if (process.platform === 'win32' && pid) {
      try { await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 6000, windowsHide: true }); }
      catch { try { child.kill(); } catch { /* 已退出 */ } }
    } else {
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      await new Promise(r => setTimeout(r, 300));
      if (child.exitCode === null) try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }

  /**
   * 启动「候选内核」：用一组与当前连接完全隔离的端口，把新节点完整跑起来并做健康检查。
   *
   * 全程不碰 this.proc / this.status / 系统代理。失败时只清理自己（进程 + 临时配置），
   * 旧内核仍在原端口服务，用户上网完全不受影响。
   */
  private async spawnCandidate(input: {
    kernel: KernelType; binaryPath: string; configText: string;
    settings: RuntimeSettings; filename: string;
  }): Promise<{ child: ChildProcess; configPath: string }> {
    const { kernel, binaryPath, configText, settings, filename } = input;
    const dir = runtimeDirOf(this.userData);
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, filename);
    fs.writeFileSync(configPath, configText, 'utf8');

    // 候选端口组必须与当前连接完全隔离；controllerPort 也要算（Xray 的 api-in 同样占端口）
    const ports = [...new Set([...boundPortsOf(kernel, settings), settings.controllerPort])];
    const occupied: number[] = [];
    for (const p of ports) if (await tcpProbe(p)) occupied.push(p);
    if (occupied.length) {
      try { fs.rmSync(configPath, { force: true }); } catch { /* ignore */ }
      throw new Error(`候选端口 ${occupied.join('、')} 已被占用，无法并行验证（当前连接未受影响）`);
    }

    const args = KERNEL_BIN_NAMES[kernel].runArgs(configPath, dir);
    this.emitLog('info', 'runtime', `[候选] 独立端口验证：${path.basename(binaryPath)} ${args.join(' ')}`);
    const child = spawn(binaryPath, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let earlyOutput = '';
    const onData = (buf: Buffer) => {
      const text = buf.toString('utf8');
      earlyOutput = (earlyOutput + text).slice(-8000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.emitLog('info', 'kernel', `[候选] ${line.replace(/\x1b\[[0-9;]*m/g, '')}`);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    // 候选阶段 this.proc 仍是旧进程，候选自己退出不会误触发崩溃重启；扶正后这套监听才生效
    child.on('error', e => {
      this.emitLog('error', 'kernel', `[候选] 进程启动失败：${e.message}`);
      if (this.proc === child && !this.stopping && !this.switching) this.handleUnexpectedExit(`内核进程异常：${e.message}`);
    });
    child.on('exit', (code, signal) => {
      this.emitLog(code === 0 ? 'info' : 'warn', 'kernel', `[候选] 进程退出 code=${code} signal=${signal ?? '-'}`);
      if (this.proc !== child) return;
      this.proc = null;
      if (!this.stopping && !this.switching && (this.status.state === 'starting' || this.status.state === 'running')) {
        this.handleUnexpectedExit(`内核意外退出（code=${code}）：${earlyOutput.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`);
      }
    });

    const probePort = kernel === 'xray' ? settings.httpPort : settings.mixedPort;
    let healthy = false;
    for (let i = 0; i < 32; i++) {
      if (child.exitCode !== null) break;
      if (await tcpProbe(probePort)) { healthy = true; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!healthy) {
      await this.killChild(child);
      try { fs.rmSync(configPath, { force: true }); } catch { /* ignore */ }
      throw new Error(`候选内核未能在 127.0.0.1:${probePort} 监听（8 秒内）。内核输出：${earlyOutput.split('\n').filter(Boolean).slice(-5).join(' | ').slice(0, 400) || '无输出'}`);
    }
    this.emitLog('info', 'runtime', `[候选] 健康检查通过 127.0.0.1:${probePort}（PID ${child.pid}），当前连接仍由旧内核服务`);
    return { child, configPath };
  }

  /**
   * 拉起内核进程的公共路径：写配置 → spawn → 挂日志/退出监听 → 健康检查。
   * start / 自动重启 共用这一份（并行切换走 spawnCandidate，不再「先杀后起」）。
   * 注意：这里不改系统代理（首次启动时由 start() 处理；重启/切换时代理本来就指向本地端口）。
   * 失败时抛错并杀掉刚拉起的进程，由调用方决定回滚策略。
   */
  private async spawnKernel(input: {
    kernel: KernelType;
    binaryPath: string;
    filename: string;
    configText: string;
    node: UnifiedNode;
    message: string;
  }): Promise<ChildProcess> {
    const { kernel, binaryPath, configText, node } = input;
    const dir = runtimeDirOf(this.userData);
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, input.filename);
    fs.writeFileSync(configPath, configText, 'utf8');
    this.status.configPath = configPath;
    if (this.currentLaunch) {
      this.currentLaunch.configPath = configPath;
      this.currentLaunch.args = KERNEL_BIN_NAMES[kernel].runArgs(configPath, dir);
    }
    this.emitLog('info', 'runtime', `配置已写入 ${configPath}（${configText.length} 字节）`);

    // 端口预检（兜底）：正常路径已由 resolveFreePorts 避让过，这里只防「刚探测完就被别人抢」的竞态
    const occupied: number[] = [];
    for (const p of boundPortsOf(kernel, this.settings)) {
      if (await tcpProbe(p)) occupied.push(p);
    }
    if (occupied.length) {
      const owner = await findPortOwner(occupied[0]);
      throw new Error(
        `本地端口 ${occupied.join('、')} 已被其他程序占用${owner ? `：${owner}` : ''}，内核无法绑定。` +
        '请先关闭其他代理软件（如 v2rayN、Clash、SSR 等），或在「运行时设置」里换个端口再连接。',
      );
    }

    const args = KERNEL_BIN_NAMES[kernel].runArgs(configPath, dir);
    this.emitLog('info', 'runtime', `启动命令：${binaryPath} ${args.join(' ')}`);
    this.setState('starting', input.message);
    const child = spawn(binaryPath, args, {
      cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;
    let earlyOutput = '';
    const onData = (buf: Buffer, level: RuntimeLog['level']) => {
      const text = buf.toString('utf8');
      earlyOutput += text;
      if (earlyOutput.length > 8000) earlyOutput = earlyOutput.slice(-8000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.emitLog(level, 'kernel', line.replace(/\x1b\[[0-9;]*m/g, ''));
      }
    };
    child.stdout?.on('data', (b: Buffer) => onData(b, 'info'));
    child.stderr?.on('data', (b: Buffer) => onData(b, 'warn'));

    child.on('error', (e) => {
      this.emitLog('error', 'kernel', `进程启动失败：${e.message}`);
      // 并行切换后这个进程可能已被替换成候选内核，旧进程的事件不能再动当前状态
      if (this.proc !== child) return;
      if (!this.stopping && !this.switching && (this.status.state === 'starting' || this.status.state === 'running')) {
        this.handleUnexpectedExit(`内核进程异常：${e.message}`);
      }
    });
    child.on('exit', (code, signal) => {
      this.emitLog(code === 0 ? 'info' : 'info', 'kernel', `内核进程退出 code=${code} signal=${signal ?? '-'}`);
      // 旧内核被并行切换杀掉时，this.proc 已经指向新内核：只记日志，绝不清空 proc 或触发回滚
      if (this.proc !== child) return;
      this.proc = null;
      if (!this.stopping && !this.switching && (this.status.state === 'starting' || this.status.state === 'running')) {
        this.handleUnexpectedExit(`内核意外退出（code=${code}，signal=${signal ?? '-'}）：${earlyOutput.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`);
      }
    });

    this.status.binary = { kernel, found: true, path: binaryPath, version: '', source: 'app-data' };
    this.status.kernel = kernel;
    this.status.node = { id: node.id, name: node.name, protocol: String(node.protocol), server: node.server, port: node.port };
    this.status.pid = child.pid ?? null;
    this.status.startedAt = Date.now();
    this.status.listenPort = kernel === 'xray' ? this.settings.httpPort : this.settings.mixedPort;

    // 健康检查：等内核真正开始监听，避免「进程起来了但配置加载失败」被报成成功
    const probePort = this.status.listenPort;
    let healthy = false;
    for (let i = 0; i < 32; i++) {
      if (!this.proc) break;
      if (await tcpProbe(probePort)) { healthy = true; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!healthy) {
      await this.killProcess();
      throw new Error(`内核启动后 ${probePort} 端口未监听（8 秒内），可能是配置被内核拒绝，或端口刚被其他程序抢占。内核输出：${earlyOutput.split('\n').filter(Boolean).slice(-5).join(' | ').slice(0, 400) || '无输出'}`);
    }
    this.emitLog('info', 'runtime', `健康检查通过：127.0.0.1:${probePort} 已监听`);
    return child;
  }

  /* ─────────────── 崩溃自动重启（指数退避 1s / 2s / 4s…，达到上限回滚） ─────────────── */

  /** 意外退出的统一入口：要么安排自动重启，要么直接回滚 */
  private handleUnexpectedExit(reason: string): void {
    const s = this.settings;
    if (!s.autoRestart || this.disposed) {
      void this.rollback(reason);
      return;
    }
    if (this.restartAttempts >= s.maxAutoRestarts) {
      this.emitLog('error', 'runtime', `自动重启已达上限（${s.maxAutoRestarts} 次），放弃并回滚：${reason}`);
      void this.rollback(reason);
      return;
    }
    const delay = 1000 * Math.pow(2, this.restartAttempts);
    this.restartAttempts++;
    this.emitLog('warn', 'runtime', reason);
    this.setState('starting', `内核意外退出，${delay / 1000}s 后自动重启（第 ${this.restartAttempts}/${s.maxAutoRestarts} 次）`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.doRestart();
    }, delay);
  }

  private async doRestart(): Promise<void> {
    const L = this.currentLaunch;
    if (!L || this.disposed || this.stopping || this.switching) return;
    this.telemetry.stop(false, '内核重启中，遥测将随新进程恢复');
    try {
      await this.killProcess();
      await this.spawnKernel({
        kernel: L.kernel, binaryPath: L.binaryPath,
        filename: path.basename(L.configPath), configText: L.configText, node: L.node,
        message: `自动重启中（第 ${this.restartAttempts}/${this.settings.maxAutoRestarts} 次）`,
      });
      this.restartAttempts = 0;
      this.setState('running', `已自动恢复 · ${L.node.name} · ${L.kernel}`);
      this.emitLog('info', 'runtime', `自动重启成功：${L.kernel} 已恢复，PID ${this.status.pid}`);
      this.telemetry.start(L.kernel, this.settings.controllerPort, this.settings.listenAddress || '127.0.0.1');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emitLog('error', 'runtime', `自动重启失败：${msg}`);
      this.handleUnexpectedExit(`自动重启失败：${msg}`);
    }
  }

  private cancelRestartTimer(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
  }

  /* ─────────────── 运行中热切换节点 ─────────────── */

  /**
   * 运行中切换节点：杀旧进程 → 写新配置 → 拉新进程 → 健康检查。
   * 系统代理 / TUN 不动（本地监听端口不变），遥测继续采样，只有几秒断流。
   * 新节点起不来时自动回退旧节点；旧节点也起不来才做完整回滚（恢复系统代理）。
   */
  /**
   * 并行热切换（零断网）：
   *   ① 新内核在另一组空闲端口上独立启动 + 健康检查 —— 旧内核与系统代理全程不动
   *   ② 验证通过才把系统代理改指向新端口（此刻两个内核都可用）
   *   ③ 扶正新内核、落盘端口，最后才杀旧内核
   * ① / ② 任何一步失败 → 只清理候选进程，当前连接与系统代理完全不变，用户照常上网。
   *
   * 旧链路「先杀旧 → 再起新 → 失败 rollback」会因端口漂移 / 残留进程导致回退失败并直接断网，
   * 这条路径已彻底移除。
   */
  async switchNode(req: RuntimeStartRequest): Promise<RuntimeResult> {
    // 重入锁必须在第一个 await 之前同步置位。配置预检最长 8 秒，
    // 这段时间里第二次点击若只看状态位，会同时进入候选阶段；两个候选内核都起来后，
    // 先扶正的那个会被后扶正的顶掉，成为没有任何引用的孤儿进程继续占用端口。
    if (this.switching) {
      return { ok: false, status: this.getStatus(), error: '正在切换中，请稍候（当前连接不受影响）' };
    }
    if (this.status.state !== 'running') {
      return { ok: false, status: this.getStatus(), error: '仅在内核运行中可以切换节点；请先连接，或直接启动目标节点' };
    }
    this.switching = true;
    try {
      return await this.switchNodeInternal(req);
    } catch (e) {
      // 兜底：端口扫描失败、运行目录不可写这类异常以前会让 IPC promise 直接 reject，
      // 渲染层拿不到结果，界面上就是「点了没反应」。一律转成可读的失败结果。
      const msg = e instanceof Error ? e.message : String(e);
      this.emitLog('error', 'runtime', `切换异常（当前连接未受影响）：${msg}`);
      this.appendRuntimeLog(`切换异常（连接未受影响）：${msg}`);
      return { ok: false, status: this.getStatus(), error: `切换失败：${msg}（当前连接与系统代理均未改动，可正常上网）` };
    } finally {
      this.switching = false;
    }
  }

  private async switchNodeInternal(req: RuntimeStartRequest): Promise<RuntimeResult> {
    const node = req.node as UnifiedNode;
    let kernel: KernelType = req.kernel ?? (node?.kernel as KernelType) ?? this.status.kernel ?? 'xray';
    // 目标节点不支持当前内核时自动换到它能跑的内核，而不是直接判切换失败
    if (node?.kernels?.length && !node.kernels.includes(kernel)) {
      const fallback = node.kernels[0];
      this.emitLog('warn', 'runtime', `[切换] ${kernel} 不支持「${node.name}」，自动改用 ${fallback} 内核`);
      this.appendRuntimeLog(`切换换核 ${node.name}：${kernel} → ${fallback}`);
      kernel = fallback;
    }
    const oldLaunch = this.currentLaunch ? { ...this.currentLaunch } : null;
    const oldSettings: RuntimeSettings = { ...this.getSettings() };
    const oldProc = this.proc;
    const oldSystemProxy = { ...this.status.systemProxy };
    const compatiblePeers = (req.peers ?? []).filter(p => !p.kernels?.length || p.kernels.includes(kernel));

    /**
     * 候选端口组必须是「当前确实空闲」的一组，四个端口全部独立分配（含 Xray 的 api-in），
     * 不复用旧内核正占着的任何端口，杜绝端口漂移与残留进程占用。
     *
     * 从这里开始的每一步都可能抛错（端口扫描 / 配置生成 / 二进制探测 / 内核预检），
     * 全部放在同一个 try 里：任何一步失败都只清理候选，当前连接与系统代理保持不变，
     * 并把原因作为普通返回值交回渲染层 —— 绝不让异常穿过 IPC 变成「点了没反应」。
     */
    let candidate: { child: ChildProcess; configPath: string } | null = null;
    /** 候选是否已扶正。扶正后网络已跑在新内核上，任何时候都不能再走回滚分支。 */
    let promoted = false;
    try {
      if (oldSettings.mode === 'tun') {
        return { ok: false, status: this.getStatus(), error: 'TUN 模式不支持不停机切换（虚拟网卡由内核独占）；请先断开再连接目标节点。当前连接未受影响' };
      }

      const picked = await this.resolveFreePorts(this.getSettings(), kernel, new Set(), true);
      const candidateSettings = picked.settings;
      for (const c of picked.changes) this.emitLog('warn', 'runtime', `[切换] ${c}`);

      let built: ReturnType<typeof buildRuntimeConfig>;
      try {
        if (!node?.server) throw new Error('目标节点无效：缺少服务器地址');
        built = buildRuntimeConfig(node, kernel, candidateSettings, compatiblePeers, req.routing);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, status: this.getStatus(), error: `切换被拒绝：${msg}（当前连接未受影响）` };
      }
      if (built.blockers.length) {
        for (const b of built.blockers) this.emitLog('error', 'runtime', `[切换] ${b}`);
        return { ok: false, status: this.getStatus(), error: `切换被拒绝：${built.blockers[0]}（当前连接未受影响）`, blockers: built.blockers };
      }
      const inv = await this.scan();
      const binary = inv.items.find(b => b.kernel === kernel);
      if (!binary?.found) {
        return { ok: false, status: this.getStatus(), error: `切换被拒绝：${kernel} 二进制缺失（当前连接未受影响）` };
      }
      if (kernel !== oldLaunch?.kernel && kernel === 'xray' && candidateSettings.mode === 'tun') {
        return { ok: false, status: this.getStatus(), error: '切换被拒绝：Xray 不支持 TUN（当前连接未受影响）' };
      }

      // 真实内核校验候选配置，不通过就原样返回（一个字节都不碰当前连接）
      const check = await this.validateConfig(kernel, binary.path, built.text);
      if (check.skipped) this.emitLog('warn', 'runtime', '[切换] 当前内核版本不支持配置预检，沿用启动健康检查');
      if (!check.ok) {
        const msg = `切换被拒绝：${kernel} 不接受目标节点配置 —— ${check.error}（当前连接未受影响）`;
        this.emitLog('error', 'runtime', `[切换] ${msg}`);
        this.appendRuntimeLog(`切换拒绝 ${oldLaunch?.node.name ?? '?'} → ${node.name} / ${kernel}：${check.error}`);
        return { ok: false, status: this.getStatus(), error: msg };
      }

      this.emitLog('info', 'runtime', `并行切换：${oldLaunch?.node.name ?? '未知'} → ${node.name}（验证阶段旧内核与系统代理保持不动）`);
      const ext = built.filename.match(/(\.json|\.yaml|\.yml)$/i)?.[0] ?? '.json';
      const candidateFilename = built.filename.replace(/(\.json|\.yaml|\.yml)$/i, '') + '-candidate' + ext;

      // ① 独立端口启动候选并验证健康；失败时旧内核与系统代理一个字节都没动
      candidate = await this.spawnCandidate({
        kernel, binaryPath: binary.path, configText: built.text,
        settings: candidateSettings, filename: candidateFilename,
      });
      const newServer = `127.0.0.1:${kernel === 'xray' ? candidateSettings.httpPort : candidateSettings.mixedPort}`;

      // ② 先把系统代理改指向候选（候选已健康，此刻两个内核都可用）；失败就只清候选
      if (candidateSettings.mode === 'system-proxy' && this.status.systemProxy?.applied) {
        const apply = applySystemProxyScript(process.platform, newServer);
        if (apply) {
          await this.runPS(apply.script, 'apply');
          this.status.systemProxy.server = newServer;
          this.status.systemProxy.message = `系统代理已改指向 ${newServer}（并行切换）`;
          this.emitLog('info', 'system', this.status.systemProxy.message);
        }
      }

      // ③ 扶正：只改内存状态与落盘；网络此时已由候选内核接管，异常也只记告警、绝不回滚
      try {
        const officialPath = path.join(runtimeDirOf(this.userData), built.filename);
        fs.writeFileSync(officialPath, built.text, 'utf8');
        try { fs.rmSync(candidate.configPath, { force: true }); } catch { /* ignore */ }
        this.proc = candidate.child;
        // 旧内核登记为「待回收」：扶正后它若还活着，断开 / 退出时会补刀，绝不留孤儿进程占端口
        this.retiredProc = oldProc;
        this.settings = candidateSettings;
        this.status.settings = candidateSettings;
        this.status.binary = { kernel, found: true, path: binary.path, version: '', source: 'app-data' };
        this.status.kernel = kernel;
        this.status.node = { id: node.id, name: node.name, protocol: String(node.protocol), server: node.server, port: node.port };
        this.status.pid = candidate.child.pid ?? null;
        this.status.startedAt = Date.now();
        this.status.listenPort = kernel === 'xray' ? candidateSettings.httpPort : candidateSettings.mixedPort;
        this.status.configPath = officialPath;
        this.currentLaunch = {
          kernel, binaryPath: binary.path, configPath: officialPath, configText: built.text,
          args: [], node, peers: compatiblePeers, routing: req.routing,
        };
        this.restartAttempts = 0;
        // 端口落盘，杜绝「settings 与实际运行配置脱节」导致的下一次端口漂移
        try { fs.writeFileSync(this.settingsPath(), JSON.stringify(candidateSettings, null, 2), 'utf8'); } catch { /* ignore */ }
        this.telemetry.start(kernel, candidateSettings.controllerPort, candidateSettings.listenAddress || '127.0.0.1');
        this.setState('running', `已切换 · ${node.name} · ${kernel}`);
        promoted = true;
      } catch (e3) {
        const m3 = e3 instanceof Error ? e3.message : String(e3);
        // 落盘 / 遥测这类收尾动作出错时进程已经扶正、网络已由新内核接管，同样不能回滚
        promoted = this.proc === candidate.child;
        this.emitLog('warn', 'runtime', `[切换] 状态同步异常（网络已由新内核接管，不影响使用）：${m3}`);
        this.appendRuntimeLog(`切换扶正告警 ${node.name}：${m3}`);
      }
      // 网络已由新内核接管：立刻解除切换锁，让后续崩溃能被自动重启正常接管
      this.switching = false;

      // ④ 最后才杀旧内核
      await this.killChild(oldProc);
      if (this.retiredProc === oldProc) this.retiredProc = null;
      this.emitLog('info', 'runtime', `并行切换完成：${node.name}（PID ${candidate.child.pid}），旧内核已退出，全程未断网`);
      this.appendRuntimeLog(`并行切换成功 ${oldLaunch?.node.name ?? '?'} → ${node.name} / ${kernel}，新端口 ${newServer}，PID ${candidate.child.pid}`);
      return { ok: true, status: this.getStatus() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 已经扶正：网络跑在新内核上，只剩收尾动作出错。回滚会把 this.proc 指回旧进程、
      // 让系统代理指向已停止的端口 —— 那才是真的断网。这里只记录，按成功返回。
      if (promoted) {
        this.emitLog('warn', 'runtime', `[切换] 收尾异常（新内核已在服务，未回滚）：${msg}`);
        this.appendRuntimeLog(`切换收尾异常（已扶正，未回滚）${node.name}：${msg}`);
        return { ok: true, status: this.getStatus() };
      }
      const proxyChanged = this.status.systemProxy.server !== oldSystemProxy.server;
      // 只清理候选；旧内核 / 系统代理 / 设置全部还原，用户上网不受任何影响
      if (candidate) await this.killChild(candidate.child);
      try { if (candidate) fs.rmSync(candidate.configPath, { force: true }); } catch { /* ignore */ }
      this.proc = oldProc;
      this.settings = oldSettings;
      this.status.settings = oldSettings;
      this.status.systemProxy = oldSystemProxy;
      if (oldLaunch) this.currentLaunch = oldLaunch;
      // 若系统代理已被改指向候选，必须改回去（候选马上被杀，否则用户会断网）
      if (oldSystemProxy.applied && oldSystemProxy.server && proxyChanged) {
        const restore = applySystemProxyScript(process.platform, oldSystemProxy.server);
        if (restore) {
          try { await this.runPS(restore.script, 'apply'); } catch (e4) {
            this.emitLog('error', 'system', `[切换] 系统代理回指 ${oldSystemProxy.server} 失败：${e4 instanceof Error ? e4.message : String(e4)}`);
          }
        }
      }
      this.emitLog('error', 'runtime', `切换失败但当前连接未受影响：${msg}`);
      this.appendRuntimeLog(`并行切换失败（连接未受影响）${oldLaunch?.node.name ?? '?'} → ${node.name} / ${kernel}：${msg}`);
      return { ok: false, status: this.getStatus(), error: `${msg}（当前连接与系统代理均未改动，可正常上网）` };
    }
  }

  /* ─────────────── 停止 / 回滚 ─────────────── */

  async stop(): Promise<RuntimeResult> {
    await this.stopInternal(null);
    return { ok: true, status: this.getStatus() };
  }

  private async restoreProxy(): Promise<void> {
    // 以 proxyDirty 为准而非 applied：apply 写到一半失败时 applied=false，但注册表可能已被改动。
    // 只要读快照成功过（proxyDirty=true），就必须尝试恢复，绝不能跳过。
    if (!this.proxyDirty || !this.snapshot) {
      this.status.systemProxy = { applied: false, server: '', snapshot: null, restored: false, message: '系统代理未被修改，无需恢复' };
      return;
    }
    const script = restoreSystemProxyScript(process.platform, this.snapshot);
    if (!script) {
      this.status.systemProxy.message = '⚠ 当前平台无法自动恢复系统代理，请按快照手动还原';
      this.emitLog('error', 'system', `${this.status.systemProxy.message}：${JSON.stringify(this.snapshot)}`);
      // 保留 proxyDirty + snapshot，供下次断开 / 退出重试，也方便用户按日志手动还原
      return;
    }
    try {
      await this.runPS(script.script, 'restore');
      this.status.systemProxy = {
        applied: false, server: '', snapshot: this.snapshot, restored: true,
        message: '系统代理已按启动前的快照恢复',
      };
      this.emitLog('info', 'system', this.status.systemProxy.message);
      // 只有真正恢复成功才清除脏标记和快照
      this.proxyDirty = false;
      this.snapshot = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.status.systemProxy.message = `⚠ 系统代理恢复失败：${msg}（原始快照已保留，下次断开会重试；也可按日志手动还原）`;
      this.emitLog('error', 'system', `${this.status.systemProxy.message}；原始快照：${JSON.stringify(this.snapshot)}`);
      // 恢复失败：snapshot 与 proxyDirty 都保留，绝不无条件清空
    }
  }

  private async killProcess(): Promise<void> {
    const child = this.proc;
    this.proc = null;
    if (!child || child.exitCode !== null) return;
    const pid = child.pid;
    if (process.platform === 'win32' && pid) {
      try { await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 6000, windowsHide: true }); }
      catch { try { child.kill(); } catch { /* 已退出 */ } }
    } else {
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      await new Promise(r => setTimeout(r, 400));
      if (child.exitCode === null) try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }

  private async stopInternal(error: string | null): Promise<void> {
    // 已有 stop 在跑时不能直接返回：dispose 会据此认为清理完成、立刻 app.quit()，
    // 把正在恢复系统代理的 PowerShell 拦腰截断，代理就留在被改状态。
    // 改为等待同一个 in-flight 任务，确保恢复真正结束。
    if (this.stopInFlight) { await this.stopInFlight; return; }
    const task = this.doStop(error);
    this.stopInFlight = task;
    try { await task; } finally { this.stopInFlight = null; }
  }

  private async doStop(error: string | null): Promise<void> {
    this.stopping = true;
    this.cancelRestartTimer();
    try {
      this.setState('stopping', error ? '启动失败，正在回滚…' : '正在断开并恢复系统设置…');
      await this.restoreProxy();
      await this.killProcess();
      // 切换过程中被替换、但没来得及确认杀掉的旧内核，在这里补刀。
      // 漏了这一步的话，它会一直占着端口跑到用户重启电脑。
      if (this.retiredProc) {
        await this.killChild(this.retiredProc);
        this.retiredProc = null;
      }
      this.telemetry.stop(false, error ? `连接失败，实时数据已停止：${error}` : '内核已断开，实时数据停止采样');
      this.status.pid = null;
      this.status.startedAt = null;
      this.status.listenPort = null;
      // 恢复失败时不能谎报「已恢复」：代理可能仍指向已死的端口，用户会被这句提示误导而继续上网失败。
      const proxyFailed = this.proxyDirty && !this.status.systemProxy.restored;
      const stopMsg = error ? `启动失败：${error}`
        : proxyFailed ? `已断开内核，但系统代理恢复失败，请按日志手动还原（${this.status.systemProxy.message}）`
        : '已断开，系统设置已恢复';
      this.setState(error ? 'error' : 'stopped', stopMsg, error);
    } finally {
      this.stopping = false;
    }
  }

  private async rollback(reason: string): Promise<void> {
    await this.stopInternal(reason);
  }

  /** 应用退出时调用：必须恢复系统代理，不能把用户的设置留在被改写状态 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // 故意不重置 this.stopping：上一次 stop 还没走完时重置，会让两个 stopInternal
    // 并发去改系统代理。stopInternal 的 finally 会自己把标志复位。
    await this.stopInternal(this.status.state === 'running' ? '应用退出，已自动断开并恢复系统设置' : null);
  }

  /* ─────────────── 真实 TCP 延迟测速 ─────────────── */

  async ping(server: string, port: number, timeout = 3000): Promise<{ ok: boolean; ms: number | null; error?: string }> {
    if (!server || !Number.isFinite(port) || port <= 0 || port > 65535) {
      return { ok: false, ms: null, error: '服务器地址或端口无效' };
    }
    return new Promise(resolve => {
      const start = Date.now();
      const sock = new net.Socket();
      let done = false;
      const finish = (ok: boolean, error?: string) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve(ok ? { ok: true, ms: Date.now() - start } : { ok: false, ms: null, error });
      };
      sock.setTimeout(timeout);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false, '连接超时'));
      sock.once('error', e => finish(false, e.message));
      try { sock.connect(port, server); } catch (e) { finish(false, e instanceof Error ? e.message : String(e)); }
    });
  }
}
