/**
 * 渲染层统一 API 适配：
 * - Electron 环境走 preload → 主进程 IPC
 * - 浏览器 / Vite dev 预览环境直接调用同一份纯逻辑解析中心（无需主进程）
 * 两种情况行为一致，都只返回"预览报告"，不会自动写入或执行。
 */
import {
  importText, importConfigFile, generateKernelConfig, protocolCoverage, toPlain,
} from '../core/hub/index.js'
import type { ImportOptions, ImportReport, UnifiedNode, KernelType } from '../core/hub/model.js'
import { buildRuntimeConfig } from '../core/runtime/config-builder.js'
import {
  emptyStatus, mergeRuntimeSettings,
  type BinaryInventory, type RuntimeLog, type RuntimeMode, type RuntimeResult,
  type RuntimeSettings, type RuntimeStartRequest, type RuntimeStatus,
} from '../core/runtime/types.js'
import {
  emptyTelemetry, describeVerdict, type ProbeReport, type TelemetrySnapshot,
} from '../core/runtime/telemetry.js'

export { describeVerdict }

const PREVIEW_HINT = '浏览器预览模式：内核运行层需要 Electron 桌面端（启动进程 / 系统代理 / TUN 均不可用）。可先用「生成运行配置预览」查看将落盘的内容。'

/**
 * 跨 IPC 传参前必须把 Vue / Pinia 的响应式 Proxy 剥成纯数据，
 * 否则 contextBridge 与 structuredClone 都会抛
 * "An object could not be cloned."（Vue 错误参考 runtime-5）。
 * 实现放在 core/hub/util.ts 的 toPlain（全深度，可单元测试）。
 */
export { toPlain }

function api(): any {
  return typeof window !== 'undefined' ? (window as any).electronAPI : undefined
}

/** 程序版本信息（主进程 app-info 返回） */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  osRelease: string
  packaged: boolean
  buildTime: string
  userData: string
  exePath: string
}

/** 浏览器预览时的占位信息，保证界面不空白也不撒谎 */
function previewAppInfo(): AppInfo {
  return {
    name: '万能代理客户端', version: '—', electron: '—', chrome: '—', node: '—', v8: '—',
    platform: 'browser', arch: '—', osRelease: '—', packaged: false,
    buildTime: '', userData: '', exePath: '',
  }
}

/** 读取程序版本信息；桌面端取真实运行时数据，浏览器预览返回占位值 */
export async function appInfo(): Promise<AppInfo> {
  const a = api()
  if (a?.appInfo) {
    try {
      const r = await a.appInfo()
      if (r && typeof r === 'object') return { ...previewAppInfo(), ...r } as AppInfo
    } catch { /* 落到占位信息 */ }
  }
  return previewAppInfo()
}

/** 把界面主题同步给 Electron 原生层；浏览器预览没有原生层，静默跳过即可 */
export async function setThemeSource(mode: 'dark' | 'light' | 'system'): Promise<void> {
  const a = api()
  if (!a?.setThemeSource) return
  try { await a.setThemeSource(mode) } catch { /* 原生主题同步失败不影响界面切换 */ }
}

export async function parseConfig(text: string, opts: ImportOptions = {}): Promise<ImportReport> {
  const a = api()
  if (a?.parseConfig) {
    try {
      const r = await a.parseConfig(text, toPlain(opts))
      if (r && typeof r === 'object' && 'nodes' in r) return r as ImportReport
    } catch { /* 落到本地实现 */ }
  }
  return importText(text, opts)
}

export async function parseFile(name: string, content: string, opts: ImportOptions = {}): Promise<ImportReport> {
  return importConfigFile(name, content, opts)
}

export async function coverage() {
  const a = api()
  if (a?.protocolCoverage) {
    try { return await a.protocolCoverage(); } catch { /* 落到本地 */ }
  }
  return protocolCoverage()
}

export async function generateConfig(nodes: UnifiedNode[], kernel: KernelType) {
  const a = api()
  if (a?.generateConfig) {
    try {
      const r = await a.generateConfig(toPlain(nodes), kernel)
      if (r && r.config) return r
    } catch { /* 落到本地 */ }
  }
  return generateKernelConfig(nodes, kernel)
}

/** 订阅拉取必须由用户显式触发；浏览器预览环境不支持跨域拉取，会明确报错而不是静默失败 */
export async function fetchSubscription(url: string): Promise<{ ok: boolean; text?: string; error?: string; contentType?: string }> {
  const a = api()
  if (a?.fetchSubscription) return a.fetchSubscription(url)
  return { ok: false, error: '订阅拉取需要 Electron 主进程（当前为浏览器预览模式）。请直接粘贴订阅内容，或在桌面端使用。' }
}

/* ==================== 内核运行层 ==================== */

export function runtimeAvailable(): boolean {
  return !!api()?.runtimeStatus
}

export async function runtimeStatus(): Promise<RuntimeStatus> {
  const a = api()
  if (a?.runtimeStatus) {
    try { return await a.runtimeStatus() as RuntimeStatus } catch { /* 落到降级 */ }
  }
  return emptyStatus(mergeRuntimeSettings(), true)
}

