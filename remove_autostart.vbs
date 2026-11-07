Option Explicit
' Undo setup_autostart.vbs: remove only the shortcut this project created.

Dim fso, sh, lnkPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

lnkPath = sh.SpecialFolders("Startup") & "\MarketDashboard.lnk"

If fso.FileExists(lnkPath) Then
  fso.DeleteFile lnkPath, True
  MsgBox "Auto-start removed.", 64, "Market Dashboard"
Else
  MsgBox "Auto-start was not installed.", 48, "Market Dashboard"
End If
