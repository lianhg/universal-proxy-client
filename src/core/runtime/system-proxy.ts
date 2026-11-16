/**
 * 内核运行层 —— 系统代理脚本（纯字符串逻辑，便于测试）
 *
 * 铁律：改动前必须保存原始快照，断开 / 退出时按快照精确恢复。
 * 只实现 Windows（本机目标平台）。macOS / Linux 明确返回不支持，绝不静默假装成功。
 * 脚本由主进程写成临时 .ps1 后用 `-File` 执行（不用 -EncodedCommand：
 * 明文脚本便于用户审计，也不会被杀软把 base64 命令当成可疑行为拦掉）。
 */

import type { SystemProxySnapshot } from './types.js';

const REG_PATH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 刷新 WinINET，让已运行的浏览器立刻读到新设置 */
const REFRESH = `
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WinInetRefresh { [DllImport("wininet.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength); }' -ErrorAction SilentlyContinue
  [WinInetRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
  [WinInetRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
} catch { }
`;

export interface ProxyScript {
  script: string;
  platform: string;
  description: string;
}

export function readSystemProxyScript(platform: string): ProxyScript | null {
  if (!platform.startsWith('win')) return null;
  return {
    platform,
    description: '读取当前用户的系统代理原始设置',
    script: `
$ErrorActionPreference = 'SilentlyContinue'
$p = '${REG_PATH}'
$v = Get-ItemProperty -Path $p
[pscustomobject]@{
  proxyEnable   = $v.ProxyEnable
  proxyServer   = $v.ProxyServer
  proxyOverride = $v.ProxyOverride
  autoConfigURL = $v.AutoConfigURL
} | ConvertTo-Json -Compress
`.trim(),
  };
}

export function applySystemProxyScript(platform: string, server: string): ProxyScript | null {
  if (!platform.startsWith('win')) return null;
  return {
    platform,
    description: `启用系统代理 → ${server}（保留原始快照，断开时恢复）`,
    script: `
$ErrorActionPreference = 'Stop'
$p = '${REG_PATH}'
Set-ItemProperty -Path $p -Name ProxyEnable -Value 1 -Type DWord
Set-ItemProperty -Path $p -Name ProxyServer -Value '${server.replace(/'/g, "''")}'
# 本地回环必须绕过代理：否则访问 127.0.0.1 / localhost 会被送回代理端口，
# 内核自己的控制接口、本地调试页面都可能因此连不上。原来有值就合并去重，不整体覆盖。
$need = @('127.0.0.1','localhost','<local>')
$cur = (Get-ItemProperty -Path $p).ProxyOverride
$parts = if ($cur) { @($cur -split ';' | Where-Object { $_ }) } else { @() }
foreach ($n in $need) { if ($parts -notcontains $n) { $parts += $n } }
Set-ItemProperty -Path $p -Name ProxyOverride -Value ($parts -join ';') -Type String
$auto = (Get-ItemProperty -Path $p).AutoConfigURL
if ($auto) { Remove-ItemProperty -Path $p -Name AutoConfigURL }
${REFRESH}
Write-Output 'OK'
`.trim(),
  };
}

export function restoreSystemProxyScript(platform: string, snap: SystemProxySnapshot): ProxyScript | null {
  if (!platform.startsWith('win')) return null;
  const setOrRemove = (name: string, value: string | number | null, type: 'DWord' | 'String') => {
    if (value === null || value === undefined || value === '') {
      return `Remove-ItemProperty -Path $p -Name ${name} -ErrorAction SilentlyContinue`;
    }
    const literal = type === 'DWord' ? String(Number(value) || 0) : `'${String(value).replace(/'/g, "''")}'`;
    return `Set-ItemProperty -Path $p -Name ${name} -Value ${literal}${type === 'DWord' ? ' -Type DWord' : ''}`;
  };
  return {
    platform,
    description: '按启动前的快照恢复系统代理',
    script: `
$ErrorActionPreference = 'SilentlyContinue'
$p = '${REG_PATH}'
${setOrRemove('ProxyEnable', snap.proxyEnable, 'DWord')}
${setOrRemove('ProxyServer', snap.proxyServer, 'String')}
${setOrRemove('ProxyOverride', snap.proxyOverride, 'String')}
${setOrRemove('AutoConfigURL', snap.autoConfigUrl, 'String')}
${REFRESH}
Write-Output 'RESTORED'
`.trim(),
  };
}

/** 解析 read 脚本的 JSON 输出，任何字段缺失都保留为 null（恢复时会删除该键） */
export function parseWindowsSnapshot(stdout: string, platform = 'win32'): SystemProxySnapshot {
  const empty: SystemProxySnapshot = {
    capturedAt: Date.now(), platform,
    proxyEnable: null, proxyServer: null, proxyOverride: null, autoConfigUrl: null,
  };
  const text = String(stdout ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ...empty, raw: text.slice(0, 500) };
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
    const enable = o.proxyEnable === null || o.proxyEnable === undefined ? null : Number(o.proxyEnable);
    return {
      capturedAt: Date.now(), platform,
      proxyEnable: Number.isFinite(enable as number) ? enable : null,
      proxyServer: str(o.proxyServer),
      proxyOverride: str(o.proxyOverride),
      autoConfigUrl: str(o.autoConfigURL ?? o.autoConfigUrl),
      raw: text.slice(0, 500),
    };
  } catch {
    return { ...empty, raw: text.slice(0, 500) };
  }
}

export function systemProxySupported(platform: string): boolean {
  return platform.startsWith('win');
}

/** 生成给用户的手动配置说明（不支持的平台 / 权限不足时展示，不假装成功） */
export function manualProxyHint(platform: string, server: string): string {
  if (platform.startsWith('win')) {
    return `请在「设置 → 网络和 Internet → 代理」中手动设置 HTTP/SOCKS 代理为 ${server}；使用完毕后记得还原。`;
  }
  if (platform === 'darwin') {
    return `当前版本未实现 macOS 自动设置系统代理。请手动在「系统设置 → 网络 → 代理」中填入 ${server}。`;
  }
  return `当前版本未实现 Linux 桌面环境自动设置系统代理。请手动设置 http_proxy / https_proxy / all_proxy 为 ${server}。`;
}
