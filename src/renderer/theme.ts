/**
 * 主题（黑夜 / 白天 / 跟随系统）唯一真源。
 *
 * 设计约定：
 * - 用户选择的是「模式」mode（dark / light / system），实际生效的是「解析后的主题」resolved。
 * - DOM 上只写两个属性：data-theme（dark|light）给 CSS 变量用，data-theme-mode 给 UI 展示当前选项用。
 * - 颜色全部走 style.css 的 CSS 变量，组件里不允许再硬编码深色值。
 * - 所有 DOM 访问都做存在性判断，纯逻辑部分（normalize / resolve）可直接在 Node 单测里跑。
 */

export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

export const THEME_STORAGE_KEY = 'upc.theme.v1'
export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'system'] as const

export const THEME_LABELS: Record<ThemeMode, string> = {
  dark: '黑夜模式',
  light: '白天模式',
  system: '跟随系统',
}

export const THEME_ICONS: Record<ThemeMode, string> = {
  dark: '\u{1F319}',   // 🌙
  light: '\u{2600}\u{FE0F}', // ☀️
  system: '\u{1F5A5}\u{FE0F}', // 🖥️
}

export const THEME_DESCRIPTIONS: Record<ThemeMode, string> = {
  dark: '深蓝底色，夜间使用更护眼',
  light: '明亮底色，白天 / 强光环境更清晰',
  system: '随 Windows 的深色/浅色设置自动切换',
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system'
}

/** 老版本 / 脏数据一律回退到 dark，绝不把非法值写进 DOM */
export function normalizeThemeMode(value: unknown, fallback: ThemeMode = 'dark'): ThemeMode {
  return isThemeMode(value) ? value : fallback
}

/** system 由调用方传入系统偏好，保证纯函数、可单测 */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light'
  return mode
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  // 没匹配到 (prefers-color-scheme: light) 就按深色处理（Electron 默认偏暗）
  return !window.matchMedia('(prefers-color-scheme: light)').matches
}

/** 读取持久化模式；storage 可注入，方便测试 */
export function readStoredTheme(storage?: Pick<Storage, 'getItem'> | null): ThemeMode {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!s) return 'dark'
  try { return normalizeThemeMode(s.getItem(THEME_STORAGE_KEY)) } catch { return 'dark' }
}

export function persistTheme(mode: ThemeMode, storage?: Pick<Storage, 'setItem'> | null): void {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!s) return
  try { s.setItem(THEME_STORAGE_KEY, normalizeThemeMode(mode)) } catch { /* 隐私模式下写不进也不影响本次会话 */ }
}

/**
 * 把模式应用到 DOM，返回实际生效的主题。
 * prefersDark 可注入（测试 / 手动覆盖）；缺省时读系统偏好。
 */
export function applyTheme(mode: ThemeMode, opts: { prefersDark?: boolean; doc?: Document } = {}): ResolvedTheme {
  const normalized = normalizeThemeMode(mode)
  const dark = opts.prefersDark ?? systemPrefersDark()
  const resolved = resolveTheme(normalized, dark)
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined)
  if (doc?.documentElement) {
    doc.documentElement.dataset.theme = resolved
    doc.documentElement.dataset.themeMode = normalized
    doc.documentElement.style.colorScheme = resolved
  }
  return resolved
}

/** 监听系统主题变化，返回取消监听函数；不支持的环境返回空函数 */
export function watchSystemTheme(callback: () => void, win?: Window | null): () => void {
  const w = win ?? (typeof window !== 'undefined' ? window : null)
  if (!w || typeof w.matchMedia !== 'function') return () => {}
  const mq = w.matchMedia('(prefers-color-scheme: light)')
  const handler = () => callback()
  try {
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
    // Electron 33 / Chromium 老接口的兼容分支
    const legacy = mq as unknown as { addListener: (cb: () => void) => void; removeListener: (cb: () => void) => void }
    legacy.addListener(handler)
    return () => legacy.removeListener(handler)
  } catch {
    return () => {}
  }
}

/**
 * 首屏防闪烁脚本（内联到 index.html，在 Vue 挂载前就定好 data-theme）。
 * 单独导出字符串便于单测断言内容一致，避免 html 与运行时逻辑两处漂移。
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var m=localStorage.getItem('${THEME_STORAGE_KEY}');if(m!=='light'&&m!=='dark'&&m!=='system')m='dark';var d=m==='system'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):m;document.documentElement.dataset.theme=d;document.documentElement.dataset.themeMode=m;document.documentElement.style.colorScheme=d;}catch(e){}})();`
