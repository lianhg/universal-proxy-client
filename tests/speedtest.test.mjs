/**
 * 节点真连测速 —— 纯逻辑回归测试
 * 运行：node tests/speedtest.test.mjs
 * 需先执行：npx tsc -p tsconfig.runtime.build.json
 *
 * 覆盖：测速目标解析 / CONNECT 隧道请求 / 代理响应解析 / Content-Length /
 *       速度换算与分级 / 白名单 / 结果文案。
 * 注意：本测试不发任何网络请求，也不启动内核。
 */
import assert from 'node:assert/strict';
import * as S from '../.runtime-build/runtime/speedtest.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

console.log('\n── 测速目标解析 ──');

t('https 目标：端口 443、path 带 query、请求行正确', () => {
  const p = S.parseTarget('https://speed.cloudflare.com/__down?bytes=10485760');
  assert.equal(p.protocol, 'https:');
  assert.equal(p.host, 'speed.cloudflare.com');
  assert.equal(p.port, 443);
  assert.equal(p.path, '/__down?bytes=10485760');
  assert.equal(p.authority, 'speed.cloudflare.com:443');
  assert.ok(p.requestText.startsWith('GET /__down?bytes=10485760 HTTP/1.1\r\n'));
  assert.ok(p.requestText.includes('Host: speed.cloudflare.com'));
  assert.ok(p.requestText.includes('Connection: close'));
});

t('http 目标：默认端口 80，不强制 TLS', () => {
  const p = S.parseTarget('http://cachefly.cachefly.net/5mb.test');
  assert.equal(p.protocol, 'http:');
  assert.equal(p.port, 80);
  assert.equal(p.authority, 'cachefly.cachefly.net:80');
});

t('非 http/https 或非法 URL 必须明确拒绝', () => {
  assert.throws(() => S.parseTarget('ftp://example.com/a'), /只支持 http\/https/);
  assert.throws(() => S.parseTarget('not a url'), /URL 无效/);
});

t('CONNECT 隧道请求格式正确', () => {
  const req = S.buildConnectRequest('speed.cloudflare.com:443');
  assert.ok(req.startsWith('CONNECT speed.cloudflare.com:443 HTTP/1.1\r\n'));
  assert.ok(req.includes('Host: speed.cloudflare.com:443'));
  assert.ok(req.endsWith('\r\n\r\n'));
});

console.log('\n── 代理响应解析 ──');

t('CONNECT 200：隧道建立，返回剩余字节', () => {
  const r = S.parseConnectReply('HTTP/1.1 200 Connection established\r\n\r\nEXTRA');
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.rest, 'EXTRA');
});

t('CONNECT 407：明确报代理需要认证，而不是「隧道成功」', () => {
  const r = S.parseConnectReply('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
  assert.equal(r.ok, false);
  assert.equal(r.status, 407);
  assert.ok(r.error.includes('407'));
});

t('响应头不完整时不误判为成功', () => {
  const r = S.parseConnectReply('HTTP/1.1 200 OK\r\n');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('完整'));
});

t('Content-Length 解析：有则取值、无则 null、大小写不敏感', () => {
  assert.equal(S.contentLengthOf('\r\ncontent-length: 10485760'), 10485760);
  assert.equal(S.contentLengthOf('\r\nContent-Length: 0'), 0);
  assert.equal(S.contentLengthOf('\r\ntransfer-encoding: chunked'), null);
});

console.log('\n── 速度换算与分级 ──');

t('字节 / 耗时换算 Mbps（1MB in 1s ≈ 8.39 Mbps）', () => {
  const v = S.bytesToMbps(1024 * 1024, 1000);
  assert.ok(v > 8.3 && v < 8.5, `实际 ${v}`);
  assert.equal(S.bytesToMbps(0, 1000), null);
  assert.equal(S.bytesToMbps(1000, 0), null);
});

t('分级阈值：≥8 优秀 / ≥2 可用 / ≥0.5 偏慢 / 其余不可用', () => {
  assert.equal(S.gradeSpeed(20), 'fast');
  assert.equal(S.gradeSpeed(8), 'fast');
  assert.equal(S.gradeSpeed(7.9), 'ok');
  assert.equal(S.gradeSpeed(2), 'ok');
  assert.equal(S.gradeSpeed(0.6), 'slow');
  assert.equal(S.gradeSpeed(0.4), 'bad');
  assert.equal(S.gradeSpeed(0), 'bad');
  assert.equal(S.gradeSpeed(null), 'bad');
});

t('测速目标白名单：只允许内置目标，防止把流量发到任意地址', () => {
  for (const tgt of S.SPEEDTEST_TARGETS) assert.equal(S.isAllowedTarget(tgt.url), true);
  assert.equal(S.isAllowedTarget('https://evil.example.com/steal'), false);
  assert.ok(S.SPEEDTEST_TARGETS.every(x => x.url.startsWith('http') && x.label && x.note));
});

t('格式化：速度 / 字节 / 结果文案', () => {
  assert.equal(S.formatMbps(null), '—');
  assert.equal(S.formatMbps(0.456), '0.46 Mbps');
  assert.equal(S.formatMbps(12.34), '12.3 Mbps');
  assert.equal(S.formatMbps(321.6), '322 Mbps');
  assert.equal(S.formatBytes(0), '0 B');
  assert.equal(S.formatBytes(2048), '2.0 KB');
  assert.equal(S.formatBytes(5 * 1024 * 1024), '5.00 MB');

  const row = {
    id: '1', name: '香港-01', protocol: 'vless', kernel: 'xray',
    server: 'hk.example.net', port: 443, phase: 'done',
    latencyMs: 42, ttfbMs: 310, mbps: 15.5, bytes: 8 * 1024 * 1024,
    grade: 'fast', startedAt: 0,
  };
  const text = S.describeRow(row);
  assert.ok(text.includes('握手 42 ms'));
  assert.ok(text.includes('首字节 310 ms'));
  assert.ok(text.includes('优秀'));
  assert.ok(S.describeRow({ ...row, phase: 'error', error: 'TLS 握手失败' }).includes('不可用'));
});

console.log('\n── 默认参数 ──');

t('默认并发 / 时长 / 目标都在安全范围', () => {
  const d = S.DEFAULT_SPEEDTEST_OPTIONS;
  assert.ok(d.concurrency >= 1 && d.concurrency <= 6);
  assert.ok(d.durationMs >= 3000 && d.durationMs <= 15000);
  assert.ok(d.maxBytes >= 1024 * 1024);
  assert.equal(S.isAllowedTarget(d.targetUrl), true);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  for (const [name, e] of failures) console.error(`\n[${name}]\n${e?.stack ?? e}`);
  process.exit(1);
}
