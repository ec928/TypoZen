using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace TypoZen
{
    /// <summary>
    /// Optional downloads: things too large to ship, that most readers will never want.
    ///
    /// TypoZen makes no network request of its own. An extension is the one exception, and
    /// only while its install is running: nothing here is contacted at launch, on a lookup,
    /// or while reading. An extension that is not installed leaves no menu behind -- the
    /// dictionary menu already hides itself while there is only one dictionary, and the
    /// Kokoro voices hide the same way.
    ///
    /// Everything lands in the cache folder, so "Remove" is a directory delete and the
    /// size shown is the size on disk.
    /// </summary>
    internal sealed class ExtensionFile
    {
        public string Url;
        /// <summary>Where it goes, relative to the extension's own folder.</summary>
        public string Path;
        public long Bytes;
        /// <summary>Checked after download when set; a mismatch fails the install.</summary>
        public string Sha256;
        /// <summary>Unpacked into the folder and deleted, rather than kept as a file.</summary>
        public bool Unzip;
        /// <summary>Rewritten after download (the engine's two hardcoded remote URLs).</summary>
        public bool PatchEngine;
    }

    internal sealed class ExtensionInfo
    {
        public string Id;
        public string Title;
        public string Blurb;
        /// <summary>Absolute folder this extension owns; removing it uninstalls.</summary>
        public string Dir;
        /// <summary>Relative path that exists only once the install finished.</summary>
        public string Marker;
        /// <summary>Written into the folder as LICENSE.txt, for anything downloaded.</summary>
        public string Notice;
        public List<ExtensionFile> Files = new List<ExtensionFile>();
        /// <summary>When set, decides Installed instead of the marker file.</summary>
        public Func<bool> Check;

        public bool Installed
        {
            get
            {
                if (Check != null) return Check();
                try { return File.Exists(System.IO.Path.Combine(Dir, Marker)); }
                catch { return false; }
            }
        }

        public long DownloadBytes
        {
            get { long n = 0; foreach (var f in Files) n += f.Bytes; return n; }
        }

        /// <summary>
        /// Files this extension expects that are not on disk. A build that adds voices
        /// leaves an older install short of them, and an install is not "done" just
        /// because its marker file is there.
        /// </summary>
        public List<ExtensionFile> Missing()
        {
            var missing = new List<ExtensionFile>();
            foreach (var f in Files)
            {
                if (f.Unzip) continue;                  // an archive is gone once unpacked
                string local = System.IO.Path.Combine(Dir, f.Path.Replace('/', System.IO.Path.DirectorySeparatorChar));
                try { if (!File.Exists(local)) missing.Add(f); }
                catch { missing.Add(f); }
            }
            return missing;
        }

        public long MissingBytes()
        {
            long n = 0; foreach (var f in Missing()) n += f.Bytes; return n;
        }
    }

    internal static class ExtensionCatalog
    {
        public const string KokoroId = "Kokoro";
        public const string WiktionaryId = "Wiktionary";
        public const string WhisperId = "Whisper";

        /// <summary>Virtual host the page loads extension files through.</summary>
        public const string HostName = "localextensions";

        /// <summary>Pinned: an upstream that moves on is an install that breaks silently.</summary>
        private const string KokoroJs = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.min.js";
        private const string OrtBase = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/dist/";
        private const string ModelRepo = "onnx-community/Kokoro-82M-v1.0-ONNX";
        private const string HfBase = "https://huggingface.co/" + ModelRepo + "/resolve/main/";

        /// <summary>
        /// Every English voice Kokoro publishes, with the grade its own VOICES.md gives it:
        /// huggingface.co/hexgrad/Kokoro-82M. All of them, because they are about half a
        /// megabyte each and the grades are one opinion -- a C+ voice someone likes is
        /// better than an A they do not. The menu is built from this, so there is one list
        /// rather than four to keep in step.
        ///
        /// "id|Name|Group|Grade". Kokoro's other languages need phonemiser data that is not
        /// downloaded here, so they are deliberately absent.
        /// </summary>
        public static readonly string[] Voices = {
            "af_heart|Heart|American female|A",
            "af_bella|Bella|American female|A-",
            "af_nicole|Nicole|American female|B-",
            "af_aoede|Aoede|American female|C+",
            "af_kore|Kore|American female|C+",
            "af_sarah|Sarah|American female|C+",
            "af_alloy|Alloy|American female|C",
            "af_nova|Nova|American female|C",
            "af_sky|Sky|American female|C-",
            "af_jessica|Jessica|American female|D",
            "af_river|River|American female|D",

            "am_fenrir|Fenrir|American male|C+",
            "am_michael|Michael|American male|C+",
            "am_puck|Puck|American male|C+",
            "am_echo|Echo|American male|D",
            "am_eric|Eric|American male|D",
            "am_liam|Liam|American male|D",
            "am_onyx|Onyx|American male|D",
            "am_santa|Santa|American male|D-",
            "am_adam|Adam|American male|F+",

            "bf_emma|Emma|British female|B-",
            "bf_isabella|Isabella|British female|C",
            "bf_alice|Alice|British female|D",
            "bf_lily|Lily|British female|D",

            "bm_fable|Fable|British male|C",
            "bm_george|George|British male|C",
            "bm_lewis|Lewis|British male|D+",
            "bm_daniel|Daniel|British male|D"
        };

        /// <summary>The voice a fresh install starts on: the best-graded one.</summary>
        public const string DefaultVoice = "af_heart";

        public static string VoiceId(string row) { return row.Split('|')[0]; }
        public static string VoiceName(string row) { return row.Split('|')[1]; }
        public static string VoiceGroup(string row) { return row.Split('|')[2]; }
        public static string VoiceGrade(string row) { return row.Split('|')[3]; }

        public static string ExtensionsDir(string cacheDir) { return Path.Combine(cacheDir, "extensions"); }
        public static string KokoroDir(string cacheDir) { return Path.Combine(ExtensionsDir(cacheDir), KokoroId); }
        public static string DictionariesDir(string cacheDir) { return Path.Combine(cacheDir, "dictionaries"); }

        /// <summary>Where the page loads the engine and the model from, once installed.</summary>
        public static string KokoroUrlBase { get { return "https://" + HostName + "/" + KokoroId + "/"; } }

        /// <summary>
        /// Kokoro runs on the GPU. The same model in half the precision is half the
        /// download and, measured on a WebGPU card, indistinguishable in speed -- so the
        /// larger build is offered rather than assumed.
        /// </summary>
        public static ExtensionInfo Kokoro(string cacheDir, bool fullPrecision)
        {
            string dir = KokoroDir(cacheDir);
            string model = fullPrecision ? "model.onnx" : "model_fp16.onnx";
            long modelBytes = fullPrecision ? 325532232L : 163234740L;
            string hf = "hf/" + ModelRepo + "/resolve/main/";

            var x = new ExtensionInfo
            {
                Id = KokoroId,
                Title = "Kokoro voices",
                Blurb = "Neural text-to-speech that reads far more naturally than standard Windows voices. "
                      + "Runs locally in real time via WebGPU on your graphics card.\n\n"
                      + "• Hardware: Any modern GPU with WebGPU support\n"
                      + "• Voices: 19 graded American and British voices\n"
                      + "• Engine: Kokoro-82M ONNX Runtime Web",
                Dir = dir,
                Marker = "engine.js",
                Notice =
                    "Kokoro voices for TypoZen\r\n"
                  + "=========================\r\n\r\n"
                  + "Downloaded by TypoZen at the reader's request. None of it is part of\r\n"
                  + "TypoZen, and each piece keeps its own licence.\r\n\r\n"
                  + "  Kokoro-82M (the voice model, onnx/ and voices/)\r\n"
                  + "      Apache License 2.0 -- https://huggingface.co/hexgrad/Kokoro-82M\r\n"
                  + "      ONNX conversion: https://huggingface.co/" + ModelRepo + "\r\n\r\n"
                  + "  kokoro-js (engine.js)\r\n"
                  + "      MIT -- https://github.com/hexgrad/kokoro\r\n"
                  + "      Bundles Transformers.js (Apache 2.0) and ONNX Runtime Web (MIT).\r\n"
                  + "      TypoZen rewrites two addresses in this file at install time so the\r\n"
                  + "      model is read from this folder instead of a remote host. Nothing\r\n"
                  + "      else in it is changed.\r\n\r\n"
                  + "  ONNX Runtime Web (ort-wasm-simd-threaded.jsep.*)\r\n"
                  + "      MIT -- https://github.com/microsoft/onnxruntime\r\n\r\n"
                  + "Removing this folder, or File > Extensions, removes all of it.\r\n"
            };

            // Engine first would leave a usable marker before the model arrived, so the
            // patched engine.js is written last -- see the install order below.
            x.Files.Add(new ExtensionFile { Url = OrtBase + "ort-wasm-simd-threaded.jsep.mjs", Path = "ort-wasm-simd-threaded.jsep.mjs", Bytes = 44484 });
            x.Files.Add(new ExtensionFile { Url = OrtBase + "ort-wasm-simd-threaded.jsep.wasm", Path = "ort-wasm-simd-threaded.jsep.wasm", Bytes = 21596019 });
            x.Files.Add(new ExtensionFile { Url = HfBase + "config.json", Path = hf + "config.json", Bytes = 44 });
            x.Files.Add(new ExtensionFile { Url = HfBase + "tokenizer.json", Path = hf + "tokenizer.json", Bytes = 3497 });
            x.Files.Add(new ExtensionFile { Url = HfBase + "tokenizer_config.json", Path = hf + "tokenizer_config.json", Bytes = 113 });
            x.Files.Add(new ExtensionFile { Url = HfBase + "onnx/" + model, Path = hf + "onnx/" + model, Bytes = modelBytes });
            foreach (string row in Voices)
            {
                string v = VoiceId(row);
                x.Files.Add(new ExtensionFile { Url = HfBase + "voices/" + v + ".bin", Path = hf + "voices/" + v + ".bin", Bytes = 522240 });
            }
            x.Files.Add(new ExtensionFile { Url = KokoroJs, Path = "engine.js", Bytes = 2135422, PatchEngine = true });
            return x;
        }

        public static ExtensionInfo Wiktionary(string cacheDir)
        {
            var x = new ExtensionInfo
            {
                Id = WiktionaryId,
                Title = "Wiktionary dictionary",
                Blurb = "Expanded offline English dictionary for reading definitions and pronunciation lookups.\n\n"
                      + "• Vocabulary: 1,355,154 words (built-in has 152,459)\n"
                      + "• Audio: 98,787 phonetic pronunciations\n"
                      + "• Usage: Switch active dictionary anytime via File > Dictionary",
                Dir = Path.Combine(DictionariesDir(cacheDir), WiktionaryId),
                Marker = "dictionary.tsv"
            };
            x.Files.Add(new ExtensionFile
            {
                Url = "https://github.com/ec928/TypoZen/releases/download/dictionary-wiktionary-v1/TypoZen-Wiktionary-v1.zip",
                Path = "TypoZen-Wiktionary-v1.zip",
                Bytes = 35640790,
                Sha256 = "AECC24C83A22232B268C24EF5971265777C9E46ECFFD42312073893118526D1A",
                Unzip = true
            });
            return x;
        }

        /// <summary>
        /// One English ggml model the reader can install. Sizes and checksums are the
        /// files on huggingface.co/ggerganov/whisper.cpp (the f16 .en bins). Tiny is
        /// absent: it still mangles. Small is the one the dialog offers first.
        /// </summary>
        internal sealed class WhisperModel
        {
            public string Label;
            public string FileName;
            public long Bytes;
            public string Sha256;
            public bool Recommended;
        }

        /// <summary>
        /// whisper.cpp 1.9.5, the Windows CPU build tagged b5454. OpenBLAS, not CUDA,
        /// so a narrator can stay on the graphics card. The zip unpacks to Release\,
        /// and whisper-cli.exe is the only program TypoZen runs.
        /// </summary>
        public const long WhisperRuntimeBytes = 21715607L;
        private const string WhisperZipUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip";
        private const string WhisperZipSha = "b1158bd10edf92c9799149a6fc5d3e58da3f495241d6fb3423088130e88ffbf3";
        private const string WhisperHf = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

        public static readonly WhisperModel[] WhisperModels = {
            new WhisperModel { Label = "Base English", FileName = "ggml-base.en.bin", Bytes = 147964211L,
                Sha256 = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" },
            new WhisperModel { Label = "Small English", FileName = "ggml-small.en.bin", Bytes = 487614201L,
                Sha256 = "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d", Recommended = true },
            new WhisperModel { Label = "Medium English", FileName = "ggml-medium.en.bin", Bytes = 1533774781L,
                Sha256 = "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356" }
        };

        public static int WhisperRecommendedIndex
        {
            get
            {
                for (int i = 0; i < WhisperModels.Length; i++)
                    if (WhisperModels[i].Recommended) return i;
                return 0;
            }
        }

        public static string WhisperDir(string cacheDir) { return Path.Combine(ExtensionsDir(cacheDir), WhisperId); }

        /// <summary>The model on disk, or -1 when the program or the model is missing.</summary>
        public static int WhisperInstalledIndex(string cacheDir)
        {
            try
            {
                string dir = WhisperDir(cacheDir);
                if (!File.Exists(Path.Combine(dir, "Release", "whisper-cli.exe"))) return -1;
                for (int i = 0; i < WhisperModels.Length; i++)
                    if (File.Exists(Path.Combine(dir, WhisperModels[i].FileName))) return i;
            }
            catch { }
            return -1;
        }

        public static ExtensionInfo Whisper(string cacheDir, int modelIndex)
        {
            if (modelIndex < 0 || modelIndex >= WhisperModels.Length) modelIndex = WhisperRecommendedIndex;
            WhisperModel model = WhisperModels[modelIndex];
            var x = new ExtensionInfo
            {
                Id = WhisperId,
                Title = "Whisper transcription",
                Blurb = "Writes down the words said in a recording, for Clone voice. "
                      + "Once installed, Transcribe uses this instead of Windows speech recognition. "
                      + "It runs on the processor, not the graphics card, so a narrator can stay loaded.\n\n"
                      + "• English\n"
                      + "• Small is the size to start with\n"
                      + "• whisper.cpp 1.9.5, the published Windows build, checked on download",
                Dir = WhisperDir(cacheDir),
                Marker = Path.Combine("Release", "whisper-cli.exe"),
                Check = () => WhisperInstalledIndex(cacheDir) == modelIndex,
                Notice =
                    "Whisper transcription for TypoZen\r\n"
                  + "=================================\r\n\r\n"
                  + "Downloaded by TypoZen at the reader's request. None of it is part of\r\n"
                  + "TypoZen, and each piece keeps its own licence.\r\n\r\n"
                  + "  whisper.cpp (Release\\whisper-cli.exe and the libraries beside it)\r\n"
                  + "      MIT -- https://github.com/ggml-org/whisper.cpp\r\n"
                  + "      Pinned build b5454, which is whisper.cpp 1.9.5.\r\n"
                  + "      TypoZen runs whisper-cli.exe. The archive's other programs are not.\r\n\r\n"
                  + "  OpenBLAS (libopenblas.dll, inside that build)\r\n"
                  + "      BSD-3-Clause -- https://github.com/OpenMathLib/OpenBLAS\r\n\r\n"
                  + "  OpenAI Whisper weights (the ggml English model)\r\n"
                  + "      MIT -- https://github.com/openai/whisper\r\n"
                  + "      ggml file: https://huggingface.co/ggerganov/whisper.cpp\r\n\r\n"
                  + "Removing this folder, or File > Extensions, removes all of it.\r\n"
            };
            x.Files.Add(new ExtensionFile
            {
                Url = WhisperZipUrl,
                Path = "whisper-blas-bin-x64.zip",
                Bytes = WhisperRuntimeBytes,
                Sha256 = WhisperZipSha,
                Unzip = true
            });
            x.Files.Add(new ExtensionFile
            {
                Url = WhisperHf + model.FileName,
                Path = model.FileName,
                Bytes = model.Bytes,
                Sha256 = model.Sha256
            });
            return x;
        }

        public const string QwenId = "QwenTTS";

        /// <summary>
        /// Qwen narration: a Python environment and several gigabytes of model, set up by
        /// hand (docs/archive/qwen-tts-plan.md). There is nothing here to download it with, so it has
        /// no files to fetch -- the dialog lists it only while it exists, for its size, its
        /// narration audio and a way to remove it.
        /// </summary>
        public static ExtensionInfo Qwen(string cacheDir)
        {
            return new ExtensionInfo
            {
                Id = QwenId,
                Title = "Qwen narration",
                Blurb = "Audiobook narration by Qwen3-TTS (1.7B parameters), running entirely on this PC. "
                      + "Voices dialogue by character, reads with expression taken from the text, and allows "
                      + "designing custom voices from natural-language descriptions.\n\n"
                      + "• Hardware: NVIDIA GPU with CUDA (~6 GB VRAM during render, 13 GB disk)\n"
                      + "• Features: Custom voice design, character casting, audio caching\n"
                      + "• Settings: Your voices, casts and narrator settings are retained if removed.",
                Dir = QwenNarrator.RootDir(cacheDir),
                Marker = Path.Combine("venv", "Scripts", "python.exe"),
                Check = () => QwenNarrator.EnvironmentReady(cacheDir)
            };
        }

        /// <summary>
        /// Breeze narration: a second, optional narrator beside Qwen (BreezeNarrator), installed
        /// the same way (BreezeInstaller). Measured on an RTX 4070 Ti, 2026-10-08.
        /// </summary>
        public static ExtensionInfo Breeze(string cacheDir)
        {
            return new ExtensionInfo
            {
                Id = BreezeNarrator.ExtensionId,
                Title = "Breeze narration",
                Blurb = "Expressive audiobook narration by Breeze TTS 2 (3B parameters), running entirely on this PC. "
                      + "Clones voices from reference recordings, performs native audio cues like (giggles) and (sigh), "
                      + "and starts speaking within seconds. Reads Qwen voices and casts too.\n\n"
                      + "• Hardware: NVIDIA GPU with 12 GB+ VRAM (~9 GB VRAM during reading)\n"
                      + "• Features: Zero-shot voice cloning, character casts, inline vocal events\n"
                      + "• Licence: Research & non-commercial use (BreezeBlue / RESONIA, Inc.)",
                Dir = BreezeNarrator.RootDir(cacheDir),
                Marker = Path.Combine("venv", "Scripts", "python.exe"),
                Notice = BreezeInstaller.LicenceSummary,
                Check = () => BreezeNarrator.EnvironmentReady(cacheDir)
            };
        }

        /// <summary>True when the model is there, whichever precision was chosen.</summary>
        public static bool KokoroInstalled(string cacheDir)
        {
            return Kokoro(cacheDir, false).Installed;
        }

        /// <summary>Which model file is on disk, for the page to load. Empty when none is.</summary>
        public static string KokoroModelName(string cacheDir)
        {
            try
            {
                string onnx = Path.Combine(KokoroDir(cacheDir), "hf", ModelRepo.Replace('/', Path.DirectorySeparatorChar), "resolve", "main", "onnx");
                if (File.Exists(Path.Combine(onnx, "model.onnx"))) return "fp32";
                if (File.Exists(Path.Combine(onnx, "model_fp16.onnx"))) return "fp16";
            }
            catch { }
            return "";
        }

        public static string ModelRepoId { get { return ModelRepo; } }
    }

    /// <summary>
    /// Downloads an extension's files to a staging folder and moves them into place when
    /// every one has arrived, so a cancelled or failed install leaves nothing half-there.
    /// </summary>
    internal sealed class ExtensionInstaller
    {
        private volatile bool _cancel;
        public void Cancel() { _cancel = true; }

        /// <summary>progress(bytesDone, bytesTotal, whatIsHappening)</summary>
        public delegate void Progress(long done, long total, string status);

        public string Install(ExtensionInfo x, Progress report)
        {
            string staging = x.Dir + ".part";
            try
            {
                try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
                Directory.CreateDirectory(staging);

                long total = x.DownloadBytes, done = 0;
                foreach (var f in x.Files)
                {
                    if (_cancel) return "cancelled";
                    string dest = Path.Combine(staging, f.Path.Replace('/', Path.DirectorySeparatorChar));
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    string name = Path.GetFileName(f.Path);
                    long before = done;

                    // Already downloaded, and the right size: keep it. This is what makes
                    // adding voices to a later build cost the voices, not the whole model.
                    string existing = Path.Combine(x.Dir, f.Path.Replace('/', Path.DirectorySeparatorChar));
                    if (!f.Unzip && File.Exists(existing) && new FileInfo(existing).Length == f.Bytes)
                    {
                        if (report != null) report(done, total, "Keeping " + name);
                        File.Copy(existing, dest, true);
                        done = before + f.Bytes;
                        continue;
                    }

                    Download(f.Url, dest, (got) =>
                    {
                        done = before + got;
                        if (report != null) report(done, total, "Downloading " + name);
                    });
                    if (_cancel) return "cancelled";
                    done = before + f.Bytes;

                    if (!string.IsNullOrEmpty(f.Sha256))
                    {
                        if (report != null) report(done, total, "Checking " + name);
                        string got = HashOf(dest);
                        if (!string.Equals(got, f.Sha256, StringComparison.OrdinalIgnoreCase))
                            return "The download did not match its checksum, so it was discarded.";
                    }
                    if (f.PatchEngine)
                    {
                        if (report != null) report(done, total, "Preparing the engine");
                        string why = PatchEngine(dest);
                        if (why != null) return why;
                    }
                    if (f.Unzip)
                    {
                        if (report != null) report(done, total, "Unpacking " + name);
                        ZipFile.ExtractToDirectory(dest, staging);
                        File.Delete(dest);
                    }
                }

                if (_cancel) return "cancelled";
                if (report != null) report(total, total, "Finishing");
                // The licence travels with what was downloaded, as the fonts' does.
                if (!string.IsNullOrEmpty(x.Notice))
                {
                    try { File.WriteAllText(Path.Combine(staging, "LICENSE.txt"), x.Notice, new UTF8Encoding(false)); }
                    catch { }
                }
                // Replace rather than merge: a previous install of the other precision
                // would otherwise leave its model behind, doubling the folder.
                //
                // Not Directory.Move. The folder may be one the application is reading
                // from, and a rename needs the destination to be gone entirely: if the
                // delete failed even partly -- one file still open, one handle not yet
                // closed -- the move failed, the staged download was thrown away, and what
                // was left behind was an empty folder and no dictionary. Moving file by
                // file into whatever is there does not care.
                Purge(x.Dir, false);
                MoveInto(staging, x.Dir);

                if (!x.Installed) return "The files did not arrive where they were meant to go.";
                return null;
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
            finally
            {
                try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
            }
        }

        /// <summary>
        /// Empties a folder, and removes it too unless it is wanted kept. Files first and
        /// one at a time: a folder that cannot go (something still has a handle on it, or
        /// Explorer is sitting in it) must not stop the files inside it being replaced.
        /// </summary>
        internal static void Purge(string dir, bool removeFolder)
        {
            if (!Directory.Exists(dir)) return;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                    {
                        try { File.SetAttributes(f, FileAttributes.Normal); } catch { }
                        try { File.Delete(f); } catch { }
                    }
                    foreach (string d in Directory.GetDirectories(dir))
                    {
                        try { Directory.Delete(d, true); } catch { }
                    }
                    if (removeFolder) { try { Directory.Delete(dir, true); } catch { } }
                    bool empty = !Directory.Exists(dir)
                                 || Directory.GetFileSystemEntries(dir).Length == 0;
                    if (empty) return;
                }
                catch { }
                Thread.Sleep(150);
            }
        }

        /// <summary>Moves everything from one folder into another, then drops the first.</summary>
        private static void MoveInto(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (string src in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
            {
                string rel = src.Substring(from.Length).TrimStart(Path.DirectorySeparatorChar);
                string dest = Path.Combine(to, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                try { if (File.Exists(dest)) File.Delete(dest); } catch { }
                try { File.Move(src, dest); }
                catch { File.Copy(src, dest, true); }        // across volumes, or a stale handle
            }
            try { Directory.Delete(from, true); } catch { }
        }

        private void Download(string url, string dest, Action<long> got)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = "TypoZen";
            req.Timeout = 30000;
            req.ReadWriteTimeout = 60000;
            using (var resp = req.GetResponse())
            using (var src = resp.GetResponseStream())
            using (var dst = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
            {
                var buf = new byte[1 << 16];
                long n = 0;
                int read;
                while ((read = src.Read(buf, 0, buf.Length)) > 0)
                {
                    if (_cancel) return;
                    dst.Write(buf, 0, read);
                    n += read;
                    if (got != null) got(n);
                }
            }
        }

        private static string HashOf(string path)
        {
            using (var sha = SHA256.Create())
            using (var s = File.OpenRead(path))
                return BitConverter.ToString(sha.ComputeHash(s)).Replace("-", "");
        }

        /// <summary>
        /// kokoro-js reaches the network in two places that no setting covers: the model
        /// host inside its copy of transformers.js, and one hardcoded URL for the voice
        /// files. Both are rewritten to the local folder. Each must appear exactly once --
        /// if a future build of the library moves them, the install stops here rather than
        /// shipping an engine that quietly phones out.
        /// </summary>
        private static string PatchEngine(string path)
        {
            string js = File.ReadAllText(path, Encoding.UTF8);
            string baseUrl = ExtensionCatalog.KokoroUrlBase + "hf/";
            var swaps = new[]
            {
                new[] { "remoteHost:\"https://huggingface.co/\"", "remoteHost:\"" + baseUrl + "\"" },
                new[] { "https://huggingface.co/" + ExtensionCatalog.ModelRepoId + "/resolve/main/voices/",
                        baseUrl + ExtensionCatalog.ModelRepoId + "/resolve/main/voices/" }
            };
            foreach (var s in swaps)
            {
                int first = js.IndexOf(s[0], StringComparison.Ordinal);
                if (first < 0) return "This version of the speech engine is not one TypoZen can make offline.";
                if (js.IndexOf(s[0], first + 1, StringComparison.Ordinal) >= 0)
                    return "This version of the speech engine is not one TypoZen can make offline.";
                js = js.Replace(s[0], s[1]);
            }
            File.WriteAllText(path, js, new UTF8Encoding(false));
            return null;
        }
    }

    /// <summary>The Extensions window: what is available, what is installed, and its size.</summary>
    internal static class ExtensionsDialog
    {
        /// <param name="installed">Given the id of an extension that has just been
        /// installed, for whatever should follow from having it.</param>
        public static void Show(Window owner, string cacheDir, Action changed, Action<string> installed = null)
        {
            var win = new Window
            {
                Title = "Extensions",
                Width = 980,
                Height = 740,
                MinWidth = 820,
                MinHeight = 520,
                MaxHeight = SystemParameters.WorkArea.Height - 32,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                ResizeMode = ResizeMode.CanResizeWithGrip,
                ShowInTaskbar = false,
                Background = owner != null ? owner.Background : null,
                Foreground = owner != null ? owner.Foreground : null
            };
            try { win.Owner = owner; } catch { }
            DialogTheme.Apply(win, owner);

            var header = new StackPanel { Margin = new Thickness(22, 14, 22, 10) };
            header.Children.Add(new TextBlock
            {
                Text = "Extensions",
                FontSize = 18,
                FontWeight = FontWeights.SemiBold
            });
            header.Children.Add(new TextBlock
            {
                Text = "Optional extras that are too large to bundle with TypoZen. Nothing here is downloaded "
                     + "unless you choose to install it, and removing an extension restores the default menus.",
                TextWrapping = TextWrapping.Wrap,
                Opacity = 0.75,
                Margin = new Thickness(0, 4, 0, 0)
            });

            var status = new TextBlock
            {
                TextWrapping = TextWrapping.NoWrap,
                TextTrimming = TextTrimming.CharacterEllipsis,
                Opacity = 0.85,
                VerticalAlignment = VerticalAlignment.Center
            };
            var bar = new ProgressBar
            {
                Height = 5,
                Margin = new Thickness(0, 0, 0, 4),
                Visibility = Visibility.Collapsed,
                Minimum = 0,
                Maximum = 1000
            };

            var rows = new List<Action>();          // re-read state after an install or removal
            ExtensionInstaller running = null;
            var narrInstalls = new List<NarratorInstaller>();     // the narration installs under way, to stop on close

            var contentGrid = new Grid();
            contentGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            contentGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18, GridUnitType.Pixel) });
            contentGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var leftCol = new StackPanel();
            Grid.SetColumn(leftCol, 0);
            contentGrid.Children.Add(leftCol);

            var rightCol = new StackPanel();
            Grid.SetColumn(rightCol, 2);
            contentGrid.Children.Add(rightCol);

            leftCol.Children.Add(new TextBlock
            {
                Text = "Reading & Reference",
                FontWeight = FontWeights.SemiBold,
                FontSize = 12.5,
                Opacity = 0.65,
                Margin = new Thickness(2, 0, 0, 8)
            });

            rightCol.Children.Add(new TextBlock
            {
                Text = "Neural Narrators",
                FontWeight = FontWeights.SemiBold,
                FontSize = 12.5,
                Opacity = 0.65,
                Margin = new Thickness(2, 0, 0, 8)
            });

            // Kokoro's two precisions are one extension with a choice, not two extensions.
            var quality = new ComboBox
            {
                Width = 230,
                Height = 26,
                HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 4, 0, 0)
            };
            quality.Items.Add("Standard - 186 MB download");
            quality.Items.Add("Full precision - 348 MB download");
            string installedModel = ExtensionCatalog.KokoroModelName(cacheDir);
            quality.SelectedIndex = installedModel == "fp32" ? 1 : 0;

            Func<ExtensionInfo> kokoroChosen = () => ExtensionCatalog.Kokoro(cacheDir, quality.SelectedIndex == 1);

            // Whisper's sizes are one extension with a choice, the same way Kokoro's precisions are.
            var whisperSize = new ComboBox
            {
                Width = 320,
                Height = 26,
                HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 4, 0, 0)
            };
            for (int i = 0; i < ExtensionCatalog.WhisperModels.Length; i++)
            {
                var wm = ExtensionCatalog.WhisperModels[i];
                string tail = wm.Recommended ? " (recommended)" : "";
                whisperSize.Items.Add(wm.Label + " - " + Human(wm.Bytes + ExtensionCatalog.WhisperRuntimeBytes) + tail);
            }
            int haveWhisper = ExtensionCatalog.WhisperInstalledIndex(cacheDir);
            whisperSize.SelectedIndex = haveWhisper >= 0 ? haveWhisper : ExtensionCatalog.WhisperRecommendedIndex;
            Func<ExtensionInfo> whisperChosen = () => ExtensionCatalog.Whisper(cacheDir,
                whisperSize.SelectedIndex < 0 ? ExtensionCatalog.WhisperRecommendedIndex : whisperSize.SelectedIndex);

            Action<ExtensionInfo, Func<ExtensionInfo>, Panel> addRow = null;
            addRow = (info, live, targetCol) =>
            {
                var narr = NarratorExtension.For(info.Id);
                bool isNarr = narr != null;
                NarratorInstaller narrRunning = null;

                var box = new Border
                {
                    BorderBrush = new SolidColorBrush(Color.FromArgb(40, 128, 128, 128)),
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(6),
                    Background = new SolidColorBrush(Color.FromArgb(12, 128, 128, 128)),
                    Padding = new Thickness(14, 10, 14, 10),
                    Margin = new Thickness(0, 0, 0, 10)
                };

                var panel = new StackPanel();

                // Header row: Title + Badge
                var headerRow = new DockPanel { LastChildFill = false };
                var titleText = new TextBlock
                {
                    Text = info.Title,
                    FontWeight = FontWeights.SemiBold,
                    FontSize = 13.5,
                    VerticalAlignment = VerticalAlignment.Center
                };
                DockPanel.SetDock(titleText, Dock.Left);
                headerRow.Children.Add(titleText);

                string badgeText = "";
                if (info.Id == ExtensionCatalog.KokoroId) badgeText = "WebGPU Neural";
                else if (info.Id == ExtensionCatalog.WiktionaryId) badgeText = "Offline TSV";
                else if (info.Id == ExtensionCatalog.WhisperId) badgeText = "Speech to text · CPU";
                else if (info.Id == BreezeNarrator.ExtensionId) badgeText = "3B Model · CUDA";
                else if (info.Id == ExtensionCatalog.QwenId) badgeText = "1.7B Model · CUDA";

                if (!string.IsNullOrEmpty(badgeText))
                {
                    var badge = new Border
                    {
                        CornerRadius = new CornerRadius(4),
                        BorderThickness = new Thickness(1),
                        BorderBrush = new SolidColorBrush(Color.FromArgb(35, 128, 128, 128)),
                        Background = new SolidColorBrush(Color.FromArgb(20, 128, 128, 128)),
                        Padding = new Thickness(6, 2, 6, 2),
                        VerticalAlignment = VerticalAlignment.Center
                    };
                    DockPanel.SetDock(badge, Dock.Right);
                    badge.Child = new TextBlock
                    {
                        Text = badgeText,
                        FontSize = 10.5,
                        FontWeight = FontWeights.Medium,
                        Opacity = 0.8
                    };
                    headerRow.Children.Add(badge);
                }
                panel.Children.Add(headerRow);

                if (isNarr)
                {
                    panel.Children.Add(new TextBlock
                    {
                        Text = "Experimental · Runs local model on NVIDIA GPU",
                        FontSize = 11,
                        FontWeight = FontWeights.Medium,
                        Opacity = 0.7,
                        Margin = new Thickness(0, 2, 0, 0)
                    });
                }

                panel.Children.Add(new TextBlock
                {
                    Text = info.Blurb,
                    TextWrapping = TextWrapping.Wrap,
                    Opacity = 0.85,
                    FontSize = 11.5,
                    Margin = new Thickness(0, 6, 0, 0)
                });

                if (info.Id == ExtensionCatalog.KokoroId)
                {
                    var qualPanel = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
                    qualPanel.Children.Add(new TextBlock { Text = "Model precision:", FontSize = 11, Opacity = 0.7 });
                    qualPanel.Children.Add(quality);
                    panel.Children.Add(qualPanel);
                }
                if (info.Id == ExtensionCatalog.WhisperId)
                {
                    var qualPanel = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
                    qualPanel.Children.Add(new TextBlock { Text = "Model:", FontSize = 11, Opacity = 0.7 });
                    qualPanel.Children.Add(whisperSize);
                    qualPanel.Children.Add(new TextBlock
                    {
                        Text = "The choice is fixed once it is installed. Remove it to pick another size.",
                        FontSize = 11,
                        Opacity = 0.7,
                        TextWrapping = TextWrapping.Wrap,
                        Margin = new Thickness(0, 4, 0, 0)
                    });
                    panel.Children.Add(qualPanel);
                }

                var state = new TextBlock
                {
                    Margin = new Thickness(0, 7, 0, 5),
                    Opacity = 0.85,
                    FontSize = 11.5,
                    TextWrapping = TextWrapping.Wrap
                };
                panel.Children.Add(state);

                var buttons = new StackPanel { Orientation = Orientation.Horizontal };
                var button = new Button { Width = 95, Height = 26 };
                buttons.Children.Add(button);

                var clearAudio = new Button { Content = "Clear audio", Width = 95, Height = 26, Margin = new Thickness(8, 0, 0, 0) };
                if (isNarr) buttons.Children.Add(clearAudio);
                panel.Children.Add(buttons);

                box.Child = panel;
                targetCol.Children.Add(box);

                Action refresh = () =>
                {
                    var now = live();
                    bool on = now.Installed;
                    long onDisk = SizeOf(now.Dir);
                    long short_ = on ? now.MissingBytes() : 0;
                    if (on && short_ > 0)
                    {
                        int n = now.Missing().Count;
                        state.Text = "Installed · " + Human(onDisk) + " on disk ("
                                   + n + (n == 1 ? " new file" : " new files")
                                   + " to download, " + Human(short_) + ")";
                    }
                    else
                    {
                        state.Text = on
                            ? "Installed · " + Human(onDisk) + " on disk"
                            : "Not installed · " + Human(now.DownloadBytes) + " to download";
                    }
                    button.Content = on ? (short_ > 0 ? "Update" : "Remove") : "Install";
                    if (info.Id == ExtensionCatalog.KokoroId) quality.IsEnabled = !on;
                    if (info.Id == ExtensionCatalog.WhisperId) whisperSize.IsEnabled = !on;
                    if (isNarr)
                    {
                        long audio = SizeOf(narr.AudioDir(cacheDir));
                        bool partway = File.Exists(narr.Installer().InstallFlag(cacheDir));
                        bool voices = Directory.Exists(Path.Combine(now.Dir, "voices"))
                                      && Directory.GetDirectories(Path.Combine(now.Dir, "voices")).Length > 0;
                        state.Text = on
                            ? "Installed · " + Human(onDisk) + " on disk" + (audio > 0 ? " (" + Human(audio) + " audio cache)" : "")
                            : partway
                                ? "Incomplete · " + Human(onDisk) + " downloaded so far (resumes on Install)"
                                : "Not installed · ~" + Human(narr.DownloadBytes) + " to download" + (voices ? " · Saved voices kept" : "");
                        if (narrRunning == null) button.Content = on ? "Remove" : "Install";
                        clearAudio.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
                        clearAudio.IsEnabled = audio > 0;
                    }
                };
                rows.Add(refresh);

                clearAudio.Click += (s, e) =>
                {
                    string audioDir = narr.AudioDir(cacheDir);
                    var ask = MessageBox.Show(win,
                        "Delete the narration audio? " + Human(SizeOf(audioDir)) + " will be deleted, and "
                        + "anything narrated again will render again.",
                        "Extensions", MessageBoxButton.OKCancel, MessageBoxImage.Question);
                    if (ask != MessageBoxResult.OK) return;
                    // The narrator writes into this folder; stopped first so nothing is
                    // half-written into it while it goes. It starts again on the next Narrate.
                    narr.Stop();
                    ExtensionInstaller.Purge(audioDir, true);
                    foreach (var r in rows) r();
                    status.Text = SizeOf(audioDir) > 0
                        ? "Some narration audio could not be deleted."
                        : "Narration audio deleted.";
                };

                button.Click += (s, e) =>
                {
                    var now = live();
                    if (now.Installed && now.MissingBytes() == 0)
                    {
                        // Narration's voices cannot be downloaded again -- the same description
                        // makes a different person -- so Remove takes the program, its models and
                        // the audio, and keeps the voices, casts and settings for when it is set up
                        // again. It used to delete the whole folder, voices included, without a word.
                        long goes = 0;
                        if (isNarr) foreach (string part in narr.RemovableParts) goes += SizeOf(Path.Combine(now.Dir, part));
                        var ask = MessageBox.Show(win,
                            isNarr
                                ? "Remove " + now.Title + "? The program and its models, " + Human(goes) + ", will be deleted. "
                                  + "Your voices, casts and narrator settings are kept, and are there again if it is set up again."
                                : "Remove " + now.Title + "? " + Human(SizeOf(now.Dir)) + " will be deleted.",
                            "Extensions", MessageBoxButton.OKCancel, MessageBoxImage.Question);
                        if (ask != MessageBoxResult.OK) return;
                        // Hand it back before deleting it: while the reader has this
                        // dictionary chosen, the application is the thing reading the file.
                        if (changed != null) changed();
                        // The narrator runs out of this folder; a running python.exe would
                        // hold its own files and most of the folder would stay behind.
                        if (isNarr)
                        {
                            narr.Stop();
                            foreach (string part in narr.RemovableParts)
                                ExtensionInstaller.Purge(Path.Combine(now.Dir, part), true);
                        }
                        else ExtensionInstaller.Purge(now.Dir, true);
                        foreach (var r in rows) r();
                        if (changed != null) changed();
                        status.Text = now.Installed
                            ? "Some of " + now.Title + " could not be removed -- close TypoZen and delete the folder by hand."
                            : now.Title + " removed.";
                        return;
                    }

                    if (isNarr)
                    {
                        if (narrRunning != null) { narrRunning.Cancel(); status.Text = "Stopping..."; return; }
                        var qi = narr.Installer();
                        string why = qi.Preflight(cacheDir);
                        if (why != null) { status.Text = why; return; }
                        // Asked on a fresh install, not when carrying on from a cancelled one.
                        if (!File.Exists(qi.InstallFlag(cacheDir)))
                        {
                            var risk = MessageBox.Show(win,
                                qi.Name + " is experimental.\n\n"
                                + "Install downloads about " + Human(narr.DownloadBytes) + " from other parties' "
                                + "servers (github.com, pypi.org, download.pytorch.org and huggingface.co) and runs a "
                                + "large speech model on your graphics card. It has been tested on one PC only.\n\n"
                                + (narr.Licence != null ? narr.Licence + "\n\n" : "")
                                + "Download and use it at your own risk. Install?",
                                qi.Name, MessageBoxButton.OKCancel, MessageBoxImage.Warning);
                            if (risk != MessageBoxResult.OK) return;
                        }
                        narrRunning = qi;
                        narrInstalls.Add(qi);
                        // Breeze's install ends by loading its model to prepare the graphics card; a
                        // narrator already on the card would leave too little room for it.
                        QwenNarrator.Stop();
                        BreezeNarrator.Stop();
                        button.Content = "Cancel";
                        bar.Visibility = Visibility.Visible;
                        bar.IsIndeterminate = true;
                        status.Text = "Starting...";
                        string appDir = AppDomain.CurrentDomain.BaseDirectory;
                        var qworker = new Thread(() =>
                        {
                            string problem = qi.Install(cacheDir, appDir, (done, total, what) =>
                            {
                                win.Dispatcher.BeginInvoke((Action)(() =>
                                {
                                    if (total > 0)
                                    {
                                        bar.IsIndeterminate = false;
                                        bar.Value = (double)done / total * 1000.0;
                                        status.Text = what + "   " + Human(done) + " of " + Human(total);
                                    }
                                    else
                                    {
                                        bar.IsIndeterminate = true;
                                        status.Text = what;
                                    }
                                }));
                            });
                            win.Dispatcher.BeginInvoke((Action)(() =>
                            {
                                narrRunning = null;
                                bar.IsIndeterminate = false;
                                bar.Visibility = Visibility.Collapsed;
                                foreach (var r in rows) r();
                                if (problem == null)
                                {
                                    status.Text = narr.ReadyText;
                                    if (changed != null) changed();
                                    if (installed != null) installed(info.Id);
                                }
                                else if (problem == "cancelled")
                                    status.Text = "Install stopped. What was downloaded is kept; Install continues from there.";
                                else
                                    status.Text = "Install failed: " + problem + " Details are in install.log in the extension folder.";
                            }));
                        });
                        qworker.IsBackground = true;
                        qworker.Start();
                        return;
                    }

                    if (running != null) { running.Cancel(); return; }

                    var installer = new ExtensionInstaller();
                    running = installer;
                    button.Content = "Cancel";
                    bar.Visibility = Visibility.Visible;
                    bar.Value = 0;
                    status.Text = "Starting...";

                    var worker = new Thread(() =>
                    {
                        string problem = installer.Install(now, (done, total, what) =>
                        {
                            win.Dispatcher.BeginInvoke((Action)(() =>
                            {
                                bar.Value = total > 0 ? (double)done / total * 1000.0 : 0;
                                status.Text = what + "   " + Human(done) + " of " + Human(total);
                            }));
                        });
                        win.Dispatcher.BeginInvoke((Action)(() =>
                        {
                            running = null;
                            bar.Visibility = Visibility.Collapsed;
                            string nowModel = ExtensionCatalog.KokoroModelName(cacheDir);
                            if (nowModel.Length > 0) quality.SelectedIndex = nowModel == "fp32" ? 1 : 0;
                            int nowWhisper = ExtensionCatalog.WhisperInstalledIndex(cacheDir);
                            if (nowWhisper >= 0) whisperSize.SelectedIndex = nowWhisper;
                            foreach (var r in rows) r();
                            if (problem == null)
                            {
                                status.Text = now.Title + " is ready.";
                                if (changed != null) changed();
                                if (installed != null) installed(now.Id);
                            }
                            else if (problem == "cancelled") status.Text = "Install cancelled - nothing was kept.";
                            else status.Text = "Install failed: " + problem;
                        }));
                    });
                    worker.IsBackground = true;
                    worker.Start();
                };
            };

            addRow(ExtensionCatalog.Kokoro(cacheDir, false), kokoroChosen, leftCol);
            var wikt = ExtensionCatalog.Wiktionary(cacheDir);
            addRow(wikt, () => wikt, leftCol);
            addRow(ExtensionCatalog.Whisper(cacheDir, whisperSize.SelectedIndex), whisperChosen, leftCol);

            // Breeze first (preferred narrator), then Qwen
            var breeze = ExtensionCatalog.Breeze(cacheDir);
            addRow(breeze, () => breeze, rightCol);
            var qwen = ExtensionCatalog.Qwen(cacheDir);
            addRow(qwen, () => qwen, rightCol);

            quality.SelectionChanged += (s, e) => { foreach (var r in rows) r(); };
            whisperSize.SelectionChanged += (s, e) => { foreach (var r in rows) r(); };

            var footerStatusPanel = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            footerStatusPanel.Children.Add(bar);
            footerStatusPanel.Children.Add(status);

            var close = new Button
            {
                Content = "Close",
                Width = 90,
                Height = 28,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
                IsCancel = true
            };
            close.Click += (s, e) => win.Close();

            var footerGrid = new Grid();
            footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(footerStatusPanel, 0);
            footerStatusPanel.Margin = new Thickness(0, 0, 16, 0);
            Grid.SetColumn(close, 1);
            footerGrid.Children.Add(footerStatusPanel);
            footerGrid.Children.Add(close);

            var footerBorder = new Border
            {
                BorderThickness = new Thickness(0, 1, 0, 0),
                BorderBrush = new SolidColorBrush(Color.FromArgb(40, 128, 128, 128)),
                Background = new SolidColorBrush(Color.FromArgb(12, 128, 128, 128)),
                Padding = new Thickness(22, 10, 22, 10)
            };
            footerBorder.Child = footerGrid;

            var outer = new DockPanel();
            DockPanel.SetDock(header, Dock.Top);
            outer.Children.Add(header);
            DockPanel.SetDock(footerBorder, Dock.Bottom);
            outer.Children.Add(footerBorder);

            var scrollViewer = new ScrollViewer
            {
                Content = contentGrid,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Padding = new Thickness(22, 0, 22, 4)
            };
            outer.Children.Add(scrollViewer);
            win.Content = outer;

            foreach (var r in rows) r();
            win.Closing += (s, e) => { if (running != null) running.Cancel(); foreach (var n in narrInstalls) n.Cancel(); };
            // Not swallowed: a dialog that fails to open is invisible twice over if the
            // reason is thrown away, which cost an afternoon the first time.
            win.ShowDialog();
        }

        /// <summary>
        /// Disk used by a folder. A file hard-linked under two names -- the speech tokenizer the
        /// two Qwen models share -- is on disk once and counted once, by its NTFS file id.
        /// Only files over a megabyte are checked: that is where sharing is worth the handle.
        /// </summary>
        private static long SizeOf(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) return 0;
                long n = 0;
                var seen = new HashSet<string>();
                foreach (var f in new DirectoryInfo(dir).GetFiles("*", SearchOption.AllDirectories))
                {
                    try
                    {
                        if (f.Length > (1 << 20))
                        {
                            string id = FileId(f.FullName);
                            if (id != null && !seen.Add(id)) continue;
                        }
                        n += f.Length;
                    }
                    catch { }
                }
                return n;
            }
            catch { return 0; }
        }

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
            public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle file, out ByHandleFileInformation info);

        /// <summary>Volume and file index, the same for every name of one file; null if unreadable.</summary>
        private static string FileId(string path)
        {
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    ByHandleFileInformation info;
                    if (!GetFileInformationByHandle(fs.SafeFileHandle, out info)) return null;
                    if (info.NumberOfLinks < 2) return null;
                    return info.VolumeSerialNumber + ":" + info.FileIndexHigh + ":" + info.FileIndexLow;
                }
            }
            catch { return null; }
        }

        private static string Human(long bytes)
        {
            if (bytes >= 1024L * 1024L * 1024L) return (bytes / 1073741824.0).ToString("0.#") + " GB";
            if (bytes >= 1024L * 1024L) return (bytes / 1048576.0).ToString("0.#") + " MB";
            if (bytes >= 1024L) return (bytes / 1024L) + " KB";
            return bytes + " bytes";
        }
    }

    /// <summary>
    /// Runs the installed whisper.cpp on one wav. Returns the words, or null.
    /// error is null when Whisper is not installed, which is the caller's cue to use
    /// Windows speech recognition. Any other null is a failure, and Windows is not tried.
    /// </summary>
    internal static class WhisperTranscriber
    {
        /// <summary>A clip that has not finished by then is stopped. Not a measured runtime.</summary>
        private const int TimeoutMs = 6 * 60 * 1000;

        public static string Transcribe(string cacheDir, string wavPath, out string error)
        {
            error = null;
            int which = ExtensionCatalog.WhisperInstalledIndex(cacheDir);
            if (which < 0) return null;
            string exe = Path.Combine(ExtensionCatalog.WhisperDir(cacheDir), "Release", "whisper-cli.exe");
            string model = Path.Combine(ExtensionCatalog.WhisperDir(cacheDir), ExtensionCatalog.WhisperModels[which].FileName);
            string scratch = Path.Combine(Path.GetTempPath(), "tzwhisp-" + Guid.NewGuid().ToString("N"));
            string txt = scratch + ".txt";
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = exe,
                    WorkingDirectory = Path.GetDirectoryName(exe),
                    Arguments = "-m \"" + model + "\" -f \"" + wavPath + "\" -l en -nt -np -otxt -of \"" + scratch + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };
                using (var p = Process.Start(psi))
                {
                    // Both pipes have to be drained. A full one stalls whisper-cli, and WaitForExit never returns.
                    Task<string> outTask = Task.Run(() => p.StandardOutput.ReadToEnd());
                    Task<string> errTask = Task.Run(() => p.StandardError.ReadToEnd());
                    if (!p.WaitForExit(TimeoutMs))
                    {
                        try { p.Kill(); } catch { }
                        try { p.WaitForExit(2000); } catch { }
                        try { outTask.Wait(2000); } catch { }
                        try { errTask.Wait(2000); } catch { }
                        error = "Whisper did not finish. Try a shorter stretch.";
                        return null;
                    }
                    string stdout = "";
                    string stderr = "";
                    try { stdout = outTask.Result; } catch { }
                    try { stderr = errTask.Result; } catch { }
                    string words = ReadTranscript(txt, stdout);
                    if (!string.IsNullOrWhiteSpace(words)) return words;
                    error = p.ExitCode != 0
                        ? "Whisper failed" + ShortErr(stderr)
                        : "Whisper did not hear any words in that stretch.";
                    return null;
                }
            }
            catch (Exception ex)
            {
                error = "Whisper failed. " + ex.Message;
                return null;
            }
            finally
            {
                try { if (File.Exists(txt)) File.Delete(txt); } catch { }
            }
        }

        /// <summary>The text file whisper-cli writes, then stdout. Blank lines are dropped.</summary>
        private static string ReadTranscript(string txtPath, string stdout)
        {
            string raw = "";
            try
            {
                if (File.Exists(txtPath)) raw = File.ReadAllText(txtPath, Encoding.UTF8);
            }
            catch { }
            if (string.IsNullOrWhiteSpace(raw)) raw = stdout ?? "";
            var parts = raw.Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            return string.Join(" ", parts);
        }

        private static string ShortErr(string stderr)
        {
            if (string.IsNullOrWhiteSpace(stderr)) return ".";
            string last = "";
            foreach (string line in stderr.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                last = line.Trim();
            if (last.Length > 180) last = last.Substring(0, 180);
            return last.Length == 0 ? "." : ": " + last;
        }
    }

    /// <summary>
    /// What the Extensions dialog needs to know about a narration extension -- its install, its
    /// audio, what Remove takes -- so the Qwen and Breeze rows are one code path.
    /// </summary>
    internal sealed class NarratorExtension
    {
        public Func<NarratorInstaller> Installer;
        public Func<string, string> AudioDir;
        public string[] RemovableParts;
        public Action Stop;
        public long DownloadBytes;
        public string ReadyText;
        /// <summary>Said before a fresh install, when its licence needs saying; null otherwise.</summary>
        public string Licence;

        public static NarratorExtension For(string id)
        {
            if (id == ExtensionCatalog.QwenId)
                return new NarratorExtension
                {
                    Installer = QwenInstaller.Create, AudioDir = QwenNarrator.CacheDir, RemovableParts = QwenNarrator.RemovableParts,
                    Stop = QwenNarrator.Stop, DownloadBytes = QwenInstaller.DownloadBytes,
                    ReadyText = "Qwen narration is ready. Choose a Qwen voice in File > Read Aloud."
                };
            if (id == BreezeNarrator.ExtensionId)
                return new NarratorExtension
                {
                    Installer = BreezeInstaller.Create, AudioDir = BreezeNarrator.CacheDir, RemovableParts = BreezeNarrator.RemovableParts,
                    Stop = BreezeNarrator.Stop, DownloadBytes = BreezeInstaller.DownloadBytes,
                    ReadyText = "Breeze narration is ready. Choose a Breeze voice in File > Read Aloud.",
                    Licence = BreezeInstaller.LicenceSummary
                };
            return null;
        }
    }
}
