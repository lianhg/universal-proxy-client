<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ImportReport, UnifiedNode } from '../../core/hub/model.js'
import { PROTOCOL_LABELS } from '../../core/hub/model.js'
import { KERNEL_LABELS } from '../../core/hub/kernel.js'

const props = defineProps<{
  report: ImportReport | null
  title?: string
  /** 订阅地址等需要用户先拉取的场景，改按钮文案 */
  confirmLabel?: string
  /** 允许对 requiresFetch 的订阅/配置地址发起联网拉取（父组件必须监听 fetch 事件） */
  fetchable?: boolean
  /** 拉取进行中：按钮显示进度并暂时不可重复点击 */
  fetching?: boolean
}>()
const emit = defineEmits<{
  confirm: [nodes: UnifiedNode[], overwrite: boolean]
  fetch: [url: string]
  clear: []
}>()

const expanded = ref<string | null>(null)
const showAllIssues = ref(false)
const overwrite = ref(false)

const visibleIssues = computed(() => {
  const list = props.report?.issues ?? []
  return showAllIssues.value ? list : list.slice(0, 8)
})
const nodeIssues = (n: UnifiedNode, level: 'error' | 'warning' | 'info') => n.issues.filter(i => i.level === level).length
const protoLabel = (p: string) => PROTOCOL_LABELS[p as keyof typeof PROTOCOL_LABELS] ?? p.toUpperCase()
const kernelLabel = (k: string | null) => k ? KERNEL_LABELS[k as keyof typeof KERNEL_LABELS] : '无可用内核'
const canConfirm = computed(() => !!props.report && props.report.nodes.length > 0 && !props.report.requiresFetch)
/**
 * 识别结果只是一个订阅 / 配置地址时，本地没有节点可导，按钮原来恒为禁用（识别成功却点不动）。
 * 这里给它一个明确动作：联网把地址里的文本取回来，拉完重新出预览，仍然要再确认一次才写入节点列表。
 */
const fetchUrl = computed(() => props.report?.requiresFetch?.url ?? '')
const needFetch = computed(() => props.fetchable === true && !!props.report?.requiresFetch && props.report.nodes.length === 0)
const fetchKindLabel = computed(() => props.report?.requiresFetch?.kind === 'config-url' ? '配置地址' : '订阅地址')
const primaryEnabled = computed(() => needFetch.value ? props.fetching !== true : canConfirm.value)
function onPrimary() {
  if (!props.report) return
  if (needFetch.value) { emit('fetch', fetchUrl.value); return }
  if (!canConfirm.value) return
  emit('confirm', props.report.nodes, overwrite.value)
}
</script>

<template>
  <div v-if="report" class="report card">
    <div class="report-head">
      <div>
        <div class="report-title">{{ title ?? '导入预览' }}</div>
        <div class="report-format">内容判定：<b>{{ report.formatLabel }}</b> · <span class="mono">{{ report.format }}</span></div>
      </div>
      <span class="preview-badge">仅预览 · 未执行</span>
    </div>

    <div class="stat-row">
      <div class="stat"><b class="ok">{{ report.stats.parsed }}</b><span>识别节点</span></div>
      <div class="stat"><b class="bad">{{ report.stats.failed }}</b><span>无法识别</span></div>
      <div class="stat"><b class="warn">{{ report.stats.duplicates }}</b><span>重复</span></div>
      <div class="stat"><b class="warn">{{ report.stats.warnings }}</b><span>警告</span></div>
    </div>

    <div v-if="report.requiresFetch" class="notice warn">
      <b>需要你确认后才会联网拉取</b>
      <div class="mono dim">{{ report.requiresFetch.url }}</div>
      <div class="tiny">
        解析中心不会自动请求该地址，也不会自动执行返回内容。
        <template v-if="needFetch">点下方「联网拉取{{ fetchKindLabel }}」后只取回文本并解析成预览，仍要再确认一次才写入节点列表。</template>
      </div>
    </div>

    <div v-if="report.issues.length" class="issues">
      <div class="sec-title">解析提示（{{ report.issues.length }}）</div>
      <div v-for="(i, idx) in visibleIssues" :key="idx" class="issue" :class="i.level">
        <span class="lv">{{ i.level === 'error' ? '错误' : i.level === 'warning' ? '警告' : '说明' }}</span>
        <span>{{ i.message }}</span>
      </div>
      <button v-if="report.issues.length > 8" class="link-btn" @click="showAllIssues = !showAllIssues">
        {{ showAllIssues ? '收起' : `展开全部 ${report.issues.length} 条` }}
      </button>
    </div>

    <div v-if="report.nodes.length" class="nodes">
      <div class="sec-title">节点清单（{{ report.nodes.length }}）</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>名称</th><th>协议</th><th>服务器</th><th>传输 / 安全</th><th>推荐内核</th><th>完整性</th></tr></thead>
          <tbody>
            <template v-for="n in report.nodes" :key="n.id">
              <tr class="node-row" @click="expanded = expanded === n.id ? null : n.id">
                <td>
                  <b>{{ n.name }}</b>
                  <span v-if="nodeIssues(n,'error')" class="badge bad">缺 {{ nodeIssues(n,'error') }} 项</span>
                </td>
                <td><span class="proto">{{ protoLabel(n.protocol) }}</span></td>
                <td class="mono tiny">{{ n.server }}:{{ n.port }}</td>
                <td class="tiny">{{ n.transport }} / {{ n.security }}<span v-if="n.flow" class="dim"> · {{ n.flow }}</span></td>
                <td class="tiny">{{ kernelLabel(n.kernel) }}</td>
                <td>
                  <span :class="['badge', n.lossless ? 'good' : 'warn']">{{ n.lossless ? '完整' : `${Object.keys(n.extras).length} 项待确认` }}</span>
                </td>
              </tr>
              <tr v-if="expanded === n.id" class="detail-row"><td colspan="6">
                <div class="detail">
                  <div class="detail-line"><b>选核依据：</b>{{ n.kernelReason }}</div>
                  <div class="detail-line"><b>可用内核：</b>{{ n.kernels.length ? n.kernels.join(' / ') : '无' }}</div>
                  <div v-if="Object.keys(n.extras).length" class="detail-line warn-text">
                    <b>未映射字段（原值完整保留）：</b>
                    <span class="mono">{{ JSON.stringify(n.extras) }}</span>
                  </div>
                  <div v-for="(i, k) in n.issues.filter(x => x.level !== 'info')" :key="k" class="detail-line" :class="i.level">
                    · {{ i.message }}
                  </div>
                  <details>
                    <summary>查看原始配置 / 解码明文</summary>
                    <pre class="mono">{{ n.rawDecoded ?? n.raw }}</pre>
                  </details>
                </div>
              </td></tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="report.rejected.length" class="rejected">
      <div class="sec-title">无法识别的内容（{{ report.rejected.length }}）—— 不会伪装成成功</div>
      <div v-for="(r, idx) in report.rejected.slice(0, 10)" :key="idx" class="reject-row">
        <span class="badge bad">失败</span>
        <span>{{ r.reason }}</span>
        <code class="mono dim">{{ r.raw.slice(0, 60) }}{{ r.raw.length > 60 ? '…' : '' }}</code>
      </div>
    </div>

    <div class="report-foot">
      <label class="chk"><input type="checkbox" v-model="overwrite" /> 覆盖已有相同节点</label>
      <div class="spacer"></div>
      <button class="btn" @click="emit('clear')">清空预览</button>
      <button class="btn primary" :disabled="!primaryEnabled" :title="needFetch ? '把地址里的文本取回来解析成预览，仍会再确认一次' : ''" @click="onPrimary">
        <template v-if="needFetch">{{ fetching ? '正在拉取…' : `联网拉取${fetchKindLabel}` }}</template>
        <template v-else>{{ confirmLabel ?? '确认导入' }}<span v-if="report.nodes.length">（{{ report.nodes.length }}）</span></template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.report { margin-top: 14px; }
