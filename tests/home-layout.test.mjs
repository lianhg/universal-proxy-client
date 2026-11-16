/**
 * 首页统一画布 —— 模块隐藏 / 恢复能力回归测试
 * 运行：node tests/home-layout.test.mjs
 *
 * 亮哥要求：首页卡片要能「删除显示」，把功能重复的卡片隐藏起来，
 * 后续想要还能随时加回来。所以隐藏只能是「不渲染」，绝不能真删模块/删数据。
 * 这里锁死：5 个模块都有隐藏入口、都有恢复入口、隐藏状态持久化、重置能复原。
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
const app = fs.readFileSync(path.join(root, 'src/renderer/App.vue'), 'utf8');

const MODULES = ['heroTop', 'heroPower', 'heroInfo', 'heroQuick', 'heroNodes', 'hub', 'monitor', 'sites'];

console.log('\n=== 首页画布：模块隐藏 / 恢复 ===');

t('8 个首页模块全部登记在 HOME_MODULES，画布统一管理', () => {
  assert.match(app, /const HOME_MODULES = \['heroTop', 'heroPower', 'heroInfo', 'heroQuick', 'heroNodes', 'hub', 'monitor', 'sites'\] as const/);
  for (const id of MODULES) {
    assert.ok(app.includes(`setHomeMod('${id}'`) || app.includes('setHomeMod(hp.id'), `模块 ${id} 未登记 ref`);
  }
  // 首页二维码识别卡片已下线（功能仍在「二维码识别」页），不得再回到画布
  assert.ok(!app.includes('data-mod="qr"'), '二维码卡片模板未删干净');
  assert.ok(!app.includes("hideHomeMod('qr')"), '二维码卡片隐藏按钮未删干净');
  assert.ok(app.includes("activeTab === 'qrcode'"), '二维码识别功能页被误删');
  // 仪表盘拆成 5 张独立卡片，逐块交给画布
  for (const part of ['top', 'power', 'info', 'quick', 'nodes']) {
    assert.ok(app.includes(`part: '${part}'`), `仪表盘缺少拆分块 ${part}`);
  }
});

t('每个模块都有隐藏开关（编辑态右上角 ✕），隐藏只走 v-if 不删组件', () => {
  for (const id of MODULES) {
    assert.ok(app.includes(`!isHomeHidden('${id}')`) || app.includes('!isHomeHidden(hp.id)'), `模块 ${id} 未接入隐藏判断`);
  }
  assert.ok(app.includes("hideHomeMod('hub')"), '状态条缺少隐藏按钮处理');
  assert.ok(app.includes('hideHomeMod(hp.id)'), '仪表盘拆分块缺少隐藏按钮处理');
  // 模块本体仍在模板里，说明是「不渲染」而不是真删
  assert.ok(app.includes('<DashboardHero :part="hp.part" @navigate="onHeroNavigate" />'), '仪表盘组件被删了');
  assert.ok(app.includes('class="hub-strip"'), '状态条被删了');
  assert.ok(app.includes('网络连接监控'), '网络连接监控被删了');
  assert.ok(app.includes('二维码识别'), '二维码识别被删了');
  assert.ok(app.includes('网站代理检测'), '网站代理检测被删了');
});

t('隐藏状态持久化，并做了脏值过滤（只接受合法模块 id）', () => {
  assert.ok(app.includes("const HOME_HIDDEN_KEY = 'upc.home.hidden.v1'"), '缺少隐藏状态持久化键');
  assert.match(app, /function persistHomeHidden\(\)/);
  assert.match(app, /localStorage\.setItem\(HOME_HIDDEN_KEY/);
  assert.match(app, /HOME_MODULES\.includes\(x as HomeModId\)/, '读回隐藏状态时未过滤非法 id');
});

t('恢复入口常驻工具条：显示「已隐藏 N 个模块」并可逐个加回', () => {
  assert.match(app, /已隐藏 \{\{ hiddenMods\.length \}\} 个模块/);
  assert.match(app, /class="hidden-pop"/);
  assert.match(app, /v-for="id in hiddenMods"/);
  assert.match(app, /@click="restoreHomeMod\(id\)"/);
  assert.match(app, /function restoreHomeMod\(id: HomeModId\)/);
});

t('恢复时若已启用自定义布局，自动补兜底坐标，不会堆在左上角', () => {
  const body = app.slice(app.indexOf('function restoreHomeMod'), app.indexOf('function toggleHiddenPanel'));
  assert.match(body, /hasHomeCustom\(\) && !homeLayout\.value\[id\]/, '恢复时缺少坐标兜底判断');
  assert.match(body, /y: bottom \? bottom \+ 16 : 16/, '恢复时未计算兜底位置');
});

t('「设为默认」把当前布局与隐藏清单存成默认模板，「恢复默认」整包还原', () => {
  assert.match(app, /const HOME_DEFAULT_KEY = 'upc\.home\.default\.v1'/, '缺少默认布局持久化键');
  assert.match(app, /function setHomeDefault\(\)/);
  assert.match(app, /function restoreHomeDefault\(\)/);
  // 设为默认：坐标 + 隐藏清单都要落盘，且只存白名单模块
  const setBody = app.slice(app.indexOf('function setHomeDefault'), app.indexOf('function restoreHomeDefault'));
  assert.match(setBody, /localStorage\.setItem\(HOME_DEFAULT_KEY/, '设为默认未落盘');
  assert.match(setBody, /hidden: \[\.\.\.hiddenMods\.value\]/, '设为默认未一并保存隐藏清单');
  const loadBody = app.slice(app.indexOf('function loadHomeDefault'), app.indexOf('const homeDefault = ref'));
  assert.match(loadBody, /HOME_MODULES\.includes\(x as HomeModId\)/, '读回默认模板时未过滤非法 id');
  // 恢复默认：坐标与隐藏清单一起回来；没设过默认就回落到出厂排布
  const restoreBody = app.slice(app.indexOf('function restoreHomeDefault'), app.indexOf('let homeEnsureMade'));
  assert.match(restoreBody, /homeLayout\.value = \{ \.\.\.d\.layout \}/, '恢复默认未还原坐标');
  assert.match(restoreBody, /hiddenMods\.value = \[\.\.\.d\.hidden\]/, '恢复默认未还原隐藏清单');
  assert.ok(restoreBody.includes('resetHomeLayout()'), '没有默认模板时应回落到出厂排布');
  // 按钮语义：旧「重置为默认」必须彻底消失，不能只换皮还清空布局
  assert.ok(!app.includes('重置为默认'), '首页仍在用旧的「重置为默认」文案');
  assert.match(app, /@click="setHomeDefault">设为默认</, '缺少「设为默认」按钮');
  assert.match(app, /@click="restoreHomeDefault">恢复默认</, '缺少「恢复默认」按钮');
  // 「当前是否就是默认」要比较布局指纹，避免任何时候都挂着恢复按钮
  assert.match(app, /function sameAsHomeDefault\(\)/, '缺少默认布局一致性判断');
});

t('磁吸对齐：10px 内吸附其他卡片与画布边缘，并显示对齐辅助线', () => {
  assert.match(app, /const HOME_MAGNET = 10/);
  assert.match(app, /function magnetBox\(/);
  // 吸附目标 = 其他可见卡片四边 + 画布边缘
  assert.match(app, /xs\.push\(l\.x, l\.x \+ l\.w\)/);
  assert.match(app, /ys\.push\(l\.y, l\.y \+ l\.h\)/);
  assert.match(app, /if \(key === id \|\| hiddenMods\.value\.includes\(key\)\) continue/);
  // 拖动改 x/y，缩放改 w/h
  assert.match(app, /if \(mode === 'move'\) next\.x = Math\.max\(0, box\.x \+ bestX\.delta\)/);
  assert.match(app, /else next\.w = Math\.max\(HOME_MIN\[id\]\[0\], box\.w \+ bestX\.delta\)/);
  // 辅助线
  assert.match(app, /class="snap-guide snap-v"/);
  assert.match(app, /class="snap-guide snap-h"/);
  assert.match(app, /snapGuides\.value = \{ v: null, h: null \}/, '拖拽结束后辅助线未清理');
});

t('默认视觉红线不变：无自定义时仍是参考图排布（顶部横带整宽、中部三块各 4 栏）', () => {
  assert.match(app, /\.home-canvas \{ display:grid; grid-template-columns:repeat\(12,1fr\)/);
  assert.match(app, /\[data-mod="heroTop"\][\s\S]{0,400}grid-column:1 \/ -1/);
  assert.match(app, /\[data-mod="heroPower"\][\s\S]{0,160}grid-column:span 4/);
  // 隐藏按钮与隐藏弹层只在交互态出现，默认态不改变卡片视觉
  assert.match(app, /\.mod-hide \{[\s\S]*?position:absolute; top:6px; right:6px/);
});

t('只有点了「编辑布局」才显示拖动手柄并能拖动（平时固定展示、不误拖）', () => {
  // 两个入口都必须有编辑态守卫，平时点不到也拖不动
  assert.match(app, /function onHomeGripDown\(id: HomeModId, e: PointerEvent\) \{\s*\/\/[^\n]*\n\s*if \(!editHome\.value\) return/, '拖动入口缺编辑态守卫');
  assert.match(app, /function onHomeResizeDown\(id: HomeModId, e: PointerEvent\) \{\s*if \(!editHome\.value\) return/, '缩放入口缺编辑态守卫');
  // 手柄不得再有「平时悬停浮现」规则，只在编辑态显示
  assert.ok(!/\.home-canvas > \.home-mod:hover \.mod-grip/.test(app), '平时不应悬停浮现拖动手柄');
  assert.ok(!/\.home-canvas > \.home-mod:hover \.mod-resize/.test(app), '平时不应悬停浮现缩放手柄');
  assert.match(app, /\.home-canvas\.home--edit \.mod-grip \{ opacity:1; pointer-events:auto; \}/, '编辑态未显示拖动手柄');
  assert.match(app, /\.home-canvas\.home--edit \.mod-resize \{ opacity:1; \}/, '编辑态未显示缩放手柄');
  // 编辑态首次拖动（超过 3px）才量位成自由布局坐标，点一下没拖则还原默认栅格
  assert.match(app, /function ensureHomeLayout\(\)/, '缺少懒量位函数 ensureHomeLayout');
  assert.match(app, /if \(homeMoved\) persistHomeLayout\(\)[\s\S]{0,120}else if \(homeEnsureMade\) homeLayout\.value = \{\}/, '拖完未自动保存 / 没拖未还原');
  // 编辑态提示要说明「拖哪里、拖完自动保存」
  assert.match(app, /拖左上角「⠿ 拖动」移动/, '编辑态未提示拖动手柄位置');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
