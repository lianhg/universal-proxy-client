import { BrowserWindow, desktopCapturer, screen } from 'electron'
import regionHtml from './region-overlay.html?raw'

/**
 * 屏幕二维码取图：走 Electron 的 desktopCapturer，不再依赖渲染层的 getDisplayMedia。
 *
 * 为什么必须重做：
 * Electron 默认没有 display-capture 授权处理器，渲染层调 getDisplayMedia 只会得到
 * 「Not supported」，框选界面里永远是一块空白 —— 用户根本看不到背后的二维码。
 *
 * 现在的做法：
 * 1. 「框选屏幕区域」先弹一个全屏透明窗口（transparent + alwaysOnTop），
 *    页面上只有一圈边框和四周压暗，框内像素完全不绘制 → 背后真实二维码原样可见；
 * 2. 用户拖完框，窗口先隐藏，再抓整屏，按框选坐标裁切（坐标是 DIP，要乘缩放系数）；
 * 3. 裁切图以 PNG dataURL 返回渲染层，交给原有二维码解码链路。
 *
 * 只读屏幕，不落盘、不上传、不执行任何二维码内容。
 */

export interface CaptureOk {
  ok: true
  /** 裁切后的 PNG dataURL */
  dataUrl: string
  /** 裁切图像素尺寸 */
  w: number
  h: number
  /** 来自哪块屏幕，用于状态提示 */
  display: string
}
export interface CaptureFail {
  ok: false
  canceled: boolean
  error?: string
}
export type CaptureResult = CaptureOk | CaptureFail

function describeDisplay(display: Electron.Display, index: number): string {
  return display.label || `显示器 ${index + 1}`
}

/** 抓指定显示器的一帧整屏图（返回物理像素图，保证小二维码够清晰） */
async function grabDisplay(display: Electron.Display): Promise<Electron.NativeImage> {
  const b = display.bounds
  const sf = display.scaleFactor || 1
  // 按物理像素请求缩略图：1080p@125% 就是 2400×1350，而不是 1920×1080 被二次拉伸
  const width = Math.max(320, Math.round(b.width * sf))
  const height = Math.max(240, Math.round(b.height * sf))
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  })
  if (!sources.length) throw new Error('系统没有返回任何屏幕捕获源')

  /* display_id 在部分 Windows 版本上可能是空串，所以再按「显示器顺序」兜底一次，
     两路都拿不到就退回第一块屏（总比直接报错可用）。 */
  const all = screen.getAllDisplays()
  const idx = all.findIndex(d => d.id === display.id)
  const byId = sources.find(s => !!s.display_id && String(s.display_id) === String(display.id))
  const source = byId ?? sources[idx >= 0 ? idx : 0] ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('屏幕捕获返回空图像（可能被系统隐私设置拦截）')
  return source.thumbnail
}

function cropByDisplay(img: Electron.NativeImage, display: Electron.Display, rect: { x: number; y: number; w: number; h: number }) {
  const b = display.bounds
  const size = img.getSize()
  // 用实际返回图的尺寸反推缩放比，比直接信 scaleFactor 稳（thumbnail 会被等比缩到上限内）
  const sx = size.width / Math.max(1, b.width)
  const sy = size.height / Math.max(1, b.height)
  const x = Math.max(0, Math.min(size.width - 1, Math.round(rect.x * sx)))
  const y = Math.max(0, Math.min(size.height - 1, Math.round(rect.y * sy)))
  const w = Math.max(1, Math.min(size.width - x, Math.round(rect.w * sx)))
  const h = Math.max(1, Math.min(size.height - y, Math.round(rect.h * sy)))
  return { img, rect: { x, y, width: w, height: h }, scale: sx }
}

/** 框选屏幕区域：弹出透明全屏层，返回裁切后的 PNG */
export async function pickScreenRegion(): Promise<CaptureResult> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const b = display.bounds
  const displayName = describeDisplay(display, Math.max(0, screen.getAllDisplays().findIndex(d => d.id === display.id)))

  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true,          // 关键：窗口底透明，才能看见背后的桌面与二维码
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: '框选二维码区域',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(regionHtml))
    win.show()
    win.focus()

    /* 说明：这里刻意不用 preload / IPC，页面把结果交回 window.__qrRegionResolve，
       executeJavaScript 返回的 Promise 会挂着等它 —— 少一个 preload 入口，少一处攻击面。 */
    const picked = await new Promise<any>((resolve) => {
      let settled = false
      const done = (v: any) => { if (!settled) { settled = true; resolve(v) } }
      win.webContents
        .executeJavaScript('new Promise(r => { window.__qrRegionResolve = r })')
        .then(done, () => done({ canceled: true }))
      win.once('closed', () => done({ canceled: true }))
      // 兜底：用户既不框也强关不掉时，3 分钟后自动取消，避免这个 IPC 永远挂着
      timer = setTimeout(() => done({ canceled: true }), 180000)
    })

    if (!picked || picked.canceled) return { ok: false, canceled: true }

    /* 先隐藏透明层再抓屏：否则会把压暗遮罩一起截进去，二维码对比度下降、容易解不出来 */
    win.hide()
    await new Promise(r => setTimeout(r, 130))

    const img = await grabDisplay(display)
    const cropped = cropByDisplay(img, display, {
      x: Number(picked.x) || 0, y: Number(picked.y) || 0,
      w: Number(picked.w) || 0, h: Number(picked.h) || 0,
    })
    if (cropped.rect.width < 4 || cropped.rect.height < 4) return { ok: false, canceled: true }
    const out = (cropped.img as Electron.NativeImage).crop(cropped.rect)
    return {
      ok: true,
      dataUrl: out.toDataURL(),
      w: out.getSize().width,
      h: out.getSize().height,
      display: displayName,
    }
  } catch (e) {
    return { ok: false, canceled: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (timer) clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}

/** 整屏截图（不需要框选）：主窗口先让开，再抓当前显示器画面 */
export async function captureScreen(mainWindow: BrowserWindow | null): Promise<CaptureResult> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const displayName = describeDisplay(display, Math.max(0, screen.getAllDisplays().findIndex(d => d.id === display.id)))
  const wasVisible = !!mainWindow && mainWindow.isVisible()
  try {
    // 主窗口自己会挡住桌面：先藏起来，截完立刻恢复，避免把自家界面截进图里
    if (wasVisible) {
      mainWindow!.hide()
      await new Promise(r => setTimeout(r, 160))
    }
    const img = await grabDisplay(display)
    const size = img.getSize()
    return { ok: true, dataUrl: img.toDataURL(), w: size.width, h: size.height, display: displayName }
  } catch (e) {
    return { ok: false, canceled: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (wasVisible && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }
}
