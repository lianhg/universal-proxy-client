/**
 * 并行热切换（零断网）—— 可执行回归测试
 * 运行：node tests/switch-node.test.mjs（需先 npx tsc -p tsconfig.main.build.json）
 *
 * 事故背景（2026-11-12 10:21 真实日志）：
 *   旧链路「杀旧进程 → 起新内核 → 8 秒健康检查」，切换时端口自动避让漂到 21812/21813，
 *   新内核没起来；回退时又被残留 xray 占着端口，于是 rollback() 把系统代理恢复掉 → 用户断网。
 *
 * 新架构：候选内核在独立端口上先完整启动 + 健康检查，旧内核与系统代理全程不动；
 *   验证通过才改系统代理指向、扶正候选、最后杀旧内核。任何前置失败只清理候选。
 *
 * 本测试用真实 RuntimeManager 实例 + 替换进程/系统代理相关方法，
 * 不启动任何内核、不改真实系统代理、不碰用户连接，验证「切换失败零影响」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from '../.main-build/main/runtime/manager.js';
import { buildRuntimeConfig } from '../.main-build/core/runtime/config-builder.js';
import { mergeRuntimeSettings } from '../.main-build/core/runtime/types.js';
import * as H from '../.main-build/core/hub/index.js';

const execFileAsync = promisify(execFile);
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const oldNode = H.importText(`vless://${UUID}@old.example.net:443?encryption=none&security=tls&sni=old.example#旧节点`).nodes[0];
const newNode = H.importText(`vless://${UUID}@new.example.net:443?encryption=none&security=tls&sni=new.example#新节点`).nodes[0];
assert.ok(oldNode && newNode, '样例节点解析失败');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-switch-test-'));
const events = [];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const managerSrc = read('src/main/runtime/manager.ts');
const storeSrc = read('src/renderer/store.ts');
const appSrc = read('src/renderer/App.vue');

/** 造一个「正在运行、系统代理已接管」的 manager，把进程/代理能力替换成可观测的桩 */
function runningManager() {
  const m = new RuntimeManager({
    userData,
    projectRoot: path.join(userData, 'no-project'),
    send: (_c, p) => events.push(p),
  });
  m.settings = mergeRuntimeSettings({ mode: 'system-proxy' });
  m.status.state = 'running';
  m.status.kernel = 'xray';
  m.status.node = { id: oldNode.id, name: oldNode.name, protocol: 'vless', server: oldNode.server, port: oldNode.port };
  m.status.settings = { ...m.settings };
  m.status.listenPort = m.settings.httpPort;
  m.status.systemProxy = {
    applied: true, server: `127.0.0.1:${m.settings.httpPort}`,
    snapshot: null, restored: false, message: '已接管',
  };
  m.proc = { pid: 1111, exitCode: null };           // 旧内核进程（桩）
  m.currentLaunch = {
    kernel: 'xray', binaryPath: 'C:/fake/xray.exe',
    configPath: path.join(userData, 'runtime', 'runtime-xray.json'),
    configText: '{"old":true}', args: [], node: oldNode, peers: [], routing: undefined,
  };
  m.scan = async () => ({ items: [
    { kernel: 'xray', found: true, path: 'C:/fake/xray.exe' },
    { kernel: 'sing-box', found: true, path: 'C:/fake/sing-box.exe' },
    { kernel: 'mihomo', found: true, path: 'C:/fake/mihomo.exe' },
  ] });
  m.validateConfig = async () => ({ ok: true, error: '' });
  m.runPS = async () => 'OK';
  m.telemetry = { start() {}, stop() {} };
  return m;
}

/** 让候选端口与当前端口明显不同，验证「不复用旧内核端口」 */
function stubCandidate(m, result) {
  let usedSettings = null;
  m.resolveFreePorts = async (s) => {
    const next = { ...s, socksPort: s.socksPort + 100, httpPort: s.httpPort + 100, controllerPort: s.controllerPort + 100 };
    usedSettings = next;
    return { settings: next, changes: ['测试：候选独立端口'] };
  };
  m.spawnCandidate = async (input) => {
    usedSettings = input.settings;
    if (result === 'fail') throw new Error('候选内核未能在 127.0.0.1:xxx 监听（8 秒内）');
    return { child: { pid: 2222, exitCode: null }, configPath: path.join(userData, 'runtime', 'candidate.json') };
  };
  m.killChild = async () => {};
  return () => usedSettings;
}

