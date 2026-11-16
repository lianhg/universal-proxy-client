<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../store.js'

const store = useAppStore()
import { generateConfig } from '../api.js'
import { capabilityTable, KERNEL_LABELS } from '../../core/hub/kernel.js'
import type { KernelType } from '../../core/hub/model.js'

const kernel = ref<KernelType>(store.kernel)
const table = capabilityTable()
const generated = ref<any>(null)
const busy = ref(false)
const showMatrix = ref(true)

const grouped = computed(() => {
  const g: Record<string, number> = { xray: 0, 'sing-box': 0, mihomo: 0, none: 0 }
  for (const n of store.nodes) {
    if (n.kernel) g[n.kernel] = (g[n.kernel] ?? 0) + 1
    else g.none++
  }
  return g
})

const levelLabel: Record<string, string> = { native: '原生', versioned: '需版本', partial: '部分', unsupported: '不支持' }

async function build() {
  busy.value = true
  store.kernel = kernel.value
  try {
    generated.value = await generateConfig(store.nodes, kernel.value)
    store.log('info', `[kernel/${kernel.value}]`,
      `已生成 ${KERNEL_LABELS[kernel.value]} 配置预览，包含 ${generated.value.config.outbounds?.length ?? generated.value.config.proxies?.length ?? 0} 个出站项；未启动内核、未写文件`,
      generated.value.issues.map((i: any) => i.message).join(' | '))
  } catch (e) { store.log('error', '[kernel]', String(e)) }
  finally { busy.value = false }
}

const configText = computed(() => generated.value ? JSON.stringify(generated.value.config, null, 2) : '')
</script>

