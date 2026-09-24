using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace TypoZen
{
    /// <summary>
    /// Extensions > Qwen narration > Install: sets the narrator up from nothing.
    ///
    /// TypoZen's part is small: check the machine, create the extension's Python environment
    /// from an installed Python 3.11, and run tools\qwen-narrator\install.py with it. That script
    /// does the rest -- the pinned packages, the two models at pinned revisions, the speaker
    /// encoder, hard links -- and reports line by line (STEP, PROGRESS, NOTE, ERROR, DONE), which
    /// is relayed here. Everything it prints also goes to install.log in the extension folder.
    ///
    /// install.part in the extension folder marks an install that has not finished; while it is
    /// there the extension does not count as installed. Stopping part-way keeps what has been
    /// downloaded, and Install again continues from there.
    /// </summary>
    internal sealed class QwenInstaller
    {
        /// <summary>Downloads, measured 2026-09-24: packages 4.8 GB, models 8.4 GB.</summary>
        public const long DownloadBytes = 13L * 1024 * 1024 * 1024;
        private const long NeedFree = 16L * 1024 * 1024 * 1024;

        private volatile bool _cancel;
        private Process _proc;
        private readonly object _gate = new object();

        public void Cancel()
        {
            _cancel = true;
            lock (_gate) { KillTree(_proc); }
        }

        public static string InstallFlag(string cacheDir)
        {
            return Path.Combine(QwenNarrator.RootDir(cacheDir), "install.part");
        }

        /// <summary>Why this machine cannot install it now, or null. Finds the Python to use.</summary>
        public static string Preflight(string cacheDir, out string python)
        {
            python = null;
            string smi = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "nvidia-smi.exe");
            if (!File.Exists(smi))
                return "Qwen narration needs an NVIDIA graphics card, and no NVIDIA driver was found on this PC.";
            try
            {
                string root = QwenNarrator.RootDir(cacheDir);
                var drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(root)));
                long have = 0;
                try { if (Directory.Exists(root)) foreach (var f in new DirectoryInfo(root).GetFiles("*", SearchOption.AllDirectories)) have += f.Length; }
                catch { }
                long need = Math.Max(1L << 30, NeedFree - have);
                if (drive.AvailableFreeSpace < need)
                    return "Qwen narration needs about " + (need >> 30) + " GB free on " + drive.Name
                         + " and there is " + (drive.AvailableFreeSpace >> 30) + " GB.";
            }
            catch { }
            python = FindPython();
            if (python == null)
                return "Qwen narration needs Python 3.11, which is not installed. Install it from python.org "
                     + "(the 64-bit Windows installer), then press Install again.";
            return null;
        }

        /// <summary>An installed Python 3.11: through the py launcher, else where python.org puts it.</summary>
        public static string FindPython()
        {
            try
            {
                string py = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "py.exe");
                if (File.Exists(py))
                {
                    var psi = new ProcessStartInfo(py, "-3.11 -c \"import sys; print(sys.executable)\"")
                    {
                        UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
                    };
                    using (var p = Process.Start(psi))
                    {
                        string o = p.StandardOutput.ReadToEnd().Trim();
                        if (p.WaitForExit(10000) && p.ExitCode == 0 && File.Exists(o)) return o;
                    }
                }
            }
            catch { }
            foreach (string c in new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Python", "Python311", "python.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Python311", "python.exe")
            })
                if (File.Exists(c)) return c;
            return null;
        }

        /// <summary>
        /// Runs the install. report(done, total, text): bytes when total &gt; 0, otherwise just
        /// what is happening. Returns null when it is ready, "cancelled", or why it failed.
        /// </summary>
        public string Install(string cacheDir, string appDir, string python, ExtensionInstaller.Progress report)
        {
            string root = QwenNarrator.RootDir(cacheDir);
            string log = Path.Combine(root, "install.log");
            string last = null;
            bool done = false;
            try
            {
                Directory.CreateDirectory(root);
                File.WriteAllText(InstallFlag(cacheDir), DateTime.Now.ToString("s"), new UTF8Encoding(false));
                Action<string> note = line =>
                {
                    try { File.AppendAllText(log, DateTime.Now.ToString("HH:mm:ss ") + line + Environment.NewLine, new UTF8Encoding(false)); }
                    catch { }
                };
                note("---- install: python " + python + ", app " + appDir);

                string venvPython = Path.Combine(root, "venv", "Scripts", "python.exe");
                if (!File.Exists(venvPython))
                {
                    report(0, 0, "Creating the Python environment");
                    int code = Run(python, "-m venv \"" + Path.Combine(root, "venv") + "\"", root, note, null);
                    if (_cancel) return "cancelled";
                    if (code != 0 || !File.Exists(venvPython)) return "The Python environment could not be created (see install.log).";
                }

                string script = Path.Combine(appDir, "tools", "qwen-narrator", "install.py");
                if (!File.Exists(script)) return "install.py is missing from this copy of TypoZen.";
                string stage = "Starting";
                int exit = Run(venvPython, "-u \"" + script + "\" --root \"" + root + "\"", Path.GetDirectoryName(script), note, line =>
                {
                    if (line.StartsWith("STEP ")) { stage = line.Substring(5); report(0, 0, stage); }
                    else if (line.StartsWith("PROGRESS "))
                    {
                        var p = line.Split(new[] { ' ' }, 4);
                        long d, t;
                        if (p.Length >= 3 && long.TryParse(p[1], out d) && long.TryParse(p[2], out t))
                            report(d, t, stage);
                    }
                    else if (line.StartsWith("NOTE ")) report(0, 0, stage + " - " + line.Substring(5));
                    else if (line.StartsWith("ERROR ")) last = line.Substring(6);
                    else if (line.StartsWith("DONE")) done = true;
                });
                if (_cancel) return "cancelled";
                if (exit != 0 || !done) return last ?? ("The install stopped (exit code " + exit + "; see install.log).");
                File.Delete(InstallFlag(cacheDir));
                note("---- install finished");
                return null;
            }
            catch (Exception ex)
            {
                return _cancel ? "cancelled" : ex.Message;
            }
        }

        /// <summary>Runs one process to its end, every output line to the log and to onLine.</summary>
        private int Run(string exe, string args, string cwd, Action<string> log, Action<string> onLine)
        {
            var psi = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = cwd,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            psi.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";
            psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            var p = new Process { StartInfo = psi };
            DataReceivedEventHandler handle = (s, e) =>
            {
                if (e.Data == null) return;
                log(e.Data);
                if (onLine != null) try { onLine(e.Data); } catch { }
            };
            p.OutputDataReceived += handle;
            p.ErrorDataReceived += handle;
            lock (_gate)
            {
                if (_cancel) return -1;
                p.Start();
                _proc = p;
            }
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            lock (_gate) { _proc = null; }
            return p.ExitCode;
        }

        /// <summary>The process and everything it started: pip and python children included.</summary>
        private static void KillTree(Process p)
        {
            if (p == null) return;
            try
            {
                if (p.HasExited) return;
                using (var k = Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + p.Id) { UseShellExecute = false, CreateNoWindow = true }))
                    k.WaitForExit(10000);
            }
            catch { }
        }
    }
}
