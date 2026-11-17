/**
 * 2026-11-17 全面排查后的回归测试。
 * 覆盖 12 条修复中不适合放进现有套件的关键断言：
 *   - 系统代理：proxyDirty 标志 + 恢复失败保留快照 + 退出竞态等待 + 不谎报已恢复
 *   - 内核下载：原子替换先备份、失败回滚；catch 清理压缩包与解压目录
 *   - 遥测：Xray 成功路径走 finish()
 *   - IPC：open-dir 兜底、geo 返回结构统一
 *   - UI：清空节点二次确认、节点缓存结构校验、UI 冒烟测试进链且断言新文案
 * 运行：node tests/audit-regressions.test.mjs（纯源码断言，无需构建）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const manager = read('src/main/runtime/manager.ts');
const downloader = read('src/main/runtime/downloader.ts');
const telemetry = read('src/main/runtime/telemetry.ts');
const main = read('src/main.ts');
const proxyList = read('src/renderer/components/ProxyListPanel.vue');
const store = read('src/renderer/store.ts');
const uiSmoke = read('tests/ui_smoke.py');
const pkg = JSON.parse(read('package.json'));

/* ── 严重：系统代理部分写入失败 ── */
t('读快照成功即置 proxyDirty，不依赖 applied', () => {
  const body = manager.slice(manager.indexOf('if (settings.mode === \'system-proxy\')'), manager.indexOf('} else if (isTun)'));
  assert.match(body, /this\.proxyDirty = true/, 'apply 前未置 proxyDirty');
  assert.ok(body.indexOf('this.proxyDirty = true') < body.indexOf('runPS(apply.script'), '必须在 apply 之前置位');
});