console.log('\n=== 并行热切换：切换失败零断网 ===');

await t('配置预检不通过：不启动候选、不杀旧内核、连接与代理都不动', async () => {
  const m = runningManager();
  let spawned = 0, killed = 0;
  m.spawnCandidate = async () => { spawned++; return {}; };
  m.killChild = async () => { killed++; };
  m.validateConfig = async () => ({ ok: false, error: 'infra/conf: unknown config id' });
  const r = await m.switchNode({ node: newNode, kernel: 'xray' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown config id/);
  assert.equal(spawned, 0);
  assert.equal(killed, 0);
  assert.equal(m.status.state, 'running');
  assert.equal(m.status.systemProxy.applied, true);
  assert.ok(!m.switching, '预检失败不能把 switching 守卫留在置位状态');
});

await t('★ 并发点击切换：第二次立即被拒，只起一个候选内核（不产生孤儿进程）', async () => {
  const m = runningManager();
  let spawned = 0;
  m.resolveFreePorts = async (s) => ({ settings: { ...s, httpPort: s.httpPort + 100 }, changes: [] });
  m.spawnCandidate = async () => {
    spawned++;
    await new Promise(r => setTimeout(r, 80));
    return { child: { pid: 3333, exitCode: null }, configPath: path.join(userData, 'runtime', 'candidate.json') };
  };
  m.killChild = async () => {};
  // 第一次还没跑完就点第二次：如果锁不是同步置位，这里会同时进入候选阶段
  const p1 = m.switchNode({ node: newNode, kernel: 'xray' });
  const p2 = m.switchNode({ node: newNode, kernel: 'xray' });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true, '第一次切换应当成功');
  assert.equal(r2.ok, false, '第二次必须被重入锁拒绝');
  assert.match(r2.error, /正在切换中/);
  assert.equal(spawned, 1, `只能起一个候选内核，实际起了 ${spawned} 个`);
});

await t('★ 候选内核起不来：旧内核进程不变、系统代理不变、状态仍 running', async () => {
  const m = runningManager();
  const oldProc = m.proc;
  const oldProxy = m.status.systemProxy.server;
  const oldSettings = { ...m.settings };
  stubCandidate(m, 'fail');
  const r = await m.switchNode({ node: newNode, kernel: 'xray' });
  assert.equal(r.ok, false);
  assert.match(r.error, /可正常上网|当前连接与系统代理均未改动/);
  assert.equal(m.proc, oldProc, '旧内核进程引用必须原样保留');
  assert.equal(m.status.systemProxy.server, oldProxy, '系统代理一个字都不能改');
  assert.equal(m.status.systemProxy.applied, true);
  assert.deepEqual(m.settings, oldSettings, '运行设置不能变成候选端口');
  assert.equal(m.status.state, 'running');
  assert.equal(m.currentLaunch.node.name, '旧节点');
});

await t('★ 系统代理改指向失败：杀候选、代理回指旧端口、旧内核仍在', async () => {
  const m = runningManager();
  const oldProc = m.proc;
  const oldProxy = m.status.systemProxy.server;
  let killedCandidates = 0, applied = [];
  stubCandidate(m, 'ok');
  m.killChild = async (child) => { if (child?.pid === 2222) killedCandidates++; };
  m.runPS = async (script) => { applied.push(script); throw new Error('模拟：写注册表失败'); };
  const r = await m.switchNode({ node: newNode, kernel: 'xray' });
  assert.equal(r.ok, false);
  assert.equal(killedCandidates, 1, '候选进程必须被清理');
  assert.equal(m.proc, oldProc, '旧内核不能被动过');
  assert.equal(m.status.systemProxy.server, oldProxy);
  assert.equal(m.status.state, 'running');
  assert.ok(applied.length >= 1, '应尝试过改系统代理（并在失败时回指）');
});

