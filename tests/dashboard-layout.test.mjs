/**
 * 首页仪表盘 —— 参考图布局与图标尺寸红线回归测试
 * 运行：node tests/dashboard-layout.test.mjs
 *
 * 亮哥明确要求「首页改成图中形式，图标大小不要擅自自己改动」。
 * 这里把参考图量出的像素值逐项锁死：改任何一处尺寸 / 比例 / 断点，测试立即失败。
 * 同时守住「不编造演示数据」红线：源码里不许出现参考图里的示例数值。
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
const hero = read('src/renderer/components/DashboardHero.vue');
const app = read('src/renderer/App.vue');

console.log('\n=== 首页仪表盘：布局与图标尺寸 ===');

/* 参考图量出的 12 个图标尺寸，集中定义、逐项锁死 */
const ICON_SIZES = {
  '--ic-check': '40px',    // 状态圆形对勾
  '--ic-rocket': '48px',   // 大圆内火箭
  '--ic-quick': '30px',    // 快捷操作四宫格
  '--ic-info': '16px',     // 节点信息行
  '--ic-group': '16px',    // 左侧分组栏
  '--ic-search': '16px',
  '--ic-refresh': '20px',
  '--ic-flag': '20px',     // 节点行地区标
  '--ic-signal': '18px',
  '--ic-more': '16px',
  '--ic-arrow': '18px',    // 下载 / 上传箭头
};