t('restoreProxy 以 proxyDirty 为准而非 applied，且失败不清快照', () => {
  const body = manager.slice(manager.indexOf('private async restoreProxy'), manager.indexOf('private async killProcess'));
  assert.match(body, /if \(!this\.proxyDirty \|\| !this\.snapshot\)/, '恢复门槛不是 proxyDirty');
  assert.ok(!/if \(!this\.status\.systemProxy\.applied/.test(body), '仍在用 applied 当恢复门槛');
  // 清除只允许出现在成功分支里，catch 之后不得再无条件清空
  const success = body.slice(body.indexOf('await this.runPS(script.script'), body.indexOf('} catch (e)'));
  assert.match(success, /this\.snapshot = null/, '成功后未清快照');
  const catchPart = body.slice(body.indexOf('} catch (e)'));
  assert.ok(!/this\.snapshot = null/.test(catchPart), '恢复失败仍清空了快照');
});

t('退出竞态：stopInternal 等待 in-flight，不再直接 return', () => {
  const body = manager.slice(manager.indexOf('private async stopInternal'), manager.indexOf('private async doStop'));
  assert.match(body, /if \(this\.stopInFlight\) \{ await this\.stopInFlight; return; \}/, '未等待进行中的 stop');
  assert.ok(!/if \(this\.stopping\) return;/.test(body), '仍在 stopping 时直接返回');
});

t('恢复失败不谎报「系统设置已恢复」', () => {
  assert.match(manager, /proxyFailed.*systemProxy.*restored/, '未根据恢复结果选择文案');
  assert.match(manager, /系统代理恢复失败，请按日志手动还原/, '缺少失败提示');
});

/* ── 内核下载 ── */
t('原子替换先备份旧内核，失败回滚', () => {
  assert.match(downloader, /const backupFinal = finalPath \+ '\.old'/, '未定义备份路径');
  const body = downloader.slice(downloader.indexOf('const hadOld'), downloader.indexOf('if (hadOld) { try { fs.rmSync(backupFinal'));
  assert.match(body, /fs\.renameSync\(finalPath, backupFinal\)/, '未先改名旧内核');
  assert.match(body, /fs\.renameSync\(tmpFinal, finalPath\)/, '未扶正新内核');
  assert.match(body, /renameSync\(backupFinal, finalPath\)/, '失败未回滚旧内核');
  assert.ok(!/fs\.rmSync\(finalPath, \{ force: true \}\);\s*\n\s*fs\.renameSync\(tmpFinal/.test(downloader), '仍是先删后写');
});

t('下载失败清理压缩包与解压目录', () => {
  const at = downloader.indexOf('// 失败不留半截文件');
  assert.ok(at >= 0, '缺少失败清理注释块');
  const body = downloader.slice(at, downloader.indexOf('return fail(`下载', at));
  assert.match(body, /\[partPath, archivePath\]/, '未清理压缩包');
  assert.match(body, /fs\.rmSync\(extractDir, \{ recursive: true, force: true \}\)/, '未清理解压目录');
});

/* ── 遥测 ── */
t('Xray 遥测成功路径走 finish，关闭会话与定时器', () => {
  const body = telemetry.slice(telemetry.indexOf("req.on('close'"), telemetry.indexOf("req.write(EMPTY_QUERY_STATS_FRAME)"));
  assert.match(body, /finish\(true, parseQueryStats/, '成功分支直接 resolve，未走 finish');
  assert.ok(!/\n\s*resolve\(parseQueryStats/.test(body), '仍在成功分支裸 resolve');
  // 从 queryXrayStats 内部切片，避免匹配到文件里其他 finish 定义
  const q = telemetry.indexOf('export function queryXrayStats');
  const finishBody = telemetry.slice(telemetry.indexOf('const finish =', q), telemetry.indexOf('const timer =', q));
  assert.match(finishBody, /clearTimeout\(timer\)/, 'finish 未清定时器');
  assert.match(finishBody, /session\?\.close\(\)/, 'finish 未关会话');
});

/* ── IPC ── */
t('runtime:open-dir 有 try/catch，不向渲染层抛 reject', () => {
  const body = main.slice(main.indexOf("ipcMain.handle('runtime:open-dir'"), main.indexOf('内核二进制下载'));
  assert.match(body, /try \{/, '缺少 try');
  assert.match(body, /catch \(e\)/, '缺少 catch');
  assert.match(body, /return \{ ok: false, error:/, '失败未返回可识别对象');
});

t('geo:lookup 所有分支结构一致（results + queried）', () => {
  const body = main.slice(main.indexOf("ipcMain.handle('geo:lookup'"), main.indexOf('内核运行层 IPC'));
  // 逐行匹配 return，避免嵌套的 results:{} 截断正则
  const returns = body.split('\n').filter(l => /return \{/.test(l));
  assert.ok(returns.length >= 3, `return 分支数异常：${returns.length}`);
  for (const r of returns) {
    // 兼容显式 results:{} 与 ES 简写属性 results
    assert.match(r, /\bresults\b/, `分支缺 results：${r.trim()}`);
    assert.match(r, /\bqueried\b/, `分支缺 queried：${r.trim()}`);
  }
});

/* ── UI / 数据 ── */
t('清空节点需二次确认，且确认态有视觉区分', () => {
  assert.match(proxyList, /clearArmed/, '无二次确认状态');
  assert.match(proxyList, /if \(!clearArmed\.value\)[\s\S]{0,200}return/, '首次点击直接返回');
  assert.match(proxyList, /再点一次确认/, '按钮无确认文案');
  assert.match(proxyList, /btn\.danger\.armed/, '确认态无视觉提示');
  assert.ok(!/@click="store\.clearAll\(\)"/.test(proxyList), '仍有裸清空按钮');
});

t('节点缓存做字段级校验，脏节点不带病启动', () => {
  assert.match(store, /function validCachedNode/, '无校验函数');
  const body = store.slice(store.indexOf('function validCachedNode'), store.indexOf('watch([nodes'));
  for (const field of ['issues', 'lossless', 'kernels', 'extras', 'raw', 'source']) {
    assert.ok(body.includes(`o.${field}`), `未校验字段 ${field}`);
  }
  assert.match(body, /\.filter\(validCachedNode\)/, '未过滤脏节点');
});

/* ── 测试链 ── */
t('UI 冒烟断言用新文案「节点管家」', () => {
  assert.match(uiSmoke, /"nodes": "节点管家"/, '仍是旧文案');
  assert.ok(!/节点管理/.test(uiSmoke), '还残留旧文案');
});

t('UI 冒烟失败时非零退出', () => {
  assert.match(uiSmoke, /sys\.exit\(main\(\)\)/, '未用退出码');
  assert.match(uiSmoke, /return 0 if ok == len\(TABS\) else 1/, '失败仍返回 0');
});

t('hygiene 与 UI 测试都进 npm test 链', () => {
  assert.match(pkg.scripts.test, /test:hygiene/, 'hygiene 未进链');
  assert.match(pkg.scripts.test, /test:ui/, 'UI 冒烟未进链');
  assert.ok(pkg.scripts['test:hygiene'], 'test:hygiene 未定义');
  assert.match(uiSmoke, /dist["']?, ["']?index\.html/, 'UI 测试未校验 dist 产物存在');
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) { for (const [n, e] of failures) console.error(`✗ ${n}\n  ${e.message}`); process.exit(1); }
