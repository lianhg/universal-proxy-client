/**
 * 二维码识别出订阅 / 配置地址后的「联网拉取」回归测试
 * 运行：node tests/qr-fetch.test.mjs
 *
 * 亮哥反馈：二维码识别成功了，但预览里「确认导入」是灰的、点不动。
 * 根因：内容是订阅地址时本地根本没有节点（识别节点 0），而按钮的可用条件是
 * nodes.length > 0 && !requiresFetch —— 两个条件全不满足，按钮永远禁用。
 *
 * 这里锁死新行为：
 * 1. 只有地址、没有节点时，按钮必须可点，且文案明确是「联网拉取订阅地址」；
 * 2. 拉取是用户显式动作，拉回来只生成预览，写入节点列表仍需再确认一次；
 * 3. 拉取失败要说清原因，不能假装成功，也不能把地址当成节点导入；
 * 4. 普通「有节点」的报告仍走原来的确认导入语义，不受影响。
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

const view = read('src/renderer/components/ImportReportView.vue');
const qrPanel = read('src/renderer/components/QrScannerPanel.vue');
const linkPanel = read('src/renderer/components/LinkParserPanel.vue');
const api = read('src/renderer/api.ts');
const main = read('src/main.ts');

console.log('\n=== 二维码订阅地址：确认按钮可点 ===');

t('只有地址、没有节点时按钮不再恒禁用（原来是死按钮）', () => {
  assert.match(view, /const needFetch = computed\(\(\) => props\.fetchable === true && !!props\.report\?\.requiresFetch && props\.report\.nodes\.length === 0\)/,
    '没有「需要拉取」的判定，按钮仍会被 nodes.length 卡死');
  assert.match(view, /const primaryEnabled = computed\(\(\) => needFetch\.value \? props\.fetching !== true : canConfirm\.value\)/,
    '按钮可用性没有把「需要拉取」算进去');
  assert.match(view, /:disabled="!primaryEnabled"/, '按钮仍绑在旧条件上');
  assert.ok(!/:disabled="!canConfirm"/.test(view), '旧的禁用条件还留着');
});

t('按钮文案明确是联网拉取，拉取中也说清进度', () => {
  assert.match(view, /联网拉取\{\{ fetchKindLabel \}\}/, '按钮没写清「联网拉取」，用户会以为是立即导入');
  assert.match(view, /fetching \? '正在拉取…'/, '拉取过程中没有进度反馈');
  assert.match(view, /kind === 'config-url' \? '配置地址' : '订阅地址'/, '订阅地址与配置地址没有区分');
});

t('拉取只是取回文本做预览，写入节点列表仍需再确认一次', () => {
  const fn = qrPanel.slice(qrPanel.indexOf('async function onFetch'), qrPanel.indexOf('onUnmounted(() => stop())'));
  assert.match(fn, /await fetchSubscription\(url\)/, '没有走主进程拉取链路');
  assert.match(fn, /await parseConfig\(/, '拉回来的内容没有解析成节点预览');
  assert.match(fn, /report\.value = rep/, '拉取结果没有替换成新的预览');
  assert.ok(!/emit\('add'/.test(fn), '拉取时直接写入了节点列表，绕过了用户确认');
});

t('拉取失败要说清原因，不伪造成功', () => {
  const fn = qrPanel.slice(qrPanel.indexOf('async function onFetch'), qrPanel.indexOf('onUnmounted(() => stop())'));
  assert.match(fn, /if \(!r\.ok\) \{[\s\S]{0,160}拉取失败：/, '拉取失败没有提示原因');
  assert.match(fn, /没有解析出节点/, '拉回空内容时当成成功，用户会以为订阅没问题');
  assert.match(fn, /finally \{\s*fetching\.value = false/, '拉取状态没有复位，按钮会一直卡在「正在拉取」');
});

t('二维码面板与配置导入面板都接上了拉取能力', () => {
  assert.match(qrPanel, /fetchable :fetching="fetching"/, '二维码面板没有启用拉取按钮');
  assert.match(qrPanel, /@fetch="onFetch"/, '二维码面板没有监听拉取事件');
  assert.match(linkPanel, /fetchable :fetching="busy"/, '配置导入面板没有启用拉取按钮');
  assert.match(linkPanel, /@fetch="pullSubscription"/, '配置导入面板没有监听拉取事件');
  // 事件会带 url 参数，按钮点击不带参数，必须显式空调用，否则会把 MouseEvent 当地址
  assert.match(linkPanel, /@click="pullSubscription\(\)"/, '按钮点击会传入事件对象，被当订阅地址使用');
});

t('拉取仍由用户触发：主进程接口只在 IPC 里，不自动请求', () => {
  assert.match(main, /ipcMain\.handle\('fetch-subscription'/, '主进程订阅拉取入口缺失');
  assert.match(api, /export async function fetchSubscription/);
  // 解析阶段只返回 requiresFetch，不自行请求
  assert.ok(!/fetch\(report\.requiresFetch\.url\)/.test(qrPanel), '面板在解析阶段就自动请求了地址');
  assert.match(view, /需要你确认后才会联网拉取/, '安全提示被删掉了');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.message ?? e}`);
  process.exit(1);
}
