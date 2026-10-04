// LAPIS-Setup.exe — 작은 설치 파일(부트스트래퍼). 설치 창에서 앱 본체와 휴대용 Node 를 내려받아 설치하고 바로가기를 만든다.
// Claude Code·Ollama·Hermes 같은 큰 구성 요소는 설치 뒤 앱의 「시작 마법사」에서 필요한 것만 내려받는다.
// Windows 에 기본으로 들어 있는 csc.exe(.NET Framework 4.x, C# 5)로 빌드한다 — scripts/build-installer.ps1 참고.
//   LAPIS-Setup.exe [--yes] [--quiet] [--prefix <폴더>] [--source <앱 zip 경로 또는 주소>] [--node-zip <경로>]
//                   [--no-shortcuts] [--no-autostart] [--no-launch]
//   --yes: 설치 버튼을 누른 것으로 보고 바로 시작 / --quiet: 창 없이 설치(자동 시험용)
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class Options
{
    public string Prefix = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "AI-Office");
    public string Source;
    public string NodeZip;
    public bool Yes, Quiet, NoShortcuts, NoAutostart, NoLaunch;
}

internal sealed class Installer
{
    private const string Repo = "po3561/ai-office";
    private const string AppAsset = "ai-office-app.zip";
    private const int NodeMajor = 24;
    private readonly Options o;
    private readonly Action<int, string> report;
    private readonly Action<string> log;
    private string logFile;

    public Installer(Options options, Action<int, string> progress, Action<string> logger)
    {
        o = options; report = progress; log = logger;
    }

    private void Say(string text)
    {
        log(text);
        try
        {
            if (logFile != null) File.AppendAllText(logFile, DateTime.Now.ToString("s") + " " + text + Environment.NewLine, Encoding.UTF8);
        }
        catch (Exception) { }
    }

    private static bool AllowedHost(string host)
    {
        host = host.ToLowerInvariant();
        string[] ok = { "github.com", "githubusercontent.com", "nodejs.org" };
        foreach (string h in ok) if (host == h || host.EndsWith("." + h)) return true;
        return false;
    }

    private HttpWebRequest Open(string url)
    {
        Uri u = new Uri(url);
        if (u.Scheme != "https" || !AllowedHost(u.Host)) throw new Exception("허용되지 않은 내려받기 주소입니다: " + u.Host);
        var req = (HttpWebRequest)WebRequest.Create(u);
        req.UserAgent = "lapis-setup";
        req.Timeout = 60000;
        req.ReadWriteTimeout = 60000;
        return req;
    }

