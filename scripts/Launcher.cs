// LAPIS.exe — 앱 실행기. 트레이 아이콘을 두고, 엔진과 대시보드를 창 없이 켜고, 앱 창을 연다.
// 봇은 엔진 안에서 돌기 때문에 창을 닫아도 계속 일하고, 트레이의 「종료」를 눌러야 멈춘다.
// Windows 에 기본으로 들어 있는 csc.exe(.NET Framework 4.x, C# 5)로 빌드한다 — scripts/build-installer.ps1 참고.
//   LAPIS.exe [--tray]      --tray: 창은 열지 않고 백그라운드로만 시작(로그인 시 자동 실행)
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Launcher
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private static string root;
    private static string node;
    private static string cli;
    private static NotifyIcon tray;

    private static string ReadJsonString(string json, string key)
    {
        // install.json 은 우리가 쓴 단순한 JSON 이라 가벼운 검색으로 읽는다.
        int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (i < 0) return null;
        i = json.IndexOf(':', i);
        int a = json.IndexOf('"', i + 1);
        int b = a + 1;
        var sb = new System.Text.StringBuilder();
        while (b < json.Length && json[b] != '"')
        {
            if (json[b] == '\\' && b + 1 < json.Length) { b++; }
            sb.Append(json[b]);
            b++;
        }
        return sb.ToString();
    }

    private static bool Locate()
    {
        root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string meta = Path.Combine(root, "install.json");
        node = null;
        if (File.Exists(meta))
        {
            string text = File.ReadAllText(meta);
            node = ReadJsonString(text, "node");
        }
        cli = Path.Combine(root, "app", "bin", "ai-office.mjs");
        if (node == null || !File.Exists(node)) node = Path.Combine(root, "runtime", "node", "node.exe");
        return File.Exists(node) && File.Exists(cli);
    }

    private static int RunCli(string args, bool wait, int timeoutMs)
    {
        var psi = new ProcessStartInfo(node, "\"" + cli + "\" " + args);
        psi.WorkingDirectory = Path.Combine(root, "app");
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        using (Process p = Process.Start(psi))
        {
            if (!wait) return 0;
            if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch (Exception) { } return -1; }
            return p.ExitCode;
        }
    }

    private static bool AutoStartOn()
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey))
        {
            return k != null && k.GetValue("LAPIS") != null;
        }
    }

    private static void SetAutoStart(bool on)
    {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (on) k.SetValue("LAPIS", "\"" + Application.ExecutablePath + "\" --tray");
            else k.DeleteValue("LAPIS", false);
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool trayOnly = Array.IndexOf(args, "--tray") >= 0;
        Application.EnableVisualStyles();
        if (!Locate())
        {
            MessageBox.Show("LAPIS 설치 파일을 찾을 수 없습니다. LAPIS-Setup.exe 로 다시 설치해 주세요.", "LAPIS", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        bool created;
        using (var mutex = new Mutex(true, "Local\\LAPIS-Launcher", out created))
        {
            if (!created)
            {
                // 이미 실행 중이면 앱 창만 연다.
                if (!trayOnly) RunCli("app", true, 60000);
                return 0;
            }
            tray = new NotifyIcon();
            try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { tray.Icon = SystemIcons.Application; }
            tray.Text = "LAPIS — 봇이 일하고 있어요";
            tray.Visible = true;
            var menu = new ContextMenuStrip();
            menu.Items.Add("LAPIS 열기", null, delegate { RunCli("app", false, 0); });
            var auto = new ToolStripMenuItem("컴퓨터를 켜면 자동 실행");
            auto.Checked = AutoStartOn();
            auto.Click += delegate { SetAutoStart(!auto.Checked); auto.Checked = AutoStartOn(); };
            menu.Items.Add(auto);
            menu.Items.Add("다시 시작", null, delegate
            {
                ThreadPool.QueueUserWorkItem(delegate { RunCli("stop", true, 30000); Thread.Sleep(1500); RunCli("app", true, 90000); });
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("종료 (봇도 멈춰요)", null, delegate
            {
                if (MessageBox.Show("LAPIS를 종료하면 실행 중인 봇도 모두 멈춥니다. 종료할까요?", "LAPIS", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                tray.Visible = false;
                RunCli("stop", true, 30000);
                Application.Exit();
            });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { RunCli("app", false, 0); };
            // 트레이를 먼저 보여 주고, 엔진·화면은 뒤에서 켠다(느린 PC에서도 아이콘이 바로 뜬다).
            bool tray2 = trayOnly;
            ThreadPool.QueueUserWorkItem(delegate { RunCli(tray2 ? "app --tray" : "app", true, 90000); });
            Application.Run();
            tray.Visible = false;
            tray.Dispose();
        }
        return 0;
    }
}
