<script setup lang="ts">
/**
 * 首页仪表盘 —— 按「全能代理助手深色仪表盘」参考图 1:1 复刻布局与图标尺寸。
 *
 * 图标尺寸红线（见 <style> 顶部变量）：全部按参考图给定像素，不擅自放大/缩小/换风格。
 * 数据红线：数值只来自内核真实遥测与真实测速结果，没数据写「— / 未测速 / 等待采样」，
 * 绝不生成演示节点、假延迟、假速率或假曲线。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAppStore } from '../store.js'
import { formatSpeed } from '../../core/runtime/telemetry.js'
import { SPEED_GRADE_LABELS, formatMbps, formatBytes } from '../../core/runtime/speedtest.js'
import type { UnifiedNode } from '../../core/hub/model.js'
import {
  REGIONS, OTHER_REGION as OTHER, regionOf, regionCode,
  displayCodeOf, countryLabelOf, flagSourceOf,
} from '../regions.js'
import FlagIcon from './FlagIcon.vue'

/** 国旗与地区名：规则在 regions.ts，与节点管家共用同一份（避免两处漂移） */
const displayCode = (n: UnifiedNode) => displayCodeOf(n, store.geoCode)
const countryLabel = (n: UnifiedNode) => countryLabelOf(n, store.geoCode)
const flagSource = (n: UnifiedNode) => flagSourceOf(n, store.geoCode)

const emit = defineEmits<{ navigate: [tab: string, mode?: string] }>()
/**
 * 拆分模式：首页画布把仪表盘拆成 5 张独立卡片统一管理（顶部横带 / 大圆连接 / 节点信息 /
 * 快捷操作 / 节点列表）。part 不传或为 'all' 时保持原整体渲染。
 */
const props = defineProps<{ part?: 'all' | 'top' | 'power' | 'info' | 'quick' | 'nodes' }>()
const isPart = computed(() => !!props.part && props.part !== 'all')
const show = (p: 'top' | 'power' | 'info' | 'quick' | 'nodes') => !isPart.value || props.part === p
const store = useAppStore()

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
  // 节点列表可见即补齐归属地：只查「节点名识别不出地区」的，带 30 天缓存，查不到也不打扰界面
  if (show('nodes') && store.nodes.some(n => !regionCode(n))) {
    store.lookupGeo().catch(() => { /* 静默：失败原因已写入运行日志 */ })
  }
})
onUnmounted(() => { if (ticker) clearInterval(ticker) })

const proxyOn = computed(() => store.runtime.state === 'running')
const runtimeLabel = computed(() => {
  const s = store.runtime.state
  return s === 'running' ? '已连接' : s === 'starting' ? '连接中…' : s === 'stopping' ? '断开中…' : s === 'error' ? '连接失败' : '未连接'
})
const t = computed(() => store.telemetry)
const downText = computed(() => formatSpeed(t.value.downSpeed))
const upText = computed(() => formatSpeed(t.value.upSpeed))
const history = computed(() => t.value.history)

/** 真实采样点画面积曲线；没有采样点时返回空，由模板显示「等待真实采样」 */
function series(kind: 'down' | 'up') {
  const pts = history.value
  if (pts.length < 2) return { line: '', area: '' }
  const vals = pts.map(p => kind === 'down' ? p.down : p.up)
  const max = Math.max(1, ...vals)
  const step = 100 / (vals.length - 1)
  const line = vals.map((v, i) => `${(i * step).toFixed(1)},${(36 - (v / max) * 30).toFixed(1)}`).join(' ')
  return { line, area: `0,40 ${line} 100,40` }
}
const downSeries = computed(() => series('down'))
const upSeries = computed(() => series('up'))

