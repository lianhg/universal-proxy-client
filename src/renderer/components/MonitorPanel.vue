<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../store.js'
import { toLogical, domScale } from '../uiScale.js'
import { aggregateConnections, formatBytes, outboundRatio, type AggregateKey } from '../../core/runtime/telemetry.js'

const store = useAppStore()
const filter = ref('全部连接')
const keyword = ref('')
const rankBy = ref<AggregateKey>('process')

const t = computed(() => store.telemetry)
const ratio = computed(() => outboundRatio(t.value.connections))
/** Xray 有速率、没有连接列表：空表必须说清楚，不能写成「当前没有活跃连接」 */
const emptyText = computed(() => {
  if (t.value.error) return `采样失败：${t.value.error}`
  if (t.value.kernel === 'xray') return 'Xray 已通过 StatsService gRPC 提供实时速率与累计流量（看上方指标），但 Xray 没有 /connections 接口，因此不显示逐条连接列表；需要该能力请改用 sing-box / Mihomo 内核。'
  if (!t.value.supported) return t.value.reason
  return t.value.state === 'active' ? '当前没有活跃连接（或没有匹配筛选条件）' : t.value.reason
})

const rows = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return t.value.connections.filter(c => {
    if (filter.value === '仅代理' && c.outbound !== 'proxy') return false
    if (filter.value === '仅直连' && c.outbound !== 'direct') return false
    if (filter.value === '仅阻断' && c.outbound !== 'reject') return false
    if (!kw) return true
    return [c.process, c.host, c.destinationIp, c.rule, c.rulePayload, ...c.chains]
      .some(v => String(v ?? '').toLowerCase().includes(kw))
  }).slice(0, 120)
})

const rank = computed(() => aggregateConnections(t.value.connections, rankBy.value, 8))
const rankMax = computed(() => Math.max(1, ...rank.value.map(r => r.total)))
const rankLabel: Record<AggregateKey, string> = {
  process: '按进程', host: '按目标域名', rule: '按规则', outbound: '按走向', chain: '按出口节点',
}
const statusText: Record<string, string> = { proxy: '代理', direct: '直连', reject: '阻断', unknown: '未知' }

function started(ts: number) {
  return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
}
function close(id: string) { void store.closeConnection(id) }

/* ───────── 自定义布局：可拖动 / 可缩放 / 自由组合模块 ─────────
   默认（无自定义布局）沿用原有流式卡片布局；点「自定义布局」进入编辑态，每个模块可拖动
   与缩放、自由组合，排列持久化到 localStorage；退出后自定义布局一直生效，可「重置」。 */
