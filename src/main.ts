import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron'
import path from 'path'
import fs from 'node:fs'
import os from 'node:os'
import { importText, generateKernelConfig, protocolCoverage } from './core/hub/index.js'
import type { KernelType } from './core/hub/model.js'
import { RuntimeManager } from './main/runtime/manager.js'
import { SpeedTester } from './main/runtime/speedtester.js'
import { pickScreenRegion, captureScreen } from './main/qr-region.js'
import { buildRuntimeConfig } from './core/runtime/config-builder.js'
import { mergeRuntimeSettings } from './core/runtime/types.js'
import type { RuntimeMode, RuntimeSettings, RuntimeStartRequest } from './core/runtime/types.js'

/* 构建产物是 CommonJS（main.js），__dirname 由 Node 原生提供。 */

/* ---------------------------------------------------------------- 启动日志
 * 打包后双击闪退时，界面上的错误看不到，只能靠落盘日志定位。
 * 日志位置：%APPDATA%\万能代理客户端\logs\startup.log
 * 只记录启动阶段与致命异常，不记录节点/密码等内容。
 */
let logFile = ''
try {
  const logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  logFile = path.join(logDir, 'startup.log')
} catch { /* 日志失败不能影响启动 */ }

function log(message: string): void {
  if (!logFile) return
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`)
  } catch { /* ignore */ }
}

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err?.stack || err}`)
})
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
})

log(`--- app start --- electron=${process.versions.electron} node=${process.versions.node} argv=${process.argv.join(' ')}`)

let mainWindow: BrowserWindow | null = null

/**
 * 内核运行层实例。所有改动系统状态的操作都必须经过它，
 * 它负责保存快照、失败回滚、退出时恢复。
 */
const runtime = new RuntimeManager({
  userData: app.getPath('userData'),
  projectRoot: app.getAppPath(),
  send: (channel, payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload) },
})

/**
 * 节点真连测速器：给每个节点临时起一个独立内核实例，走代理真实下载，
 * 全程不碰系统代理，结束后清理进程与临时配置。
 */
