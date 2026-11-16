/**
 * 遥测采集器 —— 端到端回归测试（本地假 clash_api，不访问外网、不启动内核）
 *
 * 验证主进程侧真的能从 HTTP 接口取数、算速率、关连接、在接口异常时降级，
 * 以及 Xray 明确不支持时不发任何请求。
 * 运行：node tests/telemetry-collector.test.mjs（需先 npx tsc -p tsconfig.main.build.json）
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import { TelemetryCollector } from '../.main-build/main/runtime/telemetry.js';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const state = { up: 10_000, down: 20_000, mode: 'ok', deleted: [], requests: [] };
const CONNS = [
  {
    id: 'c1', upload: 100, download: 900, chains: ['HK-01'], rule: 'DOMAIN-SUFFIX', rulePayload: 'google.com',
    metadata: { network: 'tcp', type: 'HTTP', host: 'www.google.com', process: 'chrome.exe', destinationPort: 443 },
  },
  { id: 'c2', upload: 50, download: 60, chains: ['DIRECT'], rule: 'IP-CIDR', rulePayload: '10.0.0.0/8', metadata: { host: 'nas.local' } },
];

const server = http.createServer((req, res) => {
  state.requests.push(`${req.method} ${req.url}`);
  if (req.url === '/connections' && req.method === 'GET') {
    if (state.mode === '404') { res.writeHead(404); res.end('nope'); return; }
    if (state.mode === 'badjson') { res.writeHead(200); res.end('<html>not json</html>'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uploadTotal: state.up, downloadTotal: state.down, memory: 45678, connections: CONNS,
    }));
    return;
  }
  if (req.url === '/version') { res.writeHead(200); res.end(JSON.stringify({ version: 'v1.18.2' })); return; }
  if (req.url?.startsWith('/connections/') && req.method === 'DELETE') {
    state.deleted.push(req.url);
    res.writeHead(204); res.end(); return;
  }
  res.writeHead(404); res.end();
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const events = [];
const collector = new TelemetryCollector({
  send: (ch, payload) => events.push({ ch, payload }),
  getHttpPort: () => 10809,
});
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n── 采集器端到端 ──');

await t('启动后立即采样到真实连接与内核版本', async () => {
  collector.start('mihomo', port, '127.0.0.1');
  await wait(160);
  const s = collector.getSnapshot();
  assert.equal(s.state, 'active', '应成功进入 active');
  assert.equal(s.activeConnections, 2);
  assert.equal(s.uploadTotal, 10_000);
  assert.equal(s.downloadTotal, 20_000);
  assert.equal(s.memory, 45678);
  assert.equal(s.kernelVersion, 'v1.18.2');
  assert.equal(s.connections[0].host, 'www.google.com');
  assert.equal(s.connections[0].outbound, 'proxy');
  assert.equal(s.connections[1].outbound, 'direct');
  assert.equal(s.upSpeed, 0, '首帧没有上一帧可差分，速率必须是 0');
});

await t('第二次采样由累计字节差算出真实速率', async () => {
  state.up += 2000;
  state.down += 4000;
  await wait(20);
  const s = await collector.pollOnce();
  assert.equal(s.uploadTotal, 12_000);
  assert.equal(s.downloadTotal, 24_000);
  assert.ok(s.upSpeed > 0 && s.downSpeed > 0, `速率应大于 0，实际 ${s.upSpeed}/${s.downSpeed}`);
  assert.equal(s.history.length, 2);
});

await t('关闭单条连接会发 DELETE 并更新本地快照', async () => {
  const r = await collector.closeConnection('c1');
  assert.equal(r.ok, true);
  assert.ok(state.deleted.some(d => d.includes('c1')));
  assert.equal(collector.getSnapshot().activeConnections, 1);
});

await t('非法连接 ID 被拒绝，不会拼进 URL', async () => {
  const r = await collector.closeConnection('../etc/passwd');
  assert.equal(r.ok, false);
  assert.match(r.error, /不合法/);
});

await t('接口 404 时速率归零、保留历史并给出具体原因', async () => {
  const before = collector.getSnapshot().history.length;
  state.mode = '404';
  const s = await collector.pollOnce();
  assert.equal(s.state, 'unavailable');
  assert.equal(s.upSpeed, 0);
  assert.equal(s.downSpeed, 0);
  assert.equal(s.history.length, before, '历史不应因一次失败被清空');
  assert.match(s.error, /未提供 \/connections 接口/);
  assert.equal(s.supported, true, '能力仍支持，只是本次采样失败');
});

await t('非 JSON 响应明确报错，不误报成功', async () => {
  state.mode = 'badjson';
  const s = await collector.pollOnce();
  assert.match(s.error, /不是合法 JSON/);
  assert.equal(s.state, 'unavailable');
});

await t('接口恢复后重新进入 active', async () => {
  state.mode = 'ok';
  const s = await collector.pollOnce();
  assert.equal(s.state, 'active');
  assert.equal(s.error, null);
  assert.equal(s.activeConnections, 2);
});

await t('Xray 不轮询 clash_api（HTTP 请求数不变），尝试 gRPC 失败时报明确错误', async () => {
  const before = state.requests.length;
  collector.start('xray', port, '127.0.0.1');
  await wait(80);
  const s = collector.getSnapshot();
  assert.equal(s.supported, true, 'Xray 已支持 StatsService 统计');
  assert.equal(state.requests.length, before, 'Xray 不应轮询 clash_api 的 HTTP 接口');
  // 假服务器只会 HTTP/1，gRPC(HTTP/2) 必然失败 → 速率归零并给出可读错误
  assert.match(s.error ?? '', /QueryStats|gRPC/);
  collector.stop(true);
});

/* ── Xray gRPC 统计链路：本进程内起一个假 StatsService（HTTP/2）真验采样 ── */
const grpcState = { up: 1500, down: 900_000 };
const grpcServer = http2.createServer();
grpcServer.on('stream', (stream, headers) => {
  if (headers[':path'] !== '/xray.app.stats.command.StatsService/QueryStats') {
    stream.respond({ ':status': 404 }); stream.end(); return;
  }
  stream.on('data', () => {}); // 消费请求体（5 字节空 gRPC 帧），否则流停在暂停态收不到 end
  // 请求体是 5 字节空帧；响应 StatResponse { repeated Stat stat = 1 }
  const stat = (name, value) => {
    const nb = Buffer.from(name);
    const vb = [];
    let v = BigInt(value);
    do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; vb.push(b); } while (v > 0n);
    // Stat 消息 = [0x0a, nameLen] + name + [0x10] + varint → 长度 = 2 + nameLen + vbLen
    return Buffer.concat([Buffer.from([0x0a, nb.length + vb.length + 3, 0x0a, nb.length]), nb, Buffer.from([0x10]), Buffer.from(vb)]);
  };
  const body = Buffer.concat([
    stat('inbound>>>socks-in>>>traffic>>>uplink', grpcState.up),
    stat('inbound>>>socks-in>>>traffic>>>downlink', grpcState.down),
    stat('inbound>>>api-in>>>traffic>>>downlink', 123_456), // 轮询自身流量，必须被剔除
  ]);
  const frame = Buffer.alloc(5 + body.length);
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' });
  stream.write(frame);
  stream.end();
});
await new Promise(r => grpcServer.listen(0, '127.0.0.1', r));
const grpcPort = grpcServer.address().port;

