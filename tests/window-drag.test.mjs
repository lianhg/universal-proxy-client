/**
 * 无边框窗口拖动 —— 静态红线回归测试
 * 运行：node tests/window-drag.test.mjs
 *
 * 背景：BrowserWindow 用 frame:false 自定义标题栏时，若没有任何元素声明
 * `-webkit-app-region: drag`，按住左键完全拖不动窗口；而该属性会把命中测试
 * 传递给子元素，所有按钮 / 菜单 / 输入控件必须显式 no-drag，否则点不动。
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
const main = read('src/main.ts');
const preload = read('src/preload/index.ts');
/* 匹配的是 CSS 规则结构，模板/脚本里的同名字符串不会命中，无需切割文件 */
const style = app;

console.log('\n=== 无边框窗口拖动 ===');

t('主进程确实是无边框窗口（才需要自定义拖拽区）', () => {
  assert.match(main, /frame:\s*false/);
  assert.match(main, /titleBarStyle:\s*'hidden'/);
});

t('最小化 / 最大化 / 关闭三个窗口控制 IPC 配对完整', () => {
  for (const a of ['minimize', 'maximize', 'close']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${a}-window'`), `缺少主进程 ${a}-window`);
    assert.match(preload, new RegExp(`${a}:\\s*\\(\\)\\s*=>\\s*ipcRenderer\\.invoke\\("${a}-window"\\)`), `缺少 preload ${a}`);
  }
});

t('顶部栏 / 底部状态栏都声明为可拖拽', () => {
  const rule = /\.topbar,\s*\.footer-bar\s*\{[^}]*-webkit-app-region:\s*drag/;
  assert.match(style, rule, '找不到 drag 声明');
});

t('拖拽区与 no-drag 排除规则同时存在，且排除在后', () => {
  const dragAt = style.search(/-webkit-app-region:\s*drag/);
  const noDragAt = style.search(/-webkit-app-region:\s*no-drag/);
  assert.ok(dragAt > 0, '缺少 drag');
  assert.ok(noDragAt > dragAt, 'no-drag 规则必须写在 drag 之后，避免被覆盖');
});

t('所有可交互元素都被显式排除拖拽', () => {
  const at = style.search(/-webkit-app-region:\s*no-drag/);
  const block = style.slice(Math.max(0, at - 700), at + 80);
  for (const sel of [
    '.topbar-actions', '.topbar button', '.topbar a', '.topbar input',
    '.topbar select', '.topbar textarea', '.menu-mask', '.menu-pop', '.menu-btn',
    '.modal-mask', '.help-modal', '.app-toast',
  ]) {
    assert.ok(block.includes(sel), `no-drag 缺少选择器 ${sel}`);
  }
});

t('顶栏双击最大化已绑定，且按钮上双击不触发', () => {
  assert.match(app, /<header class="topbar" @dblclick="onTopbarDblClick">/);
  assert.match(app, /function onTopbarDblClick\(e: MouseEvent\)/);
  assert.match(app, /closest\('button, a, input, select, textarea, \.topbar-actions, \[role="button"\]'\)/);
  assert.match(app, /winControl\('maximize'\)/);
});

t('使用帮助里写明了拖动位置与双击行为', () => {
  assert.match(app, /<li><b>拖动窗口<\/b>/);
  assert.match(app, /顶部栏空白处/);
  assert.match(app, /双击顶部栏空白处最大化/);
});

t('构建产物 CSS 保留 -webkit-app-region（若已构建）', () => {
  const ad = path.join(root, 'dist/assets');
  if (!fs.existsSync(ad)) { console.log('    (dist 未构建，跳过产物校验)'); return; }
  const files = fs.readdirSync(ad).filter(f => f.endsWith('.css'));
  assert.ok(files.length > 0, 'dist/assets 里没有 CSS');
  const css = files.map(f => fs.readFileSync(path.join(ad, f), 'utf8')).join('');
  assert.ok(css.includes('-webkit-app-region:drag') || css.includes('-webkit-app-region: drag'),
    'CSS 里的拖拽声明被压缩/前缀处理吃掉了');
  assert.ok(css.includes('-webkit-app-region:no-drag') || css.includes('-webkit-app-region: no-drag'),
    'CSS 里的按钮排除声明丢了');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
