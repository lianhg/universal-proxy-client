<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAppStore } from '../store.js'
import { runtimeOpenDir } from '../api.js'
import { KERNEL_LABELS } from '../../core/hub/kernel.js'
import { KERNEL_RELEASES } from '../../core/runtime/downloads.js'
import type { KernelType } from '../../core/hub/model.js'
import type { RuntimeMode, RuntimeSettings } from '../../core/runtime/types.js'

const store = useAppStore()
const selectedKernel = ref<KernelType>(store.kernel)
const settings = ref<RuntimeSettings>(JSON.parse(JSON.stringify(store.runtime.settings)))
const showConfig = ref(false)
const showAllLogs = ref(false)
const notice = ref('')
const saving = ref(false)
/* 一键下载相关状态 */
const dlVersion = ref<Partial<Record<KernelType, string>>>({})
const dlProxy = ref('')
const dlBusy = ref(false)

watch(() => store.runtime.settings, s => { settings.value = JSON.parse(JSON.stringify(s)) }, { deep: true })
watch(selectedKernel, k => { store.kernel = k })

const st = computed(() => store.runtime)
const isRunning = computed(() => st.value.state === 'running')
const isBusy = computed(() => store.runtimeBusy || st.value.state === 'starting' || st.value.state === 'stopping')
const canStart = computed(() => !!store.nodes.length && !st.value.unavailable && !isBusy.value)
const stateLabel: Record<string, string> = {
  stopped: '未启动', starting: '启动中', running: '运行中', stopping: '断开中', error: '出错',
}
const modeItems: { key: RuntimeMode; label: string; desc: string }[] = [
  { key: 'system-proxy', label: '系统代理', desc: '自动设置 Windows 系统代理，断开时按快照恢复' },
  { key: 'tun', label: 'TUN 虚拟网卡', desc: '接管全局流量，需要管理员权限；Xray 不支持' },
  { key: 'none', label: '仅启动内核', desc: '不改任何系统设置，手动指向本地端口' },
]
const visibleLogs = computed(() => {
  const list = store.runtimeLogs
  return showAllLogs.value ? list : list.slice(-14)
})
const errorIssues = computed(() => st.value.issues.filter(i => i.level !== 'info'))

onMounted(() => store.installRuntimeEvents())

function pickNode(id: string) {
  const n = store.nodes.find(x => x.id === id)
  if (n?.kernel) selectedKernel.value = n.kernel
}

async function setMode(key: RuntimeMode) {
  notice.value = ''
  const r = await store.setRuntimeMode(key)
  if (!r.ok) notice.value = r.error ?? '切换失败'
}

async function save() {
  saving.value = true
  notice.value = ''
  try {
    const r = await store.updateRuntimeSettings(settings.value)
    notice.value = r.ok ? '运行设置已保存（下次启动生效）' : (r.error ?? '保存失败')
  } finally { saving.value = false }
}

async function start() {
  notice.value = ''
  const id = st.value.node?.id ?? store.nodes[0]?.id
  const node = store.nodes.find(n => n.id === id) ?? store.nodes[0]
  if (!node) { notice.value = '请先导入并确认至少一个节点'; return }
  store.kernel = selectedKernel.value
  const ok = await store.connect(node, store.peersFor(node, selectedKernel.value))
  if (!ok) notice.value = st.value.lastError ?? '启动失败，请查看下方日志与阻断原因'
}

async function stop() {
  notice.value = ''
  await store.disconnect()
}

async function preview() {
  const node = store.nodes[0]
  if (!node) { notice.value = '请先导入节点'; return }
  const r = await store.previewRuntimeConfig(node, store.peersFor(node, selectedKernel.value))
  showConfig.value = true
  notice.value = r.ok ? `已生成将落盘的 ${r.filename}（未写文件、未启动）` : (r.error ?? '生成失败')
}

async function openDir(kind: 'bin' | 'runtime') {
  const dir = await runtimeOpenDir(kind)
  if (!dir) notice.value = '打开目录需要 Electron 桌面端'
}

