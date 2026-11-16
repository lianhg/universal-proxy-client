/**
 * 地区 / 国旗识别（仪表盘与节点列表共用一份规则）。
 *
 * 红线 1：绝不凭 IP 段瞎猜国家。IP 本身不携带国家信息，离线做「IP → 国家」推断只能靠
 * 不完整的地址段表，必然出错。这里只认节点元数据里真实写着的地区关键词：
 * 中文国名 / 英文国名 / 高置信度城市 / 带单词边界的二字国家代码。
 * 匹配不到就归「其他地区」，同时给出提示，绝不编造。
 *
 * 红线 2：不再用 emoji 国旗。Windows 的 Segoe UI Emoji 不合成区域指示符，
 * 🇺🇸 只会显示成 "US" 字母框。这里只输出 ISO 两字码，由 FlagIcon.vue 用本地 SVG 画真国旗。
 */
import type { UnifiedNode } from '../core/hub/model.js'
import { countryName, normalizeCountryCode } from './flags.js'

export type Region = { key: string; code: string; re: RegExp }

/** key 是中文地区名，code 是 ISO 两字码（用于取本地 SVG 国旗） */
export const REGIONS: Region[] = [
  { key: '中国香港', code: 'HK', re: /香港|hong\s?kong|hongkong|🇭🇰|\bhk\b/i },
  { key: '日本', code: 'JP', re: /日本|japan|东京|tokyo|大阪|osaka|🇯🇵|\bjp\b/i },
  { key: '美国', code: 'US', re: /美国|united\s?states|usa|🇺🇸|\bus\b|kansas|los\s?angeles|las\s?vegas|new\s?york|nyc|seattle|san\s?jose|san\s?diego|dallas|chicago|miami|houston|boston|fremont|atlanta|portland|denver|austin|sacramento|phoenix|sunnyvale|mountain\s?view|silicon\s?valley/i },
  { key: '新加坡', code: 'SG', re: /新加坡|singapore|狮城|🇸🇬|\bsg\b/i },
  { key: '韩国', code: 'KR', re: /韩国|korea|首尔|seoul|釜山|busan|🇰🇷|\bkr\b/i },
  { key: '德国', code: 'DE', re: /德国|germany|deutschland|法兰克福|frankfurt|🇩🇪|\bde\b/i },
  { key: '英国', code: 'GB', re: /英国|united\s?kingdom|英格兰|england|伦敦|london|manchester|🇬🇧|\bgb\b|\buk\b/i },
  { key: '法国', code: 'FR', re: /法国|france|巴黎|paris|🇫🇷|\bfr\b/i },
  { key: '加拿大', code: 'CA', re: /加拿大|canada|多伦多|toronto|vancouver|montreal|🇨🇦|\bca\b/i },
  { key: '俄罗斯', code: 'RU', re: /俄罗斯|russia|莫斯科|moscow|🇷🇺|\bru\b/i },
  { key: '荷兰', code: 'NL', re: /荷兰|netherlands|阿姆斯特丹|amsterdam|🇳🇱|\bnl\b/i },
  { key: '澳大利亚', code: 'AU', re: /澳大利亚|australia|澳洲|悉尼|sydney|melbourne|🇦🇺|\bau\b/i },
]

export const OTHER_REGION = '其他地区'
/** 地球是单个码点，Windows 能正常显示；只用于「未识别」的文字提示，不用来冒充国旗 */
export const UNKNOWN_FLAG = '🌐'

/** 参与地区匹配的文本：节点名是主来源；别名与备注类字段里若写了地区也算真实信息。 */
function regionText(n: UnifiedNode): string {
  const alias = (n as { protocolAlias?: string }).protocolAlias ?? ''
  return `${n.name} ${alias}`
}

export function matchRegion(n: UnifiedNode): Region | undefined {
  const text = regionText(n)
  return REGIONS.find(r => r.re.test(text))
}

/** 中文地区名（只来自节点名里的真实关键词） */
export function regionOf(n: UnifiedNode): string {
  return matchRegion(n)?.key ?? OTHER_REGION
}

/** ISO 两字码（只来自节点名里的真实关键词）；认不出返回空串 */
export function regionCode(n: UnifiedNode): string {
  return matchRegion(n)?.code ?? ''
}

/**
 * 显示用国家码：优先节点名里真实写着的地区，认不出才用 IP 归属地真实查询结果（30 天缓存）。
 * getGeoCode 由调用方注入（store.geoCode），避免这里依赖 Pinia。
 */
export function displayCodeOf(n: UnifiedNode, getGeoCode: (server: string) => string): string {
  return regionCode(n) || normalizeCountryCode(getGeoCode(n.server))
}

/** 显示用中文地区名：节点名识别 > IP 归属地真实查询；都没有返回空串（界面显示「未识别」） */
export function countryLabelOf(n: UnifiedNode, getGeoCode: (server: string) => string): string {
  const fromName = regionOf(n)
  if (fromName !== OTHER_REGION) return fromName
  const raw = getGeoCode(n.server)
  return normalizeCountryCode(raw) ? countryName(raw) : ''
}

/** 提示文案：说清楚这个国家是「节点名认出来的」还是「真实查 IP 得到的」，不把推测伪装成事实 */
export function flagSourceOf(n: UnifiedNode, getGeoCode: (server: string) => string): string {
  const fromName = regionOf(n)
  if (fromName !== OTHER_REGION) return `节点名识别：${fromName}`
  const raw = getGeoCode(n.server)
  const code = normalizeCountryCode(raw)
  return code
    ? `IP 归属地真实查询：${countryName(raw)}（${code}）`
    : '未识别：节点名没有地区关键词，IP 归属地尚未获取或查询失败'
}