const speedTester = new SpeedTester({
  userData: app.getPath('userData'),
  projectRoot: app.getAppPath(),
  send: (channel, payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload) },
  getSettings: () => runtime.getSettings(),
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    frame: false,              // custom title bar
    // 首帧底色跟随主题，避免白天模式启动时闪一下深蓝
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a2e' : '#f5f7fb',
    titleBarStyle: 'hidden',
    /** 任务栏 / 窗口切换器里带上版本号，排障时一眼能看出装的是哪版 */
    title: `万能代理客户端 v${app.getVersion()}`,
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '../electron-preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  /* 页面 title 会覆盖窗口 title，这里挡掉，保证任务栏始终显示「名称 + 版本」 */
  mainWindow.on('page-title-updated', e => e.preventDefault())

  if (process.env.VITE_DEV_SERVER_URL) {
    log(`loadURL ${process.env.VITE_DEV_SERVER_URL}`)
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    const indexPath = path.join(__dirname, '../index.html')
    log(`loadFile ${indexPath} exists=${fs.existsSync(indexPath)}`)
    mainWindow.loadFile(indexPath)
  }

  /* 白屏 / 加载失败必须留下线索，否则用户只能看到一片空白 */
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`did-fail-load code=${code} desc=${desc} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log(`render-process-gone reason=${details?.reason} exitCode=${details?.exitCode}`)
  })
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log(`renderer console(${level}): ${message}`)
  })
  mainWindow.webContents.on('did-finish-load', () => log('did-finish-load'))

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  console.log('[main] Electron ready · 创建窗口 · 内核运行层已就绪')
  log('app ready')
  try {
    createWindow()
    log(`window created · userData=${app.getPath('userData')}`)
  } catch (err) {
    log(`createWindow failed: ${(err as Error)?.stack || err}`)
    throw err
  }
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  // 先杀测速的临时内核，避免进程退出后留下孤儿进程
  try { speedTester.cancel() } catch { /* 忽略 */ }
  void runtime.dispose().catch(err => console.error('[runtime] 退出清理失败：', err)).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// --- IPC handlers ---

ipcMain.handle('get-app-path', (_evt, kind: string) => {
  const paths: Record<string, () => string> = {
    userData: () => app.getPath('userData'),
    temp: () => app.getPath('temp'),
    exe: () => app.getPath('exe'),
  }
  return paths[kind]?.() ?? ''
})

ipcMain.handle('open-external', (_evt, url: string) => {
  return shell.openExternal(url)
})

/**
 * 程序版本信息：全部取自运行时，不硬编码。
 * 界面上的版本号、Electron/Node 版本、构建时间、数据目录都以这里为准，
 * 避免打包升级后界面还显示旧版本号。
 */
ipcMain.handle('app-info', () => {
  let buildTime = ''
  try {
    // 打包后 app.getAppPath() 指向 .../resources/app.asar，用它（或 app 目录）的修改时间当构建时间
    buildTime = fs.statSync(app.getAppPath()).mtime.toISOString()
  } catch { /* 取不到就留空 */ }
  let packagedVersion = app.getVersion()
  try {
    if (!packagedVersion && !app.isPackaged) {
      const raw = fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')
      packagedVersion = String((JSON.parse(raw) as { version?: string }).version ?? '')
    }
  } catch { /* 忽略 */ }
  return {
    name: '万能代理客户端',
    version: packagedVersion,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osRelease: (() => {
      try { return `${os.type()} ${os.release()}` } catch { return '' }
    })(),
    packaged: app.isPackaged,
    buildTime,
    userData: app.getPath('userData'),
    exePath: app.getPath('exe'),
  }
})

ipcMain.handle('minimize-window', () => mainWindow?.minimize())
ipcMain.handle('maximize-window', () => {
  if (!mainWindow) return
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.handle('close-window', () => mainWindow?.close())

/* --------------------- 屏幕二维码取图（透明框选 / 整屏截图） ---------------------
 * Electron 默认不支持渲染层 getDisplayMedia，原来「框选屏幕区域」只会报 Not supported。
 * 改为主进程 desktopCapturer：框选时弹全屏透明层（框内全透明，背后二维码原样可见），
 * 拖完立即抓屏裁切，只回一张 PNG dataURL，不落盘、不上传、不执行二维码内容。
 */
ipcMain.handle('qr:pick-region', () => pickScreenRegion())
ipcMain.handle('qr:capture-screen', () => captureScreen(mainWindow))

/**
 * 界面主题：让 Electron 原生层（右键菜单、系统对话框、prefers-color-scheme）与界面一致。
 * 渲染层选「跟随系统」时设为 system，此时 matchMedia 反映真实系统设置。
 */
ipcMain.handle('set-theme-source', (_evt, mode: unknown) => {
  const source = mode === 'dark' || mode === 'light' || mode === 'system' ? mode : 'system'
  nativeTheme.themeSource = source
  return nativeTheme.shouldUseDarkColors
})

/* --------------------- 统一配置解析中心 IPC --------------------- */

/** 解析任意文本：分享链接 / 订阅内容 / Clash YAML / sing-box JSON / Xray JSON / WireGuard conf / 包装格式 */
ipcMain.handle('parse-config', (_evt, text: string, opts?: Record<string, unknown>) => {
  try {
    return importText(String(text ?? ''), (opts ?? {}) as any)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

/** 兼容旧调用名 */

/** 能力清单，供界面展示支持的协议 / 内核 */
ipcMain.handle('protocol-coverage', () => protocolCoverage())

/** 生成指定内核的配置对象（只生成，不写文件、不启动内核、不改系统代理） */
ipcMain.handle('generate-config', (_evt, nodes: unknown[], kernel: KernelType) => {
  try {
    return generateKernelConfig((nodes ?? []) as any, kernel)
  } catch (e) {
    return { kernel, config: {}, issues: [{ level: 'error', code: 'PARSE_ERROR', message: e instanceof Error ? e.message : String(e) }], unmapped: [] }
  }
})

/**
 * 订阅拉取：必须由用户在界面上显式触发。
 * 安全约束：仅 http/https、15s 超时、2MB 上限、只返回文本，不自动解析 / 不自动执行。
 */
ipcMain.handle('fetch-subscription', async (_evt, url: string) => {
  const target = String(url ?? '').trim()
  let parsed: URL
  try { parsed = new URL(target) } catch { return { ok: false, error: '订阅地址不是合法 URL' } }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: `仅允许 http/https 协议，收到 ${parsed.protocol}` }
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 15000)
  try {
    const resp = await fetch(target, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'universal-proxy-client/1.0', Accept: '*/*' },
    })
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` }
    const text = await resp.text()
    if (text.length > 2 * 1024 * 1024) return { ok: false, error: '订阅内容超过 2MB 上限，已拒绝' }
    return { ok: true, text, contentType: resp.headers.get('content-type') ?? '' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
})