/* ───────── 一键下载内核二进制 ───────── */

function versionOf(k: KernelType): string {
  return dlVersion.value[k] || store.latestVersions[k] || KERNEL_RELEASES[k].defaultVersion
}

async function fetchLatest() {
  dlBusy.value = true
  try {
    const v = await store.refreshLatestVersions(dlProxy.value)
    const got = (Object.keys(v) as KernelType[]).map(k => `${KERNEL_LABELS[k]} ${v[k]}`).join(' · ')
    notice.value = got ? `最新版本：${got}` : '未能获取最新版本号（原因见运行日志）'
  } finally { dlBusy.value = false }
}

async function download(k: KernelType) {
  notice.value = ''
  const ver = versionOf(k).replace(/^v/, '')
  if (!/^\d+(\.\d+){1,3}(-[\w.]+)?$/.test(ver)) {
    notice.value = `版本号不合法：${ver}（示例 1.14.4）`
    return
  }
  const r = await store.downloadKernelBinary(k, ver, dlProxy.value)
  if (r.ok) notice.value = `${KERNEL_LABELS[k]} v${r.version} 安装完成${r.checksumVerified ? '（官方校验通过）' : ''}`
  else notice.value = `下载失败：${r.error}`
}

function dlPercent(k: KernelType): number {
  const d = store.downloads[k]
  if (!d || !d.total) return 0
  return Math.min(100, Math.round(d.received / d.total * 100))
}

function levelClass(l: string) {
  return l === 'error' ? 'lg-err' : l === 'warn' ? 'lg-warn' : l === 'debug' ? 'lg-dim' : 'lg-info'
}
</script>

