/**
 * 内核二进制下载计划（纯逻辑，不 import node/electron，可独立测试）
 *
 * 原则：
 * 1. 只描述「从哪下、解压出什么、放到哪」，真正的网络与文件操作在主进程 downloader。
 * 2. 官方没提供校验文件时明确说明，绝不假装校验通过。
 * 3. 版本号与资源命名以 2026-11 官方 Release 实测为准（构建计划对 URL 模板做严格校验）。
 */

import type { KernelType } from '../hub/model.js';

export type PlatformToken = 'windows' | 'darwin' | 'linux';
export type ArchToken = 'amd64' | 'arm64';

export interface KernelReleaseInfo {
  kernel: KernelType;
  repo: string;
  /** 官方 Release 页，用户可自行核对 */
  homepage: string;
  /** 内置默认版本（不带 v 前缀），2026-11 实测的最新稳定版 */
  defaultVersion: string;
  /** 官方是否随发布提供校验文件 */
  checksumKind: 'dgst' | 'none';
}

export const KERNEL_RELEASES: Record<KernelType, KernelReleaseInfo> = {
  xray: {
    kernel: 'xray', repo: 'XTLS/Xray-core', homepage: 'https://github.com/XTLS/Xray-core/releases',
    defaultVersion: '26.11.9', checksumKind: 'dgst',
  },
  'sing-box': {
    kernel: 'sing-box', repo: 'SagerNet/sing-box', homepage: 'https://github.com/SagerNet/sing-box/releases',
    defaultVersion: '1.14.4', checksumKind: 'none',
  },
  mihomo: {
    kernel: 'mihomo', repo: 'MetaCubeX/mihomo', homepage: 'https://github.com/MetaCubeX/mihomo/releases',
    defaultVersion: '1.19.33', checksumKind: 'none',
  },
};

export function normalizeVersion(v: unknown): string {
  return String(v ?? '').trim().replace(/^v/i, '');
}

/** 接受 1.14.4 / v1.14.4 / 1.14.4-beta.1 之类的写法 */
export function isValidVersion(v: unknown): boolean {
  return /^\d+(\.\d+){1,3}(-[\w.]+)?$/.test(normalizeVersion(v));
}

export function platformToken(platform: string): PlatformToken {
  if (platform.startsWith('win')) return 'windows';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  throw new Error(`不支持的平台：${platform}（下载计划仅覆盖 windows / darwin / linux）`);
}

export function archToken(arch: string): ArchToken {
  if (arch === 'x64' || arch === 'amd64' || arch === 'ia32') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`不支持的 CPU 架构：${arch}（下载计划仅覆盖 amd64 / arm64）`);
}

export interface DownloadPlan {
  kernel: KernelType;
  version: string;
  /** 下载地址（GitHub Release 资源直链） */
  url: string;
  archiveName: string;
  /** 压缩包内要安装的可执行文件名 */
  innerExe: string;
  /** 安装到 bin 目录后的最终文件名（与二进制探测层的候选名一致） */
  finalName: string;
  /** 是否需要从 innerExe 改名为 finalName（mihomo 的 Windows 包） */
  needRename: boolean;
  /** 官方校验文件地址；为空表示官方未提供，绝不假装校验过 */
  checksumUrl: string;
  homepage: string;
  /** 压缩包格式：zip 可自动解压；gz / tar.gz 下载后需手动解压（明确提示） */
  archiveFormat: 'zip' | 'gz' | 'tar.gz';
  notes: string[];
}

/**
 * 组装下载计划。任何一步参数非法都直接抛错，绝不返回一个下不下来的 URL。
 */
