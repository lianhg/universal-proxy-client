<script setup lang="ts">
import { ref, onMounted } from 'vue'
import ImportReportView from './ImportReportView.vue'
import { parseConfig, parseFile, coverage, fetchSubscription } from '../api.js'
import { useAppStore } from '../store.js'

const store = useAppStore()
import type { ImportReport, UnifiedNode } from '../../core/hub/model.js'
import { decodeQRImage, isSupportedImage } from '../../core/hub/qr.js'
import { importQrPayload } from '../../core/hub/index.js'

const emit = defineEmits<{ add: [items: UnifiedNode[], overwrite: boolean] }>()

const text = ref('')
const subUrl = ref('')
const report = ref<ImportReport | null>(null)
const busy = ref(false)
const notice = ref('')
const showCoverage = ref(true)
const cov = ref<any>(null)
const fileInput = ref<HTMLInputElement | null>(null)

onMounted(async () => { cov.value = await coverage() })

function mergeReports(list: ImportReport[]): ImportReport {
  if (!list.length) return null as any
  const base = list[0]
  const sum = (k: 'total' | 'parsed' | 'failed' | 'duplicates' | 'warnings') =>
    list.reduce((n, r) => n + (r.stats?.[k] ?? 0), 0)
  return {
    ...base,
    formatLabel: list.length > 1 ? `${list.length} 份内容合并预览` : base.formatLabel,
    nodes: list.flatMap(r => r.nodes),
    rejected: list.flatMap(r => r.rejected),
    issues: list.flatMap(r => r.issues),
    duplicates: list.flatMap(r => r.duplicates),
    stats: {
      ...base.stats,
      total: sum('total'), parsed: sum('parsed'), failed: sum('failed'),
      duplicates: sum('duplicates'), warnings: sum('warnings'),
      byProtocol: Object.assign({}, ...list.map(r => r.stats.byProtocol)),
    },
    requiresFetch: list.find(r => r.requiresFetch)?.requiresFetch,
  }
}

async function runParse(input?: string, label = '配置导入') {
  const content = input ?? text.value
  if (!content?.trim()) { notice.value = '请先粘贴配置内容，或选择配置文件'; return }
  busy.value = true; notice.value = ''
  try {
    report.value = await parseConfig(content, { source: 'paste', existingFingerprints: [...store.fingerprints] })
    store.recordReport(report.value, label)
  } catch (e) { notice.value = String(e) }
  finally { busy.value = false }
}

async function readClipboardText() {
  try {
    const t = await navigator.clipboard.readText()
    if (!t?.trim()) { notice.value = '剪贴板没有文本内容'; return }
    text.value = t
    notice.value = `已读取剪贴板 ${t.length} 字符，请点击「解析并预览」`
  } catch (e) { notice.value = `剪贴板读取失败：${String(e)}` }
}

