@echo off
chcp 936 >nul
title Universal Proxy Client - Installer
cd /d "%~dp0"
echo.
echo  Installing Universal Proxy Client ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
