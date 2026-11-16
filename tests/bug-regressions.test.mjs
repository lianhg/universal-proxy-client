/**
 * BUG 排查回归测试（2026-11-12 第二轮）
 * 运行：node tests/bug-regressions.test.mjs（需先 npx tsc -p tsconfig.main.build.json）
 *
 * 覆盖这一轮查出来的问题：
 *   1. 端口设置被清空 / 填非法值 / 与别的端口撞车时，不能写坏 runtime-settings.json
 *   2. 遥测采集器在 ctx 被 stop() 置空后采样失败，不能再抛 TypeError 变 unhandledRejection
 *   3. runtime.log 无限增长（切节点多的人一天几百条）→ 超过 1MB 自动轮转
 *   4. 订阅自动更新定时器与上一轮叠加 → 并发拉同一订阅、计数互相污染
 *   5. 渲染层 connect/disconnect/switchNode 没有 catch → IPC 异常时界面「点了没反应」
 *   6. 主进程运行层 IPC 缺少兜底 → promise reject 到渲染层
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from '../.main-build/main/runtime/manager.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 每个用例独立 userData，避免端口写入互相影响 */
function mk() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-bug-'));
  const m = new RuntimeManager({ userData, projectRoot: path.join(userData, 'no-project'), send: () => {} });
  return { m, userData };
}

console.log('\n=== BUG 回归：设置 / 遥测 / 日志 / 订阅 / 错误提示 ===');

t('端口设置：清空与非法值被忽略，不会把空串写进配置文件', () => {
  const { m, userData } = mk();
  const before = m.getSettings();
  const after = m.updateSettings({ mixedPort: '', socksPort: 70000, httpPort: -1 });
  assert.equal(after.mixedPort, before.mixedPort, '空串必须被忽略');
  assert.equal(after.socksPort, before.socksPort, '超出 65535 必须被忽略');
  assert.equal(after.httpPort, before.httpPort, '负数必须被忽略');
  const disk = JSON.parse(fs.readFileSync(path.join(userData, 'runtime-settings.json'), 'utf8'));
  for (const k of ['mixedPort', 'socksPort', 'httpPort', 'controllerPort']) {
    assert.equal(typeof disk[k], 'number', `${k} 落盘必须是数字，实际 ${JSON.stringify(disk[k])}`);
  }
});

t('端口设置：与未修改的端口撞车时拒绝新值（反序覆盖也要挡住）', () => {
  const { m } = mk();
  const before = m.getSettings();
  // 把 socksPort 改成 httpPort 的原值：如果先登记新值再登记旧值，这里会漏过去
  const after = m.updateSettings({ socksPort: before.httpPort });
  assert.equal(after.socksPort, before.socksPort, '重复端口必须被拒绝');
  assert.equal(after.httpPort, before.httpPort);
});

t('端口设置：合法值仍然正常保存', () => {
  const { m } = mk();
  const after = m.updateSettings({ mixedPort: 23456, controllerPort: 23457 });
  assert.equal(after.mixedPort, 23456);
  assert.equal(after.controllerPort, 23457);
});

t('遥测采样在 ctx 被清空后不会读 null（源码红线）', () => {
  const src = read('src/main/runtime/telemetry.ts');
  assert.match(src, /this\.ctx\?\.kernel/, 'catch 里必须用可选链取内核');
  assert.ok(!/emptyTelemetry\(this\.ctx\.kernel/.test(src), '不能再直接读 this.ctx.kernel');
  assert.ok(!/kernelTelemetryCapability\(this\.ctx\.kernel\)/.test(src));
});

t('runtime.log 超过 1MB 会轮转，且保留最新一条', () => {
  const { m } = mk();
  const dir = path.join(m.userData, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'runtime.log');
  fs.writeFileSync(file, 'x'.repeat(1100 * 1024), 'utf8');
  m.appendRuntimeLog('after-rotate-marker');
  const size = fs.statSync(file).size;
  assert.ok(size < 500 * 1024, `轮转后应明显变小，实际 ${Math.round(size / 1024)}KB`);
  assert.match(fs.readFileSync(file, 'utf8'), /after-rotate-marker/, '最新一条必须保留');
});

t('订阅自动更新有重入锁，不会并发拉同一个订阅', () => {
  const src = read('src/renderer/store.ts');
  assert.match(src, /let autoUpdating = false/);
  assert.match(src, /if \(autoUpdating\) return/);
  assert.match(src, /finally \{ autoUpdating = false \}/);
});

t('渲染层 connect / disconnect / switchNode 都有 catch 兜底', () => {
  const src = read('src/renderer/store.ts');
  for (const name of ['async function connect(', 'async function disconnect(', 'async function switchNode(']) {
    const start = src.indexOf(name);
    assert.ok(start > 0, `没找到 ${name}`);
    const end = src.indexOf('\n  }', start);
    const body = src.slice(start, end);
    assert.match(body, /catch \(e\)/, `${name} 缺少 catch，IPC 异常会静默`);
    assert.match(body, /lastRuntimeError\.value = \{ title:/, `${name} catch 里必须写可读错误`);
  }
});

t('主进程运行层 IPC 有 guarded 兜底，不会 reject 到渲染层', () => {
  const src = read('src/main.ts');
  assert.match(src, /function guarded</);
  assert.match(src, /guarded\('启动'/);
  assert.match(src, /guarded\('断开'/);
  assert.match(src, /guarded\('切换节点'/);
  assert.match(src, /guarded\('关闭连接'/);
});

t('体检 IPC 异常保持 throw（api.ts 靠 catch 转成 { ok:false }）', () => {
  const src = read('src/main.ts');
  const start = src.indexOf("ipcMain.handle('runtime:probe-sites'");
  const body = src.slice(start, src.indexOf('})', start));
  assert.match(body, /throw new Error/, '必须 throw，返回伪报告会让 r.report.diagnosis 读 null');
});

t('dispose 不再重置 stopping（防止两个 stopInternal 并发改系统代理）', () => {
  const src = read('src/main/runtime/manager.ts');
  const start = src.indexOf('async dispose()');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.ok(!/this\.stopping = false/.test(body), 'dispose 里不能再重置 stopping');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ✗ ${name}: ${e?.stack ?? e}`);
  process.exit(1);
}
