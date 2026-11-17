/**
 * 内核二进制下载器（仅主进程使用）
 *
 * 安全与可靠性约定：
 * 1. 下载到 .part 临时文件，校验通过并解压成功后才改名/复制到 bin 目录（原子替换，失败不留半截文件）。
 * 2. Xray 用官方 .dgst 做 SHA-256 校验；sing-box / mihomo 官方不发校验文件，就明确告知「未校验」并展示本地哈希，绝不假装校验过。
 * 3. 支持走本机 HTTP 代理（CONNECT 隧道），也支持直连；失败时如实报告 HTTP 状态与原因。
 * 4. 所有进度通过 runtime:event 推送，用户随时能看到下载到哪一步。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { KernelType } from '../../core/hub/model.js';
import { KERNEL_RELEASES, buildDownloadPlan, parseDgstSha256 } from '../../core/runtime/downloads.js';

const execFileAsync = promisify(execFile);

export interface DownloadProgress {
  kernel: KernelType;
  phase: 'plan' | 'download' | 'checksum' | 'extract' | 'install' | 'done' | 'error';
  /** 已接收字节（download 阶段） */
  received: number;
  /** 总字节（服务器未提供时为 0） */
  total: number;
  message: string;
}

export interface DownloadOptions {
  kernel: KernelType;
  /** 留空用内置默认版本 */
  version?: string;
  binDir: string;
  platform?: string;
  arch?: string;
  /** 可选：走本机 HTTP 代理（例如 http://127.0.0.1:7897） */
  proxyUrl?: string;
  send: (p: DownloadProgress) => void;
  /** 下载被中断（应用退出等） */
  signal?: AbortSignal;
  /** 测试注入：替换真实网络请求函数 */
  fetchStream?: (url: string) => Promise<{ status: number; headers: http.IncomingHttpHeaders; stream: NodeJS.ReadableStream }>;
  /** 测试注入：替换解压函数 */
  extractZip?: (archive: string, destDir: string) => Promise<void>;
}

export interface DownloadResult {
  ok: boolean;
  kernel: KernelType;
  version?: string;
  path?: string;
  sha256?: string;
  checksumVerified?: boolean;
  error?: string;
}

/** 解析 http://127.0.0.1:7897 这类代理地址 */
function parseProxy(url: string): { host: string; port: number } {
  const u = new URL(url);
  if (u.protocol !== 'http:') throw new Error(`仅支持 http:// 形式的代理地址，收到 ${u.protocol}//`);
  const port = Number(u.port || 80);
  if (!u.hostname || !Number.isFinite(port)) throw new Error(`代理地址不合法：${url}`);
  return { host: u.hostname, port };
}

/**
 * 发起 https 请求：直连或经 HTTP 代理 CONNECT 隧道。
 * 自动跟随 301/302/303/307/308 重定向（GitHub Release 会 302 到 objects.githubusercontent.com），最多 5 跳。
 * 返回最终响应对象（不消费 body）。
 */
function requestOnce(url: string, proxyUrl: string | undefined, timeoutMs: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      reject(new Error(`仅支持 https 下载地址，收到 ${target.protocol}//`));
      return;
    }
    const onTimeout = () => reject(new Error(`请求超时（${timeoutMs / 1000}s）：${url}`));
    if (!proxyUrl) {
      const req = https.get(url, { timeout: timeoutMs }, res => resolve(res));
      req.on('timeout', () => { req.destroy(); onTimeout(); });
      req.on('error', reject);
      return;
    }
    const proxy = parseProxy(proxyUrl);
    const req = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${target.hostname}:443`, timeout: timeoutMs,
    });
    req.on('timeout', () => { req.destroy(); onTimeout(); });
    req.on('error', reject);
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 ${proxyUrl} 建立隧道失败：HTTP ${res.statusCode}`));
        return;
      }
      const tlsReq = https.request({
        host: target.hostname, port: 443,
        path: target.pathname + target.search, method: 'GET',
        agent: false, timeout: timeoutMs,
        createConnection: () => socket,
      }, inner => resolve(inner));
      tlsReq.on('timeout', () => { tlsReq.destroy(); onTimeout(); });
      tlsReq.on('error', reject);
      tlsReq.end();
    });
    req.end();
  });
}

