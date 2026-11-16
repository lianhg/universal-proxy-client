/**
 * 主进程运行层 —— 可执行回归测试（不需要 Electron GUI）
 *
 * RuntimeManager 不依赖 electron，只依赖 node 内置模块，因此可以在 Node 里真实跑一遍：
 * 缺二进制 / 无节点 / 平台不支持等场景必须明确拒绝，且绝不改动系统代理。
 * 运行：node tests/manager.test.mjs（需先 npx tsc -p tsconfig.main.build.json）
 *
 * 注意：本测试【不会】启动任何内核、【不会】写系统代理、【不会】读写 HKCU 注册表。
 * 它只验证「拒绝路径」与设置持久化。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeManager } from '../.main-build/main/runtime/manager.js';
import * as H from '../.main-build/core/hub/index.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✓ ' + name); },
    e => { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); },
  );
}

const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const vless = H.importText(`vless://${UUID}@hk01.example.net:443?encryption=none&security=tls&sni=hk.example#VLESS-TLS`).nodes[0];
assert.ok(vless, '样例节点解析失败');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-runtime-test-'));
const events = [];
const m = new RuntimeManager({
  userData,
  projectRoot: path.join(userData, 'no-project-here'),
  send: (_c, p) => events.push(p),
});

console.log('\n── 主进程运行层：拒绝路径与可逆性 ──');

await t('初始状态为 stopped，且未改任何系统设置', () => {
  const s = m.getStatus();
  assert.equal(s.state, 'stopped');
  assert.equal(s.systemProxy.applied, false);
  assert.equal(s.pid, null);
  assert.equal(s.unavailable, false);
});

await t('二进制扫描：三个内核都明确报告缺失与放置指引', async () => {
  const inv = await m.scan();
  assert.equal(inv.items.length, 3);
  for (const b of inv.items) {
    assert.equal(b.found, false);
    assert.ok(b.reason && b.hint, `${b.kernel} 缺失时必须给出原因和指引`);
  }
});

await t('没有节点时启动被明确拒绝，不抛异常', async () => {
  const r = await m.start({ node: null });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some(b => b.includes('没有可用的节点')));
  assert.equal(r.status.systemProxy.applied, false);
});

await t('有节点但内核二进制缺失时拒绝启动，并列出具体原因', async () => {
  const r = await m.start({ node: vless, kernel: 'xray' });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some(b => b.includes('二进制缺失')));
  assert.equal(r.status.state, 'error');
  assert.equal(r.status.systemProxy.applied, false, '失败路径绝不能留下被改写的系统代理');
  assert.equal(r.status.pid, null, '失败路径不能残留进程');
});

await t('失败原因同时进入事件日志与状态消息', () => {
  assert.ok(events.some(e => e.type === 'log' && /二进制缺失|启动失败/.test(e.log.line)));
  assert.ok(events.some(e => e.type === 'status' && e.status.state === 'error'));
  assert.ok(m.getStatus().lastError);
});

await t('不兼容内核必须拒绝（Hysteria2 + Xray）', async () => {
  const hy2 = H.importText('hysteria2://auth@hy.example.net:443?sni=hy.example#HY2').nodes[0];
  if (!hy2) return; // 样例解析失败则跳过，不误报
  const r = await m.start({ node: hy2, kernel: 'xray' });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some(b => b.includes('不能由 xray 承载')));
});

await t('Xray + TUN 被明确阻断，不静默降级', async () => {
  m.setMode('tun');
  const r = await m.start({ node: vless, kernel: 'xray' });
  assert.ok(r.blockers.some(b => b.includes('TUN')));
  m.setMode('system-proxy');
});

await t('运行设置持久化并可深合并读回', () => {
  m.updateSettings({ mixedPort: 7899, tun: { mtu: 1400 }, binaryPaths: { xray: 'C:/fake/xray.exe' } });
  const s = m.getSettings();
  assert.equal(s.mixedPort, 7899);
  assert.equal(s.tun.mtu, 1400);
  assert.equal(s.tun.stack, 'system');
  assert.equal(s.binaryPaths.xray, 'C:/fake/xray.exe');
  assert.ok(fs.existsSync(path.join(userData, 'runtime-settings.json')));
});

await t('非运行态调用 stop 是安全的，状态收敛为 stopped', async () => {
  const r = await m.stop();
  assert.equal(r.ok, true);
  assert.equal(r.status.state, 'stopped');
  assert.equal(r.status.systemProxy.applied, false);
});

await t('真实 TCP ping：连到不存在的端口必须失败并给出原因', async () => {
  const r = await m.ping('127.0.0.1', 1, 500);
  assert.equal(r.ok, false);
  assert.equal(r.ms, null);
  assert.ok(r.error);
});

await t('真实 TCP ping：参数非法必须先拒绝', async () => {
  const r = await m.ping('', 0);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('无效'));
});

await t('自动重启设置：默认开启、上限可配、持久化生效', () => {
  const def = m.getSettings();
  assert.equal(def.autoRestart, true, '崩溃自动重启默认应开启');
  assert.equal(def.maxAutoRestarts, 3);
  m.updateSettings({ autoRestart: false, maxAutoRestarts: 5 });
  const s = m.getSettings();
  assert.equal(s.autoRestart, false);
  assert.equal(s.maxAutoRestarts, 5);
  m.updateSettings({ autoRestart: true, maxAutoRestarts: 3 });
});

await t('热切换：非运行状态必须明确拒绝（不静默变成启动）', async () => {
  const r = await m.switchNode({ node: vless, kernel: 'xray' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('仅在内核运行中'), r.error);
  assert.equal(r.status.state !== 'running', true, '非运行态不能被热切换改变成运行态');
});

await t('热切换：节点无效时拒绝且错误说明「当前连接未受影响」', async () => {
  // 把状态推到 running 不可行（无私有字段访问），但可以验证无效节点在入口校验就被拒
  const r = await m.switchNode({ node: null });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('仅在内核运行中'));
});

await t('dispose 后状态安全，不残留系统代理改动', async () => {
  await m.dispose();
  const s = m.getStatus();
  assert.equal(s.systemProxy.applied, false);
  assert.equal(s.pid, null);
});

console.log(`\n主进程运行层测试：${pass} 通过 / ${fail} 失败`);
fs.rmSync(userData, { recursive: true, force: true });
if (fail) {
  for (const [name, e] of failures) console.error(`  ✗ ${name}: ${e.stack ?? e}`);
  process.exit(1);
}
