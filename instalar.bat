@echo off
chcp 65001 >nul 2>&1
title Instalador — Seguimiento TP WhatsApp
color 0F
cd /d "%~dp0"

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║       INSTALADOR — Seguimiento TP WhatsApp           ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: ── 1. Verificar Node.js ─────────────────────────────────────────────────────
echo  [1/5] Verificando Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [!] Node.js no está instalado en este equipo.
    echo.
    echo      Descargalo desde:  https://nodejs.org
    echo      Instalá la version LTS ^(recomendada^) y luego
    echo      volvé a ejecutar este instalador.
    echo.
    set /p ABRIR=  ¿Abrír la página de descarga ahora? (S/N):
    if /i "!ABRIR!"=="S" start https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [✓] Node.js %NODE_VER% encontrado

:: ── 2. Verificar npm ─────────────────────────────────────────────────────────
npm --version >nul 2>&1
if errorlevel 1 (
    echo  [!] npm no encontrado. Reinstalá Node.js desde nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm --version') do set NPM_VER=%%v
echo  [✓] npm %NPM_VER% encontrado

:: ── 3. Instalar dependencias ─────────────────────────────────────────────────
echo.
echo  [2/5] Instalando dependencias ^(puede tardar unos minutos^)...
echo  ──────────────────────────────────────────────────────────
npm install
if errorlevel 1 (
    echo.
    echo  [!] Error al instalar dependencias.
    echo  [!] Verificá tu conexión a internet e intentá de nuevo.
    echo.
    pause
    exit /b 1
)
echo  [✓] Dependencias instaladas correctamente

:: ── 4. Crear directorios necesarios ──────────────────────────────────────────
echo.
echo  [3/5] Creando estructura de directorios...
if not exist "knowledge"     mkdir knowledge
if not exist "media"         mkdir media
if not exist ".baileys_auth" mkdir .baileys_auth
echo  [✓] Directorios creados

:: ── 5. Verificar config.json ─────────────────────────────────────────────────
echo.
echo  [4/5] Verificando configuración...
if not exist "config.json" (
    echo  [!] No se encontró config.json
    echo      Copiando configuración por defecto...
    (
        echo {
        echo   "whatsapp": { "grupos": [] },
        echo   "email": {
        echo     "host": "",
        echo     "puerto": 587,
        echo     "usuario": "",
        echo     "contrasena": "",
        echo     "nombreRemitente": "",
        echo     "destinatarios": []
        echo   },
        echo   "agente": {
        echo     "activo": false,
        echo     "proveedor": "anthropic",
        echo     "modelo": "claude-haiku-4-5-20251001",
        echo     "apiKeys": {},
        echo     "instruccionesExtra": "",
        echo     "filtro": "todos",
        echo     "chatsFiltros": [],
        echo     "respuestasRapidas": []
        echo   },
        echo   "programaciones": []
        echo }
    ) > config.json
    echo  [✓] config.json creado con valores por defecto
    echo  [!] Acordate de configurar el email y el agente IA desde el panel web.
) else (
    echo  [✓] config.json encontrado
)

:: ── 6. Crear/actualizar acceso directo ───────────────────────────────────────
echo.
echo  [5/5] Creando acceso directo en el Escritorio...
set "APP_DIR=%~dp0"
set "BAT_PATH=%APP_DIR%Iniciar-TP.bat"
set "SHORTCUT=%USERPROFILE%\Desktop\TP WhatsApp.lnk"
set "ICON=%SystemRoot%\system32\shell32.dll"

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $s = $ws.CreateShortcut('%SHORTCUT%'); ^
   $s.TargetPath = '%BAT_PATH%'; ^
   $s.WorkingDirectory = '%APP_DIR%'; ^
   $s.IconLocation = '%ICON%, 14'; ^
   $s.Description = 'Iniciar TP WhatsApp'; ^
   $s.Save()" >nul 2>&1

if exist "%SHORTCUT%" (
    echo  [✓] Acceso directo "TP WhatsApp" creado en el Escritorio
) else (
    echo  [~] No se pudo crear el acceso directo ^(continuá igual^)
)

:: ── Resumen final ─────────────────────────────────────────────────────────────
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║        ✓  INSTALACIÓN COMPLETADA                     ║
echo  ╠══════════════════════════════════════════════════════╣
echo  ║                                                      ║
echo  ║  Para iniciar la aplicación:                         ║
echo  ║  → Doble clic en "TP WhatsApp" del Escritorio        ║
echo  ║  → O ejecutá directamente "Iniciar-TP.bat"           ║
echo  ║                                                      ║
echo  ║  Luego abrí en el navegador:                         ║
echo  ║       http://localhost:3000                          ║
echo  ║                                                      ║
echo  ║  IMPORTANTE — Primeros pasos:                        ║
echo  ║  1. Escaneá el QR con WhatsApp del celular           ║
echo  ║  2. Configurá el email en la pestaña Ajustes         ║
echo  ║  3. Configurá el Agente IA si lo vas a usar          ║
echo  ║                                                      ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

set /p INICIAR=  ¿Querés iniciar la aplicación ahora? (S/N):
if /i "%INICIAR%"=="S" (
    echo.
    echo  Iniciando...
    timeout /t 2 /nobreak >nul
    start "" "%BAT_PATH%"
)

echo.
echo  Presioná cualquier tecla para cerrar el instalador.
pause >nul
