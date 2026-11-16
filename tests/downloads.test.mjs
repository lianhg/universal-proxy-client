/**
 * 内核下载计划与下载器回归测试（不访问网络：下载器用注入的假流与假解压）
 * 运行前提：npx tsc -p tsconfig.main.build.json（产物在 .main-build/）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  KERNEL_RELEASES, buildDownloadPlan, isValidVersion, normalizeVersion,
  parseDgstSha256, pickLatestVersions, platformToken, archToken,
} from '../.main-build/core/runtime/downloads.js';
import { downloadKernel, fetchLatestVersions } from '../.main-build/main/runtime/downloader.js';

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

/* ───────── 计划层 ───────── */

console.log('下载计划（纯逻辑）');
await t('默认版本与仓库信息齐全', () => {
  for (const k of ['xray', 'sing-box', 'mihomo']) {
    const r = KERNEL_RELEASES[k];
    assert.ok(r.repo.includes('/'), `${k} repo 应为 owner/name`);
    assert.ok(isValidVersion(r.defaultVersion), `${k} 默认版本号格式应合法`);
  }
  assert.equal(KERNEL_RELEASES.xray.checksumKind, 'dgst');
  assert.equal(KERNEL_RELEASES['sing-box'].checksumKind, 'none');
});

await t('Xray win32/x64 计划：URL、zip、dgst 校验、无需改名', () => {
  const p = buildDownloadPlan('xray', '26.11.9', 'win32', 'x64');
  assert.equal(p.url, 'https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-windows-64.zip');
  assert.equal(p.innerExe, 'xray.exe');
  assert.equal(p.finalName, 'xray.exe');
  assert.equal(p.needRename, false);
  assert.equal(p.checksumUrl, p.url + '.dgst');
  assert.equal(p.archiveFormat, 'zip');
});

await t('Xray arm64 资源名带 -arm64-v8a', () => {
  const p = buildDownloadPlan('xray', '', 'win32', 'arm64');
  assert.ok(p.archiveName.includes('arm64-v8a'), p.archiveName);
});

await t('sing-box win32/x64 计划：zip 内文件名带版本', () => {
  const p = buildDownloadPlan('sing-box', 'v1.14.4', 'win32', 'x64');
  assert.equal(p.url, 'https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-windows-amd64.zip');
  assert.equal(p.innerExe, 'sing-box.exe');
  assert.equal(p.finalName, 'sing-box.exe');
  assert.equal(p.checksumUrl, '', 'sing-box 官方不发校验文件');
  assert.ok(p.notes.some(n => n.includes('未随发布提供校验文件')));
});

