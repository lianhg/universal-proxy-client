/**
 * 实时遥测 —— 纯逻辑回归测试
 * 运行：node tests/telemetry.test.mjs
 * 需先执行：npx tsc -p tsconfig.runtime.build.json
 *
 * 覆盖：Clash API 归一化、出站判定、累计字节差分算速率、计数器回退、历史序列、
 *       聚合排行、内核能力判定、绝不产生模拟数据。
 */
import assert from 'node:assert/strict';
import * as T from '../.runtime-build/runtime/telemetry.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const RAW = {
  downloadTotal: 12_000_000,
  uploadTotal: 3_000_000,
  memory: 45678,
  connections: [
    {
      id: 'c1', upload: 1200, download: 98000, start: '2026-11-10T10:20:01.123456789+08:00',
      chains: ['香港-01', 'DIRECT'], rule: 'DOMAIN-SUFFIX', rulePayload: 'google.com',
      metadata: {
        network: 'tcp', type: 'HTTP', sourceIP: '127.0.0.1', sourcePort: 51234,
        destinationIP: '203.0.113.1', destinationPort: 443,
        host: 'www.google.com', process: 'chrome.exe', processPath: 'C:\\chrome.exe',
      },
    },
    {
      id: 'c2', upload: 800, download: 400, chains: ['DIRECT'], rule: 'IP-CIDR', rulePayload: '192.168.1.0/24',
      metadata: { network: 'udp', type: 'TUN', host: 'baidu.com', process: 'wechat.exe', destinationPort: 53 },
    },
    { id: 'c3', upload: 10, download: 20, chains: [], rule: 'MATCH', rulePayload: '' },
  ],
};

console.log('\n── 内核能力判定 ──');
t('Xray 支持 StatsService gRPC 统计，并说明连接能力限制', () => {
  const c = T.kernelTelemetryCapability('xray');
  assert.equal(c.supported, true);
  assert.match(c.reason, /StatsService/);
});
t('Mihomo / sing-box 支持 clash_api', () => {
  assert.equal(T.kernelTelemetryCapability('mihomo').supported, true);
  assert.equal(T.kernelTelemetryCapability('sing-box').supported, true);
});
t('空快照不含任何模拟速率 / 连接', () => {
  const s = T.emptyTelemetry('xray');
  assert.equal(s.upSpeed, 0);
  assert.equal(s.downSpeed, 0);
  assert.equal(s.activeConnections, 0);
  assert.equal(s.connections.length, 0);
  assert.equal(s.uploadTotal, 0);
});

console.log('\n── /connections 归一化 ──');
t('累计字节、内存、连接数组完整解析', () => {
  const p = T.parseClashConnections(RAW);
  assert.equal(p.downloadTotal, 12_000_000);
  assert.equal(p.uploadTotal, 3_000_000);
  assert.equal(p.memory, 45678);
  assert.equal(p.connections.length, 3);
});
t('metadata 字段映射到统一连接模型', () => {
  const c = T.parseClashConnections(RAW).connections[0];
  assert.equal(c.id, 'c1');
  assert.equal(c.host, 'www.google.com');
  assert.equal(c.process, 'chrome.exe');
  assert.equal(c.destinationPort, 443);
  assert.equal(c.network, 'tcp');
  assert.equal(c.upload, 1200);
  assert.ok(c.startedAt > 0, 'RFC3339 时间应转成时间戳');
});
t('缺少 connections 数组时抛明确错误，不返回半成品', () => {
  assert.throws(() => T.parseClashConnections({ downloadTotal: 1 }), /connections/);
  assert.throws(() => T.parseClashConnections(null), /JSON 对象/);
});
t('出站方向判定：代理 / 直连 / 阻断 / 未知', () => {
  assert.equal(T.classifyOutbound(['香港-01'], 'MATCH', ''), 'proxy');
  assert.equal(T.classifyOutbound(['DIRECT'], 'IP-CIDR', '192.168.0.0/16'), 'direct');
  assert.equal(T.classifyOutbound(['REJECT'], 'RULE-SET', 'ads'), 'reject');
  assert.equal(T.classifyOutbound([], '', ''), 'unknown');
});

