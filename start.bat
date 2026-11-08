@echo off
chcp 65001 >nul
cd /d "%~dp0"
title لوحة الدفع العائلية
if not exist node_modules (
  echo تثبيت المكتبات لأول مرة...
  call npm install --omit=dev
)
start "" http://localhost:4600
node --disable-warning=ExperimentalWarning server/index.js
pause
