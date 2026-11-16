<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../store.js'
import { PROTOCOL_LABELS } from '../../core/hub/model.js'
import type { UnifiedNode } from '../../core/hub/model.js'
import {
  SPEEDTEST_TARGETS, SPEED_GRADE_LABELS, SPEED_GRADE_HINTS,
  formatBytes, formatMbps,
  type SpeedGrade, type SpeedTestRow,
} from '../../core/runtime/speedtest.js'

const store = useAppStore()

const selected = ref<string[]>([])
const sortKey = ref<'speed' | 'latency' | 'name'>('speed')
const onlySelected = ref(false)

/** 只有「完整」且未阻断的节点才能测出真实速度 */
const candidates = computed(() => store.nodes.filter(n => !n.issues.some(i => i.level === 'error')))

const visible = computed(() => {
  const base = onlySelected.value
    ? candidates.value.filter(n => selected.value.includes(n.id))
    : candidates.value
  const row = (n: UnifiedNode) => store.speedRows[n.id]
  return [...base].sort((a, b) => {
    if (sortKey.value === 'name') return a.name.localeCompare(b.name)
    if (sortKey.value === 'latency') {
      return (row(a)?.latencyMs ?? Infinity) - (row(b)?.latencyMs ?? Infinity)
    }
    // 速度：已测出带宽的按速度降序，未测的排后面
    return (row(b)?.mbps ?? -1) - (row(a)?.mbps ?? -1)
  })
})

/** 勾选了才测；初次进入默认全选，避免用户以为按钮坏了 */
const targets = computed(() => candidates.value.filter(n => selected.value.includes(n.id)))

const busy = computed(() => store.speedBusy)
const rows = computed(() => store.speedRows)

const finishedCount = computed(() => targets.value.filter(n => {
  const p = rows.value[n.id]?.phase
  return p === 'done' || p === 'error' || p === 'cancelled'
}).length)

const fastest = computed(() => {
  const list = Object.values(rows.value).filter(r => (r.mbps ?? 0) > 0) as SpeedTestRow[]
  if (!list.length) return null
  return list.sort((a, b) => (b.mbps ?? 0) - (a.mbps ?? 0))[0]
})

const usableCount = computed(() => Object.values(rows.value)
  .filter(r => r.phase === 'done' && (r.mbps ?? 0) >= 2).length)

const gradeClass: Record<SpeedGrade, string> = {
  fast: 'ok', ok: 'ok', slow: 'warn', bad: 'bad', unknown: 'dim',
}

const phaseText: Record<string, string> = {
  pending: '排队中',
  tcp: '测握手…',
  starting: '起内核…',
  download: '下载测速…',
  done: '完成',
  error: '失败',
  cancelled: '已取消',
}

const label = (p: string) => PROTOCOL_LABELS[p as keyof typeof PROTOCOL_LABELS] ?? p.toUpperCase()

function toggle(id: string) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}

function toggleAll() {
  selected.value = selected.value.length === candidates.value.length ? [] : candidates.value.map(n => n.id)
}

async function runOne(n: UnifiedNode) {
  await store.startSpeedTest([n])
}

async function runBulk() {
  await store.startSpeedTest(targets.value)
}

/** 测完可直接连上这个节点（复用节点管理里的连接 / 热切换逻辑） */
async function connectNode(n: UnifiedNode) {
  await store.activateNode(n)
}

onMounted(() => {
  if (!selected.value.length) selected.value = candidates.value.map(n => n.id)
})
watch(candidates, list => {
  // 新导入的节点默认参与测速
  for (const n of list) if (!selected.value.includes(n.id)) selected.value.push(n.id)
})
</script>

