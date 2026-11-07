Option Explicit
' Optional: create a shortcut in the current user's Startup folder.
' Only affects this Windows account. No registry changes, no admin rights.

Dim fso, sh, here, lnkPath, lnk
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
lnkPath = sh.SpecialFolders("Startup") & "\MarketDashboard.lnk"

If Not fso.FileExists(here & "\run_hidden.vbs") Then
  MsgBox "run_hidden.vbs not found in " & here, 16, "Market Dashboard"
  WScript.Quit 1
End If

Set lnk = sh.CreateShortcut(lnkPath)
lnk.TargetPath       = here & "\run_hidden.vbs"
lnk.WorkingDirectory = here
lnk.Description      = "A-share index and sector flow dashboard (background)"
lnk.Save

MsgBox "Auto-start installed." & vbCrLf & vbCrLf & _
       lnkPath & vbCrLf & vbCrLf & _
       "The dashboard will start hidden at every logon." & vbCrLf & _
       "Run remove_autostart.vbs to undo.", 64, "Market Dashboard"