/* --------------------- IP 归属地查询（geo:lookup） --------------------- */
/*
 * 需求：节点列表按 IP 显示代理国家图标。节点名里没写地区的（如「未知-SS-09」），
 * 只能查真实归属地——这里向免费归属地服务发起真实 HTTPS 查询：
 * - 不用任何本地地址段表去「推断」（那必然出错，等于编数据）
 * - 逐个尝试多个服务，单个 6s 超时，哪个通用哪个（粘性记忆，减少后续请求）
 * - 结果落盘 userData/geoip-cache.json，30 天内直接用缓存，不重复打扰对方服务
 * - 明确限制：单次最多 64 个、每条最长 253 字符，防滥用
 */
const GEO_PROVIDERS: { name: string; url: (h: string) => string; pick: (j: any) => string }[] = [
  { name: 'ip.sb', url: h => `https://api.ip.sb/geoip/${encodeURIComponent(h)}`, pick: j => String(j?.country_code ?? '') },
  { name: 'ipwho.is', url: h => `https://ipwho.is/${encodeURIComponent(h)}`, pick: j => (j?.success === false ? '' : String(j?.country_code ?? '')) },
  { name: 'ip-api.com', url: h => `http://ip-api.com/json/${encodeURIComponent(h)}?fields=status,countryCode`, pick: j => (j?.status === 'success' ? String(j?.countryCode ?? '') : '') },
]
let geoSticky = -1 // 上次成功的服务下标，优先复用

function geoCacheFile(): string {
  return path.join(app.getPath('userData'), 'geoip-cache.json')
}
function loadGeoCache(): Record<string, { code: string; at: number }> {
  try {
    const raw = JSON.parse(fs.readFileSync(geoCacheFile(), 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    const out: Record<string, { code: string; at: number }> = {}
    const now = Date.now()
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
      if (typeof k !== 'string' || !v || typeof v !== 'object') continue
      const code = typeof (v as any).code === 'string' ? (v as any).code : ''
      const at = typeof (v as any).at === 'number' ? (v as any).at : 0
      if (code && /^[A-Z]{2}$/.test(code) && now - at < 30 * 24 * 3600 * 1000) out[k] = { code, at }
    }
    return out
  } catch { return {} }
}
function saveGeoCache(cache: Record<string, { code: string; at: number }>): void {
  try { fs.writeFileSync(geoCacheFile(), JSON.stringify(cache, null, 2)) } catch { /* 缓存写失败不影响查询结果 */ }
}

async function geoQueryOne(host: string): Promise<{ code?: string; error?: string }> {
  const order = geoSticky >= 0
    ? [GEO_PROVIDERS[geoSticky], ...GEO_PROVIDERS.filter((_, i) => i !== geoSticky)]
    : GEO_PROVIDERS
  let lastError = '所有归属地服务都未能响应'
  for (const p of order) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 6000)
    try {
      const resp = await fetch(p.url(host), {
        signal: ac.signal,
        headers: { 'User-Agent': 'universal-proxy-client/1.0', Accept: 'application/json' },
      })
      if (!resp.ok) { lastError = `${p.name} HTTP ${resp.status}`; continue }
      const json: any = await resp.json()
      const code = p.pick(json).toUpperCase()
      if (/^[A-Z]{2}$/.test(code)) {
        geoSticky = GEO_PROVIDERS.indexOf(p)
        return { code }
      }
      lastError = `${p.name} 返回里没有有效的国家代码`
    } catch (e) {
      lastError = `${p.name} ${e instanceof Error ? (e.name === 'AbortError' ? '超时' : e.message) : '请求失败'}`
    } finally {
      clearTimeout(timer)
    }
  }
  return { error: lastError }
}

