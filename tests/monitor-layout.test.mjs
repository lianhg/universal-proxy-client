/**
 * 网络连接监控面板 —— 自定义布局能力回归测试
 * 运行：node tests/monitor-layout.test.mjs
 *
 * 与首页仪表盘一致：默认仍是原有流式卡片布局（红线），用户点「自定义布局」进入编辑态，
 * 每个模块可拖动 / 缩放 / 自由组合，排列持久化到 localStorage；可「重置为默认」。
 * 这里锁死：默认布局选择器原样保留 + 编辑态能力存在，防止日后改动悄悄删掉。
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
const mon = read('src/renderer/components/MonitorPanel.vue');

console.log('\n=== 网络连接监控：自定义布局能力 ===');

t('自定义布局入口与编辑态能力存在', () => {
  // 入口按钮
  assert.ok(mon.includes('自定义布局'), '缺少「自定义布局」入口按钮');
  // 拖动 / 缩放 / 定位处理函数
  assert.ok(mon.includes('onGripDown'), '缺少拖动处理函数 onGripDown');
  assert.ok(mon.includes('onResizeDown'), '缺少缩放处理函数 onResizeDown');
  assert.ok(mon.includes('moduleStyle'), '缺少 moduleStyle 定位函数');
  assert.ok(mon.includes('enterEdit') && mon.includes('exitEdit') && mon.includes('resetLayout'), '缺少进入/退出/重置函数');
  // 8 个模块都登记了可定位的 ref 与尺寸样式
  for (const id of ['head', 'notice', 'metrics', 'toolbar', 'table', 'rank', 'guide', 'hint']) {
    assert.ok(mon.includes(`setMod('${id}'`), `模块 ${id} 未登记 setMod`);
    assert.ok(mon.includes(`moduleStyle('${id}')`), `模块 ${id} 未绑定 moduleStyle`);
  }
  // 持久化键与编辑态类
  assert.ok(mon.includes('upc.monitor.layout.v1'), '缺少自定义布局持久化键');
  assert.ok(mon.includes('panel--edit'), '缺少编辑态类 .panel--edit');
  assert.ok(mon.includes('has-custom'), '缺少已保存自定义布局类 .has-custom');
  // 手柄样式
  assert.ok(mon.includes('mod-grip') && mon.includes('mod-resize'), '缺少拖动/缩放手柄样式');
});

t('默认布局选择器原样保留（红线：编辑态只是叠加，不破坏流式卡片）', () => {
  // 默认双栏：.split 是 flex（表格 + 排行并排）
  assert.match(mon, /\.split\s*\{[^}]*display:flex/, '默认 .split 仍应为 flex 并排布局');
  // 默认指标卡是栅格
  assert.match(mon, /\.metrics\s*\{[^}]*display:grid/, '默认 .metrics 仍应为栅格');
  // 编辑态通过 display:contents 解除 .split 的 flex，让表格 / 排行各自自由定位
  assert.ok(mon.includes('.panel--edit .split') && mon.includes('display:contents'), '编辑态未用 display:contents 解除 .split');
  // 编辑态模块改为绝对定位
  assert.ok(mon.includes('.panel--edit .ml-mod') && mon.includes('position:absolute'), '编辑态模块未改为绝对定位');
  // 默认布局的标题文案不变（不编造 / 不破坏现有内容）
  assert.ok(mon.includes('网络连接监控 · 真实连接'), '默认标题文案被改动');
});

t('构建产物含自定义布局逻辑（若已构建）', () => {
  const ad = path.join(root, 'dist/assets');
  if (!fs.existsSync(ad)) { console.log('    (dist 未构建，跳过产物校验)'); return; }
  const files = fs.readdirSync(ad).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 0, 'dist/assets 里没有 JS');
  const js = files.map(f => fs.readFileSync(path.join(ad, f), 'utf8')).join('');
  assert.ok(js.includes('upc.monitor.layout.v1'), '构建产物缺少监控自定义布局持久化键');
  assert.ok(js.includes('panel--edit'), '构建产物缺少编辑态类');
});

t('只有点了「编辑布局」才显示拖动手柄并能拖动（平时固定展示）', () => {
  // 两个入口都必须有编辑态守卫
  assert.match(mon, /function onGripDown\(id: ModId, e: PointerEvent\) \{\s*\/\/[^\n]*\n\s*if \(!editMode\.value\) return/, '拖动入口缺编辑态守卫');
  assert.match(mon, /function onResizeDown\(id: ModId, e: PointerEvent\) \{\s*if \(!editMode\.value\) return/, '缩放入口缺编辑态守卫');
  // 手柄只在编辑态显示，不再「平时悬停浮现」
  assert.ok(!/\.panel \.ml-mod:hover \.mod-grip/.test(mon), '平时不应悬停浮现拖动手柄');
  assert.match(mon, /\.panel--edit \.mod-grip \{ opacity:1; pointer-events:auto; \}/, '编辑态未显示拖动手柄');
  assert.match(mon, /\.panel--edit \.mod-resize \{ opacity:1; \}/, '编辑态未显示缩放手柄');
  // 编辑态首次拖动才量位：固定排布 → 自由布局坐标；拖完自动保存
  assert.match(mon, /function ensureLayout\(\)/, '缺少懒量位函数 ensureLayout');
  assert.match(mon, /if \(moved\) persistLayout\(\)[\s\S]{0,120}else if \(ensureMade\) layout\.value = \{\}/, '拖完未自动保存 / 没拖未还原');
});

t('手柄与选中框和模块边界一致（与首页同一套视觉，不遮内容、不放大模块）', () => {
  assert.match(mon, /\.panel--edit \.ml-mod \{ outline:1px dashed var\(--border-strong\); outline-offset:0;/, '选中框仍外扩，视觉上比模块大一圈');
  const grip = mon.slice(mon.indexOf('.mod-grip {'), mon.indexOf('.mod-grip span'));
  assert.match(grip, /top:0; left:0; transform:translateY\(-100%\)/, '手柄未统一贴模块上沿');
  assert.match(grip, /height:16px/, '手柄高度未固定，模块之间会出现大小差异');
  assert.ok(!/border-radius:0 var\(--radius-md\) 0 var\(--radius-md\)/.test(grip), '手柄仍是卡片内直角标签，会盖住模块标题');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
