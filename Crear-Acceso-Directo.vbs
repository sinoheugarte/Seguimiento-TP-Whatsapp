Dim WshShell, oShortcut, ScriptDir, Desktop

Set WshShell = CreateObject("WScript.Shell")
ScriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
Desktop = WshShell.SpecialFolders("Desktop")

Set oShortcut = WshShell.CreateShortcut(Desktop & "\Seguimiento TP.lnk")
oShortcut.TargetPath = ScriptDir & "Iniciar-TP.vbs"
oShortcut.WorkingDirectory = Left(ScriptDir, Len(ScriptDir) - 1)
oShortcut.Description = "Iniciar Seguimiento TP en segundo plano"
oShortcut.IconLocation = "C:\Windows\System32\shell32.dll, 14"
oShortcut.Save

Set oShortcut = WshShell.CreateShortcut(Desktop & "\Detener Seguimiento TP.lnk")
oShortcut.TargetPath = ScriptDir & "Detener-TP.vbs"
oShortcut.WorkingDirectory = Left(ScriptDir, Len(ScriptDir) - 1)
oShortcut.Description = "Detener Seguimiento TP"
oShortcut.IconLocation = "C:\Windows\System32\shell32.dll, 27"
oShortcut.Save

MsgBox "Accesos directos creados en el Escritorio:" & Chr(13) & Chr(13) & _
       "  - Seguimiento TP (inicia en segundo plano)" & Chr(13) & _
       "  - Detener Seguimiento TP", vbInformation, "Seguimiento TP"
