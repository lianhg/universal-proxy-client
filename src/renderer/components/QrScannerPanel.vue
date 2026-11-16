<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import ImportReportView from './ImportReportView.vue'
import { useAppStore } from '../store.js'

const store = useAppStore()
import type { ImportReport, UnifiedNode } from '../../core/hub/model.js'
import {
  startCameraScan, decodeQRFiles, decodeQRImage, readClipboard,
  previewQrHits, previewFileScans, summarizeQrPayload,
  type QrHit, type ScanController,
} from '../../core/hub/qr.js'
import { pickScreenRegion, captureScreenShot, fetchSubscription, parseConfig } from '../api.js'

const emit = defineEmits<{ add: [items: UnifiedNode[], overwrite: boolean] }>()

type Mode = 'camera' | 'screen' | 'region' | 'file' | 'clipboard'
const mode = ref<Mode>('camera')
const videoEl = ref<HTMLVideoElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const hits = ref<QrHit[]>([])
const report = ref<ImportReport | null>(null)
const status = ref('选择一种二维码来源开始识别')
const scanning = ref(false)
const busy = ref(false)
const fileResults = ref<{ fileName: string; count: number; error?: string }[]>([])

// 屏幕取图（框选区域 / 整屏）的预览图：用 dataURL 直接显示刚截到的画面
const shotUrl = ref('')
let controller: ScanController | null = null

const summarized = computed(() => hits.value.map(h => ({ hit: h, info: summarizeQrPayload(h.text) })))

function stop() {
  controller?.stop()
  controller = null
  scanning.value = false
  if (videoEl.value) videoEl.value.srcObject = null
}

function refreshReport(r?: ImportReport) {
  report.value = r ?? previewQrHits(hits.value)
  store.recordReport(report.value, '二维码识别')
}

function onFound(hit: QrHit) {
  if (hits.value.some(h => h.text === hit.text)) return
  hits.value.push(hit)
  status.value = `识别到二维码：${summarizeQrPayload(hit.text).kind}（来源 ${hit.origin}）`
  refreshReport()
}

async function startLive(kind: 'camera') {
  stop()
  mode.value = kind
  shotUrl.value = ''
  if (!videoEl.value) { status.value = '视频预览未就绪'; return }
  const opts = {
    intervalMs: 260,
    onFound,
    onError: (m: string) => { status.value = `扫码失败：${m}`; scanning.value = false; },
  }
  scanning.value = true
  status.value = '摄像头扫描中…'
  controller = startCameraScan(videoEl.value, opts)
}

/**
 * 屏幕取图扫码：交给主进程 desktopCapturer 完成。
 * 框选时弹出全屏透明层——框内一个像素都不绘制，背后的真实二维码原样可见，
 * 拖完松手立即抓屏裁切，不需要再点第二次按钮。
 * （原来在窗口内的 video 上框选，Electron 拿不到 getDisplayMedia，永远只有一块空白。）
 */
