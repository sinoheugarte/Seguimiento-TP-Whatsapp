Option Explicit
' Inicia Seguimiento TP en segundo plano (sin ventana) y abre el panel web.
' Si el servidor ya esta corriendo, solo abre el navegador.

Dim sh, fso, carpeta, url, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:3000"

Function ServidorActivo()
  Dim http
  ServidorActivo = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1500, 1500, 1500, 1500
  http.open "GET", url & "/api/chat/sync", False
  http.send
  If Err.Number = 0 Then ServidorActivo = (http.status = 200)
  Err.Clear
  On Error GoTo 0
End Function

If Not ServidorActivo() Then
  sh.CurrentDirectory = carpeta
  ' Ventana oculta (0); el registro queda en server.log
  sh.Run "cmd /c node src\index.js > server.log 2>&1", 0, False
  For i = 1 To 60
    WScript.Sleep 1000
    If ServidorActivo() Then Exit For
  Next
  If Not ServidorActivo() Then
    MsgBox "El servidor no respondió después de 60 segundos." & vbCrLf & vbCrLf & _
           "Revisa el archivo server.log en:" & vbCrLf & carpeta & vbCrLf & vbCrLf & _
           "O ejecuta Iniciar-TP-Consola.bat para ver el detalle.", vbExclamation, "Seguimiento TP"
    WScript.Quit 1
  End If
End If

sh.Run url