export function buildDownloadPlan(
  kernel: KernelType,
  version: unknown,
  platform: string,
  arch: string,
): DownloadPlan {
  const info = KERNEL_RELEASES[kernel];
  if (!info) throw new Error(`未知内核：${kernel}`);
  const ver = normalizeVersion(version) || info.defaultVersion;
  if (!isValidVersion(ver)) throw new Error(`版本号不合法：${String(version)}（示例：1.14.4 或 v1.14.4）`);

  const pf = platformToken(platform);
  const ar = archToken(arch);
  const base = `https://github.com/${info.repo}/releases/download/v${ver}/`;
  const notes: string[] = [];

  if (kernel === 'xray') {
    const suffix = ar === 'amd64' ? '64' : 'arm64-v8a';
    const archiveName = `Xray-${pf}-${suffix}.zip`;
    return {
      kernel, version: ver,
      url: base + archiveName,
      archiveName,
      innerExe: pf === 'windows' ? 'xray.exe' : 'xray',
      finalName: pf === 'windows' ? 'xray.exe' : 'xray',
      needRename: false,
      checksumUrl: base + archiveName + '.dgst',
      homepage: info.homepage,
      archiveFormat: 'zip',
      notes: ['官方随发布提供 .dgst 校验文件，下载后会做 SHA-256 完整性校验', ...notes],
    };
  }

  if (kernel === 'sing-box') {
    const archiveName = `sing-box-${ver}-${pf}-${ar}.zip`;
    const innerExe = pf === 'windows' ? 'sing-box.exe' : `sing-box-${ver}-${pf}-${ar}`;
    return {
      kernel, version: ver,
      url: base + archiveName,
      archiveName,
      innerExe,
      finalName: pf === 'windows' ? 'sing-box.exe' : 'sing-box',
      needRename: pf !== 'windows',
      checksumUrl: '',
      homepage: info.homepage,
      archiveFormat: 'zip',
      notes: [
        '官方未随发布提供校验文件：下载完成后会计算本地 SHA-256 并展示，供你与官方渠道自行核对',
        ...(ar === 'amd64' ? ['另有 -legacy-windows-7 变体，仅老系统需要，默认不使用'] : []),
      ],
    };
  }

  // mihomo（2026-11 实测：zip 内文件名不带版本号后缀，与资产名不同）
  const archiveName = `mihomo-${pf}-${ar}-v${ver}.zip`;
  const innerExe = pf === 'windows' ? `mihomo-${pf}-${ar}.exe` : `mihomo-${pf}-${ar}`;
  return {
    kernel, version: ver,
    url: base + archiveName,
    archiveName,
    innerExe,
    finalName: pf === 'windows' ? 'mihomo.exe' : 'mihomo',
    needRename: true,
    checksumUrl: '',
    homepage: info.homepage,
    archiveFormat: 'zip',
    notes: [
      '压缩包内文件名与资产名不同（实测为 mihomo-平台-架构.exe），安装时会改名为 mihomo.exe（探测层认这个名字）',
      '官方未随发布提供校验文件：下载完成后会计算本地 SHA-256 并展示，供你与官方渠道自行核对',
      ...(ar === 'amd64' ? ['另有 -v2 / -v3 / -compatible 微架构变体；默认下通用 amd64 版，绝大多数 CPU 可用'] : []),
    ],
  };
}

/**
 * 解析 Xray 的 .dgst 校验文件，取 SHA-256。
 * 实测存在两种格式（不同年代的发布脚本）：
 *   SHA2-256= <hex>   ← 2026-11 实测当前格式
 *   SHA-256: <hex>    ← 旧格式
 */
export function parseDgstSha256(text: string): string | null {
  const m = text.match(/^SHA2?-256[=:]\s*([0-9a-fA-F]{64})\s*$/m);
  return m ? m[1].toLowerCase() : null;
}

/** 把 GitHub API 的 latest 响应映射成「内核 → 最新版本号」；任何一项失败都如实报错 */
export function pickLatestVersions(
  fetched: Partial<Record<KernelType, unknown>>,
): { versions: Partial<Record<KernelType, string>>; errors: string[] } {
  const versions: Partial<Record<KernelType, string>> = {};
  const errors: string[] = [];
  for (const k of Object.keys(KERNEL_RELEASES) as KernelType[]) {
    const v = normalizeVersion(fetched[k]);
    if (isValidVersion(v)) versions[k] = v;
    else errors.push(`${KERNEL_RELEASES[k].repo}：未能获取最新版本号`);
  }
  return { versions, errors };
}
