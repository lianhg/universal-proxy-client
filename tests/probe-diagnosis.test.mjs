/**
 * 节点体检 —— 诊断纯逻辑回归测试
 * 运行：node tests/probe-diagnosis.test.mjs
 * 需先执行：npx tsc -p tsconfig.runtime.build.json
 *
 * 覆盖：站点分组、失败原因归类、逐行判定、以及最关键的「综合结论」：
 *   什么情况算节点坏、什么情况只是分流规则、什么情况下数据不足不能下结论。
 * 全部为纯函数，不联网、不启动内核、不产生任何模拟数据。
 */
import assert from 'node:assert/strict';
import * as T from '../.runtime-build/runtime/telemetry.js';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const OK = (via = 'https-proxy') => ({ ok: true, ms: 120, status: 200, failure: null, via });
const BAD = (failure = 'timeout', error = '请求超时') => ({
  ok: false, ms: null, status: 0, failure, error, via: 'none',
});
const row = (host, direct, viaProxy) => ({
  host,
  group: T.probeGroupOf(host),
  direct, viaProxy,
  verdict: T.verdictOf(direct.ok, viaProxy.ok),
  probedAt: 1700000000000,
});
const ctx = (extra = {}) => ({
  proxyRunning: true, kernelRunning: true, proxyPort: 21809,
  kernel: 'xray', nodeName: 'HK-01', ...extra,
});

/** 亮哥截图里的真实形态：境外经代理通、境内只有直连通 */
const screenshotRows = () => [
  row('google.com', BAD('timeout'), OK()),
  row('youtube.com', BAD('timeout'), OK()),
  row('baidu.com', OK('https-direct'), BAD('proxy-reject')),
  row('bilibili.com', OK('https-direct'), BAD('proxy-reject')),
];

console.log('\n── 站点分组与失败分类 ──');

await t('默认检测站点包含 2 个境外 + 2 个境内', () => {
  assert.equal(T.DEFAULT_PROBE_SITES.length, 4);
  assert.deepEqual(T.DEFAULT_PROBE_SITES.map(s => s.host), ['google.com', 'youtube.com', 'baidu.com', 'bilibili.com']);
  assert.equal(T.DEFAULT_PROBE_SITES.filter(s => s.group === 'overseas').length, 2);
});

await t('境外域名判为 overseas', () => {
  assert.equal(T.probeGroupOf('google.com'), 'overseas');
  assert.equal(T.probeGroupOf('www.youtube.com'), 'overseas');
  assert.equal(T.probeGroupOf('example.org'), 'overseas');
});

await t('境内域名 / 子域 / .cn 判为 domestic', () => {
  assert.equal(T.probeGroupOf('baidu.com'), 'domestic');
  assert.equal(T.probeGroupOf('www.bilibili.com'), 'domestic');
  assert.equal(T.probeGroupOf('example.cn'), 'domestic');
  assert.equal(T.probeGroupOf('a.gov.cn'), 'domestic');
});

await t('错误文本归类：拒绝 / 超时 / DNS / TLS', () => {
  assert.equal(T.classifyProbeError('connect ECONNREFUSED 127.0.0.1:21809'), 'refused');
  assert.equal(T.classifyProbeError('直连 google.com:443 超时（4000ms）'), 'timeout');
  assert.equal(T.classifyProbeError('getaddrinfo ENOTFOUND google.com'), 'dns');
  assert.equal(T.classifyProbeError('ERR_TLS_CERT_ALTNAME_INVALID'), 'tls');
});

await t('错误文本归类：代理拒绝 / 连接重置 / 未知', () => {
  assert.equal(T.classifyProbeError('内核拒绝建立 CONNECT 隧道：HTTP 502'), 'proxy-reject');
  assert.equal(T.classifyProbeError('socket hang up / ECONNRESET'), 'empty-reply');
  assert.equal(T.classifyProbeError('发生了点别的'), 'unknown');
  assert.equal(T.classifyProbeError('没有可用信息', 503), 'blocked');
});

await t('verdictOf 覆盖四种组合', () => {
  assert.equal(T.verdictOf(true, true), 'both-ok');
  assert.equal(T.verdictOf(false, true), 'proxy-only');
  assert.equal(T.verdictOf(true, false), 'direct-only');
  assert.equal(T.verdictOf(false, false), 'all-fail');
});

await t('failedAttempt 不伪造耗时与状态码', () => {
  const a = T.failedAttempt('not-running', '内核未运行');
  assert.equal(a.ok, false);
  assert.equal(a.ms, null);
  assert.equal(a.status, 0);
  assert.equal(a.failure, 'not-running');
  assert.equal(a.via, 'none');
});

console.log('\n── 逐行结论文案 ──');

await t('境内站「经节点不通」解释成分流规则，不吓唬人', () => {
  const r = row('baidu.com', OK(), BAD());
  assert.equal(T.describeVerdict(r, true), '直连可达，多为分流规则');
});

await t('境外站「经节点不通」提示需排查', () => {
  const r = row('google.com', OK(), BAD());
  assert.equal(T.describeVerdict(r, true), '经节点不可达，需排查');
});

await t('内核未运行时明确写「内核未运行」', () => {
  const r = row('google.com', OK(), BAD());
  assert.equal(T.describeVerdict(r, false), '内核未运行');
});

console.log('\n── 综合诊断：能不能判定节点好坏 ──');

await t('没有结果时不下结论，nodeOk=null', () => {
  const d = T.diagnoseProbe([], ctx());
  assert.equal(d.level, 'idle');
  assert.equal(d.nodeOk, null);
  assert.equal(d.summary, '—');
});