<template>
  <div class="card panel">
    <div class="head">
      <div>
        <h3>多内核架构 · 高级设置</h3>
        <p class="sub">Xray + sing-box + Mihomo 统一配置模型；按协议 / 传输层 / 安全层自动选核，不兼容时明确说明原因</p>
      </div>
      <button class="btn" @click="showMatrix = !showMatrix">{{ showMatrix ? '收起能力矩阵' : '查看能力矩阵' }}</button>
    </div>

    <div class="kernel-cards">
      <button v-for="k in (['xray','sing-box','mihomo'] as KernelType[])" :key="k"
              :class="['kcard', { active: kernel === k }]" @click="kernel = k">
        <div class="kname">{{ KERNEL_LABELS[k] }}</div>
        <div class="kcount">{{ grouped[k] ?? 0 }} 个节点可用</div>
        <div class="kbar"><span :style="{ width: (store.nodes.length ? ((grouped[k] ?? 0) / store.nodes.length * 100) : 0) + '%' }"></span></div>
      </button>
      <div v-if="grouped.none" class="kcard none">
        <div class="kname">无可用内核</div>
        <div class="kcount bad-text">{{ grouped.none }} 个节点需额外兼容</div>
      </div>
    </div>

    <div class="toolbar">
      <button class="btn primary" :disabled="busy || !store.nodes.length" @click="build">
        {{ busy ? '生成中…' : `生成 ${KERNEL_LABELS[kernel]} 配置预览` }}
      </button>
      <span class="tiny dim">只生成配置对象：不启动内核、不写文件、不改系统代理 / TUN。真正启停请用下方「内核运行层」面板</span>
    </div>

    <div v-if="generated" class="gen-result">
      <div class="sec-title">配置生成结果</div>
      <div v-for="(i, k) in generated.issues" :key="k" class="issue" :class="i.level">
        <span class="lv">{{ i.code }}</span><span>{{ i.message }}</span>
      </div>
      <div v-if="generated.unmapped?.length" class="unmapped">
        <b>生成配置中无法表达的字段（原值仍保留在节点 raw / extras，未丢弃）：</b>
        <div class="mono">{{ generated.unmapped.join('、') }}</div>
      </div>
      <details open><summary>配置预览（JSON）</summary><pre class="mono">{{ configText }}</pre></details>
    </div>

    <div v-if="showMatrix" class="matrix">
      <div class="sec-title">协议 × 内核能力矩阵</div>
      <div class="matrix-wrap">
        <table class="tbl">
          <thead><tr><th>协议</th><th>Xray</th><th>sing-box</th><th>Mihomo</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="row in table" :key="row.protocol">
              <td class="mono">{{ row.label }}</td>
              <td v-for="k in (['xray','sing-box','mihomo'] as KernelType[])" :key="k">
                <span :class="['lv2', row[k].level]">{{ levelLabel[row[k].level] }}<small v-if="row[k].since"> ≥{{ row[k].since }}</small></span>
              </td>
              <td class="tiny dim">{{ row.mihomo.level === 'native' ? row.xray.note : row.mihomo.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="roadmap">
      <div class="sec-title">内核运行层状态（全部为真实能力）</div>
      <div class="rm"><span class="badge ok">已实现</span> 协议解析 · 自动选核 · 三内核完整运行配置生成并落盘 · 参数完整性检查</div>
      <div class="rm"><span class="badge ok">已实现</span> 内核进程启停 / 健康检查 / 实时日志 · 系统代理可逆切换（快照恢复）· TUN 入站配置 · 真实 TCP 握手测速</div>
      <div class="rm"><span class="badge ok">已实现</span> 实时遥测（速率 / 累计流量 / 活跃连接 / 规则命中）· 规则管理与三内核下发 · DNS 分流 · 订阅定时自动更新 · 站点真实 HTTPS 连通性探测 + 节点诊断</div>
      <div class="rm"><span class="badge todo">待接入</span> 内核崩溃自动重启、clash_api 运行时切换节点、macOS / Linux 系统代理自动设置</div>
      <div class="tiny dim">Xray 的实时速率与累计流量已通过 StatsService gRPC 接入；只有「逐条连接列表 / 按连接关闭」需要改用 sing-box / Mihomo。未连接时所有指标显示 0 并说明原因，不显示任何模拟数据。启动内核需要自备官方二进制，系统设置改动在断开或退出时按快照恢复。</div>
    </div>
  </div>
</template>

<style scoped>
.panel h3 { font-size: 15px; margin-bottom: 4px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sub { font-size: 12px; color: var(--text-muted); margin: 0; }
.kernel-cards { display: flex; gap: 10px; margin: 14px 0; flex-wrap: wrap; }
.kcard { flex: 1; min-width: 150px; text-align: left; background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px 12px; cursor: pointer; color: var(--text); font-family: inherit; }
.kcard.active { border-color: var(--accent); background: var(--accent-dim); }
.kcard.none { cursor: default; }
.kname { font-size: 13px; font-weight: 600; } .kcount { font-size: 11px; color: var(--text-muted); margin: 4px 0 6px; }
.bad-text { color: var(--danger); }
.kbar { height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
.kbar span { display: block; height: 100%; background: var(--accent); }
.toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.tiny { font-size: 11px; } .dim { color: var(--text-muted); }
.sec-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 14px 0 7px; }
.issue { display: flex; gap: 8px; font-size: 12px; padding: 5px 8px; background: var(--bg-inset); border-radius: var(--radius-sm); margin-bottom: 4px; color: var(--text-secondary); }
.issue.warning { color: var(--warn-text); } .issue.error { color: var(--error-text); }
.lv { font-size: 10px; border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; height: fit-content; }
.unmapped { font-size: 12px; color: var(--warning); background: rgba(245,158,11,.08); border-radius: var(--radius-sm); padding: 8px 10px; margin: 8px 0; word-break: break-all; }
.gen-result pre, .matrix pre { max-height: 260px; overflow: auto; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; font-size: 11px; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all; }
details summary { cursor: pointer; color: var(--accent); font-size: 12px; margin: 8px 0; }
.matrix-wrap { overflow: auto; max-height: 320px; border: 1px solid var(--border); border-radius: var(--radius-md); }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th { position: sticky; top: 0; background: var(--bg-elevated); text-align: left; color: var(--text-muted); font-weight: 500; padding: 6px 9px; border-bottom: 1px solid var(--border); }
.tbl td { padding: 6px 9px; border-bottom: 1px solid var(--divider); color: var(--text-secondary); }
.lv2 { font-size: 10px; border-radius: var(--radius-full); padding: 1px 7px; white-space: nowrap; }
.lv2.native { color: var(--success); background: var(--success-dim); }
.lv2.versioned { color: var(--accent); background: var(--accent-dim); }
.lv2.partial { color: var(--warning); background: rgba(245,158,11,.12); }
.lv2.unsupported { color: var(--danger); background: var(--danger-dim); }
.roadmap { border-top: 1px solid var(--divider); margin-top: 14px; padding-top: 6px; }
.rm { font-size: 12px; color: var(--text-secondary); padding: 4px 0; }
.badge { font-size: 10px; padding: 1px 7px; border-radius: var(--radius-full); margin-right: 6px; }
.badge.ok { color: var(--success); background: var(--success-dim); }
.badge.todo { color: var(--warning); background: rgba(245,158,11,.12); }
</style>
