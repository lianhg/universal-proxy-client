# 万能代理客户端 卸载
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
