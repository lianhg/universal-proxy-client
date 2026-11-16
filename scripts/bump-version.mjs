#!/usr/bin/env node
/**
 * 版本号升版脚本 —— 唯一真源是 package.json 的 version。
 *
 * 用法：
 *   npm run bump -- patch "修复二维码订阅按钮点不动"
 *   npm run bump -- minor "新增规则分流编辑器"
 *   npm run bump -- 1.4.2 "手工指定版本"
 *
 * 做三件事（缺一不可，避免出现「改了没升版」或「界面/安装器版本漂移」）：
 *   1. 改写 package.json 的 version；
 *   2. 重新生成 install.ps1 等安装脚本（由 build/make_installer.py 读取新版本注入）；
 *   3. 在 CHANGELOG.md 顶部插入本版本条目。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'package.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const SECTION = { patch: '修复', minor: '新增', major: '变更' };

function fail(msg) {
  console.error(`[bump] ${msg}`);
  process.exit(1);
}

const [kindArg, ...rest] = process.argv.slice(2);
if (!kindArg) fail('用法：npm run bump -- <patch|minor|major|x.y.z> "一句话说明"');
const note = rest.join(' ').trim();

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const current = String(pkg.version);
const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) fail(`package.json 里的版本号不是合法 semver：${current}`);

let next;
if (['patch', 'minor', 'major'].includes(kindArg)) {
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kindArg === 'patch') patch += 1;
  if (kindArg === 'minor') { minor += 1; patch = 0; }
  if (kindArg === 'major') { major += 1; minor = 0; patch = 0; }
  next = `${major}.${minor}.${patch}`;
} else if (/^\d+\.\d+\.\d+$/.test(kindArg)) {
  next = kindArg;
} else {
  fail(`无法识别的版本类型：${kindArg}`);
}

if (next === current) fail('新版本号与当前相同，没有升版');

// 先校验再写文件：避免出现「package.json 改了、CHANGELOG 没写」的半成品状态
if (!fs.existsSync(CHANGELOG)) fail('缺少 CHANGELOG.md，无法记录本次改动');
const log = fs.readFileSync(CHANGELOG, 'utf8');
if (log.includes(`## [${next}]`)) fail(`CHANGELOG.md 已存在 ${next} 条目，本次不做任何修改`);

// 1. package.json
pkg.version = next;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`[bump] package.json  ${current} → ${next}`);

// 2. 安装脚本（版本号由生成器从 package.json 读取，不手改）
const gen = path.join(ROOT, 'build', 'make_installer.py');
if (fs.existsSync(gen)) {
  let done = false;
  for (const py of ['python', 'py', 'python3']) {
    try {
      execFileSync(py, [gen], { cwd: ROOT, stdio: 'ignore' });
      console.log(`[bump] 已用 ${py} 重新生成 install.ps1 / uninstall.ps1`);
      done = true;
      break;
    } catch { /* 换下一个解释器 */ }
  }
  if (!done) {
    // 生成器跑不了也不让版本号分叉：直接改脚本里的 DisplayVersion
    const ps1 = path.join(ROOT, 'install.ps1');
    if (fs.existsSync(ps1)) {
      const src = fs.readFileSync(ps1, 'utf8');
      const out = src.replace(/(-Name 'DisplayVersion'\s+-Value ')[^']+(')/, `$1${next}$2`);
      if (out !== src) {
        fs.writeFileSync(ps1, out, 'utf8');
        console.log('[bump] 未找到 Python，已直接改写 install.ps1 的 DisplayVersion');
      } else {
        console.warn('[bump] 警告：未能更新 install.ps1 的 DisplayVersion，请手动确认');
      }
    }
  }
}

// 3. CHANGELOG
const today = new Date();
const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const heading = SECTION[kindArg] ?? '变更';
const entry = `## [${next}] - ${date}\n\n### ${heading}\n- ${note || '（待补充：说明这次改了什么）'}\n\n`;
const at = log.search(/^## \[/m);
const updated = at >= 0 ? log.slice(0, at) + entry + log.slice(at) : log.trimEnd() + '\n\n' + entry;
fs.writeFileSync(CHANGELOG, updated, 'utf8');
console.log(`[bump] CHANGELOG.md 已新增 ${next}（${heading}）`);
console.log(`[bump] 完成：v${current} → v${next}`);
console.log('[bump] 下一步：重新打包（npm run electron:pack）并覆盖部署，界面与产物名会自动带上新版本号');
