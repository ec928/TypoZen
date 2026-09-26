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
        /// <summary>Serves PrivateCacheDir: audio rendered while Privacy Mode is on.</summary>
        public const string PrivateHostName = "localnarrationp";

        /// <summary>
        /// This session's folder for audio rendered in Privacy Mode, inside the private load
        /// folder, so it goes wherever that goes: emptied when Privacy Mode ends, deleted at
        /// exit, swept at the next launch after a crash. Set once at start-up, before the
        /// narrator is started, and handed to it as --private-cache.
        /// </summary>
        public static string PrivateCacheDir;
        public static string BaseUrl { get { return "http://127.0.0.1:" + Port; } }

        private static Process _process;
        private static readonly object Gate = new object();
        private static string _logPath;

        /// <summary>
        /// The host's lines in narration.log, the file the sidecar and the page also write,
        /// so starting, running and stopping the narrator read as one timeline. On except in
        /// Privacy Mode, when nothing is written by anyone (SetLogging): a narration that fails
        /// otherwise leaves nothing behind to say why.
        /// </summary>
        private static void Log(string msg)
        {
            try
            {
                if (_logPath == null || PrivateMode) return;
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
        // narrator.json in the extension folder holds the narrator's voice, the instruction it
        // reads by and the emotion-cue setting; presets.json the reader's own saved instructions;
        // cast\<hash of the book's path>.json a book's character -> voice choices and the names
        // they were shown under. Settings and cast are sent to the page, which puts them on every
        // request it makes, before each narration and whenever they change.
        //
        // The instruction is the whole of what the narrator is told for a paragraph, shown and
        // edited as it stands. Nothing is added to it except an emotion cue, and that only when
        // the reader ticks the box -- hidden standing wording was what made the cues look like an
        // improvement until an A/B test showed the opposite (2026-09-26).

        /// <summary>What the narrator read by before instructions were editable; kept word for word
        /// so a reader's older settings migrate to exactly what they had, and its audio is still
        /// found in the cache. Not offered as a preset any more (below).</summary>
        private const string LegacyBase = "Narrate as an accomplished audiobook reader of literary fiction: measured and unhurried, phrasing that follows the sense of the sentence, understated rather than performed.";
        private const string LegacyDialogue = " Give the spoken lines a light, distinct colour without acting them out.";
        private const string StylePrefix = "Narrate as an audiobook reader of literary fiction. ";
        /// <summary>
        /// How an emotion cue is worded when it is added; {cue} is the cue ("whispered, hushed").
        /// The plain "Voice the lines in quotation marks as {cue}." was the default in 0.6.19, on
        /// the reasoning that "restraint" fights the cue; by ear it came out less angry than this
        /// wording on "I know," she snapped, against the same cues-off clip (2026-09-26, one take
        /// each). Kept until more listening says otherwise.
        /// </summary>
        public const string DefaultCue = "Voice the lines in quotation marks as {cue}, clearly but with restraint, and keep the narration around them measured.";

        /// <summary>
        /// The starting points offered in Narrator Settings, in order. Not editable in place; save a
        /// copy as your own. None of them tells the narrator to hold back on dialogue: "understated
        /// rather than performed" and "without acting them out" fought the emotion cues -- with
        /// them, "she snapped" was read flatter than with no instruction at all (2026-09-26).
        /// </summary>
        public static readonly KeyValuePair<string, string>[] BuiltInPresets =
        {
            new KeyValuePair<string, string>("None (the model unguided)", ""),
            new KeyValuePair<string, string>("Standard", "Narrate as an accomplished audiobook reader of literary fiction: measured and unhurried, phrasing that follows the sense of the sentence."),
            new KeyValuePair<string, string>("Warm", StylePrefix + "Warm and close, as if reading to one listener, unhurried, with a gentle smile in the voice where the text allows."),
            new KeyValuePair<string, string>("Brisk", StylePrefix + "Brisk and clear, keeping the story moving, crisp at the ends of sentences, never rushed."),
            new KeyValuePair<string, string>("Dramatic", StylePrefix + "Vivid and engaged, giving tension and emotion their full weight, with bold contrasts between quiet and intense moments.")
        };

        public sealed class Settings
        {
            public string Voice = "";
            // No instruction and emotion cues on, for a reader who has set nothing: by ear on
            // 2026-09-26 the cues came through best with nothing else said, and a standing
            // instruction only competed with them. A reader's saved choice always wins.
            public string Instruction = "";
            public string Cue = DefaultCue;
            public bool Direct = true;
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

        internal static Dictionary<string, object> ReadJson(string path)
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
            object v, s, c, i, q;
            var r = new Settings { Voice = d.TryGetValue("voice", out v) ? (v as string ?? "") : "" };
            if (d.TryGetValue("direct", out c) && c is bool) r.Direct = (bool)c;
            if (d.TryGetValue("instruction", out i) && i is string) r.Instruction = (string)i;
            else if (d.TryGetValue("style", out s))
            {
                // Saved before instructions were editable: the same words the narrator built from
                // the style, now in the open. Cues were always on then, so they stay on.
                string style = ((s as string) ?? "").Trim();
                r.Instruction = (style.Length > 0 ? StylePrefix + style : LegacyBase) + LegacyDialogue;
            }
            if (d.TryGetValue("cue", out q) && q is string && ((string)q).Trim().Length > 0) r.Cue = (string)q;
            return r;
        }

        public static void SaveSettings(string cacheDir, Settings s)
        {
            var d = new Dictionary<string, object>
            {
                { "voice", s.Voice ?? "" }, { "instruction", s.Instruction ?? "" }, { "cue", s.Cue ?? "" }, { "direct", s.Direct }
            };
            File.WriteAllText(SettingsPath(cacheDir), new JavaScriptSerializer().Serialize(d), Encoding.UTF8);
        }

        private static string PresetsPath(string cacheDir) { return Path.Combine(RootDir(cacheDir), "presets.json"); }

        /// <summary>The reader's own saved instructions, name -> instruction, in the order saved.</summary>
        public static List<KeyValuePair<string, string>> LoadPresets(string cacheDir)
        {
            var list = new List<KeyValuePair<string, string>>();
            foreach (var kv in StringMap(ReadJson(PresetsPath(cacheDir)), "presets")) list.Add(kv);
            return list;
        }

        public static void SavePresets(string cacheDir, List<KeyValuePair<string, string>> presets)
        {
            var map = new Dictionary<string, object>();
            foreach (var kv in presets) map[kv.Key] = kv.Value;
            string path = PresetsPath(cacheDir), part = path + ".part";
            File.WriteAllText(part, new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "presets", map } }), Encoding.UTF8);
            if (File.Exists(path)) File.Replace(part, path, null); else File.Move(part, path);
        }

        /// <summary>
        /// Set with Privacy Mode. A cast file names the book it belongs to, so while this is on a
        /// saved cast is held in SessionCasts instead: it still applies to the reading, and is
        /// gone when TypoZen closes. Kept past Privacy Mode being turned off, for the same reason
        /// as the private audio -- the reader may still be listening in it.
        /// </summary>
        public static bool PrivateMode;

        /// <summary>
        /// Tells a running narrator whether to write narration.log: off in Privacy Mode. A
        /// narrator not running yet is started with --quiet instead (EnsureRunning). Quick and
        /// silent when nothing is listening.
        /// </summary>
        public static void SetLogging(bool on)
        {
            try { Call("POST", "/logging", "{\"on\":" + (on ? "true" : "false") + "}", 2000); }
            catch { }
        }
        private static readonly Dictionary<string, Cast> SessionCasts =
            new Dictionary<string, Cast>(StringComparer.OrdinalIgnoreCase);

        /// <summary>Clear Stored Data: casts held for this session go with the saved ones.</summary>
        public static void ForgetSessionCasts()
        {
            lock (SessionCasts) SessionCasts.Clear();
        }

        private static Cast Copy(Cast c)
        {
            return new Cast { Voices = new Dictionary<string, string>(c.Voices), Names = new Dictionary<string, string>(c.Names) };
        }

        public static Cast LoadCast(string cacheDir, string book)
        {
            if (string.IsNullOrEmpty(book)) return new Cast();
            Cast held;
            lock (SessionCasts)
                if (SessionCasts.TryGetValue(CastPath(cacheDir, book), out held)) return Copy(held);
            var d = ReadJson(CastPath(cacheDir, book));
            return new Cast { Voices = StringMap(d, "cast"), Names = StringMap(d, "names") };
        }

        public static void SaveCast(string cacheDir, string book, Cast c)
        {
            if (string.IsNullOrEmpty(book)) return;
            string path = CastPath(cacheDir, book);
            if (PrivateMode)
            {
                lock (SessionCasts) SessionCasts[path] = Copy(c);
                return;
            }
            // Saved for good now, so the session's copy no longer stands in front of the file.
            lock (SessionCasts) SessionCasts.Remove(path);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var d = new Dictionary<string, object> { { "book", book }, { "cast", c.Voices }, { "names", c.Names } };
            File.WriteAllText(path, new JavaScriptSerializer().Serialize(d), Encoding.UTF8);
        }

        /// <summary>The built-in voice's id and name, as the narrator lists it.</summary>
        /// <summary>
        /// What Extensions > Remove deletes from the extension folder: the Python environment and
        /// the Python it was made from, the models, the rendered audio and the download cache.
        /// Everything else -- voices, casts, narrator.json, the reference recording -- is the
        /// reader's and stays.
        /// </summary>
        public static readonly string[] RemovableParts = { "venv", "python", "models", "narration", "xet" };

        public const string DefaultVoiceId = "northern-english";
        public const string DefaultVoiceName = "Northern English (original)";

        /// <summary>
        /// The model's own English speakers (sidecar.py MODEL_SPEAKERS): id, name, description.
        /// The voices the model was trained to take instructions with.
        /// </summary>
        public static readonly string[][] ModelSpeakers =
        {
            // The model's own words for them. Ryan's accent is not stated, so nothing here names a
            // country for Look up's voice match (PickWordVoice) to guess from.
            new[] { "qwen-ryan", "Ryan (built into the model)", "Dynamic male voice with strong rhythmic drive." },
            new[] { "qwen-aiden", "Aiden (built into the model)", "Sunny American male voice with a clear midrange." }
        };

        /// <summary>
        /// Every voice the narrator can read in, (id, name), the built-in ones first -- read from
        /// the voices folder on disk, so a menu can list them without starting the narrator.
        /// </summary>
        public static List<KeyValuePair<string, string>> SavedVoices(string cacheDir)
        {
            var list = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>(DefaultVoiceId, DefaultVoiceName) };
            foreach (var m in ModelSpeakers) list.Add(new KeyValuePair<string, string>(m[0], m[1]));
            try
            {
                string dir = Path.Combine(RootDir(cacheDir), "voices");
                if (!Directory.Exists(dir)) return list;
                var kept = new List<KeyValuePair<string, string>>();
                foreach (string d in Directory.GetDirectories(dir))
                {
                    string id = Path.GetFileName(d);
                    if (id.StartsWith("_") || !File.Exists(Path.Combine(d, "print.npy"))) continue;
                    object n;
                    var meta = ReadJson(Path.Combine(d, "meta.json"));
                    kept.Add(new KeyValuePair<string, string>(id, meta.TryGetValue("name", out n) && n is string ? (string)n : id));
                }
                kept.Sort((a, b) => string.Compare(a.Value, b.Value, StringComparison.OrdinalIgnoreCase));
                list.AddRange(kept);
            }
            catch { }
            return list;
        }

        /// <summary>The narrator's current voice id: the saved choice, or the built-in voice.</summary>
        public static string CurrentVoice(string cacheDir)
        {
            string v = LoadSettings(cacheDir).Voice;
            return string.IsNullOrEmpty(v) ? DefaultVoiceId : v;
        }

        /// <summary>The built-in voice as sidecar.py describes it (BUILTIN_VOICES).</summary>
        public const string DefaultVoiceDescription =
            "A British woman with a soft northern English accent, gentle and grounded, with a low steady delivery.";

        /// <summary>
        /// A voice's description -- what it was designed from -- and name, for matching it to
        /// a quick voice (Look up's speaker says a word in one of those, not in the narrator).
        /// </summary>
        public static string VoiceDescription(string cacheDir, string id)
        {
            if (string.IsNullOrEmpty(id) || id == DefaultVoiceId) return DefaultVoiceDescription;
            foreach (var m in ModelSpeakers) if (m[0] == id) return m[2] + " " + m[1];
            try
            {
                var meta = ReadJson(Path.Combine(RootDir(cacheDir), "voices", id, "meta.json"));
                object d, n;
                string desc = meta.TryGetValue("description", out d) && d is string ? (string)d : "";
                string name = meta.TryGetValue("name", out n) && n is string ? (string)n : "";
                return (desc + " " + name).Trim();
            }
            catch { return ""; }
        }

        /// <summary>What the page is sent: the narrator's voice and style, the reading speed, and this book's cast.</summary>
        public static string PageSettingsJson(string cacheDir, string book, double speed, bool privateMode)
        {
            var s = LoadSettings(cacheDir);
            string current = CurrentVoice(cacheDir), name = current;
            foreach (var v in SavedVoices(cacheDir)) if (v.Key == current) name = v.Value;
            var d = new Dictionary<string, object>
            {
                { "voice", s.Voice }, { "voiceName", name }, { "instruction", s.Instruction }, { "cue", s.Cue },
                { "direct", s.Direct }, { "speed", speed },
                { "cast", LoadCast(cacheDir, book).Voices },
                // Render into this session's private folder, not the lasting cache.
                { "private", privateMode }
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
            try { return EnvironmentReady(cacheDir) && File.Exists(ScriptPath(appDir)); }
            catch { return false; }
        }

        /// <summary>
        /// The environment in the data folder is there and finished: an install still under way,
        /// or stopped part-way, leaves install.part behind (QwenInstaller) and does not count.
        /// </summary>
        public static bool EnvironmentReady(string cacheDir)
        {
            try { return File.Exists(PythonPath(cacheDir)) && !File.Exists(QwenInstaller.InstallFlag(cacheDir)); }
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
            object ready;
            var h = Health();
            return h != null && h.TryGetValue("ready", out ready) && ready is bool && (bool)ready;
        }

        /// <summary>The narrator's own report that its model failed to load; null when it has none.</summary>
        public static string LoadError()
        {
            object error;
            var h = Health();
            return h != null && h.TryGetValue("error", out error) && error is string && ((string)error).Length > 0
                ? (string)error : null;
        }

        /// <summary>/health, parsed; null when the narrator does not answer.</summary>
        private static Dictionary<string, object> Health()
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
                                  + (string.IsNullOrEmpty(PrivateCacheDir) ? ""
                                     : " --private-cache \"" + PrivateCacheDir + "\"")
                                  + (PrivateMode ? " --quiet" : "")
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
                // A failed model load leaves the process up but never ready. Waiting out the
                // three-minute limit showed "starting" all that time (2026-09-24). Say so now,
                // and stop that process so the next attempt starts a fresh one.
                string failed = LoadError();
                if (failed != null)
                {
                    Log("narrator could not load its model: " + failed + "; stopping it so the next attempt starts fresh");
                    Stop();
                    say("The narrator could not load its model. Press Read Aloud to try again. (" + failed + ")");
                    return false;
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
                // A clock, so a half-minute load reads as progress rather than a hang. It
                // usually takes about 25s here; after a reboot the first one is slower.
                if (waited > 0 && waited % 2 == 0)
                    say("Starting the narrator: loading the voice model onto the graphics card, " + waited + "s" +
                        (waited < 30 ? " (usually about 25s)." : ". The first start after a reboot is the slow one."));
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
            Log("stopping narrator process " + p.Id);
            PostStop();
            try { if (!p.WaitForExit(3000)) p.Kill(); }
            catch { }
        }

        /// <summary>Ask whatever narrator answers on the port to shut itself down.</summary>
        private static void PostStop()
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