export async function runtimeLogs(): Promise<RuntimeLog[]> {
  const a = api()
  if (a?.runtimeLogs) { try { return await a.runtimeLogs() as RuntimeLog[] } catch { /* 忽略 */ } }
  return []
}

export async function runtimeSettings(): Promise<RuntimeSettings> {
  const a = api()
  if (a?.runtimeSettings) { try { return await a.runtimeSettings() as RuntimeSettings } catch { /* 忽略 */ } }
  return mergeRuntimeSettings()
}

export async function runtimeBinaries(): Promise<BinaryInventory> {
  const a = api()
  if (a?.runtimeBinaries) { try { return await a.runtimeBinaries() as BinaryInventory } catch { /* 忽略 */ } }
  return {
    binDir: '', platform: 'browser-preview',
    items: (['xray', 'sing-box', 'mihomo'] as KernelType[]).map(kernel => ({
      kernel, found: false, path: '', version: '', source: 'none' as const,
      reason: PREVIEW_HINT, hint: '请在 Electron 桌面端查看内核二进制状态',
    })),
  }
}

export async function runtimeUpdateSettings(patch: Partial<RuntimeSettings>): Promise<{ ok: boolean; settings?: RuntimeSettings; error?: string }> {
  const a = api()
  if (a?.runtimeUpdateSettings) return a.runtimeUpdateSettings(toPlain(patch))
  return { ok: false, error: PREVIEW_HINT }
}

export async function runtimeSetMode(mode: RuntimeMode): Promise<{ ok: boolean; settings?: RuntimeSettings; error?: string }> {
  const a = api()
  if (a?.runtimeSetMode) return a.runtimeSetMode(mode)
  return { ok: false, error: PREVIEW_HINT }
}

export async function runtimeStart(req: RuntimeStartRequest): Promise<RuntimeResult> {
  const a = api()
  if (a?.runtimeStart) return a.runtimeStart(toPlain(req)) as Promise<RuntimeResult>
  const status = emptyStatus(mergeRuntimeSettings(req.settings), true)
  return { ok: false, status, error: PREVIEW_HINT, blockers: [PREVIEW_HINT] }
}

export async function runtimeStop(): Promise<RuntimeResult> {
  const a = api()
  if (a?.runtimeStop) return a.runtimeStop() as Promise<RuntimeResult>
  return { ok: false, status: emptyStatus(mergeRuntimeSettings(), true), error: PREVIEW_HINT }
}

/** 运行中热切换节点：新节点起不来自动回退旧节点 */
export async function runtimeSwitchNode(req: RuntimeStartRequest): Promise<RuntimeResult> {
  const a = api()
  if (a?.runtimeSwitchNode) return a.runtimeSwitchNode(toPlain(req)) as Promise<RuntimeResult>
  return { ok: false, status: emptyStatus(mergeRuntimeSettings(req.settings), true), error: PREVIEW_HINT }
}

/** 内核二进制下载进度（与主进程 downloader 的 DownloadProgress 结构一致，但这里只保留渲染层需要的形状） */
export interface KernelDownloadProgress {
  kernel: KernelType
  phase: 'plan' | 'download' | 'checksum' | 'extract' | 'install' | 'done' | 'error'
  received: number
  total: number
  message: string
}

/** 内核二进制一键下载（用户显式触发）；浏览器预览模式明确拒绝 */
export async function runtimeDownloadBinary(kernel: KernelType, version?: string, proxyUrl?: string): Promise<{ ok: boolean; path?: string; version?: string; sha256?: string; checksumVerified?: boolean; error?: string }> {
  const a = api()
  if (a?.runtimeDownloadBinary) return a.runtimeDownloadBinary(kernel, version, proxyUrl)
  return { ok: false, error: PREVIEW_HINT }
}

/** 查询最新版本号：先取官方，取不到再退回内置默认并说明原因 */
export async function runtimeLatestVersions(proxyUrl?: string): Promise<{
  versions: Partial<Record<KernelType, string>>;
  errors: string[];
  fallback: Partial<Record<KernelType, string>>;
}> {
  const a = api()
  if (a?.runtimeLatestVersions) {
    try { return { ...(await a.runtimeLatestVersions(proxyUrl)), fallback: {} } }
    catch { /* 落到默认 */ }
  }
  return {
    versions: {}, errors: ['浏览器预览模式无法查询 GitHub'],
    fallback: { xray: '26.11.9', 'sing-box': '1.14.4', mihomo: '1.19.33' },
  }
}

export async function runtimePing(server: string, port: number): Promise<{ ok: boolean; ms: number | null; error?: string }> {
  const a = api()
  if (a?.runtimePing) return a.runtimePing(server, port)
  return { ok: false, ms: null, error: PREVIEW_HINT }
}