.report-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.report-title { font-size: 15px; font-weight: 600; color: var(--text); }
.report-format { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.preview-badge { flex: none; font-size: 11px; color: var(--success); background: var(--success-dim); border: 1px solid rgba(34,197,94,.3); border-radius: var(--radius-full); padding: 3px 10px; }
.stat-row { display: flex; gap: 10px; margin: 12px 0; flex-wrap: wrap; }
.stat { flex: 1; min-width: 92px; background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 10px; display: flex; flex-direction: column; }
.stat b { font-size: 19px; line-height: 1.2; }
.stat span { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.ok { color: var(--success); } .bad { color: var(--danger); } .warn { color: var(--warning); }
.sec-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 12px 0 6px; }
.notice { border-radius: var(--radius-md); padding: 10px 12px; font-size: 12px; margin-bottom: 8px; }
.notice.warn { background: rgba(245,158,11,.09); border: 1px solid rgba(245,158,11,.3); color: var(--warning); }
.notice .mono { margin: 6px 0; word-break: break-all; }
.tiny { font-size: 11px; } .dim { color: var(--text-muted); }
.issue { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; padding: 5px 8px; border-radius: var(--radius-sm); margin-bottom: 4px; background: var(--bg-inset); color: var(--text-secondary); }
.issue.error { color: var(--error-text); background: var(--danger-dim); }
.issue.warning { color: var(--warn-text); background: rgba(245,158,11,.08); }
.lv { flex: none; font-size: 10px; border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; margin-top: 2px; opacity: .85; }
.link-btn { background: none; border: none; color: var(--accent); font-size: 12px; cursor: pointer; padding: 4px 0; }
.tbl-wrap { overflow: auto; max-height: 300px; border: 1px solid var(--border); border-radius: var(--radius-md); }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; }
.tbl th { position: sticky; top: 0; background: var(--bg-elevated); text-align: left; color: var(--text-muted); font-weight: 500; padding: 7px 9px; border-bottom: 1px solid var(--border); }
.tbl td { padding: 7px 9px; border-bottom: 1px solid var(--divider); color: var(--text-secondary); }
.node-row { cursor: pointer; } .node-row:hover td { background: var(--surface-hover); }
.badge { font-size: 10px; padding: 1px 6px; border-radius: var(--radius-full); margin-left: 6px; white-space: nowrap; }
.badge.good { color: var(--success); background: var(--success-dim); }
.badge.warn { color: var(--warning); background: rgba(245,158,11,.12); }
.badge.bad { color: var(--danger); background: var(--danger-dim); }
.proto { color: var(--accent); }
.detail-row td { background: var(--bg-inset); padding: 0; }
.detail { padding: 10px 14px; white-space: normal; font-size: 12px; line-height: 1.7; }
.detail-line { color: var(--text-secondary); } .detail-line.error { color: var(--error-text); } .detail-line.warning { color: var(--warn-text); }
.warn-text { color: var(--warning); word-break: break-all; }
.detail pre { max-height: 180px; overflow: auto; background: var(--code-bg); padding: 8px; border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 11px; white-space: pre-wrap; word-break: break-all; }
details summary { cursor: pointer; color: var(--accent); margin-top: 6px; }
.reject-row { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-secondary); padding: 6px 8px; background: var(--bg-inset); border-radius: var(--radius-sm); margin-bottom: 4px; }
.reject-row code { margin-left: auto; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.report-foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--divider); }
.chk { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; cursor: pointer; }
.spacer { flex: 1; }
</style>