await t('内核未运行：只测直连，明确说判断不了节点', () => {
  const rows = screenshotRows();
  const d = T.diagnoseProbe(rows, ctx({ proxyRunning: false, kernelRunning: false }));
  assert.equal(d.level, 'idle');
  assert.equal(d.nodeOk, null);
  assert.match(d.title, /内核未运行/);
  assert.match(d.detail, /21809/);
});

await t('内核在跑但代理端口没监听：给「HTTP 入站没起来」而不是「没连接」', () => {
  const d = T.diagnoseProbe(screenshotRows(), ctx({ proxyRunning: false, kernelRunning: true }));
  assert.equal(d.level, 'idle');
  assert.match(d.title, /代理端口没监听/);
  assert.ok(d.advice.some(a => /运行配置/.test(a)));
});

await t('截图场景判定为「节点可用」：境内代不通不是节点故障', () => {
  const d = T.diagnoseProbe(screenshotRows(), ctx());
  assert.equal(d.level, 'good');
  assert.equal(d.nodeOk, true);
  assert.match(d.title, /节点可用/);
  assert.match(d.detail, /不是节点故障/);
  assert.equal(d.summary, '代理可达 2/4 · 直连可达 2/4');
});

await t('全部站点经节点都不通 → 节点不可用（直连正常）', () => {
  const rows = [
    row('google.com', OK('https-direct'), BAD('timeout')),
    row('youtube.com', OK('https-direct'), BAD('timeout')),
    row('baidu.com', OK('https-direct'), BAD('timeout')),
    row('bilibili.com', OK('https-direct'), BAD('timeout')),
  ];
  const d = T.diagnoseProbe(rows, ctx());
  assert.equal(d.level, 'bad');
  assert.equal(d.nodeOk, false);
  assert.match(d.title, /节点不可用/);
  assert.match(d.detail, /本机网络正常/);
  assert.ok(d.advice.some(a => /节点测速|换一个节点/.test(a)));
});

await t('代理端口全拒绝 → 建议重新生成运行配置', () => {
  const rows = ['google.com', 'baidu.com'].map(h => row(h, OK('https-direct'), BAD('refused', 'connect ECONNREFUSED')));
  const d = T.diagnoseProbe(rows, ctx());
  assert.equal(d.level, 'bad');
  assert.ok(d.advice.some(a => /重新生成运行配置/.test(a)));
  assert.match(d.detail, /内核没有正常监听/);
});

await t('DNS 类失败 → 建议检查运行配置里的 DNS', () => {
  const rows = ['google.com', 'youtube.com'].map(h => row(h, OK('https-direct'), BAD('dns')));
  const d = T.diagnoseProbe(rows, ctx());
  assert.ok(d.advice.some(a => /DNS/.test(a)));
});

await t('直连和经节点全不通 → 先查本机网络，nodeOk=null（不甩锅给节点）', () => {
  const rows = ['google.com', 'baidu.com'].map(h => row(h, BAD('timeout'), BAD('timeout')));
  const d = T.diagnoseProbe(rows, ctx());
  assert.equal(d.level, 'bad');
  assert.equal(d.nodeOk, null);
  assert.match(d.title, /本机网络/);
  assert.ok(d.advice.some(a => /系统代理/.test(a)));
});

await t('境外经节点全不通、境内经节点通 → 判定「出不了海」', () => {
  const rows = [
    row('google.com', BAD(), BAD('timeout')),
    row('youtube.com', BAD(), BAD('timeout')),
    row('baidu.com', OK('https-direct'), OK()),
    row('bilibili.com', OK('https-direct'), OK()),
  ];
  const d = T.diagnoseProbe(rows, ctx());
  assert.equal(d.level, 'bad');
  assert.equal(d.nodeOk, false);
  assert.match(d.title, /出不了海/);
  assert.ok(d.advice.some(a => /分流规则/.test(a)));
});

await t('境外只通一半 → 部分可用（warn），不算完全正常', () => {
  const rows = [
    row('google.com', BAD(), OK()),
    row('youtube.com', BAD(), BAD('timeout')),
    row('baidu.com', OK('https-direct'), OK()),
    row('bilibili.com', OK('https-direct'), OK()),
  ];
  const d = T.diagnoseProbe(rows, ctx());
  assert.equal(d.level, 'warn');
  assert.equal(d.nodeOk, true);
  assert.match(d.title, /部分可用/);
});

await t('四个站点全通 → 节点完全正常', () => {
  const rows = ['google.com', 'youtube.com', 'baidu.com', 'bilibili.com'].map(h => row(h, OK('https-direct'), OK()));
  const d = T.diagnoseProbe(rows, ctx());
  assert.equal(d.level, 'good');
  assert.equal(d.nodeOk, true);
  assert.equal(d.summary, '代理可达 4/4 · 直连可达 4/4');
});

await t('诊断标题带上当前节点名，便于定位是哪个节点', () => {
  const d = T.diagnoseProbe(screenshotRows(), ctx({ nodeName: '美国-01' }));
  assert.match(d.title, /美国-01/);
});

await t('每条诊断都有可操作建议，且不会给空数组', () => {
  const cases = [
    [[], ctx()],
    [screenshotRows(), ctx({ proxyRunning: false })],
    [screenshotRows(), ctx()],
    [['google.com', 'youtube.com'].map(h => row(h, OK('https-direct'), BAD())), ctx()],
  ];
  for (const [rows, c] of cases) {
    const d = T.diagnoseProbe(rows, c);
    assert.ok(Array.isArray(d.advice) && d.advice.length > 0);
    assert.ok(d.advice.every(a => typeof a === 'string' && a.length > 4));
  }
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) { for (const [n, e] of failures) console.error('  ✗ ' + n, e); process.exit(1); }
