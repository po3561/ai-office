' AI-Office launcher: runs node without a console window.
'   wscript.exe launch.vbs "<path to node.exe>" "<path to ai-office.mjs>" <serve|open>
If WScript.Arguments.Count < 3 Then WScript.Quit 1
Set sh = CreateObject("WScript.Shell")
sh.Run """" & WScript.Arguments(0) & """ """ & WScript.Arguments(1) & """ " & WScript.Arguments(2), 0, False
