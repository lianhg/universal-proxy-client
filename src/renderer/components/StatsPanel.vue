<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../store.js'
import { aggregateConnections, formatBytes, formatSpeed, type AggregateKey } from '../../core/runtime/telemetry.js'

const store = useAppStore()
const rankBy = ref<AggregateKey>('host')

const t = computed(() => store.telemetry)
const points = computed(() => t.value.history)
const W = 720, H = 210, PAD_L = 58, PAD_R = 12, PAD_T = 12, PAD_B = 26

const maxY = computed(() => {
  const m = Math.max(1, ...points.value.map(p => Math.max(p.up, p.down)))
  return Math.ceil(m * 1.15 / 1024) * 1024 || 1024
})

function xOf(i: number): number {
  const n = points.value.length
  if (n <= 1) return PAD_L
  return PAD_L + i / (n - 1) * (W - PAD_L - PAD_R)
}
function yOf(v: number): number {
  return PAD_T + (1 - v / maxY.value) * (H - PAD_T - PAD_B)
}
function line(key: 'up' | 'down'): string {
  return points.value.map((p, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(p[key]).toFixed(1)}`).join(' ')
}
function area(key: 'up' | 'down'): string {
  if (!points.value.length) return ''
  const base = H - PAD_B
  return `${line(key)} L${xOf(points.value.length - 1).toFixed(1)},${base} L${xOf(0).toFixed(1)},${base} Z`
}
const gridLines = computed(() => [0, 0.25, 0.5, 0.75, 1].map(r => ({
  y: PAD_T + r * (H - PAD_T - PAD_B),
  label: formatBytes(maxY.value * (1 - r), 0),
})))
const peak = computed(() => ({
  down: Math.max(0, ...points.value.map(p => p.down)),
  up: Math.max(0, ...points.value.map(p => p.up)),
}))
const rank = computed(() => aggregateConnections(t.value.connections, rankBy.value, 10))
const rankLabel: Record<AggregateKey, string> = { process: '进程', host: '目标域名', rule: '规则', outbound: '走向', chain: '出口节点' }
</script>

<template>
  <div class="card panel">
    <div class="head">
      <div>
        <h3>流量统计 · 内核真实数据</h3>
        <p class="sub">Xray 走 StatsService gRPC，sing-box / Mihomo 走 clash_api /connections；每秒采样累计字节并差分计算速率，图表只画真实采样点，不插值、不补随机数</p>
      </div>
      <span class="cnt">{{ t.state === 'active' ? '采样中' : '未采样' }} · {{ points.length }} 个采样点</span>
    </div>

    <div v-if="!t.supported || t.error" class="notice">
      <b>{{ t.error ? '统计接口异常' : t.kernel ? '统计接口暂不可用' : '没有可用的遥测数据源' }}</b>
      <div>{{ t.error ?? t.reason }}</div>
    </div>

    <div class="metrics">
      <div class="m"><span>当前下行</span><b class="down">{{ formatSpeed(t.downSpeed) }}</b></div>
      <div class="m"><span>当前上行</span><b class="up">{{ formatSpeed(t.upSpeed) }}</b></div>
      <div class="m"><span>本次累计下载</span><b>{{ formatBytes(t.downloadTotal) }}</b></div>
      <div class="m"><span>本次累计上传</span><b>{{ formatBytes(t.uploadTotal) }}</b></div>
      <div class="m"><span>峰值下行 / 上行</span><b class="tiny">{{ formatSpeed(peak.down) }} / {{ formatSpeed(peak.up) }}</b></div>
      <div class="m"><span>活跃连接</span><b>{{ t.kernel === 'xray' ? '不支持' : t.activeConnections }}</b></div>
    </div>

    <div class="chart-card">
      <div class="chart-head">
        <b>实时速率（最近 {{ points.length }} 秒）</b>
        <div class="legend"><span class="dot dn"></span>下行 <span class="dot up"></span>上行</div>
      </div>
      <svg :viewBox="`0 0 ${W} ${H}`" class="chart" preserveAspectRatio="none">
        <g v-for="(g, i) in gridLines" :key="i">
          <line :x1="PAD_L" :x2="W - PAD_R" :y1="g.y" :y2="g.y" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4" />
          <text :x="PAD_L - 6" :y="g.y + 3" text-anchor="end" fill="var(--text-faint)" font-size="9">{{ g.label }}</text>
        </g>
        <line :x1="PAD_L" :x2="W - PAD_R" :y1="H - PAD_B" :y2="H - PAD_B" stroke="var(--border)" />
        <path v-if="points.length" :d="area('down')" fill="var(--chart-fill)" />
        <path v-if="points.length" :d="area('up')" fill="var(--traffic-fill)" />
        <path v-if="points.length" :d="line('down')" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linejoin="round" />
        <path v-if="points.length" :d="line('up')" fill="none" stroke="var(--green)" stroke-width="2" stroke-linejoin="round" />
        <g v-for="(p, i) in points" :key="i">
          <circle v-if="points.length <= 30" :cx="xOf(i)" :cy="yOf(p.down)" r="2" fill="var(--blue)">
            <title>{{ new Date(p.ts).toLocaleTimeString('zh-CN', { hour12: false }) }} 下行 {{ formatSpeed(p.down) }}</title>
          </circle>
        </g>
        <text v-if="!points.length" :x="W / 2" :y="H / 2" text-anchor="middle" fill="var(--text-muted)" font-size="12">
          {{ t.supported ? '等待内核采样数据…' : '统计接口暂不可用' }}
        </text>
        <text :x="PAD_L" :y="H - 8" fill="var(--text-faint)" font-size="9">{{ points.length ? new Date(points[0].ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—' }}</text>
        <text :x="W - PAD_R" :y="H - 8" text-anchor="end" fill="var(--text-faint)" font-size="9">{{ points.length ? new Date(points[points.length - 1].ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—' }}</text>
      </svg>
    </div>

    <div class="table-card">
      <div class="chart-head">
        <b>流量排行（按当前活跃连接的累计字节）</b>
        <div class="rank-tabs">
          <button v-for="k in (['host','process','rule','chain','outbound'] as AggregateKey[])" :key="k"
                  :class="['chip', { on: rankBy === k }]" @click="rankBy = k">{{ rankLabel[k] }}</button>
        </div>
      </div>
      <table class="grid">
        <thead><tr><th>{{ rankLabel[rankBy] }}</th><th>连接数</th><th>上传</th><th>下载</th><th>合计</th></tr></thead>
        <tbody>
          <tr v-for="r in rank" :key="r.key">
            <td class="ellipsis" :title="r.key">{{ r.key }}</td>
            <td class="mono">{{ r.connections }}</td>
            <td class="mono">↑ {{ formatBytes(r.upload) }}</td>
            <td class="mono">↓ {{ formatBytes(r.download) }}</td>
            <td class="mono"><b>{{ formatBytes(r.total) }}</b></td>
          </tr>
          <tr v-if="!rank.length"><td colspan="5" class="empty">当前没有活跃连接，暂无排行数据</td></tr>
        </tbody>
      </table>
    </div>

    <p class="hint">
      累计流量是「本次内核启动以来」的总量，断开或切换节点后会重新计；历史序列最多保留最近 60 个采样点。
      内核版本 {{ t.kernelVersion || '—' }} · 内存占用 {{ t.memory !== null ? formatBytes(t.memory) : '接口未提供' }}。
    </p>
  </div>
</template>

<style scoped>
.panel h3 { font-size:15px; margin-bottom:4px; }
.head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
.sub { font-size:12px; color:var(--text-muted); margin:0; }
.cnt { font-size:12px; color:var(--accent); white-space:nowrap; }
.notice { margin-top:12px; padding:10px 12px; border:1px solid var(--warning); background:var(--bg-inset); border-radius:var(--radius-md); font-size:12px; color:var(--text-secondary); line-height:1.7; }
.metrics { display:grid; grid-template-columns:repeat(6,1fr); gap:8px; margin:12px 0; }
.m { background:var(--bg-inset); border:1px solid var(--border); border-radius:var(--radius-md); padding:9px; display:flex; flex-direction:column; gap:4px; }
.m span { font-size:10px; color:var(--text-muted); } .m b { font-size:15px; color:var(--text); }
.m b.down { color:var(--accent); } .m b.up { color:var(--success); } .m b.tiny { font-size:11px; }
.chart-card, .table-card { border:1px solid var(--border); border-radius:var(--radius-md); background:var(--bg-inset); padding:10px 12px; margin-bottom:10px; }
.chart-head { display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12px; color:var(--text-secondary); margin-bottom:8px; flex-wrap:wrap; }
.legend { font-size:10px; color:var(--text-muted); display:flex; align-items:center; gap:5px; }
.dot { width:8px; height:8px; border-radius:50%; display:inline-block; } .dot.dn { background:var(--blue); } .dot.up { background:var(--green); margin-left:8px; }
.chart { width:100%; height:210px; display:block; }
.grid { width:100%; border-collapse:collapse; font-size:11.5px; }
.grid th { text-align:left; color:var(--text-muted); font-weight:500; padding:6px 8px; border-bottom:1px solid var(--border); }
.grid td { padding:6px 8px; border-bottom:1px solid var(--divider); color:var(--text-secondary); }
.ellipsis { max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.empty { text-align:center; color:var(--text-muted); padding:18px; }
.rank-tabs { display:flex; gap:4px; flex-wrap:wrap; }
.chip { font-size:10px; padding:3px 7px; border-radius:10px; border:1px solid var(--border); background:var(--bg-inset); color:var(--text-muted); cursor:pointer; }
.chip.on { color:var(--accent); border-color:var(--accent); }
.tiny { font-size:10px; }
.hint { font-size:11px; color:var(--text-muted); line-height:1.7; margin:8px 0 0; }
</style>