await t('候选验证通过：先改代理 → 再扶正 → 最后才杀旧内核', async () => {
  const m = runningManager();
  const oldProc = m.proc;
  const oldSettings = { ...m.settings };
  const order = [];
  const getUsed = stubCandidate(m, 'ok');
  m.killChild = async (child) => { order.push(child === oldProc ? 'kill-old' : 'kill-candidate'); };
  m.runPS = async () => { order.push('apply-proxy'); return 'OK'; };
  const r = await m.switchNode({ node: newNode, kernel: 'xray' });
  assert.equal(r.ok, true, r.error);
  assert.equal(order[0], 'apply-proxy', '必须先改系统代理');
  assert.equal(order.includes('kill-old'), true, '旧内核必须最后才杀');
  assert.equal(m.status.node.name, '新节点');
  assert.equal(m.status.state, 'running');
  assert.equal(m.currentLaunch.node.name, '新节点');
  assert.notDeepEqual(getUsed(), oldSettings, '候选必须使用独立端口组');
  assert.equal(m.settings.httpPort, getUsed().httpPort, '成功后端口要落盘生效，避免下次漂移');
});

await t('候选端口组不与旧内核端口重叠', async () => {
  const m = runningManager();
  const oldPorts = [m.settings.socksPort, m.settings.httpPort, m.settings.controllerPort];
  const getUsed = stubCandidate(m, 'ok');
  m.runPS = async () => 'OK';
  m.killChild = async () => {};
  await m.switchNode({ node: newNode, kernel: 'xray' });
  const s = getUsed();
  for (const p of oldPorts) {
    assert.ok(![s.socksPort, s.httpPort, s.controllerPort].includes(p), `候选端口与旧端口 ${p} 重叠`);
  }
});

await t('目标节点不支持当前内核时自动换核并写日志', async () => {
  const m = runningManager();
  const singOnly = { ...newNode, kernels: ['sing-box'], kernel: 'sing-box' };
  m.validateConfig = async () => ({ ok: false, error: '测试：预检拒绝' });
  const r = await m.switchNode({ node: singOnly, kernel: 'xray' });
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(events), /自动改用 sing-box 内核/);
  assert.equal(m.status.state, 'running');
});

await t('peers 只保留支持最终内核的节点', async () => {
  const m = runningManager();
  const badPeer = { ...oldNode, id: 'peer-bad', name: '不兼容节点', kernels: ['mihomo'] };
  const goodPeer = { ...oldNode, id: 'peer-good', name: '兼容节点', kernels: ['xray'] };
  stubCandidate(m, 'ok');
  m.runPS = async () => 'OK';
  m.killChild = async () => {};
  await m.switchNode({ node: newNode, kernel: 'xray', peers: [badPeer, goodPeer] });
  assert.deepEqual(m.currentLaunch.peers.map(p => p.name), ['兼容节点']);
});

await t('TUN 模式明确拒绝不停机切换（不会偷偷走旧链路断网）', async () => {
  const m = runningManager();
  m.settings = mergeRuntimeSettings({ mode: 'tun' });
  m.status.settings = { ...m.settings };
  const r = await m.switchNode({ node: newNode, kernel: 'xray' });
  assert.equal(r.ok, false);
  assert.match(r.error, /TUN 模式不支持不停机切换/);
  assert.equal(m.status.state, 'running');
});

console.log('\n── 源码红线 ──');

