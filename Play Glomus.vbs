' Starts Glomus (and the local model, if it isn't running) and opens it in the browser.
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
shell.Run "node """ & root & "\server\server.js""", 0, False
