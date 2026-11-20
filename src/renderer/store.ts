import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { Subscription } from '../types.js'
import type { ImportReport, KernelType, UnifiedNode } from '../core/hub/model.js'
import type { BinaryInventory, RuntimeLog, RuntimeSettings, RuntimeStatus } from '../core/runtime/types.js'
import { emptyStatus, mergeRuntimeSettings } from '../core/runtime/types.js'
import {
  emptyTelemetry, type ProbeReport, type ProbeResult, type TelemetrySnapshot,
} from '../core/runtime/telemetry.js'
import { cloneRoutingConfig, isLegacyDefaultRules, type RoutingConfig } from '../core/runtime/rules.js'
import { resolveKernelForNode } from '../core/hub/kernel.js'
import type { SpeedTestOptions, SpeedTestRow } from '../core/runtime/speedtest.js'
import { DEFAULT_SPEEDTEST_OPTIONS } from '../core/runtime/speedtest.js'
import * as runtimeApi from './api.js'
import type { KernelDownloadProgress } from './api.js'
import {
  THEME_LABELS, applyTheme, normalizeThemeMode, persistTheme, readStoredTheme,
  resolveTheme, systemPrefersDark, watchSystemTheme,
  type ResolvedTheme, type ThemeMode,
} from './theme.js'
import { regionCode } from './regions.js'

type TabKey = 'home' | 'nodes' | 'subscribe' | 'qrcode' | 'config' | 'rules' | 'monitor' | 'stats' | 'logs' | 'settings'

export interface LogEntry {
  id: string
  ts: number
  time: string
  level: 'info' | 'warn' | 'error' | 'success'
  module: string
  message: string
  detail?: string
}

export interface SubscriptionUpdateRecord {
  id: string
  ts: number
  subName: string
  ok: boolean
  added: number
  skipped: number
  failed: number
  message: string
  manual: boolean
}