    private string DownloadText(string url)
    {
        using (var resp = (HttpWebResponse)Open(url).GetResponse())
        {
            if (!AllowedHost(resp.ResponseUri.Host)) throw new Exception("허용되지 않은 주소로 이동했습니다.");
            using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) return r.ReadToEnd();
        }
    }

    // url(또는 로컬 파일 경로) → dest. 진행률은 from~to 구간에 매핑한다. 해시를 주면 검증한다.
    private void Fetch(string url, string dest, string label, int from, int to, string sha256)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(dest));
        Say(label);
        if (File.Exists(url)) { File.Copy(url, dest, true); }
        else
        {
            using (var resp = (HttpWebResponse)Open(url).GetResponse())
            {
                if (!AllowedHost(resp.ResponseUri.Host)) throw new Exception("허용되지 않은 주소로 이동했습니다.");
                long total = resp.ContentLength;
                using (var src = resp.GetResponseStream())
                using (var dst = File.Create(dest))
                {
                    var buf = new byte[81920];
                    long done = 0;
                    int n;
                    while ((n = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        dst.Write(buf, 0, n);
                        done += n;
                        if (total > 0) report(from + (int)((to - from) * done / total), label + "  " + (done / 1048576) + " / " + (total / 1048576) + " MB");
                    }
                }
            }
        }
        if (!string.IsNullOrEmpty(sha256))
        {
            string actual = Sha256(dest);
            if (!string.Equals(actual, sha256, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(dest);
                throw new Exception("내려받은 파일의 해시가 맞지 않아 폐기했습니다. (" + Path.GetFileName(dest) + ")");
            }
            Say("해시 확인 완료");
        }
        report(to, label);
    }

    private static string Sha256(string file)
    {
        using (var sha = SHA256.Create())
        using (var fs = File.OpenRead(file))
        {
            var hash = sha.ComputeHash(fs);
            var sb = new StringBuilder();
            foreach (byte b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    private static void CopyDir(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (string f in Directory.GetFiles(src)) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
        foreach (string d in Directory.GetDirectories(src)) CopyDir(d, Path.Combine(dst, Path.GetFileName(d)));
    }

    private static string Run(string exe, string args, int timeoutMs)
    {
        var psi = new ProcessStartInfo(exe, args);
        psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.RedirectStandardOutput = true;
        using (Process p = Process.Start(psi))
        {
            string text = p.StandardOutput.ReadToEnd();
            if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch (Exception) { } }
            return text;
        }
    }

    private static void MakeShortcut(string path, string target, string args, string workDir, string icon, string description)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object sh = Activator.CreateInstance(t);
        object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh, new object[] { path });
        Type lt = lnk.GetType();
        lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
        if (args != null) lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { args });
        lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
        lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { description });
        if (icon != null) lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { icon });
        lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
    }

    private static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }

    public int Install()
    {
        string temp = Path.Combine(Path.GetTempPath(), "lapis-setup-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(o.Prefix);
            Directory.CreateDirectory(Path.Combine(o.Prefix, "logs"));
            logFile = Path.Combine(o.Prefix, "logs", "setup.log");
            Directory.CreateDirectory(temp);
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;   // TLS 1.2

            // 1) 앱 본체
            string appZipUrl = o.Source, appSha = null, version = "";
            if (string.IsNullOrEmpty(appZipUrl))
            {
                report(2, "최신 버전을 확인하는 중…");
                var ser = new JavaScriptSerializer();
                var rel = (Dictionary<string, object>)ser.DeserializeObject(DownloadText("https://api.github.com/repos/" + Repo + "/releases/latest"));
                version = Convert.ToString(rel["tag_name"]);
                foreach (object a in (ArrayList)rel["assets"])
                {
                    var asset = (Dictionary<string, object>)a;
                    if (Convert.ToString(asset["name"]) != AppAsset) continue;
                    appZipUrl = Convert.ToString(asset["browser_download_url"]);
                    string digest = asset.ContainsKey("digest") ? Convert.ToString(asset["digest"]) : "";
                    if (digest != null && digest.StartsWith("sha256:")) appSha = digest.Substring(7);
                }
                if (string.IsNullOrEmpty(appZipUrl) || !appZipUrl.StartsWith("https://github.com/" + Repo + "/releases/download/"))
                    throw new Exception("릴리스에서 앱 파일을 찾지 못했습니다.");
                Say("최신 버전 " + version);
            }
            string appZip = Path.Combine(temp, "app.zip");
            Fetch(appZipUrl, appZip, "LAPIS 앱 내려받는 중", 5, 30, appSha);
            string stage = Path.Combine(temp, "app");
            report(31, "압축을 푸는 중…");
            ZipFile.ExtractToDirectory(appZip, stage);
            if (!File.Exists(Path.Combine(stage, "bin", "ai-office.mjs"))) throw new Exception("앱 파일이 올바르지 않습니다.");

            // 2) 휴대용 Node(관리자 권한·winget 불필요)
            string nodeDir = Path.Combine(o.Prefix, "runtime", "node");
            string nodeExe = Path.Combine(nodeDir, "node.exe");
            bool haveNode = false;
            if (File.Exists(nodeExe))
            {
                try { haveNode = int.Parse(Run(nodeExe, "--version", 15000).Trim().TrimStart('v').Split('.')[0]) >= NodeMajor; } catch (Exception) { }
            }
            if (!haveNode)
            {
                string nodeZip = o.NodeZip;
                if (string.IsNullOrEmpty(nodeZip))
                {
                    string arch = (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "").ToUpperInvariant() == "ARM64" ? "win-arm64" : "win-x64";
                    string baseUrl = "https://nodejs.org/dist/latest-v" + NodeMajor + ".x/";
                    report(33, "Node 정보를 확인하는 중…");
                    string name = null, hash = null;
                    foreach (string line in DownloadText(baseUrl + "SHASUMS256.txt").Split('\n'))
                    {
                        string l = line.Trim();
                        if (l.EndsWith("-" + arch + ".zip")) { hash = l.Substring(0, 64); name = l.Substring(l.LastIndexOf(' ') + 1); break; }
                    }
                    if (name == null) throw new Exception("Node 내려받기 정보를 찾지 못했습니다.");
                    nodeZip = Path.Combine(temp, name);
                    Fetch(baseUrl + name, nodeZip, "Node(앱 실행 엔진) 내려받는 중", 35, 80, hash);
                }
                string nodeStage = Path.Combine(temp, "node");
                report(81, "Node 설치 중…");
                ZipFile.ExtractToDirectory(nodeZip, nodeStage);
                string inner = Directory.GetDirectories(nodeStage)[0];
                if (Directory.Exists(nodeDir)) Directory.Delete(nodeDir, true);
                Directory.CreateDirectory(Path.GetDirectoryName(nodeDir));
                Directory.Move(inner, nodeDir);
                if (!File.Exists(nodeExe)) throw new Exception("Node 설치에 실패했습니다.");
            }
            Say("Node 준비 완료: " + nodeExe);

            // 3) 실행 중인 이전 버전 멈추기 → 앱 교체(사무실·봇 데이터는 건드리지 않는다)
            report(85, "앱을 설치하는 중…");
            string app = Path.Combine(o.Prefix, "app");
            string cli = Path.Combine(app, "bin", "ai-office.mjs");
            string launcherExe = Path.Combine(o.Prefix, "LAPIS.exe");
            if (File.Exists(cli)) { try { Run(nodeExe, "\"" + cli + "\" stop", 20000); } catch (Exception) { } }
            foreach (Process p in Process.GetProcessesByName("LAPIS"))
            {
                try { if (string.Equals(p.MainModule.FileName, launcherExe, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(5000); } } catch (Exception) { }
            }
            Thread.Sleep(800);
            foreach (string item in new string[] { "bin", "src", "web", "dashboard", "templates", "scripts", "assets" })
            {
                string from = Path.Combine(stage, item), to = Path.Combine(app, item);
                if (!Directory.Exists(from)) continue;
                if (Directory.Exists(to)) Directory.Delete(to, true);
                CopyDir(from, to);
            }
            foreach (string f in new string[] { "package.json", "README.md", "LICENSE", "install.ps1", "uninstall.ps1" })
            {
                string from = Path.Combine(stage, f);
                if (File.Exists(from)) File.Copy(from, Path.Combine(app, f), true);
            }
            if (string.IsNullOrEmpty(version))
            {
                try { version = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(app, "package.json")))["version"].ToString(); } catch (Exception) { version = "0.0.0"; }
            }
            version = version.TrimStart('v');
            File.WriteAllText(Path.Combine(o.Prefix, "install.json"),
                "{\"version\":\"" + Esc(version) + "\",\"node\":\"" + Esc(nodeExe) + "\",\"app\":\"" + Esc(app) + "\",\"installedAt\":\"" + DateTime.Now.ToString("o") + "\"}", new UTF8Encoding(false));

            // 4) 실행기(LAPIS.exe)
            report(90, "실행기를 만드는 중…");
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("launcher.exe"))
            {
                if (s == null) throw new Exception("설치 파일이 손상되었습니다(실행기 없음).");
                using (var fs = File.Create(launcherExe)) s.CopyTo(fs);
            }
            string icon = Path.Combine(app, "assets", "ai-office.ico");

            // 5) 바로가기·자동 실행
            if (!o.NoShortcuts)
            {
                report(94, "바로가기를 만드는 중…");
                string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "LAPIS");
                Directory.CreateDirectory(startMenu);
                MakeShortcut(Path.Combine(startMenu, "LAPIS.lnk"), launcherExe, null, o.Prefix, icon, "LAPIS — 나의 AI 업무 공간");
                MakeShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "LAPIS.lnk"), launcherExe, null, o.Prefix, icon, "LAPIS — 나의 AI 업무 공간");
                string un = Path.Combine(app, "uninstall.ps1");
                if (File.Exists(un)) MakeShortcut(Path.Combine(startMenu, "LAPIS 제거.lnk"), "powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + un + "\"", o.Prefix, icon, "LAPIS 제거");
            }
            if (!o.NoAutostart)
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                    k.SetValue("LAPIS", "\"" + launcherExe + "\" --tray");
            }
            report(100, "설치가 끝났어요!");
            Say("설치 완료: " + o.Prefix + " (v" + version + ")");
            if (!o.NoLaunch)
            {
                var psi = new ProcessStartInfo(launcherExe); psi.WorkingDirectory = o.Prefix; psi.UseShellExecute = false;
                Process.Start(psi);
            }
            return 0;
        }
        catch (Exception e)
        {
            Say("설치하지 못했습니다: " + e.Message);
            return 1;
        }
        finally
        {
            try { Directory.Delete(temp, true); } catch (Exception) { }
        }
    }
}

