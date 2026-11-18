/**
 * 内核运行层 —— 共享类型与默认设置
 *
 * 这一层是纯数据，不 import electron / node 内置模块，渲染层与测试都可以直接用。
 * 安全边界：所有会改动系统状态的操作都必须可逆，且必须先保存快照。
 */

import type { KernelType, ParseIssue, UnifiedNode } from '../hub/model.js';
import type { RoutingConfig } from './rules.js';

export type RuntimeMode = 'system-proxy' | 'tun' | 'none';
export type RuntimeState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeSettings {
  /** 混合入站（HTTP + SOCKS），系统代理默认指向它 */
  mixedPort: number;
  socksPort: number;
  httpPort: number;
  listenAddress: string;
  mode: RuntimeMode;
  logLevel: LogLevel;
  /** 是否把 DNS 交给内核处理，防止 DNS 泄漏 */
  dnsEnabled: boolean;
  dnsServers: string[];
  /** 局域网地址直连，避免把内网流量送进代理 */
  bypassLan: boolean;
  /** TUN 模式参数 */
  tun: {
    interfaceName: string;
    mtu: number;
    autoRoute: boolean;
    strictRoute: boolean;
    stack: 'system' | 'gvisor' | 'mixed';
  };
  /** Mihomo / sing-box clash_api 控制端口，供后续统计接入 */
  controllerPort: number;
  /** 进程退出 / 应用关闭时自动恢复系统代理（默认必须开启） */
  autoRestoreOnExit: boolean;
  /** 内核意外退出时自动重启（指数退避 1s/2s/4s…；连续失败达上限后回滚） */
  autoRestart: boolean;
  /** 自动重启最大尝试次数；达到上限后断开并恢复系统设置 */
  maxAutoRestarts: number;
  /** 用户手工指定的内核二进制路径，优先级最高 */
  binaryPaths: Partial<Record<KernelType, string>>;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  // 冷门端口段：避开 7890/7891（Clash）、10808/10809（v2rayN）、9090（Clash API）等大众端口，
  // 这些端口常年被其他代理软件占用，默认撞上就会启动失败。
  mixedPort: 21810,
  socksPort: 21808,
  httpPort: 21809,
  listenAddress: '127.0.0.1',
  mode: 'system-proxy',
  logLevel: 'warn',
  dnsEnabled: true,
  dnsServers: ['223.5.5.5', '119.29.29.29', '8.8.8.8'],
  bypassLan: true,
  tun: {
    interfaceName: 'upc-tun',
    mtu: 9000,
    autoRoute: true,
    strictRoute: false,
    stack: 'system',
  },
  controllerPort: 21811,
  autoRestoreOnExit: true,
  autoRestart: true,
  maxAutoRestarts: 3,
  binaryPaths: {},
};

/** 某个内核真正会 bind 的本地端口（Xray 使用独立 API 入站端口；其它内核含 mixed 与控制端口） */
export function boundPortsOf(kernel: KernelType, s: RuntimeSettings): number[] {
  const base = [s.socksPort, s.httpPort];
  return kernel === 'xray' ? [...base, s.controllerPort] : [s.mixedPort, ...base, s.controllerPort];
}

/** 把绑定地址转换为本机客户端可连接的地址；通配地址应通过回环地址访问。 */
export function localProxyHost(listenAddress: string): string {
  const host = String(listenAddress ?? '').trim();
  return !host || host === '0.0.0.0' || host === '::' || host === '::0' ? '127.0.0.1' : host;
}

