<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import ProxyListPanel from './components/ProxyListPanel.vue'
import LinkParserPanel from './components/LinkParserPanel.vue'
import QrScannerPanel from './components/QrScannerPanel.vue'
import SubscribePanel from './components/SubscribePanel.vue'
import KernelPanel from './components/KernelPanel.vue'
import LogPanel from './components/LogPanel.vue'
import RuntimePanel from './components/RuntimePanel.vue'
import MonitorPanel from './components/MonitorPanel.vue'
import StatsPanel from './components/StatsPanel.vue'
import RulesPanel from './components/RulesPanel.vue'
import AboutPanel from './components/AboutPanel.vue'
import AppearancePanel from './components/AppearancePanel.vue'
import DashboardHero from './components/DashboardHero.vue'
import { useAppStore } from './store.js'
import { THEME_ICONS, THEME_LABELS, THEME_MODES } from './theme.js'
import { uiScale, scaleForWidth, initScaleBase, toLogical, domScale } from './uiScale.js'
import type { UnifiedNode } from '../core/hub/model.js'
import {
  DEFAULT_PROBE_SITES, describeMonitorStatus, describeVerdict, formatBytes, formatSpeed,
  type ProbeAttempt, type ProbeReport,
} from '../core/runtime/telemetry.js'

const appStore = useAppStore()
function winControl(kind: 'minimize' | 'maximize' | 'close') {
  const api = (window as any).electronAPI
  api?.[kind]?.()
}
/** 双击顶栏空白处最大化 / 还原（对齐 Windows 标题栏习惯），按钮上双击不触发 */
function onTopbarDblClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (t?.closest('button, a, input, select, textarea, .topbar-actions, [role="button"]')) return
  winControl('maximize')
}
function onImport(nodes: UnifiedNode[], overwrite: boolean) {
  appStore.addNodes(nodes, { overwrite })
}

type TabKey = 'home' | 'nodes' | 'subscribe' | 'qrcode' | 'config' | 'rules' | 'monitor' | 'stats' | 'logs' | 'settings'

const activeTab = ref<TabKey>('home')
/** 首页所有指标都来自内核真实遥测；未连接 / 内核不支持时显示 0 与具体原因 */
const proxyOn = computed(() => appStore.runtime.state === 'running')
const runtimeLabel = computed(() => {
  const s = appStore.runtime.state
  return s === 'running' ? '已连接' : s === 'starting' ? '连接中…' : s === 'stopping' ? '断开中…' : s === 'error' ? '连接失败' : '未连接'
})
const nowTs = ref(Date.now())
const telemetry = computed(() => appStore.telemetry)
const downText = computed(() => formatSpeed(telemetry.value.downSpeed))
const upText = computed(() => formatSpeed(telemetry.value.upSpeed))
const uploadedText = computed(() => formatBytes(telemetry.value.uploadTotal))
const downloadedText = computed(() => formatBytes(telemetry.value.downloadTotal))
const runSeconds = computed(() => {
  const start = appStore.runtime.startedAt
  return start ? Math.max(0, Math.floor((nowTs.value - start) / 1000)) : 0
})
const networkHealth = computed(() => {
  if (!proxyOn.value) return '内核未运行'
  if (telemetry.value.error) return '采样异常'
  return telemetry.value.supported ? '内核在线' : '无统计接口'
})
const probeReport = computed<ProbeReport | null>(() => appStore.probeReport)
const checkedAtText = computed(() => {
  const t = probeReport.value?.checkedAt
  return t ? `检测于 ${new Date(t).toLocaleTimeString('zh-CN', { hour12: false })}` : ''
})
const filterApp = ref('全部应用')

/** 监控卡片的四组状态：只描述真实采样事实，没数据就显示未采样 / 未检测 */
const monitorStatus = computed(() => describeMonitorStatus({
  connected: proxyOn.value,
  runtimeState: appStore.runtime.state,
  runtimeMessage: appStore.runtime.lastError || appStore.runtime.message || '',
  kernel: appStore.runtime.kernel ?? telemetry.value.kernel,
  nodeName: appStore.runtime.node?.name,
  listenPort: appStore.runtime.listenPort,
  telemetry: telemetry.value,
  diagnosis: probeReport.value?.diagnosis ?? null,
  now: nowTs.value,
}))
const monitorBadges = computed(() => [
  { key: '连接', ...monitorStatus.value.connection },
  { key: '采样', ...monitorStatus.value.sampling },
  { key: '数据源', ...monitorStatus.value.source },
  { key: '节点', ...monitorStatus.value.nodeCheck },
])
const monitorFacts = computed(() => [
  { label: '内核', value: (appStore.runtime.kernel ?? telemetry.value.kernel ?? '—') + (telemetry.value.kernelVersion ? ' ' + telemetry.value.kernelVersion : '') },
  { label: '当前节点', value: appStore.runtime.node?.name ?? '—' },
  { label: '本地端口', value: appStore.runtime.listenPort ? String(appStore.runtime.listenPort) : '—' },
  { label: '实时 ↓ / ↑', value: `${downText.value} / ${upText.value}` },
  { label: '本次累计 ↓ / ↑', value: `${downloadedText.value} / ${uploadedText.value}` },
  { label: '活跃连接', value: monitorStatus.value.connectionList ? String(telemetry.value.activeConnections) : (appStore.runtime.kernel ?? telemetry.value.kernel) === 'xray' ? '不支持' : '—' },
  { label: '最近采样', value: monitorStatus.value.sampledAgo },
])