const duration = computed(() => {
  const start = store.runtime.startedAt
  if (!start) return '00:00:00'
  const s = Math.max(0, Math.floor((now.value - start) / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
})

const currentNode = computed<UnifiedNode | null>(() =>
  store.nodes.find(n => n.id === store.runtime.node?.id) ?? null)
const currentId = computed(() => store.runtime.node?.id ?? '')

function delayText(id: string): string {
  const row = store.speedRows[id]
  return row?.latencyMs != null ? `${Math.round(row.latencyMs)} ms` : '未测速'
}
/** 真实测速带宽（Mbps，字段原单位），内核不提供单节点实时上行速率，故上行恒为 — */
function downBw(id: string): string {
  const v = store.speedRows[id]?.mbps
  return v != null ? `${v.toFixed(1)} Mbps` : '—'
}
const info = computed(() => {
  const r = store.runtime
  const n = currentNode.value
  const rn = r.node
  if (!n && !rn) return null
  return {
    name: n?.name ?? rn?.name ?? '—',
    delay: delayText(currentId.value),
    protocol: n
      ? `${String(n.protocol).toUpperCase()}${n.reality ? ' + REALITY' : ''}${n.flow ? ' + ' + n.flow : ''}`
      : String(rn?.protocol ?? '—').toUpperCase(),
    address: n?.server ?? rn?.server ?? '—',
    port: n?.port ?? rn?.port ?? '—',
    transport: n
      ? `${n.transport}${n.security && n.security !== 'none' ? ' + ' + String(n.security).toUpperCase() : ''}`
      : '—',
    kernel: r.kernel ?? '—',
    source: n?.source ?? '—',
  }
})

/** 节点信息卡左上角的国旗：优先当前节点完整对象；内核上报的简化节点也走同一套地区规则 */
const infoLikeNode = computed<UnifiedNode | null>(() => {
  if (currentNode.value) return currentNode.value
  const rn = store.runtime.node
  if (!rn) return null
  return { name: rn.name, server: rn.server, protocolAlias: '' } as unknown as UnifiedNode
})
const infoCode = computed(() => infoLikeNode.value ? displayCodeOf(infoLikeNode.value, store.geoCode) : '')
const infoCountry = computed(() => infoLikeNode.value ? countryLabelOf(infoLikeNode.value, store.geoCode) : '')
const infoFlagTitle = computed(() => {
  if (!infoLikeNode.value) return '未连接节点'
  return (infoCountry.value ? infoCountry.value + ' · ' : '') + flagSourceOf(infoLikeNode.value, store.geoCode)
})

/* 「延迟」标签就地展开：直接在这张卡里显示网速 / ping，不跳到节点管家。
   数据全部取自真实真连测速结果（store.speedRows），没测过就给「就地测速」按钮，
   点了也是在当前卡片里回填，绝不生成估算值。 */
const speedOpen = ref(false)
const speedRow = computed(() => store.speedRows[currentId.value] ?? null)
const speedBusy = computed(() => store.speedBusy)
const speedPhase = computed(() => {
  const r = speedRow.value
  if (!r) return '未测速'
  if (r.phase === 'error') return '不可用'
  if (r.phase === 'cancelled') return '已取消'
  if (r.phase !== 'done') return '测速中…'
  return SPEED_GRADE_LABELS[r.grade]
})
async function measureHere() {
  const n = currentNode.value
  if (!n || speedBusy.value) return
  await store.startSpeedTest([n])
}

async function toggleConnect() {
  const r = await store.toggleConnection()
  if (r.action === 'no-nodes') emit('navigate', 'config')
}

async function connectNode(n: UnifiedNode) {
  await store.activateNode(n)
}

/* ───────── 地区分组：规则集中在 renderer/regions.ts（与节点列表共用），
   只按节点名里真实存在的地区关键词归类，不猜测、不编造计数；匹配不到归「其他地区」保留 🌐。 */
/* 地区规则见 renderer/regions.ts：REGIONS / regionOf / regionCode 均从那里导入 */

/* 自定义分组：关键词匹配节点名，持久化到 localStorage（真实可用的「添加分组」） */
const CUSTOM_KEY = 'upc.dash.groups.v1'
function loadGroups(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 8) : []
  } catch { return [] }
}
const customGroups = ref<string[]>(loadGroups())
const addingGroup = ref(false)
const groupInput = ref('')
function commitGroup() {
  const v = groupInput.value.trim()
  if (v && !customGroups.value.includes(v) && customGroups.value.length < 8) {
    customGroups.value = [...customGroups.value, v]
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(customGroups.value)) } catch { /* 隐私模式下忽略 */ }
  }
  groupInput.value = ''
  addingGroup.value = false
}

const keyword = ref('')
const sortKey = ref<'name' | 'latency' | 'protocol'>('latency')
const activeGroup = ref('all')
const measuredCount = computed(() => store.nodes.filter(n => store.speedRows[n.id]?.latencyMs != null).length)

/** 「自动选择」：按真实测速延迟挑最快节点；没测过就带去节点管家一键全检，不随便猜一个 */
async function autoSelect() {
  const measured = store.nodes.filter(n => store.speedRows[n.id]?.latencyMs != null)
  if (!measured.length) { emit('navigate', 'nodes'); return }
  measured.sort((a, b) => (store.speedRows[a.id]?.latencyMs ?? 1e9) - (store.speedRows[b.id]?.latencyMs ?? 1e9))
  await connectNode(measured[0]!)
}

function inGroup(n: UnifiedNode, key: string): boolean {
  if (key === 'all') return true
  if (key.startsWith('region:')) return regionOf(n) === key.slice(7)
  if (key.startsWith('custom:')) return n.name.toLowerCase().includes(key.slice(7).toLowerCase())
  return true
}
const visibleNodes = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = store.nodes.filter(n => {
    if (!inGroup(n, activeGroup.value)) return false
    if (!kw) return true
    return [n.name, n.server, n.protocol, n.kernel ?? ''].some(v => String(v).toLowerCase().includes(kw))
  })
  const sorted = [...list]
  if (sortKey.value === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
  else if (sortKey.value === 'protocol') sorted.sort((a, b) => a.protocol.localeCompare(b.protocol))
  else sorted.sort((a, b) => {
    const la = store.speedRows[a.id]?.latencyMs ?? Number.POSITIVE_INFINITY
    const lb = store.speedRows[b.id]?.latencyMs ?? Number.POSITIVE_INFINITY
    return la - lb
  })
  return sorted
})

/** 信号柱：由真实延迟算格数，未测速全灰，不编造强弱 */
function signalLevel(id: string): number {
  const ms = store.speedRows[id]?.latencyMs
  if (ms == null) return 0
  if (ms < 50) return 4
  if (ms < 100) return 3
  if (ms < 200) return 2
  return 1
}
const quick = (tab: string, mode?: string) => emit('navigate', tab, mode)

