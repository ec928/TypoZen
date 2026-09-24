using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace TypoZen
{
    /// <summary>
    /// Extensions > Qwen narration > Install: sets the narrator up from nothing.
    ///
    /// TypoZen's part is small: check the machine, fetch a Python of its own into the extension
    /// folder, create the extension's environment from it, and run tools\qwen-narrator\install.py
    /// with that. The script
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

        /// <summary>
        /// The Python the narrator runs on, fetched into the extension folder rather than taken
        /// from the PC: nothing to install first, nothing registered with Windows, and an
        /// uninstalled system Python cannot break narration (an environment made from one would
        /// stop working). A python-build-standalone build -- portable CPython, with venv and
        /// pip -- pinned and checked. python.org's "embeddable" package has neither.
        /// </summary>
        private const string PythonUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/20260924/cpython-3.11.16%2B20260924-x86_64-pc-windows-msvc-install_only_stripped.tar.gz";
        private const string PythonSha256 = "f86b3cbd425e1c446b56aa24e20a7be1223c1a8146e5e3a68c8e18d08b76e810";

        public static string OwnPython(string cacheDir)
        {
            return Path.Combine(QwenNarrator.RootDir(cacheDir), "python", "python.exe");
        }

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

        /// <summary>Why this machine cannot install it now, or null.</summary>
        public static string Preflight(string cacheDir)
        {
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
            string tar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "tar.exe");
            if (!File.Exists(tar))
                return "This version of Windows has no tar.exe (Windows 10 1803 and later do), which the install needs.";
            return null;
        }

        /// <summary>
        /// The extension's own Python, fetched and checked if it is not there yet. Null when it
        /// is ready, "cancelled", or why not.
        /// </summary>
        private string EnsurePython(string root, ExtensionInstaller.Progress report, Action<string> note)
        {
            string dir = Path.Combine(root, "python");
            string exe = Path.Combine(dir, "python.exe");
            if (File.Exists(exe)) return null;
            string archive = Path.Combine(root, "python.tar.gz");
            report(0, 0, "Downloading Python");
            Download(PythonUrl, archive, (done, total) => report(done, total, "Downloading Python"));
            if (_cancel) return "cancelled";
            string sha;
            using (var h = System.Security.Cryptography.SHA256.Create())
            using (var s = File.OpenRead(archive))
                sha = BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
            if (sha != PythonSha256)
            {
                File.Delete(archive);
                return "The Python download did not match its checksum, so it was discarded.";
            }
            report(0, 0, "Unpacking Python");
            string part = Path.Combine(root, "python.part");
            if (Directory.Exists(part)) Directory.Delete(part, true);
            Directory.CreateDirectory(part);
            string tar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "tar.exe");
            int code = Run(tar, "-xzf \"" + archive + "\" -C \"" + part + "\"", root, note, null);
            if (_cancel) return "cancelled";
            string unpacked = Path.Combine(part, "python");      // the archive holds one folder, python\
            if (code != 0 || !File.Exists(Path.Combine(unpacked, "python.exe")))
                return "Python could not be unpacked (see install.log).";
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.Move(unpacked, dir);
            Directory.Delete(part, true);
            File.Delete(archive);
            code = Run(exe, "-c \"import sys, venv, ensurepip; print(sys.version)\"", root, note, null);
            if (code != 0) return "The downloaded Python does not run (see install.log).";
            note("python ready: " + exe);
            return null;
        }

        /// <summary>A plain download, stopping when cancelled. report(done, total).</summary>
        private void Download(string url, string dest, Action<long, long> report)
        {
            System.Net.ServicePointManager.SecurityProtocol = System.Net.SecurityProtocolType.Tls12;
            var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(url);
            req.UserAgent = "TypoZen";
            req.Timeout = 30000;
            req.ReadWriteTimeout = 60000;
            using (var resp = req.GetResponse())
            using (var src = resp.GetResponseStream())
            using (var dst = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
            {
                long total = resp.ContentLength, n = 0;
                var buf = new byte[1 << 16];
                int read;
                while ((read = src.Read(buf, 0, buf.Length)) > 0)
                {
                    if (_cancel) return;
                    dst.Write(buf, 0, read);
                    n += read;
                    report(n, total > 0 ? total : 0);
                }
            }
        }

        /// <summary>
        /// Runs the install. report(done, total, text): bytes when total &gt; 0, otherwise just
        /// what is happening. Returns null when it is ready, "cancelled", or why it failed.
        /// </summary>
        public string Install(string cacheDir, string appDir, ExtensionInstaller.Progress report)
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
                note("---- install: app " + appDir);

                string venvPython = Path.Combine(root, "venv", "Scripts", "python.exe");
                if (!File.Exists(venvPython))
                {
                    string why = EnsurePython(root, report, note);
                    if (why != null) return why;
                    string python = OwnPython(cacheDir);
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
