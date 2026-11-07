Option Explicit
' Start the dashboard in the background with no console window.
' Logs are written to logs\server.log by start.bat (silent mode).

Dim fso, sh, here, bat
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
bat = here & "\start.bat"

If Not fso.FileExists(bat) Then
  MsgBox "start.bat not found in " & here, 16, "Market Dashboard"
  WScript.Quit 1
End If

sh.Run """" & bat & """ silent", 0, False
