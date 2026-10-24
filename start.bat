@echo off
chcp 65001 >nul
title Aurora Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] 未找到 Node.js，请先安装 Node.js 20 或更高版本：
  echo       https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   Aurora Launcher 正在启动...
echo.
node src\main.js %*

if errorlevel 1 pause
