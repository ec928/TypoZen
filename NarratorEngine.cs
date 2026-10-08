using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace TypoZen
{
    /// <summary>
    /// One narration sidecar process: starting it, stopping it, and knowing whether it is there.
    /// The Qwen narrator (QwenNarrator) and the Breeze narrator (BreezeNarrator) are one of these
    /// each; both sidecars answer the same HTTP requests, so the page reads with either.
    ///
    /// Only one engine holds the graphics card at a time: the two models together do not fit a
    /// 12 GB card (Breeze about 9 GB, Qwen about 6), and Windows pages GPU memory to system RAM
    /// rather than failing, which turns a fast narrator into a crawling one. Starting one stops
    /// the other.
    /// </summary>
    internal sealed class NarratorEngine
    {
        public string Name;                 // "Qwen", "Breeze": in the log and the messages
        public int Port;
        public Func<string, string> RootDir;            // cacheDir -> the extension folder
        public Func<string, string> CacheDir;           // cacheDir -> where rendered audio goes
        public Func<string, string> PythonPath;         // cacheDir -> the environment's python.exe
        public Func<string, string> ScriptPath;         // appDir -> sidecar.py beside the exe
        public Func<string, bool> EnvironmentReady;     // cacheDir -> installed and finished
        public Func<string, string> ExtraArgs = c => ""; // cacheDir -> more command-line arguments
        /// <summary>The start clock's wording: what a normal start takes.</summary>
        public Func<int, string> StartingMessage;
        /// <summary>The longest a start may take before it is given up.</summary>
        public int StartLimitSeconds = 180;

        /// <summary>This session's folder for audio rendered in Privacy Mode (set at start-up).</summary>
        public string PrivateCacheDir;
        /// <summary>Privacy Mode: no narration.log, from the host or the sidecar.</summary>
        public static bool PrivateMode;

        private Process _process;
        private readonly object _gate = new object();
        private string _logPath;

        public string BaseUrl { get { return "http://127.0.0.1:" + Port; } }

        /// <summary>
        /// The host's lines in narration.log, the file the sidecar and the page also write, so
        /// starting, running and stopping read as one timeline. Nothing in Privacy Mode.
        /// </summary>
        public void Log(string msg)
        {
            try
            {
                if (_logPath == null || PrivateMode) return;
                File.AppendAllText(_logPath, DateTime.Now.ToString("HH:mm:ss.fff") + "  host    " + msg + Environment.NewLine);
            }
            catch { }
        }

        /// <summary>Both halves present: the environment in the data folder and the script beside the exe.</summary>
        public bool Installed(string cacheDir, string appDir)
        {
            try { return EnvironmentReady(cacheDir) && File.Exists(ScriptPath(appDir)); }
            catch { return false; }
        }

        public bool Running
        {
            get
            {
                lock (_gate)
                {
                    try { return _process != null && !_process.HasExited; }
                    catch { return false; }
                }
            }
        }

        /// <summary>
        /// Tells a running narrator whether to write narration.log: off in Privacy Mode. One not
        /// running yet is started with --quiet instead. Quick and silent when nothing listens.
        /// </summary>
        public void SetLogging(bool on)
        {
            try { Call("POST", "/logging", "{\"on\":" + (on ? "true" : "false") + "}", 2000); }
            catch { }
        }

        /// <summary>
        /// One request to the narrator, returning its JSON reply. A reply with an error status
        /// throws with the narrator's own error text rather than a bare "500".
        /// </summary>
        public string Call(string method, string path, string json, int timeoutMs)
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

        /// <summary>True once the model answers, not merely once the process exists.</summary>
        public bool Ready()
        {
            object ready;
            var h = Health();
            return h != null && h.TryGetValue("ready", out ready) && ready is bool && (bool)ready;
        }

        /// <summary>The narrator's own report that its model failed to load; null when it has none.</summary>
        public string LoadError()
        {
            object error;
            var h = Health();
            return h != null && h.TryGetValue("error", out error) && error is string && ((string)error).Length > 0
                ? (string)error : null;
        }

        /// <summary>/health, parsed; null when the narrator does not answer.</summary>
        public Dictionary<string, object> Health()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/health");
                req.Timeout = 2000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(resp.GetResponseStream()))
                    return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            }
            catch { return null; }
        }

        /// <summary>
        /// Start it if it is not already up, and wait for the weights. Reports progress so the
        /// reader is told what a thirty second wait is for rather than left guessing.
        /// </summary>
        public async Task<bool> EnsureRunning(string cacheDir, string appDir, Action<string> say, CancellationToken cancel)
        {
            _logPath = Path.Combine(RootDir(cacheDir), "narration.log");
            Log("---- narrate requested; script " + ScriptPath(appDir));
            if (!Installed(cacheDir, appDir))
            {
                Log("not installed: python " + File.Exists(PythonPath(cacheDir)) + ", script " + File.Exists(ScriptPath(appDir)));
                say("The narration extension is not installed.");
                return false;
            }
            // The other engine steps off the card first (see the class summary).
            foreach (var other in Others()) other.StopAny("the " + Name + " narrator is starting");
            if (Ready())
            {
                // A narrator left running by an earlier TypoZen -- one that crashed, so never
                // stopped it -- writes private audio into that session's folder, which this one
                // neither serves nor deletes. Replace it rather than use it.
                object had;
                var h = Health();
                string theirs = h != null && h.TryGetValue("private", out had) ? had as string ?? "" : "";
                if (string.Equals(theirs, PrivateCacheDir ?? "", StringComparison.OrdinalIgnoreCase))
                {
                    Log("narrator already up");
                    SetLogging(!PrivateMode);       // in case Privacy Mode changed while it ran
                    return true;
                }
                Log("narrator already up but belongs to another session; replacing it");
                say("Restarting the narrator...");
                PostStop();
                for (int i = 0; i < 20 && Health() != null; i++) await Task.Delay(250);
            }

            var started = DateTime.Now;
            lock (_gate)
            {
                if (_process == null || _process.HasExited)
                {
                    Directory.CreateDirectory(CacheDir(cacheDir));
                    var psi = new ProcessStartInfo
                    {
                        FileName = PythonPath(cacheDir),
                        Arguments = "\"" + ScriptPath(appDir) + "\""
                                  + " --cache \"" + CacheDir(cacheDir) + "\""
                                  + (string.IsNullOrEmpty(PrivateCacheDir) ? ""
                                     : " --private-cache \"" + PrivateCacheDir + "\"")
                                  + (PrivateMode ? " --quiet" : "")
                                  + " --port " + Port
                                  + ExtraArgs(cacheDir),
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
            for (int waited = 0; waited < StartLimitSeconds && !cancel.IsCancellationRequested; waited++)
            {
                if (Ready())
                {
                    Log("narrator ready after " + (DateTime.Now - started).TotalSeconds.ToString("0.0") + "s");
                    say("");
                    return true;
                }
                // A failed model load leaves the process up but never ready. Waiting out the
                // limit showed "starting" all that time (2026-09-24). Say so now, and stop that
                // process so the next attempt starts a fresh one.
                string failed = LoadError();
                if (failed != null)
                {
                    Log("narrator could not load its model: " + failed + "; stopping it so the next attempt starts fresh");
                    Stop();
                    say("The narrator could not load its model. Press Read Aloud to try again. (" + failed + ")");
                    return false;
                }
                Process p;
                lock (_gate) { p = _process; }
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
                // A clock, so a long load reads as progress rather than a hang.
                if (waited > 0 && waited % 2 == 0) say(StartingMessage(waited));
                await Task.Delay(1000, cancel).ConfigureAwait(false);
            }
            Log("narrator not ready after " + (DateTime.Now - started).TotalSeconds.ToString("0") + "s; giving up");
            say("The narrator did not start.");
            return false;
        }

        /// <summary>Every engine but this one. Named here rather than registered, so an engine whose
        /// class has not been touched yet this session is still found and stopped.</summary>
        private List<NarratorEngine> Others()
        {
            var all = new List<NarratorEngine> { QwenNarrator.Engine, BreezeNarrator.Engine };
            return all.FindAll(e => e != this);
        }

        /// <summary>Asks it to stop, then makes sure. Called when TypoZen closes.</summary>
        public void Stop()
        {
            Process p;
            lock (_gate) { p = _process; _process = null; }
            if (p == null) return;
            Log("stopping narrator process " + p.Id);
            PostStop();
            try { if (!p.WaitForExit(3000)) p.Kill(); }
            catch { }
        }

        /// <summary>
        /// Off the card, whoever started it: this session's process, or one answering on the port
        /// (left by a TypoZen that crashed). Quick when nothing is there.
        /// </summary>
        public void StopAny(string why)
        {
            bool ours = Running;
            if (!ours && Health() == null) return;
            Log("stopping: " + why);
            if (ours) Stop();
            else PostStop();
        }

        /// <summary>Ask whatever narrator answers on the port to shut itself down.</summary>
        public void PostStop()
        {
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
        }
    }
}