/** 生成系统代理可解析的 host:port；IPv6 地址必须加方括号。 */
export function localProxyServer(listenAddress: string, port: number): string {
  const host = localProxyHost(listenAddress);
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function mergeRuntimeSettings(input?: Partial<RuntimeSettings>): RuntimeSettings {
  const base = DEFAULT_RUNTIME_SETTINGS;
  if (!input) return JSON.parse(JSON.stringify(base)) as RuntimeSettings;
  return {
    ...base,
    ...input,
    tun: { ...base.tun, ...(input.tun ?? {}) },
    dnsServers: input.dnsServers?.length ? [...input.dnsServers] : [...base.dnsServers],
    binaryPaths: { ...base.binaryPaths, ...(input.binaryPaths ?? {}) },
  };
}

/** 内核二进制探测结果。缺失时 reason 必须说清该把文件放哪，绝不假装可用。 */
export interface KernelBinary {
  kernel: KernelType;
  found: boolean;
  path: string;
  version: string;
  source: 'user-specified' | 'app-data' | 'project' | 'path' | 'none';
  reason?: string;
  hint?: string;
}

export type BinaryInventory = {
  binDir: string;
  items: KernelBinary[];
  platform: string;
};

/** 修改系统代理前的原始值快照，断开时按此精确恢复 */
export interface SystemProxySnapshot {
  capturedAt: number;
  platform: string;
  proxyEnable: number | string | null;
  proxyServer: string | null;
  proxyOverride: string | null;
  autoConfigUrl: string | null;
  /** 非 Windows 平台保存的原始命令输出，便于排查 */
  raw?: string;
}

export interface SystemProxyState {
  applied: boolean;
  server: string;
  snapshot: SystemProxySnapshot | null;
  restored: boolean;
  message: string;
}

export interface RuntimeLog {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: 'kernel' | 'runtime' | 'system';
  line: string;
}

export interface RuntimeStatus {
  state: RuntimeState;
  mode: RuntimeMode;
  kernel: KernelType | null;
  binary: KernelBinary | null;
  node: { id: string; name: string; protocol: string; server: string; port: number } | null;
  pid: number | null;
  listenPort: number | null;
  startedAt: number | null;
  configPath: string | null;
  systemProxy: SystemProxyState;
  message: string;
  lastError: string | null;
  /** 生成运行配置时无法表达 / 被排除的字段，必须传给 UI 显示 */
  issues: ParseIssue[];
  unmapped: string[];
  settings: RuntimeSettings;
  /** 浏览器预览模式下为 true：不能启动内核，但状态仍可查看 */
  unavailable: boolean;
}

export interface RuntimeStartRequest {
  node: UnifiedNode;
  /** 同内核的其它节点，一并写进配置以便切换 */
  peers?: UnifiedNode[];
  kernel?: KernelType;
  settings?: Partial<RuntimeSettings>;
  /** 用户自定义路由规则 / DNS 分流；不下发时会明确阻断启动 */
  routing?: RoutingConfig;
}

export interface RuntimeResult {
  ok: boolean;
  status: RuntimeStatus;
  error?: string;
  /** 明确列出启动被拒绝的原因，不静默降级 */
  blockers?: string[];
  /** 热切换专用：新节点启动失败但旧节点已恢复 */
  reverted?: boolean;
}

export function emptyStatus(settings: RuntimeSettings, unavailable = false): RuntimeStatus {
  return {
    state: 'stopped',
    mode: settings.mode,
    kernel: null,
    binary: null,
    node: null,
    pid: null,
    listenPort: null,
    startedAt: null,
    configPath: null,
    systemProxy: { applied: false, server: '', snapshot: null, restored: false, message: '未启用系统代理' },
    message: unavailable ? '浏览器预览模式：内核运行层需要 Electron 桌面端' : '内核未启动',
    lastError: null,
    issues: [],
    unmapped: [],
    settings,
    unavailable,
  };
}

export const KERNEL_BIN_NAMES: Record<KernelType, { win: string[]; unix: string[]; versionArgs: string[]; runArgs: (cfg: string, dir: string) => string[] }> = {
  xray: {
    win: ['xray.exe', 'Xray.exe'],
    unix: ['xray'],
    versionArgs: ['version'],
    runArgs: cfg => ['run', '-c', cfg],
  },
  'sing-box': {
    win: ['sing-box.exe', 'sing-box-client.exe'],
    unix: ['sing-box'],
    versionArgs: ['version'],
    runArgs: cfg => ['run', '-c', cfg, '--disable-color'],
  },
  mihomo: {
    win: ['mihomo.exe', 'clash-meta.exe', 'Clash.Meta.exe'],
    unix: ['mihomo', 'clash-meta'],
    versionArgs: ['-v'],
    runArgs: (cfg, dir) => ['-f', cfg, '-d', dir],
  },
};
