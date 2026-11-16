<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../store.js'
import { runtimeOpenDir } from '../api.js'
import { KERNEL_LABELS } from '../../core/hub/kernel.js'
import type { KernelType } from '../../core/hub/model.js'

const store = useAppStore()
const notice = ref('')
const refreshing = ref(false)

/** 版本信息全部来自主进程 app.getVersion() / process.versions，界面不做任何硬编码 */
const info = computed(() => store.appInfo)
const versionText = computed(() => (info.value.version && info.value.version !== '—' ? `v${info.value.version}` : '未知'))

const buildTimeText = computed(() => {
  const t = info.value.buildTime
  if (!t) return '—'
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})

const modeText = computed(() => (info.value.packaged ? '安装版（已打包）' : '开发 / 预览模式'))

const platformText = computed(() => {
  const map: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', browser: '浏览器预览' }
  const os = map[info.value.platform] ?? info.value.platform
  return `${os} · ${info.value.arch || '—'}`
})

/** 已装内核版本：直接读当前二进制扫描结果 */
const kernels = computed(() => store.binaries.items)

const kernelLines = computed(() => kernels.value
  .filter(k => k.kernel && k.kernel !== 'none')
  .map(k => `${KERNEL_LABELS[k.kernel as KernelType] ?? k.kernel} ${k.found ? `v${k.version}` : '未安装'}`))

/** 一键复制的诊断信息：版本 + 环境 + 内核，排障时贴给开发者即可 */
function diagnosticText(): string {
  return [
    `${info.value.name} ${versionText.value}`,
    `构建时间：${buildTimeText.value}`,
    `运行模式：${modeText.value}`,
    `Electron ${info.value.electron} / Chromium ${info.value.chrome} / Node ${info.value.node} / V8 ${info.value.v8}`,
    `系统：${platformText.value}（${info.value.osRelease}）`,
    `内核：${kernelLines.value.join('、') || '无'}`,
    `数据目录：${info.value.userData || '—'}`,
    `程序路径：${info.value.exePath || '—'}`,
  ].join('\n')
}

async function copyInfo() {
  const text = diagnosticText()
  try {
    await navigator.clipboard.writeText(text)
    notice.value = '版本信息已复制到剪贴板'
  } catch {
    notice.value = '复制失败：当前环境不允许写剪贴板，可手动选中表格复制'
  }
  setTimeout(() => { notice.value = '' }, 2600)
}

async function refresh() {
  refreshing.value = true
  try {
    await store.loadAppInfo()
    await store.refreshRuntime()
    notice.value = '已刷新'
  } catch {
    notice.value = '刷新失败'
  } finally {
    refreshing.value = false
    setTimeout(() => { notice.value = '' }, 2000)
  }
}

async function openDataDir() {
  const r = await runtimeOpenDir('runtime')
  if (!r) notice.value = '打开目录失败（需桌面端）'
}

onMounted(() => {
  void store.loadAppInfo()
  /* 内核版本要现场扫描才有值，进面板就先刷一次，避免显示「尚未扫描」 */
  void store.refreshRuntime()
})
</script>