<template>
  <div class="card panel">
    <div class="head">
      <div>
        <h3>节点测速</h3>
        <p class="sub">
          真连测速：给每个节点临时起一个独立内核，经代理真实下载取速度。不是 TCP 握手，也不是估算值。
          全程不改系统代理，结束后自动清理临时进程与配置。
        </p>
      </div>
      <span class="cnt">{{ store.nodes.length }} 个节点 · 可测 {{ candidates.length }}</span>
    </div>

    <div class="toolbar">
      <select v-model="store.speedTarget" :disabled="busy" style="min-width:240px">
        <option v-for="t in SPEEDTEST_TARGETS" :key="t.id" :value="t.url">{{ t.label }}</option>
      </select>
      <label class="inline">
        <span>并发</span>
        <input type="number" min="1" max="6" v-model.number="store.speedConcurrency" :disabled="busy" style="width:64px" />
      </label>
      <button class="btn" :disabled="busy || !targets.length" @click="runBulk">
        {{ busy ? `测速中 ${finishedCount}/${targets.length}` : `开始测速（${targets.length}）` }}
      </button>
      <button class="btn danger" :disabled="!busy" @click="store.cancelSpeedTest()">取消</button>
      <label class="inline check"><input type="checkbox" v-model="onlySelected" /><span>只看已选</span></label>
      <select v-model="sortKey" style="margin-left:auto">
        <option value="speed">按速度排序</option>
        <option value="latency">按握手延迟排序</option>
        <option value="name">按名称</option>
      </select>
    </div>

    <div class="summary">
      <span>已完成 <b>{{ finishedCount }}</b> / {{ targets.length }}</span>
      <span>可用（≥2 Mbps）<b class="ok-text">{{ usableCount }}</b></span>
      <span v-if="fastest">最快 <b class="ok-text">{{ fastest.name }}</b> · {{ formatMbps(fastest.mbps) }}</span>
      <span class="dim tiny">测速会真实消耗流量：默认目标 10MB × 节点数，请留意流量套餐。</span>
    </div>

    <div v-if="!candidates.length" class="empty">
      没有可测速的节点。请先到「配置导入」「二维码识别」或「订阅管理」导入配置。
    </div>

    <div v-else class="table-wrap">
      <table class="speed-table">
        <thead>
          <tr>
            <th style="width:34px">
              <input type="checkbox" :checked="selected.length === candidates.length"
                     @change="toggleAll" />
            </th>
            <th>节点</th>
            <th>协议</th>
            <th>服务器</th>
            <th>内核</th>
            <th>握手</th>
            <th>首字节</th>
            <th>下载速度</th>
            <th>结论</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="n in visible" :key="n.id" :class="{ running: ['tcp','starting','download'].includes(rows[n.id]?.phase ?? '') }">
            <td><input type="checkbox" :checked="selected.includes(n.id)" @change="toggle(n.id)" /></td>
            <td class="name">{{ n.name }}</td>
            <td><span class="tag">{{ label(n.protocol) }}</span></td>
            <td class="mono tiny">{{ n.server }}:{{ n.port }}</td>
            <td class="tiny dim">{{ n.kernel ?? '—' }}</td>
            <td class="mono">{{ rows[n.id]?.latencyMs != null ? rows[n.id].latencyMs + ' ms' : '—' }}</td>
            <td class="mono">{{ rows[n.id]?.ttfbMs != null ? rows[n.id].ttfbMs + ' ms' : '—' }}</td>
            <td class="mono speed">{{ rows[n.id]?.mbps != null ? formatMbps(rows[n.id].mbps) : '—' }}</td>
            <td>
              <span v-if="rows[n.id]" :class="['badge', gradeClass[rows[n.id].grade]]" :title="rows[n.id].error ?? SPEED_GRADE_HINTS[rows[n.id].grade]">
                {{ rows[n.id].phase === 'error' ? '不可用' : rows[n.id].phase === 'cancelled' ? '已取消'
                   : rows[n.id].phase !== 'done' ? phaseText[rows[n.id].phase] : SPEED_GRADE_LABELS[rows[n.id].grade] }}
              </span>
              <span v-else class="badge dim">未测</span>
            </td>
            <td class="ops">
              <button class="btn mini" :disabled="busy" @click="runOne(n)">测速</button>
              <button class="btn mini" :disabled="store.runtimeBusy"
                      @click="connectNode(n)">{{ store.runtime.state === 'running' ? '切换' : '连接' }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="Object.keys(rows).length" class="detail">
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
        <span v-for="r in (Object.values(rows) as SpeedTestRow[]).filter(x => x.bytes > 0)" :key="r.id" class="chip">
          {{ r.name }} {{ formatBytes(r.bytes) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel h3 { font-size: 15px; margin-bottom: 4px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sub { font-size: 12px; color: var(--text-muted); margin: 0; line-height: 1.7; max-width: 720px; }
.cnt { font-size: 12px; color: var(--accent); white-space: nowrap; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0 10px; align-items: center; }
.inline { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); }
.inline.check { gap: 4px; }
.summary { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; font-size: 11px; color: var(--text-muted); margin-bottom: 10px; }
.summary b { color: var(--text); font-weight: 600; }
.ok-text { color: var(--success) !important; }
.empty { font-size: 13px; color: var(--text-muted); text-align: center; padding: 28px; background: var(--bg-inset); border-radius: var(--radius-md); }
.table-wrap { overflow-x: auto; border: 1px solid var(--divider); border-radius: var(--radius-md); }
.speed-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.speed-table th { text-align: left; padding: 7px 8px; color: var(--text-muted); font-weight: 500; border-bottom: 1px solid var(--divider); white-space: nowrap; background: var(--bg-inset); }
.speed-table td { padding: 7px 8px; color: var(--text-secondary); border-bottom: 1px solid var(--divider); white-space: nowrap; }
.speed-table tr:hover td { background: var(--surface-hover); }
.speed-table tr.running td { background: var(--nav-hover); }
.speed-table tr:last-child td { border-bottom: none; }
.name { color: var(--text); max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.mono { font-family: var(--font-mono, ui-monospace, monospace); }
.tiny { font-size: 11px; } .dim { color: var(--text-muted); }
.tag { font-size: 10px; color: var(--accent); background: var(--accent-dim); border-radius: var(--radius-full); padding: 1px 7px; }
.speed { color: var(--text); font-weight: 600; }
.badge { font-size: 10px; padding: 1px 7px; border-radius: var(--radius-full); }
.badge.ok { color: var(--success); background: var(--success-dim); }
.badge.warn { color: var(--warning); background: rgba(245,158,11,.12); }
.badge.bad { color: var(--danger); background: var(--danger-dim); }
.badge.dim { color: var(--text-muted); background: var(--bg-inset); }
.ops { display: flex; gap: 4px; }
.detail { margin-top: 13px; padding: 11px 13px; background: var(--bg-inset); border-radius: var(--radius-md); font-size: 11px; color: var(--text-muted); line-height: 1.8; }
.detail-title { font-size: 12px; color: var(--text-secondary); font-weight: 600; margin-bottom: 5px; }
.detail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 14px; }
.detail-grid b { margin-right: 6px; font-weight: 600; }
.g-fast, .g-ok { color: var(--success); }
.g-slow { color: var(--warning); }
.g-bad { color: var(--danger); }
.g-unknown { color: var(--text-muted); }
.detail-note { margin-top: 6px; }
.chip { display: inline-block; margin: 0 6px 4px 0; padding: 0 6px; border: 1px solid var(--divider); border-radius: var(--radius-full); font-size: 10px; }
</style>
