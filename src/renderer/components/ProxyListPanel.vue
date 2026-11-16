<script setup lang="ts">
/**
 * 节点管家（合并页）
 *
 * 原「节点管理」+「节点测速」两个页面做的是同一批节点、同一个连接动作，
 * 且真连测速本身就会先做 TCP 握手，来回切页纯属重复。这里合成一页：
 *   管理（搜索 / 分组 / 筛选 / 详情 / 删除）· 测速（握手 + 真连下载）· 连接，一次做完。
 *
 * 「一键全检」先用不耗流量的 TCP 握手剔掉不可达节点，再只对可达节点跑真连下载测速，
 * 既省流量也省时间。所有测速都是真实结果，不估算、不造假。
 */
import { ref, computed } from 'vue'
import { useAppStore } from '../store.js'
import { PROTOCOL_LABELS } from '../../core/hub/model.js'
import { KERNEL_LABELS } from '../../core/hub/kernel.js'
import type { UnifiedNode } from '../../core/hub/model.js'
import { regionOf, displayCodeOf, countryLabelOf, flagSourceOf } from '../regions.js'
import { countryName } from '../flags.js'
import FlagIcon from './FlagIcon.vue'
import {
  SPEEDTEST_TARGETS, SPEED_GRADE_LABELS, SPEED_GRADE_HINTS,
  formatBytes, formatMbps,
  type SpeedGrade, type SpeedTestRow,
} from '../../core/runtime/speedtest.js'

const store = useAppStore()

/** 国旗 / 提示文案：规则在 regions.ts，与仪表盘共用同一份 */
const displayCode = (n: UnifiedNode) => displayCodeOf(n, store.geoCode)
const countryLabel = (n: UnifiedNode) => countryLabelOf(n, store.geoCode)
const flagSource = (n: UnifiedNode) => flagSourceOf(n, store.geoCode)

const filterName = ref('')
const regionFilter = ref('')
const sortKey = ref<'addedAt' | 'name' | 'protocol' | 'kernel' | 'latency' | 'speed'>('addedAt')
const selected = ref<string[]>([])
const expanded = ref<string | null>(null)
const latencies = ref<Record<string, { ms: number | null; error?: string }>>({})
const testing = ref(false)       // TCP 握手进行中
const testProgress = ref('')

/** 真连测速状态来自 store（主进程进度经 runtime:event 推送） */
const speedRows = computed(() => store.speedRows)
const busy = computed(() => store.speedBusy)

/** 只有「完整」且未阻断的节点才能测出真实速度 */
const candidates = computed(() => store.nodes.filter(n => !n.issues.some(i => i.level === 'error')))

/** 只统计真实存在的地区（数量来自当前节点，不做任何推测补全） */
const regionOptions = computed(() => {
  const counter = new Map<string, number>()
  for (const n of store.nodes) {
    const k = regionOf(n)
    counter.set(k, (counter.get(k) ?? 0) + 1)
  }
  return [...counter.entries()].sort((a, b) => b[1] - a[1])
})

const filtered = computed(() => {
  const q = filterName.value.trim().toLowerCase()
  const list = store.nodes.filter(n => {
    if (regionFilter.value && regionOf(n) !== regionFilter.value) return false
    return !q || `${n.name} ${n.server} ${n.protocol}`.toLowerCase().includes(q)
  })
  return [...list].sort((a, b) => {
    if (sortKey.value === 'name') return a.name.localeCompare(b.name)
    if (sortKey.value === 'protocol') return a.protocol.localeCompare(b.protocol)
    if (sortKey.value === 'kernel') return (a.kernel ?? 'zzz').localeCompare(b.kernel ?? 'zzz')
    if (sortKey.value === 'latency') {
      const x = pingMs(a), y = pingMs(b)
      return x - y
    }
    if (sortKey.value === 'speed') {
      return (speedRows.value[b.id]?.mbps ?? -1) - (speedRows.value[a.id]?.mbps ?? -1)
    }
    return b.addedAt - a.addedAt
  })
})

