import { contextBridge, ipcRenderer } from "electron"

/**
 * 渲染层可用的最小 API 面。
 *
 * 安全约定：
 * - 解析类 API 只返回"预览报告"，不自动写入节点、不自动执行配置。
 * - 订阅拉取、内核启动、系统代理改动都必须由用户在界面上显式点击触发。
 * - preload 不暴露任何 fs / child_process / 任意路径执行能力。
 */
export const electronAPI = {
  minimize: () => ipcRenderer.invoke("minimize-window"),
  maximize: () => ipcRenderer.invoke("maximize-window"),
  close: () => ipcRenderer.invoke("close-window"),
  getAppPath: (kind: string) => ipcRenderer.invoke("get-app-path", kind),
  /** 程序版本信息（版本号 / Electron / Node / 构建时间 / 数据目录），界面以它为准 */
  appInfo: () => ipcRenderer.invoke("app-info"),
  /** 同步界面主题到 Electron 原生层（dark / light / system） */
  setThemeSource: (mode: string) => ipcRenderer.invoke("set-theme-source", mode),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

  /** 统一配置解析中心：任意文本 → 导入预览报告 */
  parseConfig: (text: string, opts?: Record<string, unknown>) =>
    ipcRenderer.invoke("parse-config", text, opts ?? {}),
  /** 支持的协议 / 传输 / 配置格式清单 */
  protocolCoverage: () => ipcRenderer.invoke("protocol-coverage"),
  /** 生成三内核配置对象（只生成，不落盘、不启动） */
  generateConfig: (nodes: unknown[], kernel: string) =>
    ipcRenderer.invoke("generate-config", nodes, kernel),
  /** 显式拉取订阅 URL（仅返回文本，不自动解析） */
  fetchSubscription: (url: string) => ipcRenderer.invoke("fetch-subscription", url),

  /* ───────── 内核运行层（全部需要用户显式触发） ───────── */
  runtimeStatus: () => ipcRenderer.invoke("runtime:status"),
  runtimeLogs: () => ipcRenderer.invoke("runtime:logs"),
  runtimeBinaries: () => ipcRenderer.invoke("runtime:binaries"),
  runtimeSettings: () => ipcRenderer.invoke("runtime:settings"),
  runtimeUpdateSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke("runtime:update-settings", patch),
  runtimeSetMode: (mode: string) => ipcRenderer.invoke("runtime:set-mode", mode),
  runtimeStart: (req: Record<string, unknown>) => ipcRenderer.invoke("runtime:start", req),
  runtimeStop: () => ipcRenderer.invoke("runtime:stop"),
  runtimeSwitchNode: (req: Record<string, unknown>) => ipcRenderer.invoke("runtime:switch-node", req),
  runtimePing: (server: string, port: number) => ipcRenderer.invoke("runtime:ping", server, port),
  /** 节点真连测速：主进程为每个节点临时起内核并真实下载；进度经 runtime:event 推送 */
  runtimeSpeedTest: (nodes: unknown[], opts?: Record<string, unknown>) =>
    ipcRenderer.invoke("runtime:speedtest", nodes, opts ?? {}),
  runtimeSpeedTestCancel: () => ipcRenderer.invoke("runtime:speedtest-cancel"),
  runtimeOpenDir: (kind: "bin" | "runtime") => ipcRenderer.invoke("runtime:open-dir", kind),
  /** 内核二进制下载：必须由用户点击触发；进度经 runtime:event 推送 */
  runtimeDownloadBinary: (kernel: string, version?: string, proxyUrl?: string) =>
    ipcRenderer.invoke("runtime:download-binary", kernel, version, proxyUrl),
  runtimeLatestVersions: (proxyUrl?: string) => ipcRenderer.invoke("runtime:latest-versions", proxyUrl),
  runtimePreviewConfig: (req: Record<string, unknown>) => ipcRenderer.invoke("runtime:preview-config", req),
  runtimeTelemetry: () => ipcRenderer.invoke("runtime:telemetry"),
  runtimeCloseConnection: (id: string) => ipcRenderer.invoke("runtime:close-connection", id),
  /** 节点体检：真实 HTTPS 直连 + 经节点 CONNECT 隧道探测，返回 ProbeReport；只在用户点击后调用 */
  runtimeProbeSites: (hosts: string[]) => ipcRenderer.invoke("runtime:probe-sites", hosts),
  /** IP 归属地查询：主进程向免费归属地服务发起真实请求，带 30 天磁盘缓存 */
  geoLookup: (servers: string[]) => ipcRenderer.invoke("geo:lookup", servers),

  /* ───────── 屏幕二维码取图（主进程 desktopCapturer） ───────── */
  /** 弹出全屏透明框选层，框内透明可看见背后二维码；返回裁切后的 PNG dataURL */
  qrPickRegion: () => ipcRenderer.invoke("qr:pick-region"),
  /** 整屏截图（主窗口先让开），返回 PNG dataURL */
  qrCaptureScreen: () => ipcRenderer.invoke("qr:capture-screen"),

  /** 订阅主进程推送的运行状态 / 内核日志，返回取消订阅函数 */
  onRuntimeEvent: (callback: (payload: unknown) => void) => {
    const listener = (_evt: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on("runtime:event", listener as any)
    return () => ipcRenderer.removeListener("runtime:event", listener as any)
  },
}

contextBridge.exposeInMainWorld("electronAPI", electronAPI)
