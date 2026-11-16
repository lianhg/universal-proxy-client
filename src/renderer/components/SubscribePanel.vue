<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../store.js'

const store = useAppStore()
import { fetchSubscription, parseConfig, runtimeAvailable } from '../api.js'
import ImportReportView from './ImportReportView.vue'
import type { Subscription } from '../../types.js'
import type { ImportReport, UnifiedNode } from '../../core/hub/model.js'

const url = ref('')
const name = ref('')
const loading = ref(false)
const msg = ref('')
const updatingId = ref('')
const report = ref<ImportReport | null>(null)
const pendingSub = ref<Subscription | null>(null)
const hours = ref(store.autoUpdateHours)
const busyAll = ref(false)
const runtimeOk = computed(() => runtimeAvailable())
const pendingNodes = ref<UnifiedNode[]>([])
const emit = defineEmits<{ add: [items: UnifiedNode[], overwrite: boolean] }>()

function validUrl(u: string): boolean {
  try {
    const x = new URL(u.trim())
    return ['http:', 'https:'].includes(x.protocol)
  } catch { return false }
}

function addSubscription() {
  const u = url.value.trim()
  if (!validUrl(u)) { msg.value = '请输入合法的 http/https 订阅地址'; return }
  const sub: Subscription = {
    id: crypto.randomUUID(),
    name: name.value.trim() || (u.split('/').pop()?.split('?')[0] || '未命名订阅'),
    url: u, proxies: [],
  }
  store.subscriptions.push(sub)
  store.log('success', '[subscription]', `已添加订阅「${sub.name}」（仅登记地址，未发起请求）`, u)
  msg.value = `已登记订阅「${sub.name}」。点击「更新」才会拉取内容。`
  url.value = ''; name.value = ''
}

async function update(sub: Subscription) {
  loading.value = true; updatingId.value = sub.id; msg.value = ''
  report.value = null
  try {
    store.log('info', '[network]', `用户确认拉取订阅「${sub.name}」`, sub.url)
    const r = await fetchSubscription(sub.url)
    if (!r.ok) {
      msg.value = `拉取失败：${r.error}`
      store.log('error', '[subscription]', `订阅「${sub.name}」拉取失败：${r.error}`)
      return
    }
    const rep = await parseConfig(r.text ?? '', { source: `subscription:${sub.url}`, existingFingerprints: [...store.fingerprints] })
    report.value = rep
    pendingNodes.value = rep.nodes
    pendingSub.value = sub
    store.recordReport(rep, `订阅更新 ${sub.name}`)
    msg.value = `已拉取 ${(r.text ?? '').length} 字符，识别 ${rep.stats.parsed} 个节点，失败 ${rep.stats.failed}；请在下方预览中确认后再合并。`
  } catch (e) {
    msg.value = String(e)
    store.log('error', '[subscription]', String(e))
  } finally { loading.value = false; updatingId.value = '' }
}

function confirmMerge(nodes: UnifiedNode[], overwrite: boolean) {
  if (pendingSub.value) {
    // mergeSubscription 内部已完成去重合并与节点写入，不再重复 emit，避免二次导入
    const r = store.mergeSubscription(pendingSub.value, nodes, { overwrite })
    msg.value = `订阅「${pendingSub.value.name}」已合并：新增 ${r.added}，跳过重复 ${r.skipped}`
  }
  report.value = null; pendingSub.value = null
}

function remove(sub: Subscription) {
  store.subscriptions = store.subscriptions.filter(s => s.id !== sub.id) as any
  store.log('info', '[subscription]', `已移除订阅「${sub.name}」`)
}

const totalNodes = computed(() => store.nodes.length)

function toggleAuto(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  const r = store.setAutoUpdate(on, hours.value)
  msg.value = r.ok
    ? (on ? `自动更新已开启：每 ${hours.value} 小时检查一次到期订阅（默认关闭，随时可关）` : '自动更新已关闭')
    : `自动更新未能开启：${r.error}`
}
function applyHours() {
  store.setAutoUpdate(store.autoUpdateEnabled, hours.value)
  if (store.autoUpdateEnabled) msg.value = `更新周期已改为 ${hours.value} 小时`
}
async function updateAll() {
  busyAll.value = true
  const r = await store.updateAllSubscriptions(true)
  msg.value = r.ok ? `已依次更新 ${r.count} 个订阅，结果见下方更新记录与运行日志` : `批量更新失败：${r.error}`
  busyAll.value = false
}
function nextUpdate(s: Subscription): string {
  if (!store.autoUpdateEnabled || !s.updatedAt) return '—'
  return new Date(s.updatedAt + store.autoUpdateHours * 3600 * 1000).toLocaleString('zh-CN')
}
</script>

