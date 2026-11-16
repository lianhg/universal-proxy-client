/**
 * 节点列表 —— 代理国家图标 / 地区筛选 / 本地 SVG 国旗 回归测试
 * 运行：node tests/node-region.test.mjs
 *
 * 需求：节点列表要显示代理国家图标与 IP 端国家地址，方便切换节点。
 * 红线：
 * - IP 本身不带国家信息，禁止按地址段瞎猜；只认节点名/别名里真实写着的地区关键词，
 *   识别不到就明确标注「未识别」。仪表盘与节点列表必须共用同一份规则。
 * - Windows 的 emoji 字体不合成国旗（会退化成 AU/IT/US 字母框），
 *   所以必须用随包打包的本地 SVG 国旗，绝不再用区域指示符 emoji。
 * - ISO TW 一律用中国国旗、名称写「中国台湾」，不得加载任何所谓"国旗"资源。
 *
 * 纯静态校验，不联网、不启动 Electron、不改动任何文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const exists = p => fs.existsSync(path.join(root, p));

const regions = read('src/renderer/regions.ts');
const flags = read('src/renderer/flags.ts');
const icon = read('src/renderer/components/FlagIcon.vue');
const list = read('src/renderer/components/ProxyListPanel.vue');
const hero = read('src/renderer/components/DashboardHero.vue');

console.log('\n=== 节点列表：代理国家图标 / 地区筛选 / 本地 SVG 国旗 ===');

t('地区规则集中在一处，仪表盘与节点管家共用同一份', () => {
  assert.match(regions, /export const REGIONS: Region\[\]/);
  assert.match(regions, /export function regionOf/);
  assert.match(regions, /export function regionCode/);
  assert.match(regions, /export const OTHER_REGION/);
  assert.match(hero, /from '\.\.\/regions\.js'/, '仪表盘未复用共享地区规则');
  assert.match(list, /from '\.\.\/regions\.js'/, '节点管家未复用共享地区规则');
  assert.ok(!/const REGIONS: Region\[\] = \[/.test(hero), '仪表盘里残留了重复的地区表');
});

t('地区表带 ISO 两字码（用于取本地 SVG 国旗），不再是 emoji', () => {
  const codes = regions.match(/code: '[A-Z]{2}'/g) ?? [];
  assert.ok(codes.length >= 12, `地区条目只有 ${codes.length} 个`);
  assert.ok(!/flag: '🇦|flag: '🇺/.test(regions), '地区表里仍残留 emoji 旗标字段');
  assert.match(regions, /code: 'HK'/);
  assert.match(regions, /code: 'US'/);
  assert.match(regions, /code: 'AU'/);
});

t('节点列表显示「本地 SVG 国旗 + 中文国家/地区名」，并解释识别依据', () => {
  assert.match(list, /<FlagIcon :code="displayCode\(n\)"/, '节点行未渲染本地 SVG 国旗');
  assert.match(list, /\{\{ countryLabel\(n\) \|\| '未识别' \}\}/, '节点行未显示中文国家/地区名');
  assert.match(list, /import FlagIcon from '\.\/FlagIcon\.vue'/);
  assert.match(regions, /未识别/, '识别不到地区时没有明确提示');
  assert.match(list, /flagSourceOf/, '节点管家未复用共享的识别依据文案');
  assert.match(hero, /flagSourceOf/, '仪表盘未复用共享的识别依据文案');
  assert.match(list, /代理地区/, '节点详情缺少代理地区字段');
  // 仪表盘节点行与地区分组也必须换成 SVG 国旗
  assert.match(hero, /<FlagIcon :code="displayCode\(n\)"/, '仪表盘节点行仍是 emoji');
  assert.match(hero, /<FlagIcon :code="r\.code"/, '仪表盘地区分组仍是 r.flag（该字段已删除）');
  assert.ok(!/\{\{ r\.flag \}\}/.test(hero), '仪表盘仍引用已删除的 r.flag');
});

t('国旗资源随包离线：SVG 目录存在、用 Vite ?url 映射、加载失败有两字码兜底', () => {
  assert.ok(exists('src/renderer/flags/svg/us.svg'), '缺少美国国旗资源');
  assert.ok(exists('src/renderer/flags/svg/cn.svg'), '缺少中国国旗资源');
  const count = fs.readdirSync(path.join(root, 'src/renderer/flags/svg')).filter(f => f.endsWith('.svg')).length;
  assert.ok(count >= 250, `国旗资源只有 ${count} 个，覆盖不足`);
  assert.match(flags, /import\.meta\.glob\('\.\/flags\/svg\/\*\.svg'/, '未用 Vite 静态资源映射');
  assert.match(flags, /query: '\?url'/, '没有用 ?url（内联会让 bundle 暴涨）');
  assert.match(icon, /@error="failed = true"/, '图片加载失败没有兜底');
  assert.match(icon, /class="flag-fallback"[\s\S]{0,80}\{\{ label \}\}/, '兜底未显示两字码');
});

t('彻底移除 emoji 国旗（Windows 会显示成 AU / IT / US 字母框）', () => {
  assert.ok(!/export function codeToFlag/.test(regions), '仍在生成区域指示符 emoji');
  assert.ok(!/export function flagOf/.test(regions), '仍在用 emoji 判断地区');
  assert.ok(!/Segoe UI Emoji/.test(hero), '仪表盘仍挂着 emoji 字体栈');
  assert.ok(!/\{\{ displayFlag\(n\) \}\}/.test(list + hero), '仍在渲染 emoji 国旗文本');
  assert.match(flags, /Segoe UI Emoji \*\*不会\*\*/, '未记录替换原因');
});