</script>

<template>
  <div class="dash" :class="{ 'dash--part': isPart }">

    <!-- 线性图标库：24×24 viewBox，stroke 继承 currentColor；尺寸由下面的固定变量控制 -->
    <svg class="ic-defs" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <symbol id="ic-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="ic-arrow-down" viewBox="0 0 24 24"><path d="M12 3v16m0 0l-6-6m6 6l6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="ic-arrow-up" viewBox="0 0 24 24"><path d="M12 21V5m0 0L6 11m6-6l6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="ic-rocket" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 00-2.9-.1z"/><path d="M12 15l-3-3a22 22 0 012-4A12.9 12.9 0 0122 2c0 2.7-.8 7.5-6 11a22 22 0 01-4 2z"/><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/></g><circle cx="15.2" cy="8.8" r="1.5" fill="currentColor"/></symbol>
      <symbol id="ic-qr-scan" viewBox="0 0 24 24"><path d="M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 12h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
      <symbol id="ic-image" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.5" cy="9.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 17l4.5-4.5 3.5 3.5 3-3 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="ic-clipboard" viewBox="0 0 24 24"><rect x="5" y="4.5" width="14" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 4.5V3.6A1.1 1.1 0 0110.1 2.5h3.8A1.1 1.1 0 0115 3.6v.9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 11h6M9 15h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
      <symbol id="ic-folder" viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2.2h9A1.5 1.5 0 0121 9.7v8.8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></symbol>
      <symbol id="ic-badge" viewBox="0 0 24 24"><path d="M12 2.8l2.3 2 3-.3 1 2.9 2.6 1.6-1 2.9 1 2.9-2.6 1.6-1 2.9-3-.3-2.3 2-2.3-2-3 .3-1-2.9L3.1 15l1-2.9-1-2.9 2.6-1.6 1-2.9 3 .3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 8.2l1.1 2.3 2.5.3-1.8 1.8.4 2.5-2.2-1.2-2.2 1.2.4-2.5-1.8-1.8 2.5-.3z" fill="currentColor"/></symbol>
      <symbol id="ic-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 12h18M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z" fill="none" stroke="currentColor" stroke-width="1.6"/></symbol>
      <symbol id="ic-plug" viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-6 6 6 6 0 01-6-6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 17v4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
      <symbol id="ic-layers" viewBox="0 0 24 24"><path d="M12 3l8 4.5-8 4.5-8-4.5zM4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="ic-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M15.5 15.5L21 21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
      <symbol id="ic-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 10-2.3 6.3M20 5v6h-6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></symbol>
      <symbol id="ic-bolt" viewBox="0 0 24 24"><path d="M13.5 2L5 13.5h6L10.5 22 19 10.5h-6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></symbol>
      <symbol id="ic-grid" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.8"/></symbol>
      <symbol id="ic-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="ic-more" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/></symbol>
      <symbol id="ic-dots" viewBox="0 0 24 24"><path d="M4 12h2M11 12h2M18 12h2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></symbol>
      <symbol id="ic-flower" viewBox="0 0 24 24"><g fill="currentColor"><circle cx="12" cy="6.4" r="3.5"/><circle cx="17.5" cy="10.1" r="3.5"/><circle cx="15.4" cy="16.9" r="3.5"/><circle cx="8.6" cy="16.9" r="3.5"/><circle cx="6.5" cy="10.1" r="3.5"/></g><circle cx="12" cy="12" r="2.3" fill="#e0453f"/></symbol>
    </svg>

    <!-- ① 顶部横带：连接状态 | 下载 | 上传 -->
    <div v-if="show('top')" class="dash-top">
      <div class="top-cell status" :class="{ on: proxyOn }">
        <span class="status-check"><svg style="width:22px;height:22px"><use href="#ic-check"/></svg></span>
        <div class="status-text">
          <b>{{ runtimeLabel }}</b>
          <span>当前节点：{{ store.runtime.node?.name ?? '—' }} <i>|</i> 延迟：{{ currentId ? delayText(currentId) : '—' }}</span>
        </div>
      </div>
      <div class="top-cell speed">
        <div class="sp-label"><svg class="ic ic-arrow"><use href="#ic-arrow-down"/></svg> 下载</div>
        <div class="sp-value down">{{ downText }}</div>
        <svg class="sp-chart" viewBox="0 0 100 40" preserveAspectRatio="none" aria-label="真实下行速率曲线">
          <defs><linearGradient id="grad-down" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.55"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient></defs>
          <template v-if="downSeries.line">
            <polygon :points="downSeries.area" fill="url(#grad-down)" />
            <polyline class="sp-line down" :points="downSeries.line" fill="none" stroke-width="1.8" vector-effect="non-scaling-stroke" />
          </template>
          <text v-else x="50" y="24" text-anchor="middle" fill="var(--text-muted)" font-size="8">等待真实采样</text>
        </svg>
      </div>
      <div class="top-cell speed">
        <div class="sp-label"><svg class="ic ic-arrow"><use href="#ic-arrow-up"/></svg> 上传</div>
        <div class="sp-value up">{{ upText }}</div>
        <svg class="sp-chart" viewBox="0 0 100 40" preserveAspectRatio="none" aria-label="真实上行速率曲线">
          <defs><linearGradient id="grad-up" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--purple);stop-opacity:.55"/><stop offset="1" style="stop-color:var(--purple);stop-opacity:0"/></linearGradient></defs>
          <template v-if="upSeries.line">
            <polygon :points="upSeries.area" fill="url(#grad-up)" />
            <polyline class="sp-line up" :points="upSeries.line" fill="none" stroke-width="1.8" vector-effect="non-scaling-stroke" />
          </template>
          <text v-else x="50" y="24" text-anchor="middle" fill="var(--text-muted)" font-size="8">等待真实采样</text>
        </svg>
      </div>
    </div>

    <!-- ② 中部：大圆连接按钮 | 节点信息 | 快捷操作 -->
    <div v-if="show('power') || show('info') || show('quick')" class="dash-mid">
      <div v-if="show('power')" class="power-cell">
        <button class="power-ring" :class="{ on: proxyOn, busy: store.runtimeBusy }" :disabled="store.runtimeBusy" @click="toggleConnect">
          <svg class="ic-rocket"><use href="#ic-rocket"/></svg>
          <b>{{ proxyOn ? '断开连接' : '开始连接' }}</b>
          <small>{{ duration }}</small>
        </button>
      </div>

      <div v-if="show('info')" class="card dash-info">
        <div class="sec-title">节点信息</div>
        <div class="info-head">
          <span class="info-flag" :class="{ 'has-flag': !!infoCode }" :title="infoFlagTitle">
            <FlagIcon v-if="infoCode" :code="infoCode" :size="20" />
            <svg v-else class="ic ic-flower"><use href="#ic-flower"/></svg>
          </span>
          <b class="info-name">{{ info?.name ?? '—' }}</b>
          <button type="button" :class="['delay-tag', 'delay-btn', { idle: !info || info.delay === '未测速', open: speedOpen }]"
                  :title="speedOpen ? '收起网速 / ping 详情' : '点击就地查看网速与 ping（不跳转）'"
                  @click="speedOpen = !speedOpen">
            {{ info && info.delay !== '未测速' ? '延迟 ' + info.delay : '未测速' }}
            <span class="delay-caret">{{ speedOpen ? '▴' : '▾' }}</span>
          </button>
        </div>
        <dl class="info-grid">
          <div><dt><svg class="ic ic-info"><use href="#ic-badge"/></svg></dt><dd><label>协议</label><span>{{ info?.protocol ?? '—' }}</span></dd></div>
          <div><dt><svg class="ic ic-info"><use href="#ic-globe"/></svg></dt><dd><label>地址</label><span class="mono">{{ info?.address ?? '—' }}</span></dd></div>
          <div><dt><svg class="ic ic-info"><use href="#ic-plug"/></svg></dt><dd><label>端口</label><span class="mono">{{ info?.port ?? '—' }}</span></dd></div>
          <div><dt><svg class="ic ic-info"><use href="#ic-layers"/></svg></dt><dd><label>传输</label><span>{{ info?.transport ?? '—' }}</span></dd></div>
        </dl>
        <!-- 点「延迟」就地展开：网速 / ping / 首字节 / 实测下载，全程不跳页 -->
        <div v-if="speedOpen" class="info-speed">
          <div class="info-speed-head">
            <b>当前节点测速</b>
            <button type="button" class="btn mini" :disabled="!currentNode || speedBusy"
                    :title="currentNode ? '对当前节点做一次真实下载测速，结果就地回填' : '当前节点信息不完整，无法就地测速'"
                    @click="measureHere">
              {{ speedBusy ? '测速中…' : speedRow ? '重新测速' : '就地测速' }}
            </button>
          </div>
          <div class="info-speed-grid">
            <div><label>Ping / 握手</label><span>{{ speedRow?.latencyMs != null ? speedRow.latencyMs + ' ms' : '—' }}</span></div>
            <div><label>网速 / 下载</label><span class="hi">{{ speedRow?.mbps != null ? formatMbps(speedRow.mbps) : '—' }}</span></div>
            <div><label>首字节</label><span>{{ speedRow?.ttfbMs != null ? speedRow.ttfbMs + ' ms' : '—' }}</span></div>
            <div><label>实测下载</label><span>{{ speedRow?.bytes ? formatBytes(speedRow.bytes) : '—' }}</span></div>
          </div>
          <div class="info-speed-foot">
            <span :class="['speed-grade', { ok: speedRow?.phase === 'done', bad: speedRow?.phase === 'error' }]">{{ speedPhase }}</span>
            <span v-if="speedRow?.error" class="tiny dim">{{ speedRow.error }}</span>
            <span v-else-if="!speedRow" class="tiny dim">还没有测速结果，点「就地测速」用真实下载检验当前节点</span>
            <span v-else class="tiny dim">数据来自真实真连测速，不估算</span>
          </div>
        </div>
        <div v-if="!info" class="info-empty">连上节点后显示真实参数，不预填演示数据</div>
      </div>

      <div v-if="show('quick')" class="card dash-quick">
        <div class="sec-title">快捷操作</div>
        <div class="quick-grid">
          <button @click="quick('qrcode', 'camera')"><svg class="ic ic-quick"><use href="#ic-qr-scan"/></svg><span>二维码扫描</span></button>
          <button @click="quick('qrcode', 'file')"><svg class="ic ic-quick"><use href="#ic-image"/></svg><span>导入图片</span></button>
          <button @click="quick('qrcode', 'clipboard')"><svg class="ic ic-quick"><use href="#ic-clipboard"/></svg><span>剪贴板识别</span></button>
          <button @click="quick('config')"><svg class="ic ic-quick"><use href="#ic-folder"/></svg><span>导入配置</span></button>
        </div>
      </div>
    </div>

    <!-- ③ 节点列表：左侧分组栏 + 右侧搜索 / 节点行 -->
    <div v-if="show('nodes')" class="card dash-nodes">
      <div class="nodes-top">
        <div class="sec-title nodes-title">节点列表</div>
        <label class="nodes-search">
          <svg class="ic ic-search"><use href="#ic-search"/></svg>
          <input v-model="keyword" placeholder="搜索节点名称..." />
        </label>
        <select v-model="sortKey" class="nodes-sort" title="排序依据">
          <option value="latency">测速排序</option>
          <option value="name">按名称</option>
          <option value="protocol">按协议</option>
        </select>
        <button class="nodes-refresh" title="刷新运行状态与遥测" @click="store.refreshRuntime()"><svg class="ic ic-refresh"><use href="#ic-refresh"/></svg></button>
      </div>
      <div class="nodes-body">
        <aside class="node-groups">
          <button :class="['group-btn', { on: activeGroup === 'all' }]" @click="activeGroup = 'all'">
            <svg class="ic ic-group"><use href="#ic-grid"/></svg><span>全部节点</span><em>({{ store.nodes.length }})</em>
          </button>
          <button class="group-btn auto" @click="autoSelect" :title="measuredCount ? '按真实测速延迟自动连接最快节点' : '还没有测速结果，先去节点管家一键全检'">
            <svg class="ic ic-group"><use href="#ic-bolt"/></svg><span>自动选择</span><em>({{ measuredCount }})</em>
          </button>
          <button v-for="r in REGIONS" :key="r.key" :class="['group-btn', { on: activeGroup === 'region:' + r.key, empty: !store.nodes.some(n => regionOf(n) === r.key) }]" @click="activeGroup = 'region:' + r.key">
            <span class="grp-flag"><FlagIcon :code="r.code" :size="16" /></span><span>{{ r.key }}</span><em>({{ store.nodes.filter(n => regionOf(n) === r.key).length }})</em>
          </button>
          <button :class="['group-btn', { on: activeGroup === 'region:' + OTHER }]" @click="activeGroup = 'region:' + OTHER">
            <svg class="ic ic-group"><use href="#ic-dots"/></svg><span>{{ OTHER }}</span><em>({{ store.nodes.filter(n => regionOf(n) === OTHER).length }})</em>
          </button>
          <button v-for="g in customGroups" :key="g" :class="['group-btn', { on: activeGroup === 'custom:' + g }]" @click="activeGroup = 'custom:' + g">
            <svg class="ic ic-group"><use href="#ic-folder"/></svg><span :title="g">{{ g }}</span><em>({{ store.nodes.filter(n => n.name.toLowerCase().includes(g.toLowerCase())).length }})</em>
          </button>
          <div v-if="addingGroup" class="group-add-row">
            <input v-model="groupInput" placeholder="分组关键词" @keydown.enter="commitGroup" @keydown.esc="addingGroup = false" />
            <button title="确定" @click="commitGroup"><svg class="ic ic-group"><use href="#ic-check"/></svg></button>
          </div>
          <button v-else class="group-btn add" @click="addingGroup = true">
            <svg class="ic ic-group"><use href="#ic-plus"/></svg><span>添加分组</span>
          </button>
        </aside>

        <div class="node-rows">
          <div v-for="n in visibleNodes" :key="n.id" :class="['node-row', { current: currentId === n.id && proxyOn }]">
            <span class="node-radio" :class="{ on: currentId === n.id && proxyOn }"></span>
            <FlagIcon :code="displayCode(n)" :title="flagSource(n)" :size="20" />
            <span class="node-country" :title="flagSource(n)">{{ countryLabel(n) || '未识别' }}</span>
            <span class="node-name" :title="`${n.server}:${n.port}`">{{ n.name }}</span>
            <span :class="['delay-tag', { idle: store.speedRows[n.id]?.latencyMs == null }]">{{ delayText(n.id) }}</span>
            <span class="node-bw mono" title="真实测速结果；内核不提供单节点实时上行速率，故不编造">↑ —</span>
            <span class="node-bw mono" title="真实测速下载带宽">↓ {{ downBw(n.id) }}</span>
            <svg class="ic ic-signal" :class="'lv-' + signalLevel(n.id)" viewBox="0 0 24 24" aria-label="真实延迟信号等级">
              <rect x="2" y="16" width="4" height="6" rx="1"/><rect x="8" y="12" width="4" height="10" rx="1"/>
              <rect x="14" y="8" width="4" height="14" rx="1"/><rect x="20" y="3" width="3" height="19" rx="1"/>
            </svg>
            <button :class="['node-connect', { on: currentId === n.id && proxyOn }]" :disabled="store.runtimeBusy || (currentId === n.id && proxyOn)" @click="connectNode(n)">
              {{ currentId === n.id && proxyOn ? '已连接' : proxyOn ? '切换' : '连接' }}
            </button>
            <button class="node-more" title="在节点管理里查看完整配置" @click="quick('nodes')"><svg class="ic ic-more"><use href="#ic-more"/></svg></button>
          </div>
          <div v-if="!visibleNodes.length" class="node-empty">
            <b>{{ store.nodes.length ? '没有匹配的节点' : '还没有导入任何节点' }}</b>
            <span>{{ store.nodes.length ? '换个关键词或切回「全部节点」' : '先导入配置 / 订阅，或用二维码识别添加节点' }}</span>
            <button v-if="!store.nodes.length" @click="quick('config')">去导入配置</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dash {
  display:flex; flex-direction:column; gap:14px; flex:none;
  /* ── 图标尺寸：严格按参考图，勿擅自调整 ── */
  --ic-check: 40px;    /* 状态圆形对勾 */
  --ic-rocket: 48px;   /* 大圆内火箭 */
  --ic-quick: 30px;    /* 快捷操作四宫格 */
  --ic-info: 16px;     /* 节点信息行 */
  --ic-group: 16px;    /* 左侧分组栏 */
  --ic-search: 16px;
  --ic-refresh: 20px;
  --ic-flag: 20px;     /* 节点行地区标 */
  --ic-signal: 18px;
  --ic-more: 16px;
  --ic-arrow: 18px;    /* 下载 / 上传箭头 */
  --ring: #2fe3c8;
}
.ic-defs { position:absolute; width:0; height:0; overflow:hidden; }
.ic { display:block; flex:none; }
.ic-arrow { width:var(--ic-arrow); height:var(--ic-arrow); }
.ic-quick { width:var(--ic-quick); height:var(--ic-quick); }
.ic-info { width:var(--ic-info); height:var(--ic-info); }
.ic-group { width:var(--ic-group); height:var(--ic-group); }
.ic-search { width:var(--ic-search); height:var(--ic-search); }
.ic-refresh { width:var(--ic-refresh); height:var(--ic-refresh); }
.ic-signal { width:var(--ic-signal); height:var(--ic-signal); }
.ic-more { width:var(--ic-more); height:var(--ic-more); }
.ic-flower { width:14px; height:14px; }
/* 国旗改用本地 SVG（FlagIcon.vue），不再依赖 emoji 字体栈 —— Windows 上 emoji 会退化成字母框 */
.dash .card { background:var(--card-from); border:1px solid var(--border); border-radius:14px; }
.sec-title { font-size:17px; font-weight:700; color:var(--text); margin:0 0 14px; }
.mono { font-family:var(--font-mono); }