ipcMain.handle('geo:lookup', async (_evt, servers: unknown) => {
  if (!Array.isArray(servers)) return { ok: false, error: '参数必须是字符串数组', results: {} }
  const hosts = [...new Set(servers
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length <= 253))].slice(0, 64)
  if (!hosts.length) return { ok: true, results: {} }

  const cache = loadGeoCache()
  const results: Record<string, { code?: string; error?: string; source: string }> = {}
  let queried = 0
  for (const host of hosts) {
    const hit = cache[host]
    if (hit) { results[host] = { code: hit.code, source: '缓存' }; continue }
    const r = await geoQueryOne(host)
    queried++
    if (r.code) {
      cache[host] = { code: r.code, at: Date.now() }
      results[host] = { code: r.code, source: '真实查询' }
    } else {
      results[host] = { error: r.error, source: '查询失败' }
    }
    if (queried >= 1) await new Promise(res => setTimeout(res, 250)) // 轻微限速，别打爆免费服务
  }
  saveGeoCache(cache)
  return { ok: true, results, queried }
})

/* --------------------- 内核运行层 IPC --------------------- */
/*
 * 与解析层的区别：这里的操作会真正启动进程、写配置文件、修改系统代理。
 * 因此所有入口都必须由用户显式点击触发；preload 不提供自动调用能力。
 * 系统代理改动前保存快照，失败 / 断开 / 退出时按快照恢复。
 */

ipcMain.handle('runtime:status', () => runtime.getStatus())
ipcMain.handle('runtime:logs', () => runtime.getLogs())
ipcMain.handle('runtime:binaries', () => runtime.scan())
ipcMain.handle('runtime:settings', () => runtime.getSettings())

ipcMain.handle('runtime:update-settings', (_evt, patch: Partial<RuntimeSettings>) => {
  try { return { ok: true, settings: runtime.updateSettings(patch ?? {}) } }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
})

ipcMain.handle('runtime:set-mode', (_evt, mode: RuntimeMode) => {
  try { return { ok: true, settings: runtime.setMode(mode) } }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
})

/**
 * 运行层 IPC 兜底。
 *
 * 启动 / 断开 / 切换节点都会写配置、起进程、改系统代理。任何一处未预期异常如果让
 * IPC promise 直接 reject，渲染层只会看到「点了没反应」——2026-11-12 用户反馈的
 * 「切换节点失败」里就有一半属于这种静默失败。这里保证永远返回 { ok, status, error }。
 */
function guarded<A extends unknown[], T extends object>(
  label: string,
  fn: (...args: A) => Promise<T> | T,
) {
  return async (_evt: unknown, ...args: A): Promise<T | { ok: false; status: ReturnType<RuntimeManager['getStatus']>; error: string }> => {
    try {
      return await fn(...args)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(`${label}未捕获异常：${msg}`)
      return { ok: false, status: runtime.getStatus(), error: `${label}异常：${msg}（当前连接未受影响）` }
    }
  }
}

