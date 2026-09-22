using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;

namespace TypoZen
{
    /// <summary>
    /// The narration sidecar: starting it, stopping it, and knowing whether it is there.
    ///
    /// The page talks to the sidecar directly over the loopback, because the page already
    /// owns the reading queue and the highlight; relaying the text through here would only
    /// copy it out of one process and back into another. So this class does the two things
    /// the page cannot: own the process, and hand the rendered audio to the WebView through
    /// a virtual host.
    ///
    /// It is started on demand rather than at launch. The weights take seconds to load and
    /// hold a few gigabytes of VRAM, which is not something to spend on a reader who opened
    /// TypoZen to look at a document.
    /// </summary>
    internal static class QwenNarrator
    {
        public const int Port = 8765;
        public const string HostName = "localnarration";
        public static string BaseUrl { get { return "http://127.0.0.1:" + Port; } }

        private static Process _process;
        private static readonly object Gate = new object();

        public static string RootDir(string cacheDir)
        {
            return Path.Combine(ExtensionCatalog.ExtensionsDir(cacheDir), "QwenTTS");
        }

        /// <summary>Where the rendered audio and the group manifests live.</summary>
        public static string CacheDir(string cacheDir)
        {
            return Path.Combine(RootDir(cacheDir), "narration");
        }

        private static string PythonPath(string cacheDir)
        {
            return Path.Combine(RootDir(cacheDir), "venv", "Scripts", "python.exe");
        }

        private static string ScriptPath(string appDir)
        {
            return Path.Combine(appDir, "tools", "qwen-narrator", "sidecar.py");
        }

        /// <summary>
        /// Installed means both halves are present: the environment in the data folder and
        /// the script that ships with the app. Either one alone narrates nothing.
        /// </summary>
        public static bool Installed(string cacheDir, string appDir)
        {
            try { return File.Exists(PythonPath(cacheDir)) && File.Exists(ScriptPath(appDir)); }
            catch { return false; }
        }

        public static bool Running
        {
            get
            {
                lock (Gate)
                {
                    try { return _process != null && !_process.HasExited; }
                    catch { return false; }
                }
            }
        }

        /// <summary>True once the model answers, not merely once the process exists.</summary>
        public static bool Ready()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/health");
                req.Timeout = 2000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(resp.GetResponseStream()))
                {
                    return reader.ReadToEnd().IndexOf("\"ready\": true", StringComparison.OrdinalIgnoreCase) >= 0
                        || reader.ReadToEnd().IndexOf("\"ready\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch { return false; }
        }

        /// <summary>
        /// Start it if it is not already up, and wait for the weights. Reports progress so
        /// the reader is told what a thirty second wait is for rather than left guessing.
        /// </summary>
        public static async Task<bool> EnsureRunning(string cacheDir, string appDir,
                                                     Action<string> say, CancellationToken cancel)
        {
            if (!Installed(cacheDir, appDir)) { say("The narration extension is not installed."); return false; }
            if (Ready()) return true;

            lock (Gate)
            {
                if (_process == null || _process.HasExited)
                {
                    Directory.CreateDirectory(CacheDir(cacheDir));
                    var psi = new ProcessStartInfo
                    {
                        FileName = PythonPath(cacheDir),
                        Arguments = "\"" + ScriptPath(appDir) + "\""
                                  + " --cache \"" + CacheDir(cacheDir) + "\""
                                  + " --port " + Port,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WorkingDirectory = Path.GetDirectoryName(ScriptPath(appDir))
                    };
                    _process = Process.Start(psi);
                }
            }

            say("Starting the narrator...");
            // Cold, this has taken about a minute: the weights are several gigabytes and the
            // first CUDA context in a fresh process is not quick. Warm, it is seconds.
            for (int waited = 0; waited < 180 && !cancel.IsCancellationRequested; waited++)
            {
                if (Ready()) { say(""); return true; }
                if (waited == 10) say("Starting the narrator - loading the voice model...");
                if (waited == 45) say("Still loading the voice model. The first start is the slow one.");
                await Task.Delay(1000, cancel).ConfigureAwait(false);
            }
            say("The narrator did not start.");
            return false;
        }

        /// <summary>Asks it to stop, then makes sure. Called when TypoZen closes.</summary>
        public static void Stop()
        {
            Process p;
            lock (Gate) { p = _process; _process = null; }
            if (p == null) return;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/stop");
                req.Method = "POST";
                req.Timeout = 2000;
                req.ContentLength = 2;
                using (var s = req.GetRequestStream()) { s.WriteByte((byte)'{'); s.WriteByte((byte)'}'); }
                using (req.GetResponse()) { }
            }
            catch { }
            try { if (!p.WaitForExit(3000)) p.Kill(); }
            catch { }
        }
    }
}