internal sealed class SetupForm : Form
{
    private readonly Options o;
    private readonly ProgressBar bar = new ProgressBar();
    private readonly Label status = new Label();
    private readonly TextBox logBox = new TextBox();
    private readonly Button go = new Button();
    private readonly CheckBox desk = new CheckBox();
    private readonly CheckBox auto = new CheckBox();
    private bool done;

    public SetupForm(Options options)
    {
        o = options;
        Text = "LAPIS 설치";
        ClientSize = new Size(540, 400);
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Malgun Gothic", 9.5f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
        var title = new Label { Text = "LAPIS", Font = new Font("Malgun Gothic", 22f, FontStyle.Bold), Left = 24, Top = 16, Width = 480, Height = 44, ForeColor = Color.FromArgb(27, 138, 208) };
        var sub = new Label { Text = "나의 AI 업무 공간을 설치합니다. 앱 본체만 먼저 받고, Claude·Ollama 같은 큰 도구는\r\n설치 뒤 앱에서 필요한 것만 골라 받아요. 관리자 권한은 필요 없어요.", Left = 26, Top = 62, Width = 490, Height = 44, ForeColor = Color.FromArgb(80, 100, 120) };
        desk.Text = "바탕화면에 바로가기 만들기"; desk.Checked = !o.NoShortcuts; desk.Left = 28; desk.Top = 118; desk.Width = 300;
        auto.Text = "컴퓨터를 켜면 자동으로 실행(봇이 계속 일해요)"; auto.Checked = !o.NoAutostart; auto.Left = 28; auto.Top = 144; auto.Width = 400;
        bar.Left = 28; bar.Top = 184; bar.Width = 484; bar.Height = 22; bar.Maximum = 100;
        status.Left = 28; status.Top = 212; status.Width = 484; status.Height = 22; status.Text = "준비됐어요. 「설치」를 눌러 주세요.";
        logBox.Left = 28; logBox.Top = 240; logBox.Width = 484; logBox.Height = 100; logBox.Multiline = true; logBox.ReadOnly = true; logBox.ScrollBars = ScrollBars.Vertical; logBox.Font = new Font("Consolas", 8.5f);
        go.Text = "설치"; go.Left = 396; go.Top = 352; go.Width = 116; go.Height = 32;
        go.Click += delegate { if (done) { Close(); } else { Start(); } };
        Controls.AddRange(new Control[] { title, sub, desk, auto, bar, status, logBox, go });
        if (o.Yes) Shown += delegate { Start(); };
    }

