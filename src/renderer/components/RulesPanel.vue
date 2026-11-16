<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../store.js'
import {
  buildRoutingForKernel, cloneRoutingConfig, createRule, parseRuleText, routingCoverage,
  serializeRuleText, validateRouting, validateRule, RULE_KINDS, RULE_ACTIONS,
  type RoutingConfig, type RoutingRule,
} from '../../core/runtime/rules.js'
import type { KernelType } from '../../core/hub/model.js'

const store = useAppStore()
/** 界面上的可编辑副本，点「保存」才写入 store 并持久化 */
const cfg = ref<RoutingConfig>(cloneRoutingConfig(store.routingConfig))
const previewKernel = ref<KernelType>(store.kernel)
const importText = ref('')
const importNote = ref('')
const saved = ref(false)

const coverage = computed(() => routingCoverage())
const invalid = computed(() => validateRouting(cfg.value))
const built = computed(() => buildRoutingForKernel(cfg.value, previewKernel.value, store.nodes[0]?.name ?? 'PROXY'))
const dirty = computed(() => JSON.stringify(cfg.value) !== JSON.stringify(store.routingConfig))

function errs(r: RoutingRule) { return validateRule(r) }

function addRule() { cfg.value.rules.push(createRule()); saved.value = false }
function delRule(i: number) { cfg.value.rules.splice(i, 1); saved.value = false }
function move(i: number, d: number) {
  const j = i + d
  if (j < 0 || j >= cfg.value.rules.length) return
  const arr = cfg.value.rules
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  saved.value = false
}
function doImport() {
  const r = parseRuleText(importText.value)
  cfg.value.rules.push(...r.rules)
  importNote.value = `导入 ${r.rules.length} 条，拒绝 ${r.issues.length} 条`
  for (const i of r.issues) store.log('error', '[rules/import]', i.message)
  if (r.rules.length) { saved.value = false; importText.value = '' }
}
function doExport() {
  const text = serializeRuleText(cfg.value.rules)
  importText.value = text
  importNote.value = `已导出 ${cfg.value.rules.length} 条规则到下方文本框，可复制保存`
}
function save() {
  if (invalid.value.length) { importNote.value = '存在不合法的规则，请先修正再保存'; return }
  store.saveRouting(cfg.value)
  saved.value = true
  importNote.value = '规则已保存，下次启动内核时生效；正在运行的内核需断开重连才会应用新规则'
}
function reset() { cfg.value = cloneRoutingConfig(); saved.value = false; importNote.value = '已恢复默认规则（尚未保存）' }
function setDns(v: string) { cfg.value.dnsServers = v.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean); saved.value = false }
</script>

