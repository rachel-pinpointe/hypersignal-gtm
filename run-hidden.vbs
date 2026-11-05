' HyperSignal-Hiring - start the server with NO console window, then open the dashboard.
' The server runs invisibly in the background; all output is saved to run.log next to this file.
' To stop it later, double-click "stop-signal-engine.cmd" (or the Stop Signal Engine desktop icon).
Option Explicit
Dim sh, fso, base
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
' Keep the previous run's log as run.prev.log before starting — the old ">" truncated it on every
' launch, so whatever crashed the last session was erased exactly when it was needed for diagnosis.
On Error Resume Next
If fso.FileExists(base & "\run.log") Then
  If fso.FileExists(base & "\run.prev.log") Then fso.DeleteFile base & "\run.prev.log", True
  fso.MoveFile base & "\run.log", base & "\run.prev.log"
End If
On Error Goto 0
' 0 = hidden window, False = don't wait. Logs still captured to run.log so nothing is lost.
sh.Run "cmd /c npm run start > ""run.log"" 2>&1", 0, False
' Give the server a few seconds to start listening, then open the dashboard in the browser.
WScript.Sleep 8000
sh.Run "http://localhost:4000", 1, False