    private void Start()
    {
        go.Enabled = false; desk.Enabled = false; auto.Enabled = false;
        o.NoShortcuts = !desk.Checked; o.NoAutostart = !auto.Checked;
        var inst = new Installer(o,
            delegate (int pct, string text) { BeginInvoke((MethodInvoker)delegate { bar.Value = Math.Max(0, Math.Min(100, pct)); status.Text = text; }); },
            delegate (string line) { BeginInvoke((MethodInvoker)delegate { logBox.AppendText(line + "\r\n"); }); });
        var t = new Thread(delegate ()
        {
            int code = inst.Install();
            BeginInvoke((MethodInvoker)delegate
            {
                done = true; go.Enabled = true; go.Text = "닫기";
                status.Text = code == 0 ? "설치가 끝났어요! LAPIS가 곧 열립니다." : "설치하지 못했어요. 위 기록을 확인하고 다시 시도해 주세요.";
                if (code == 0) { System.Windows.Forms.Timer close = new System.Windows.Forms.Timer(); close.Interval = 2500; close.Tick += delegate { Close(); }; close.Start(); }
            });
        });
        t.IsBackground = true; t.Start();
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var o = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i].ToLowerInvariant())
            {
                case "--yes": case "-y": o.Yes = true; break;
                case "--quiet": o.Quiet = true; o.Yes = true; break;
                case "--prefix": if (i + 1 < args.Length) o.Prefix = args[++i]; break;
                case "--source": if (i + 1 < args.Length) o.Source = args[++i]; break;
                case "--node-zip": if (i + 1 < args.Length) o.NodeZip = args[++i]; break;
                case "--no-shortcuts": o.NoShortcuts = true; break;
                case "--no-autostart": o.NoAutostart = true; break;
                case "--no-launch": o.NoLaunch = true; break;
            }
        }
        if (o.Quiet) return new Installer(o, delegate (int p, string t) { }, delegate (string l) { }).Install();
        Application.EnableVisualStyles();
        Application.Run(new SetupForm(o));
        return 0;
    }
}