<template>
  <section class="panel card">
    <div class="head">
      <div>
        <h3>关于 / 版本信息</h3>
        <p class="sub">版本号取自程序本身，界面不硬编码；升级后自动更新</p>
      </div>
      <div class="head-actions">
        <button class="btn" :disabled="refreshing" @click="refresh">{{ refreshing ? '刷新中…' : '刷新' }}</button>
        <button class="btn primary" @click="copyInfo">复制诊断信息</button>
      </div>
    </div>

    <div class="ver-hero">
      <div class="logo">&#x1F680;</div>
      <div>
        <div class="ver-name">{{ info.name }}</div>
        <div class="ver-num mono">{{ versionText }}</div>
      </div>
      <div class="ver-badges">
        <span class="chip" :class="info.packaged ? 'ok' : 'warn'">{{ modeText }}</span>
        <span class="chip">构建 {{ buildTimeText }}</span>
      </div>
    </div>

    <div class="grid">
      <div class="box">
        <div class="sec-title">运行环境</div>
        <div class="row"><span>Electron</span><b class="mono">{{ info.electron }}</b></div>
        <div class="row"><span>Chromium</span><b class="mono">{{ info.chrome }}</b></div>
        <div class="row"><span>Node.js</span><b class="mono">{{ info.node }}</b></div>
        <div class="row"><span>V8</span><b class="mono">{{ info.v8 }}</b></div>
      </div>

      <div class="box">
        <div class="sec-title">系统</div>
        <div class="row"><span>平台 / 架构</span><b class="mono">{{ platformText }}</b></div>
        <div class="row"><span>系统内核</span><b class="mono ellipsis" :title="info.osRelease">{{ info.osRelease || '—' }}</b></div>
        <div class="row"><span>数据目录</span>
          <b class="mono ellipsis" :title="info.userData">{{ info.userData || '—' }}</b>
        </div>
        <div class="row"><span>程序路径</span>
          <b class="mono ellipsis" :title="info.exePath">{{ info.exePath || '—' }}</b>
        </div>
      </div>

      <div class="box">
        <div class="sec-title">内核二进制版本</div>
        <div v-for="k in kernels.filter(x => x.kernel && x.kernel !== 'none')" :key="k.kernel" class="row">
          <span>{{ KERNEL_LABELS[k.kernel as KernelType] ?? k.kernel }}</span>
          <b class="mono" :class="k.found ? '' : 'dim'">{{ k.found ? `v${k.version}` : '未安装' }}</b>
        </div>
        <div v-if="!kernels.length" class="row"><span>尚未扫描</span><b class="dim">点「刷新」</b></div>
      </div>

      <div class="box tips">
        <div class="sec-title">说明</div>
        <p>本程序仅做协议解析与内核调度，不内置任何节点、不提供订阅服务。</p>
        <p>内核二进制由你自己下载，版本号即内核自报版本；未安装时无法启动连接。</p>
        <p>遇到问题请先「复制诊断信息」，里面包含版本与环境，不包含任何节点、密码或订阅地址。</p>
        <button class="btn small" @click="openDataDir">打开数据目录</button>
      </div>
    </div>

    <div v-if="notice" class="notice">{{ notice }}</div>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
h3 { font-size: 15px; margin: 0 0 4px; color: var(--text); }
.sub { font-size: 12px; color: var(--text-muted); margin: 0; }
.head-actions { display: flex; gap: 8px; }

.ver-hero { display: flex; align-items: center; gap: 14px; padding: 14px 16px; background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-md); }
.logo { font-size: 34px; line-height: 1; filter: drop-shadow(0 0 10px rgba(59,130,246,.55)); }
.ver-name { font-size: 13px; color: var(--text-secondary); }
.ver-num { font-size: 24px; font-weight: 700; color: var(--text); letter-spacing: .5px; }
.ver-badges { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.chip { font-size: 11px; padding: 2px 9px; border-radius: var(--radius-full); border: 1px solid var(--border); color: var(--text-muted); white-space: nowrap; }
.chip.ok { color: var(--success); border-color: var(--success-dim); background: var(--success-dim); }
.chip.warn { color: var(--warn-text); border-color: rgba(245,158,11,.3); background: rgba(245,158,11,.1); }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.box { background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px 12px; min-width: 0; }
.sec-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 7px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--text-muted); padding: 3px 0; min-width: 0; }
.row b { color: var(--text-secondary); font-weight: 500; }
.row b.dim { color: var(--text-muted); font-weight: 400; }
.ellipsis { max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
.tips p { font-size: 11px; color: var(--text-muted); margin: 0 0 6px; line-height: 1.6; }
.btn.small { padding: 4px 10px; font-size: 11px; }
.notice { font-size: 12px; color: var(--accent); }
.mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
</style>
