/**
 * 界面整体缩放 —— 窗口放大 / 缩小时，内容视图里的卡片连同文字、图标一起等比缩放。
 *
 * 关键约束：缩放只作用在 .view-scaler 这一层。顶栏 / 底栏带 -webkit-app-region:drag
 * （无边框窗口的拖动区），绝对不能缩放，否则命中测试错位、窗口会拖不动。
 *
 * 缩放完全由软件自动完成：窗口尺寸一变就重算，没有任何需要用户点击的开关或按钮。
 *
 * 基准窗口宽度 1100px（main.ts 初始窗口宽），此时缩放为 1，视觉与参考图零差异。
 *
 * 坐标换算（CSS zoom 语义）：
 *   CSS left/top/width/height、clientWidth/clientHeight 属于「逻辑像素」，渲染时乘 zoom；
 *   getBoundingClientRect()、PointerEvent.clientX/Y 属于「视口物理像素」，不乘 zoom。
 *   两者相差一个缩放系数：逻辑 = 物理 / scale。
 *   所以「量位」和「拖拽」读到的物理值必须先换算回逻辑值再写进布局；否则窗口放大后
 *   首次拖动量出来的坐标会偏大、拖动手柄跟手错位。
 */
import { ref } from 'vue'

/** 设计基准窗口宽度（参考图对应的 Electron 窗口 width） */
export const UI_BASE_WIDTH = 1100
/** 启动时窗口宽度允许浮动 ±12%（用户可能上次关窗时是最大化 / 缩小过） */
export const UI_BASE_TOLERANCE = 0.12
export const UI_SCALE_MIN = 0.75
export const UI_SCALE_MAX = 1.8

/**
 * 记录启动时的实际内容宽度作为「100% 基准」。
 *
 * Electron 无边框窗口 width:1100 时 webContents 的 innerWidth 实测只有 1086（不可见边框），
 * 不同机器 / DPI 缩放还不一样。若写死 1100，启动瞬间会得到 0.987，卡片比参考图小 1.3%，
 * 破坏「基准窗口视觉零差异」红线。以实测启动宽度为基准，任何环境启动都是精确 100%。
 * 只接受设计基准 ±12% 内的窗口宽度：用户上次把窗口最大化 / 缩到很小后重启，
 * 不该把那个尺寸当成 100%（否则之后窗口一变就整体缩得离谱）。
 */
let baseWidth: number | null = null
export function initScaleBase(innerWidth: number): number {
  if (baseWidth !== null) return baseWidth
  const lo = UI_BASE_WIDTH * (1 - UI_BASE_TOLERANCE)
  const hi = UI_BASE_WIDTH * (1 + UI_BASE_TOLERANCE)
  baseWidth = Number.isFinite(innerWidth) && innerWidth > 0
    ? Math.min(hi, Math.max(lo, innerWidth))
    : UI_BASE_WIDTH
  return baseWidth
}

/** 按窗口宽度算目标缩放系数，带上下限防止文字过大 / 过小 */
export function scaleForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1
  const base = baseWidth ?? UI_BASE_WIDTH
  const raw = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, width / base))
  return Math.round(raw * 1000) / 1000
}

/** 当前生效的缩放系数；窗口 resize 时由 App.vue 更新，CSS 变量 --ui-scale 由它驱动 */
export const uiScale = ref(1)

/**
 * 实测容器的「视口物理像素 / 布局逻辑像素」比例。
 *
 * 不直接拿 uiScale 去除：CSS zoom 下 getBoundingClientRect / clientX 是视口物理像素，
 * clientWidth 是布局逻辑像素，两者之比天然等于实际缩放系数。用实测值可以避免依赖
 * 浏览器对 zoom 几何 API 的具体语义（不同 Chromium 版本有差异）。未缩放时比值恒为 1，
 * 所有坐标换算自动退化为恒等变换、视觉零变化。
 */
export function domScale(el: HTMLElement | null | undefined): number {
  if (!el) return uiScale.value || 1
  const logical = el.clientWidth
  const physical = el.getBoundingClientRect().width
  if (!logical || !physical) return uiScale.value || 1
  return physical / logical
}

/** 视口物理像素 → 布局逻辑像素；传入容器时用实测比例，否则回退 uiScale */
export function toLogical(px: number, el?: HTMLElement | null): number {
  return px / (domScale(el) || 1)
}