ipcMain.handle('runtime:start', guarded('启动', (req: RuntimeStartRequest) => runtime.start(req ?? ({} as RuntimeStartRequest))))
ipcMain.handle('runtime:stop', guarded('断开', () => runtime.stop()))
ipcMain.handle('runtime:switch-node', guarded('切换节点', (req: RuntimeStartRequest) => runtime.switchNode(req ?? ({} as RuntimeStartRequest))))

ipcMain.handle('runtime:ping', (_evt, server: string, port: number) => runtime.ping(String(server ?? ''), Number(port)))

/* 节点真连测速：每个节点临时起内核 + 真实下载；进度经 runtime:event（type=speedtest）推送 */
ipcMain.handle('runtime:speedtest', (_evt, nodes: unknown[], opts?: Record<string, unknown>) =>
  speedTester.run((Array.isArray(nodes) ? nodes : []) as any, (opts ?? {}) as any))
ipcMain.handle('runtime:speedtest-cancel', () => { speedTester.cancel(); return { ok: true } })

/* 实时遥测：只读统计 + 站点真实探测（探测必须由用户点击触发） */
ipcMain.handle('runtime:telemetry', () => runtime.getTelemetry())
ipcMain.handle('runtime:close-connection', guarded('关闭连接', (id: string) => runtime.closeConnection(String(id ?? ''))))
/** 节点体检：直连 / 经节点各发一次真实 HTTPS 请求，返回逐站结果 + 综合诊断 */
ipcMain.handle('runtime:probe-sites', async (_evt, hosts: string[]) => {
  // 这里刻意不吞异常：渲染层 api.ts 用 try/catch 把它翻译成 { ok:false, report:null, error }。
  // 如果改成返回一个「长得像报告」的对象，前端会把 r.report.diagnosis 读成 null 直接崩。
  try {
    return await runtime.probeSites(Array.isArray(hosts) ? hosts : [])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`节点体检异常：${msg}`)
    throw new Error(`检测异常：${msg}`)
  }
})

ipcMain.handle('runtime:open-dir', async (_evt, kind: 'bin' | 'runtime') => {
  const dir = kind === 'bin' ? await runtime.openBinDir() : await runtime.openRuntimeDir()
  await shell.openPath(dir)
  return dir
})

/* --------------------- 内核二进制下载（用户显式点击触发） --------------------- */

import { downloadKernel, fetchLatestVersions } from './main/runtime/downloader.js'
import type { KernelType as KernelTypeForDownload } from './core/hub/model.js'

/** 查询三内核最新版本号（GitHub API；任何一项失败都如实返回，不用旧缓存顶替） */
ipcMain.handle('runtime:latest-versions', (_evt, proxyUrl?: string) => fetchLatestVersions(proxyUrl || undefined))

/**
 * 下载并安装内核二进制。必须由用户在设置中心点击触发。
 * proxyUrl 可选（http://127.0.0.1:7897 这类本机代理），留空直连。
 * 进度通过 runtime:event 推送，落盘前先过校验。
 */
ipcMain.handle('runtime:download-binary', async (_evt, kernel: KernelTypeForDownload, version?: string, proxyUrl?: string) => {
  try {
    const binDir = await runtime.openBinDir()
    return await downloadKernel({
      kernel, version: version || undefined, binDir, proxyUrl: proxyUrl || undefined,
      send: p => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:event', { type: 'download', download: p }) },
    })
  } catch (e) {
    return { ok: false, kernel, error: e instanceof Error ? e.message : String(e) }
  }
})


/** 预览模式：只生成完整运行配置文本，不落盘、不启动、不改系统设置 */
ipcMain.handle('runtime:preview-config', (_evt, req: RuntimeStartRequest) => {
  try {
    const settings = mergeRuntimeSettings({ ...runtime.getSettings(), ...(req.settings ?? {}) })
    const kernel = (req.kernel ?? req.node?.kernel ?? 'xray') as KernelType
    const r = buildRuntimeConfig(req.node, kernel, settings, req.peers ?? [], req.routing)
    return { ok: true, ...r }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})