/** 真实连接列表。clash_api 不提供 PID，明确显示 — 而不是编造数字 */
const monitorRows = computed(() => {
  const f = filterApp.value
  const list = telemetry.value.connections.filter(c =>
    f === '全部应用' || (f === '仅代理' ? c.outbound === 'proxy' : c.outbound === 'direct'))
  return list.slice(0, 8).map(c => ({
    name: c.process || c.inbound || '未知进程',
    icon: '▣',
    pid: '—',
    target: c.host || c.destinationIp || '—',
    port: c.destinationPort ? String(c.destinationPort) : '—',
    status: c.outbound,
    statusText: { proxy: '代理', direct: '直连', reject: '阻断', unknown: '未知' }[c.outbound],
    node: c.chains[c.chains.length - 1] || '—',
    rule: [c.rule, c.rulePayload].filter(Boolean).join(':') || '—',
    up: formatBytes(c.upload),
    down: formatBytes(c.download),
    time: c.startedAt ? new Date(c.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—',
  }))
})

/** 节点体检：未点击「开始真实检测」前一律显示 —，绝不预填通/不通或延迟 */
const probeHosts = DEFAULT_PROBE_SITES.map(s => s.host)
const testSites = computed(() => DEFAULT_PROBE_SITES.map(s => {
  const p = appStore.siteProbes.find(x => x.host === s.host)
  const cell = (a: ProbeAttempt | undefined, label: string) => {
    if (!p || !a) return { text: '—', cls: 'idle', title: `尚未检测：${label}` }
    if (a.ok) return {
      text: `${a.ms} ms`,
      cls: a.status >= 400 ? 'warn' : 'ok',
      title: `${label}：链路已通，HTTP ${a.status}${a.error ? '｜' + a.error : ''}（${a.via}）`,
    }
    return {
      text: '不通',
      cls: 'bad',
      title: `${label}：${a.error ?? '未收到任何响应'}（${a.failure ?? 'unknown'}）`,
    }
  }
  return {
    name: s.host, icon: '🌐',
    groupLabel: s.group === 'overseas' ? '境外' : '境内',
    groupCls: s.group,
    direct: cell(p?.direct, '直连'),
    proxy: cell(p?.viaProxy, '经节点'),
    note: p ? describeVerdict(p, probeReport.value?.proxyRunning ?? false) : '',
    verdict: p?.verdict ?? 'not-probed',
  }
}))

const navItems: { key: TabKey; label: string; sub: string; icon: string }[] = [
  { key: 'home',          label: '首页',           sub: '实时状态',       icon: '\u{1F3E0}' },
  { key: 'nodes',         label: '节点管家',        sub: '管理 · 测速 · 连接', icon: '\u{1F500}' },
  { key: 'subscribe',     label: '订阅管理',        sub: '自动更新',       icon: '\u{1F504}' },
  { key: 'qrcode',        label: '二维码识别',      sub: '多种格式',       icon: '\u{1F4F8}' },
  { key: 'config',        label: '配置导入',        sub: '支持多协议',     icon: '\u{1F4C2}' },
  { key: 'rules',         label: '规则管理',        sub: '智能分流',       icon: '\u{2699}' },
  { key: 'monitor',       label: '网络连接监控',    sub: '代理状态识别',   icon: '\u{1F4E1}' },
  { key: 'stats',         label: '流量统计',        sub: '详细报表',       icon: '\u{1F4CA}' },
  { key: 'logs',          label: '日志查看',        sub: '运行日志',       icon: '\u{1F4CD}' },
  { key: 'settings',      label: '设置中心',        sub: '高级设置',       icon: '\u{2699}' },
]

/** 「节点测速」已并入「节点管家」：旧深链接 #speedtest、仪表盘「自动选择」的旧跳转
 *  仍指向 speedtest，这里统一归一到 nodes，避免书签 / 按钮点了没反应 */
function normalizeTab(t: string): TabKey {
  return t === 'speedtest' ? 'nodes' : t as TabKey
}

const formatTime = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}小时${m}分钟`
}

/* 主题切换由顶部「主题」循环按钮（cycleTheme）接管；原侧边栏主题下拉菜单已随侧栏移除 */

// 定时器只负责刷新「运行时长」的时钟读数；所有速率 / 流量 / 连接数据由主进程遥测推送
let ticker: ReturnType<typeof setInterval>
// 支持 #config / #qrcode 之类的深链接，方便直接定位子界面
watch(activeTab, k => { try { history.replaceState(null, '', '#' + k) } catch { /* 忽略 */ } })
/* 窗口缩放：窗口放大 / 缩小时，内容视图整体等比缩放，卡片跟着变大变小。
   只缩放 .view 内部的内容层（.view-scaler），顶栏 / 底栏的窗口拖动区不受影响。
   全自动：resize 一到就重算，界面上不提供任何开关，不需要用户点一下才生效。 */
function applyUiScale() {
  // 基准取启动瞬间的实际内容宽度，保证基准窗口下 zoom 精确等于 1、视觉与参考图一致
  initScaleBase(window.innerWidth)
  uiScale.value = scaleForWidth(window.innerWidth)
}

onMounted(() => {
  appStore.installRuntimeEvents()
  appStore.installAutoUpdate()
  /** 主题：应用保存的选择，并让 system 模式跟随 Windows 设置自动变化 */
  appStore.initTheme()
  /** 版本号取自程序本身（主进程 app.getVersion），侧边栏与「关于」页共用这一份 */
  void appStore.loadAppInfo()
  const k = normalizeTab(location.hash.replace('#', ''))
  if (navItems.some(n => n.key === k)) activeTab.value = k
  ticker = setInterval(() => { nowTs.value = Date.now() }, 1000)
  applyUiScale()
  window.addEventListener('resize', applyUiScale)
})
onUnmounted(() => {
  clearInterval(ticker)
  if (toastTimer) clearTimeout(toastTimer)
  window.removeEventListener('resize', applyUiScale)
  appStore.disposeTheme()
})

/** 顶部主题快捷按钮：黑夜 → 白天 → 跟随系统 循环 */
function cycleTheme() {
  const i = THEME_MODES.indexOf(appStore.theme)
  appStore.setTheme(THEME_MODES[(i + 1) % THEME_MODES.length])
}

const helpOpen = ref(false)

/** 真实事件通知：导入完成 / 连接失败才弹，绝不预置演示通知 */
type Toast = { level: 'success' | 'error'; title: string; detail: string }
const toast = ref<Toast | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined
function showToast(level: Toast['level'], title: string, detail: string) {
  toast.value = { level, title, detail }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 8000)
}
watch(() => appStore.lastReport, r => {
  if (!r) return
  showToast(
    'success',
    r.stats.failed ? '导入完成（含失败项）' : '配置识别成功',
    `${r.formatLabel} · 识别 ${r.stats.parsed} 个节点${r.stats.failed ? ` · 失败 ${r.stats.failed}` : ''}`,
  )
})
/* 只保留这一条错误 toast 通道：连接 / 断开 / 切换 / 崩溃退出全部汇到 lastRuntimeError，
   原先还额外监听 runtime.lastError，一次连接失败会连弹两个一模一样的提示。 */
watch(() => appStore.lastRuntimeError, e => {
  // title 由 store 决定（连接 / 断开 / 切换各不相同），缺省沿用「节点切换失败」
  if (e) showToast('error', e.title || '节点切换失败', e.message.slice(0, 200))
})

/** 仪表盘快捷操作：切页并可指定二维码起始模式 */
function onHeroNavigate(tab: string, mode?: string) {
  // qrMode 必须在切页前写好：二维码面板挂载时 onMounted 会消费一次并清空
  if (mode) appStore.qrMode = mode
  activeTab.value = normalizeTab(tab)
}

/** 真实一键连接：启动内核 / 断开并按快照恢复系统设置 */
async function switchProxy() {
  const r = await appStore.toggleConnection()
  if (r.action === 'no-nodes') activeTab.value = 'config'
}

/* 首页统一自由布局画布：把首页所有可见模块（仪表盘 / 状态条 / 网络连接监控 /
   网站代理检测）统一成可拖拽、缩放、自由组合的一层卡片画布。
   机制与 DashboardHero 一致：默认（无自定义布局）沿用参考图固定栅格视觉不变；
   点「自定义首页布局」进入编辑态，每个模块可拖动 / 缩放 / 自由组合并持久化到 localStorage；
   退出后一直生效；调好后可「设为默认」存成自己的默认模板，「恢复默认」一键回到那套摆法。
   只动卡片容器大小/位置，绝不碰图标像素红线。
   DashboardHero 在画布编辑态作为整体卡片，其内部子布局编辑被 CSS 屏蔽。
   注：首页不再放「二维码识别」卡片（功能仍在「二维码识别」页），入口统一走菜单。 */
const HOME_MODULES = ['heroTop', 'heroPower', 'heroInfo', 'heroQuick', 'heroNodes', 'hub', 'monitor', 'sites'] as const
type HomeModId = typeof HOME_MODULES[number]
const HOME_MIN: Record<HomeModId, [number, number]> = {
  heroTop: [420, 118], heroPower: [250, 250], heroInfo: [290, 290], heroQuick: [290, 230], heroNodes: [360, 300],
  hub: [300, 110], monitor: [360, 320], sites: [240, 240],
}
/* 仪表盘拆成 5 张独立卡片：顶部横带 / 大圆连接 / 节点信息 / 快捷操作 / 节点列表，
   全部交给首页画布统一拖动、缩放、隐藏，不再作为一个整块大卡。 */
const HERO_PARTS: { id: HomeModId; part: 'top' | 'power' | 'info' | 'quick' | 'nodes' }[] = [
  { id: 'heroTop', part: 'top' },
  { id: 'heroPower', part: 'power' },
  { id: 'heroInfo', part: 'info' },
  { id: 'heroQuick', part: 'quick' },
  { id: 'heroNodes', part: 'nodes' },
]
const HOME_LAYOUT_KEY = 'upc.home.layout.v1'
const HOME_SNAP = 8
const editHome = ref(false)
const homeLayout = ref<Record<string, { x: number; y: number; w: number; h: number }>>({})
const homeEls = ref<Record<string, HTMLElement>>({})
const homeEl = ref<HTMLElement | null>(null)
let homeDrag: { id: HomeModId; mode: 'move' | 'resize'; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null = null
function setHomeMod(id: string, el: unknown) {
  if (el) homeEls.value[id] = el as HTMLElement
  else delete homeEls.value[id]
}
function loadHomeLayout(): Record<string, { x: number; y: number; w: number; h: number }> {
  try {
    const raw = JSON.parse(localStorage.getItem(HOME_LAYOUT_KEY) || '{}') || {}
    // 白名单过滤：已下线的模块（如旧版首页的二维码卡片）残留坐标必须清掉，
    // 否则磁吸会吸附到一张看不见的卡片边缘，拖动时莫名被拽住
    const clean: Record<string, { x: number; y: number; w: number; h: number }> = {}
    for (const id of HOME_MODULES) {
      const l = raw[id]
      if (l && Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.w) && Number.isFinite(l.h)) clean[id] = l
    }
    return clean
  } catch { return {} }
}
function hasHomeCustom(): boolean { return Object.keys(homeLayout.value).length > 0 }
function homeModuleStyle(id: string): Record<string, string> {
  if (!editHome.value && !hasHomeCustom()) return {}
  const l = homeLayout.value[id]
  if (!l) return {}
  return { left: l.x + 'px', top: l.y + 'px', width: l.w + 'px', height: l.h + 'px' }
}
const homeMinH = computed(() => {
  if (!editHome.value && !hasHomeCustom()) return ''
  let m = 0
  for (const id of HOME_MODULES) {
    if (hiddenMods.value.includes(id)) continue
    const l = homeLayout.value[id]; if (l) m = Math.max(m, l.y + l.h)
  }
  return (m + 14) + 'px'
})
function homeSnap(v: number) { return Math.round(v / HOME_SNAP) * HOME_SNAP }

/* 磁吸：拖动 / 缩放时，卡片边缘靠近其他卡片边缘或画布边缘（10px 内）自动吸附，
   并显示对齐辅助线。8px 栅格是兜底精度，磁吸负责「贴边对齐」。 */
const HOME_MAGNET = 10
const snapGuides = ref<{ v: number | null; h: number | null }>({ v: null, h: null })
type Box = { x: number; y: number; w: number; h: number }
function magnetBox(id: HomeModId, box: Box, mode: 'move' | 'resize'): { box: Box; guideV: number | null; guideH: number | null } {
  const el = homeEl.value
  const width = el?.clientWidth ?? 0
  const height = el?.clientHeight ?? 0
  const xs: number[] = [0]
  const ys: number[] = [0]
  if (width) xs.push(width)
  if (height) ys.push(height)
  for (const key of HOME_MODULES) {
    if (key === id || hiddenMods.value.includes(key)) continue
    const l = homeLayout.value[key]
    if (!l) continue
    xs.push(l.x, l.x + l.w)
    ys.push(l.y, l.y + l.h)
  }
  const next: Box = { ...box }
  /* 移动模式：整块盒子移动，左/右、上/下两条边都可能作为吸附基准；
     缩放模式：手柄在右下角，只有右边缘/下边缘在动，左/上边缘不该参与吸附，
     否则从右下角拖缩放、且卡片靠近其它卡片时会被错误拽动宽度/高度。 */
  const xEdges = mode === 'move' ? [box.x, box.x + box.w] : [box.x + box.w]
  const yEdges = mode === 'move' ? [box.y, box.y + box.h] : [box.y + box.h]
  // 水平：边缘分别尝试贴目标竖线，取最近的一条
  let bestX: { delta: number; target: number } | null = null
  for (const edge of xEdges) {
    for (const target of xs) {
      const delta = target - edge
      if (Math.abs(delta) <= HOME_MAGNET && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, target }
    }
  }
  if (bestX) {
    if (mode === 'move') next.x = Math.max(0, box.x + bestX.delta)
    else next.w = Math.max(HOME_MIN[id][0], box.w + bestX.delta)
  }
  // 垂直：边缘分别尝试贴目标横线，取最近的一条
  let bestY: { delta: number; target: number } | null = null
  for (const edge of yEdges) {
    for (const target of ys) {
      const delta = target - edge
      if (Math.abs(delta) <= HOME_MAGNET && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, target }
    }
  }
  if (bestY) {
    if (mode === 'move') next.y = Math.max(0, box.y + bestY.delta)
    else next.h = Math.max(HOME_MIN[id][1], box.h + bestY.delta)
  }
  return { box: next, guideV: bestX ? bestX.target : null, guideH: bestY ? bestY.target : null }
}
function measureHomeLayout(): Record<string, { x: number; y: number; w: number; h: number }> {
  const base = homeEl.value?.getBoundingClientRect()
  const measured: Record<string, { x: number; y: number; w: number; h: number }> = {}
  if (base) {
    /* rect 是视口物理像素，而 left/top 写进样式的是逻辑像素（zoom 会再放大一次）。
       必须除以实测缩放系数，否则窗口放大后首次拖动量出的坐标会偏大、卡片瞬间跳位。 */
    const k = domScale(homeEl.value) || 1
    for (const id of HOME_MODULES) {
      const el = homeEls.value[id]
      if (!el) continue
      const r = el.getBoundingClientRect()
      measured[id] = {
        x: homeSnap((r.left - base.left) / k), y: homeSnap((r.top - base.top) / k),
        w: Math.round(r.width / k), h: Math.round(r.height / k),
      }
    }
  }
  return measured
}
function enterHomeEdit() {
  const saved = loadHomeLayout()
  homeLayout.value = Object.keys(saved).length ? saved : measureHomeLayout()
  editHome.value = true
}
/* 平时也能直接拖：首次真正拖动时，把当前栅格位置量出来转成绝对定位，布局从此自由排布。
   只按住没拖动不会转换，默认参考图栅格保持不变。 */
function ensureHomeLayout() {
  if (hasHomeCustom()) return
  homeLayout.value = measureHomeLayout()
}
function persistHomeLayout() {
  try { localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify(homeLayout.value)) } catch { /* 隐私模式忽略 */ }
}
function exitHomeEdit(saveIt: boolean) {
  if (saveIt) persistHomeLayout()
  editHome.value = false
}
function resetHomeLayout() {
  homeLayout.value = {}
  hiddenMods.value = []
  hiddenOpen.value = false
  try {
    localStorage.removeItem(HOME_LAYOUT_KEY)
    localStorage.removeItem(HOME_HIDDEN_KEY)
  } catch { /* ignore */ }
  editHome.value = false
}

/* 模块隐藏 / 恢复：功能重复或暂时不想看的卡片可以隐藏，随时从工具条「已隐藏 N 个模块」加回来。
   隐藏只影响渲染，组件数据与功能全保留；恢复时若已启用自定义布局，自动补一个兜底位置。 */
const HOME_LABELS: Record<HomeModId, string> = {
  heroTop: '仪表盘·顶部横带', heroPower: '仪表盘·连接按钮', heroInfo: '仪表盘·节点信息',
  heroQuick: '仪表盘·快捷操作', heroNodes: '仪表盘·节点列表',
  hub: '状态条', monitor: '网络连接监控', sites: '网站代理检测',
}
const HOME_HIDDEN_KEY = 'upc.home.hidden.v1'
function loadHomeHidden(): HomeModId[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HOME_HIDDEN_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((x: unknown): x is HomeModId => HOME_MODULES.includes(x as HomeModId))
  } catch { return [] }
}
const hiddenMods = ref<HomeModId[]>(loadHomeHidden())
const hiddenOpen = ref(false)
function isHomeHidden(id: HomeModId): boolean { return hiddenMods.value.includes(id) }
function persistHomeHidden() {
  try { localStorage.setItem(HOME_HIDDEN_KEY, JSON.stringify(hiddenMods.value)) } catch { /* 隐私模式忽略 */ }
}
function hideHomeMod(id: HomeModId) {
  if (!hiddenMods.value.includes(id)) hiddenMods.value = [...hiddenMods.value, id]
  persistHomeHidden()
  if (!hiddenMods.value.length) hiddenOpen.value = false
}
function restoreHomeMod(id: HomeModId) {
  hiddenMods.value = hiddenMods.value.filter(x => x !== id)
  persistHomeHidden()
  // 已启用自定义布局（绝对定位）时，恢复的模块必须有自己的坐标，否则会堆在画布左上角
  if (hasHomeCustom() && !homeLayout.value[id]) {
    let bottom = 0
    for (const key of Object.keys(homeLayout.value)) {
      const l = homeLayout.value[key]
      bottom = Math.max(bottom, l.y + l.h)
    }
    const sibling = homeLayout.value['sites'] ?? homeLayout.value['monitor']
    const w = sibling ? sibling.w : 420
    homeLayout.value = { ...homeLayout.value, [id]: { x: 16, y: bottom ? bottom + 16 : 16, w, h: HOME_MIN[id][1] } }
    try { localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify(homeLayout.value)) } catch { /* ignore */ }
  }
  if (!hiddenMods.value.length) hiddenOpen.value = false
}
function toggleHiddenPanel() { hiddenOpen.value = !hiddenOpen.value }

/* 「设为默认」：把当前调好的布局 + 隐藏清单存成自己的默认模板（不是清空重置）。
   之后不管怎么拖、怎么隐藏，点「恢复默认」都能整包回到这套摆法；
   模板只存坐标与隐藏清单，不碰节点数据、订阅与图标像素红线。 */
const HOME_DEFAULT_KEY = 'upc.home.default.v1'
type HomeDefault = { layout: Record<string, { x: number; y: number; w: number; h: number }>; hidden: HomeModId[]; at: number }
function loadHomeDefault(): HomeDefault | null {
  try {
    const raw = JSON.parse(localStorage.getItem(HOME_DEFAULT_KEY) || 'null')
    if (!raw || typeof raw !== 'object' || !raw.layout) return null
    // 同样走白名单：旧版本下线的模块坐标不能带进默认模板
    const layout: HomeDefault['layout'] = {}
    for (const id of HOME_MODULES) {
      const l = raw.layout[id]
      if (l && Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.w) && Number.isFinite(l.h)) layout[id] = { x: l.x, y: l.y, w: l.w, h: l.h }
    }
    const hidden = Array.isArray(raw.hidden)
      ? raw.hidden.filter((x: unknown): x is HomeModId => HOME_MODULES.includes(x as HomeModId))
      : []
    return { layout, hidden, at: Number(raw.at) || 0 }
  } catch { return null }
}
const homeDefault = ref<HomeDefault | null>(loadHomeDefault())
const homeHint = ref('')   // 工具条就地提示：设默认 / 恢复默认都只在这里说一句，不弹打扰性 toast
let homeHintTimer: ReturnType<typeof setTimeout> | undefined
function flashHomeHint(text: string) {
  homeHint.value = text
  if (homeHintTimer) clearTimeout(homeHintTimer)
  homeHintTimer = setTimeout(() => { homeHint.value = '' }, 2600)
}
/* 布局指纹：只比模块 id 顺序固定后的坐标与隐藏清单，用来判断「当前是否就是默认」 */
function homeSignature(layout: HomeDefault['layout'], hidden: HomeModId[]): string {
  const body = HOME_MODULES.filter(id => layout[id]).map(id => {
    const l = layout[id]
    return `${id}:${l.x},${l.y},${l.w},${l.h}`
  }).join('|')
  return body + '#' + [...hidden].sort().join(',')
}
function sameAsHomeDefault(): boolean {
  const d = homeDefault.value
  if (!d) return false
  return homeSignature(homeLayout.value, hiddenMods.value) === homeSignature(d.layout, d.hidden)
}
function setHomeDefault() {
  if (!hasHomeCustom() && !hiddenMods.value.length) { flashHomeHint('先把卡片拖成想要的样子，再点「设为默认」'); return }
  const snap: HomeDefault = { layout: { ...homeLayout.value }, hidden: [...hiddenMods.value], at: Date.now() }
  homeDefault.value = snap
  try { localStorage.setItem(HOME_DEFAULT_KEY, JSON.stringify(snap)) } catch { /* 隐私模式忽略 */ }
  flashHomeHint('已把当前布局设为默认，之后可一键恢复')
}
function restoreHomeDefault() {
  const d = homeDefault.value
  if (!d) { resetHomeLayout(); flashHomeHint('还没保存过默认布局，已回到出厂排布'); return }
  homeLayout.value = { ...d.layout }
  hiddenMods.value = [...d.hidden]
  persistHomeLayout()
  persistHomeHidden()
  hiddenOpen.value = false
  editHome.value = false
  flashHomeHint('已恢复到默认布局')
}

let homeEnsureMade = false  // 本次拖动是否由「直接拖」触发了栅格→自由布局转换
let homeMoved = false      // 本次拖动是否真的移动过
function onHomeGripDown(id: HomeModId, e: PointerEvent) {
  // 只有点了「编辑布局」才允许拖动：平时卡片是固定展示态，避免误拖打乱布局
  if (!editHome.value) return
  e.preventDefault()
  homeEnsureMade = !homeLayout.value[id]
  homeMoved = false
  homeDrag = { id, mode: 'move', sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, ow: 0, oh: 0 }
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  window.addEventListener('pointermove', onHomePointerMove)
  window.addEventListener('pointerup', onHomePointerUp)
}
function onHomeResizeDown(id: HomeModId, e: PointerEvent) {
  if (!editHome.value) return
  e.preventDefault(); e.stopPropagation()
  homeEnsureMade = !homeLayout.value[id]
  homeMoved = false
  homeDrag = { id, mode: 'resize', sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, ow: 0, oh: 0 }
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  window.addEventListener('pointermove', onHomePointerMove)
  window.addEventListener('pointerup', onHomePointerUp)
}
function onHomePointerMove(e: PointerEvent) {
  if (!homeDrag) return
  const pdx = e.clientX - homeDrag.sx, pdy = e.clientY - homeDrag.sy
  // 平时直接拖：真的动了（超过 3px 物理像素，防手抖误触）才把栅格位置量成自由布局坐标
  if (!homeMoved) {
    if (Math.abs(pdx) < 3 && Math.abs(pdy) < 3) return
    ensureHomeLayout()
    const l = homeLayout.value[homeDrag.id]
    if (!l) { homeDrag = null; return }
    homeDrag.ox = l.x; homeDrag.oy = l.y; homeDrag.ow = l.w; homeDrag.oh = l.h
    homeMoved = true
  }
  /* clientX/Y 是视口物理像素，坐标是逻辑像素：换算后拖动才跟手（放大 1.5 倍时
     鼠标移 15px，卡片也正好跟着移 15px，而不是被 zoom 再放大成 22.5px）。 */
  const dx = toLogical(pdx, homeEl.value), dy = toLogical(pdy, homeEl.value)
  const cur = { ...homeLayout.value[homeDrag.id]! }
  if (homeDrag.mode === 'move') {
    cur.x = Math.max(0, homeSnap(homeDrag.ox + dx))
    cur.y = Math.max(0, homeSnap(homeDrag.oy + dy))
  } else {
    cur.w = Math.max(HOME_MIN[homeDrag.id][0], homeSnap(homeDrag.ow + dx))
    cur.h = Math.max(HOME_MIN[homeDrag.id][1], homeSnap(homeDrag.oh + dy))
  }
  const snapped = magnetBox(homeDrag.id, cur, homeDrag.mode)
  snapGuides.value = { v: snapped.guideV, h: snapped.guideH }
  homeLayout.value = { ...homeLayout.value, [homeDrag.id]: snapped.box }
}
function onHomePointerUp() {
  homeDrag = null
  snapGuides.value = { v: null, h: null }
  // 编辑态下拖完立即落盘：即使忘了点「完成」也不会丢布局；只点了一下没拖就还原默认栅格
  if (homeMoved) persistHomeLayout()
  else if (homeEnsureMade) homeLayout.value = {}
  homeEnsureMade = false
  homeMoved = false
  window.removeEventListener('pointermove', onHomePointerMove)
  window.removeEventListener('pointerup', onHomePointerUp)
}

/* 汉堡菜单：取消常驻顶部导航栏后，11 个功能页入口收进一个 ≡ 弹层 */
const menuOpen = ref(false)
function toggleMenu() { menuOpen.value = !menuOpen.value }
function gotoTab(key: TabKey) { activeTab.value = key; menuOpen.value = false }
</script>

<template>
  <div class="app-shell" :style="{ '--ui-scale': uiScale }">
    <!-- 左侧导航栏已移除：11 个功能入口改为右侧顶部卡片导航 top-nav，详见下方 -->

    <!-- Main content -->
    <main class="main-content">
      <!-- Header -->
      <header class="topbar" @dblclick="onTopbarDblClick">
        <div class="topbar-title" title="按住此处可拖动窗口 · 双击最大化 / 还原">
          <span class="breadcrumb">{{ navItems.find(n=>n.key===activeTab)?.label ?? '首页' }}</span>
        </div>
        <div class="topbar-actions">
          <span class="node-count">节点 {{ appStore.nodes.length }}<span v-if="appStore.problemCount" class="warn-dot"> · {{ appStore.problemCount }} 项待补全</span></span>
          <button class="icon-btn menu-btn" title="功能菜单" @click="toggleMenu">&#x2261; 菜单</button>
          <button class="icon-btn" title="切换主题：黑夜 / 白天 / 跟随系统" @click="cycleTheme">{{ THEME_ICONS[appStore.theme] }} {{ THEME_LABELS[appStore.theme] }}</button>
          <button class="icon-btn" title="使用帮助" @click="helpOpen = true">&#x003F; 帮助</button>
          <span class="win-btns">
            <button title="最小化" @click="winControl('minimize')">&#x2013;</button>
            <button title="最大化" @click="winControl('maximize')">&#x25A1;</button>
            <button title="关闭" class="close" @click="winControl('close')">&#x2715;</button>
          </span>
        </div>
      </header>

      <!-- HOME VIEW -->
      <div v-if="activeTab === 'home'" class="view home-view">
        <!-- 缩放层只包内容：顶栏 / 底栏带 -webkit-app-region:drag，绝不能缩放 -->
        <div class="view-scaler">
        <div class="home-canvas" :class="{ 'home--edit': editHome, 'has-custom': hasHomeCustom() }" :style="{ minHeight: homeMinH }" ref="homeEl">
          <div class="home-toolbar">
            <span class="ht-tip ht-tip-flash" v-if="homeHint">{{ homeHint }}</span>
            <span class="ht-tip" v-else-if="editHome">拖左上角「⠿ 拖动」移动、拖右下角缩放；右上角 ✕ 隐藏模块；拖完自动保存</span>
            <span class="ht-tip" v-else>点「编辑布局」后可拖动 / 缩放 / 隐藏卡片；调好点「设为默认」长期保留</span>
            <span class="ht-spacer"></span>
            <button v-if="hiddenMods.length" class="ht-btn" :class="{ active: hiddenOpen }" @click="toggleHiddenPanel">已隐藏 {{ hiddenMods.length }} 个模块</button>
            <button v-if="!editHome" class="ht-btn" @click="enterHomeEdit">{{ hasHomeCustom() ? '编辑布局' : '自定义首页布局' }}</button>
            <button v-if="!editHome && (hasHomeCustom() || hiddenMods.length)" class="ht-btn" @click="setHomeDefault">设为默认</button>
            <button v-if="!editHome && homeDefault && !sameAsHomeDefault()" class="ht-btn ghost" @click="restoreHomeDefault">恢复默认</button>
            <button v-if="editHome" class="ht-btn primary" @click="exitHomeEdit(true)">完成</button>
            <!-- 已隐藏模块：点一下立刻加回首页（数据与功能一直都在） -->
            <div v-if="hiddenOpen && hiddenMods.length" class="hidden-pop" @click.stop>
              <div class="hp-title">已隐藏模块 · 点一下恢复</div>
              <button v-for="id in hiddenMods" :key="id" class="hp-item" @click="restoreHomeMod(id)">
                <span class="hp-name">{{ HOME_LABELS[id] }}</span><span class="hp-add">+ 恢复</span>
              </button>
              <div class="hp-tip">隐藏只是不在首页显示，数据与功能都保留，随时可以加回来</div>
            </div>
          </div>

          <!-- 磁吸对齐辅助线：拖动 / 缩放时贴近其他卡片或画布边缘才出现 -->
          <div v-if="snapGuides.v !== null" class="snap-guide snap-v" :style="{ left: snapGuides.v + 'px' }"></div>
          <div v-if="snapGuides.h !== null" class="snap-guide snap-h" :style="{ top: snapGuides.h + 'px' }"></div>
          <template v-for="hp in HERO_PARTS" :key="hp.id">
            <div v-if="!isHomeHidden(hp.id)" class="home-mod" :data-mod="hp.id" :style="homeModuleStyle(hp.id)" :ref="(el) => setHomeMod(hp.id, el)">
              <DashboardHero :part="hp.part" @navigate="onHeroNavigate" />
              <div class="mod-grip" @pointerdown="onHomeGripDown(hp.id, $event)"><span>⠿ 拖动</span></div>
              <button v-if="editHome" type="button" class="mod-hide" title="隐藏这个模块（随时可恢复）" @pointerdown.stop.prevent @click.stop="hideHomeMod(hp.id)">✕</button>
              <div class="mod-resize" @pointerdown="onHomeResizeDown(hp.id, $event)"></div>
            </div>
          </template>

          <!-- ② 真实状态条 -->
          <div v-if="!isHomeHidden('hub')" class="home-mod" :data-mod="'hub'" :style="homeModuleStyle('hub')" :ref="(el) => setHomeMod('hub', el)">
        <div class="hub-strip">
          <div class="hs-item"><b class="hs-ok">{{ appStore.nodes.length }}</b><span>真实节点</span></div>
          <div class="hs-item"><b>{{ appStore.subscriptions.length }}</b><span>订阅</span></div>
          <div class="hs-item"><b class="hs-warn">{{ appStore.problemCount }}</b><span>阻断问题</span></div>
          <div class="hs-item"><b class="hs-warn">{{ appStore.lossyCount }}</b><span>含待确认字段</span></div>
          <div class="hs-item"><b>{{ appStore.logs.length }}</b><span>运行日志</span></div>
          <div class="hs-item"><b :class="proxyOn ? 'hs-ok' : 'hs-warn'" style="font-size:15px">{{ runtimeLabel }}</b><span>内核状态</span></div>
          <div class="hs-note">
            <b>内核运行：{{ appStore.runtime.message }}</b>
            <br /><span>{{ appStore.lastReport ? `最近导入：${appStore.lastReport.formatLabel} · 识别 ${appStore.lastReport.stats.parsed} / 失败 ${appStore.lastReport.stats.failed}` : '尚未导入配置' }} · 实时数据：{{ telemetry.reason }}</span>
          </div>
        </div>
          <div class="mod-grip" @pointerdown="onHomeGripDown('hub', $event)"><span>⠿ 拖动</span></div>
          <button v-if="editHome" type="button" class="mod-hide" title="隐藏这个模块（随时可恢复）" @pointerdown.stop.prevent @click.stop="hideHomeMod('hub')">✕</button>
          <div class="mod-resize" @pointerdown="onHomeResizeDown('hub', $event)"></div>
          </div>

          <!-- ③ 网络连接监控 -->
          <div v-if="!isHomeHidden('monitor')" class="home-mod" :data-mod="'monitor'" :style="homeModuleStyle('monitor')" :ref="(el) => setHomeMod('monitor', el)">
        <div class="card monitor-card">
          <div class="monitor-header">
            <span class="monitor-title">&#x1F4E0; 网络连接监控</span>
            <div class="monitor-badges">
              <span v-for="b in monitorBadges" :key="b.key" :class="['mon-badge', 'lv-' + b.level]" :title="b.detail">
                <i class="mon-dot"></i><em>{{ b.key }}</em>{{ b.label }}
              </span>
            </div>
            <div class="monitor-controls">
              <select v-model="filterApp" class="filter-select">
                <option>全部应用</option>
                <option>仅代理</option>
                <option>仅直连</option>
              </select>
              <button class="clear-btn" @click="appStore.refreshRuntime()">刷新数据</button>
            </div>
          </div>
          <div class="monitor-strip">
            <div v-for="f in monitorFacts" :key="f.label" class="mon-fact">
              <span>{{ f.label }}</span><b>{{ f.value }}</b>
            </div>
          </div>
          <table class="monitor-table">
            <thead>
              <tr>
                <th>进程名称</th><th>PID</th><th>目标地址</th><th>端口</th>
                <th>代理状态</th><th>使用节点</th><th>匹配规则</th><th>上传/下载</th><th>时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row,i) in monitorRows" :key="i">
                <td><span class="proc-icon">{{ row.icon }}</span>{{ row.name }}</td>
                <td class="mono" title="clash_api 不提供进程 PID，故无法显示">{{ row.pid }}</td>
                <td>{{ row.target }}</td>
                <td class="mono">{{ row.port }}</td>
                <td><span :class="['status-tag', row.status]">{{ row.statusText }}</span></td>
                <td>{{ row.node }}</td>
                <td>{{ row.rule }}</td>
                <td class="mini-stats">
                  <span class="up-arrow">&#x2191;</span> {{ row.up }}
                  <span class="dn-arrow">&#x2193;</span> {{ row.down }}
                </td>
                <td class="mono time-col">{{ row.time }}</td>
              </tr>
              <tr v-if="!monitorRows.length">
                <td colspan="9" class="empty-cell">
                  <div class="mon-empty">
                    <div class="mon-empty-title"><span class="mon-empty-dot"></span>{{ monitorStatus.emptyTitle }}</div>
                    <p>{{ monitorStatus.emptyDetail }}</p>
                    <div class="mon-empty-advice"><span v-for="(a,i) in monitorStatus.advice" :key="i">· {{ a }}</span></div>
                    <div class="mon-empty-actions">
                      <button v-if="!proxyOn && appStore.nodes.length" class="mon-empty-btn" @click="switchProxy">开始连接</button>
                      <button class="mon-empty-btn ghost" :disabled="appStore.probeBusy" @click="appStore.probeSites(probeHosts)">
                        {{ appStore.probeBusy ? '检测中…' : '检验节点通没通' }}
                      </button>
                      <button class="mon-empty-btn ghost" @click="appStore.refreshRuntime()">重新采样</button>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
          <div class="mod-grip" @pointerdown="onHomeGripDown('monitor', $event)"><span>⠿ 拖动</span></div>
          <button v-if="editHome" type="button" class="mod-hide" title="隐藏这个模块（随时可恢复）" @pointerdown.stop.prevent @click.stop="hideHomeMod('monitor')">✕</button>
          <div class="mod-resize" @pointerdown="onHomeResizeDown('monitor', $event)"></div>
          </div>

          <!-- ⑤ 网站代理检测 -->
          <div v-if="!isHomeHidden('sites')" class="home-mod" :data-mod="'sites'" :style="homeModuleStyle('sites')" :ref="(el) => setHomeMod('sites', el)">
        <div class="card sites-card">
          <div class="sites-header">
            <span>&#x1F310; 网站代理检测</span>
            <button class="more-link link-btn" title="去节点管家逐个检验节点" @click="activeTab='nodes'">更多 &gt;</button>
          </div>
          <div class="sites-list">
            <div v-for="s in testSites" :key="s.name" class="site-row" :class="'v-' + s.verdict">
              <span class="site-icon">{{ s.icon }}</span>
              <div class="site-main">
                <div class="site-line1">
                  <span class="site-name">{{ s.name }}</span>
                  <span class="site-group" :class="s.groupCls">{{ s.groupLabel }}</span>
                </div>
                <div class="site-line2">
                  <span class="probe-cell" :class="s.direct.cls" :title="s.direct.title">直 {{ s.direct.text }}</span>
                  <span class="probe-cell" :class="s.proxy.cls" :title="s.proxy.title">代 {{ s.proxy.text }}</span>
                </div>
                <div v-if="s.note" class="site-note" :title="s.note">{{ s.note }}</div>
              </div>
            </div>
          </div>
          <div class="probe-hint">直连 / 经节点各一次真实 HTTPS 请求，不通会写明原因</div>
          <button class="btn-test-all" :disabled="appStore.probeBusy" @click="appStore.probeSites(probeHosts)">
            {{ appStore.probeBusy ? '检测中…' : '开始真实检测' }}
          </button>
          <div v-if="probeReport" class="probe-diagnosis" :class="'lv-' + probeReport.diagnosis.level">
            <div class="diag-title"><span class="diag-dot"></span>{{ probeReport.diagnosis.title }}</div>
            <div class="diag-detail">{{ probeReport.diagnosis.detail }}</div>
            <div v-for="(a, i) in probeReport.diagnosis.advice.slice(0, 2)" :key="i" class="diag-advice">· {{ a }}</div>
            <div class="diag-time">{{ checkedAtText }} · {{ probeReport.diagnosis.summary }}</div>
          </div>
          <div v-else-if="appStore.probeError" class="probe-diagnosis lv-bad">
            <div class="diag-title"><span class="diag-dot"></span>检测未能执行</div>
            <div class="diag-detail">{{ appStore.probeError }}</div>
          </div>
        </div>
          <div class="mod-grip" @pointerdown="onHomeGripDown('sites', $event)"><span>⠿ 拖动</span></div>
          <button v-if="editHome" type="button" class="mod-hide" title="隐藏这个模块（随时可恢复）" @pointerdown.stop.prevent @click.stop="hideHomeMod('sites')">✕</button>
          <div class="mod-resize" @pointerdown="onHomeResizeDown('sites', $event)"></div>
          </div>
        </div>
        </div>
      </div>

      <!-- OTHER VIEWS -->
      <div v-else class="view">
        <!-- 与首页共用同一缩放层，保证 11 个功能页的卡片都随窗口放大缩小 -->
        <div class="view-scaler">
        <ProxyListPanel v-if="activeTab === 'nodes'" />
        <SubscribePanel v-else-if="activeTab === 'subscribe'" @add="onImport" />
        <QrScannerPanel v-else-if="activeTab === 'qrcode'" @add="onImport" />
        <LinkParserPanel v-else-if="activeTab === 'config'" @add="onImport" />
        <template v-else-if="activeTab === 'settings'">
          <AppearancePanel />
          <KernelPanel />
          <RuntimePanel />
          <AboutPanel />
        </template>
        <LogPanel v-else-if="activeTab === 'logs'" />
        <RulesPanel v-else-if="activeTab === 'rules'" />
        <MonitorPanel v-else-if="activeTab === 'monitor'" />
        <StatsPanel v-else-if="activeTab === 'stats'" />
        </div>
      </div>
      </main>

      <!-- 汉堡菜单：取消常驻顶部导航栏后，11 个功能页入口收进 ≡ 弹层 -->
      <div v-if="menuOpen" class="menu-mask" @click.self="menuOpen = false">
        <div class="menu-pop" role="menu">
          <div class="menu-head">
            <b>功能导航</b>
            <button class="menu-close" title="关闭" @click="menuOpen = false">&#x2715;</button>
          </div>
          <button v-for="item in navItems" :key="item.key"
                  :class="['menu-item', { active: activeTab === item.key }]"
                  :title="`${item.label} · ${item.sub}`"
                  @click="gotoTab(item.key)">
            <span class="menu-icon">{{ item.icon }}</span>
            <span class="menu-label">{{ item.label }}</span>
            <span class="menu-sub">{{ item.sub }}</span>
          </button>
        </div>
      </div>

      <!-- Footer -->
    <footer class="footer-bar">
      <div class="footer-left">
        <span :class="['status-dot', proxyOn ? 'green' : 'red']"></span>
        <span>内核：{{ runtimeLabel }}</span>
        <span class="sep">|</span>
        <span>本程序系统代理：{{ appStore.runtime.systemProxy.applied ? '已接管 ' + appStore.runtime.systemProxy.server : '未接管' }}</span>
        <span class="sep">|</span>
        <span>TUN模式：{{ proxyOn && appStore.runtime.mode === 'tun' ? '已开启' : '未开启' }}</span>
      </div>
      <div class="footer-center">
        运行时长：<strong>{{ formatTime(runSeconds) }}</strong>
      </div>
      <div class="footer-right">
        <span class="mono" :title="'当前程序版本 ' + appStore.appVersion">{{ appStore.appVersion }}</span>
        <span class="sep">|</span>
        <span class="signal-icon">&#x1F4F6;</span>
        <span>网络状态：<strong>{{ networkHealth }}</strong></span>
      </div>
    </footer>

    <!-- 真实事件通知：只有导入完成 / 连接失败才出现，8 秒自动消失 -->
    <div v-if="toast" :class="['app-toast', 'lv-' + toast.level]" role="status">
      <span class="toast-icon">{{ toast.level === 'success' ? '&#x2714;' : '&#x0021;' }}</span>
      <div class="toast-body"><b>{{ toast.title }}</b><span>{{ toast.detail }}</span></div>
      <button class="toast-link" @click="activeTab = 'config'; toast = null">查看详情</button>
      <button class="toast-x" title="关闭" @click="toast = null">&#x2715;</button>
    </div>

    <!-- 使用帮助 -->
    <div v-if="helpOpen" class="modal-mask" @click.self="helpOpen = false">
      <div class="help-modal" role="dialog" aria-label="使用帮助">
        <div class="help-head"><b>&#x1F4D6; 使用帮助</b><button title="关闭" @click="helpOpen = false">&#x2715;</button></div>
        <ol>
          <li><b>导入节点</b>：配置导入 / 订阅管理 / 二维码识别，支持 16 类协议与 Clash、sing-box、Xray、WireGuard 配置。</li>
          <li><b>开始连接</b>：点首页大圆按钮或「开始连接」，启动内核并接管系统代理；再点一次断开，系统代理按快照恢复。</li>
          <li><b>检验节点</b>：「节点管家」一键全检先做 TCP 握手剔除不可达节点，再只对可达节点真连下载测速；网站代理检测真发 HTTPS 请求并给出「节点可用 / 异常」诊断。</li>
          <li><b>看状态</b>：网络连接监控有四态徽章和状态条；流量统计的曲线只画真实采样点。</li>
          <li><b>规则与设置</b>：规则管理下发三内核分流；设置中心里切换内核、运行模式与黑夜 / 白天主题。</li>
          <li><b>拖动窗口</b>：无边框标题栏，按住左键拖顶部栏空白处、左上角 logo 区或底部状态栏即可移动；双击顶部栏空白处最大化 / 还原，右上角三个按钮最小化 / 最大化 / 关闭。</li>
        </ol>
        <div class="help-note">原则：所有数值来自内核真实返回，没数据就显示「未采样 / 未测速」，绝不生成模拟数据。Xray 有实时速率但没有逐条连接列表。</div>
        <div class="help-foot">版本 {{ appStore.appVersion }} · 本地端口 21808 ~ 21811 · 端口占用会自动避让</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 原实现是 flex-direction:column，侧边栏会占满纵向空间、把主内容挤成 0 高并被 overflow 裁掉。
   改为 grid：左侧栏与主内容同处第一行，底栏通栏第二行。 */
.app-shell { display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr) auto; height:100vh; background:var(--bg); color:var(--text); font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif; overflow:hidden; user-select:none; }
.main-content { grid-column:1; grid-row:1; min-height:0; }
.footer-bar { grid-column:1; grid-row:2; }

/* ─── Main ─── */
.main-content { flex:1; display:flex; flex-direction:column; overflow:hidden; background:var(--bg); }
.topbar { display:flex; align-items:center; justify-content:space-between; padding:10px 20px; background:var(--bg-inset); border-bottom:1px solid var(--border); min-height:44px; }
.breadcrumb { font-size:15px; font-weight:600; color:var(--text); }
.topbar-actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
.icon-btn { padding:5px 12px; border:1px solid var(--border); border-radius:6px; background:transparent; color:var(--text-secondary); font-size:12px; cursor:pointer; }
.icon-btn:hover { background:var(--border); color:var(--text); }

/* ─── 无边框窗口拖动（frame:false）───
   没有 app-region:drag 时按住左键完全拖不动窗口；该属性会向子元素传递命中测试，
   因此所有按钮/菜单/输入控件必须显式 no-drag，否则点击会被系统当成拖动吞掉。 */
.topbar, .footer-bar { -webkit-app-region: drag; user-select:none; }
.topbar-actions, .topbar button, .topbar a, .topbar input, .topbar select,
.topbar textarea, .topbar [role="button"], .topbar [role="menuitem"],
.menu-mask, .menu-pop, .menu-btn,
.footer-bar button, .footer-bar a,
.modal-mask, .help-modal, .app-toast,
.view, .monitor-table, .card { -webkit-app-region: no-drag; }

.view { flex:1; overflow-y:auto; padding:16px 20px; min-height:0; }
/* 窗口整体缩放层：以 1100px 窗口为基准 100%，窗口放大 → 卡片连同文字 / 图标等比放大铺满，
   窗口缩小 → 整体等比缩小不裁切。只作用于内容视图，顶栏 / 底栏的无边框拖动区不受影响。
   CSS zoom 会参与布局重排（不同于 transform:scale 只做视觉缩放留空白）；实测 Chromium 下
   width:100% 会自动按 zoom 反补偿，物理宽度正好铺满父容器，无需 calc(100%/scale)。 */
.view-scaler { zoom:var(--ui-scale, 1); width:100%; display:flex; flex-direction:column; gap:16px; }

.placeholder-view { flex:1; display:flex; align-items:center; justify-content:center; }
.placeholder-card { text-align:center; padding:40px 60px; }
.placeholder-card h3 { margin-bottom:8px; font-size:18px; color:var(--text); }
.placeholder-card p { color:var(--text-secondary); font-size:14px; }
.placeholder-card .sub { color:var(--text-muted); font-size:12px; margin-top:4px; }

/* ─── Cards ─── */
.card { background:linear-gradient(135deg,var(--bg-elevated) 0%,var(--bg-inset) 100%); border:1px solid var(--border); border-radius:12px; padding:16px; }
.top-cards { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
.mid-cards { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }

/* Connection card */
.conn-card { display:flex; flex-direction:column; justify-content:center; align-items:flex-start; gap:10px; min-height:140px; position:relative; overflow:hidden; background:linear-gradient(135deg,var(--card-from) 0%,var(--card-to) 100%); }
.conn-card::before { content:''; position:absolute; inset:0; background:radial-gradient(circle at 80% 50%, rgba(34,197,94,.08), transparent 60%); pointer-events:none; }
.conn-indicator { display:flex; align-items:center; gap:10px; z-index:1; }
.check-icon { width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:700; background:rgba(100,116,139,.14); color:var(--text-muted); }
.conn-card.connected .check-icon { background:rgba(34,197,94,.25); color:var(--green); box-shadow:0 0 24px var(--success-glow), inset 0 0 12px rgba(34,197,94,.2); }
.conn-status { font-size:28px; font-weight:700; color:var(--green); }
.conn-status.off { color:var(--text-secondary); }
.conn-detail { font-size:12px; color:var(--text-secondary); z-index:1; }
.btn-disconnect { padding:8px 20px; border-radius:20px; border:none; background:linear-gradient(135deg,#ef4444,#dc2626); color:#fff; font-size:14px; font-weight:600; cursor:pointer; z-index:1; }
.btn-disconnect:hover { opacity:.9; transform:scale(1.02); }
.btn-connect { padding:8px 20px; border-radius:20px; border:none; background:linear-gradient(135deg,#22c55e,#16a34a); color:#fff; font-size:14px; font-weight:600; cursor:pointer; z-index:1; }
.btn-connect:hover { opacity:.9; }

/* Speed cards */
.speed-card { display:flex; flex-direction:column; justify-content:space-between; min-height:100px; }
.speed-label { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-secondary); }
.dl-icon { color:var(--blue); font-size:16px; }
.up-icon { color:var(--purple); font-size:16px; }
.speed-value { font-size:26px; font-weight:700; color:var(--speed-down); margin:4px 0; }
.speed-value.up { color:var(--speed-up); }
.speed-chart { height:36px; background:repeating-linear-gradient(90deg, transparent, transparent 8px, var(--chart-grid) 8px, var(--chart-grid) 16px); border-radius:4px; position:relative; overflow:hidden; }
.speed-note { font-size:11px; color:var(--warn-text); margin-top:6px; line-height:1.5; word-break:break-all; }
.speed-chart::after { content:''; position:absolute; bottom:0; left:0; right:0; height:60%; background:linear-gradient(to top, var(--chart-fill), transparent); clip-path:polygon(0 80%,15% 50%,30% 65%,45% 30%,60% 55%,75% 20%,90% 45%,100% 10%,100% 100%,0 100%); }
.chart-up::after { background:linear-gradient(to top, var(--chart-fill-up), transparent); clip-path:polygon(0 60%,20% 40%,40% 70%,60% 25%,80% 50%,100% 15%,100% 100%,0 100%); }

/* Acceleration card */
.accel-card { display:flex; flex-direction:column; justify-content:center; background:linear-gradient(135deg,var(--accel-from),var(--accel-to)); }
.accel-title { font-size:15px; font-weight:600; color:var(--accel-title); margin-bottom:4px; }
.accel-desc { font-size:12px; color:var(--text-secondary); }

/* Overview card */
.overview-card { display:flex; flex-direction:column; }
.overview-title { font-size:13px; color:var(--text-secondary); margin-bottom:12px; }
.overview-row { display:flex; align-items:center; justify-content:space-around; flex:1; }
.ov-item { display:flex; flex-direction:column; align-items:center; gap:4px; }
.ov-green, .ov-blue { font-size:28px; }
.ov-number { font-size:22px; font-weight:700; color:var(--text); }
.ov-label { font-size:11px; color:var(--text-muted); }
.ov-divider { width:1px; height:48px; background:var(--border); }

/* Traffic card */
.traffic-card { display:flex; flex-direction:column; }
.traffic-title { font-size:13px; color:var(--text-secondary); margin-bottom:10px; }
.traffic-row { display:flex; gap:16px; margin-bottom:8px; }
.traffic-stat { font-size:12px; color:var(--text-secondary); display:flex; align-items:center; gap:4px; }
.tu { color:var(--green); }
.td { color:var(--blue); }
.traffic-stat strong { color:var(--text); font-size:16px; }
.traffic-chart { flex:1; height:40px; background:repeating-linear-gradient(90deg, transparent, transparent 6px, var(--traffic-grid) 6px, var(--traffic-grid) 12px); border-radius:4px; position:relative; overflow:hidden; }
.traffic-chart::after { content:''; position:absolute; bottom:0; left:0; right:0; height:70%; background:linear-gradient(to top, var(--traffic-fill), transparent); clip-path:polygon(0 70%,10% 40%,20% 55%,30% 25%,40% 60%,50% 35%,60% 50%,70% 20%,80% 45%,90% 30%,100% 50%,100% 100%,0 100%); }

/* Monitor table */
.monitor-card { flex-shrink:0; }
.monitor-header { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
.monitor-title { font-size:14px; font-weight:600; color:var(--text); white-space:nowrap; }
.monitor-live { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--green); }
.live-dot { width:6px; height:6px; border-radius:50%; background:var(--green); animation:pulse 1.5s infinite; }
@keyframes pulse { 0%,100% {opacity:1;} 50% {opacity:.3;} }
.monitor-controls { margin-left:auto; display:flex; gap:8px; align-items:center; }
.filter-select { padding:4px 8px; border:1px solid var(--border); border-radius:6px; background:var(--bg-inset); color:var(--text-secondary); font-size:12px; }
.clear-btn { padding:4px 10px; border:1px solid var(--border); border-radius:6px; background:transparent; color:var(--text-secondary); font-size:12px; cursor:pointer; }
.clear-btn:hover { background:var(--border); color:var(--text); }
.monitor-table { width:100%; border-collapse:collapse; font-size:12px; }
.monitor-table th { text-align:left; padding:6px 8px; color:var(--text-muted); font-weight:500; border-bottom:1px solid var(--border); white-space:nowrap; }
.monitor-table td { padding:6px 8px; color:var(--text-secondary); border-bottom:1px solid var(--table-border); vertical-align:middle; }
.monitor-table tr:hover td { background:var(--nav-hover); }
.proc-icon { font-size:14px; margin-right:6px; }
.status-tag { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500; }
.status-tag.proxy { background:var(--tag-green-bg); color:var(--tag-green-text); }
.status-tag.direct { background:var(--tag-blue-bg); color:var(--tag-blue-text); }
.mono { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--text-secondary); }
.mini-stats { display:flex; gap:6px; font-size:11px; }
.up-arrow { color:var(--green); }
.dn-arrow { color:var(--blue); }
.time-col { color:var(--text-muted); }

/* 首页二维码卡片已移除（功能仍在「二维码识别」页）；
   下面这条 .more-link 仍被「网站代理检测」卡片的「更多」按钮使用，不要删 */
.more-link { font-size:11px; color:var(--text-muted); cursor:pointer; }

/* Sites card */
.sites-card { display:flex; flex-direction:column; }
.sites-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; font-size:13px; color:var(--text); font-weight:500; }
.sites-list { display:flex; flex-direction:column; gap:8px; flex:1; }
.site-row { display:flex; align-items:center; gap:10px; font-size:12px; background:linear-gradient(135deg,var(--bg-elevated) 0%,var(--bg-inset) 100%); border:1px solid var(--border); border-radius:10px; padding:8px 10px; transition:border-color .15s; }
.site-row:hover { border-color:var(--border-strong); }
.site-icon { font-size:18px; }
.site-name { flex:1; color:var(--text-secondary); }
.site-tag { padding:2px 10px; border-radius:10px; font-size:11px; font-weight:500; }
.site-tag.proxy { background:var(--tag-green-bg); color:var(--tag-green-text); }
.site-tag.direct { background:var(--tag-blue-bg); color:var(--tag-blue-text); }
.site-ms { color:var(--text-muted); font-size:11px; font-family:ui-monospace,monospace; }
.btn-test-all { margin-top:8px; padding:8px; border-radius:20px; border:none; background:linear-gradient(135deg,#3b82f6,#1d4ed8); color:#fff; font-size:13px; font-weight:600; cursor:pointer; }
.btn-test-all:hover { opacity:.85; }

/* Footer */
.footer-bar { display:flex; align-items:center; justify-content:space-between; padding:6px 20px; background:var(--bg-inset); border-top:1px solid var(--border); font-size:12px; color:var(--text-muted); }
.footer-left, .footer-right { display:flex; align-items:center; gap:6px; }
.footer-center { display:flex; align-items:center; gap:6px; }
.footer-center strong { color:var(--text-secondary); }
.status-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
.status-dot.green { background:var(--green); box-shadow:0 0 6px var(--success-glow); }
.status-dot.red { background:var(--danger); box-shadow:0 0 6px var(--danger-glow); }
.sep { color:var(--border); }
.signal-icon { font-size:14px; }

/* Scrollbar */
::-webkit-scrollbar { width:6px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
::-webkit-scrollbar-thumb:hover { background:var(--border-strong); }

/* ─── Hub real-status strip / window buttons ─── */
.hub-strip { display:flex; align-items:stretch; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
.hs-item { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; min-width:86px; flex:1 1 86px; padding:12px 14px; background:linear-gradient(135deg,var(--bg-elevated) 0%,var(--bg-inset) 100%); border:1px solid var(--border); border-radius:12px; transition:border-color .15s, transform .15s; }
.hs-item:hover { border-color:var(--border-strong); transform:translateY(-1px); }
.hs-item b { font-size:20px; line-height:1.15; color:var(--text); }
.hs-item span { font-size:11px; color:var(--text-muted); }
.hs-ok { color:var(--success); } .hs-warn { color:var(--warning); }
.hs-note { flex:2 1 300px; min-width:240px; padding:12px 16px; background:linear-gradient(135deg,var(--bg-elevated) 0%,var(--bg-inset) 100%); border:1px solid var(--border); border-radius:12px; font-size:11px; color:var(--text-secondary); line-height:1.7; }
.hs-note b { color:var(--text); font-weight:600; }
.hs-note span { color:var(--text-muted); }
.node-count { font-size:12px; color:var(--accent); margin-right:6px; }
.warn-dot { color:var(--warning); }
.win-btns { display:flex; gap:2px; margin-left:8px; }
.win-btns button { width:28px; height:26px; border:none; background:transparent; color:var(--text-secondary); cursor:pointer; border-radius:4px; font-size:13px; }
.win-btns button:hover { background:var(--surface-hover); color:var(--text); }
.win-btns button.close:hover { background:var(--danger-dim); color:var(--danger); }

/* ─── 顶部帮助弹窗 / 真实事件通知 ─── */
.modal-mask { position:fixed; inset:0; background:rgba(4,12,24,.62); display:flex; align-items:center; justify-content:center; z-index:80; }
.help-modal { width:min(560px,88vw); background:var(--bg-elevated); border:1px solid var(--border-strong); border-radius:14px; box-shadow:var(--menu-shadow); padding:18px 20px; color:var(--text); }
.help-head { display:flex; align-items:center; justify-content:space-between; font-size:15px; margin-bottom:12px; }
.help-head button { background:none; border:none; color:var(--text-muted); font-size:15px; cursor:pointer; }
.help-modal ol { margin:0; padding-left:20px; font-size:12.5px; line-height:1.95; color:var(--text-secondary); }
.help-modal li b { color:var(--text); }
.help-note { margin-top:12px; padding:9px 11px; border:1px solid var(--border); border-radius:8px; background:var(--bg-inset); font-size:11.5px; line-height:1.8; color:var(--text-secondary); }
.help-foot { margin-top:10px; font-size:11px; color:var(--text-muted); }
.app-toast { position:fixed; left:206px; bottom:44px; min-width:360px; max-width:520px; display:flex; align-items:center; gap:11px; padding:11px 13px; border-radius:12px; background:var(--bg-elevated); border:1px solid var(--border-strong); box-shadow:var(--menu-shadow); z-index:70; }
.app-toast.lv-success { border-left:4px solid var(--success); }
.app-toast.lv-error { border-left:4px solid var(--danger); }
.toast-icon { width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex:none; background:var(--success-dim); color:var(--success); font-size:14px; }
.app-toast.lv-error .toast-icon { background:var(--danger-dim); color:var(--danger); }
.toast-body { flex:1; display:flex; flex-direction:column; gap:2px; min-width:0; }
.toast-body b { font-size:12.5px; color:var(--text); }
.toast-body span { font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.toast-link { padding:4px 10px; border:1px solid var(--border); border-radius:6px; background:var(--bg-inset); color:var(--text-secondary); font-size:11px; cursor:pointer; flex:none; }
.toast-link:hover { color:var(--text); }
.toast-x { background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:12px; flex:none; }

/* ─── 真实遥测：空态 / 状态标签 / 探测结果 ─── */
.live-dot.off { background:var(--text-faint); animation:none; }
.status-tag.reject { background:var(--danger-dim); color:var(--danger); }
.status-tag.unknown { background:var(--surface-hover); color:var(--text-muted); }
.empty-row { text-align:center; color:var(--text-muted); font-size:12px; padding:22px 12px; line-height:1.7; }

/* ─── 网络连接监控：四态徽章 + 状态条 + 结构化空态 ─── */
.monitor-header { flex-wrap:wrap; }
.monitor-badges { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.mon-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:12px; font-size:11px; white-space:nowrap; border:1px solid var(--border); background:var(--bg-inset); color:var(--text-secondary); cursor:help; }
.mon-badge em { font-style:normal; color:var(--text-muted); font-size:10px; }
.mon-dot { width:6px; height:6px; border-radius:50%; background:var(--text-faint); flex:none; }
.mon-badge.lv-good { color:var(--success); border-color:var(--success-dim); background:var(--success-dim); }
.mon-badge.lv-good .mon-dot { background:var(--success); animation:pulse 1.5s infinite; }
.mon-badge.lv-warn { color:var(--warning); border-color:var(--warning); }
.mon-badge.lv-warn .mon-dot { background:var(--warning); }
.mon-badge.lv-bad { color:var(--danger); border-color:var(--danger-dim); background:var(--danger-dim); }
.mon-badge.lv-bad .mon-dot { background:var(--danger); }
.mon-badge.lv-idle { color:var(--text-muted); }
.monitor-strip { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:12px; }
.mon-fact { background:linear-gradient(135deg,var(--bg-elevated) 0%,var(--bg-inset) 100%); border:1px solid var(--border); border-radius:12px; padding:10px 12px; display:flex; flex-direction:column; gap:5px; min-width:0; transition:border-color .15s, transform .15s; }
.mon-fact:hover { border-color:var(--border-strong); transform:translateY(-1px); }
.mon-fact span { font-size:11px; color:var(--text-muted); }
.mon-fact b { font-size:13px; color:var(--text); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.empty-cell { padding:0 !important; text-align:left; }
.monitor-table tr:hover .empty-cell { background:transparent; }
.mon-empty { padding:16px 18px; }
.mon-empty-title { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:var(--text); }
.mon-empty-dot { width:8px; height:8px; border-radius:50%; background:var(--warning); flex:none; }
.mon-empty p { margin:7px 0 0; font-size:12px; line-height:1.8; color:var(--text-secondary); }
.mon-empty-advice { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:7px; font-size:11.5px; color:var(--text-muted); }
.mon-empty-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:11px; }
.mon-empty-btn { padding:5px 12px; font-size:11.5px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
.mon-empty-btn.ghost { background:transparent; color:var(--accent); }
.mon-empty-btn:disabled { opacity:.55; cursor:not-allowed; }
.mon-empty-btn:not(:disabled):hover { filter:brightness(1.08); }

.site-row .site-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.site-row .site-ms { flex:none; }

/* ─── 节点体检：逐站通/不通 + 失败原因 + 综合诊断 ─── */
.link-btn { background:none; border:none; padding:0; font:inherit; color:var(--accent); }
.link-btn:hover { text-decoration:underline; }
.site-row { align-items:flex-start; }
.site-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.site-line1 { display:flex; align-items:center; gap:6px; }
.site-group { flex:none; font-size:10px; padding:1px 6px; border-radius:8px; border:1px solid var(--border); color:var(--text-muted); }
.site-group.overseas { color:var(--info-text); background:var(--accent-dim); border-color:transparent; }
.site-group.domestic { color:var(--tag-green-text); background:var(--tag-green-bg); border-color:transparent; }
.site-line2 { display:flex; gap:6px; flex-wrap:wrap; }
.probe-cell { font-size:11px; font-family:var(--font-mono); padding:1px 6px; border-radius:6px; border:1px solid var(--border); color:var(--text-muted); white-space:nowrap; }
.probe-cell.ok { color:var(--success); background:var(--success-dim); border-color:transparent; }
.probe-cell.bad { color:var(--danger); background:var(--danger-dim); border-color:transparent; }
.probe-cell.warn { color:var(--warning); background:var(--accent-dim); border-color:transparent; }
.probe-cell.idle { color:var(--text-faint); }
.site-note { font-size:10px; color:var(--text-muted); line-height:1.35; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.site-row.v-all-fail .site-note, .site-row.v-direct-only .site-note { color:var(--warn-text); }
.probe-hint { margin-top:8px; font-size:10px; color:var(--text-faint); text-align:center; }
.btn-test-all:disabled { opacity:.55; cursor:progress; }
.probe-diagnosis { margin-top:10px; padding:9px 10px; border-radius:var(--radius-md); border:1px solid var(--border); background:var(--bg-inset); font-size:10px; line-height:1.5; max-height:156px; overflow:auto; }
.probe-diagnosis.lv-good { border-color:var(--success); }
.probe-diagnosis.lv-warn { border-color:var(--warning); }
.probe-diagnosis.lv-bad { border-color:var(--danger); }
.probe-diagnosis.lv-idle { border-color:var(--border-strong); }
.diag-title { font-size:11px; font-weight:700; color:var(--text); display:flex; align-items:center; gap:6px; }
.diag-dot { width:7px; height:7px; border-radius:50%; background:var(--text-muted); flex:none; }
.lv-good .diag-dot { background:var(--success); }
.lv-warn .diag-dot { background:var(--warning); }
.lv-bad .diag-dot { background:var(--danger); }
.diag-detail { color:var(--text-secondary); margin-top:4px; }
.diag-advice { color:var(--text-muted); }
.diag-time { color:var(--text-faint); margin-top:4px; font-family:var(--font-mono); }

/* ─── 首页统一自由布局画布（机制与 DashboardHero 一致，scoped 自包含）─── */
.home-toolbar { display:flex; align-items:center; gap:10px; min-height:34px; position:relative; z-index:20; grid-column:1 / -1; }
.ht-tip { font-size:12px; color:var(--text-muted); }
.ht-tip-flash { color:var(--success); font-weight:600; }
.ht-spacer { flex:1; }
.ht-btn { height:30px; padding:0 14px; border:1px solid var(--border); border-radius:8px; background:var(--bg-inset); color:var(--text-secondary); font-size:13px; cursor:pointer; font-family:inherit; }
.ht-btn:hover { color:var(--text); border-color:var(--accent); }
.ht-btn.ghost { color:var(--text-muted); }
.ht-btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.ht-btn.active { color:var(--text); border-color:var(--accent); }

/* 已隐藏模块恢复弹层：从工具条按钮展开，点模块名立刻加回首页 */
.hidden-pop {
  position:absolute; right:0; top:38px; z-index:40; width:min(300px,80vw);
  background:var(--bg-elevated); border:1px solid var(--border-strong); border-radius:12px;
  box-shadow:var(--menu-shadow); padding:10px; display:flex; flex-direction:column; gap:6px;
}
.hp-title { font-size:12px; color:var(--text-muted); padding:0 4px 6px; border-bottom:1px solid var(--border); }
.hp-item { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; border:1px solid var(--border); border-radius:9px; background:var(--bg-inset); color:var(--text-secondary); font-size:13px; font-family:inherit; cursor:pointer; text-align:left; }
.hp-item:hover { color:var(--text); border-color:var(--accent); }
.hp-name { font-weight:500; }
.hp-add { font-size:11px; color:var(--accent); flex:none; }
.hp-tip { font-size:11px; color:var(--text-faint); padding:2px 4px 0; line-height:1.5; }

/* 编辑态卡片右上角：隐藏按钮（与左上拖动、右下缩放互不干扰） */
.mod-hide {
  position:absolute; top:6px; right:6px; z-index:7; width:24px; height:24px; padding:0;
  display:flex; align-items:center; justify-content:center; border:none; border-radius:7px;
  background:rgba(239,68,68,.16); color:var(--danger); font-size:12px; line-height:1;
  font-family:inherit; cursor:pointer; user-select:none; touch-action:none;
}
.mod-hide:hover { background:var(--danger); color:#fff; }

/* 默认（无自定义布局）沿用原排布：顶部横带 / 节点列表 / 状态条 / 监控 / 网站代理检测整宽，
   仪表盘中部三块各占 4 栏。
   首页已移除「二维码识别」卡片（功能仍在二维码识别页），网站代理检测因此独占一行 */
.home-canvas { display:grid; grid-template-columns:repeat(12,1fr); gap:16px; align-items:start; }
.home-canvas > .home-mod[data-mod="heroTop"],
.home-canvas > .home-mod[data-mod="heroNodes"],
.home-canvas > .home-mod[data-mod="hub"],
.home-canvas > .home-mod[data-mod="monitor"],
.home-canvas > .home-mod[data-mod="sites"] { grid-column:1 / -1; }
.home-canvas > .home-mod[data-mod="heroPower"],
.home-canvas > .home-mod[data-mod="heroInfo"],
.home-canvas > .home-mod[data-mod="heroQuick"] { grid-column:span 4; }

/* 编辑态 / 已保存自定义布局：解除栅格，模块绝对定位自由排布 */
.home-canvas.home--edit, .home-canvas.has-custom { position:relative; display:block; }
.home-canvas.home--edit > .home-mod, .home-canvas.has-custom > .home-mod { position:absolute; margin:0; padding:0; }
/* 选中框必须与卡片严丝合缝：outline-offset 归零，不再给模块加 padding 让位。
   历史问题：以前用 padding-top:6px + hero 的 padding-left:48px 给手柄腾地方，
   box-sizing:border-box 会让卡片整体内缩 48px、变矮 6px —— 拖动框、卡片、缩放手柄三套边界对不上。 */
.home-canvas.home--edit > .home-mod { outline:1px dashed var(--border-strong); outline-offset:0; border-radius:12px; }
.home-canvas.home--edit > .home-mod .card, .home-canvas.has-custom > .home-mod .card { height:100%; }
/* 模块盒子 = 卡片盒子：内部的卡片/横带一律撑满，拖多大卡片就多大 */
.home-canvas.home--edit > .home-mod, .home-canvas.has-custom > .home-mod { display:flex; flex-direction:column; }
.home-canvas.home--edit > .home-mod > .dash, .home-canvas.has-custom > .home-mod > .dash { flex:1 1 auto; min-height:0; }
.home-canvas.home--edit > .home-mod > .dash > .card,
.home-canvas.home--edit > .home-mod > .dash > .dash-top,
.home-canvas.home--edit > .home-mod > .dash > .power-cell,
.home-canvas.has-custom > .home-mod > .dash > .card,
.home-canvas.has-custom > .home-mod > .dash > .dash-top,
.home-canvas.has-custom > .home-mod > .dash > .power-cell { flex:1 1 auto; min-height:0; }
.home-canvas.home--edit > .home-mod > .hub-strip, .home-canvas.has-custom > .home-mod > .hub-strip { flex:1 1 auto; min-height:0; margin-bottom:0; }

/* DashboardHero 拆成独立卡片后，内部旧布局系统已退役（编辑态不可达，手柄永不渲染），无需再屏蔽 */

/* 磁吸对齐辅助线：只在拖动/缩放靠近边缘时短暂出现 */
.snap-guide { position:absolute; z-index:9; pointer-events:none; background:var(--accent); opacity:.85; box-shadow:0 0 6px rgba(59,130,246,.55); }
.snap-v { top:0; bottom:0; width:1px; }
.snap-h { left:0; right:0; height:1px; }

/* 拖动手柄（模块左上角）与缩放手柄（右下角）：只有点「编辑布局」进入编辑态才出现；
   平时完全隐藏且不接收点击，卡片是固定展示态，避免误拖打乱已排好的布局 */
.mod-grip {
  /* 统一贴在卡片上边线外侧：底边贴住卡片顶边，高 16px 正好放进模块间距，
     所有模块位置完全一致，也不遮卡片里的任何内容（以前在卡片内左上角，会盖住标题）。 */
  position:absolute; top:0; left:0; transform:translateY(-100%); z-index:6;
  display:flex; align-items:center; gap:4px; height:16px; padding:0 7px;
  border-radius:6px 6px 0 0; background:var(--accent); color:#fff; font-size:10px; line-height:1;
  cursor:move; user-select:none; white-space:nowrap; touch-action:none;
  opacity:0; pointer-events:none; transition:opacity .12s;
}
.mod-grip::before { content:'⠿'; font-size:11px; line-height:1; }
.mod-resize {
  position:absolute; right:3px; bottom:3px; width:16px; height:16px; z-index:6; cursor:nwse-resize;
  border-right:2px solid var(--text-muted); border-bottom:2px solid var(--text-muted); touch-action:none;
  opacity:0; transition:opacity .12s;
}
.home-canvas.home--edit .mod-grip { opacity:1; pointer-events:auto; }
.home-canvas.home--edit .mod-resize { opacity:1; }
.home-canvas.home--edit .mod-grip, .home-canvas.home--edit .mod-resize { box-shadow:0 0 0 1px rgba(59,130,246,.4); }
/* 编辑态下整卡提示可拖：虚线框 + 轻微上浮，和平时展示态区分开。
   高亮用 inset 描边画在卡片内侧，不会让卡片看起来被放大一圈。 */
.home-canvas.home--edit > .home-mod:hover { box-shadow:inset 0 0 0 2px var(--accent), 0 6px 18px rgba(0,0,0,.25); }

/* ─── 汉堡菜单（取消常驻导航栏后的功能入口弹层）─── */
.menu-mask { position:fixed; inset:0; background:rgba(4,12,24,.55); display:flex; align-items:flex-start; justify-content:center; z-index:90; padding-top:60px; -webkit-app-region:no-drag; }
.menu-pop { width:min(420px,92vw); max-height:72vh; overflow-y:auto; background:var(--bg-elevated); border:1px solid var(--border-strong); border-radius:14px; box-shadow:var(--menu-shadow); padding:10px; display:flex; flex-direction:column; gap:4px; }
.menu-head { display:flex; align-items:center; justify-content:space-between; padding:4px 8px 10px; border-bottom:1px solid var(--border); margin-bottom:4px; }
.menu-head b { font-size:14px; color:var(--text); }
.menu-close { background:none; border:none; color:var(--text-muted); font-size:14px; cursor:pointer; }
.menu-close:hover { color:var(--text); }
.menu-item { display:flex; align-items:center; gap:12px; padding:10px 12px; border:none; border-radius:10px; background:transparent; color:var(--text-secondary); text-align:left; cursor:pointer; font-family:inherit; font-size:13px; }
.menu-item:hover { background:var(--surface-hover); color:var(--text); }
.menu-item.active { background:linear-gradient(135deg,var(--nav-active-from) 0%,var(--nav-active-to) 100%); color:var(--nav-active-text); }
.menu-icon { font-size:18px; flex:none; width:22px; text-align:center; }
.menu-label { font-weight:500; flex:none; min-width:72px; }
.menu-sub { font-size:11px; color:var(--text-muted); margin-left:auto; }
.menu-item.active .menu-sub { color:var(--nav-active-text); opacity:.8; }
</style>