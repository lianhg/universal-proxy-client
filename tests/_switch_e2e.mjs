/** 一次性真机验收：真实 xray.exe + 独立端口，验证并行切换「失败零断网」 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { RuntimeManager } from '../.main-build/main/runtime/manager.js';
import * as H from '../.main-build/core/hub/index.js';

const BIN = path.join(os.homedir(), 'AppData/Roaming/universal-proxy-client/bin/xray.exe');
if (!fs.existsSync(BIN)) { console.log('跳过：本机没有 xray.exe'); process.exit(0); }

const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const n1 = H.importText(`vless://${UUID}@e2e-a.example.net:443?encryption=none&security=tls&sni=a.example#E2E-A`).nodes[0];
const n2 = H.importText(`vless://${UUID}@e2e-b.example.net:443?encryption=none&security=tls&sni=b.example#E2E-B`).nodes[0];
const n3 = H.importText(`vless://${UUID}@e2e-c.example.net:443?encryption=none&security=tls&sni=c.example#E2E-C`).nodes[0];

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-switch-e2e-'));
const m = new RuntimeManager({ userData, projectRoot: path.join(userData, 'none'), send: () => {} });
m.scan = async () => ({ items: [{ kernel: 'xray', found: true, path: BIN }] });
const ports = { mode: 'none', socksPort: 23808, httpPort: 23809, controllerPort: 23811, autoRestart: false };
const probe = port => new Promise(res => {
  const s = new net.Socket(); let done = false;
  const f = v => { if (!done) { done = true; s.destroy(); res(v) } };
  s.setTimeout(400); s.once('connect', () => f(true)); s.once('timeout', () => f(false)); s.once('error', () => f(false));
  try { s.connect(port, '127.0.0.1') } catch { f(false) }
});

let failed = false;
try {
  const s1 = await m.start({ node: n1, kernel: 'xray', settings: ports });
  console.log('① 真实启动:', s1.ok, s1.error ?? '', 'PID', s1.status.pid, '端口', s1.status.listenPort);
  assert.equal(s1.ok, true, `启动失败：${s1.error}`);
  assert.equal(await probe(s1.status.listenPort), true, '初始 HTTP 入站未监听');
  const oldPort = s1.status.listenPort;
  const oldPid = s1.status.pid;

  const s2 = await m.switchNode({ node: n2, kernel: 'xray' });
  const newPort = s2.status.listenPort;
  console.log('② 并行切换:', s2.ok, s2.error ?? '', '节点', s2.status.node?.name, '端口', oldPort, '→', newPort);
  assert.equal(s2.ok, true, `切换失败：${s2.error}`);
  assert.equal(s2.status.node?.name, 'E2E-B');
  assert.notEqual(newPort, oldPort, '候选必须使用独立端口组');
  assert.equal(await probe(newPort), true, '新内核端口未监听');
  assert.equal(await probe(oldPort), false, '旧内核应已退出');

  // ③ 预检拒绝：当前连接必须原样保留
  m.validateConfig = async () => ({ ok: false, error: '模拟：内核拒绝目标节点配置' });
  const s3 = await m.switchNode({ node: n3, kernel: 'xray' });
  console.log('③ 预检拒绝:', s3.ok, '当前节点', s3.status.node?.name, '端口仍监听 =', await probe(newPort));
  assert.equal(s3.ok, false);
  assert.equal(s3.status.state, 'running');
  assert.equal(s3.status.node?.name, 'E2E-B');
  assert.equal(await probe(newPort), true, '预检拒绝后内核必须仍在监听');

  // ④ 候选内核起不来（并行验证阶段失败）：这是以前会直接断网的场景
  m.validateConfig = async () => ({ ok: true, error: '' });
  const realSpawn = m.spawnCandidate.bind(m);
  m.spawnCandidate = async () => { throw new Error('模拟：候选内核 8 秒内未监听') };
  const s4 = await m.switchNode({ node: n3, kernel: 'xray' });
  console.log('④ 候选启动失败:', s4.ok, '当前节点', s4.status.node?.name,
    'PID 未变 =', s4.status.pid === s2.status.pid, '端口仍监听 =', await probe(newPort));
  assert.equal(s4.ok, false);
  assert.equal(s4.status.state, 'running', '候选失败后必须仍是连接状态');
  assert.equal(s4.status.node?.name, 'E2E-B', '候选失败后当前节点不能被改掉');
  assert.equal(s4.status.pid, s2.status.pid, '候选失败后当前内核 PID 不能变');
  assert.equal(await probe(newPort), true, '★ 候选失败后用户仍能通过代理上网');
  m.spawnCandidate = realSpawn;
  assert.notEqual(oldPid, s2.status.pid, '切换后应换成候选内核的 PID');

  console.log('\n真机端到端：启动 / 并行切换 / 预检拒绝 / 候选失败不断网 全部通过');
} catch (e) {
  failed = true;
  console.error('真机端到端失败:', e.stack ?? e.message);
} finally {
  await m.stop().catch(() => {});
  await m.dispose().catch(() => {});
  await new Promise(r => setTimeout(r, 600));
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* Windows 进程句柄稍晚释放，忽略 */ }
}
process.exit(failed ? 1 : 0);
