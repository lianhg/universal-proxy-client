/**
 * 节点体检 —— 真实可达性探测回归测试（本机假站 + 假 CONNECT 代理，不访问外网）
 * 运行：node tests/probe-reachability.test.mjs
 * 需先执行：npx tsc -p tsconfig.main.build.json
 *
 * 验证「通 / 不通」到底怎么判：
 *   - 拿到任意 HTTP 响应头（含 403）就算链路通，并记录状态码
 *   - 端口没人听 / 超时 / 代理 502 拒绝 / 连接被重置，都要给出可解释的失败类别
 *   - 内核没运行或端口没监听时，绝不假装发过「经节点」请求
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { TelemetryCollector, probeReachability, defaultProbeHosts } from '../.main-build/main/runtime/telemetry.js';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

/** 假目标站：/ok=200、/forbidden=403、/slow=拖到超时 */
function startOrigin() {
  const srv = http.createServer((req, res) => {
    if (req.url?.startsWith('/forbidden')) { res.writeHead(403); res.end('no'); return; }
    if (req.url?.startsWith('/slow')) { return; } // 不回包，等客户端超时
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello');
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/** 假 HTTP 代理：CONNECT 隧道连到真实目标；mode='502' 拒绝隧道 */
function startProxy(mode = 'ok') {
  const srv = http.createServer((_req, res) => { res.writeHead(400); res.end(); });
  srv.on('connect', (req, clientSocket, head) => {
    if (mode === '502') {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      clientSocket.end();
      return;
    }
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const origin = await startOrigin();
const originPort = origin.address().port;
const proxyOk = await startProxy('ok');
const proxyBad = await startProxy('502');
const proxyPort = proxyOk.address().port;
const proxyBadPort = proxyBad.address().port;
const deadPort = 1; // 几乎不可能有服务监听

console.log('\n── 直连探测 ──');

await t('直连拿到 200：ok=true，记录状态码与耗时', async () => {
  const r = await probeReachability({ host: '127.0.0.1', port: originPort, useTls: false, path: '/ok' });
  assert.equal(r.ok, true, `不应失败：${r.error}`);
  assert.equal(r.status, 200);
  assert.equal(r.failure, null);
  assert.equal(r.via, 'http-direct');
  assert.ok(typeof r.ms === 'number' && r.ms >= 0);
});

await t('直连拿到 403 也算链路通，但记下状态码和提示', async () => {
  const r = await probeReachability({ host: '127.0.0.1', port: originPort, useTls: false, path: '/forbidden' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 403);
  assert.match(r.error ?? '', /HTTP 403/);
});

await t('直连端口没人监听：判不通且归类 refused', async () => {
  const r = await probeReachability({ host: '127.0.0.1', port: deadPort, useTls: false, timeoutMs: 1200 });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'refused', `实际 ${r.failure} / ${r.error}`);
  assert.equal(r.ms, null);
  assert.ok((r.error ?? '').length > 4);
});

await t('直连一直不回包：判不通且归类 timeout', async () => {
  const r = await probeReachability({ host: '127.0.0.1', port: originPort, useTls: false, path: '/slow', timeoutMs: 350 });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'timeout', `实际 ${r.failure} / ${r.error}`);
});

console.log('\n── 经本地代理（CONNECT 隧道）探测 ──');

await t('经代理拿到 200：ok=true，通道标为 http-proxy', async () => {
  const r = await probeReachability({
    host: '127.0.0.1', port: originPort, useTls: false, path: '/ok',
    proxyPort, timeoutMs: 2000,
  });
  assert.equal(r.ok, true, `不应失败：${r.error}`);
  assert.equal(r.status, 200);
  assert.equal(r.via, 'http-proxy');
});

await t('经代理拿到 403：仍算通，状态码如实保留', async () => {
  const r = await probeReachability({
    host: '127.0.0.1', port: originPort, useTls: false, path: '/forbidden',
    proxyPort, timeoutMs: 2000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 403);
});

await t('内核拒绝 CONNECT（502）：判不通且归类 proxy-reject', async () => {
  const r = await probeReachability({
    host: '127.0.0.1', port: originPort, useTls: false,
    proxyPort: proxyBadPort, timeoutMs: 2000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'proxy-reject', `实际 ${r.failure} / ${r.error}`);
  assert.match(r.error ?? '', /502/);
});

await t('代理端口压根没人监听：判不通且归类 refused', async () => {
  const r = await probeReachability({
    host: '127.0.0.1', port: originPort, useTls: false,
    proxyPort: deadPort, timeoutMs: 1200,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'refused', `实际 ${r.failure} / ${r.error}`);
});

await t('CONNECT 成功但目标不存在：判不通，且给出可读错误', async () => {
  const r = await probeReachability({
    host: '127.0.0.1', port: deadPort, useTls: false,
    proxyPort, timeoutMs: 1200,
  });
  assert.equal(r.ok, false);
  assert.ok(['empty-reply', 'unknown', 'refused', 'timeout'].includes(r.failure), `实际 ${r.failure}`);
  assert.ok((r.error ?? '').length > 4);
});

console.log('\n── 采集器级：报告结构与「不假装测过」 ──');

const collector = new TelemetryCollector({ send: () => {}, getHttpPort: () => proxyPort });

await t('默认站点列表与主进程共用同一份定义', () => {
  assert.deepEqual(defaultProbeHosts(), ['google.com', 'youtube.com', 'baidu.com', 'bilibili.com']);
});

await t('非法域名被过滤，不发任何请求，结论明确为未检测', async () => {
  const r = await collector.probeSites(['bad host!', '', 'LEGIT.example.com;rm']);
  assert.equal(r.results.length, 0);
  assert.equal(r.diagnosis.level, 'idle');
  assert.equal(r.diagnosis.nodeOk, null);
  assert.equal(r.diagnosis.summary, '—');
});

await t('内核未运行：经节点一律标 not-running，不发假请求', async () => {
  const r = await collector.probeSites(['127.0.0.1']);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].viaProxy.failure, 'not-running');
  assert.equal(r.results[0].viaProxy.ok, false);
  assert.equal(r.proxyRunning, false);
  assert.match(r.diagnosis.title, /内核未运行/);
  assert.match(r.results[0].viaProxy.error ?? '', /内核未运行/);
});

await t('报告带齐端口 / 节点 / 时间，供界面显示检测时刻', async () => {
  const c2 = new TelemetryCollector({
    send: () => {},
    getHttpPort: () => proxyPort,
    getRuntimeState: () => ({ running: true, kernel: 'mihomo', nodeName: 'HK-01' }),
  });
  const r = await c2.probeSites(['127.0.0.1']);
  assert.equal(r.proxyPort, proxyPort);
  assert.equal(r.kernel, 'mihomo');
  assert.equal(r.nodeName, 'HK-01');
  assert.equal(typeof r.checkedAt, 'number');
  assert.ok(r.diagnosis.advice.length > 0);
  assert.equal(r.results[0].group, 'overseas');
});

await t('重复域名去重，不会同一个站测两遍', async () => {
  const r = await collector.probeSites(['127.0.0.1', '127.0.0.1', 'HTTP://127.0.0.1/foo']);
  assert.equal(r.results.length, 1);
});

collector.stop(true);
for (const srv of [origin, proxyOk, proxyBad]) {
  await new Promise(r => srv.close(r));
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) { for (const [n, e] of failures) console.error('  ✗ ' + n, e); process.exit(1); }
