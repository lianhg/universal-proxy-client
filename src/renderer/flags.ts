/**
 * 本地国旗资源（离线 SVG，不依赖 emoji）
 *
 * 为什么不用 emoji：Windows 的 Segoe UI Emoji **不会**把区域指示符合成国旗，
 * 🇦🇺 / 🇮🇹 / 🇺🇸 在客户端里只会显示成 AU / IT / US 两个字母框。
 * 所以这里改用随程序打包的 SVG 国旗，任何系统上都显示真实图案。
 *
 * 资源来源：flag-icons 7.6.0 的 4x3 SVG（MIT），已落地到 ./flags/svg/，运行时不联网。
 *
 * 红线（必须遵守）：
 * - ISO `TW` 一律使用中国国旗，名称写「中国台湾」，绝不加载任何所谓"国旗"资源
 *   （tw.svg 在落地时已直接排除，代码里再做一次强制映射，双保险）。
 * - `HK` / `MO` 使用中国香港 / 中国澳门区旗，名称必须写全「中国香港」「中国澳门」。
 */
const urls = import.meta.glob('./flags/svg/*.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>

/** 常见别名与主权相关映射 */
const ALIAS: Record<string, string> = {
  UK: 'GB',   // 英国 ISO 是 GB，UK 是常用别名
  TW: 'CN',   // 中国台湾：使用中国国旗
}

/** 名称覆盖：保证涉及中国主权的表述准确 */
const FIXED_NAME: Record<string, string> = {
  CN: '中国',
  HK: '中国香港',
  MO: '中国澳门',
  TW: '中国台湾',
}

/** 归一化 ISO 两字码；非法输入返回空串，绝不猜测 */
export function normalizeCountryCode(code: unknown): string {
  if (typeof code !== 'string') return ''
  const c = code.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return ''
  return ALIAS[c] ?? c
}

/** 国旗 SVG 的可用 URL；没有对应资源返回空串（由组件显示两字码兜底） */
export function flagUrl(code: unknown): string {
  const c = normalizeCountryCode(code)
  if (!c) return ''
  return urls[`./flags/svg/${c.toLowerCase()}.svg`] ?? ''
}

let displayNames: Intl.DisplayNames | null = null
try { displayNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' }) } catch { /* 运行环境不支持时退回两字码 */ }

/** ISO 两字码 → 中文国家或地区名；识别不了就返回两字码本身，不编造 */
export function countryName(code: unknown): string {
  const raw = typeof code === 'string' ? code.trim().toUpperCase() : ''
  if (!/^[A-Z]{2}$/.test(raw)) return ''
  if (FIXED_NAME[raw]) return FIXED_NAME[raw]
  try { return displayNames?.of(raw) ?? raw } catch { return raw }
}
