@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   ============================================
echo     AskAnything · 划词提问服务
echo   ============================================
echo.

rem ---- 检查 node ----
where node >nul 2>nul
if errorlevel 1 (
  echo   [x] 找不到 node 命令。
  echo       请先安装 Node.js: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem ---- 检查主程序 ----
if not exist "ask-server.mjs" (
  echo   [x] 当前目录下没有 ask-server.mjs
  echo       本脚本必须和它放在同一个目录里。
  echo       当前目录: %CD%
  echo.
  pause
  exit /b 1
)

rem ---- 读工作区路径（配置里没有就提示一次）----
for /f "usebackq delims=" %%i in (`node -e "const c=require('./ask.config.json');process.stdout.write(c.workspace||'')" 2^>nul`) do set WS=%%i
if "!WS!"=="" (
  echo   [!] 配置里没有设置 workspace（工作区路径）。
  echo       请编辑 ask.config.json，加上一行，例如：
  echo         "workspace": "D:/Project/我的课程",
  echo       也可以用参数临时指定：askanything.bat --workspace "路径"
  echo.
) else (
  echo   工作区: !WS!
)

rem ---- 启动 ----
echo   服务即将启动，浏览器会自动打开。
echo   关闭本窗口即可停止服务。
echo.
node ask-server.mjs %*

set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo   [x] 服务异常退出，代码 %CODE%
  echo       常见原因：端口被占用、配置 JSON 有语法错误、workspace 路径不存在。
  echo.
  pause
)

endlocal