const MODULES = ['head', 'notice', 'metrics', 'toolbar', 'table', 'rank', 'guide', 'hint'] as const
type ModId = typeof MODULES[number]
const MIN_SIZE: Record<ModId, [number, number]> = {
  head: [280, 56], notice: [280, 40], metrics: [320, 92],
  toolbar: [320, 44], table: [360, 200], rank: [220, 160], guide: [300, 120], hint: [300, 48],
}
const LAYOUT_KEY = 'upc.monitor.layout.v1'
const SNAP = 8
const editMode = ref(false)
const layout = ref<Record<string, { x: number; y: number; w: number; h: number }>>({})
const modEls = ref<Record<string, HTMLElement>>({})
const panelEl = ref<HTMLElement | null>(null)
let dragState: { id: ModId; mode: 'move' | 'resize'; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null = null

function setMod(id: string, el: unknown) {
  if (el) modEls.value[id] = el as HTMLElement
  else delete modEls.value[id]
}
function loadLayout(): Record<string, { x: number; y: number; w: number; h: number }> {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') || {} } catch { return {} }
}
function hasCustom(): boolean { return Object.keys(layout.value).length > 0 }
function moduleStyle(id: string): Record<string, string> {
  if (!editMode.value && !hasCustom()) return {}
  const l = layout.value[id]
  if (!l) return {}
  return { left: l.x + 'px', top: l.y + 'px', width: l.w + 'px', height: l.h + 'px' }
}
const panelMinH = computed(() => {
  if (!editMode.value && !hasCustom()) return ''
  let m = 0
  for (const id of MODULES) { const l = layout.value[id]; if (l) m = Math.max(m, l.y + l.h) }
  return (m + 14) + 'px'
})
function snap(v: number) { return Math.round(v / SNAP) * SNAP }
function measureLayout(): Record<string, { x: number; y: number; w: number; h: number }> {
  const base = panelEl.value?.getBoundingClientRect()
  const measured: Record<string, { x: number; y: number; w: number; h: number }> = {}
  if (base) {
    /* rect 是视口物理像素，样式里的 left/top 是逻辑像素，除以实测缩放系数还原 */
    const k = domScale(panelEl.value) || 1
    for (const id of MODULES) {
      const el = modEls.value[id]
      if (!el) continue
      const r = el.getBoundingClientRect()
      measured[id] = {
        x: snap((r.left - base.left) / k), y: snap((r.top - base.top) / k),
        w: Math.round(r.width / k), h: Math.round(r.height / k),
      }
    }
  }
  return measured
}
function enterEdit() {
  const saved = loadLayout()
  layout.value = Object.keys(saved).length ? saved : measureLayout()
  editMode.value = true
}
/* 平时也能直接拖：首次真正拖动时，把当前固定排布量成自由布局坐标 */
function ensureLayout() {
  if (hasCustom()) return
  layout.value = measureLayout()
}
function persistLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout.value)) } catch { /* 隐私模式忽略 */ }
}
function exitEdit(saveIt: boolean) {
  if (saveIt) persistLayout()
  editMode.value = false
}
function resetLayout() {
  layout.value = {}
  try { localStorage.removeItem(LAYOUT_KEY) } catch { /* ignore */ }
  editMode.value = false
}
let ensureMade = false  // 本次拖动是否由编辑态拖动触发了固定排布→自由布局转换
let moved = false      // 本次拖动是否真的移动过
function onGripDown(id: ModId, e: PointerEvent) {
  // 只有点了「编辑布局」才允许拖动：平时模块是固定展示态，避免误拖打乱布局
  if (!editMode.value) return
  e.preventDefault()
  ensureMade = !layout.value[id]
  moved = false
  dragState = { id, mode: 'move', sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, ow: 0, oh: 0 }
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}
function onResizeDown(id: ModId, e: PointerEvent) {
  if (!editMode.value) return
  e.preventDefault(); e.stopPropagation()
  ensureMade = !layout.value[id]
  moved = false
  dragState = { id, mode: 'resize', sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, ow: 0, oh: 0 }
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}
function onPointerMove(e: PointerEvent) {
  if (!dragState) return
  const pdx = e.clientX - dragState.sx, pdy = e.clientY - dragState.sy
  // 平时直接拖：真的动了（超过 3px 物理像素，防手抖误触）才把固定排布量成自由布局坐标
  if (!moved) {
    if (Math.abs(pdx) < 3 && Math.abs(pdy) < 3) return
    ensureLayout()
    const l = layout.value[dragState.id]
    if (!l) { dragState = null; return }
    dragState.ox = l.x; dragState.oy = l.y; dragState.ow = l.w; dragState.oh = l.h
    moved = true
  }
  /* 视口物理像素 → 布局逻辑像素，保证窗口缩放后拖动仍跟手 */
  const dx = toLogical(pdx, panelEl.value), dy = toLogical(pdy, panelEl.value)
  const cur = { ...layout.value[dragState.id]! }
  if (dragState.mode === 'move') {
    cur.x = Math.max(0, snap(dragState.ox + dx))
    cur.y = Math.max(0, snap(dragState.oy + dy))
  } else {
    cur.w = Math.max(MIN_SIZE[dragState.id][0], snap(dragState.ow + dx))
    cur.h = Math.max(MIN_SIZE[dragState.id][1], snap(dragState.oh + dy))
  }
  layout.value = { ...layout.value, [dragState.id]: cur }
}
function onPointerUp() {
  dragState = null
  // 编辑态下拖完立即落盘：即使忘了点「完成」也不会丢布局；只点了一下没拖就还原默认排布
  if (moved) persistLayout()
  else if (ensureMade) layout.value = {}
  ensureMade = false
  moved = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
}
</script>