async function request(url: string, proxyUrl?: string, timeoutMs = 30000): Promise<http.IncomingMessage> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const res = await requestOnce(current, proxyUrl, timeoutMs);
    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
      const loc = res.headers.location;
      res.resume();
      if (!loc) throw new Error(`HTTP ${res.statusCode} 但未提供 Location（${current}）`);
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error(`重定向次数超过 5 次：${url} → ${current}`);
}

/** 下载 URL 全部内容到内存（仅用于小文件：.dgst 校验文件、GitHub API JSON） */
async function fetchText(url: string, proxyUrl?: string, maxBytes = 1024 * 1024): Promise<string> {
  const res = await request(url, proxyUrl);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? ''}（${url}）`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res) {
    size += (c as Buffer).length;
    if (size > maxBytes) { res.destroy(); throw new Error(`响应超过 ${maxBytes} 字节上限（${url}）`); }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 流式下载到文件，带进度回调；返回计算好的 SHA-256 */
function downloadToFile(
  url: string,
  filePath: string,
  proxyUrl: string | undefined,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number; total: number }> {
  return new Promise((resolve, reject) => {
    void (async () => {
      let res: http.IncomingMessage;
      try { res = await request(url, proxyUrl); }
      catch (e) { reject(e); return; }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`下载失败：HTTP ${res.statusCode} ${res.statusMessage ?? ''}（${url}）`));
        return;
      }
      const total = Number(res.headers['content-length'] ?? 0);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(filePath);
      let received = 0;
      let lastTick = 0;
      res.on('data', (c: Buffer) => {
        if (signal?.aborted) { res.destroy(); out.destroy(); reject(new Error('下载已取消')); return; }
        received += c.length;
        hash.update(c);
        const now = Date.now();
        if (now - lastTick > 300) { lastTick = now; onProgress(received, total); }
      });
      res.on('error', e => { out.destroy(); reject(e); });
      out.on('error', e => reject(e));
      out.on('finish', () => resolve({ sha256: hash.digest('hex'), size: received, total }));
      res.pipe(out);
    })();
  });
}

/** 用系统自带 tar（bsdtar）解压 zip；失败时退回 PowerShell Expand-Archive */
async function extractZipReal(archive: string, destDir: string): Promise<void> {
  try {
    await execFileAsync('tar', ['-xf', archive, '-C', destDir], { timeout: 120_000, windowsHide: true });
    return;
  } catch (e1) {
    const script = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const psFile = path.join(destDir, '_extract.ps1');
    fs.writeFileSync(psFile, script, 'utf8');
    try {
      await execFileAsync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
        { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    } catch (e2) {
      throw new Error(`解压失败：tar：${msg(e1)}；PowerShell：${msg(e2)}`);
    } finally {
      try { fs.rmSync(psFile, { force: true }); } catch { /* 尽力清理 */ }
    }
  }
}

function msg(e: unknown): string { return e instanceof Error ? e.message.slice(0, 160) : String(e); }

/** 递归找文件名（解压后可能带子目录） */
function findFileDeep(dir: string, name: string): string | null {
  let found: string | null = null;
  const walk = (d: string) => {
    if (found) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.toLowerCase() === name.toLowerCase()) { found = p; return; }
    }
  };
  walk(dir);
  return found;
}

function fmtMB(bytes: number): string { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

/**
 * 下载并安装一个内核二进制。每一步失败都会如实报告并清理临时文件。
 */
export async function downloadKernel(opts: DownloadOptions): Promise<DownloadResult> {
  const { kernel, binDir, send } = opts;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const fetchStream = opts.fetchStream;
  const extractZip = opts.extractZip ?? extractZipReal;
  const tempDir = path.join(binDir, 'downloads');

  const fail = (error: string): DownloadResult => {
    send({ kernel, phase: 'error', received: 0, total: 0, message: error });
    return { ok: false, kernel, error };
  };

  let plan: ReturnType<typeof buildDownloadPlan>;
  try {
    plan = buildDownloadPlan(kernel, opts.version, platform, arch);
  } catch (e) {
    return fail(`下载计划无法生成：${msg(e)}`);
  }

  send({ kernel, phase: 'plan', received: 0, total: 0, message: `准备下载 ${kernel} v${plan.version}（${fmtMB(0)}→${plan.archiveName}）` });

  fs.mkdirSync(tempDir, { recursive: true });
  const archivePath = path.join(tempDir, plan.archiveName);
  const partPath = archivePath + '.part';
  const extractDir = path.join(tempDir, `extract-${kernel}`);

  try {
    // ── 1. 下载压缩包 ──
    send({ kernel, phase: 'download', received: 0, total: 0, message: `开始下载 ${plan.archiveName}${opts.proxyUrl ? `（经代理 ${opts.proxyUrl}）` : '（直连）'}` });
    let sha256: string;
    let size = 0;
    if (fetchStream) {
      // 测试注入路径：行为与真实下载保持一致（同样落盘、同样算哈希）
      const r = await fetchStream(plan.url);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}（${plan.url}）`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(partPath);
      for await (const c of r.stream as NodeJS.ReadableStream) {
        const b = c as Buffer;
        size += b.length; hash.update(b);
        if (!out.write(b)) await new Promise<void>(res => out.once('drain', () => res()));
      }
      await new Promise<void>(res => out.end(res));
      sha256 = hash.digest('hex');
      fs.renameSync(partPath, archivePath);
    } else {
      // 网络抖动（ECONNRESET / ETIMEDOUT 等）自动重试，最多 3 次，指数退避
      const RETRYABLE = /ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up/i;
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await downloadToFile(plan.url, partPath, opts.proxyUrl, (received, total) => {
            send({
              kernel, phase: 'download', received, total,
              message: `下载中 ${fmtMB(received)}${total ? ` / ${fmtMB(total)}` : ''}`,
            });
          }, opts.signal);
          sha256 = r.sha256; size = r.size;
          break;
        } catch (e) {
          const m = msg(e);
          if (attempt < 3 && RETRYABLE.test(m) && !opts.signal?.aborted) {
            send({ kernel, phase: 'download', received: 0, total: 0, message: `网络中断（${m}），${attempt}s 后重试（第 ${attempt + 1}/3 次）` });
            await new Promise(r2 => setTimeout(r2, attempt * 1000));
            continue;
          }
          throw e;
        }
      }
    }
    if (!fetchStream) fs.renameSync(partPath, archivePath);
    send({ kernel, phase: 'download', received: size, total: size, message: `下载完成：${fmtMB(size)}` });

    // ── 2. 校验 ──
    let checksumVerified = false;
    if (plan.checksumUrl) {
      send({ kernel, phase: 'checksum', received: size, total: size, message: '正在核对官方 SHA-256…' });
      let dgst = '';
      if (fetchStream) {
        // 测试注入路径：校验文件也走注入流，不碰真实网络
        const r = await fetchStream(plan.checksumUrl);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}（${plan.checksumUrl}）`);
        for await (const c of r.stream as NodeJS.ReadableStream) dgst += (c as Buffer).toString('utf8');
      } else {
        dgst = await fetchText(plan.checksumUrl, opts.proxyUrl);
      }
      const expected = parseDgstSha256(dgst);
      if (!expected) throw new Error('官方 .dgst 文件里找不到 SHA-256 条目（内容异常，已中止安装）');
      if (expected !== sha256) {
        throw new Error(`SHA-256 校验失败：官方 ${expected}，实际 ${sha256}。文件可能损坏或被篡改，已拒绝安装`);
      }
      checksumVerified = true;
      send({ kernel, phase: 'checksum', received: size, total: size, message: `SHA-256 校验通过（官方 .dgst）` });
    } else {
      send({ kernel, phase: 'checksum', received: size, total: size, message: `官方未提供校验文件。本地 SHA-256 = ${sha256}（供你与官方渠道自行核对）` });
    }

    // ── 3. 解压 ──
    if (plan.archiveFormat !== 'zip') {
      // 非 Windows 平台的 .gz / .tar.gz：不装懂，下载已就位，明确交给用户手动解压
      send({ kernel, phase: 'extract', received: size, total: size, message: `${plan.archiveFormat} 格式暂不支持自动解压：压缩包已下载到 ${archivePath}，请手动解压出 ${plan.innerExe} 放到 ${binDir}` });
      return { ok: false, kernel, version: plan.version, path: archivePath, sha256, checksumVerified, error: `暂不支持自动解压 ${plan.archiveFormat}（压缩包已保留在 ${archivePath}）` };
    }
    send({ kernel, phase: 'extract', received: size, total: size, message: '正在解压…' });
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(archivePath, extractDir);

    // ── 4. 安装（找到可执行文件 → 原子复制/改名到 bin）──
    send({ kernel, phase: 'install', received: size, total: size, message: `正在安装 ${plan.finalName} 到 ${binDir}` });
    const inner = findFileDeep(extractDir, plan.innerExe);
    if (!inner) {
      const names: string[] = [];
      const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { names.push(e.name); if (e.isDirectory()) walk(path.join(d, e.name)); } };
      walk(extractDir);
      throw new Error(`解压结果里没有找到 ${plan.innerExe}。压缩包实际包含：${names.slice(0, 20).join('、')}`);
    }
    const finalPath = path.join(binDir, plan.finalName);
    const tmpFinal = finalPath + '.new';
    const backupFinal = finalPath + '.old';
    fs.copyFileSync(inner, tmpFinal);
    // 原子替换：先把可用旧内核改名为备份，再把新文件扶正，最后删备份。
    // 绝不能「先删旧文件再改名新文件」——内核正被占用时 rm 会因 EPERM 失败，
    // 或 rm 成功而 rename 失败，两种情况都会让原本可用的内核彻底丢失。
    const hadOld = fs.existsSync(finalPath);
    let swapped = false;
    try {
      if (hadOld) {
        fs.rmSync(backupFinal, { force: true });
        fs.renameSync(finalPath, backupFinal);
      }
      fs.renameSync(tmpFinal, finalPath);
      swapped = true;
    } catch (e) {
      // 任一步失败都尽力把旧内核还原，保证至少还有一个能用的二进制
      try { fs.rmSync(tmpFinal, { force: true }); } catch { /* 尽力 */ }
      if (hadOld && !fs.existsSync(finalPath) && fs.existsSync(backupFinal)) {
        try { fs.renameSync(backupFinal, finalPath); } catch { /* 尽力 */ }
      }
      throw e;
    }
    if (hadOld) { try { fs.rmSync(backupFinal, { force: true }); } catch { /* 尽力 */ } }
    send({ kernel, phase: 'done', received: size, total: size, message: `${kernel} v${plan.version} 安装完成：${finalPath}${checksumVerified ? '（已通过官方校验）' : ''}` });

    // 清理临时产物（保留压缩包便于复查？删除更干净 —— 保留 dgst 无意义，删临时目录与压缩包）
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 尽力 */ }

    return { ok: true, kernel, version: plan.version, path: finalPath, sha256, checksumVerified };
  } catch (e) {
    // 失败不留半截文件：下载中的 .part、已落盘的压缩包、解压目录统统清理。
    // 校验失败 / 疑似被篡改的压缩包尤其不能留在磁盘上被人误用。
    for (const p of [partPath, archivePath]) {
      try { fs.rmSync(p, { force: true }); } catch { /* 尽力 */ }
    }
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
    return fail(`下载 / 安装失败：${msg(e)}`);
  }
}

/** 查询三个内核的最新版本号（GitHub API）。任何一项失败都如实返回错误，不用缓存顶替。 */
export async function fetchLatestVersions(proxyUrl?: string): Promise<{
  versions: Partial<Record<KernelType, string>>;
  errors: string[];
}> {
  const kernels = Object.keys(KERNEL_RELEASES) as KernelType[];
  const versions: Partial<Record<KernelType, string>> = {};
  const errors: string[] = [];
  await Promise.all(kernels.map(async k => {
    const repo = KERNEL_RELEASES[k].repo;
    try {
      const text = await fetchText(`https://api.github.com/repos/${repo}/releases/latest`, proxyUrl);
      const tag = (JSON.parse(text) as { tag_name?: string }).tag_name ?? '';
      const ver = tag.replace(/^v/, '');
      if (/^\d+(\.\d+){1,3}(-[\w.]+)?$/.test(ver)) versions[k] = ver;
      else errors.push(`${repo}：返回的 tag 不像版本号（${tag}）`);
    } catch (e) {
      errors.push(`${repo}：${msg(e)}`);
    }
  }));
  return { versions, errors };
}