console.log('\n── 速率差分与历史 ──');
t('正常采样：由累计字节差 / 时间差算 B/s', () => {
  const r = T.computeSpeed({ uploadTotal: 1000, downloadTotal: 2000, ts: 10_000 },
    { uploadTotal: 3000, downloadTotal: 6000 }, 12_000);
  assert.equal(r.upSpeed, 1000);
  assert.equal(r.downSpeed, 2000);
  assert.equal(r.reset, false);
});
t('首帧没有速率，不凭空生成数字', () => {
  const r = T.computeSpeed(null, { uploadTotal: 9999, downloadTotal: 9999 }, 10_000);
  assert.equal(r.upSpeed, 0);
  assert.equal(r.downSpeed, 0);
});
t('采样间隔过长不输出失真尖峰', () => {
  const r = T.computeSpeed({ uploadTotal: 0, downloadTotal: 0, ts: 0 },
    { uploadTotal: 100_000_000, downloadTotal: 100_000_000 }, 60_000);
  assert.equal(r.upSpeed, 0);
  assert.equal(r.downSpeed, 0);
});
t('累计量回退（内核重启）标记 reset 且速率归零', () => {
  const r = T.computeSpeed({ uploadTotal: 9000, downloadTotal: 9000, ts: 10_000 },
    { uploadTotal: 100, downloadTotal: 100 }, 11_000);
  assert.equal(r.reset, true);
  assert.equal(r.upSpeed, 0);
  assert.equal(r.downSpeed, 0);
});
t('applySample 累积历史并清空 reset 前的旧曲线', () => {
  let s = T.emptyTelemetry('mihomo');
  const p = () => T.parseClashConnections(RAW);
  s = T.applySample(s, p(), 1000);
  assert.equal(s.state, 'active');
  assert.equal(s.history.length, 1);
  s = T.applySample(s, { ...p(), uploadTotal: 3_001_000, downloadTotal: 12_010_000 }, 2000);
  assert.equal(s.activeConnections, 3);
  assert.equal(s.history.length, 2);
  const reset = T.applySample(s, { ...p(), uploadTotal: 0, downloadTotal: 0 }, 3000);
  assert.equal(reset.reset, true);
  assert.equal(reset.history.length, 1);
});
t('历史序列最多保留 MAX_HISTORY 个点', () => {
  let h = [];
  for (let i = 0; i < 200; i++) h = T.pushHistory(h, { ts: i, up: i, down: i }, T.MAX_HISTORY);
  assert.equal(h.length, T.MAX_HISTORY);
  assert.equal(h.at(-1).ts, 199);
});

console.log('\n── 聚合 / 格式化 ──');
t('按进程聚合按总 bytes 降序', () => {
  const cs = T.parseClashConnections(RAW).connections;
  const rows = T.aggregateConnections(cs, 'process', 5);
  assert.equal(rows[0].key, 'chrome.exe');
  assert.equal(rows[0].total, 99200);
});
t('走向占比统计', () => {
  const r = T.outboundRatio(T.parseClashConnections(RAW).connections);
  assert.equal(r.total, 3);
  assert.equal(r.direct, 2);
  assert.ok(r.proxy + r.direct + r.reject + r.unknown === 3);
});
t('字节 / 速率格式化', () => {
  assert.equal(T.formatBytes(0), '0 B');
  assert.equal(T.formatBytes(1024), '1.0 KB');
  assert.equal(T.formatBytes(1024 * 1024 * 3.5), '3.5 MB');
  assert.equal(T.formatSpeed(2048), '2.0 KB/s');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) { for (const [n, e] of failures) console.error('  ✗ ' + n, e); process.exit(1); }
