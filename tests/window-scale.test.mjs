/**
 * 窗口整体缩放 —— 窗口放大 / 缩小时卡片随之等比放大缩小。
 * 运行：node tests/window-scale.test.mjs
 *
 * 需求：软件窗口化，放大缩小时里面的卡片相应放大缩小。
 * 实现：以 1100px 窗口为基准，内容视图用 CSS zoom 等比缩放（参与布局重排，
 * 不像 transform:scale 那样只做视觉缩放留空白）。
 *
 * 红线：
 * - 基准窗口 1100px 时缩放 = 100%，视觉与参考图零差异。
 * - 缩放全自动：界面上不提供任何开关按钮，窗口一变就自动适配，不需要用户点一下。
 * - 缩放层只包内容视图，顶栏 / 底栏带 -webkit-app-region:drag（无边框窗口拖动区）
 *   绝不能被缩放，否则窗口拖不动。
 * - 视口物理像素与布局逻辑像素必须换算，否则窗口放大后拖拽跟手错位。
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
const app = read('src/renderer/App.vue');
const scale = read('src/renderer/uiScale.ts');
const monitor = read('src/renderer/components/MonitorPanel.vue');
const qr = read('src/renderer/components/QrScannerPanel.vue');

console.log('\n=== 窗口整体缩放：卡片随窗口等比放大缩小 ===');

t('缩放以启动时实测内容宽度为 100% 基准，并有缩放上下限防止过大 / 过小', () => {
  assert.match(scale, /export const UI_BASE_WIDTH = 1100/);
  assert.match(scale, /export const UI_SCALE_MIN = 0\.75/);
  assert.match(scale, /export const UI_SCALE_MAX = 1\.8/);
  // 启动基准：Electron 无边框窗口 width:1100 时 innerWidth 实测 1086，写死 1100 会让启动瞬间变成 0.987
  assert.match(scale, /export function initScaleBase\(innerWidth: number\)/, '缺少启动时实测基准');
  assert.match(scale, /baseWidth = Number\.isFinite\(innerWidth\)/, '基准未取实测宽度');
  assert.match(scale, /if \(baseWidth !== null\) return baseWidth/, '基准必须只记录一次');
  assert.match(app, /initScaleBase\(window\.innerWidth\)/, 'App 启动时未记录基准');
  const body = scale.slice(scale.indexOf('export function scaleForWidth'), scale.indexOf('export const uiScale'));
  assert.match(body, /width \/ base/, '未按基准宽度换算缩放系数');
  assert.match(body, /Math\.min\(UI_SCALE_MAX, Math\.max\(UI_SCALE_MIN/, '缺少上下限 clamp');
});

t('窗口 resize 时重算缩放，卸载时清理监听（不留内存泄漏）', () => {
  assert.match(app, /function applyUiScale\(\)/);
  const mount = app.slice(app.indexOf('onMounted(() =>'), app.indexOf('onUnmounted(() =>'));
  assert.match(mount, /applyUiScale\(\)/, '挂载时未计算初始缩放');
  assert.match(mount, /window\.addEventListener\('resize', applyUiScale\)/, '未监听窗口尺寸变化');
  const unmount = app.slice(app.indexOf('onUnmounted(() =>'), app.indexOf('/* 顶部主题快捷按钮'));
  assert.match(unmount, /window\.removeEventListener\('resize', applyUiScale\)/, '卸载时未移除监听');
});

t('缩放变量只驱动内容视图的 .view-scaler，顶栏 / 底栏拖动区不受影响', () => {
  assert.match(app, /:style="\{ '--ui-scale': uiScale \}"/, 'app-shell 未下发缩放变量');
  assert.match(app, /\.view-scaler \{ zoom:var\(--ui-scale, 1\)/, '缩放层未使用 zoom');
  // 两个视图（首页 / 其它功能页）都包了缩放层，卡片才会一起放大缩小
  assert.equal((app.match(/class="view-scaler"/g) || []).length, 2, '缩放层数量不对');
  // drag 区规则必须原样保留，且不能出现在 .view-scaler 规则里
  assert.match(app, /\.topbar, \.footer-bar \{ -webkit-app-region: drag/);
  const scalerRule = app.slice(app.indexOf('.view-scaler {'), app.indexOf('.placeholder-view {'));
  assert.ok(!scalerRule.includes('app-region'), '缩放层不应改动无边框窗口拖动区');
});

t('缩放全自动：界面无开关按钮、无需点击，resize 即重算', () => {
  // 顶栏不再有「自适应 100%」这类看着要点一下才生效的按钮
  assert.ok(!/toggleAutoScale/.test(app), '仍残留手动开关函数');
  assert.ok(!/scale-btn/.test(app), '顶栏仍残留缩放开关按钮');
  assert.ok(!/自适应 |缩放 100%/.test(app), '顶栏仍有需要点击的缩放文案');
  assert.ok(!/autoScale/.test(app + scale), '仍残留自动缩放开关状态');
  assert.ok(!/setAutoScale/.test(scale), '仍残留开关设置函数');
  assert.ok(!/upc\.ui\.autoscale\.v1/.test(scale), '仍残留开关持久化（不需要用户设置）');
  // 计算链路必须无条件按窗口宽度走
  assert.match(app, /uiScale\.value = scaleForWidth\(window\.innerWidth\)/, '未按窗口宽度自动计算缩放');
  assert.match(app, /window\.addEventListener\('resize', applyUiScale\)/, 'resize 未自动重算');
});

t('坐标换算：物理像素 / 实测缩放系数 = 逻辑像素（不赌浏览器 zoom 语义）', () => {
  assert.match(scale, /export function domScale\(el: HTMLElement \| null \| undefined\)/);
  assert.match(scale, /getBoundingClientRect\(\)\.width/, '未实测 rect 物理宽度');
  assert.match(scale, /el\.clientWidth/, '未取逻辑宽度');
  assert.match(scale, /return physical \/ logical/, '未计算物理/逻辑比例');
  assert.match(scale, /export function toLogical\(px: number, el\?: HTMLElement \| null\)/);
  assert.match(scale, /px \/ \(domScale\(el\) \|\| 1\)/);
});

t('首页画布：量位与拖动都做了换算，窗口放大后卡片不跳位、拖动跟手', () => {
  const measure = app.slice(app.indexOf('function measureHomeLayout'), app.indexOf('function enterHomeEdit'));
  assert.match(measure, /domScale\(homeEl\.value\)/, '量位未使用实测缩放系数');
  assert.match(measure, /\(r\.left - base\.left\) \/ k/, '量位 x 未换算');
  assert.match(measure, /r\.width \/ k/, '量位宽度未换算');
  const move = app.slice(app.indexOf('function onHomePointerMove'), app.indexOf('function onHomePointerUp'));
  assert.match(move, /toLogical\(pdx, homeEl\.value\)/, '拖动 x 未换算');
  assert.match(move, /toLogical\(pdy, homeEl\.value\)/, '拖动 y 未换算');
  // 防手抖阈值仍按物理像素判断，不受缩放影响
  assert.match(move, /Math\.abs\(pdx\) < 3 && Math\.abs\(pdy\) < 3/);
});

t('监控页与屏幕框选同样做了换算（缩放层覆盖 11 个功能页）', () => {
  const mMeasure = monitor.slice(monitor.indexOf('function measureLayout'), monitor.indexOf('function enterEdit'));
  assert.match(mMeasure, /domScale\(panelEl\.value\)/);
  assert.match(mMeasure, /\(r\.left - base\.left\) \/ k/);
  const mMove = monitor.slice(monitor.indexOf('function onPointerMove'), monitor.indexOf('function onPointerUp'));
  assert.match(mMove, /toLogical\(pdx, panelEl\.value\)/);
  // 屏幕框选改由主进程透明层完成：坐标是 DIP，抓到的图是物理像素，必须按实际图尺寸换算
  const qrRegion = read('src/main/qr-region.ts');
  assert.match(qrRegion, /const sx = size\.width \/ Math\.max\(1, b\.width\)/, '屏幕框选未按图像实际尺寸算缩放比');
  assert.match(qrRegion, /Math\.round\(rect\.x \* sx\)/, '屏幕框选 x 未换算');
  assert.match(qrRegion, /Math\.round\(rect\.h \* sy\)/, '屏幕框选高度未换算');
  // 面板里原来那套「窗口内 video 上框选」必须彻底退场，否则又会被 UI 缩放放大一次
  assert.ok(!qr.includes('toLogical(e.clientX'), '面板内旧框选逻辑未清理');
});

t('默认视觉红线：缩放不改动图标尺寸变量、参考图栅格与断点', () => {
  assert.match(app, /\.home-canvas \{ display:grid; grid-template-columns:repeat\(12,1fr\)/);
  assert.match(app, /\[data-mod="heroPower"\][\s\S]{0,160}grid-column:span 4/);
  const css = read('src/renderer/components/DashboardHero.vue');
  assert.match(css, /--ic-rocket: 48px/);
  assert.match(css, /@media \(max-width:1000px\)/);
  // 缩放层里不出现任何写死的图标尺寸覆盖
  const scalerRule = app.slice(app.indexOf('.view-scaler {'), app.indexOf('.placeholder-view {'));
  assert.ok(!/--ic-|--ring:|font-size:\s*\d+px/.test(scalerRule), '缩放层不应改写图标尺寸或字号');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