async function scanScreen(kind: 'region' | 'screen') {
  stop()
  mode.value = kind
  shotUrl.value = ''
  busy.value = true
  status.value = kind === 'region' ? '在屏幕上拖拽框住二维码，松手即识别…' : '正在截取当前屏幕…'
  try {
    const shot = kind === 'region' ? await pickScreenRegion() : await captureScreenShot()
    if (!shot.ok || !shot.dataUrl) {
      status.value = shot.canceled ? '已取消框选' : `屏幕取图失败：${shot.error ?? '未知原因'}`
      return
    }
    shotUrl.value = shot.dataUrl
    // dataURL → Blob 后复用图片解码链路（自带 2 倍放大，小码也能解出来）
    const blob = await (await fetch(shot.dataUrl)).blob()
    const size = `${shot.w ?? 0}×${shot.h ?? 0}`
    const found = await decodeQRImage(Object.assign(blob, { name: `屏幕取图-${size}.png` }), kind)
    if (!found.length) {
      status.value = `没有识别到二维码（${shot.display ?? '当前屏幕'} · ${size}）`
      return
    }
    let added = 0
    for (const hit of found) {
      if (hits.value.some(h => h.text === hit.text)) continue
      hits.value.push({ ...hit, origin: `${shot.display ?? '当前屏幕'} · ${size}` })
      added++
    }
    refreshReport()
    status.value = added
      ? `识别到 ${added} 个二维码（${shot.display ?? '当前屏幕'} · ${size}）`
      : `这张图里的二维码之前已经识别过（${size}）`
  } catch (e) {
    status.value = `屏幕取图失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}

async function handleFiles(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files ?? [])
  if (!files.length) return
  busy.value = true
  mode.value = 'file'
  try {
    const results = await decodeQRFiles(files)
    fileResults.value = results.map(r => ({ fileName: r.fileName, count: r.hits.length, error: r.error }))
    hits.value = results.flatMap(r => r.hits)
    const r = previewFileScans(results)
    refreshReport(r)
    status.value = `批量处理 ${files.length} 张图片，识别到 ${hits.value.length} 个二维码`
  } catch (err) { status.value = String(err) }
  finally { busy.value = false; (e.target as HTMLInputElement).value = '' }
}

async function handleClipboard() {
  mode.value = 'clipboard'
  busy.value = true
  const r = await readClipboard()
  hits.value = r.hits
  if (r.hits.length) refreshReport(previewQrHits(r.hits))
  else { report.value = null; store.log('warn', '[qr/clipboard]', r.note) }
  status.value = r.note
  busy.value = false
}

function clearAll() {
  stop(); hits.value = []; report.value = null; fileResults.value = []
  shotUrl.value = ''
  status.value = '已清空，选择一种来源重新开始'
}

/** 首页快捷操作：切到本页时直接按指定模式开始（图片模式唤起文件选择框） */
onMounted(async () => {
  const m = store.qrMode
  if (!m) return
  store.qrMode = null
  await nextTick()
  if (m === 'clipboard') await handleClipboard()
  else if (m === 'file') fileInput.value?.click()
  else if (m === 'camera') await startLive('camera')
  else if (m === 'screen' || m === 'region') await scanScreen(m)
})

function onConfirm(nodes: UnifiedNode[], overwrite: boolean) {
  emit('add', nodes, overwrite)
  status.value = `已确认导入 ${nodes.length} 个节点`
  report.value = null
}

/**
 * 二维码里是订阅 / 配置地址时，本地没有节点可导，预览里的确认按钮原来一直是灰的。
 * 这里按用户点击去把地址里的文本取回来，解析成节点预览；写入节点列表仍然要再确认一次。
 */
const fetching = ref(false)
async function onFetch(url: string) {
  if (!url || fetching.value) return
  fetching.value = true
  status.value = `正在拉取 ${url} …`
  store.log('info', '[network]', `二维码识别到地址，按用户确认拉取：${url}`)
  try {
    const r = await fetchSubscription(url)
    if (!r.ok) {
      status.value = `拉取失败：${r.error ?? '未知原因'}（地址可访问性、鉴权或网络都可能影响）`
      return
    }
    const rep = await parseConfig(r.text ?? '', {
      source: `subscription:${url}`,
      existingFingerprints: [...store.fingerprints],
    })
    report.value = rep
    store.recordReport(rep, '二维码订阅拉取')
    status.value = rep.nodes.length
      ? `已拉回并解析 ${rep.nodes.length} 个节点（无法识别 ${rep.stats.failed}）—— 点「确认导入」后写入节点列表`
      : `已拉回 ${(r.text ?? '').length} 字符，但没有解析出节点：这份内容可能不是节点订阅，或需要额外的 User-Agent`
  } catch (e) {
    status.value = `拉取失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    fetching.value = false
  }
}

onUnmounted(() => stop())
</script>