async function handleFiles(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files ?? [])
  if (!files.length) return
  busy.value = true; notice.value = ''
  const reports: ImportReport[] = []
  try {
    for (const f of files) {
      if (isSupportedImage(f)) {
        const hits = await decodeQRImage(f, 'file')
        if (!hits.length) {
          reports.push(await parseConfig(`图片「${f.name}」中未检测到二维码`, { source: `file:${f.name}` }))
        } else {
          reports.push(...hits.map(h => importQrPayload(h.text, 'file', { source: `file:${f.name}` })))
        }
      } else {
        reports.push(await parseFile(f.name, await f.text(), { existingFingerprints: [...store.fingerprints] }))
      }
    }
    report.value = mergeReports(reports)
    store.recordReport(report.value, `文件导入（${files.length} 个）`)
    notice.value = `已处理 ${files.length} 个文件：${files.map(f => f.name).join('、')}`
  } catch (err) { notice.value = String(err) }
  finally {
    busy.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function pullSubscription(urlArg?: string) {
  const url = (urlArg ?? subUrl.value).trim()
  if (!url) { notice.value = '请填写订阅地址'; return }
  if (busy.value) return
  if (urlArg) subUrl.value = url
  busy.value = true; notice.value = '正在请求订阅地址…'
  try {
    const r = await fetchSubscription(url)
    if (!r.ok) { notice.value = `订阅拉取失败：${r.error}`; return }
    text.value = r.text ?? ''
    notice.value = `已拉取 ${(r.text ?? '').length} 字符（仅返回文本，未自动执行）。正在解析为预览…`
    report.value = await parseConfig(r.text ?? '', { source: `subscription:${url}`, existingFingerprints: [...store.fingerprints] })
    store.recordReport(report.value, `订阅 ${url}`)
    store.log('info', '[network]', `已按用户确认拉取订阅：${url}`)
  } catch (e) { notice.value = String(e) }
  finally { busy.value = false }
}

function onConfirm(nodes: UnifiedNode[], overwrite: boolean) {
  emit('add', nodes, overwrite)
  notice.value = `已确认导入 ${nodes.length} 个节点（重复项按设置${overwrite ? '覆盖' : '跳过'}）`
  report.value = null
}
</script>

<template>
  <div class="card panel">
    <div class="head">
      <div>
        <h3>配置导入中心</h3>
        <p class="sub">分享链接 / 订阅内容 / Clash YAML / sing-box JSON / Xray JSON / WireGuard conf / v2rayn:// 包装格式</p>
      </div>
      <button class="btn" @click="showCoverage = !showCoverage">{{ showCoverage ? '收起能力清单' : '查看支持能力' }}</button>
    </div>

    <div v-if="showCoverage && cov" class="coverage">
      <div class="cov-line"><b>协议</b><span class="chips"><i v-for="p in cov.protocols" :key="p.key">{{ p.label }}</i></span></div>
      <div class="cov-line"><b>传输 / 安全</b><span class="chips"><i v-for="t in cov.transports" :key="t">{{ t }}</i><i v-for="s in cov.security" :key="s">{{ s }}</i></span></div>
      <div class="cov-line"><b>高级特性</b><span class="chips"><i v-for="a in cov.advanced" :key="a">{{ a }}</i></span></div>
      <div class="cov-line"><b>配置格式</b><span class="chips"><i v-for="f in cov.formats" :key="f">{{ f }}</i></span></div>
      <div class="cov-line"><b>内核</b><span class="chips"><i v-for="k in cov.kernels" :key="k.key">{{ k.label }}</i></span></div>
    </div>

    <label class="field-label">粘贴配置内容（支持多行批量）</label>
    <textarea v-model="text" class="code-area mono" placeholder="vmess://...&#10;vless://...?security=reality&pbk=...&#10;trojan://...&#10;或粘贴完整 Clash YAML / sing-box / Xray JSON / WireGuard conf"></textarea>

    <div class="toolbar">
      <button class="btn primary" :disabled="busy" @click="runParse()">{{ busy ? '处理中…' : '解析并预览' }}</button>
      <button class="btn" :disabled="busy" @click="readClipboardText">读取剪贴板</button>
      <label class="btn file-btn">
        选择配置文件 / 二维码图片
        <input ref="fileInput" type="file" multiple hidden accept=".txt,.yaml,.yml,.json,.conf,.sub,image/png,image/jpeg,image/webp,image/bmp" @change="handleFiles" />
      </label>
      <button class="btn" @click="text = ''; report = null; notice = ''">清空</button>
    </div>

    <div class="sub-row">
      <input v-model="subUrl" placeholder="订阅地址 https://…（需你点击后才会联网拉取）" />
      <button class="btn" :disabled="busy" @click="pullSubscription()">拉取并预览</button>
    </div>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <p class="safe-hint">导入安全：解析结果只生成预览，不会自动写入节点、发起请求、启动内核或修改系统代理。任何未兼容字段都会明确列出，不会静默丢失。</p>

    <ImportReportView
      :report="report" title="配置导入预览"
      fetchable :fetching="busy"
      @confirm="onConfirm" @fetch="pullSubscription" @clear="report = null"
    />
  </div>
</template>

<style scoped>
.panel h3 { font-size: 15px; margin-bottom: 4px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sub { font-size: 12px; color: var(--text-muted); margin: 0; }
.coverage { background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px 12px; margin: 12px 0; }
.cov-line { display: flex; gap: 10px; align-items: flex-start; font-size: 12px; padding: 4px 0; }
.cov-line b { flex: none; width: 76px; color: var(--text-secondary); font-weight: 500; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chips i { font-style: normal; font-size: 11px; color: var(--accent); background: var(--accent-dim); border-radius: var(--radius-full); padding: 1px 8px; }
.field-label { display: block; font-size: 12px; color: var(--text-secondary); margin: 12px 0 6px; }
.code-area { width: 100%; min-height: 130px; box-sizing: border-box; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.file-btn { cursor: pointer; }
.sub-row { display: flex; gap: 8px; margin-top: 14px; }
.sub-row input { flex: 1; }
.notice { font-size: 12px; color: var(--warning); margin: 10px 0 0; word-break: break-all; }
.safe-hint { font-size: 11px; color: var(--text-muted); line-height: 1.7; margin: 10px 0 0; }
</style>
