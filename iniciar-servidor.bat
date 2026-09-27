@echo off
REM Inicia o servidor local do aplicativo de inspecao.
REM Basta dar duplo clique neste arquivo.
title Inspecao de Campo - servidor local
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0servidor.ps1"
pause