<template>
  <div class="card panel">
    <div class="head">
      <div>
        <h3>订阅管理</h3>
        <p class="sub">手动更新走「预览 → 确认」；自动更新默认关闭，开启后按周期拉取并去重合并，每次结果都记录</p>
      </div>
      <span class="cnt">共 {{ store.subscriptions.length }} 个订阅 / {{ totalNodes }} 个节点</span>
    </div>

    <div class="add-row">
      <input v-model="name" placeholder="订阅备注名（可选）" style="width:170px" />
      <input v-model="url" placeholder="https://example.com/sub?token=…" style="flex:1" @keyup.enter="addSubscription" />
      <button class="btn primary" @click="addSubscription">登记订阅</button>
    </div>
    <p v-if="msg" class="notice">{{ msg }}</p>

    <div class="sub-list">
      <div v-if="!store.subscriptions.length" class="empty">暂无订阅。登记后点击「更新」拉取并预览内容。</div>
      <div v-for="s in store.subscriptions" :key="s.id" class="sub-item">
        <div class="si-main">
          <b>{{ s.name }}</b>
          <div class="mono tiny dim">{{ s.url }}</div>
          <div class="tiny dim">
            {{ s.updatedAt ? '上次更新：' + new Date(s.updatedAt).toLocaleString('zh-CN') : '尚未拉取' }}
            · {{ s.proxies?.length ?? 0 }} 个节点
            <template v-if="store.autoUpdateEnabled"> · 下次检查：{{ nextUpdate(s) }}</template>
          </div>
        </div>
        <div class="si-act">
          <button class="btn" :disabled="loading && updatingId === s.id" @click="update(s)">
            {{ loading && updatingId === s.id ? '拉取中…' : '更新' }}
          </button>
          <button class="btn danger" @click="remove(s)">移除</button>
        </div>
      </div>
    </div>

    <div class="settings">
      <div class="auto-row">
        <label class="chk"><input type="checkbox" :checked="store.autoUpdateEnabled" @change="toggleAuto" /> 定时自动更新</label>
        <select v-model.number="hours" @change="applyHours">
          <option :value="1">每 1 小时</option><option :value="3">每 3 小时</option>
          <option :value="6">每 6 小时</option><option :value="12">每 12 小时</option><option :value="24">每 24 小时</option>
        </select>
        <button class="btn" :disabled="busyAll || !store.subscriptions.length || !runtimeOk" @click="updateAll">
          {{ busyAll ? '更新中…' : '立即更新全部' }}
        </button>
        <span class="tiny dim" :class="{ 'bad-text': !runtimeOk }">
          {{ runtimeOk ? '桌面端可用 · 默认关闭' : '浏览器预览模式不能后台拉取订阅' }}
        </span>
      </div>
      <div class="tiny dim">开启后每分钟检查一次到期订阅；仅拉取、解析、按指纹去重合并，默认不覆盖已有节点，也不会静默删除旧节点。手动「更新」仍会先给预览再等确认。</div>

      <div class="sec-title" style="margin-top:8px">更新记录（最近 {{ store.updateHistory.length }} 条）</div>
      <div v-if="!store.updateHistory.length" class="empty">暂无更新记录</div>
      <div v-for="h in store.updateHistory.slice(0, 10)" :key="h.id" class="hist" :class="{ failed: !h.ok }">
        <span class="mono tiny dim">{{ new Date(h.ts).toLocaleString('zh-CN') }}</span>
        <b>{{ h.subName }}</b>
        <span :class="h.ok ? 'ok-text' : 'bad-text'">{{ h.ok ? '成功' : '失败' }}</span>
        <span class="tiny">{{ h.message }}</span>
        <span class="tiny dim">{{ h.manual ? '手动' : '自动' }}</span>
      </div>
    </div>

    <ImportReportView :report="report" title="订阅内容预览" confirm-label="确认合并到节点列表" @confirm="confirmMerge" @clear="report = null" />
  </div>
</template>

<style scoped>
.panel h3 { font-size: 15px; margin-bottom: 4px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sub { font-size: 12px; color: var(--text-muted); margin: 0; }
.cnt { font-size: 12px; color: var(--accent); white-space: nowrap; }
.add-row { display: flex; gap: 8px; margin: 14px 0 6px; flex-wrap: wrap; }
.notice { font-size: 12px; color: var(--warning); margin: 8px 0; word-break: break-all; }
.sub-list { margin-top: 10px; }
.empty { font-size: 12px; color: var(--text-muted); padding: 14px; background: var(--bg-inset); border-radius: var(--radius-md); text-align: center; }
.sub-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px 12px; margin-bottom: 8px; }
.si-main { min-width: 0; font-size: 13px; color: var(--text); }
.si-main .mono { margin: 4px 0; word-break: break-all; }
.si-act { display: flex; gap: 6px; flex: none; }
.tiny { font-size: 11px; } .dim { color: var(--text-muted); }
.settings { border-top: 1px solid var(--divider); margin-top: 12px; padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.chk { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
.auto-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.auto-row select { width:auto; min-width:120px; flex:none; }
.auto-row .btn { flex:none; white-space:nowrap; }
.auto-row .chk { white-space:nowrap; }
.auto-row > .tiny { flex:1 1 100%; }
.sec-title { font-size:12px; font-weight:600; color:var(--text-secondary); }
.hist { display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--text-secondary); padding:5px 8px; background:var(--bg-inset); border:1px solid var(--border); border-radius:var(--radius-sm); margin-bottom:5px; flex-wrap:wrap; }
.hist.failed { border-color:var(--danger); }
.ok-text { color:var(--success); font-size:11px; }
.bad-text { color:var(--danger); }
</style>