/* ① 顶部横带：三格共用一条带，竖线分隔 */
.dash-top { display:grid; grid-template-columns:1.6fr 1fr 1fr; background:var(--card-from); border:1px solid var(--border); border-radius:14px; overflow:hidden; }
.top-cell { position:relative; padding:16px 20px; min-height:118px; }
.top-cell + .top-cell { border-left:1px solid var(--border); }
.status { display:flex; align-items:center; gap:14px; }
.status-check { width:var(--ic-check); height:var(--ic-check); border-radius:50%; display:flex; align-items:center; justify-content:center; flex:none; background:var(--danger-dim); color:var(--danger); }
.status.on .status-check { background:var(--success); color:#fff; box-shadow:0 0 18px rgba(34,197,94,.45); }
.status-text { display:flex; flex-direction:column; gap:6px; min-width:0; }
.status-text b { font-size:26px; font-weight:700; line-height:1.1; color:var(--text-secondary); }
.status.on .status-text b { color:var(--success); }
.status-text > span { font-size:13px; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.status-text i { color:var(--text-faint); font-style:normal; margin:0 6px; }
.sp-label { display:flex; align-items:center; gap:8px; font-size:14px; color:var(--text-secondary); }
.sp-label .ic-arrow:first-child { color:var(--speed-down); }
.speed:last-child .sp-label .ic-arrow:first-child { color:var(--speed-up); }
.sp-value { font-size:26px; font-weight:700; margin-top:8px; line-height:1.1; }
.sp-value.down { color:var(--speed-down); }
.sp-value.up { color:var(--speed-up); }
.sp-line.down { stroke:var(--speed-down); }
.sp-line.up { stroke:var(--speed-up); }
.sp-chart { position:absolute; right:14px; bottom:12px; width:52%; height:52px; }

/* ② 中部三列：左侧大圆无卡片底，中右为卡片 */
.dash-mid { display:grid; grid-template-columns:1.1fr 1.15fr 1fr; gap:14px; align-items:stretch; }
/* 拆分模式（首页画布逐块管理）：大圆这一块单独成卡，其余块本身已是卡片 */
.dash--part { gap:0; }
.dash--part .dash-mid { grid-template-columns:1fr; gap:0; }
.dash--part .power-cell { background:var(--card-from); border:1px solid var(--border); border-radius:14px; padding:18px; }
.power-cell { display:flex; align-items:center; justify-content:center; padding:6px 0; }
.power-ring {
  width:200px; height:200px; border-radius:50%; border:10px solid var(--border-strong);
  background:radial-gradient(circle,var(--bg-elevated) 55%,var(--bg-inset) 100%);
  color:var(--text); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px;
  cursor:pointer; transition:box-shadow .2s,border-color .2s,transform .2s; font-family:inherit;
}
.power-ring:hover { transform:scale(1.02); }
.power-ring.on { border-color:var(--ring); box-shadow:0 0 26px rgba(47,227,200,.55), inset 0 0 30px rgba(47,227,200,.12); }
.power-ring.busy { opacity:.65; cursor:wait; }
.ic-rocket { width:var(--ic-rocket); height:var(--ic-rocket); color:var(--text); margin-bottom:2px; }
.power-ring b { font-size:22px; font-weight:700; }
.power-ring small { font-size:13px; color:var(--text-muted); font-family:var(--font-mono); }
.dash-info, .dash-quick { padding:18px 20px; }
.info-head { display:flex; align-items:center; gap:10px; padding-bottom:14px; border-bottom:1px solid var(--divider); margin-bottom:12px; }
.info-flag { width:var(--ic-flag); height:var(--ic-flag); border-radius:4px; display:flex; align-items:center; justify-content:center; background:#e0453f; color:#fff; flex:none; }
/* 有真实国旗时去掉红花底，容器尺寸保持 20×20 不变（图标尺寸红线） */
.info-flag.has-flag { background:transparent; }
.info-name { font-size:15px; color:var(--text); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.delay-tag { padding:3px 9px; border-radius:10px; font-size:11px; background:var(--success-dim); color:var(--success); white-space:nowrap; flex:none; }
.delay-tag.idle { background:var(--surface-hover); color:var(--text-muted); }
/* 「延迟」标签可点：就地展开网速 / ping，不跳页 */
button.delay-tag { border:none; cursor:pointer; font-family:inherit; }
.delay-btn:hover { filter:brightness(1.1); }
.delay-btn.open { box-shadow:0 0 0 1px var(--accent); }
.delay-caret { margin-left:5px; font-size:9px; opacity:.7; }
.info-speed { margin-top:12px; padding:10px 12px; background:var(--bg-inset); border:1px solid var(--divider); border-radius:var(--radius-md); max-height:190px; overflow-y:auto; }
.info-speed-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:12px; color:var(--text-secondary); }
.info-speed-head .btn { margin-left:auto; }
.info-speed-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px 16px; }
.info-speed-grid > div { display:flex; justify-content:space-between; align-items:baseline; gap:8px; min-width:0; }
.info-speed-grid label { font-size:11px; color:var(--text-muted); white-space:nowrap; }
.info-speed-grid span { font-size:12px; color:var(--text); font-family:var(--font-mono, ui-monospace, monospace); white-space:nowrap; }
.info-speed-grid span.hi { color:var(--success); font-weight:600; }
.info-speed-foot { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:10px; padding-top:8px; border-top:1px solid var(--divider); }
.speed-grade { font-size:10px; padding:1px 8px; border-radius:var(--radius-full); color:var(--text-muted); background:var(--surface-hover); }
.speed-grade.ok { color:var(--success); background:var(--success-dim); }
.speed-grade.bad { color:var(--danger); background:var(--danger-dim); }
.info-grid { display:flex; flex-direction:column; gap:14px; margin:0; }
.info-grid > div { display:flex; align-items:center; gap:12px; min-width:0; }
.info-grid dt { width:var(--ic-info); flex:none; color:var(--text-muted); display:flex; }
.info-grid dd { margin:0; display:flex; align-items:baseline; gap:12px; min-width:0; }
.info-grid dd label { width:32px; flex:none; font-size:13px; color:var(--text-muted); }
.info-grid dd span { font-size:13px; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.info-empty { font-size:11px; color:var(--text-muted); line-height:1.6; padding-top:14px; }
.quick-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.quick-grid button {
  height:100px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px;
  border:1px solid var(--border); border-radius:10px; background:var(--bg-inset); color:var(--text-secondary);
  font-size:13px; cursor:pointer; font-family:inherit;
}
.quick-grid button .ic { color:var(--text); }
.quick-grid button:hover { border-color:var(--accent); color:var(--text); background:var(--surface-hover); }

/* ③ 节点列表 */
.dash-nodes { padding:16px 18px 18px; }
.nodes-top { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.nodes-title { margin:0 auto 0 0; white-space:nowrap; }
.nodes-search { display:flex; align-items:center; gap:9px; height:36px; padding:0 12px; min-width:200px; max-width:320px; flex:1; border:1px solid var(--border); border-radius:8px; background:var(--bg-inset); color:var(--text-muted); }
.nodes-search input { flex:1; min-width:0; border:none; outline:none; background:transparent; color:var(--text); font-size:13px; font-family:inherit; }
.nodes-search input::placeholder { color:var(--text-muted); }
.nodes-sort { height:36px; padding:0 10px; border:1px solid var(--border); border-radius:8px; background:var(--bg-inset); color:var(--text-secondary); font-size:13px; font-family:inherit; }
.nodes-refresh { width:36px; height:36px; display:flex; align-items:center; justify-content:center; border:1px solid var(--border); border-radius:8px; background:var(--bg-inset); color:var(--text-secondary); cursor:pointer; }
.nodes-refresh:hover { color:var(--text); background:var(--surface-hover); }
.nodes-body { display:flex; gap:14px; min-height:220px; }
.node-groups { width:170px; flex:none; display:flex; flex-direction:column; gap:4px; padding-right:12px; border-right:1px solid var(--divider); max-height:312px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--border-strong) transparent; }
.group-btn { display:flex; align-items:center; gap:10px; height:36px; padding:0 10px; border:none; border-radius:8px; background:transparent; color:var(--text-secondary); font-size:13px; cursor:pointer; text-align:left; font-family:inherit; flex:none; }
.group-btn > span:nth-child(2) { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.group-btn em { font-style:normal; color:var(--text-muted); font-size:12px; }
.group-btn:hover { background:var(--surface-hover); }
.group-btn.on { background:var(--accent-dim); color:var(--accent); box-shadow:inset 0 0 0 1px rgba(59,130,246,.35); }
.group-btn.on em { color:var(--accent); }
.group-btn.empty { opacity:.55; }
.group-btn.auto .ic { color:var(--warning); }
.group-btn.add { color:var(--accent); margin-top:6px; }
.grp-flag { width:var(--ic-group); font-size:14px; line-height:1; flex:none; text-align:center; }
.group-add-row { display:flex; gap:4px; padding:2px 0; }
.group-add-row input { flex:1; min-width:0; height:30px; padding:0 8px; border:1px solid var(--accent); border-radius:6px; background:var(--bg-inset); color:var(--text); font-size:12px; font-family:inherit; outline:none; }
.group-add-row button { width:30px; height:30px; flex:none; display:flex; align-items:center; justify-content:center; border:none; border-radius:6px; background:var(--accent); color:#fff; cursor:pointer; }
.node-rows { flex:1; min-width:0; display:flex; flex-direction:column; gap:8px; max-height:312px; overflow-y:auto; padding-right:6px; scrollbar-width:thin; scrollbar-color:var(--border-strong) transparent; }
.node-rows::-webkit-scrollbar, .node-groups::-webkit-scrollbar { width:9px; }
.node-rows::-webkit-scrollbar-thumb, .node-groups::-webkit-scrollbar-thumb { background:var(--border-strong); border-radius:6px; }
.node-rows::-webkit-scrollbar-thumb:hover, .node-groups::-webkit-scrollbar-thumb:hover { background:var(--text-faint); }
.node-rows::-webkit-scrollbar-track, .node-groups::-webkit-scrollbar-track { background:transparent; }
.node-row { display:flex; align-items:center; gap:12px; height:52px; padding:0 12px; border:1px solid var(--border); border-radius:10px; background:var(--bg-inset); font-size:13px; flex:none; }
.node-row:hover { border-color:var(--border-strong); }
.node-row.current { border-color:var(--accent); background:var(--accent-dim); }
.node-radio { width:16px; height:16px; border:2px solid var(--text-faint); border-radius:50%; flex:none; }
.node-radio.on { border-color:var(--accent); background:var(--accent); box-shadow:inset 0 0 0 2px var(--bg-inset); }
.node-country { flex:none; max-width:76px; font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.node-name { flex:1; min-width:0; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.node-bw { width:86px; flex:none; text-align:right; color:var(--text-secondary); font-size:12px; white-space:nowrap; }
.ic-signal { fill:var(--text-faint); }
.ic-signal.lv-1 rect:nth-child(-n+1), .ic-signal.lv-2 rect:nth-child(-n+2), .ic-signal.lv-3 rect:nth-child(-n+3), .ic-signal.lv-4 rect { fill:var(--success); }
.node-connect { flex:none; min-width:56px; height:30px; padding:0 12px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; font-size:12px; cursor:pointer; font-family:inherit; }
.node-connect.on { background:var(--success-dim); border-color:var(--success); color:var(--success); cursor:default; }
.node-connect:disabled { opacity:.7; cursor:default; }
.node-more { flex:none; width:20px; height:30px; display:flex; align-items:center; justify-content:center; border:none; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; }
.node-more:hover { color:var(--text); }
.node-empty { padding:34px 10px; text-align:center; display:flex; flex-direction:column; align-items:center; gap:8px; color:var(--text-muted); font-size:12px; }
.node-empty b { color:var(--text-secondary); font-size:14px; }
.node-empty button { margin-top:6px; padding:6px 14px; border:1px solid var(--accent); border-radius:6px; background:transparent; color:var(--accent); font-size:12px; cursor:pointer; }
.node-more-hint { padding:6px 8px; font-size:11px; color:var(--text-muted); text-align:center; }

/* 参考图的内容区宽度约 860px（窗口 1100px 时正好），只有窗口窄于 1000px 才折叠 */
@media (max-width:1000px) {
  .dash-top { grid-template-columns:1fr 1fr; }
  .top-cell.status { grid-column:1 / 3; border-bottom:1px solid var(--border); }
  .dash-mid { grid-template-columns:1fr 1fr; }
  .power-cell { grid-column:1 / 3; }
  .node-bw { display:none; }
}

</style>
