' Starts the ChatGPT chat-tool bridge with no console window and detached from the caller, so
' Task Scheduler tearing down its process tree does not stop the services.
Option Explicit
Dim shell, fso, here, command, limit, pattern
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
' 0 = hidden, False = do not wait. node comes from PATH; --minimized keeps Chrome out of the way.
command = "node """ & here & "\manage.mjs"" start --minimized"
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments.Count <> 1 Then WScript.Quit 2
  Set pattern = New RegExp
  pattern.Pattern = "^[1-9][0-9]?$"
  If Not pattern.Test(WScript.Arguments(0)) Then WScript.Quit 2
  limit = CLng(WScript.Arguments(0))
  If limit > 82 Then WScript.Quit 2
  command = command & " --max-health-get " & CStr(limit)
End If
shell.Run command, 0, False
