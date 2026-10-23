@echo off
chcp 65001 >nul
title DeepMV
cd /d "%~dp0"

if not exist "node_modules" (
  echo [DeepMV] 首次运行，安装依赖...
  call pnpm install --config.strictDepBuilds=false
)

if not exist "web\dist\index.html" (
  echo [DeepMV] 构建前端...
  call pnpm build
)

echo [DeepMV] 启动 http://127.0.0.1:7821
cd server
npx tsx src/index.ts
pause
