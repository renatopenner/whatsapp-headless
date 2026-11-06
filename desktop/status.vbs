' Abre o painel de status do whatsapp-headless.
' Se o servico nao estiver no ar, sobe ele escondido e espera responder.
Option Explicit

Dim fso, sh, root, url, nodeExe, cmd, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
url = "http://127.0.0.1:8787/status"

If Not Listening() Then
    nodeExe = "node"
    If fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe") Then
        nodeExe = """" & sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"""
    End If

    cmd = "cmd /c cd /d """ & root & """ && " & nodeExe & " src\server.js >> """ & _
          sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\whatsapp-headless.log"" 2>&1"
    ' 0 = janela oculta, False = nao esperar
    sh.Run cmd, 0, False

    ' espera ate ~30s o servico abrir a porta
    For i = 1 To 60
        WScript.Sleep 500
        If Listening() Then Exit For
    Next
End If

sh.Run url, 1, False

Function Listening()
    Dim http
    Listening = False
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 500, 500, 1000, 1000
    http.open "GET", "http://127.0.0.1:8787/health", False
    http.send
    If Err.Number = 0 Then
        If http.status = 200 Then Listening = True
    End If
    Err.Clear
    On Error GoTo 0
End Function
