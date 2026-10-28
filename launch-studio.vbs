' ACE-Step Studio - lanceur Windows sans fenetre de console.
' Le raccourci du Bureau et du menu Demarrer lance ce script (par wscript.exe) : seule la page web s'ouvre, comme sous Linux.
' Le serveur tourne dans une console cachee, et fermer la page arrete le Studio (--quit-on-close).
'
' Les journaux du serveur sont ecrits dans logs\studio-last-run.log (le fichier est refait a chaque lancement). Pour les voir
' en direct, lancez run.bat dans une fenetre de commandes, comme avant. En cas d'erreur, ce fichier s'ouvre tout seul.
'
' "< nul" : sans fenetre, un "pause" de run.bat attendrait une touche pour toujours ; ainsi il passe son chemin.
Option Explicit

Dim fso, sh, root, logDir, logFile, q, cmd, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

logDir = root & "\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logFile = logDir & "\studio-last-run.log"

q = Chr(34)
cmd = "cmd /c " & q & q & root & "\run.bat" & q & " --quit-on-close > " & q & logFile & q & " 2>&1 < nul" & q

' 0 = fenetre cachee, True = on attend la fin du Studio.
rc = sh.Run(cmd, 0, True)

If rc <> 0 Then
    MsgBox "ACE-Step Studio s'est arrete avec une erreur (code " & rc & ")." & vbCrLf & vbCrLf & _
           "Le journal va s'ouvrir : " & logFile, 48, "ACE-Step Studio"
    sh.Run "notepad.exe " & q & logFile & q, 1, False
End If
