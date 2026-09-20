using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
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
        public List<ExtensionFile> Files = new List<ExtensionFile>();

        public bool Installed
        {
            get
            {
                try { return File.Exists(System.IO.Path.Combine(Dir, Marker)); }
                catch { return false; }
            }
        }

        public long DownloadBytes
        {
            get { long n = 0; foreach (var f in Files) n += f.Bytes; return n; }
        }
    }

    internal static class ExtensionCatalog
    {
        public const string KokoroId = "Kokoro";
        public const string WiktionaryId = "Wiktionary";

        /// <summary>Virtual host the page loads extension files through.</summary>
        public const string HostName = "localextensions";

        /// <summary>Pinned: an upstream that moves on is an install that breaks silently.</summary>
        private const string KokoroJs = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.min.js";
        private const string OrtBase = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/dist/";
        private const string ModelRepo = "onnx-community/Kokoro-82M-v1.0-ONNX";
        private const string HfBase = "https://huggingface.co/" + ModelRepo + "/resolve/main/";

        /// <summary>
        /// The voices offered in the menu. Kokoro publishes more; these are the ones with
        /// names in the UI, at about 0.5 MB each.
        /// </summary>
        public static readonly string[] Voices = {
            "af_heart", "af_alloy", "af_bella", "af_sarah", "af_nova",
            "am_fenrir", "am_puck", "am_echo", "am_adam", "am_michael",
            "bf_alice", "bf_emma", "bm_fable", "bm_george"
        };

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
                Blurb = "Neural voices that read far more naturally than the Windows ones. "
                      + "Needs a graphics card with WebGPU; everything runs on this computer.",
                Dir = dir,
                Marker = "engine.js"
            };

            // Engine first would leave a usable marker before the model arrived, so the
            // patched engine.js is written last -- see the install order below.
            x.Files.Add(new ExtensionFile { Url = OrtBase + "ort-wasm-simd-threaded.jsep.mjs", Path = "ort-wasm-simd-threaded.jsep.mjs", Bytes = 44484 });
            x.Files.Add(new ExtensionFile { Url = OrtBase + "ort-wasm-simd-threaded.jsep.wasm", Path = "ort-wasm-simd-threaded.jsep.wasm", Bytes = 21596019 });
            x.Files.Add(new ExtensionFile { Url = HfBase + "config.json", Path = hf + "config.json", Bytes = 44 });
            x.Files.Add(new ExtensionFile { Url = HfBase + "tokenizer.json", Path = hf + "tokenizer.json", Bytes = 3497 });
            x.Files.Add(new ExtensionFile { Url = HfBase + "tokenizer_config.json", Path = hf + "tokenizer_config.json", Bytes = 113 });
            x.Files.Add(new ExtensionFile { Url = HfBase + "onnx/" + model, Path = hf + "onnx/" + model, Bytes = modelBytes });
            foreach (string v in Voices)
                x.Files.Add(new ExtensionFile { Url = HfBase + "voices/" + v + ".bin", Path = hf + "voices/" + v + ".bin", Bytes = 522240 });
            x.Files.Add(new ExtensionFile { Url = KokoroJs, Path = "engine.js", Bytes = 2135422, PatchEngine = true });
            return x;
        }

        public static ExtensionInfo Wiktionary(string cacheDir)
        {
            var x = new ExtensionInfo
            {
                Id = WiktionaryId,
                Title = "Wiktionary dictionary",
                Blurb = "1,355,154 words against the built-in dictionary's 152,459, with pronunciations "
                      + "for 98,787 of them. The built-in one still orders senses better, so both stay "
                      + "and File > Dictionary switches between them.",
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
        public static void Show(Window owner, string cacheDir, Action changed)
        {
            var win = new Window
            {
                Title = "Extensions",
                SizeToContent = SizeToContent.Height,
                Width = 560,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                ResizeMode = ResizeMode.NoResize,
                ShowInTaskbar = false,
                Background = owner != null ? owner.Background : null,
                Foreground = owner != null ? owner.Foreground : null
            };
            try { win.Owner = owner; } catch { }

            var root = new StackPanel { Margin = new Thickness(18) };
            root.Children.Add(new TextBlock
            {
                Text = "Extras that are too large to ship with TypoZen. Nothing here is downloaded "
                     + "unless you ask for it, and removing one takes its menu away again.",
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 14)
            });

            var status = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 14, 0, 0), Opacity = 0.85 };
            var bar = new ProgressBar { Height = 6, Margin = new Thickness(0, 8, 0, 0), Visibility = Visibility.Collapsed, Minimum = 0, Maximum = 1000 };

            var rows = new List<Action>();          // re-read state after an install or removal
            ExtensionInstaller running = null;

            // Kokoro's two precisions are one extension with a choice, not two extensions.
            var quality = new ComboBox { Width = 210, Margin = new Thickness(0, 6, 0, 0) };
            quality.Items.Add("Standard - 186 MB download");
            quality.Items.Add("Full precision - 348 MB download");
            quality.SelectedIndex = 0;

            Func<ExtensionInfo> kokoroChosen = () => ExtensionCatalog.Kokoro(cacheDir, quality.SelectedIndex == 1);

            Action<ExtensionInfo, Func<ExtensionInfo>> addRow = null;
            addRow = (info, live) =>
            {
                var box = new Border
                {
                    BorderBrush = new SolidColorBrush(Color.FromArgb(60, 128, 128, 128)),
                    BorderThickness = new Thickness(1),
                    Padding = new Thickness(12),
                    Margin = new Thickness(0, 0, 0, 10)
                };
                var panel = new StackPanel();
                panel.Children.Add(new TextBlock { Text = info.Title, FontWeight = FontWeights.SemiBold });
                panel.Children.Add(new TextBlock
                {
                    Text = info.Blurb,
                    TextWrapping = TextWrapping.Wrap,
                    Opacity = 0.8,
                    Margin = new Thickness(0, 3, 0, 0)
                });
                if (info.Id == ExtensionCatalog.KokoroId) panel.Children.Add(quality);

                var state = new TextBlock { Margin = new Thickness(0, 8, 0, 0), Opacity = 0.9 };
                var button = new Button { Width = 110, Height = 26, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 8, 0, 0) };
                panel.Children.Add(state);
                panel.Children.Add(button);
                box.Child = panel;
                root.Children.Add(box);

                Action refresh = () =>
                {
                    var now = live();
                    bool on = now.Installed;
                    long onDisk = SizeOf(now.Dir);
                    state.Text = on
                        ? "Installed - " + Human(onDisk) + " on disk"
                        : "Not installed - " + Human(now.DownloadBytes) + " to download";
                    button.Content = on ? "Remove" : "Install";
                    if (info.Id == ExtensionCatalog.KokoroId) quality.IsEnabled = !on;
                };
                rows.Add(refresh);

                button.Click += (s, e) =>
                {
                    var now = live();
                    if (now.Installed)
                    {
                        var ask = MessageBox.Show(win,
                            "Remove " + now.Title + "? " + Human(SizeOf(now.Dir)) + " will be deleted.",
                            "Extensions", MessageBoxButton.OKCancel, MessageBoxImage.Question);
                        if (ask != MessageBoxResult.OK) return;
                        // Hand it back before deleting it: while the reader has this
                        // dictionary chosen, the application is the thing reading the file.
                        if (changed != null) changed();
                        ExtensionInstaller.Purge(now.Dir, true);
                        foreach (var r in rows) r();
                        if (changed != null) changed();
                        status.Text = now.Installed
                            ? "Some of " + now.Title + " could not be removed -- close TypoZen and delete the folder by hand."
                            : now.Title + " removed.";
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
                            foreach (var r in rows) r();
                            if (problem == null)
                            {
                                status.Text = now.Title + " is ready.";
                                if (changed != null) changed();
                            }
                            else if (problem == "cancelled") status.Text = "Install cancelled - nothing was kept.";
                            else status.Text = "Install failed: " + problem;
                        }));
                    });
                    worker.IsBackground = true;
                    worker.Start();
                };
            };

            addRow(ExtensionCatalog.Kokoro(cacheDir, false), kokoroChosen);
            var wikt = ExtensionCatalog.Wiktionary(cacheDir);
            addRow(wikt, () => wikt);

            quality.SelectionChanged += (s, e) => { foreach (var r in rows) r(); };

            root.Children.Add(bar);
            root.Children.Add(status);

            var close = new Button { Content = "Close", Width = 90, Height = 26, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0), IsCancel = true };
            root.Children.Add(close);
            win.Content = root;

            foreach (var r in rows) r();
            win.Closing += (s, e) => { if (running != null) running.Cancel(); };
            // Not swallowed: a dialog that fails to open is invisible twice over if the
            // reason is thrown away, which cost an afternoon the first time.
            win.ShowDialog();
        }

        private static long SizeOf(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) return 0;
                long n = 0;
                foreach (var f in new DirectoryInfo(dir).GetFiles("*", SearchOption.AllDirectories))
                {
                    try { n += f.Length; } catch { }
                }
                return n;
            }
            catch { return 0; }
        }

        private static string Human(long bytes)
        {
            if (bytes >= 1024L * 1024L * 1024L) return (bytes / 1073741824.0).ToString("0.#") + " GB";
            if (bytes >= 1024L * 1024L) return (bytes / 1048576.0).ToString("0.#") + " MB";
            if (bytes >= 1024L) return (bytes / 1024L) + " KB";
            return bytes + " bytes";
        }
    }
}
