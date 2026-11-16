/**
 * 网络连接监控 —— 状态归一化回归测试
 * 运行：node tests/monitor-status.test.mjs
 * 需先执行：npx tsc -p tsconfig.runtime.build.json
 *
 * 覆盖：连接 / 采样 / 数据源 / 节点体检四组状态，Xray「有速率但没有连接列表」的
 * 准确表述、采样异常与未连接空态、以及「绝不把没数据写成通」的红线。
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

const NOW = 1_770_000_000_000;
const base = (over = {}) => ({
  connected: false,
  runtimeState: 'idle',
  kernel: null,
  telemetry: T.emptyTelemetry(),
  now: NOW,
  ...over,
});
const sampling = (kernel, over = {}) => ({
  ...T.emptyTelemetry(kernel),
  state: 'active', supported: true, ts: NOW - 3000,
  upSpeed: 2048, downSpeed: 8192,
  uploadTotal: 100_000, downloadTotal: 2_000_000,
  ...over,
});
const diag = level => ({ level, title: '节点可用：能访问境外站点', detail: '境外 2/2 经节点可达', advice: ['保持'], nodeOk: true, summary: '2/4' });

/* ─── 相对采样时刻 ─── */
await t('采样时刻：刚刚 / 秒 / 分钟 / 小时 / 天', () => {
  assert.equal(T.formatSampledAgo(NOW, NOW), '刚刚');
  assert.equal(T.formatSampledAgo(NOW - 1_000, NOW), '刚刚');
  assert.equal(T.formatSampledAgo(NOW - 3_000, NOW), '3 秒前');
  assert.equal(T.formatSampledAgo(NOW - 125_000, NOW), '2 分钟前');
  assert.equal(T.formatSampledAgo(NOW - 7_200_000, NOW), '2 小时前');
  assert.equal(T.formatSampledAgo(NOW - 172_800_000, NOW), '2 天前');
});
await t('采样时刻：没有真实采样 / 时间倒挂一律返回 —，不编时间', () => {
  assert.equal(T.formatSampledAgo(0, NOW), '—');
  assert.equal(T.formatSampledAgo(NOW, 0), '—');
  assert.equal(T.formatSampledAgo(NOW + 5_000, NOW), '—');
});

/* ─── 未连接 ─── */
await t('未连接：四组状态都不是「通」，采样时刻为 —', () => {
  const s = T.describeMonitorStatus(base());
  assert.deepEqual(
    [s.connection.level, s.sampling.level, s.source.level, s.nodeCheck.level],
    ['idle', 'idle', 'idle', 'idle'],
  );
  assert.equal(s.connection.label, '未连接');
  assert.equal(s.sampling.label, '未采样');
  assert.equal(s.nodeCheck.label, '未检测');
  assert.equal(s.sampledAgo, '—');
  assert.equal(s.connectionList, false);
});
await t('未连接：空态写明原因与可操作建议，不显示模拟数据', () => {
  const s = T.describeMonitorStatus(base());
  assert.match(s.emptyTitle, /内核未运行/);
  assert.match(s.emptyDetail, /不会出现模拟数据/);
  assert.ok(s.advice.length >= 2 && s.advice.some(a => a.includes('开始连接')));
});
await t('断开后 kernel 字段仍在，但采样状态必须是未采样', () => {
  const s = T.describeMonitorStatus(base({ kernel: 'xray', telemetry: sampling('xray') }));
  assert.equal(s.sampling.level, 'idle');
  assert.equal(s.sampledAgo, '—');
  assert.ok(!s.sampling.detail.includes('通'));
});