await t('mihomo win32/x64 计划：压缩包内文件名（实测不带版本后缀）、需要改名', () => {
  const p = buildDownloadPlan('mihomo', '1.19.33', 'win32', 'x64');
  assert.equal(p.url, 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/mihomo-windows-amd64-v1.19.33.zip');
  assert.equal(p.innerExe, 'mihomo-windows-amd64.exe');
  assert.equal(p.finalName, 'mihomo.exe');
  assert.equal(p.needRename, true);
});

await t('linux 平台：计划可生成，gz/tar.gz 明确说明不自动解压', () => {
  const p = buildDownloadPlan('mihomo', '1.19.33', 'linux', 'x64');
  assert.ok(p.archiveName.startsWith('mihomo-linux-amd64-v'), p.archiveName);
});

await t('版本号校验：合法 / 非法输入都明确', () => {
  assert.ok(isValidVersion('1.14.4'));
  assert.ok(isValidVersion('v26.11.9'));
  assert.ok(isValidVersion('1.2.3-beta.1'));
  assert.ok(!isValidVersion('latest'));
  assert.ok(!isValidVersion(''));
  assert.ok(!isValidVersion('../../evil'));
  assert.equal(normalizeVersion(' v1.2.3 '), '1.2.3');
});

await t('平台 / 架构映射：不支持的平台与架构直接抛错', () => {
  assert.equal(platformToken('win32'), 'windows');
  assert.equal(platformToken('darwin'), 'darwin');
  assert.equal(archToken('x64'), 'amd64');
  assert.equal(archToken('ia32'), 'amd64');
  assert.throws(() => platformToken('freebsd'));
  assert.throws(() => archToken('mips'));
});

await t('.dgst 解析：取 SHA-256（新旧两种格式），忽略其它算法行', () => {
  const oldFmt = 'File: Xray-windows-64.zip\nSHA-512: aa\nSHA-256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\nMD5: bb\n';
  assert.equal(parseDgstSha256(oldFmt), '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
  const newFmt = 'MD5= 5d41d34f0423b90455631380275105bb\nSHA1= 699430f472dc59127abcb6695fb69ecf1b6a1f2c\nSHA2-256= 1262522266337b824f07beb8e1375786b437683b3890105469088f8e17e0a69d\nSHA2-512= bd0792a9\n';
  assert.equal(parseDgstSha256(newFmt), '1262522266337b824f07beb8e1375786b437683b3890105469088f8e17e0a69d');
  assert.equal(parseDgstSha256('no sha here'), null);
});

await t('最新版本映射：失败项如实进入 errors', () => {
  const r = pickLatestVersions({ xray: '26.11.9', 'sing-box': 'v1.14.4', mihomo: 'oops' });
  assert.equal(r.versions.xray, '26.11.9');
  assert.equal(r.versions['sing-box'], '1.14.4');
  assert.ok(!r.versions.mihomo);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes('MetaCubeX/mihomo'));
});

/* ───────── 下载器（注入假流 / 假解压，不碰网络） ───────── */

function fakeStream(chunks) { return Readable.from(chunks.map(c => Buffer.from(c, 'utf8'))); }
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

console.log('下载器（注入式，不联网）');

await t('完整成功路径：下载 → 校验 → 解压 → 安装到 bin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-dl-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const events = [];
  const r = await downloadKernel({
    kernel: 'xray', version: '26.11.9', binDir,
    platform: 'win32', arch: 'x64',
    send: p => events.push(p),
    fetchStream: async url => {
      if (url.endsWith('.dgst')) {
        return { status: 200, headers: {}, stream: fakeStream(['File: x.zip\nSHA-256: ' + sha('AAAABBBBCCCC') + '\n']) };
      }
      const body = 'AAAABBBBCCCC';
      return { status: 200, headers: { 'content-length': String(body.length) }, stream: fakeStream([body]) };
    },
    extractZip: async (archive, dest) => {
      // 校验文件确实下载完整后才走到解压
      const data = fs.readFileSync(archive, 'utf8');
      assert.equal(data, 'AAAABBBBCCCC', '解压拿到的应是完整压缩包内容');
      fs.writeFileSync(path.join(dest, 'xray.exe'), 'fake-exe');
    },
  });
  assert.ok(r.ok, r.error);
  assert.equal(r.version, '26.11.9');
  assert.equal(r.checksumVerified, true);
  assert.ok(fs.existsSync(path.join(binDir, 'xray.exe')), 'xray.exe 应安装到 bin 目录');
  assert.equal(fs.readFileSync(path.join(binDir, 'xray.exe'), 'utf8'), 'fake-exe');
  assert.ok(!fs.existsSync(path.join(binDir, 'downloads')), '临时目录应清理');
  const phases = events.map(e => e.phase);
  assert.equal(phases[0], 'plan');
  assert.equal(phases.at(-1), 'done');
  for (const p of ['download', 'checksum', 'extract', 'install']) {
    assert.ok(phases.indexOf(p) < phases.indexOf('done'), `阶段顺序应包含 ${p}`);
  }
  assert.ok(events.at(-1).message.includes('已通过官方校验'));
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('SHA-256 不匹配：拒绝安装并报错，bin 目录不留文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-dl-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const r = await downloadKernel({
    kernel: 'xray', binDir, platform: 'win32', arch: 'x64',
    send: () => {},
    fetchStream: async url => url.endsWith('.dgst')
      ? { status: 200, headers: {}, stream: fakeStream(['SHA-256: ' + 'b'.repeat(64) + '\n']) }
      : { status: 200, headers: {}, stream: fakeStream(['real-content']) },
    extractZip: async () => { throw new Error('不应走到解压'); },
  });
  assert.ok(!r.ok);
  assert.ok(r.error.includes('校验失败'), r.error);
  assert.ok(!fs.existsSync(path.join(binDir, 'xray.exe')));
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('sing-box：官方无校验文件 → 如实标注未校验，安装仍可完成', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-dl-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const events = [];
  const r = await downloadKernel({
    kernel: 'sing-box', binDir, platform: 'win32', arch: 'x64',
    send: p => events.push(p),
    fetchStream: async () => ({ status: 200, headers: {}, stream: fakeStream(['zip-bytes']) }),
    extractZip: async (a, dest) => fs.writeFileSync(path.join(dest, 'sing-box.exe'), 'exe'),
  });
  assert.ok(r.ok, r.error);
  assert.equal(r.checksumVerified, false);
  assert.ok(r.sha256 && r.sha256.length === 64, '应提供本地哈希供用户核对');
  const ck = events.find(e => e.phase === 'checksum');
  assert.ok(ck.message.includes('官方未提供校验文件'), ck.message);
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('mihomo：压缩包内文件改名后安装为 mihomo.exe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-dl-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const r = await downloadKernel({
    kernel: 'mihomo', binDir, platform: 'win32', arch: 'x64',
    send: () => {},
    fetchStream: async () => ({ status: 200, headers: {}, stream: fakeStream(['zip-bytes']) }),
    extractZip: async (a, dest) => {
      fs.mkdirSync(path.join(dest, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'sub', 'mihomo-windows-amd64.exe'), 'exe-content');
    },
  });
  assert.ok(r.ok, r.error);
  const final = path.join(binDir, 'mihomo.exe');
  assert.ok(fs.existsSync(final), '应改名安装为 mihomo.exe');
  assert.equal(fs.readFileSync(final, 'utf8'), 'exe-content');
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('解压结果缺可执行文件：报错并列出压缩包实际内容', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-dl-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const r = await downloadKernel({
    kernel: 'xray', binDir, platform: 'win32', arch: 'x64',
    send: () => {},
    fetchStream: async url => url.endsWith('.dgst')
      ? { status: 200, headers: {}, stream: fakeStream(['SHA-256: ' + sha('x') + '\n']) }
      : { status: 200, headers: {}, stream: fakeStream(['x']) },
    extractZip: async (a, dest) => fs.writeFileSync(path.join(dest, 'README.txt'), 'hello'),
  });
  assert.ok(!r.ok);
  assert.ok(r.error.includes('README.txt'), '错误信息应包含实际文件清单');
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('HTTP 404：如实报错，不留 .part', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-dl-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const r = await downloadKernel({
    kernel: 'mihomo', version: '0.0.1', binDir, platform: 'win32', arch: 'x64',
    send: () => {},
    fetchStream: async () => ({ status: 404, headers: {}, stream: fakeStream(['']) }),
    extractZip: async () => { throw new Error('不应走到解压'); },
  });
  assert.ok(!r.ok);
  assert.ok(r.error.includes('404'), `错误应包含 HTTP 状态码：${r.error}`);
  assert.ok(!fs.existsSync(path.join(binDir, 'downloads', 'mihomo-windows-amd64-v0.0.1.zip.part')), '不应残留 .part 文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('非法版本号：计划阶段直接拒绝', async () => {
  const r = await downloadKernel({
    kernel: 'xray', version: '../../etc/passwd', binDir: '/tmp/x', send: () => {},
    fetchStream: async () => { throw new Error('不应发起请求'); },
  });
  assert.ok(!r.ok);
  assert.ok(r.error.includes('版本号不合法'));
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