<template>
  <div class="card panel">
    <div class="head">
      <div>
        <h3>规则管理 · 智能分流</h3>
        <p class="sub">按顺序匹配，先命中先生效。任何内核无法表达的规则都会明确拒绝下发，并阻止带着残缺分流策略启动</p>
      </div>
      <span class="cnt" :class="{ bad: invalid.length }">{{ invalid.length ? invalid.length + ' 项校验错误' : dirty ? '有未保存修改' : '已保存' }}</span>
    </div>

    <div class="toolbar">
      <button class="btn primary" @click="save">保存规则</button>
      <button class="btn" @click="addRule">＋ 添加规则</button>
      <button class="btn" @click="doExport">导出文本</button>
      <button class="btn" @click="reset">恢复默认</button>
      <span class="tiny dim">共 {{ cfg.rules.length }} 条 · 启用 {{ cfg.rules.filter(r => r.enabled).length }} 条</span>
    </div>

    <div class="grid2">
      <div class="left">
        <table class="rules">
          <thead><tr><th></th><th>类型</th><th>规则内容</th><th>动作</th><th>备注</th><th>顺序</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in cfg.rules" :key="r.id" :class="{ off: !r.enabled, bad: errs(r).length }">
              <td><input type="checkbox" v-model="r.enabled" @change="saved = false" title="启用 / 禁用" /></td>
              <td><select v-model="r.kind" @change="saved = false">
                <option v-for="k in RULE_KINDS" :key="k" :value="k">{{ k }}</option>
              </select></td>
              <td><input v-model="r.payload" :disabled="r.kind === 'MATCH'" :placeholder="r.kind === 'MATCH' ? '无需内容' : '例如 google.com'" @input="saved = false" /></td>
              <td><select v-model="r.action" @change="saved = false">
                <option v-for="a in RULE_ACTIONS" :key="a" :value="a">{{ a }}</option>
              </select></td>
              <td><input v-model="r.comment" placeholder="可选" @input="saved = false" /></td>
              <td class="ops">
                <button title="上移" @click="move(i, -1)">↑</button>
                <button title="下移" @click="move(i, 1)">↓</button>
                <button title="删除" class="danger" @click="delRule(i)">×</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-for="(e, i) in invalid" :key="i" class="err-line">{{ e.message }}</div>

        <div class="sec-title" style="margin-top:14px">全局分流 / DNS</div>
        <div class="form-row">
          <label>默认动作</label>
          <select v-model="cfg.defaultAction" @change="saved = false">
            <option v-for="a in RULE_ACTIONS" :key="a" :value="a">{{ a }}</option>
          </select>
          <label class="chk"><input type="checkbox" v-model="cfg.bypassLan" @change="saved = false" /> 局域网地址直连</label>
          <label class="chk"><input type="checkbox" v-model="cfg.dnsEnabled" @change="saved = false" /> 启用 DNS 分流</label>
        </div>
        <div class="form-row">
          <label>DNS 服务器</label>
          <input :value="cfg.dnsServers.join(', ')" @change="setDns(($event.target as HTMLInputElement).value)" placeholder="223.5.5.5, 119.29.29.29" style="flex:1" />
        </div>
        <div class="tiny dim">DNS 分流与 DNS 服务器会写入内核运行配置；伪造 DNS 应答、域名嗅探等高级策略当前未开放。</div>

        <div class="sec-title" style="margin-top:14px">批量导入 Clash 规则文本</div>
        <textarea v-model="importText" rows="4" placeholder="DOMAIN-SUFFIX,google.com,PROXY&#10;GEOSITE,cn,DIRECT&#10;MATCH,PROXY"></textarea>
        <div class="toolbar" style="margin:6px 0">
          <button class="btn" @click="doImport">解析并追加</button>
          <span class="tiny dim">无法识别的类型 / 动作会逐行报出并拒绝，不会静默丢弃</span>
        </div>
        <p v-if="importNote" class="note">{{ importNote }}</p>
      </div>

      <div class="right">
        <div class="sec-title">下发预检</div>
        <div class="kernels">
          <button v-for="k in (['xray','sing-box','mihomo'] as KernelType[])" :key="k"
                  :class="['chip', { on: previewKernel === k }]" @click="previewKernel = k">{{ k }}</button>
        </div>
        <div class="stat" :class="{ bad: built.skipped.length }">
          <div><b>{{ built.applied }}</b><span>可下发</span></div>
          <div><b class="red">{{ built.skipped.length }}</b><span>无法下发</span></div>
        </div>
        <div v-if="built.skipped.length" class="warn-box">
          <b>以下规则不会被写入配置，启动会被阻断：</b>
          <div v-for="r in built.skipped" :key="r.id" class="mono tiny">{{ r.kind }},{{ r.payload }},{{ r.action }}</div>
          <div class="tiny dim">请禁用这些规则、改用支持的写法，或切换到支持它们的内核。</div>
        </div>
        <div v-for="(e, i) in built.issues.filter(x => x.level === 'error')" :key="i" class="err-line">{{ e.message }}</div>
        <div v-if="!built.skipped.length && !built.issues.some(x => x.level === 'error')" class="ok-box">
          当前 {{ previewKernel }} 可完整下发全部启用规则。
        </div>

        <div class="sec-title" style="margin-top:14px">内核规则能力矩阵</div>
        <div v-for="c in coverage" :key="c.kernel" class="cov">
          <b>{{ c.kernel }}</b>
          <div class="tiny dim">支持 {{ c.supported.length }} / {{ RULE_KINDS.length }} 类</div>
          <div v-for="u in c.unsupported" :key="u.kind" class="tiny dim">· {{ u.kind }}：{{ u.reason }}</div>
        </div>

        <div class="sec-title" style="margin-top:14px">将写入的规则（{{ previewKernel }}）</div>
        <pre class="preview">{{ JSON.stringify(built.items, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel h3 { font-size:15px; margin-bottom:4px; }
.head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
.sub { font-size:12px; color:var(--text-muted); margin:0; }
.cnt { font-size:12px; color:var(--success); white-space:nowrap; } .cnt.bad { color:var(--danger); }
.toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:12px 0 10px; }
.grid2 { display:flex; gap:12px; align-items:flex-start; }
.left { flex:1; min-width:0; } .right { width:320px; flex:none; }
.rules { width:100%; border-collapse:collapse; font-size:11.5px; }
.rules th { text-align:left; color:var(--text-muted); font-weight:500; padding:5px 4px; border-bottom:1px solid var(--border); }
.rules td { padding:4px; border-bottom:1px solid var(--divider); }
.rules tr.off { opacity:.5; } .rules tr.bad { background:var(--danger-dim); }
.rules input[type=text], .rules input:not([type]), .rules select { width:100%; min-width:0; }
.rules td:nth-child(3) input { min-width:120px; }
.ops { white-space:nowrap; }
.ops button { border:1px solid var(--border); background:var(--bg-inset); color:var(--text-secondary); border-radius:4px; width:20px; height:22px; cursor:pointer; margin-right:2px; }
.ops button.danger { color:var(--danger); }
.err-line { font-size:11px; color:var(--danger); margin-top:5px; line-height:1.6; }
.form-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:7px 0; font-size:12px; color:var(--text-secondary); }
.form-row label { flex:none; }
.chk { display:flex; align-items:center; gap:4px; font-size:11.5px; white-space:nowrap; }
.form-row select { width:auto; min-width:100px; }
textarea { width:100%; font-family:var(--mono, monospace); font-size:11px; }
.note { font-size:11px; color:var(--warning); line-height:1.6; }
.sec-title { font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:7px; }
.kernels { display:flex; gap:5px; margin-bottom:9px; }
.chip { font-size:10px; padding:3px 8px; border-radius:10px; border:1px solid var(--border); background:var(--bg-inset); color:var(--text-muted); cursor:pointer; }
.chip.on { color:var(--accent); border-color:var(--accent); }
.stat { display:flex; gap:8px; margin-bottom:9px; }
.stat div { flex:1; background:var(--bg-inset); border:1px solid var(--border); border-radius:var(--radius-md); padding:8px; display:flex; flex-direction:column; }
.stat b { font-size:18px; color:var(--success); } .stat span { font-size:10px; color:var(--text-muted); }
.stat b.red { color:var(--danger); }
.warn-box, .ok-box { border-radius:var(--radius-md); padding:9px 10px; font-size:11px; line-height:1.7; margin-bottom:9px; }
.warn-box { background:var(--danger-dim); color:var(--danger); border:1px solid var(--danger); }
.ok-box { background:var(--bg-inset); color:var(--success); border:1px solid var(--border); }
.cov { border-bottom:1px solid var(--divider); padding:6px 0; font-size:11.5px; color:var(--text-secondary); }
.cov .tiny { line-height:1.55; margin-top:2px; }
.preview { max-height:190px; overflow:auto; background:var(--bg-inset); border:1px solid var(--border); border-radius:var(--radius-md); padding:8px; font-size:10px; color:var(--text-secondary); line-height:1.5; white-space:pre-wrap; word-break:break-all; }
.tiny { font-size:10px; } .dim { color:var(--text-muted); }
</style>