/** 标准 Pinia 用法：在组件 setup 里 const store = useAppStore() */
export const useAppStore = defineStore('app', () => {
  /** 统一模型节点（真实数据） */
  const nodes = ref<UnifiedNode[]>([])
  const subscriptions = ref<Subscription[]>([])
  /** 用户选择的主题模式：黑夜 / 白天 / 跟随系统；实际生效值见 resolvedTheme */
  const theme = ref<ThemeMode>(readStoredTheme())
  const resolvedTheme = ref<ResolvedTheme>(resolveTheme(theme.value, systemPrefersDark()))
  let stopSystemThemeWatch: (() => void) | null = null
  const activeTab = ref<TabKey>('home')
  const lastReport = ref<ImportReport | null>(null)
  const logs = ref<LogEntry[]>([])
  /* 内核选择：持久化到 localStorage，重启客户端不丢（此前是内存态默认 xray，重启必回 xray） */
  const KERNEL_KEY = 'upc.kernel.v1'
  function loadKernel(): KernelType {
    const saved = localStorage.getItem(KERNEL_KEY)
    return saved === 'xray' || saved === 'sing-box' || saved === 'mihomo' ? saved : 'xray'
  }
  const kernel = ref<KernelType>(loadKernel())
  watch(kernel, k => {
    try { localStorage.setItem(KERNEL_KEY, k) } catch { /* 存储不可用时本次会话仍有效 */ }
  })

  /* ───────── 本地持久化：节点与订阅刷新后不丢（自动更新的前提） ───────── */
  const DATA_KEY = 'upc.data.v1'
  /** 只认结构完整的节点。UI 直接读 n.issues.some / n.kernels.includes / n.extras，
   *  旧版本或手工改坏的缓存里若缺这些字段，首页 computed 会抛错导致整页白屏。
   *  与 geo 缓存、首页布局缓存一样做字段级校验，脏节点宁可丢弃也不带病启动。 */
  function validCachedNode(n: unknown): n is UnifiedNode {
    if (!n || typeof n !== 'object') return false
    const o = n as Record<string, unknown>
    return typeof o.id === 'string' && typeof o.name === 'string'
      && typeof o.protocol === 'string' && typeof o.server === 'string'
      && typeof o.port === 'number' && Number.isFinite(o.port)
      && Array.isArray(o.issues) && typeof o.lossless === 'boolean'
      && Array.isArray(o.kernels) && Array.isArray(o.extras)
      && typeof o.raw === 'string' && typeof o.source === 'string'
  }
  try {
    const raw = localStorage.getItem(DATA_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as { nodes?: unknown; subscriptions?: unknown }
      if (Array.isArray(saved.nodes)) {
        const kept = saved.nodes.filter(validCachedNode)
        if (kept.length !== saved.nodes.length) {
          console.warn(`[store] 本地缓存有 ${saved.nodes.length - kept.length} 个结构不完整的节点，已跳过以防界面崩溃`)
        }
        nodes.value = kept
      }
      if (Array.isArray(saved.subscriptions)) {
        const subs = saved.subscriptions.filter((s: unknown): s is Subscription =>
          !!s && typeof s === 'object'
          && typeof (s as Subscription).id === 'string'
          && typeof (s as Subscription).url === 'string'
          && Array.isArray((s as Subscription).proxies))
        subscriptions.value = subs
      }
    }
  } catch { /* 数据损坏 / 存储不可用时忽略，不阻断启动 */ }
  watch([nodes, subscriptions], () => {
    try { localStorage.setItem(DATA_KEY, JSON.stringify({ nodes: nodes.value, subscriptions: subscriptions.value })) }
    catch { /* 存储不可用不影响本次会话 */ }
  }, { deep: true })

  /* ───────── 内核运行层（真实状态，与下方演示指标严格区分） ───────── */
  const runtime = ref<RuntimeStatus>(emptyStatus(mergeRuntimeSettings(), !runtimeApi.runtimeAvailable()))
  const runtimeLogs = ref<RuntimeLog[]>([])
  const binaries = ref<BinaryInventory>({ binDir: '', platform: '', items: [] })
  const runtimeBusy = ref(false)
  const runtimePreview = ref<{ ok: boolean; text?: string; filename?: string; issues?: unknown[]; error?: string } | null>(null)
  /** 内核真实遥测：无任何模拟数据，未连接 / 不支持时显示具体原因 */
  const telemetry = ref<TelemetrySnapshot>(emptyTelemetry())
  /** 程序版本信息（版本号 / Electron / Node / 构建时间 / 数据目录），全部取自主进程 */
  const appInfo = ref<runtimeApi.AppInfo>({
    name: '万能代理客户端', version: '—', electron: '—', chrome: '—', node: '—', v8: '—',
    platform: '—', arch: '—', osRelease: '—', packaged: false, buildTime: '', userData: '', exePath: '',
  })

  async function loadAppInfo() {
    appInfo.value = await runtimeApi.appInfo()
  }

  /** 界面上的版本号，如 v1.1.0；浏览器预览时为 — */
  const appVersion = computed(() => (appInfo.value.version && appInfo.value.version !== '—' ? `v${appInfo.value.version}` : '—'))
  const siteProbes = ref<ProbeResult[]>([])
  /** 最近一次节点体检的完整报告（含综合诊断）；未检测/失败时为 null */
  const probeReport = ref<ProbeReport | null>(null)
  const probeError = ref('')
  const probeBusy = ref(false)
  /** 内核二进制下载进度（按内核记录；完成后保留最后一次结果，出错时显示原因） */
  const downloads = ref<Partial<Record<KernelType, KernelDownloadProgress>>>({})
  const downloadBusy = ref<KernelType | null>(null)
  /** 各内核最新版本号（GitHub 实查；失败时回退内置默认并注明） */
  const latestVersions = ref<Partial<Record<KernelType, string>>>({})

  /* ───────── 节点真连测速（每个节点临时起内核 + 走代理真实下载） ───────── */
  /** 按节点 id 记录测速结果；未测的节点不在表里，界面显示「未测」而不是 0 */
  const speedRows = ref<Record<string, SpeedTestRow>>({})
  const speedBusy = ref(false)
  /** 测速目标（白名单里的 url）与并发数，用户可改 */
  const speedTarget = ref<string>(DEFAULT_SPEEDTEST_OPTIONS.targetUrl)
  const speedConcurrency = ref<number>(DEFAULT_SPEEDTEST_OPTIONS.concurrency)
  /** 首页快捷操作指定的二维码起始模式（camera / file / clipboard），面板挂载后消费一次 */
  const qrMode = ref<string | null>(null)
  /** 最近一次节点切换 / 连接失败的原因；带时间戳保证连续两次相同错误也会重新弹提示 */
  const lastRuntimeError = ref<{ title: string; message: string; at: number } | null>(null)

  /* ───────── 用户自定义路由规则（持久化，三内核下发前逐条校验） ───────── */
  const ROUTING_KEY = 'upc.routing.v1'
  function loadRouting(): RoutingConfig {
    try {
      const raw = localStorage.getItem(ROUTING_KEY)
      if (raw) {
        const parsed = cloneRoutingConfig(JSON.parse(raw) as Partial<RoutingConfig>)
        // 1.1.x 用户存的是旧默认三条（MATCH→PROXY 兜底会把国内流量也绕到节点）。
        // 用户从未自定义过规则时，升级到带国内直连的新默认集；改过一条都原样保留。
        if (parsed.defaultAction === 'PROXY' && isLegacyDefaultRules(parsed.rules)) {
          log('info', '[rules]', '检测到 1.1.x 旧默认规则集，已升级为含国内直连的新默认规则')
          return cloneRoutingConfig()
        }
        return parsed
      }
    } catch { /* 首次启动 / 存储不可用，用默认规则 */ }
    return cloneRoutingConfig()
  }
  const routingConfig = ref<RoutingConfig>(loadRouting())
  function saveRouting(cfg: RoutingConfig) {
    routingConfig.value = cloneRoutingConfig(cfg)
    try { localStorage.setItem(ROUTING_KEY, JSON.stringify(routingConfig.value)) }
    catch { log('warn', '[rules]', '规则未能写入本地存储，本次会话仍然有效') }
    log('info', '[rules]', `路由规则已保存：${routingConfig.value.rules.filter(r => r.enabled).length} 条启用，默认动作 ${routingConfig.value.defaultAction}`)
  }
  let eventUnsub: (() => void) | null = null

  const fingerprints = computed(() => nodes.value.map(n => n.fingerprint))
  const problemCount = computed(() => nodes.value.filter(n => n.issues.some(i => i.level === 'error')).length)
  const lossyCount = computed(() => nodes.value.filter(n => !n.lossless).length)

  function log(level: LogEntry['level'], module: string, message: string, detail?: string) {
    const now = new Date()
    logs.value.unshift({
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: now.getTime(),
      time: now.toLocaleTimeString('zh-CN', { hour12: false }),
      level, module, message, detail,
    })
    if (logs.value.length > 500) logs.value.length = 500
  }

  /** 只安装一次主进程事件订阅（状态推送 + 内核日志） */
  function installRuntimeEvents() {
    if (eventUnsub) return
    eventUnsub = runtimeApi.onRuntimeEvent(payload => {
      const p = payload as any
      if (!p) return
      if (p.type === 'status' && p.status) {
        const s = p.status as RuntimeStatus
        const prevState = runtime.value.state
        runtime.value = s
        /* 崩溃退出 / 自动重启失败只会从这里冒出来（connect / disconnect / switchNode 自己已经
           记过 lastRuntimeError）。用时间戳去重，保证同一件事只弹一次 toast，而不是弹两次。 */
        if (s.state === 'error' && s.lastError && prevState !== 'error') {
          const now = Date.now()
          if (!lastRuntimeError.value || now - lastRuntimeError.value.at > 1500) {
            lastRuntimeError.value = { title: '内核异常', message: s.lastError, at: now }
          }
        }
      }
      if (p.type === 'telemetry' && p.snapshot) telemetry.value = p.snapshot as TelemetrySnapshot
      if (p.type === 'download' && p.download) {
        const d = p.download as KernelDownloadProgress
        downloads.value = { ...downloads.value, [d.kernel]: d }
        if (d.phase === 'done' || d.phase === 'error') {
          if (d.phase === 'error') log('error', `[download/${d.kernel}]`, d.message)
          if (downloadBusy.value === d.kernel) downloadBusy.value = null
          if (d.phase === 'done') void refreshRuntime()
        }
      }
      if (p.type === 'speedtest' && p.row) {
        const row = p.row as SpeedTestRow
        speedRows.value = { ...speedRows.value, [row.id]: row }
        if (row.phase === 'done') {
          log('success', '[speedtest]', `${row.name}：握手 ${row.latencyMs ?? '—'} ms · 首字节 ${row.ttfbMs ?? '—'} ms · ${row.mbps !== null ? row.mbps.toFixed(2) + ' Mbps' : '带宽未测出'}`)
        } else if (row.phase === 'error' || row.phase === 'cancelled') {
          log(row.phase === 'error' ? 'warn' : 'info', '[speedtest]', `${row.name}：${row.phase === 'error' ? '不可用' : '已取消'}${row.error ? `（${row.error}）` : ''}`)
        }
      }
      if (p.type === 'log' && p.log) {
        const l = p.log as RuntimeLog
        runtimeLogs.value.push(l)
        if (runtimeLogs.value.length > 500) runtimeLogs.value.splice(0, runtimeLogs.value.length - 500)
        const level: LogEntry['level'] = l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'info'
        log(level, `[kernel/${l.source}]`, l.line)
      }
    })
    void refreshRuntime()
  }

  async function refreshRuntime() {
    try {
      const [s, b, l, t] = await Promise.all([
        runtimeApi.runtimeStatus(), runtimeApi.runtimeBinaries(), runtimeApi.runtimeLogs(),
        runtimeApi.runtimeTelemetry(),
      ])
      runtime.value = s
      binaries.value = b
      runtimeLogs.value = l
      telemetry.value = t
    } catch (e) {
      log('error', '[runtime]', `读取运行状态失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 用户点击「开始连接」才会调用：真正启动内核 */
  async function connect(node: UnifiedNode, peers: UnifiedNode[] = []) {
    if (runtimeBusy.value) return false
    runtimeBusy.value = true
    try {
      // 用户显式选择的内核优先；节点不支持该内核时才回落到体检推荐
      // （如 sing-box 专用节点选不了 xray）。此前 node.kernel 恒定覆盖手动选择。
      const targetKernel = resolveKernelForNode(node, kernel.value)
      const r = await runtimeApi.runtimeStart({ node, peers, kernel: targetKernel, routing: routingConfig.value })
      runtime.value = r.status
      if (r.ok) {
        kernel.value = r.status.kernel ?? targetKernel
        log('success', '[runtime]', `内核已启动：${node.name} · ${r.status.kernel} · PID ${r.status.pid}`)
      } else {
        log('error', '[runtime]', `连接失败：${r.error ?? '未知原因'}`)
        for (const b of r.blockers ?? []) log('error', '[runtime/blocker]', b)
        lastRuntimeError.value = { title: '连接失败', message: r.error ?? '未知原因', at: Date.now() }
      }
      await refreshRuntime()
      return r.ok
    } catch (e) {
      // IPC 本身异常（主进程未响应 / 参数无法序列化）时给出可读提示，而不是静默失败
      const message = e instanceof Error ? e.message : String(e)
      log('error', '[runtime]', `连接异常：${message}`)
      lastRuntimeError.value = { title: '连接失败', message, at: Date.now() }
      return false
    } finally { runtimeBusy.value = false }
  }

  /**
   * 与目标节点同内核、可作为热切换备选的其它节点。
   * 节点页 / 测速页 / 仪表盘原先各自写了一遍过滤条件，其中两处用 node.kernel、
   * 两处用界面当前选中的 kernel，导致同一操作挑出的备选集不一致；统一到这里。
   */
  function peersFor(node: UnifiedNode, kernelOverride?: KernelType): UnifiedNode[] {
    const k = kernelOverride ?? node.kernel ?? kernel.value
    return nodes.value.filter(n => n.id !== node.id && n.kernels.includes(k))
  }

  /**
   * 连接指定节点（节点页 / 测速页 / 仪表盘节点行共用）。
   * 运行中走零断网热切换，未连接则直接启动；已是当前节点时不重复操作。
   */
  async function activateNode(node: UnifiedNode): Promise<{ ok: boolean; already: boolean }> {
    if (runtimeBusy.value) return { ok: false, already: false }
    if (runtime.value.state === 'running') {
      if (runtime.value.node?.id === node.id) {
        log('warn', '[runtime]', `${node.name} 已是当前节点`)
        return { ok: false, already: true }
      }
      return { ok: await switchNode(node, peersFor(node)), already: false }
    }
    // 仅当用户当前选的内核不被该节点支持时才切到体检推荐，尊重手动选择
    if (!node.kernels.includes(kernel.value)) kernel.value = node.kernel ?? kernel.value
    return { ok: await connect(node, peersFor(node)), already: false }
  }

  /**
   * 一键连接 / 断开（首页大圆按钮与监控空表按钮共用）。
   * 之前 App.vue 与 DashboardHero.vue 各写了一份同样的「有节点就连接、没节点就引导导入」，
   * 差异只在没节点时跳哪个页面；统一收在这里，页面只负责跳转。
   */
  async function toggleConnection(): Promise<{ action: 'disconnect' | 'connect' | 'no-nodes'; ok: boolean }> {
    if (runtimeBusy.value) return { action: 'connect', ok: false }
    if (runtime.value.state === 'running') return { action: 'disconnect', ok: await disconnect() }
    if (!nodes.value.length) return { action: 'no-nodes', ok: false }
    const node = nodes.value.find(n => n.id === runtime.value.node?.id) ?? nodes.value[0]
    return { action: 'connect', ok: await connect(node, peersFor(node, kernel.value)) }
  }

  /** 用户点击「断开连接」：停止内核并按快照恢复系统代理 */
  async function disconnect() {
    if (runtimeBusy.value) return false
    runtimeBusy.value = true
    try {
      const r = await runtimeApi.runtimeStop()
      runtime.value = r.status
      log(r.ok ? 'success' : 'error', '[runtime]', r.ok ? '已断开，系统代理已按快照恢复' : `断开失败：${r.error}`)
      if (!r.ok) lastRuntimeError.value = { title: '断开失败', message: r.error ?? '未知原因', at: Date.now() }
      await refreshRuntime()
      return r.ok
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log('error', '[runtime]', `断开异常：${message}`)
      lastRuntimeError.value = { title: '断开失败', message, at: Date.now() }
      return false
    } finally { runtimeBusy.value = false }
  }

  /**
   * 运行中热切换节点：杀旧进程 → 新配置 → 新进程 → 健康检查；
   * 新节点起不来自动回退旧节点，都不行才完整回滚（恢复系统代理）。
   */
  async function switchNode(node: UnifiedNode, peers: UnifiedNode[] = []) {
    if (runtimeBusy.value) return false
    runtimeBusy.value = true
    try {
      const r = await runtimeApi.runtimeSwitchNode({
        node, peers, kernel: resolveKernelForNode(node, kernel.value), routing: routingConfig.value,
      })
      runtime.value = r.status
      if (r.ok) {
        // 换核切换（如 xray → sing-box）后必须回写，否则下一次连接 / peers 过滤还按旧内核走
        kernel.value = r.status.kernel ?? kernel.value
        log('success', '[runtime]', `已热切换到 ${node.name}（${r.status.kernel} · PID ${r.status.pid}），系统代理未中断`)
      } else if (r.reverted) log('warn', '[runtime]', `切换失败，已恢复原节点：${r.error}`)
      else log('error', '[runtime]', `切换失败：${r.error}`)
      // 切换失败以前只在日志页留一行，界面上点了像没反应；这里主动弹 toast 给出确切原因
      if (!r.ok) lastRuntimeError.value = { title: '节点切换失败', message: r.error ?? '未知原因', at: Date.now() }
      await refreshRuntime()
      return r.ok
    } catch (e) {
      // 第二道防线：主进程已经保证不 reject，这里再兜一次，避免任何异常变成「点了没反应」
      const message = e instanceof Error ? e.message : String(e)
      log('error', '[runtime]', `切换异常：${message}`)
      lastRuntimeError.value = { title: '节点切换失败', message, at: Date.now() }
      return false
    } finally { runtimeBusy.value = false }
  }

  /** 一键下载内核二进制（用户在设置中心点击）；进度经 downloads 状态实时展示 */
  async function downloadKernelBinary(kernel: KernelType, version?: string, proxyUrl?: string) {
    if (downloadBusy.value) return { ok: false, error: `正在下载 ${downloadBusy.value}，请稍候` }
    downloadBusy.value = kernel
    try {
      log('info', `[download/${kernel}]`, `开始下载${version ? ` v${version}` : ''}${proxyUrl ? `（经代理 ${proxyUrl}）` : '（直连）'}`)
      const r = await runtimeApi.runtimeDownloadBinary(kernel, version, proxyUrl?.trim() || undefined)
      if (r.ok) {
        log('success', `[download/${kernel}]`,
          `v${r.version} 已安装到 ${r.path}${r.checksumVerified ? '（官方 SHA-256 校验通过）' : '（官方未提供校验文件，本地 SHA-256：' + (r.sha256 ?? '').slice(0, 16) + '…）'}`)
      } else {
        log('error', `[download/${kernel}]`, `下载失败：${r.error}`)
      }
      await refreshRuntime()
      return r
    } finally { downloadBusy.value = null }
  }

  /** 查询最新版本号；GitHub 不可达时回退内置默认（如实注明） */
  async function refreshLatestVersions(proxyUrl?: string) {
    const r = await runtimeApi.runtimeLatestVersions(proxyUrl?.trim() || undefined)
    const merged: Partial<Record<KernelType, string>> = { ...r.fallback, ...r.versions }
    latestVersions.value = merged
    for (const e of r.errors) log('warn', '[download]', `${e}（已回退内置默认版本号）`)
    return merged
  }

  async function setRuntimeMode(mode: RuntimeStatus['mode']) {
    const r = await runtimeApi.runtimeSetMode(mode)
    if (r.ok && r.settings) runtime.value.settings = r.settings
    else log('error', '[runtime]', `切换运行模式失败：${r.error}`)
    return r
  }

  async function updateRuntimeSettings(patch: Partial<RuntimeSettings>) {
    const r = await runtimeApi.runtimeUpdateSettings(patch)
    if (r.ok && r.settings) runtime.value.settings = r.settings
    else log('error', '[runtime]', `保存运行设置失败：${r.error}`)
    return r
  }

  /** 只生成将要落盘的完整配置文本，不启动、不改系统 */
  async function previewRuntimeConfig(node: UnifiedNode, peers: UnifiedNode[] = []) {
    const r = await runtimeApi.runtimePreviewConfig({ node, peers, kernel: kernel.value, routing: routingConfig.value }) as any
    runtimePreview.value = r?.ok
      ? { ok: true, text: r.text, filename: r.filename, issues: r.issues }
      : { ok: false, error: r?.error ?? '生成失败' }
    return runtimePreview.value
  }

  /** 真实 TCP 延迟，替代节点页的随机数字 */
  async function pingNode(node: UnifiedNode) {
    return runtimeApi.runtimePing(node.server, node.port)
  }

  /**
   * 节点真连测速：主进程给每个节点临时起内核、走代理真实下载。
   * 只测用户点选（或全选）的节点；没有节点时明确提示，不假装成功。
   */
  async function startSpeedTest(targets: UnifiedNode[], opts: SpeedTestOptions = {}) {
    if (speedBusy.value) return { ok: false, rows: [], error: '测速已在进行中' }
    if (!targets.length) {
      log('warn', '[speedtest]', '没有选中任何节点')
      return { ok: false, rows: [], error: '请先选择要测速的节点' }
    }
    speedBusy.value = true
    // 先清空目标节点的旧结果，避免把上一轮的速度当成这一轮的
    const next = { ...speedRows.value }
    for (const n of targets) delete next[n.id]
    speedRows.value = next
    log('info', '[speedtest]', `开始真连测速：${targets.length} 个节点，并发 ${opts.concurrency ?? speedConcurrency.value}，目标 ${opts.targetUrl ?? speedTarget.value}`)
    try {
      const r = await runtimeApi.runtimeSpeedTest(targets, {
        concurrency: opts.concurrency ?? speedConcurrency.value,
        targetUrl: opts.targetUrl ?? speedTarget.value,
        ...opts,
      })
      if (!r.ok) log('error', '[speedtest]', `测速未能开始：${r.error ?? '未知原因'}`)
      else {
        const okCount = r.rows.filter(x => x.phase === 'done' && (x.mbps ?? 0) > 0).length
        log('info', '[speedtest]', `测速完成：${r.rows.length} 个节点，其中 ${okCount} 个测出带宽`)
      }
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('error', '[speedtest]', `测速失败：${msg}`)
      return { ok: false, rows: [], error: msg }
    } finally {
      speedBusy.value = false
    }
  }

  async function cancelSpeedTest() {
    const r = await runtimeApi.runtimeSpeedTestCancel()
    if (r.ok) log('info', '[speedtest]', '已请求取消测速，正在清理临时内核…')
    else log('warn', '[speedtest]', `取消失败：${r.error}`)
    return r
  }

  /**
   * 用户点「开始真实检测」才发请求：每个站点直连 + 经节点各一次真实 HTTPS 请求。
   * 绝不预填延迟；失败时保留旧结果但清空诊断，并明确写日志。
   */
  async function probeSites(hosts: string[]) {
    if (probeBusy.value) return
    probeBusy.value = true
    probeError.value = ''
    try {
      const r = await runtimeApi.runtimeProbeSites(hosts)
      if (r.ok && r.report) {
        probeReport.value = r.report
        siteProbes.value = r.report.results
        const d = r.report.diagnosis
        log(d.level === 'bad' ? 'warn' : 'info', '[probe]',
          `节点体检完成：${d.title}｜${d.summary}（${r.report.results.length} 个站点，直连 / 经节点各一次真实请求）`)
      } else {
        probeReport.value = null
        probeError.value = r.error ?? '检测失败，未拿到结果'
        log('error', '[probe]', `节点体检不可用：${probeError.value}`)
      }
    } catch (e) {
      probeReport.value = null
      probeError.value = e instanceof Error ? e.message : String(e)
      log('error', '[probe]', `节点体检异常：${probeError.value}`)
    } finally { probeBusy.value = false }
  }

  async function closeConnection(id: string) {
    const r = await runtimeApi.runtimeCloseConnection(id)
    if (r.ok) {
      telemetry.value.connections = telemetry.value.connections.filter(c => c.id !== id)
      telemetry.value.activeConnections = telemetry.value.connections.length
      log('info', '[connection]', `已请求内核关闭连接 ${id}`)
    } else log('error', '[connection]', `关闭连接失败：${r.error}`)
    return r
  }

  /** 记录一次导入报告（仅预览，不写入节点） */
  function recordReport(report: ImportReport, sourceLabel = '配置导入') {
    lastReport.value = report
    log('info', '[hub/format]', `${sourceLabel} · ${report.formatLabel}：识别 ${report.stats.parsed} 个节点，失败 ${report.stats.failed}，重复 ${report.stats.duplicates}，警告 ${report.stats.warnings}`)
    for (const r of report.rejected.slice(0, 30)) log('error', '[parse/error]', r.reason, r.raw?.slice(0, 200))
    for (const i of report.issues.filter(x => x.level !== 'info').slice(0, 30)) {
      log(i.level === 'error' ? 'error' : 'warn', `[hub/${i.code}]`, i.message)
    }
    for (const n of report.nodes) {
      for (const i of n.issues.filter(x => x.level === 'error')) {
        log('error', '[field/missing]', `${n.name}：${i.message}`)
      }
      if (!n.lossless) log('warn', '[field/unmapped]', `${n.name} 有 ${Object.keys(n.extras).length} 个未映射字段，原值已保留：${Object.keys(n.extras).join('、')}`)
    }
  }

  /** 用户确认后才调用：写入节点列表 */
  function addNodes(items: UnifiedNode[], opts: { overwrite?: boolean } = {}) {
    const map = new Map(nodes.value.map(n => [n.fingerprint, n]))
    let added = 0, replaced = 0, skipped = 0
    for (const n of items) {
      if (map.has(n.fingerprint)) {
        if (opts.overwrite) { map.set(n.fingerprint, n); replaced++ }
        else skipped++
      } else { map.set(n.fingerprint, n); added++ }
    }
    nodes.value = [...map.values()]
    log('success', '[store/import]', `确认导入完成：新增 ${added}，覆盖 ${replaced}，跳过重复 ${skipped}；当前共 ${nodes.value.length} 个节点`)
    return { added, replaced, skipped }
  }

  /** 订阅更新：按指纹合并，默认不覆盖已有节点 */
  function mergeSubscription(sub: Subscription, incoming: UnifiedNode[], opts: { overwrite?: boolean } = {}) {
    const result = addNodes(incoming, opts)
    const idx = subscriptions.value.findIndex(s => s.id === sub.id)
    const updated: Subscription = { ...sub, updatedAt: Date.now(), proxies: [...incoming] as any }
    if (idx >= 0) subscriptions.value[idx] = updated
    else subscriptions.value.push(updated)
    log('success', '[subscription]', `订阅「${sub.name}」已更新：新增 ${result.added}，重复 ${result.skipped}`, sub.url)
    return result
  }

  /* ───────── 订阅定时自动更新（默认关闭，需用户显式开启） ───────── */
  const AUTO_KEY = 'upc.subAuto.v1'
  const autoUpdateEnabled = ref(false)
  const autoUpdateHours = ref(6)
  const updateHistory = ref<SubscriptionUpdateRecord[]>([])
  let autoTimer: ReturnType<typeof setInterval> | null = null

  try {
    const raw = localStorage.getItem(AUTO_KEY)
    if (raw) {
      const s = JSON.parse(raw) as { enabled?: boolean; hours?: number }
      autoUpdateEnabled.value = s.enabled === true
      if ([1, 3, 6, 12, 24].includes(Number(s.hours))) autoUpdateHours.value = Number(s.hours)
    }
  } catch { /* 忽略损坏的配置 */ }

  function persistAuto() {
    try { localStorage.setItem(AUTO_KEY, JSON.stringify({ enabled: autoUpdateEnabled.value, hours: autoUpdateHours.value })) }
    catch { /* 存储不可用不影响本次会话 */ }
  }

  function pushUpdate(rec: Omit<SubscriptionUpdateRecord, 'id' | 'ts'>) {
    updateHistory.value.unshift({ ...rec, id: crypto.randomUUID(), ts: Date.now() })
    if (updateHistory.value.length > 50) updateHistory.value.length = 50
  }

  function autoBlocker(): string | null {
    if (!runtimeApi.runtimeAvailable()) return '浏览器预览模式无法后台拉取订阅（跨域限制），请在 Electron 桌面端使用'
    if (!subscriptions.value.length) return '尚未登记任何订阅'
    return null
  }

  /**
   * 自动 / 批量更新单个订阅：拉取 → 解析 → 按指纹去重合并。
   * 这条链路不弹预览（用户开启自动更新即已授权），但每一次结果都会写入更新记录与运行日志；
   * 手动「更新」按钮仍走 SubscribePanel 的「预览 → 确认」链路。
   */
  async function updateSubscription(sub: Subscription, manual = true) {
    log('info', '[network]', `${manual ? '用户点击' : '定时器'}拉取订阅「${sub.name}」`, sub.url)
    try {
      const r = await runtimeApi.fetchSubscription(sub.url)
      if (!r.ok) {
        const message = `拉取失败：${r.error}`
        pushUpdate({ subName: sub.name, ok: false, added: 0, skipped: 0, failed: 0, message, manual })
        log('error', '[subscription]', `订阅「${sub.name}」${message}`)
        return { ok: false, error: r.error }
      }
      const rep = await runtimeApi.parseConfig(r.text ?? '', {
        source: `subscription:${sub.url}`, existingFingerprints: [...fingerprints.value],
      })
      recordReport(rep, `订阅更新 ${sub.name}`)
      const result = mergeSubscription(sub, rep.nodes)
      const message = `识别 ${rep.stats.parsed} 个节点 · 新增 ${result.added} · 重复 ${result.skipped} · 解析失败 ${rep.stats.failed}`
      pushUpdate({ subName: sub.name, ok: true, added: result.added, skipped: result.skipped, failed: rep.stats.failed, message, manual })
      return { ok: true, ...result, report: rep }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      pushUpdate({ subName: sub.name, ok: false, added: 0, skipped: 0, failed: 0, message, manual })
      log('error', '[subscription]', `订阅「${sub.name}」更新异常：${message}`)
      return { ok: false, error: message }
    }
  }

  /** force=true 立即全部更新；force=false 只处理到期的订阅（定时器用） */
  let autoUpdating = false
  async function updateAllSubscriptions(force = true) {
    const blocker = autoBlocker()
    if (blocker) { if (force) log('warn', '[subscription]', blocker); return { ok: false, error: blocker, count: 0 } }
    // 定时器每分钟触发一次，而一轮更新可能因为订阅站慢跑几十秒。
    // 没有这把锁时两轮会叠起来并发拉同一个订阅：重复写节点、重复记更新记录、
    // 而且「新增/重复」计数会互相污染。
    if (autoUpdating) return { ok: true, count: 0, error: '' }
    autoUpdating = true
    try {
      const now = Date.now()
      const due = force ? [...subscriptions.value] : subscriptions.value.filter(s =>
        !s.updatedAt || now - (s.updatedAt ?? 0) >= autoUpdateHours.value * 3600 * 1000)
      if (!due.length) return { ok: true, count: 0, error: '' }
      for (const s of due) await updateSubscription(s, force)
      return { ok: true, count: due.length, error: '' }
    } finally { autoUpdating = false }
  }

  function setAutoUpdate(enabled: boolean, hours?: number) {
    if (hours && [1, 3, 6, 12, 24].includes(hours)) autoUpdateHours.value = hours
    stopAutoUpdate()
    autoUpdateEnabled.value = enabled
    persistAuto()
    if (enabled) {
      const blocker = autoBlocker()
      if (blocker) {
        autoUpdateEnabled.value = false
        persistAuto()
        log('warn', '[subscription]', `自动更新未能开启：${blocker}`)
        return { ok: false, error: blocker }
      }
      autoTimer = setInterval(() => { void updateAllSubscriptions(false) }, 60_000)
      log('info', '[subscription]', `自动更新已开启：每 ${autoUpdateHours.value} 小时检查到期订阅（每分钟检查一次）`)
    } else log('info', '[subscription]', '自动更新已关闭，不会再后台联网')
    return { ok: true }
  }

  function stopAutoUpdate() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  }

  /** 应用启动时恢复上次开启的自动更新（默认关闭，不会悄悄联网） */
  function installAutoUpdate() {
    if (!autoUpdateEnabled.value || autoTimer) return
    const blocker = autoBlocker()
    if (blocker) {
      autoUpdateEnabled.value = false
      persistAuto()
      log('warn', '[subscription]', `上次的自动更新设置已停用：${blocker}`)
      return
    }
    autoTimer = setInterval(() => { void updateAllSubscriptions(false) }, 60_000)
    log('info', '[subscription]', `已恢复自动更新：每 ${autoUpdateHours.value} 小时检查一次`)
  }

  function removeNode(id: string) {
    nodes.value = nodes.value.filter(n => n.id !== id)
    log('info', '[store]', `已删除节点 ${id}`)
  }

  function clearAll() {
    nodes.value = []
    lastReport.value = null
    log('warn', '[store]', '已清空节点列表')
  }

  /* ───────── 界面主题：黑夜 / 白天 / 跟随系统 ───────── */
  function applyThemeNow(): void {
    // applyTheme 只操作 DOM 属性，CSS 变量由 style.css 按 data-theme 切换
    resolvedTheme.value = applyTheme(theme.value)
    // 同步 Electron 原生层；浏览器预览没有该 API，api.ts 会静默跳过
    void runtimeApi.setThemeSource(theme.value)
  }

  function setTheme(mode: ThemeMode): void {
    theme.value = normalizeThemeMode(mode)
    persistTheme(theme.value)
    applyThemeNow()
    log('info', '[appearance]', `界面主题已切换为${THEME_LABELS[theme.value]}`)
  }

  /** 应用启动时调用：先应用已保存的选择，再监听系统主题变化（仅 system 模式自动跟随） */
  function initTheme(): void {
    applyThemeNow()
    stopSystemThemeWatch?.()
    stopSystemThemeWatch = watchSystemTheme(() => {
      if (theme.value === 'system') applyThemeNow()
    })
  }

  function disposeTheme(): void {
    stopSystemThemeWatch?.()
    stopSystemThemeWatch = null
  }

  log('info', '[app]', '全能代理助手已启动 · 解析中心就绪；内核需用户在首页点击「开始连接」后才会启动')

  /* ───────── IP 归属地：节点名没写地区时，按真实查询结果补国旗（30 天缓存） ───────── */
  const GEO_KEY = 'upc.geo.cache.v1'
  const GEO_TTL = 30 * 24 * 3600 * 1000
  const geoMap = ref<Record<string, { code: string; at: number }>>({})
  try {
    const rawGeo = JSON.parse(localStorage.getItem(GEO_KEY) || '{}')
    const now = Date.now()
    if (rawGeo && typeof rawGeo === 'object') {
      for (const [k, v] of Object.entries(rawGeo as Record<string, any>)) {
        if (v && typeof v === 'object' && typeof v.code === 'string'
          && /^[A-Z]{2}$/.test(v.code) && now - (typeof v.at === 'number' ? v.at : 0) < GEO_TTL) {
          geoMap.value[k] = { code: v.code, at: typeof v.at === 'number' ? v.at : 0 }
        }
      }
    }
  } catch { /* 缓存坏了就当没有 */ }
  function persistGeo(): void {
    try { localStorage.setItem(GEO_KEY, JSON.stringify(geoMap.value)) } catch { /* 隐私模式忽略 */ }
  }
  const geoBusy = ref(false)
  /** 查询节点服务器归属地：默认只查「节点名识别不出地区」且缓存未命中的，避免无谓请求 */
  async function lookupGeo(serversOverride?: string[]): Promise<{ ok: boolean; count: number; error?: string }> {
    if (geoBusy.value) return { ok: false, count: 0, error: '归属地查询进行中' }
    let targets = serversOverride?.length
      ? [...new Set(serversOverride)]
      : [...new Set(nodes.value.filter(n => !regionCode(n)).map(n => n.server))]
    targets = targets.filter(s => !geoMap.value[s])
    if (!targets.length) return { ok: true, count: 0 }
    geoBusy.value = true
    try {
      const r = await runtimeApi.geoLookup(targets.slice(0, 64))
      if (!r.ok) {
        log('warn', '[geo]', r.error ?? '归属地查询失败')
        return { ok: false, count: 0, error: r.error }
      }
      let count = 0
      for (const [host, res] of Object.entries(r.results)) {
        if (res?.code) {
          geoMap.value = { ...geoMap.value, [host]: { code: res.code, at: Date.now() } }
          count++
        } else if (res?.error) {
          log('warn', '[geo]', `${host} 归属地查询失败：${res.error}`)
        }
      }
      persistGeo()
      if (count) log('success', '[geo]', `已获取 ${count} 个节点的 IP 归属地（来源：真实查询，已缓存 30 天）`)
      return { ok: true, count }
    } finally {
      geoBusy.value = false
    }
  }
  /** 某服务器是否已有归属地结果 */
  const geoCode = (server: string): string => geoMap.value[server]?.code ?? ''

  return {
    nodes, subscriptions, theme, resolvedTheme, activeTab, lastReport, logs, kernel,
    runtime, runtimeLogs, binaries, runtimeBusy, runtimePreview,
    telemetry, siteProbes, probeReport, probeError, probeBusy, routingConfig, appInfo, appVersion, loadAppInfo,
    speedRows, speedBusy, speedTarget, speedConcurrency, qrMode, lastRuntimeError,
    downloads, downloadBusy, latestVersions,
    autoUpdateEnabled, autoUpdateHours, updateHistory,
    fingerprints, problemCount, lossyCount,
    log, recordReport, addNodes, mergeSubscription, removeNode, clearAll,
    installRuntimeEvents, refreshRuntime, connect, disconnect, switchNode, activateNode, peersFor, toggleConnection, setRuntimeMode,
    updateRuntimeSettings, previewRuntimeConfig, pingNode, probeSites, closeConnection, saveRouting,
    startSpeedTest, cancelSpeedTest,
    setTheme, initTheme, disposeTheme,
    geoMap, geoBusy, geoCode, lookupGeo,
    downloadKernelBinary, refreshLatestVersions,
    setAutoUpdate, installAutoUpdate, stopAutoUpdate, updateAllSubscriptions, updateSubscription,
  }
})
