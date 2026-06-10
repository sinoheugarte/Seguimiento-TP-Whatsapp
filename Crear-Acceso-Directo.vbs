Dim WshShell, oShortcut, ScriptDir, Desktop

Set WshShell = CreateObject("WScript.Shell")
ScriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
Desktop = WshShell.SpecialFolders("Desktop")

' Crear acceso directo en el escritorio
Set oShortcut = WshShell.CreateShortcut(Desktop & "\Seguimiento TP.lnk")
oShortcut.TargetPath = ScriptDir & "Iniciar-TP.vbs"
oShortcut.WorkingDirectory = Left(ScriptDir, Len(ScriptDir) - 1)
oShortcut.Description = "Iniciar Seguimiento TP — WhatsApp + Email"
oShortcut.IconLocation = "C:\Windows\System32\shell32.dll, 14"
oShortcut.Save

MsgBox "Acceso directo creado en el Escritorio." & Chr(13) & Chr(13) & "Busca el icono 'Seguimiento TP' en tu escritorio.", vbInformation, "Seguimiento TP"
