/**
 * 内核二进制探测（仅 Electron 主进程使用）
 *
 * 找不到二进制时明确说明「该把哪个文件放到哪个目录」，绝不假装内核可用。
 * 搜索优先级：用户手工指定 > 应用数据目录 > 项目 bin 目录 > 环境变量 > PATH。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { KernelType } from '../../core/hub/model.js';
import type { BinaryInventory, KernelBinary, RuntimeSettings } from '../../core/runtime/types.js';
import { KERNEL_BIN_NAMES } from '../../core/runtime/types.js';

const execFileAsync = promisify(execFile);
const KERNELS: KernelType[] = ['xray', 'sing-box', 'mihomo'];

export function binDirOf(userData: string): string {
  return path.join(userData, 'bin');
}

export function runtimeDirOf(userData: string): string {
  return path.join(userData, 'runtime');
}

export function ensureRuntimeDirs(userData: string): { binDir: string; runtimeDir: string } {
  const binDir = binDirOf(userData);
  const runtimeDir = runtimeDirOf(userData);
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  return { binDir, runtimeDir };
}

function candidateNames(kernel: KernelType, platform: string): string[] {
  return platform.startsWith('win') ? KERNEL_BIN_NAMES[kernel].win : KERNEL_BIN_NAMES[kernel].unix;
}

/** 从 PATH 里找可执行文件，不依赖 shell 内建命令 */
function findInPath(kernel: KernelType, platform: string): string {
  const sep = platform.startsWith('win') ? ';' : ':';
  const dirs = (process.env.PATH ?? '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const name of candidateNames(kernel, platform)) {
      const p = path.join(dir, name);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* 继续找 */ }
    }
  }
  return '';
}

function findInDir(dir: string, kernel: KernelType, platform: string): string {
  if (!dir) return '';
  for (const name of candidateNames(kernel, platform)) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 继续找 */ }
  }
  return '';
}

async function probeVersion(binPath: string, kernel: KernelType): Promise<string> {
  if (!binPath) return '';
  try {
    const { stdout, stderr } = await execFileAsync(binPath, KERNEL_BIN_NAMES[kernel].versionArgs, {
      timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024,
    });
    const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
    const m = text.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/);
    return m ? m[1] : (text.split('\n')[0] ?? '').slice(0, 80);
  } catch (e) {
    return `无法执行（${e instanceof Error ? e.message.slice(0, 80) : String(e)}）`;
  }
}

/**
 * 扫描三个内核的二进制。不下载、不联网、不自动安装——缺失只报告。
 */
export async function scanBinaries(
  userData: string,
  projectRoot: string,
  settings: RuntimeSettings,
): Promise<BinaryInventory> {
  const { binDir } = ensureRuntimeDirs(userData);
  const platform = process.platform;
  const items: KernelBinary[] = [];

  for (const kernel of KERNELS) {
    const names = candidateNames(kernel, platform).join(' / ');
    const hint = `把 ${names} 放到 ${binDir}\\ ，或在「设置中心 → 内核运行」里指定可执行文件完整路径。`;
    const manual = settings.binaryPaths[kernel];
    let foundPath = '';
    let source: KernelBinary['source'] = 'none';

    if (manual) {
      try {
        if (fs.statSync(manual).isFile()) { foundPath = manual; source = 'user-specified'; }
      } catch { /* 路径无效，继续按其它来源找 */ }
    }
    if (!foundPath) { foundPath = findInDir(binDir, kernel, platform); if (foundPath) source = 'app-data'; }
    if (!foundPath) { foundPath = findInDir(path.join(projectRoot, 'bin'), kernel, platform); if (foundPath) source = 'project'; }
    if (!foundPath) {
      const envKey = `UPC_${kernel.toUpperCase().replace('-', '_')}_PATH`;
      const envPath = process.env[envKey];
      if (envPath) { try { if (fs.statSync(envPath).isFile()) { foundPath = envPath; source = 'path'; } } catch { /* 忽略 */ } }
    }
    if (!foundPath) { foundPath = findInPath(kernel, platform); if (foundPath) source = 'path'; }

    const version = foundPath ? await probeVersion(foundPath, kernel) : '';
    items.push({
      kernel,
      found: !!foundPath,
      path: foundPath,
      version,
      source,
      reason: foundPath ? undefined : `未找到 ${kernel} 内核可执行文件${manual ? `（指定路径无效：${manual}）` : ''}`,
      hint: foundPath ? undefined : hint,
    });
  }
  return { binDir, items, platform };
}
