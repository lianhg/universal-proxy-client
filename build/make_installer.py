# -*- coding: utf-8 -*-
"""生成不依赖 NSIS 的安装/卸载脚本（纯文件安装 + 快捷方式 + 卸载注册项）

版本号不在脚本里硬编码：读取 package.json 的 version 填入 __APP_VERSION__，
避免升级后「控制面板 → 程序和功能」还显示 1.0.0。
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def app_version() -> str:
    """从 package.json 取当前版本，失败时退回 0.0.0（不让脚本生成失败）"""
    try:
        data = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
        return str(data.get('version') or '0.0.0')
    except Exception:
        return '0.0.0'

INSTALL_PS1 = r'''# 万能代理客户端 一键安装（不依赖 NSIS，纯文件安装）
$ErrorActionPreference = 'Stop'
$AppName = '万能代理客户端'

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '   万能代理客户端  一键安装' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

# --- 1. 定位源文件 ---
$candidates = @(
  (Join-Path $PSScriptRoot 'win-unpacked'),
  (Join-Path $PSScriptRoot 'release\win-unpacked'),
  $PSScriptRoot
)
$SrcDir = $null
foreach ($c in $candidates) {
  if (Test-Path (Join-Path $c '万能代理客户端.exe')) { $SrcDir = $c; break }
}
if (-not $SrcDir) {
  Write-Host '[错误] 找不到 win-unpacked 目录（里面应有 万能代理客户端.exe）' -ForegroundColor Red
  Write-Host '       请先运行 打包.bat 选 [2] 打出绿色版，再运行本安装脚本。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '按回车键退出'
  exit 1
}
Write-Host "[1/5] 源目录: $SrcDir"

# --- 2. 关闭正在运行的实例 ---
$running = Get-Process -Name '万能代理客户端' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "[2/5] 检测到正在运行的实例，正在关闭..." -ForegroundColor Yellow
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
} else {
  Write-Host '[2/5] 无运行中的实例'
}

# --- 3. 复制文件 ---
$DestDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
Write-Host "[3/5] 安装到: $DestDir"
if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $DestDir -Force | Out-Null

& robocopy.exe $SrcDir $DestDir /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) {
  Write-Host "[错误] 文件复制失败（robocopy 退出码 $rc）" -ForegroundColor Red
  Write-Host '       常见原因：目标文件被占用，或杀毒软件拦截。请关闭程序后重试。' -ForegroundColor Yellow
  Read-Host '按回车键退出'
  exit 1
}
$exePath = Join-Path $DestDir '万能代理客户端.exe'
if (-not (Test-Path $exePath)) {
  Write-Host '[错误] 复制后未找到主程序 exe' -ForegroundColor Red
  Read-Host '按回车键退出'
  exit 1
}
$sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
Write-Host "      主程序就绪（$sizeMB MB）"

# 附带卸载脚本
Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') (Join-Path $DestDir 'uninstall.ps1') -Force -ErrorAction SilentlyContinue

# --- 4. 创建快捷方式 ---
Write-Host '[4/5] 创建快捷方式...'
$ws = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppName.lnk")
)
foreach ($lnk in $targets) {
  try {
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $exePath
    $s.WorkingDirectory = $DestDir
    $s.IconLocation = "$exePath,0"
    $s.Description = '多内核全能代理管理工具'
    $s.Save()
    Write-Host "      OK  $lnk"
  } catch {
    Write-Host "      跳过（$lnk）：$($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# --- 5. 写入卸载注册项（当前用户，不需要管理员）---
Write-Host '[5/5] 注册卸载信息...'
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"
try {
  if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Set-ItemProperty -Path $regPath -Name 'DisplayName'     -Value $AppName
  Set-ItemProperty -Path $regPath -Name 'DisplayVersion'  -Value '__APP_VERSION__'
  Set-ItemProperty -Path $regPath -Name 'Publisher'       -Value 'Universal Proxy Client'
  Set-ItemProperty -Path $regPath -Name 'InstallLocation' -Value $DestDir
  Set-ItemProperty -Path $regPath -Name 'DisplayIcon'     -Value "$exePath,0"
  Set-ItemProperty -Path $regPath -Name 'UninstallString' -Value "`"$powershell`" -ExecutionPolicy Bypass -File `"$DestDir\uninstall.ps1`""
  Set-ItemProperty -Path $regPath -Name 'NoModify'        -Value 1 -Type DWord
  Set-ItemProperty -Path $regPath -Name 'NoRepair'        -Value 1 -Type DWord
  $sz = (Get-ChildItem $DestDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
  Set-ItemProperty -Path $regPath -Name 'EstimatedSize'   -Value ([int]($sz / 1KB)) -Type DWord
  Write-Host '      OK  已写入"应用和功能"列表'
} catch {
  Write-Host "      注册表写入失败（不影响使用）：$($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host '   安装完成！' -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
Write-Host "  程序位置: $exePath"
Write-Host '  桌面和开始菜单已创建快捷方式'
Write-Host '  卸载：设置 → 应用 → 万能代理客户端 → 卸载'
Write-Host ''
$go = Read-Host '现在启动程序？(Y/n)'
if ($go -ne 'n' -and $go -ne 'N') {
  Start-Process -FilePath $exePath -WorkingDirectory $DestDir
  Write-Host '已启动。如果没有窗口出现，请查看日志：' -ForegroundColor Yellow
  Write-Host "  $env:APPDATA\$AppName\logs\startup.log" -ForegroundColor Yellow
  Start-Sleep -Seconds 2
}
'''

UNINSTALL_PS1 = r'''# 万能代理客户端 卸载
$ErrorActionPreference = 'SilentlyContinue'
$AppName = '万能代理客户端'
$DestDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"

Write-Host ''
Write-Host '正在卸载 万能代理客户端 ...' -ForegroundColor Cyan

Get-Process -Name $AppName | Stop-Process -Force
Start-Sleep -Milliseconds 800

# 快捷方式
foreach ($lnk in @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppName.lnk")
)) { Remove-Item $lnk -Force }

# 注册项
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName" -Recurse -Force

# 程序目录
Set-Location $env:TEMP
if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }

Write-Host '卸载完成。' -ForegroundColor Green
Write-Host "用户数据（日志/配置）保留在: $env:APPDATA\$AppName" -ForegroundColor Yellow
Write-Host '如需彻底清除，手动删除上述目录即可。'
Write-Host ''
Read-Host '按回车键退出'
'''

BAT_INSTALL = r'''@echo off
chcp 936 >nul
title Universal Proxy Client - Installer
cd /d "%~dp0"
echo.
echo  Installing Universal Proxy Client ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
'''

BAT_UNINSTALL = r'''@echo off
chcp 936 >nul
title Universal Proxy Client - Uninstaller
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
'''

def write(path: pathlib.Path, text: str, encoding: str):
    path.write_text(text, encoding=encoding)
    print(f"wrote {path.name}  ({encoding})")

write(ROOT / 'install.ps1', INSTALL_PS1.replace('__APP_VERSION__', app_version()), 'utf-8-sig')
write(ROOT / 'uninstall.ps1', UNINSTALL_PS1, 'utf-8-sig')
write(ROOT / '安装.bat', BAT_INSTALL, 'gbk')
write(ROOT / '卸载.bat', BAT_UNINSTALL, 'gbk')
