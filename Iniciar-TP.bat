@echo off
cd /d "%~dp0"
title Seguimiento TP — Iniciando...
color 0A

echo.
echo  ============================================
echo    Seguimiento TP -- WhatsApp + Email
echo  ============================================
echo.
echo  Iniciando servidor... espera unos segundos.
echo.

REM Abre el servidor en una nueva ventana que permanece visible
start "Seguimiento TP — Servidor" cmd /k "npm start"

REM Espera 8 segundos para que Node.js y WhatsApp inicien
timeout /t 8 /nobreak > nul

REM Abre el navegador en el panel web
start "" "http://localhost:3000"

echo  Panel abierto en: http://localhost:3000
echo.
echo  Puedes cerrar esta ventana.
timeout /t 3 /nobreak > nul
exit