await t('Xray gRPC 采样：累计值来自计数器且 api-in 被剔除', async () => {
  collector.start('xray', grpcPort, '127.0.0.1');
  await wait(160);
  const s = collector.getSnapshot();
  assert.equal(s.state, 'active', '应成功进入 active');
  assert.equal(s.uploadTotal, 1500);
  assert.equal(s.downloadTotal, 900_000, 'api-in 的 123456 不允许计入');
  assert.match(s.reason, /StatsService/);
});

await t('Xray 第二次采样差分出真实速率', async () => {
  grpcState.up += 1000; grpcState.down += 5000;
  await wait(20);
  const s = await collector.pollOnce();
  assert.equal(s.uploadTotal, 2500);
  assert.equal(s.downloadTotal, 905_000);
  assert.ok(s.upSpeed > 0 && s.downSpeed > 0, `速率应大于 0，实际 ${s.upSpeed}/${s.downSpeed}`);
});

await t('Xray 不支持按连接关闭（无连接列表）', async () => {
  const r = await collector.closeConnection('c1');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Xray/);
});
grpcServer.close();

await t('停止采集后清空连接与速率，只留原因', () => {
  collector.stop(false, '测试结束');
  const s = collector.getSnapshot();
  assert.equal(s.state, 'idle');
  assert.equal(s.activeConnections, 0);
  assert.equal(s.upSpeed, 0);
  assert.equal(s.connections.length, 0);
  assert.ok(events.some(e => e.payload?.type === 'telemetry'));
});

await t('站点探测过滤非法域名，不发起真实外网请求', async () => {
  const report = await collector.probeSites(['bad host!', '', 'LEGIT.example.com;rm']);
  assert.equal(report.results.length, 0);
  assert.equal(report.diagnosis.level, 'idle');
  assert.equal(report.diagnosis.nodeOk, null);
});

collector.stop(true);
await new Promise(r => server.close(r));

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) { for (const [n, e] of failures) console.error('  ✗ ' + n, e); process.exit(1); }
