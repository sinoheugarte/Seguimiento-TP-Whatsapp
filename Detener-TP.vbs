Option Explicit
' Detiene el servidor de Seguimiento TP que corre en segundo plano.

Dim wmi, procesos, p, linea, n
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procesos = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name = 'node.exe'")
n = 0
For Each p In procesos
  linea = LCase(p.CommandLine & "")
  If InStr(linea, "src\index.js") > 0 Or InStr(linea, "src/index.js") > 0 Then
    p.Terminate
    n = n + 1
  End If
Next

If n > 0 Then
  MsgBox "Seguimiento TP se detuvo correctamente." & vbCrLf & _
         "El bot y las programaciones quedan en pausa hasta que vuelvas a iniciarlo.", vbInformation, "Seguimiento TP"
Else
  MsgBox "Seguimiento TP no estaba en ejecución.", vbInformation, "Seguimiento TP"
End If
