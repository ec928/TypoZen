using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

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
        /// <summary>The narrator's id in the reading-voice list, beside the Kokoro and Windows voices.</summary>
        public const string VoiceId = "qwen_narrator";
        public const string HostName = "localnarration";
        public static string BaseUrl { get { return "http://127.0.0.1:" + Port; } }

        private static Process _process;
        private static readonly object Gate = new object();
        private static string _logPath;

        /// <summary>
        /// The host's lines in narration.log, the file the sidecar and the page also write,
        /// so starting, running and stopping the narrator read as one timeline. Always on:
        /// a narration that fails otherwise leaves nothing behind to say why.
        /// </summary>
        private static void Log(string msg)
        {
            try
            {
                if (_logPath == null) return;
                DateTime t = DateTime.Now;
                File.AppendAllText(_logPath, t.ToString("HH:mm:ss.fff") + "  host    " + msg + Environment.NewLine);
            }
            catch { }
        }

        public static string RootDir(string cacheDir)
        {
            return Path.Combine(ExtensionCatalog.ExtensionsDir(cacheDir), "QwenTTS");
        }

        /// <summary>Where the rendered audio and the group manifests live.</summary>
        public static string CacheDir(string cacheDir)
        {
            return Path.Combine(RootDir(cacheDir), "narration");
        }

        // ---- Narrator settings and each book's cast ---------------------------------------
        //
        // narrator.json in the extension folder holds the narrator's voice and the reader's
        // style words; cast\<hash of the book's path>.json holds a book's character -> voice
        // choices and the names they were shown under. Both are sent to the page, which puts
        // them on every request it makes, before each narration and whenever they change.

        public sealed class Settings
        {
            public string Voice = "";
            public string Style = "";
        }

        public sealed class Cast
        {
            public Dictionary<string, string> Voices = new Dictionary<string, string>();
            public Dictionary<string, string> Names = new Dictionary<string, string>();
        }

        private static string SettingsPath(string cacheDir) { return Path.Combine(RootDir(cacheDir), "narrator.json"); }

        private static string CastPath(string cacheDir, string book)
        {
            using (var sha = SHA1.Create())
            {
                byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes((book ?? "").ToLowerInvariant()));
                return Path.Combine(RootDir(cacheDir), "cast", BitConverter.ToString(h).Replace("-", "").Substring(0, 16) + ".json");
            }
        }

        private static Dictionary<string, object> ReadJson(string path)
        {
            try
            {
                if (File.Exists(path))
                    return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
            }
            catch { }
            return new Dictionary<string, object>();
        }

        private static Dictionary<string, string> StringMap(Dictionary<string, object> d, string key)
        {
            var map = new Dictionary<string, string>();
            object o;
            var inner = d.TryGetValue(key, out o) ? o as Dictionary<string, object> : null;
            if (inner != null) foreach (var kv in inner) if (kv.Value is string) map[kv.Key] = (string)kv.Value;
            return map;
        }

        public static Settings LoadSettings(string cacheDir)
        {
            var d = ReadJson(SettingsPath(cacheDir));
            object v, s;
            return new Settings
            {
                Voice = d.TryGetValue("voice", out v) ? (v as string ?? "") : "",
                Style = d.TryGetValue("style", out s) ? (s as string ?? "") : ""
            };
        }

        public static void SaveSettings(string cacheDir, Settings s)
        {
            var d = new Dictionary<string, object> { { "voice", s.Voice ?? "" }, { "style", s.Style ?? "" } };
            File.WriteAllText(SettingsPath(cacheDir), new JavaScriptSerializer().Serialize(d), Encoding.UTF8);
        }

        public static Cast LoadCast(string cacheDir, string book)
        {
            if (string.IsNullOrEmpty(book)) return new Cast();
            var d = ReadJson(CastPath(cacheDir, book));
            return new Cast { Voices = StringMap(d, "cast"), Names = StringMap(d, "names") };
        }

        public static void SaveCast(string cacheDir, string book, Cast c)
        {
            if (string.IsNullOrEmpty(book)) return;
            string path = CastPath(cacheDir, book);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var d = new Dictionary<string, object> { { "book", book }, { "cast", c.Voices }, { "names", c.Names } };
            File.WriteAllText(path, new JavaScriptSerializer().Serialize(d), Encoding.UTF8);
        }

        /// <summary>What the page is sent: the narrator's voice and style, the reading speed, and this book's cast.</summary>
        public static string PageSettingsJson(string cacheDir, string book, double speed)
        {
            var s = LoadSettings(cacheDir);
            var d = new Dictionary<string, object>
            {
                { "voice", s.Voice }, { "style", s.Style }, { "speed", speed },
                { "cast", LoadCast(cacheDir, book).Voices }
            };
            return new JavaScriptSerializer().Serialize(d);
        }

        /// <summary>
        /// One request to the narrator, returning its JSON reply. A reply with an error status
        /// throws with the narrator's own error text rather than a bare "500".
        /// </summary>
        public static string Call(string method, string path, string json, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(BaseUrl + path);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            if (json != null)
            {
                byte[] body = Encoding.UTF8.GetBytes(json);
                req.ContentType = "application/json";
                req.ContentLength = body.Length;
                using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
            }
            try
            {
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return r.ReadToEnd();
            }
            catch (WebException ex)
            {
                if (ex.Response == null) throw;
                string text;
                using (var r = new StreamReader(ex.Response.GetResponseStream(), Encoding.UTF8)) text = r.ReadToEnd();
                object err;
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
                throw new Exception(d != null && d.TryGetValue("error", out err) ? Convert.ToString(err) : text);
            }
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
            _logPath = Path.Combine(RootDir(cacheDir), "narration.log");
            Log("---- narrate requested; script " + ScriptPath(appDir));
            if (!Installed(cacheDir, appDir))
            {
                Log("not installed: python " + File.Exists(PythonPath(cacheDir)) + ", script " + File.Exists(ScriptPath(appDir)));
                say("The narration extension is not installed.");
                return false;
            }
            if (Ready()) { Log("narrator already up"); return true; }

            var started = DateTime.Now;
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
                    Log("started narrator process " + _process.Id);
                }
                else Log("narrator process " + _process.Id + " exists but is not ready yet");
            }

            say("Starting the narrator...");
            // Cold, this has taken about a minute: the weights are several gigabytes and the
            // first CUDA context in a fresh process is not quick. Warm, it is seconds.
            for (int waited = 0; waited < 180 && !cancel.IsCancellationRequested; waited++)
            {
                if (Ready())
                {
                    Log("narrator ready after " + (DateTime.Now - started).TotalSeconds.ToString("0.0") + "s");
                    say("");
                    return true;
                }
                Process p;
                lock (Gate) { p = _process; }
                try
                {
                    if (p != null && p.HasExited)
                    {
                        Log("narrator process EXITED with code " + p.ExitCode + " before it was ready");
                        say("The narrator stopped while starting.");
                        return false;
                    }
                }
                catch { }
                if (waited == 10) say("Starting the narrator - loading the voice model...");
                if (waited == 45) say("Still loading the voice model. The first start is the slow one.");
                await Task.Delay(1000, cancel).ConfigureAwait(false);
            }
            Log("narrator not ready after " + (DateTime.Now - started).TotalSeconds.ToString("0") + "s; giving up");
            say("The narrator did not start.");
            return false;
        }

        /// <summary>Asks it to stop, then makes sure. Called when TypoZen closes.</summary>
        public static void Stop()
        {
            Process p;
            lock (Gate) { p = _process; _process = null; }
            if (p == null) return;
            Log("TypoZen closing: stopping narrator process " + p.Id);
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