/* ─── Xray：速率可用、连接列表不可用 ─── */
await t('Xray 采样中：连接 / 采样为绿，数据源明确写 gRPC', () => {
  const s = T.describeMonitorStatus(base({
    connected: true, runtimeState: 'running', kernel: 'xray',
    nodeName: '香港 01', listenPort: 21809, telemetry: sampling('xray'),
  }));
  assert.equal(s.connection.level, 'good');
  assert.equal(s.sampling.level, 'good');
  assert.equal(s.sampling.label, '实时采样中');
  assert.equal(s.source.label, 'gRPC 速率统计');
  assert.match(s.source.detail, /StatsService gRPC/);
  assert.equal(s.sampledAgo, '3 秒前');
  assert.match(s.connection.detail, /香港 01/);
  assert.match(s.connection.detail, /21809/);
});
await t('Xray 空表必须说「不提供逐条连接列表」，不能说节点坏了', () => {
  const s = T.describeMonitorStatus(base({
    connected: true, runtimeState: 'running', kernel: 'xray', telemetry: sampling('xray'),
  }));
  assert.equal(s.connectionList, false);
  assert.match(s.emptyTitle, /不提供逐条连接列表/);
  assert.match(s.emptyDetail, /这不是节点故障/);
  assert.match(s.emptyDetail, /StatsService gRPC/);
  assert.ok(!s.emptyDetail.includes('节点坏了'));
  assert.ok(s.advice.some(a => a.includes('sing-box')));
});
await t('Xray 等待首次返回时也不误报「没有活跃连接」', () => {
  const s = T.describeMonitorStatus(base({
    connected: true, runtimeState: 'running', kernel: 'xray',
    telemetry: { ...T.emptyTelemetry('xray'), reason: '正在连接 Xray StatsService gRPC…' },
  }));
  assert.equal(s.sampling.level, 'warn');
  assert.equal(s.sampling.label, '等待首次采样');
  assert.match(s.emptyTitle, /等待统计接口首次返回/);
  assert.match(s.emptyDetail, /正在连接/);
});

/* ─── sing-box / Mihomo ─── */
await t('Mihomo 采样中：数据源标 clash_api 全量，支持连接列表', () => {
  const s = T.describeMonitorStatus(base({
    connected: true, runtimeState: 'running', kernel: 'mihomo', telemetry: sampling('mihomo'),
  }));
  assert.equal(s.source.label, 'clash_api 全量');
  assert.equal(s.connectionList, true);
  assert.match(s.source.detail, /\/connections/);
});
await t('sing-box 采样正常但没连接：空态写「当前没有活跃连接」', () => {
  const s = T.describeMonitorStatus(base({
    connected: true, runtimeState: 'running', kernel: 'sing-box', telemetry: sampling('sing-box'),
  }));
  assert.match(s.emptyTitle, /没有活跃连接/);
  assert.ok(s.advice.some(a => a.includes('全部应用') || a.includes('筛选')));
});
await t('有连接数据时活跃连接数仍来自内核，不凭空补数', () => {
  const conn = {
    id: 'c1', network: 'tcp', inbound: 'HTTP', process: 'chrome.exe', processPath: '',
    host: 'example.com', destinationIp: '', destinationPort: 443, sourceIp: '', sourcePort: 0,
    chains: ['节点A'], rule: 'DOMAIN', rulePayload: 'example.com', outbound: 'proxy',
    upload: 100, download: 200, startedAt: NOW - 10_000,
  };
  const s = T.describeMonitorStatus(base({
    connected: true, runtimeState: 'running', kernel: 'mihomo',
    telemetry: sampling('mihomo', { connections: [conn], activeConnections: 1 }),
  }));
  assert.equal(s.connectionList, true);
  assert.equal(s.sampling.level, 'good');
  assert.ok(!s.emptyDetail.includes('节点故障'));
});