/** 节点真连测速：主进程起临时内核 + 真实下载，结果与进度经 runtime:event（type=speedtest）推送 */
export async function runtimeSpeedTest(
  nodes: UnifiedNode[],
  opts?: { concurrency?: number; durationMs?: number; maxBytes?: number; targetUrl?: string; timeoutMs?: number },
): Promise<{ ok: boolean; rows: import('../core/runtime/speedtest.js').SpeedTestRow[]; error?: string }> {
  const a = api()
  if (a?.runtimeSpeedTest) return a.runtimeSpeedTest(toPlain(nodes), toPlain(opts ?? {}))
  return { ok: false, rows: [], error: PREVIEW_HINT }
}

export async function runtimeSpeedTestCancel(): Promise<{ ok: boolean; error?: string }> {
  const a = api()
  if (a?.runtimeSpeedTestCancel) return a.runtimeSpeedTestCancel()
  return { ok: false, error: PREVIEW_HINT }
}

export async function runtimeOpenDir(kind: 'bin' | 'runtime'): Promise<string> {
  const a = api()
  if (a?.runtimeOpenDir) return a.runtimeOpenDir(kind)
  return ''
}

/** 预览将要落盘的完整内核配置（浏览器里也能用，纯计算，不接触系统） */
export async function runtimePreviewConfig(req: RuntimeStartRequest) {
  const a = api()
  if (a?.runtimePreviewConfig) {
    try { return await a.runtimePreviewConfig(toPlain(req)) } catch { /* 落到本地 */ }
  }
  const settings = mergeRuntimeSettings({ ...await runtimeSettings(), ...(req.settings ?? {}) })
  const kernel = (req.kernel ?? req.node?.kernel ?? 'xray') as KernelType
  return { ok: true, ...buildRuntimeConfig(req.node, kernel, settings, req.peers ?? [], req.routing) }
}

/* ==================== 实时遥测 ==================== */

export async function runtimeTelemetry(): Promise<TelemetrySnapshot> {
  const a = api()
  if (a?.runtimeTelemetry) { try { return await a.runtimeTelemetry() as TelemetrySnapshot } catch { /* 落到降级 */ } }
  return emptyTelemetry(null, '浏览器预览模式：实时遥测需要 Electron 桌面端运行内核后才有数据')
}

export async function runtimeCloseConnection(id: string): Promise<{ ok: boolean; error?: string }> {
  const a = api()
  if (a?.runtimeCloseConnection) return a.runtimeCloseConnection(id)
  return { ok: false, error: PREVIEW_HINT }
}

/**
 * 节点体检：主进程真实发起直连 / 经节点 HTTPS 请求，返回逐站结果与综合诊断。
 * 浏览器预览环境不允许跨域探测，明确拒绝而不是编造「通 / 不通」。
 */
export async function runtimeProbeSites(hosts: string[]): Promise<{ ok: boolean; report: ProbeReport | null; error?: string }> {
  const a = api()
  if (a?.runtimeProbeSites) {
    try { return { ok: true, report: await a.runtimeProbeSites(toPlain(hosts)) as ProbeReport } }
    catch (e) { return { ok: false, report: null, error: e instanceof Error ? e.message : String(e) } }
  }
  return { ok: false, report: null, error: PREVIEW_HINT }
}

/**
 * IP 归属地查询：主进程向免费归属地服务真实请求（带 30 天缓存）。
 * 浏览器预览环境明确拒绝，不编造归属地。
 */
export async function geoLookup(servers: string[]): Promise<{
  ok: boolean
  results: Record<string, { code?: string; error?: string; source?: string }>
  error?: string
}> {
  const a = api()
  if (a?.geoLookup) {
    try { return await a.geoLookup(servers) } catch (e) {
      return { ok: false, results: {}, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return { ok: false, results: {}, error: 'IP 归属地查询需要 Electron 主进程（当前为浏览器预览模式）' }
}

/** 屏幕取图结果：成功时只有 PNG dataURL，失败 / 取消都不编造内容 */
export interface ScreenShot {
  ok: boolean
  canceled?: boolean
  dataUrl?: string
  w?: number
  h?: number
  display?: string
  error?: string
}

/**
 * 框选屏幕区域取图：主进程弹全屏透明层（框内透明，背后二维码原样可见），
 * 拖完立即抓屏裁切。浏览器预览模式没有这个能力，明确拒绝而不是假装成功。
 */
export async function pickScreenRegion(): Promise<ScreenShot> {
  const a = api()
  if (!a?.qrPickRegion) return { ok: false, error: '屏幕框选需要桌面端（浏览器预览不支持）' }
  try { return await a.qrPickRegion() } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 整屏截图取图（主窗口会自动让开），用于「屏幕截图扫码」 */
export async function captureScreenShot(): Promise<ScreenShot> {
  const a = api()
  if (!a?.qrCaptureScreen) return { ok: false, error: '屏幕截图需要桌面端（浏览器预览不支持）' }
  try { return await a.qrCaptureScreen() } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 订阅主进程状态 / 内核日志 / 遥测推送；返回取消订阅函数 */export function onRuntimeEvent(cb: (payload: any) => void): () => void {
  const a = api()
  if (a?.onRuntimeEvent) return a.onRuntimeEvent(cb)
  return () => {}
}