t('国家/地区名写全，涉及中国主权的表述准确（TW 用中国国旗）', () => {
  assert.ok(!exists('src/renderer/flags/svg/tw.svg'), 'tw.svg 未排除，存在主权风险');
  assert.match(flags, /TW: 'CN'/, 'TW 未强制映射为中国国旗');
  assert.match(flags, /TW: '中国台湾'/);
  assert.match(flags, /HK: '中国香港'/);
  assert.match(flags, /MO: '中国澳门'/);
  assert.match(flags, /CN: '中国'/);
  assert.match(flags, /export function countryName/);
  assert.match(flags, /Intl\.DisplayNames\(\['zh-CN'\]/, '缺少中文国名转换');
});

t('节点信息卡片左上角也显示对应国旗（原固定红花只在识别不出时兜底）', () => {
  assert.match(hero, /class="info-flag" :class="\{ 'has-flag': !!infoCode \}"/, '节点信息卡未接入国旗状态');
  assert.match(hero, /<FlagIcon v-if="infoCode" :code="infoCode" :size="20" \/>/, '节点信息卡未渲染国旗');
  assert.match(hero, /const infoLikeNode = computed/, '缺少当前连接节点的地区数据源');
  assert.match(hero, /const infoCode = computed/, '缺少国旗代码计算');
  assert.match(hero, /const infoCountry = computed/, '缺少中文国家名');
  assert.match(hero, /infoFlagTitle/, '国旗缺少来源说明');
  assert.match(hero, /\.info-flag\.has-flag \{ background:transparent; \}/, '有国旗时未去掉红花底');
  // 图标尺寸红线：容器尺寸一个像素都不能改
  assert.match(hero, /--ic-flag: 20px/);
  assert.match(hero, /\.info-flag \{ width:var\(--ic-flag\); height:var\(--ic-flag\)/);
});

t('地区筛选只列真实存在的地区，数量来自当前节点', () => {
  assert.match(list, /const regionFilter = ref\(''\)/);
  assert.match(list, /const regionOptions = computed/);
  assert.match(list, /counter\.set\(k, \(counter\.get\(k\) \?\? 0\) \+ 1\)/);
  assert.match(list, /<option value="">全部地区<\/option>/);
  assert.match(list, /v-for="\[key, count\] in regionOptions"/);
});

t('离线瞎猜被禁止：没有打包任何本地地址段库，归属地只来自真实查询', () => {
  for (const banned of ['maxmind', 'ip2region', 'geolite']) {
    assert.ok(!regions.toLowerCase().includes(banned), `打包了离线地址段库：${banned}`);
  }
  assert.match(regions, /绝不凭 IP 段瞎猜国家/);
});

t('IP 归属地走真实查询：主进程 geo:lookup 多服务回退 + 6s 超时 + 磁盘缓存', () => {
  const main = read('src/main.ts');
  assert.match(main, /ipcMain\.handle\('geo:lookup'/, '主进程缺少 geo:lookup 处理器');
  for (const provider of ['api.ip.sb', 'ipwho.is', 'ip-api.com']) {
    assert.ok(main.includes(provider), `缺少归属地服务 ${provider}`);
  }
  assert.match(main, /AbortController[\s\S]{0,80}6000/, '归属地查询缺少 6s 超时');
  assert.match(main, /geoip-cache\.json/, '归属地缓存没有落盘');
  assert.match(main, /30 \* 24 \* 3600 \* 1000/, '缓存缺少 30 天有效期');
  assert.match(main, /slice\(0, 64\)/, '单次查询数量没有上限');
});

t('渲染层链路齐全：preload 暴露 geoLookup，store 缓存 30 天且只查认不出的', () => {
  const preload = read('src/preload/index.ts');
  assert.match(preload, /geoLookup: \(servers: string\[\]\) => ipcRenderer\.invoke\("geo:lookup", servers\)/);
  const store = read('src/renderer/store.ts');
  assert.match(store, /GEO_KEY = 'upc\.geo\.cache\.v1'/);
  assert.match(store, /async function lookupGeo/);
  assert.match(store, /filter\(n => !regionCode\(n\)\)/, '没有只查识别不出地区的节点');
  assert.match(store, /targets\.filter\(s => !geoMap\.value\[s\]\)/, '没有跳过已缓存的');
});

t('地区关键词带单词边界，避免 "in/de/us" 之类的误判', () => {
  assert.match(regions, /\\bhk\\b/);
  assert.match(regions, /\\bus\\b/);
  assert.match(regions, /\\bjp\\b/);
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