t('11 个图标尺寸严格等于参考图数值，未被擅自调整', () => {
  for (const [name, px] of Object.entries(ICON_SIZES)) {
    const re = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*${px}\\s*;`);
    assert.match(hero, re, `${name} 应为 ${px}，当前可能被改动`);
  }
});

t('每个图标类都绑定了对应尺寸变量（没有漏绑或写死别的数值）', () => {
  for (const cls of ['ic-arrow', 'ic-quick', 'ic-info', 'ic-group', 'ic-search', 'ic-refresh', 'ic-signal', 'ic-more']) {
    assert.match(hero, new RegExp(`\\.${cls}\\s*\\{[^}]*width:var\\(--ic-[a-z]+\\)`), `.${cls} 未使用尺寸变量`);
  }
  assert.match(hero, /\.ic-rocket\s*\{[^}]*width:var\(--ic-rocket\)/);
  assert.match(hero, /\.status-check\s*\{[^}]*width:var\(--ic-check\)/);
});

t('顶部横带三格并排、比例按图 1.6fr / 1fr / 1fr', () => {
  assert.match(hero, /\.dash-top\s*\{[^}]*grid-template-columns:1\.6fr 1fr 1fr/);
  assert.match(hero, /\.top-cell \+ \.top-cell\s*\{[^}]*border-left/);
});

t('中部三列并排，左侧大圆 / 节点信息 / 快捷操作', () => {
  assert.match(hero, /\.dash-mid\s*\{[^}]*grid-template-columns:1\.1fr 1\.15fr 1fr/);
  assert.match(hero, /class="power-cell"/);
  assert.match(hero, /class="card dash-info"/);
  assert.match(hero, /class="card dash-quick"/);
});

t('关键控件尺寸按图：大圆 200px / 快捷按钮 100px / 节点行 52px / 搜索与分组 36px', () => {
  assert.match(hero, /\.power-ring\s*\{[^}]*width:200px; height:200px; border-radius:50%; border:10px/);
  assert.match(hero, /\.quick-grid button\s*\{[^}]*height:100px/);
  assert.match(hero, /\.node-row\s*\{[^}]*height:52px/);
  assert.match(hero, /\.nodes-search\s*\{[^}]*height:36px/);
  assert.match(hero, /\.group-btn\s*\{[^}]*height:36px/);
});

t('窄屏断点下移到 1000px：1100px 窗口不会再被误判成窄屏而拆行', () => {
  assert.match(hero, /@media \(max-width:1000px\)/);
  assert.doesNotMatch(hero, /@media \(max-width:1120px\)/);
});

t('图标是内联线性 SVG symbol，不是 emoji 占位', () => {
  const symbols = hero.match(/<symbol id="ic-/g) || [];
  assert.ok(symbols.length >= 19, `SVG symbol 只有 ${symbols.length} 个`);
  for (const id of ['ic-rocket', 'ic-qr-scan', 'ic-image', 'ic-clipboard', 'ic-folder', 'ic-flower', 'ic-search', 'ic-refresh']) {
    assert.ok(hero.includes(`id="${id}"`), `缺少图标 ${id}`);
  }
});

t('参考图里的演示数值一个都没写进代码（不编造数据）', () => {
  for (const fake of ['12.6 MB/s', '8.3 MB/s', '28 ms', 'hk.example.com', '00:12:36', '香港·01']) {
    assert.ok(!hero.includes(fake), `源码里出现了演示数据 ${fake}`);
  }
  assert.match(hero, /等待真实采样/);
  assert.match(hero, /未测速/);
});

t('首页第一屏从仪表盘开始，真实状态条下移且信息一条没删', () => {
  const heroAt = app.indexOf('<DashboardHero :part="hp.part" @navigate="onHeroNavigate" />');
  const stripAt = app.indexOf('<div class="hub-strip">');
  assert.ok(heroAt > 0 && stripAt > heroAt, 'hub-strip 应排在仪表盘之后');
  for (const w of ['真实节点', '订阅', '阻断问题', '含待确认字段', '运行日志', '内核状态']) {
    assert.ok(app.includes(w), `状态条丢了「${w}」`);
  }
});

t('构建产物 CSS 保留图标尺寸变量与 1000px 断点（若已构建）', () => {
  const ad = path.join(root, 'dist/assets');
  if (!fs.existsSync(ad)) { console.log('    (dist 未构建，跳过产物校验)'); return; }
  const files = fs.readdirSync(ad).filter(f => f.endsWith('.css'));
  assert.ok(files.length > 0, 'dist/assets 里没有 CSS');
  const css = files.map(f => fs.readFileSync(path.join(ad, f), 'utf8')).join('');
  assert.ok(/--ic-quick:\s*30px/.test(css), '图标尺寸变量在压缩后丢失');
  assert.ok(/--ic-rocket:\s*48px/.test(css), '火箭尺寸变量在压缩后丢失');
  assert.ok(/max-width:\s*1000px/.test(css) || /max-width:1000px/.test(css), '1000px 断点在压缩后丢失');
});

t('仪表盘内部旧工具条已删除：首页只有画布一个布局入口，不再出现重复按钮', () => {
  const tpl = hero.slice(hero.indexOf('<template>'), hero.indexOf('</template>'));
  // 内部工具条与入口按钮整体移除，editMode 不再可达（旧 localStorage 存档也不会生效）
  assert.ok(!tpl.includes('dash-toolbar'), '仪表盘内部旧工具条应已删除');
  assert.ok(!tpl.includes('自定义布局'), '仪表盘模板不应再有独立的「自定义布局」入口');
  assert.ok(!tpl.includes('@click="enterEdit"'), '不应再有触发内部编辑态的按钮');
  // 首页画布工具条承担统一入口（含隐藏/恢复/重置）
  assert.ok(app.includes('自定义首页布局'), '首页画布缺少统一布局入口');
  // 内部死代码已彻底移除：不再有第二套拖拽引擎 / 布局存档键
  assert.ok(!hero.includes('upc.dash.layout.v2'), '仪表盘不应再保留内部布局存档键（首页画布统一管理）');
  assert.ok(!hero.includes('setMod('), '仪表盘不应再保留内部模块登记逻辑');
  assert.ok(!hero.includes('editMode'), '仪表盘不应再保留内部编辑态');
});

t('点「延迟」就地显示网速 / ping，不跳页；未测速可就地测速回填', () => {
  assert.match(hero, /const speedOpen = ref\(false\)/, '缺少就地展开状态');
  assert.match(hero, /@click="speedOpen = !speedOpen"/, '延迟标签点击未就地展开');
  assert.match(hero, /button type="button" :class="\['delay-tag', 'delay-btn'/, '延迟标签不是可点击按钮');
  assert.match(hero, /class="info-speed"/, '缺少就地详情面板');
  for (const kw of ['Ping / 握手', '网速 / 下载', '首字节', '实测下载', 'speedRow?.latencyMs', 'speedRow?.mbps', 'formatMbps', 'formatBytes']) {
    assert.ok(hero.includes(kw), `详情面板缺少「${kw}」`);
  }
  // 数据只来自真实真连测速结果，绝不估算
  assert.match(hero, /const speedRow = computed\(\(\) => store\.speedRows\[currentId\.value\] \?\? null\)/);
  assert.match(hero, /const speedBusy = computed\(\(\) => store\.speedBusy\)/);
  assert.match(hero, /async function measureHere\(\)/);
  assert.match(hero, /store\.startSpeedTest\(\[n\]\)/, '缺少就地测速入口');
  // 就地展开与就地测速两条路径都不许跳转
  const measure = hero.slice(hero.indexOf('async function measureHere'), hero.indexOf('async function toggleConnect'));
  assert.ok(!/emit\('navigate'/.test(measure), '就地测速不应跳转页面');
  const panel = hero.slice(hero.indexOf('<!-- 点「延迟」就地展开'), hero.indexOf('<div v-if="!info" class="info-empty"'));
  assert.ok(!/emit\('navigate'/.test(panel), '详情面板不应跳转页面');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