/* ─── 异常态 ─── */
await t('采样异常：状态为红，空态原样带出错误而不吞掉', () => {
  const err = 'clash_api /connections 请求超时（1500ms）';
  const s = T.describeMonitorStatus(base({
    connected: true, runtimeState: 'running', kernel: 'mihomo',
    telemetry: sampling('mihomo', { error: err, state: 'unavailable' }),
  }));
  assert.equal(s.sampling.level, 'bad');
  assert.equal(s.sampling.label, '采样异常');
  assert.match(s.sampling.detail, /请求超时/);
  assert.match(s.emptyTitle, /采样失败/);
  assert.equal(s.emptyDetail, err);
  assert.equal(s.sampledAgo, '—');
});
await t('连接失败：状态为红并带出内核报错', () => {
  const s = T.describeMonitorStatus(base({
    runtimeState: 'error', runtimeMessage: '端口 21809 被占用', kernel: 'xray',
  }));
  assert.equal(s.connection.level, 'bad');
  assert.equal(s.connection.label, '连接失败');
  assert.match(s.connection.detail, /端口 21809 被占用/);
  assert.match(s.emptyTitle, /连接失败/);
});
await t('连接中 / 断开中：状态为黄而不是误报已连接', () => {
  for (const [state, label] of [['starting', '连接中…'], ['stopping', '断开中…']]) {
    const s = T.describeMonitorStatus(base({ runtimeState: state, kernel: 'xray' }));
    assert.equal(s.connection.level, 'warn');
    assert.equal(s.connection.label, label);
  }
});
await t('统计接口不支持的兜底：空态如实写出 reason', () => {
  const s = T.describeMonitorStatus(base({
    connected: true, runtimeState: 'running', kernel: 'mihomo',
    telemetry: { ...T.emptyTelemetry('mihomo'), supported: false, reason: '内核版本过旧，未提供 /connections' },
  }));
  assert.equal(s.source.level, 'warn');
  assert.match(s.emptyTitle, /不提供统计接口/);
  assert.match(s.emptyDetail, /版本过旧/);
});

/* ─── 节点体检状态 ─── */
await t('节点体检：四个等级映射成四个明确短标签', () => {
  const expect = { good: '节点可用', warn: '部分可用', bad: '节点异常', idle: '判断不了' };
  for (const [level, label] of Object.entries(expect)) {
    const s = T.describeMonitorStatus(base({ diagnosis: diag(level) }));
    assert.equal(s.nodeCheck.level, level);
    assert.equal(s.nodeCheck.label, label);
    assert.match(s.nodeCheck.detail, /节点可用：能访问境外站点/);
  }
});
await t('没做过检测：节点状态就是「未检测」，不猜节点好坏', () => {
  const s = T.describeMonitorStatus(base({
    connected: true, runtimeState: 'running', kernel: 'xray', telemetry: sampling('xray'),
  }));
  assert.equal(s.nodeCheck.label, '未检测');
  assert.match(s.nodeCheck.detail, /还没检验过/);
  assert.ok(!s.nodeCheck.detail.includes('可用'));
});
await t('每条空态都有非空建议，且四个状态项都有标签与说明', () => {
  const cases = [
    base(),
    base({ connected: true, runtimeState: 'running', kernel: 'xray', telemetry: sampling('xray') }),
    base({ connected: true, runtimeState: 'running', kernel: 'mihomo', telemetry: sampling('mihomo') }),
    base({ connected: true, runtimeState: 'running', kernel: 'mihomo', telemetry: sampling('mihomo', { error: 'boom', state: 'unavailable' }) }),
    base({ runtimeState: 'error', kernel: 'xray' }),
  ];
  for (const c of cases) {
    const s = T.describeMonitorStatus(c);
    assert.ok(s.advice.length > 0 && s.advice.every(a => typeof a === 'string' && a.length > 3));
    for (const item of [s.connection, s.sampling, s.source, s.nodeCheck]) {
      assert.ok(item.label.length > 1);
      assert.ok(item.detail.length > 4);
      assert.ok(['good', 'warn', 'bad', 'idle'].includes(item.level));
    }
  }
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) { for (const [n, e] of failures) console.error('  ✗ ' + n, e); process.exit(1); }
