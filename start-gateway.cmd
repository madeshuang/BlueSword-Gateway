@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 24.13.0 或更高版本。
  pause
  exit /b 1
)
node scripts\start-local.cjs --gateway
if errorlevel 1 pause
