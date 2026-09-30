// AI-Office-Setup.exe 의 본체. 안에 든 payload.zip 을 임시 폴더에 풀고 install.ps1 을 실행한다.
// Windows 에 기본으로 들어 있는 csc.exe(.NET Framework 4.x)로 빌드한다 — scripts/build-installer.ps1 참고.
//   AI-Office-Setup.exe [--yes] [--prefix <폴더>] [--no-shortcuts] [--no-autostart] [--no-launch]
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

internal static class Setup
{
    private static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        Console.Title = "AI-Office 설치";
        bool yes = false;
        var extra = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i].ToLowerInvariant())
            {
                case "--yes": case "-y": yes = true; extra.Append(" -Yes"); break;
                case "--prefix": if (i + 1 < args.Length) extra.Append(" -Prefix \"").Append(args[++i]).Append('"'); break;
                case "--no-shortcuts": extra.Append(" -NoShortcuts"); break;
                case "--no-autostart": extra.Append(" -NoAutostart"); break;
                case "--no-launch": extra.Append(" -NoLaunch"); break;
            }
        }

        string tmp = Path.Combine(Path.GetTempPath(), "ai-office-setup-" + Guid.NewGuid().ToString("N"));
        int code = 1;
        try
        {
            Directory.CreateDirectory(tmp);
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (s == null) { Console.WriteLine("설치 파일이 손상되었습니다(payload 없음)."); return 1; }
                using (var z = new ZipArchive(s, ZipArchiveMode.Read)) z.ExtractToDirectory(tmp);
            }
            var psi = new ProcessStartInfo("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(tmp, "install.ps1") + "\" -SourceDir \"" + tmp + "\"" + extra)
            { UseShellExecute = false };
            using (Process p = Process.Start(psi)) { p.WaitForExit(); code = p.ExitCode; }
        }
        catch (Exception e)
        {
            Console.WriteLine("설치하지 못했습니다: " + e.Message);
        }
        finally
        {
            try { Directory.Delete(tmp, true); } catch { }
        }
        if (!yes) { Console.WriteLine(); Console.Write("엔터를 누르면 이 창을 닫습니다…"); Console.ReadLine(); }
        return code;
    }
}