/** 握手延迟：优先用真连测速里那次（端到端更准），没有再退回快速握手结果 */
function pingMs(n: UnifiedNode): number {
  return speedRows.value[n.id]?.latencyMs ?? latencies.value[n.id]?.ms ?? Infinity
}

const grouped = computed(() => {
  const m = new Map<string, UnifiedNode[]>()
  for (const n of filtered.value) {
    const k = PROTOCOL_LABELS[n.protocol] ?? n.protocol
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(n)
  }
  return [...m.entries()]
})

/** 测速目标：勾了就测勾中的，没勾就测当前筛选结果里的可测节点 */
const targets = computed(() => {
  const ids = selected.value.length ? selected.value : filtered.value.map(n => n.id)
  return candidates.value.filter(n => ids.includes(n.id))
})

const finishedCount = computed(() => targets.value.filter(n => {
  const p = speedRows.value[n.id]?.phase
  return p === 'done' || p === 'error' || p === 'cancelled'
}).length)

const fastest = computed(() => {
  const list = Object.values(speedRows.value).filter(r => (r.mbps ?? 0) > 0) as SpeedTestRow[]
  if (!list.length) return null
  return [...list].sort((a, b) => (b.mbps ?? 0) - (a.mbps ?? 0))[0]
})
const usableCount = computed(() => Object.values(speedRows.value)
  .filter(r => r.phase === 'done' && (r.mbps ?? 0) >= 2).length)
const hasSpeedResult = computed(() => Object.keys(speedRows.value).length > 0)

const gradeClass: Record<SpeedGrade, string> = {
  fast: 'ok', ok: 'ok', slow: 'warn', bad: 'bad', unknown: 'dim',
}
const phaseText: Record<string, string> = {
  pending: '排队中', tcp: '测握手…', starting: '起内核…',
  download: '下载测速…', done: '完成', error: '失败', cancelled: '已取消',
}
const speedText = (n: UnifiedNode) => {
  const r = speedRows.value[n.id]
  if (!r) return '未测'
  if (r.phase === 'error') return '不可用'
  if (r.phase === 'cancelled') return '已取消'
  if (r.phase !== 'done') return phaseText[r.phase] ?? r.phase
  return SPEED_GRADE_LABELS[r.grade]
}

const label = (p: string) => PROTOCOL_LABELS[p as keyof typeof PROTOCOL_LABELS] ?? p.toUpperCase()
const kernelLabel = (k: string | null) => k ? KERNEL_LABELS[k as keyof typeof KERNEL_LABELS] : '无可用内核'

function toggleSelect(id: string) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}
function toggleAll() {
  const ids = filtered.value.map(n => n.id)
  selected.value = selected.value.length === ids.length ? [] : ids
}

/** 真实 TCP 握手：快、不耗流量；连得通 ≠ 代理可用，只是先剔掉明显不可达的节点 */
async function bulkPing(list: UnifiedNode[]): Promise<void> {
  if (!list.length) return
  testing.value = true
  let done = 0
  store.log('info', '[speedtest]', `开始对 ${list.length} 个节点做真实 TCP 握手探测（并发 6，超时 3s；握手延迟不等于代理端到端延迟）`)
  const queue = [...list]
  async function worker() {
    while (queue.length) {
      const n = queue.shift()!
      const r = await store.pingNode(n)
      latencies.value = { ...latencies.value, [n.id]: { ms: r.ms, error: r.error } }
      done++
      testProgress.value = `${done}/${list.length}`
      store.log(r.ok ? 'success' : 'warn', '[speedtest]',
        r.ok ? `${n.name} TCP 握手 ${r.ms} ms` : `${n.name} 不可达：${r.error ?? '未知原因'}`)
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker)) }
  finally { testing.value = false; testProgress.value = '' }
}

function quickPing() { return bulkPing(targets.value) }

/** 真连下载测速：给每个节点临时起独立内核，经代理真实下载，不改系统代理 */
async function runSpeed(list: UnifiedNode[]) {
  if (!list.length) { store.log('warn', '[speedtest]', '没有可测速的节点'); return }
  await store.startSpeedTest(list)
}
function runBulk() { return runSpeed(targets.value) }
function runOne(n: UnifiedNode) { return runSpeed([n]) }

