/**
 * 节点管家（原「节点管理」+「节点测速」合并页）回归测试
 * 运行：node tests/node-hub.test.mjs
 *
 * 红线：合并只删重复的「第二个列表页」，不能丢任何管理能力或测速能力；
 * 旧深链接 #speedtest 必须还能用；原组件文件保留以便随时回退。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'src/renderer/App.vue'), 'utf8');
const hub = fs.readFileSync(path.join(root, 'src/renderer/components/ProxyListPanel.vue'), 'utf8');
const hero = fs.readFileSync(path.join(root, 'src/renderer/components/DashboardHero.vue'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src/renderer/store.ts'), 'utf8');
const legacyExists = fs.existsSync(path.join(root, 'src/renderer/components/SpeedTestPanel.vue'));

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

console.log('\n=== 节点管家：管理 + 测速合并页 ===');

t('功能导航只保留一个「节点管家」，独立「节点测速」页已下线', () => {
  assert.match(app, /key: 'nodes'[\s\S]{0,80}label: '节点管家'/);
  assert.ok(!/key: 'speedtest'/.test(app), '导航里仍有独立测速页');
  assert.ok(!/label: '节点测速'/.test(app), '导航里仍有旧「节点测速」标签');
  assert.ok(!app.includes('import SpeedTestPanel'), 'App.vue 仍在 import 旧测速面板');
  assert.ok(!/SpeedTestPanel v-else-if/.test(app), 'App.vue 仍在渲染旧测速面板');
  assert.ok(legacyExists, 'SpeedTestPanel.vue 文件被删了，无法回退');
});

t('旧深链接 #speedtest 与仪表盘跳转归一到 nodes，不会点了没反应', () => {
  assert.match(app, /function normalizeTab\(t: string\): TabKey \{[\s\S]{0,160}t === 'speedtest' \? 'nodes'/);
  assert.match(app, /normalizeTab\(location\.hash\.replace\('#', ''\)\)/, '启动时未归一 hash');
  assert.match(app, /activeTab\.value = normalizeTab\(tab\)/, '仪表盘跳转未归一');
  assert.ok(!hero.includes("emit('navigate', 'speedtest')"), '仪表盘「自动选择」仍指向已下线页面');
});

t('一键全检：先 TCP 握手剔除不可达，再只对可达节点跑真连下载（省流量）', () => {
  assert.match(hub, /async function runAll\(\)/, '缺少一键全检');
  assert.match(hub, /await bulkPing\(list\)/, '未先做 TCP 握手');
  assert.match(hub, /const reachable = list\.filter\(n => latencies\.value\[n\.id\]\?\.ms != null\)/, '未按握手结果过滤可达节点');
  assert.match(hub, /await runSpeed\(reachable\)/, '未对可达节点跑真连下载');
  assert.match(hub, /握手全部不可达，已跳过真连下载测速（未消耗流量）/, '全不可达时未跳过流量消耗');
});

t('两档测速都保留：快速握手（不耗流量）与真连下载（真实带宽）', () => {
  assert.match(hub, /function quickPing\(\)/, '缺少快速握手');
  assert.match(hub, /store\.pingNode\(n\)/, '快速握手未走真实 TCP ping');
  assert.match(hub, /store\.startSpeedTest\(list\)/, '真连下载未走主进程测速器');
  assert.match(hub, /store\.cancelSpeedTest\(\)/, '缺少取消测速');
  assert.match(hub, /SPEEDTEST_TARGETS/, '缺少测速目标白名单');
  assert.match(hub, /store\.speedConcurrency/, '缺少并发设置');
});

t('原节点测速页的结果呈现不丢：带宽 / 评级 / 汇总 / 判定标准 / 下载明细', () => {
  for (const kw of ['formatMbps', 'SPEED_GRADE_LABELS', 'SPEED_GRADE_HINTS', 'formatBytes', 'fastest', 'usableCount', 'finishedCount', '判定标准', '本轮实测下载明细']) {
    assert.ok(hub.includes(kw), `合并后丢了「${kw}」`);
  }
  assert.match(hub, /value="speed">按下载速度/, '缺少按下载速度排序');
  assert.match(hub, /ttfbMs/, '详情里丢了首字节时间');
});

t('原节点管理能力不丢：分组 / 搜索 / 地区 / 删除 / 清空 / 详情 / 连接 / 归属地', () => {
  for (const kw of ['grouped', 'filterName', 'regionFilter', 'removeSelected', 'store.clearAll()', 'node-detail', 'store.activateNode(n)', 'store.lookupGeo()', 'rawDecoded', 'displayCode', 'countryLabel']) {
    assert.ok(hub.includes(kw), `合并后丢了「${kw}」`);
  }
  assert.match(hub, /<h3>节点管家<\/h3>/, '页面标题未改为节点管家');
});

t('状态链路未断：真连测速结果仍由主进程经 store 推送进度', () => {
  assert.match(store, /if \(p\.type === 'speedtest' && p\.row\)/, '主进程测速进度监听被删');
  assert.match(store, /speedRows\.value = \{ \.\.\.speedRows\.value, \[row\.id\]: row \}/, '测速结果未写入 store');
  assert.match(hub, /const speedRows = computed\(\(\) => store\.speedRows\)/, '合并页未连到 store 的测速结果');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