<template>
  <div class="rt-wrap">
    <!-- 状态总览 -->
    <div class="card rt-card">
      <div class="rt-head">
        <div>
          <div class="rt-title">⚙ 内核运行层</div>
          <div class="rt-sub">真实进程 · 可逆系统代理 · 配置落盘 · 内核日志</div>
        </div>
        <span :class="['rt-state', isRunning ? 'on' : st.state === 'error' ? 'bad' : '']">
          {{ stateLabel[st.state] ?? st.state }}{{ st.unavailable ? ' · 浏览器预览' : '' }}
        </span>
      </div>

      <div class="rt-grid">
        <div><span>当前内核</span><b>{{ st.kernel ? KERNEL_LABELS[st.kernel] : '—' }}</b></div>
        <div><span>当前节点</span><b>{{ st.node?.name ?? '—' }}</b></div>
        <div><span>进程 PID</span><b class="mono">{{ st.pid ?? '—' }}</b></div>
        <div><span>监听端口</span><b class="mono">{{ st.listenPort ?? '—' }}</b></div>
        <div><span>运行模式</span><b>{{ modeItems.find(m => m.key === st.mode)?.label ?? st.mode }}</b></div>
        <div><span>系统代理</span><b :class="st.systemProxy.applied ? 'ok' : ''">{{ st.systemProxy.applied ? st.systemProxy.server : st.systemProxy.message }}</b></div>
      </div>

      <div v-if="st.lastError" class="rt-alert bad">启动失败：{{ st.lastError }}</div>
      <div v-if="errorIssues.length" class="rt-alert warn">
        <div v-for="(i, k) in errorIssues.slice(0, 6)" :key="k">[{{ i.code }}] {{ i.message }}</div>
      </div>
      <div v-if="st.issues.length || st.unmapped.length" class="rt-alert info">
        生成运行配置时有 {{ st.unmapped.length }} 类字段内核无法表达，原值仍保存在节点 raw / extras 中，未静默丢弃。
      </div>
      <div v-if="notice" class="rt-alert info">{{ notice }}</div>

      <div class="rt-actions">
        <button class="btn rt-primary" :disabled="!canStart || isRunning" @click="start">
          {{ st.state === 'starting' ? '启动中…' : '▶ 启动内核并连接' }}
        </button>
        <button class="btn rt-danger" :disabled="!isRunning" @click="stop">⏹ 断开并恢复系统设置</button>
        <button class="btn" :disabled="!store.nodes.length" @click="preview">📄 生成运行配置预览</button>
        <button class="btn" @click="store.refreshRuntime()">🔄 刷新状态</button>
      </div>
      <div class="rt-foot">首页「开始连接 / 断开连接」按钮已接同一套运行逻辑；网速 / 流量 / 连接监控为内核 clash_api 实时遥测，Xray 无统计接口时如实标注。</div>
    </div>

    <!-- 运行模式 -->
    <div class="card rt-card">
      <div class="rt-title sm">运行模式</div>
      <div class="rt-modes">
        <button v-for="m in modeItems" :key="m.key"
                :class="['rt-mode', { active: st.mode === m.key }]"
                :disabled="isRunning || isBusy" @click="setMode(m.key)">
          <b>{{ m.label }}</b><span>{{ m.desc }}</span>
        </button>
      </div>
      <div class="rt-hint">切换模式需要先断开连接。系统代理改动前会保存原始快照，断开 / 程序退出时自动恢复。</div>
    </div>

    <!-- 二进制 -->
    <div class="card rt-card">
      <div class="rt-title sm">内核二进制
        <button class="btn mini" @click="openDir('bin')">打开目录</button>
        <button class="btn mini" @click="openDir('runtime')">配置目录</button>
      </div>
      <div class="rt-hint">目录：{{ store.binaries.binDir || '（仅桌面端可见）' }}</div>
      <div class="rt-bin" v-for="b in store.binaries.items" :key="b.kernel">
        <span :class="['rt-dot', b.found ? 'ok' : 'bad']"></span>
        <b>{{ KERNEL_LABELS[b.kernel] }}</b>
        <span class="rt-ver mono">{{ b.found ? `v${b.version}` : '未安装' }}</span>
        <span class="rt-path mono">{{ b.found ? b.path : (b.hint ?? b.reason) }}</span>
      </div>
      <div v-if="!store.binaries.items.length" class="rt-hint">正在探测…</div>

      <!-- 一键下载 -->
      <div class="rt-dl-head">
        <span class="rt-dl-title">一键下载（GitHub 官方发布）</span>
        <button class="btn mini" :disabled="dlBusy" @click="fetchLatest">{{ dlBusy ? '查询中…' : '获取最新版本号' }}</button>
      </div>
      <div class="rt-dl-row" v-for="b in store.binaries.items" :key="'dl-' + b.kernel">
        <b class="rt-dl-name">{{ KERNEL_LABELS[b.kernel] }}</b>
        <input class="rt-dl-ver mono" v-model="dlVersion[b.kernel]" :placeholder="versionOf(b.kernel)"
               @change="dlVersion = { ...dlVersion }" />
        <button class="btn mini rt-dl-go" :disabled="store.downloadBusy !== null" @click="download(b.kernel)">
          {{ store.downloadBusy === b.kernel ? '下载中…' : b.found ? '重新下载 / 更新' : '下载并安装' }}
        </button>
        <span v-if="store.downloadBusy !== b.kernel && !store.downloads[b.kernel]" class="rt-dl-note mono">
          默认 v{{ KERNEL_RELEASES[b.kernel].defaultVersion }}{{ store.latestVersions[b.kernel] ? ` · 最新 v${store.latestVersions[b.kernel]}` : '' }}
        </span>
        <span v-else class="rt-dl-note" :class="{ bad: store.downloads[b.kernel]?.phase === 'error', ok: store.downloads[b.kernel]?.phase === 'done' }">
          {{ store.downloads[b.kernel]?.message }}
        </span>
        <div v-if="store.downloadBusy === b.kernel && store.downloads[b.kernel]" class="rt-dl-bar">
          <div class="rt-dl-fill" :style="{ width: dlPercent(b.kernel) + '%' }"></div>
        </div>
      </div>
      <div class="rt-form" style="margin-top:6px">
        <label class="wide"><span>下载代理（可选，直连不上 GitHub 时填本机代理）</span>
          <input v-model="dlProxy" placeholder="例如 http://127.0.0.1:7897，留空直连" />
        </label>
      </div>
      <div class="rt-hint">
        下载源为各内核 GitHub 官方 Release；Xray 会做官方 .dgst SHA-256 校验，sing-box / Mihomo 官方不发校验文件，安装后展示本地哈希供你自行核对。
        也可以不用下载器，自行把可执行文件放进上面的目录。
      </div>
    </div>

    <!-- 运行参数 -->
    <div class="card rt-card">
      <div class="rt-title sm">运行参数</div>
      <div class="rt-form">
        <label><span>Mixed 端口</span><input type="number" v-model.number="settings.mixedPort" :disabled="isRunning" /></label>
        <label><span>SOCKS 端口</span><input type="number" v-model.number="settings.socksPort" :disabled="isRunning" /></label>
        <label><span>HTTP 端口</span><input type="number" v-model.number="settings.httpPort" :disabled="isRunning" /></label>
        <label><span>控制端口</span><input type="number" v-model.number="settings.controllerPort" :disabled="isRunning" /></label>
        <label><span>监听地址</span><input v-model="settings.listenAddress" :disabled="isRunning" /></label>
        <label><span>日志级别</span>
          <select v-model="settings.logLevel" :disabled="isRunning">
            <option value="debug">debug</option><option value="info">info</option>
            <option value="warn">warn</option><option value="error">error</option>
          </select>
        </label>
        <label class="wide"><span>DNS 服务器（逗号分隔）</span>
          <input :value="settings.dnsServers.join(', ')" :disabled="isRunning"
                 @change="settings.dnsServers = String(($event.target as HTMLInputElement).value).split(/[,，\s]+/).filter(Boolean)" />
        </label>
        <label class="check"><input type="checkbox" v-model="settings.dnsEnabled" :disabled="isRunning" /><span>内核接管 DNS</span></label>
        <label class="check"><input type="checkbox" v-model="settings.bypassLan" :disabled="isRunning" /><span>局域网直连</span></label>
        <label class="check"><input type="checkbox" v-model="settings.autoRestoreOnExit" /><span>退出时自动恢复系统代理</span></label>
        <label class="check"><input type="checkbox" v-model="settings.autoRestart" :disabled="isRunning" /><span>内核崩溃自动重启（指数退避）</span></label>
        <label><span>自动重启上限（次）</span>
          <input type="number" min="1" max="10" v-model.number="settings.maxAutoRestarts" :disabled="isRunning || !settings.autoRestart" />
        </label>
      </div>
      <div class="rt-note">
        默认走冷门端口段（21808~21811），避开 v2rayN / Clash 常占的 10808、7890、9090。
        端口被占用时会自动挪到下一个空闲端口，并把系统代理同步到新端口——日志里会写明实际使用的端口。
      </div>
      <div class="rt-form" style="margin-top:8px">
        <label v-for="k in (['xray','sing-box','mihomo'] as KernelType[])" :key="k" class="wide">
          <span>{{ KERNEL_LABELS[k] }} 可执行文件</span>
          <input :value="settings.binaryPaths[k] ?? ''" placeholder="留空则自动探测"
                 @change="settings.binaryPaths = { ...settings.binaryPaths, [k]: String(($event.target as HTMLInputElement).value).trim() }" />
        </label>
      </div>
      <div class="rt-actions">
        <button class="btn rt-primary" :disabled="isRunning || saving" @click="save">{{ saving ? '保存中…' : '保存运行设置' }}</button>
      </div>
    </div>

    <!-- 节点 / 内核选择 -->
    <div class="card rt-card">
      <div class="rt-title sm">启动目标</div>
      <div class="rt-form">
        <label class="wide"><span>节点</span>
          <select @change="pickNode(($event.target as HTMLSelectElement).value)">
            <option v-for="n in store.nodes" :key="n.id" :value="n.id">{{ n.name }} · {{ n.protocol.toUpperCase() }} · {{ n.server }}:{{ n.port }}</option>
            <option v-if="!store.nodes.length" value="">（尚未导入节点）</option>
          </select>
        </label>
        <label><span>内核</span>
          <select v-model="selectedKernel" :disabled="isRunning">
            <option value="xray">Xray-core</option>
            <option value="sing-box">sing-box</option>
            <option value="mihomo">Mihomo</option>
          </select>
        </label>
      </div>
      <div class="rt-hint">选择节点时会自动切换到它推荐的内核；若该节点在所选内核中不可用，启动会被明确拒绝并列出原因。</div>
    </div>

    <!-- 配置预览 -->
    <div class="card rt-card" v-if="showConfig">
      <div class="rt-title sm">运行配置预览 · {{ store.runtimePreview?.filename ?? '' }}
        <button class="btn mini" @click="showConfig = false">收起</button>
      </div>
      <div class="rt-hint">仅为将要落盘的内容，未写文件、未启动内核、未改系统设置。</div>
      <pre class="rt-pre">{{ store.runtimePreview?.text ?? store.runtimePreview?.error }}</pre>
    </div>

    <!-- 内核日志 -->
    <div class="card rt-card">
      <div class="rt-title sm">内核 / 运行日志
        <button class="btn mini" @click="showAllLogs = !showAllLogs">{{ showAllLogs ? '只看最近' : '查看全部' }}</button>
      </div>
      <div class="rt-log">
        <div v-for="(l, i) in visibleLogs" :key="i" :class="['rt-line', levelClass(l.level)]">
          <span class="mono">{{ new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
          <span>[{{ l.source }}]</span><span>{{ l.line }}</span>
        </div>
        <div v-if="!visibleLogs.length" class="rt-hint">暂无内核日志。启动内核后，stdout / stderr 会实时写到这里。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rt-wrap { display:flex; flex-direction:column; gap:12px; }
.rt-card { padding:14px 16px; }
.rt-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
.rt-title { font-size:15px; font-weight:700; color:var(--text); display:flex; align-items:center; gap:8px; }
.rt-title.sm { font-size:13px; margin-bottom:10px; }
.rt-sub { font-size:11px; color:var(--text-muted); margin-top:3px; }
.rt-state { font-size:11px; padding:4px 10px; border-radius:999px; border:1px solid var(--border-strong); color:var(--text-secondary); white-space:nowrap; }
.rt-state.on { color:var(--success); border-color:var(--success); background:var(--success-dim); }
.rt-state.bad { color:var(--danger); border-color:var(--danger); background:var(--danger-dim); }
.rt-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px 18px; margin:14px 0; }
.rt-grid > div { display:flex; flex-direction:column; gap:3px; min-width:0; }
.rt-grid span { font-size:10px; color:var(--text-muted); }
.rt-grid b { font-size:12px; color:var(--text); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rt-grid b.ok { color:var(--success); }
.rt-alert { border-radius:var(--radius-md); padding:8px 10px; font-size:11px; line-height:1.65; margin-bottom:8px; }
.rt-alert.bad { background:var(--danger-dim); color:var(--error-text); border:1px solid rgba(239,68,68,.35); }
.rt-alert.warn { background:rgba(245,158,11,.08); color:var(--warn-text); border:1px solid rgba(245,158,11,.3); }
.rt-alert.info { background:var(--accent-dim); color:var(--info-text); border:1px solid var(--border); }
.rt-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
.rt-foot { font-size:10px; color:var(--text-muted); margin-top:10px; line-height:1.6; }
.rt-modes { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.rt-mode { text-align:left; background:var(--bg-inset); border:1px solid var(--border); border-radius:var(--radius-md); padding:10px; cursor:pointer; color:var(--text-secondary); display:flex; flex-direction:column; gap:4px; }
.rt-mode b { font-size:12px; color:var(--text); }
.rt-mode span { font-size:10px; line-height:1.5; }
.rt-mode.active { border-color:var(--accent); background:var(--accent-dim); }
.rt-mode:disabled { opacity:.55; cursor:not-allowed; }
.rt-hint { font-size:10.5px; color:var(--text-muted); line-height:1.7; margin-top:8px; }
.rt-bin { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--divider); font-size:11px; min-width:0; }
.rt-bin b { min-width:110px; color:var(--text); }
.rt-ver { min-width:80px; color:var(--text-secondary); }
.rt-path { flex:1; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; }
.rt-dot { width:7px; height:7px; border-radius:50%; flex:none; }
.rt-dot.ok { background:var(--success); } .rt-dot.bad { background:var(--danger); }
.rt-form { display:grid; grid-template-columns:repeat(3,1fr); gap:8px 12px; }
.rt-form label { display:flex; flex-direction:column; gap:4px; font-size:10px; color:var(--text-muted); min-width:0; }
.rt-form label.wide { grid-column:1 / -1; }
.rt-form label.check { flex-direction:row; align-items:center; gap:6px; color:var(--text-secondary); font-size:11px; }
.rt-form input, .rt-form select { background:var(--bg-inset); border:1px solid var(--border); color:var(--text); border-radius:var(--radius-sm); padding:6px 8px; font-size:11px; font-family:var(--font-sans); width:100%; box-sizing:border-box; }
.rt-form input:disabled, .rt-form select:disabled { opacity:.55; }
.rt-form input[type=checkbox] { width:14px; height:14px; }
.rt-note { margin-top:8px; font-size:10px; line-height:1.6; color:var(--text-muted); }
.btn.mini { padding:3px 8px; font-size:10px; margin-left:auto; }
.rt-primary { background:var(--accent); color:#fff; border-color:var(--accent); }
.rt-danger { background:var(--danger-dim); color:var(--error-text); border-color:rgba(239,68,68,.4); }
.rt-pre { background:var(--code-bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:10px; font-family:var(--font-mono); font-size:10.5px; color:var(--code-text); max-height:260px; overflow:auto; white-space:pre-wrap; word-break:break-all; }
.rt-log { background:var(--code-bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:8px 10px; max-height:250px; overflow:auto; }
.rt-line { display:flex; gap:8px; font-size:10.5px; line-height:1.75; color:var(--text-secondary); font-family:var(--font-mono); }
.rt-line > span:first-child { color:var(--text-faint); flex:none; }
.rt-line > span:nth-child(2) { color:var(--accent); flex:none; }
.lg-err { color:var(--error-text) !important; } .lg-warn { color:var(--warn-text) !important; }
.lg-dim { color:var(--text-muted) !important; } .lg-info { color:var(--text-secondary); }
.rt-dl-head { display:flex; align-items:center; gap:8px; margin-top:12px; padding-top:10px; border-top:1px solid var(--divider); }
.rt-dl-title { font-size:11.5px; font-weight:600; color:var(--text-secondary); }
.rt-dl-row { display:grid; grid-template-columns:110px 90px auto 1fr; gap:6px 8px; align-items:center; padding:7px 0; border-bottom:1px solid var(--divider); }
.rt-dl-name { font-size:11px; color:var(--text); }
.rt-dl-ver { background:var(--bg-inset); border:1px solid var(--border); color:var(--text); border-radius:var(--radius-sm); padding:5px 7px; font-size:10.5px; width:100%; box-sizing:border-box; }
.rt-dl-go { white-space:nowrap; }
.rt-dl-note { font-size:10px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rt-dl-note.ok { color:var(--success); }
.rt-dl-note.bad { color:var(--danger); white-space:normal; }
.rt-dl-bar { grid-column:1 / -1; height:4px; border-radius:2px; background:var(--bg-inset); overflow:hidden; }
.rt-dl-fill { height:100%; background:var(--accent); transition:width .3s; }
</style>