<template>
  <div class="card panel" :class="{ 'panel--edit': editMode, 'has-custom': hasCustom() }" :style="{ minHeight: panelMinH }" ref="panelEl">
    <div class="ml-toolbar">
      <span class="ml-tip" v-if="editMode">拖左上角「⠿ 拖动」移动、拖右下角缩放；拖完自动保存</span>
      <span class="ml-tip" v-else>点「编辑布局」后可拖动 / 缩放模块；平时为固定展示态</span>
      <span class="ml-spacer"></span>
      <button v-if="!editMode" class="ml-btn" @click="enterEdit">{{ hasCustom() ? '编辑布局' : '自定义布局' }}</button>
      <button v-if="!editMode && hasCustom()" class="ml-btn ghost" @click="resetLayout">重置为默认</button>
      <button v-else-if="editMode" class="ml-btn primary" @click="exitEdit(true)">完成</button>
    </div>

    <div class="ml-mod m-head" :class="{ editing: editMode }" :style="moduleStyle('head')" :ref="(el) => setMod('head', el)">
      <div class="mod-grip" @pointerdown="onGripDown('head', $event)"><span>⠿ 拖动</span></div>
      <div class="mod-resize" @pointerdown="onResizeDown('head', $event)"></div>
    <div class="head">
      <div>
        <h3>网络连接监控 · 真实连接</h3>
        <p class="sub">速率与累计流量：Xray 走 StatsService gRPC，sing-box / Mihomo 走 clash_api /connections（每秒采样）；逐条连接列表只有后两者提供，未连接时不显示任何模拟数据</p>
        <p class="sub" style="margin-top:3px">当前状态：{{ t.error ? '采样异常' : t.state === 'active' ? '实时采样中' : '未采样' }} · {{ t.kernel === 'xray' ? '数据源 gRPC StatsService（无连接列表）' : `数据源 ${t.kernel ?? '内核'} clash_api` }}</p>
      </div>
      <span class="cnt" :class="{ bad: !!t.error }">{{ t.error ? '采样异常' : t.state === 'active' ? '实时采样中' : '未采样' }}</span>
    </div>
    </div>

    <div v-if="!t.supported || t.error" class="ml-mod m-notice" :class="{ editing: editMode }" :style="moduleStyle('notice')" :ref="(el) => setMod('notice', el)">
      <div class="mod-grip" @pointerdown="onGripDown('notice', $event)"><span>⠿ 拖动</span></div>
      <div class="mod-resize" @pointerdown="onResizeDown('notice', $event)"></div>
      <div class="notice">
        <b>{{ t.error ? '采样失败' : t.kernel === 'xray' ? 'Xray 不提供逐条连接列表' : t.kernel ? '连接接口暂不可用' : '没有可用的遥测数据源' }}</b>
        <div>{{ t.error ?? t.reason }}</div>
      </div>
    </div>

    <div class="ml-mod m-metrics" :class="{ editing: editMode }" :style="moduleStyle('metrics')" :ref="(el) => setMod('metrics', el)">
      <div class="mod-grip" @pointerdown="onGripDown('metrics', $event)"><span>⠿ 拖动</span></div>
      <div class="mod-resize" @pointerdown="onResizeDown('metrics', $event)"></div>
      <div class="metrics">
        <div class="m"><b>{{ t.activeConnections }}</b><span>活跃连接</span></div>
        <div class="m"><b class="ok">{{ ratio.proxy }}</b><span>走代理</span></div>
        <div class="m"><b class="blue">{{ ratio.direct }}</b><span>直连</span></div>
        <div class="m"><b class="bad">{{ ratio.reject }}</b><span>被阻断</span></div>
        <div class="m"><b>{{ formatBytes(t.downSpeed) }}/s</b><span>实时下行</span></div>
        <div class="m"><b>{{ formatBytes(t.upSpeed) }}/s</b><span>实时上行</span></div>
      </div>
    </div>

    <div class="ml-mod m-toolbar" :class="{ editing: editMode }" :style="moduleStyle('toolbar')" :ref="(el) => setMod('toolbar', el)">
      <div class="mod-grip" @pointerdown="onGripDown('toolbar', $event)"><span>⠿ 拖动</span></div>
      <div class="mod-resize" @pointerdown="onResizeDown('toolbar', $event)"></div>
      <div class="toolbar">
        <select v-model="filter">
          <option>全部连接</option><option>仅代理</option><option>仅直连</option><option>仅阻断</option>
        </select>
        <input v-model="keyword" placeholder="搜索进程 / 域名 / 规则 / 节点" />
        <button class="btn" @click="store.refreshRuntime()">刷新</button>
        <span class="tiny dim">显示 {{ rows.length }} / {{ t.activeConnections }} 条 · 采样于 {{ t.ts ? new Date(t.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—' }}</span>
      </div>
    </div>

    <div class="split">
      <div class="table-wrap ml-mod m-table" :class="{ editing: editMode }" :style="moduleStyle('table')" :ref="(el) => setMod('table', el)">
        <div class="mod-grip" @pointerdown="onGripDown('table', $event)"><span>⠿ 拖动</span></div>
        <div class="mod-resize" @pointerdown="onResizeDown('table', $event)"></div>
        <table class="grid">
          <thead><tr>
            <th>进程</th><th>目标</th><th>端口</th><th>走向</th><th>出口</th><th>规则</th><th>上传 / 下载</th><th>开始</th><th></th>
          </tr></thead>
          <tbody>
            <tr v-for="c in rows" :key="c.id">
              <td :title="c.processPath"><b>{{ c.process || c.inbound || '未知' }}</b><div class="tiny dim">{{ c.network }}{{ c.inbound ? ' · ' + c.inbound : '' }}</div></td>
              <td class="mono ellipsis" :title="c.host || c.destinationIp">{{ c.host || c.destinationIp || '—' }}</td>
              <td class="mono">{{ c.destinationPort || '—' }}</td>
              <td><span :class="['tagx', c.outbound]">{{ statusText[c.outbound] }}</span></td>
              <td class="ellipsis" :title="c.chains.join(' → ')">{{ c.chains[c.chains.length - 1] || '—' }}</td>
              <td class="ellipsis" :title="c.rulePayload">{{ [c.rule, c.rulePayload].filter(Boolean).join(':') || '—' }}</td>
              <td class="mono tiny">↑{{ formatBytes(c.upload) }} ↓{{ formatBytes(c.download) }}</td>
              <td class="mono tiny dim">{{ started(c.startedAt) }}</td>
              <td><button class="btn tiny danger" @click="close(c.id)">关闭</button></td>
            </tr>
            <tr v-if="!rows.length"><td colspan="9" class="empty">{{ emptyText }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="rank ml-mod m-rank" :class="{ editing: editMode }" :style="moduleStyle('rank')" :ref="(el) => setMod('rank', el)">
        <div class="mod-grip" @pointerdown="onGripDown('rank', $event)"><span>⠿ 拖动</span></div>
        <div class="mod-resize" @pointerdown="onResizeDown('rank', $event)"></div>
        <div class="sec-title">连接流量排行</div>
        <div class="rank-tabs">
          <button v-for="k in (['process','host','rule','chain','outbound'] as AggregateKey[])" :key="k"
                  :class="['chip', { on: rankBy === k }]" @click="rankBy = k">{{ rankLabel[k] }}</button>
        </div>
        <div v-if="!rank.length" class="tiny dim">暂无数据</div>
        <div v-for="r in rank" :key="r.key" class="rank-row">
          <div class="between"><span class="ellipsis" :title="r.key">{{ r.key }}</span><span class="mono tiny">{{ formatBytes(r.total) }}</span></div>
          <div class="bar"><i :style="{ width: (r.total / rankMax * 100) + '%' }"></i></div>
          <div class="tiny dim">{{ r.connections }} 条连接 · ↑{{ formatBytes(r.upload) }} ↓{{ formatBytes(r.download) }}</div>
        </div>
      </div>
    </div>

    <div v-if="t.state !== 'active'" class="ml-mod m-guide" :class="{ editing: editMode }" :style="moduleStyle('guide')" :ref="(el) => setMod('guide', el)">
      <div class="mod-grip" @pointerdown="onGripDown('guide', $event)"><span>⠿ 拖动</span></div>
      <div class="mod-resize" @pointerdown="onResizeDown('guide', $event)"></div>
      <div class="guide">
        <div class="sec-title">如何获得真实连接数据</div>
        <ol>
          <li>要看<b>逐条连接</b>请用 <b>sing-box</b> 或 <b>Mihomo</b> —— Xray 只有 StatsService gRPC 的速率与累计流量，没有 /connections 接口，这里会明确写出原因而不用模拟数据填充。</li>
          <li>内核启动后在本地控制端口（默认 127.0.0.1:21811）开放统计接口，运行层每秒读取一次 <span class="mono">/connections</span> 或 gRPC QueryStats。</li>
          <li>速率由两次采样的累计字节差计算；连接列表、出口链路、命中规则、进程名全部来自内核返回值。</li>
          <li>浏览器预览模式没有主进程，无法启动内核，因此这里会一直显示空态与原因。</li>
        </ol>
      </div>
    </div>

    <div class="ml-mod m-hint" :class="{ editing: editMode }" :style="moduleStyle('hint')" :ref="(el) => setMod('hint', el)">
      <div class="mod-grip" @pointerdown="onGripDown('hint', $event)"><span>⠿ 拖动</span></div>
      <div class="mod-resize" @pointerdown="onResizeDown('hint', $event)"></div>
      <p class="hint">clash_api 不返回进程 PID，因此本表不显示 PID（不编造）。「关闭」只断开这一条活跃连接，不影响节点配置与内核进程。</p>
    </div>
  </div>
</template>

<style scoped>
.panel h3 { font-size:15px; margin-bottom:4px; }
.head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
.sub { font-size:12px; color:var(--text-muted); margin:0; }
.cnt { font-size:12px; color:var(--success); white-space:nowrap; } .cnt.bad { color:var(--danger); }
.notice { margin-top:12px; padding:10px 12px; border:1px solid var(--warning); background:var(--bg-inset); border-radius:var(--radius-md); font-size:12px; color:var(--text-secondary); line-height:1.7; }
.metrics { display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:8px; margin:12px 0; }
.m { background:var(--bg-inset); border:1px solid var(--border); border-radius:var(--radius-md); padding:9px; display:flex; flex-direction:column; gap:3px; }
.m b { font-size:16px; color:var(--text); } .m span { font-size:10px; color:var(--text-muted); }
.m b.ok { color:var(--success); } .m b.blue { color:var(--accent); } .m b.bad { color:var(--danger); }
.toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
.toolbar select { width:auto; min-width:110px; flex:none; }
.toolbar input { flex:1; min-width:180px; }
.guide { margin-top:12px; border:1px solid var(--border); border-radius:var(--radius-md); background:var(--bg-inset); padding:10px 14px; font-size:11.5px; color:var(--text-secondary); line-height:1.85; }
.guide ol { margin:4px 0 0; padding-left:18px; }
.guide b { color:var(--text); }
.split { display:flex; gap:10px; align-items:flex-start; }
.table-wrap { flex:1; min-width:0; overflow:auto; max-height:460px; border:1px solid var(--border); border-radius:var(--radius-md); }
.grid { width:100%; border-collapse:collapse; font-size:11.5px; }
.grid th { position:sticky; top:0; background:var(--bg-inset); color:var(--text-muted); font-weight:500; text-align:left; padding:7px 8px; border-bottom:1px solid var(--border); white-space:nowrap; }
.grid td { padding:6px 8px; border-bottom:1px solid var(--divider); color:var(--text-secondary); vertical-align:middle; }
.grid tbody tr:hover { background:var(--surface-hover); }
.ellipsis { max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.empty { text-align:center; color:var(--text-muted); padding:26px 10px; line-height:1.7; }
.tagx { padding:1px 7px; border-radius:10px; font-size:10px; }
.tagx.proxy { background:var(--tag-green-bg); color:var(--success); }
.tagx.direct { background:var(--accent-dim); color:var(--accent); }
.tagx.reject { background:var(--danger-dim); color:var(--danger); }
.tagx.unknown { background:var(--surface-hover); color:var(--text-muted); }
.rank { width:250px; flex:none; }
.sec-title { font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:8px; }
.rank-tabs { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:10px; }
.chip { font-size:10px; padding:3px 7px; border-radius:10px; border:1px solid var(--border); background:var(--bg-inset); color:var(--text-muted); cursor:pointer; }
.chip.on { color:var(--accent); border-color:var(--accent); }
.rank-row { margin-bottom:10px; font-size:11.5px; color:var(--text-secondary); }
.bar { height:5px; background:var(--bg-inset); border-radius:3px; margin:4px 0; overflow:hidden; }
.bar i { display:block; height:100%; background:var(--accent); }
.tiny { font-size:10px; } .dim { color:var(--text-muted); }
.between { display:flex; justify-content:space-between; gap:6px; }
.btn.tiny { padding:2px 7px; font-size:10px; }
.hint { font-size:11px; color:var(--text-muted); line-height:1.7; margin:12px 0 0; }

/* ───────── 自定义布局：可拖动 / 可缩放 / 自由组合模块 ───────── */
.ml-toolbar { display:flex; align-items:center; gap:10px; min-height:34px; margin-bottom:10px; position:relative; z-index:5; }
.ml-tip { font-size:12px; color:var(--text-muted); }
.ml-spacer { flex:1; }
.ml-btn { font-size:12px; padding:4px 12px; border-radius:var(--radius-md); border:1px solid var(--border); background:var(--bg-inset); color:var(--text-secondary); cursor:pointer; }
.ml-btn.primary { color:#fff; background:var(--accent); border-color:var(--accent); }
.ml-btn.ghost { color:var(--text-muted); }
.ml-btn:hover { border-color:var(--accent); }

/* 编辑态 / 已保存自定义布局：解除默认流式，模块绝对定位自由排布 */
.panel--edit, .panel.has-custom { position:relative; }
.panel--edit .ml-mod, .panel.has-custom .ml-mod { position:absolute; }
.panel--edit .split, .panel.has-custom .split { display:contents; }
.panel--edit .ml-mod { outline:1px dashed var(--border-strong); outline-offset:2px; border-radius:var(--radius-md); }
.panel--edit .ml-mod.editing { background:var(--bg-inset); }
.panel--edit .table-wrap, .panel.has-custom .table-wrap { max-height:none; flex:none; min-width:0; }

/* 拖动手柄（左上）与缩放手柄（右下） */
.mod-grip { position:absolute; top:0; left:0; display:flex; align-items:center; gap:4px; padding:2px 8px; font-size:11px; color:#fff; background:var(--accent); border-radius:0 var(--radius-md) 0 var(--radius-md); cursor:move; user-select:none; z-index:6; opacity:0; pointer-events:none; transition:opacity .12s; }
.mod-grip span { pointer-events:none; }
.mod-resize { position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize; z-index:6; background:linear-gradient(135deg, transparent 50%, var(--border-strong) 50%); border-bottom-right-radius:var(--radius-md); opacity:0; transition:opacity .12s; }
/* 只有点「编辑布局」进入编辑态才显示手柄；平时完全隐藏且不接收点击，模块为固定展示态 */
.panel--edit .mod-grip { opacity:1; pointer-events:auto; }
.panel--edit .mod-resize { opacity:1; }
</style>
