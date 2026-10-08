using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace TypoZen
{
    /// <summary>
    /// The Breeze narrator: the second, optional narration extension beside Qwen
    /// (docs/internal/breeze-tts-plan.md). Its sidecar (tools\breeze-narrator\sidecar.py) answers
    /// the same requests as Qwen's, so the page narrates with either; this class says where
    /// Breeze lives and which voices it has.
    ///
    /// What the reader sets in Narrator Settings -- instruction, emotion cues, cue wording, each
    /// book's cast -- is shared with the Qwen narrator and kept where it always was
    /// (QwenNarrator.LoadSettings, extensions\QwenTTS\narrator.json). Only the voice the narrator
    /// reads in is Breeze's own choice, "breezeVoice" there.
    ///
    /// A Breeze voice is a recording and its exact words. Breeze reads the Qwen narrator's saved
    /// voices too (each keeps design.wav, a recording of the fixed design passage), so a cast made
    /// for Qwen works here; the voices Breeze makes itself -- designed or cloned from the reader's
    /// own recording -- are in its own folder and are Breeze's alone.
    /// </summary>
    /// <summary>The Breeze narration install (NarratorInstaller, tools\breeze-narrator\install.py).</summary>
    internal static class BreezeInstaller
    {
        /// <summary>Packages about 4.9 GB (the Qwen lock plus Triton), the model 7.7 GB.</summary>
        public const long DownloadBytes = 12600L * 1024 * 1024;

        public static NarratorInstaller Create()
        {
            return new NarratorInstaller
            {
                Name = "Breeze narration",
                RootDir = BreezeNarrator.RootDir,
                ScriptFolder = "breeze-narrator",
                NeedFree = 16L * 1024 * 1024 * 1024,
                // About 9 GB while reading (measured on a 12 GB card, 2026-10-08). A card reported
                // as "12 GB" has a little under 12 GiB, so the line is drawn at 11.
                MinGpuMiB = 11 * 1024,
                Notice = LicenceSummary
            };
        }

        public static string InstallFlag(string cacheDir) { return BreezeNarrator.InstallFlag(cacheDir); }
        public static string Preflight(string cacheDir) { return Create().Preflight(cacheDir); }

        /// <summary>
        /// What the reader agrees to before anything is downloaded: Breeze's weights are not
        /// freely licensed as Qwen's are, and the install says so in its own words.
        /// </summary>
        public const string LicenceSummary =
            "Breeze TTS 2's model is licensed by BreezeBlue (RESONIA, Inc.) for research and non-commercial use "
            + "only -- and that includes the audio it makes on your PC. Listening to your own books is fine; "
            + "selling or publishing the audio, or using it in paid work, needs their written permission. "
            + "Its code is Apache 2.0. Full terms: huggingface.co/BreezeBlue/Breeze-TTS-2.";
    }

    internal static class BreezeNarrator
    {
        public const int Port = 8766;
        /// <summary>The narrator's id in the reading-voice list, beside Qwen, Kokoro and Windows.</summary>
        public const string VoiceId = "breeze_narrator";
        public const string HostName = "localbreeze";
        /// <summary>Serves PrivateCacheDir: audio rendered while Privacy Mode is on.</summary>
        public const string PrivateHostName = "localbreezep";
        public const string ExtensionId = "BreezeTTS";

        public const string DefaultVoiceId = "northern-english";
        public const string DefaultVoiceName = "Northern English (original)";

        /// <summary>
        /// What Extensions > Remove deletes: the environment and its Python, the model, Breeze's
        /// code, rendered audio, compiled kernels. Voices -- above all the reader's clones, which
        /// cannot be made again without the recording -- stay.
        /// </summary>
        public static readonly string[] RemovableParts = { "venv", "python", "model", "breeze-tts", "narration", "compiled", "hf" };

        public static readonly NarratorEngine Engine = new NarratorEngine
        {
            Name = "Breeze",
            Port = Port,
            RootDir = RootDir,
            CacheDir = CacheDir,
            PythonPath = PythonPath,
            ScriptPath = ScriptPath,
            EnvironmentReady = EnvironmentReady,
            // Qwen's saved voices, read only: a voice designed there reads here too.
            ExtraArgs = cacheDir =>
            {
                string qv = Path.Combine(QwenNarrator.RootDir(cacheDir), "voices");
                return Directory.Exists(qv) ? " --qwen-voices \"" + qv + "\"" : "";
            },
            // Load about 7 s, then compiling the fast path: about 33 s, two minutes the first time
            // on a PC (measured 2026-10-08), after which the compiled kernels are kept.
            StartingMessage = waited => "Starting the Breeze narrator: loading the voice model and preparing the graphics card, " + waited + "s" +
                (waited < 45 ? " (usually about 40s)." : ". The very first start takes about two and a half minutes."),
            StartLimitSeconds = 300
        };

        public static string RootDir(string cacheDir)
        {
            return Path.Combine(ExtensionCatalog.ExtensionsDir(cacheDir), ExtensionId);
        }

        /// <summary>Where the rendered audio lives.</summary>
        public static string CacheDir(string cacheDir)
        {
            return Path.Combine(RootDir(cacheDir), "narration");
        }

        public static string InstallFlag(string cacheDir)
        {
            return Path.Combine(RootDir(cacheDir), "install.part");
        }

        private static string PythonPath(string cacheDir)
        {
            return Path.Combine(RootDir(cacheDir), "venv", "Scripts", "python.exe");
        }

        private static string ScriptPath(string appDir)
        {
            return Path.Combine(appDir, "tools", "breeze-narrator", "sidecar.py");
        }

        /// <summary>The environment is there and its install finished (no install.part).</summary>
        public static bool EnvironmentReady(string cacheDir)
        {
            try
            {
                return File.Exists(PythonPath(cacheDir)) && !File.Exists(InstallFlag(cacheDir))
                    && File.Exists(Path.Combine(RootDir(cacheDir), "model", "config.json"));
            }
            catch { return false; }
        }

        public static string PrivateCacheDir
        {
            get { return Engine.PrivateCacheDir; }
            set { Engine.PrivateCacheDir = value; }
        }
        public static string BaseUrl { get { return Engine.BaseUrl; } }
        public static bool Installed(string cacheDir, string appDir) { return Engine.Installed(cacheDir, appDir); }
        public static string Call(string method, string path, string json, int timeoutMs) { return Engine.Call(method, path, json, timeoutMs); }
        public static Task<bool> EnsureRunning(string cacheDir, string appDir, Action<string> say, CancellationToken cancel)
        {
            return Engine.EnsureRunning(cacheDir, appDir, say, cancel);
        }
        public static void Stop() { Engine.Stop(); }

        /// <summary>
        /// Every voice Breeze can read in, (id, name): the built-in narrator, then the Qwen
        /// narrator's saved voices and Breeze's own, by name -- read from disk, so a menu lists
        /// them without starting the narrator. The same rules as the sidecar's reload_voices.
        /// </summary>
        public static List<KeyValuePair<string, string>> SavedVoices(string cacheDir)
        {
            var list = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>(DefaultVoiceId, DefaultVoiceName) };
            var kept = new Dictionary<string, string>();
            foreach (string dir in new[] { Path.Combine(QwenNarrator.RootDir(cacheDir), "voices"), Path.Combine(RootDir(cacheDir), "voices") })
            {
                try
                {
                    if (!Directory.Exists(dir)) continue;
                    foreach (string d in Directory.GetDirectories(dir))
                    {
                        string id = Path.GetFileName(d);
                        if (id.StartsWith("_") || id == DefaultVoiceId) continue;
                        if (!File.Exists(Path.Combine(d, "reference.wav")) && !File.Exists(Path.Combine(d, "design.wav"))) continue;
                        object n;
                        var meta = QwenNarrator.ReadJson(Path.Combine(d, "meta.json"));
                        kept[id] = meta.TryGetValue("name", out n) && n is string ? (string)n : id;
                    }
                }
                catch { }
            }
            var sorted = new List<KeyValuePair<string, string>>(kept);
            sorted.Sort((a, b) => string.Compare(a.Value, b.Value, StringComparison.OrdinalIgnoreCase));
            list.AddRange(sorted);
            return list;
        }

        /// <summary>Breeze's current voice id: the saved choice, or the built-in voice.</summary>
        public static string CurrentVoice(string cacheDir)
        {
            string v = QwenNarrator.LoadSettings(cacheDir).BreezeVoice;
            return string.IsNullOrEmpty(v) ? DefaultVoiceId : v;
        }

        public static void SetVoice(string cacheDir, string voiceId)
        {
            var s = QwenNarrator.LoadSettings(cacheDir);
            s.BreezeVoice = voiceId ?? "";
            QwenNarrator.SaveSettings(cacheDir, s);
        }

        /// <summary>
        /// What the page is sent: the same as for Qwen (instruction, cues, cast, speed, privacy)
        /// with Breeze's voice, and where Breeze's audio is served from.
        /// </summary>
        public static string PageSettingsJson(string cacheDir, string book, double speed, bool privateMode)
        {
            var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                QwenNarrator.PageSettingsJson(cacheDir, book, speed, privateMode));
            string current = CurrentVoice(cacheDir), name = current;
            foreach (var v in SavedVoices(cacheDir)) if (v.Key == current) name = v.Value;
            d["voice"] = QwenNarrator.LoadSettings(cacheDir).BreezeVoice;
            d["voiceName"] = name;
            d["audioHost"] = HostName;
            d["audioHostPrivate"] = PrivateHostName;
            // One piece per request: Breeze renders pieces one after another, so a batch only
            // delays the first sound until all of it is done.
            d["batch"] = 1;
            d["engine"] = "breeze";
            d["strength"] = QwenNarrator.LoadSettings(cacheDir).BreezeStrength;
            return new JavaScriptSerializer().Serialize(d);
        }

        /// <summary>A voice's description and name, for Look up's choice of quick voice.</summary>
        public static string VoiceDescription(string cacheDir, string id)
        {
            if (string.IsNullOrEmpty(id) || id == DefaultVoiceId) return QwenNarrator.DefaultVoiceDescription;
            foreach (string dir in new[] { Path.Combine(RootDir(cacheDir), "voices"), Path.Combine(QwenNarrator.RootDir(cacheDir), "voices") })
            {
                string meta = Path.Combine(dir, id, "meta.json");
                if (!File.Exists(meta)) continue;
                var m = QwenNarrator.ReadJson(meta);
                object d, n;
                return (((m.TryGetValue("description", out d) ? d as string : "") ?? "") + " " +
                        ((m.TryGetValue("name", out n) ? n as string : "") ?? "")).Trim();
            }
            return "";
        }
    }
}