<template>
  <div class="card panel">
    <div class="head">
      <div>
        <h3>全协议二维码智能识别中心</h3>
        <p class="sub">二维码只是数据载体：解出内容后自动判定是分享链接、订阅地址还是完整配置，遇到不支持的格式明确提示</p>
      </div>
      <span class="cnt">已识别 {{ hits.length }} 个码</span>
    </div>

    <div class="toolbar">
      <button :class="['btn', { primary: mode === 'camera' && scanning }]" @click="startLive('camera')">摄像头实时扫码</button>
      <button :class="['btn', { primary: mode === 'screen' && !!shotUrl }]" @click="scanScreen('screen')">屏幕截图扫码</button>
      <button :class="['btn', { primary: mode === 'region' && !!shotUrl }]" @click="scanScreen('region')">框选屏幕区域</button>
      <button class="btn" :disabled="busy" @click="handleClipboard">剪贴板 / Ctrl+V</button>
      <label class="btn file-btn">
        批量导入图片
        <input ref="fileInput" type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" @change="handleFiles" />
      </label>
      <button v-if="scanning" class="btn danger" @click="stop">停止扫描</button>
      <button class="btn" @click="clearAll">清空</button>
    </div>

    <div class="scan-area">
      <div class="video-wrap">
        <video ref="videoEl" autoplay playsinline muted></video>
        <!-- 屏幕取图结果：框选 / 截屏后直接显示截到的画面，确认框住的就是二维码 -->
        <img v-if="shotUrl" class="shot" :src="shotUrl" alt="屏幕取图预览" />
        <div v-if="!scanning && !shotUrl" class="placeholder">
          <div class="qr-frame"><span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span><span class="scanline"></span></div>
          <div class="ph-text">选择来源后，二维码会出现在这里</div>
          <div class="ph-sub">支持 PNG / JPG / JPEG / WebP / BMP / GIF · 一图多码 · 多图批量</div>
        </div>
      </div>
      <div class="side">
        <div class="status" :class="{ active: scanning }">{{ status }}</div>
        <div class="src-list">
          <div class="sec-title">识别记录</div>
          <div v-if="!summarized.length" class="empty">暂无记录</div>
          <div v-for="(s, i) in summarized" :key="i" class="hit">
            <div class="hit-top"><span class="tag">{{ s.hit.source }}</span><b>{{ s.info.kind }}</b></div>
            <div class="hit-text mono">{{ s.info.preview }}</div>
            <div class="hit-foot">{{ s.hit.origin }} · {{ s.info.multiNode ? '含多个节点' : '单个内容' }}</div>
          </div>
        </div>
        <div v-if="fileResults.length" class="file-res">
          <div class="sec-title">图片处理结果</div>
          <div v-for="f in fileResults" :key="f.fileName" class="tiny">
            {{ f.error ? '失败' : `${f.count} 个码` }} · {{ f.fileName }} <span v-if="f.error" class="bad-text">{{ f.error }}</span>
          </div>
        </div>
      </div>
    </div>

    <p class="safe-hint">识别后只生成预览，不会自动导入节点或执行二维码里的配置；订阅地址类内容需要你确认后才会联网拉取。</p>
    <ImportReportView
      :report="report" title="二维码识别结果预览"
      fetchable :fetching="fetching"
      @confirm="onConfirm" @fetch="onFetch" @clear="report = null"
    />
  </div>
</template>

<style scoped>
.panel h3 { font-size: 15px; margin-bottom: 4px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sub { font-size: 12px; color: var(--text-muted); margin: 0; }
.cnt { font-size: 12px; color: var(--accent); white-space: nowrap; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0 10px; }
.file-btn { cursor: pointer; }
.scan-area { display: flex; gap: 12px; }
.video-wrap { position: relative; flex: 1; min-height: 260px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
.video-wrap video { width: 100%; height: 100%; max-height: 320px; object-fit: contain; display: block; }
.shot { position: absolute; inset: 0; width: 100%; height: 100%; max-height: 320px; object-fit: contain; background: var(--bg); }
.placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; pointer-events: none; }
.qr-frame { position: relative; width: 150px; height: 150px; border: 1px dashed rgba(59,130,246,.35); border-radius: 8px; }
.c { position: absolute; width: 20px; height: 20px; border: 2px solid var(--accent); }
.c.tl { top: -2px; left: -2px; border-right: 0; border-bottom: 0; } .c.tr { top: -2px; right: -2px; border-left: 0; border-bottom: 0; }
.c.bl { bottom: -2px; left: -2px; border-right: 0; border-top: 0; } .c.br { bottom: -2px; right: -2px; border-left: 0; border-top: 0; }
.scanline { position: absolute; left: 8px; right: 8px; height: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent); animation: scan 2.4s linear infinite; }
@keyframes scan { 0% { top: 8px; } 100% { top: 140px; } }
.ph-text { font-size: 13px; color: var(--text-secondary); } .ph-sub { font-size: 11px; color: var(--text-muted); }
.side { width: 290px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.status { font-size: 12px; color: var(--text-secondary); background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 9px 10px; }
.status.active { color: var(--success); border-color: rgba(34,197,94,.35); }
.src-list { max-height: 220px; overflow: auto; }
.sec-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
.empty { font-size: 12px; color: var(--text-muted); }
.hit { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 7px 9px; margin-bottom: 6px; background: var(--bg-inset); }
.hit-top { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); }
.tag { font-size: 10px; color: var(--accent); background: var(--accent-dim); border-radius: var(--radius-full); padding: 1px 7px; }
.hit-text { font-size: 11px; color: var(--text-muted); margin: 5px 0; word-break: break-all; max-height: 34px; overflow: hidden; }
.hit-foot { font-size: 10px; color: var(--text-faint); }
.file-res .tiny { font-size: 11px; color: var(--text-secondary); padding: 2px 0; word-break: break-all; }
.bad-text { color: var(--danger); }
.safe-hint { font-size: 11px; color: var(--text-muted); line-height: 1.7; margin: 10px 0 0; }
</style>
