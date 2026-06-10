Dim WshShell, ScriptDir, LogFile

Set WshShell = CreateObject("WScript.Shell")
ScriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
LogFile = ScriptDir & "server.log"

' Iniciar npm start sin ventana, guardar log
WshShell.Run "cmd /c cd /d """ & Left(ScriptDir, Len(ScriptDir) - 1) & """ && npm start >> """ & LogFile & """ 2>&1", 0, False

' Esperar a que el servidor arranque
WScript.Sleep 8000

' Abrir el navegador
WshShell.Run "http://localhost:3000"