/** 一键全检：先握手剔除不可达，再只对可达节点跑真连下载（省流量、省时间） */
async function runAll() {
  if (busy.value || testing.value) return
  const list = targets.value
  if (!list.length) { store.log('warn', '[speedtest]', '没有可全检的节点'); return }
  await bulkPing(list)
  const reachable = list.filter(n => latencies.value[n.id]?.ms != null)
  if (!reachable.length) {
    store.log('warn', '[speedtest]', 'TCP 握手全部不可达，已跳过真连下载测速（未消耗流量）')
    return
  }
  store.log('info', '[speedtest]', `握手可达 ${reachable.length}/${list.length} 个，只对可达节点跑真连下载测速`)
  await runSpeed(reachable)
}

function removeSelected() {
  selected.value.forEach(id => store.removeNode(id))
  selected.value = []
}

/** 连接 / 热切换：未连接 → 直接启动；运行中 → 杀旧拉新，失败自动回退 */
async function connectNode(n: UnifiedNode) { await store.activateNode(n) }
const isCurrent = (n: UnifiedNode) => store.runtime.state === 'running' && store.runtime.node?.id === n.id
</script>

<template>
  <div class="card panel">
    <div class="head">
      <div>
        <h3>节点管家</h3>
        <p class="sub">管理 · 测速 · 连接，一页做完 · 按协议分组 · 所有节点保留完整原始配置</p>
      </div>
      <span class="cnt">{{ store.nodes.length }} 个节点<span v-if="store.problemCount" class="bad-text"> · {{ store.problemCount }} 个有阻断问题</span></span>
    </div>

    <!-- 第一排：筛选与管理 -->
    <div class="toolbar">
      <input v-model="filterName" placeholder="搜索名称 / 服务器 / 协议" style="flex:1;min-width:180px" />
      <select v-model="regionFilter" title="按代理国家/地区筛选（识别自节点名里的真实地区关键词）">
        <option value="">全部地区</option>
        <option v-for="[key, count] in regionOptions" :key="key" :value="key">{{ key }}（{{ count }}）</option>
      </select>
      <select v-model="sortKey" title="排序依据">
        <option value="addedAt">按添加时间</option>
        <option value="name">按名称</option>
        <option value="protocol">按协议</option>
        <option value="kernel">按内核</option>
        <option value="latency">按 TCP 延迟</option>
        <option value="speed">按下载速度</option>
      </select>
      <button class="btn" :disabled="store.geoBusy || !store.nodes.length" title="向免费归属地服务真实查询节点服务器的国家（带 30 天缓存，只查名字里认不出地区的）" @click="store.lookupGeo()">
        {{ store.geoBusy ? '归属地查询中…' : '查询IP归属地' }}
      </button>
      <button class="btn danger" :disabled="!selected.length" @click="removeSelected">删除选中</button>
      <button class="btn danger" :disabled="!store.nodes.length" @click="store.clearAll()">清空</button>
    </div>

    <!-- 第二排：测速（两档 + 一键全检） -->
    <div class="toolbar speed-bar">
      <select v-model="store.speedTarget" :disabled="busy" title="真连下载测速目标（白名单，避免被恶意地址利用）" style="min-width:210px">
        <option v-for="t in SPEEDTEST_TARGETS" :key="t.id" :value="t.url">{{ t.label }}</option>
      </select>
      <label class="inline"><span>并发</span>
        <input type="number" min="1" max="6" v-model.number="store.speedConcurrency" :disabled="busy" style="width:60px" />
      </label>
      <button class="btn primary" :disabled="busy || testing || !targets.length" title="先 TCP 握手剔除不可达，再只对可达节点跑真连下载测速" @click="runAll">
        ⚡ 一键全检（{{ targets.length }}）
      </button>
      <button class="btn" :disabled="busy || testing || !targets.length" title="只做 TCP 握手，不消耗下载流量" @click="quickPing">
        {{ testing ? `握手中 ${testProgress}` : '快速握手' }}
      </button>
      <button class="btn" :disabled="busy || testing || !targets.length" @click="runBulk">
        {{ busy ? `测速中 ${finishedCount}/${targets.length}` : `真连下载测速（${targets.length}）` }}
      </button>
      <button class="btn danger" :disabled="!busy" @click="store.cancelSpeedTest()">取消</button>
      <label class="inline check"><input type="checkbox" :checked="selected.length === filtered.length && filtered.length > 0" @change="toggleAll" /><span>全选</span></label>
      <span class="tiny dim flow-hint">真连测速会消耗下载流量：默认 10MB × 节点数</span>
    </div>

    <div v-if="hasSpeedResult || testing" class="summary">
      <span>已完成 <b>{{ finishedCount }}</b> / {{ targets.length }}</span>
      <span>可用（≥2 Mbps）<b class="ok-text">{{ usableCount }}</b></span>
      <span v-if="fastest">最快 <b class="ok-text">{{ fastest.name }}</b> · {{ formatMbps(fastest.mbps) }}</span>
      <span class="dim tiny">结果按节点直接显示在下方卡片里，可当场点「连接 / 切换」</span>
    </div>

    <div v-if="!filtered.length" class="empty">
      暂无节点。请到「配置导入」「二维码识别」或「订阅管理」导入配置。<br />
      <span class="tiny dim">导入后需在预览中点击「确认导入」才会写入这里。</span>
    </div>

    <div v-for="[proto, items] in grouped" :key="proto" class="group">
      <div class="group-title">{{ proto }} <span class="tiny dim">{{ items.length }}</span></div>
      <div v-for="n in items" :key="n.id" class="node" :class="{ running: ['tcp','starting','download'].includes(speedRows[n.id]?.phase ?? '') }">
        <div class="node-main" @click="expanded = expanded === n.id ? null : n.id">
          <input type="checkbox" :checked="selected.includes(n.id)" @click.stop @change="toggleSelect(n.id)" />
          <span class="tag">{{ label(n.protocol) }}</span>
          <FlagIcon :code="displayCode(n)" :title="flagSource(n)" />
          <span class="country" :title="flagSource(n)">{{ countryLabel(n) || '未识别' }}</span>
          <b class="name">{{ n.name }}</b>
          <span class="mono tiny addr">{{ n.server }}:{{ n.port }}</span>
          <span class="tiny dim">{{ n.transport }} / {{ n.security }}</span>
          <span class="tiny kernel">{{ kernelLabel(n.kernel) }}</span>

          <!-- TCP 握手结果（快速握手或真连测速里的那次） -->
          <span v-if="pingMs(n) !== Infinity" class="badge ok" title="TCP 握手延迟：到服务器端口的往返时间">
            {{ pingMs(n) }} ms
          </span>
          <span v-else-if="latencies[n.id]" class="badge bad" title="TCP 握手不可达">不可达</span>

          <!-- 真连下载结果 -->
          <span v-if="speedRows[n.id]?.mbps != null" class="badge speed-badge" title="经代理真实下载测得的带宽">
            {{ formatMbps(speedRows[n.id].mbps) }}
          </span>
          <span v-if="speedRows[n.id]" :class="['badge', gradeClass[speedRows[n.id].grade]]"
                :title="speedRows[n.id].error ?? SPEED_GRADE_HINTS[speedRows[n.id].grade]">
            {{ speedText(n) }}
          </span>

          <span v-if="n.issues.some(i => i.level === 'error')" class="badge bad">缺字段</span>
          <span v-else-if="!n.lossless" class="badge warn">待确认 {{ Object.keys(n.extras).length }}</span>
          <span v-else class="badge ok">完整</span>

          <button class="btn mini" :disabled="busy || testing || n.issues.some(i => i.level === 'error')" title="只测这一个节点的真实下载速度" @click.stop="runOne(n)">测速</button>
          <button class="btn mini connect-btn" :class="{ current: isCurrent(n) }"
                  :disabled="store.runtimeBusy || n.issues.some(i => i.level === 'error')"
                  @click.stop="connectNode(n)">
            {{ isCurrent(n) ? '当前节点' : store.runtime.state === 'running' ? '⇄ 切换' : '▶ 连接' }}
          </button>
        </div>
        <div v-if="expanded === n.id" class="node-detail">
          <div class="detail-grid">
            <div><b>代理地区</b><FlagIcon :code="displayCode(n)" :title="flagSource(n)" /> {{ countryLabel(n) || regionOf(n) }}<span v-if="store.geoCode(n.server)" class="tiny dim">（IP 归属地：{{ countryName(store.geoCode(n.server)) }} · {{ store.geoCode(n.server) }}）</span></div>
            <div><b>协议别名</b>{{ n.protocolAlias ?? n.protocol }}</div>
            <div><b>传输 / 安全</b>{{ n.transport }} / {{ n.security }}</div>
            <div><b>流控</b>{{ n.flow ?? '—' }}</div>
            <div><b>指纹</b><span class="mono">{{ n.fingerprint }}</span></div>
            <div><b>可用内核</b>{{ n.kernels.join(' / ') || '无' }}</div>
            <div><b>来源</b>{{ n.source }}</div>
            <div v-if="speedRows[n.id]"><b>首字节</b>{{ speedRows[n.id].ttfbMs != null ? speedRows[n.id].ttfbMs + ' ms' : '—' }}</div>
            <div v-if="speedRows[n.id]"><b>实测下载</b>{{ speedRows[n.id].bytes ? formatBytes(speedRows[n.id].bytes) : '—' }}</div>
          </div>
          <div class="kv"><b>选核依据：</b>{{ n.kernelReason }}</div>
          <div v-if="n.tls" class="kv"><b>TLS：</b><span class="mono">{{ JSON.stringify(n.tls) }}</span></div>
          <div v-if="n.reality" class="kv"><b>Reality：</b><span class="mono">{{ JSON.stringify(n.reality) }}</span></div>
          <div v-if="Object.keys(n.transportSettings).length" class="kv"><b>传输参数：</b><span class="mono">{{ JSON.stringify(n.transportSettings) }}</span></div>
          <div v-if="Object.keys(n.extras).length" class="kv warn-text"><b>未映射字段（原值保留）：</b><span class="mono">{{ JSON.stringify(n.extras) }}</span></div>
          <div v-for="(i, k) in n.issues.filter(x => x.level !== 'info')" :key="k" class="kv" :class="i.level">· {{ i.message }}</div>
          <details><summary>原始配置 / 解码明文</summary><pre class="mono">{{ n.rawDecoded ?? n.raw }}</pre></details>
        </div>
      </div>
    </div>

    <!-- 判定标准与实测明细（沿用原节点测速页，避免合并后丢信息） -->
    <div v-if="hasSpeedResult" class="detail">
      <div class="detail-title">判定标准</div>
      <div class="detail-grid">
        <div v-for="(hint, g) in SPEED_GRADE_HINTS" :key="g">
          <b :class="'g-' + g">{{ SPEED_GRADE_LABELS[g as SpeedGrade] }}</b>{{ hint }}
        </div>
      </div>
      <div class="detail-note">
        握手 = 到服务器端口的 TCP 往返；首字节 = 经代理加密转发并拿到目标响应的时间；
        下载速度 = 本次真实下载字节数 ÷ 下载耗时。下载量不足 20KB 或目标是 204 时只判连通，不给带宽结论。
      </div>
      <div class="detail-note">
        本轮实测下载明细：
        <span v-for="r in (Object.values(speedRows) as SpeedTestRow[]).filter(x => x.bytes > 0)" :key="r.id" class="chip">
          {{ r.name }} {{ formatBytes(r.bytes) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel h3 { font-size: 15px; margin-bottom: 4px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sub { font-size: 12px; color: var(--text-muted); margin: 0; }
.cnt { font-size: 12px; color: var(--accent); white-space: nowrap; }
.bad-text { color: var(--danger); }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 6px; align-items: center; }
.speed-bar { margin-top: 4px; padding: 9px 10px; background: var(--bg-inset); border: 1px solid var(--divider); border-radius: var(--radius-md); }
.inline { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.inline.check { gap: 4px; }
.flow-hint { margin-left: auto; }
.btn.primary { color:#fff; background:linear-gradient(135deg,var(--accent),#2563eb); border-color:transparent; font-weight:600; }
.btn.primary:disabled { opacity:.5; }
.summary { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; font-size: 11px; color: var(--text-muted); margin: 8px 0 10px; }
.summary b { color: var(--text); font-weight: 600; }
.ok-text { color: var(--success) !important; }
.empty { font-size: 13px; color: var(--text-muted); text-align: center; padding: 28px; background: var(--bg-inset); border-radius: var(--radius-md); line-height: 1.9; }
.tiny { font-size: 11px; } .dim { color: var(--text-muted); }
.group { margin-bottom: 14px; }
.group-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); padding: 6px 2px 8px; }
/* 每个节点独立成卡：与首页卡片一致的渐变底 + 边框 + 圆角 + 悬停上浮 */
.node { border: 1px solid var(--border); border-radius: 10px; background: linear-gradient(135deg, var(--bg-elevated) 0%, var(--bg-inset) 100%); margin-bottom: 8px; overflow: hidden; transition: border-color .15s, transform .15s; }
.node:hover { border-color: var(--border-strong); transform: translateY(-1px); }
.node.running { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim); }
.node-main { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; font-size: 12px; color: var(--text-secondary); flex-wrap: wrap; }
.node-main:hover { background: var(--surface-hover); }
.tag { font-size: 10px; color: var(--accent); background: var(--accent-dim); border-radius: var(--radius-full); padding: 1px 7px; }
.name { color: var(--text); min-width: 100px; }
.country { font-size: 11px; color: var(--text-secondary); flex: none; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.addr { min-width: 140px; }
.kernel { color: var(--purple); }
.badge { font-size: 10px; padding: 1px 7px; border-radius: var(--radius-full); white-space: nowrap; }
.badge.ok { color: var(--success); background: var(--success-dim); }
.badge.warn { color: var(--warning); background: rgba(245,158,11,.12); }
.badge.bad { color: var(--danger); background: var(--danger-dim); }
.badge.dim { color: var(--text-muted); background: var(--bg-inset); }
.speed-badge { color: var(--text); background: var(--accent-dim); font-weight: 600; }
.node-detail { padding: 10px 14px 14px 30px; background: var(--bg-inset); border-top: 1px solid var(--divider); font-size: 12px; color: var(--text-secondary); line-height: 1.8; }
.detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 12px; margin-bottom: 8px; }
.detail-grid b { color: var(--text-muted); font-weight: 500; margin-right: 6px; }
.kv { word-break: break-all; } .kv.error { color: var(--error-text); } .kv.warning { color: var(--warn-text); }
.warn-text { color: var(--warning); }
.node-detail pre { max-height: 200px; overflow: auto; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
.connect-btn { padding: 2px 9px; font-size: 10.5px; white-space: nowrap; margin-left: auto; }
.connect-btn.current { color: var(--success); border-color: var(--success); background: var(--success-dim); cursor: default; }
details summary { cursor: pointer; color: var(--accent); margin-top: 6px; }
.detail { margin-top: 13px; padding: 11px 13px; background: var(--bg-inset); border-radius: var(--radius-md); font-size: 11px; color: var(--text-muted); line-height: 1.8; }
.detail-title { font-size: 12px; color: var(--text-secondary); font-weight: 600; margin-bottom: 5px; }
.detail .detail-grid { grid-template-columns: repeat(2, 1fr); gap: 2px 14px; }
.detail .detail-grid b { margin-right: 6px; font-weight: 600; }
.g-fast, .g-ok { color: var(--success); }
.g-slow { color: var(--warning); }
.g-bad { color: var(--danger); }
.g-unknown { color: var(--text-muted); }
.detail-note { margin-top: 6px; }
.chip { display: inline-block; margin: 0 6px 4px 0; padding: 0 6px; border: 1px solid var(--divider); border-radius: var(--radius-full); font-size: 10px; }
</style>