await t('旧「先杀后起 + rollback 断网」链路已彻底移除', () => {
  const fn = managerSrc.slice(
    managerSrc.indexOf('  async switchNode(req: RuntimeStartRequest)'),
    managerSrc.indexOf('  /* ─────────────── 停止 / 回滚'),
  );
  assert.match(fn, /spawnCandidate\(/, '必须走并行候选');
  assert.ok(!fn.includes('await this.rollback('), '切换失败绝不能 rollback 断开系统代理');
  assert.ok(!fn.includes('await this.killProcess();'), '切换中不能再先杀当前内核');
  assert.match(fn, /当前连接与系统代理均未改动/);
  assert.match(fn, /killChild\(oldProc\)/, '旧内核必须最后才杀');
});

await t('切换前存在真实内核配置校验，三内核参数正确', () => {
  assert.match(managerSrc, /private async validateConfig\(/);
  assert.match(managerSrc, /'-test', '-c', tmp/);
  assert.match(managerSrc, /'check', '-c', tmp/);
  assert.match(managerSrc, /'-t', '-f', tmp, '-d', dir/);
});

await t('切换失败原因会落盘并弹到界面 toast', () => {
  assert.match(managerSrc, /appendRuntimeLog/);
  // title 区分「连接失败 / 断开失败 / 节点切换失败」，message 仍是主进程给的原始原因
  assert.match(storeSrc, /lastRuntimeError\.value = \{ title: '节点切换失败', message: r\.error/);
  assert.match(appSrc, /watch\(\(\) => appStore\.lastRuntimeError/);
  assert.match(appSrc, /showToast\('error', e\.title \|\| '节点切换失败'/);
  // 只能有一条错误 toast 通道：曾经同时监听 runtime.lastError，一次失败弹两个提示
  assert.ok(!/watch\(\(\) => appStore\.runtime\.lastError/.test(appSrc), '不应再额外监听 runtime.lastError（会重复弹窗）');
});

await t('切换重入锁在第一个 await 之前同步置位（防并发孤儿内核）', () => {
  const head = managerSrc.slice(managerSrc.indexOf('async switchNode(req'), managerSrc.indexOf('private async switchNodeInternal'));
  assert.ok(head.length > 0, '没找到 switchNode 入口');
  const lockIdx = head.indexOf('this.switching = true');
  // 注意不能搜 'await '：注释里就写着「第一个 await 之前」，会误判
  const firstAwait = head.indexOf('await this.switchNodeInternal');
  assert.ok(lockIdx > 0, 'switchNode 入口必须同步置位 switching');
  assert.ok(firstAwait === -1 || lockIdx < firstAwait, 'switching 必须在任何 await 之前置位');
  assert.match(head, /try \{\s*return await this\.switchNodeInternal\(req\)/, '入口必须用 try 包住内部实现');
  assert.match(head, /catch \(e\)[\s\S]*?ok: false/, 'IPC 入口异常必须转成 ok:false 结果，不能 reject');
});

await t('候选阶段到扶正前的所有步骤都在同一个 try 里（端口扫描失败也有可读结果）', () => {
  const body = managerSrc.slice(managerSrc.indexOf('private async switchNodeInternal'));
  const tryIdx = body.indexOf('let candidate:');
  const portIdx = body.indexOf('await this.resolveFreePorts(');
  assert.ok(tryIdx > 0 && portIdx > tryIdx, 'resolveFreePorts 必须在 try 内');
  assert.ok(body.indexOf('let promoted = false') > 0, '需要 promoted 标记区分「已扶正」与「未扶正」');
  assert.match(body, /if \(promoted\)[\s\S]*?ok: true/, '已扶正后收尾异常不得回滚（回滚=断网）');
});

await t('热切换不留孤儿内核：扶正后旧内核登记为待回收，断开时补刀', () => {
  assert.match(managerSrc, /private retiredProc: ChildProcess \| null = null/);
  assert.match(managerSrc, /this\.retiredProc = oldProc/);
  assert.match(managerSrc, /if \(this\.retiredProc\) \{\s*await this\.killChild\(this\.retiredProc\)/);
});

await t('真实 Xray -test 能区分好配置与坏配置（预检依据成立）', async () => {
  const bin = path.join(os.homedir(), 'AppData/Roaming/universal-proxy-client/bin/xray.exe');
  if (!fs.existsSync(bin)) { console.log('    (本机未安装 xray.exe，跳过真内核校验)'); return; }
  const built = buildRuntimeConfig(newNode, 'xray', mergeRuntimeSettings(), [], undefined);
  assert.deepEqual(built.blockers, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-xray-check-'));
  const good = path.join(dir, 'good.json');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(good, built.text, 'utf8');
  let badText = built.text.replace(/"protocol":\s*"socks"/, '"protocol": "NO_SUCH_PROTO"');
  if (badText === built.text) badText = built.text.slice(0, -8);
  fs.writeFileSync(bad, badText, 'utf8');
  try {
    await execFileAsync(bin, ['-test', '-c', good], { timeout: 8000, windowsHide: true });
    let rejected = false;
    try { await execFileAsync(bin, ['-test', '-c', bad], { timeout: 8000, windowsHide: true }); }
    catch { rejected = true; }
    assert.equal(rejected, true, '坏配置必须被真实内核拒绝');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ${name}: ${e?.stack ?? e}`);
  process.exit(1);
}
