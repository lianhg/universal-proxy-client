/**
 * 测速下载链路回归测试（本机假代理，不联网、不启动内核）
 * 运行：node tests/speedtest-download.test.mjs
 * 需先执行：npx tsc -p tsconfig.main.build.json
 *
 * 验证：CONNECT 隧道 → 原始 HTTP 请求 → 字节统计 → 速度换算 → 错误如实上报。
 * 这是「真连测速」最容易写错的一段（头部字节不能算进带宽、隧道失败不能当成 0 速度）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { downloadThroughProxy } from '../.main-build/main/runtime/speedtester.js';
import * as S from '../.main-build/core/runtime/speedtest.js';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const BODY = Buffer.alloc(2 * 1024 * 1024, 0x41); // 2MB

/** 源站：/big 返回 2MB，其余 404 */
function startOrigin() {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/big')) {
      res.writeHead(200, { 'Content-Length': BODY.length, 'Content-Type': 'application/octet-stream' });
      res.end(BODY);
      return;
    }
    if (req.url.startsWith('/empty')) {
      res.writeHead(204, { 'Content-Length': '0' });
      res.end();
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/** 假 HTTP 代理：CONNECT 直接连目标并双向 pipe；mode='502' 时拒绝隧道 */
function startProxy(mode = 'ok') {
  const srv = http.createServer((_req, res) => { res.writeHead(400); res.end(); });
  srv.on('connect', (req, clientSocket, head) => {
    if (mode === '502') {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
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
const opts = { durationMs: 4000, maxBytes: 8 * 1024 * 1024, timeoutMs: 4000 };

console.log('\n── 经代理真实下载 ──');

await t('CONNECT 隧道下载 2MB：字节数正确、首字节与带宽都有值', async () => {
  const target = S.parseTarget(`http://127.0.0.1:${originPort}/big`);
  const r = await downloadThroughProxy(proxyOk.address().port, target, opts, { cancelled: false });
  assert.equal(r.error, undefined, `不应报错：${r.error}`);
  assert.equal(r.bytes, BODY.length, `字节数应等于响应体大小，实际 ${r.bytes}`);
  assert.ok(r.ttfbMs !== null && r.ttfbMs >= 0, '首字节时间必须有值');
  assert.ok(r.mbps !== null && r.mbps > 0, `带宽应大于 0，实际 ${r.mbps}`);
});

await t('达到 maxBytes 后收工（允许最后一个数据块溢出），不会把 2MB 全下完', async () => {
  const target = S.parseTarget(`http://127.0.0.1:${originPort}/big`);
  const limit = 64 * 1024;
  const r = await downloadThroughProxy(proxyOk.address().port, target, { ...opts, maxBytes: limit }, { cancelled: false });
  assert.ok(r.bytes >= limit, `至少应下满上限，实际 ${r.bytes}`);
  assert.ok(r.bytes < BODY.length, `应在上限附近停止，实际下了 ${r.bytes} / ${BODY.length}`);
});

await t('204 空响应：只证明连通，带宽为 null 而不是 0 Mbps', async () => {
  const target = S.parseTarget(`http://127.0.0.1:${originPort}/empty`);
  const r = await downloadThroughProxy(proxyOk.address().port, target, opts, { cancelled: false });
  assert.equal(r.error, undefined);
  assert.equal(r.bytes, 0);
  assert.equal(r.mbps, null);
  assert.ok(r.ttfbMs !== null);
});

await t('代理拒绝隧道（502）：如实报错，不返回 0 速度冒充成功', async () => {
  const target = S.parseTarget(`http://127.0.0.1:${originPort}/big`);
  const r = await downloadThroughProxy(proxyBad.address().port, target, opts, { cancelled: false });
  assert.ok(r.error, '必须有错误信息');
  assert.ok(r.error.includes('502'), `错误里应带状态码，实际：${r.error}`);
  assert.equal(r.mbps, null);
});

await t('已取消的测速立即失败，不会继续下载', async () => {
  const target = S.parseTarget(`http://127.0.0.1:${originPort}/big`);
  const r = await downloadThroughProxy(proxyOk.address().port, target, opts, { cancelled: true });
  assert.ok(r.error, '取消必须有明确原因');
});

origin.close(); proxyOk.close(); proxyBad.close();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  for (const [name, e] of failures) console.error(`\n[${name}]\n${e?.stack ?? e}`);
  process.exit(1);
}
