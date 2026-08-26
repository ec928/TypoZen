using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Shell;
using System.Windows.Forms.Integration;
using System.Windows.Threading;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;
using WinForms = System.Windows.Forms;

// Assembly identity, so Explorer -> Properties -> Details reports a real version rather
// than 0.0.0.0. Derived from Program.AppVersion rather than repeated: a const string plus
// a literal is a compile-time constant, which is all an attribute argument has to be, so
// there is exactly one place to edit and the resource cannot drift from the About modal.
[assembly: System.Reflection.AssemblyTitle("TypoZen")]
[assembly: System.Reflection.AssemblyProduct("TypoZen")]
[assembly: System.Reflection.AssemblyDescription("WYSIWYG Markdown and text editor for Windows")]
[assembly: System.Reflection.AssemblyVersion(TypoZen.Program.AppVersion + ".0")]
[assembly: System.Reflection.AssemblyFileVersion(TypoZen.Program.AppVersion + ".0")]
[assembly: System.Reflection.AssemblyInformationalVersion(TypoZen.Program.AppVersion)]

namespace TypoZen
{
    public class Program
    {
        /// <summary>
        /// The app's version, and the only place it is written down.
        /// </summary>
        /// <remarks>
        /// Three digits, no "v" -- the tag carries that (v0.2.0, v0.1.0). The assembly
        /// attributes above build their values from this, and the About modal is stamped
        /// with it when the template is prepared for navigation, so a bump here reaches
        /// the file properties and the UI together. Nothing else may hold a copy.
        /// </remarks>
        internal const string AppVersion = "0.2.10";

        /// <summary>
        /// Where "Report a problem or suggest a feature" in About goes.
        /// </summary>
        /// <remarks>
        /// /issues/new/choose rather than /issues: the repo has bug_report and
        /// feature_request templates plus a Discussions contact link, so the chooser asks
        /// the reader which they have and routes the open-ended ones away from the tracker.
        /// Held here and not in the page on purpose -- the page asks for "feedback" and
        /// gets this address, so no document rendered in the editor can talk the shell into
        /// opening something else.
        /// </remarks>
        internal const string IssuesUrl = "https://github.com/ec928/TypoZen/issues/new/choose";

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool AllowSetForegroundWindow(uint dwProcessId);

        // One running window; further Explorer double-clicks hand off paths over a named pipe
        // and exit (Notepad-style tabs, not a new process per file).
        private const string SingleInstanceMutexName = @"Local\TypoZen_SingleInstance_v1";
        internal const string OpenPipeName = "TypoZen_Open_v1";

        // Telemetry log. Off unless --debug is passed (or TYPOZEN_DEBUG is set), so an
        // ordinary run never writes debug.log next to the executable. TypoZen_Debug.bat
        // launches with the flag for column/pagination work.
        internal static bool DebugLogEnabled;

        /// <summary>DevTools port opened only under --debug, for tests/app-harness.mjs.</summary>
        internal const int RemoteDebugPort = 9333;

        // --- Startup instrumentation --------------------------------------------------
        //
        // OFF unless the environment variable TYPOZEN_PERF is set and non-empty. When off,
        // PerfMark returns on a cached bool before touching the clock, the disk or a string,
        // so instrumented paths cost effectively nothing in a normal run. Nothing is created,
        // no file is opened, and no perf.log appears.
        //
        // To use it:
        //     $env:TYPOZEN_PERF = '1'      # this shell only - do NOT set it persistently
        //     .\TypoZen.exe "some\file.md"
        //     Get-Content "$env:LOCALAPPDATA\TypoZen_Cache\perf.log"
        //
        // Output is appended, so delete perf.log between runs for a clean timeline. Marks are
        // millisecond offsets from entry to Main; .NET runtime and WPF assembly load happen
        // before that and are therefore not included.
        //
        // Why in-process rather than timing from outside:
        // measuring startup externally with UI Automation is actively misleading. A FindAll
        // call marshals onto this app's UI thread and costs ~150-200 ms, so polling for a
        // control during startup starves the very startup being measured. That approach
        // reported ~9 s for a cold open, and stayed flat as the restored session grew,
        // because the measurement dominated everything it was supposed to be comparing.
        //
        // What these marks found (kept as a record of why the marks are placed where they are):
        // LoadFileFromPath was being called synchronously from inside the WebView2 "ready"
        // message handler. It pulls document state with a blocking script call, and that
        // result cannot be delivered while WebView2 is still dispatching the handler waiting
        // on it, so both attempts ran to their 3 s timeouts - 6 s of dead time on every cold
        // open from Explorer. Deferring the load with Dispatcher.BeginInvoke cut it to ~35 ms
        // and took a cold open from ~8.9 s to ~3.0 s. Template navigation is now the largest
        // remaining cost (~2.1 s), which is why a mark sits on either side of it.
        private static readonly Stopwatch _perfClock = Stopwatch.StartNew();
        private static readonly bool _perfOn =
            !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("TYPOZEN_PERF"));
        private static string _perfLog;

        /// <summary>True when TYPOZEN_PERF is set; also gates the page-side marks via ?perf=1.</summary>
        internal static bool PerfEnabled { get { return _perfOn; } }

        /// <summary>
        /// Append a timestamped milestone to perf.log. No-op unless TYPOZEN_PERF is set.
        /// Safe to call from any thread and from inside event handlers; never throws.
        /// </summary>
        internal static void PerfMark(string label)
        {
            if (!_perfOn) return;
            try
            {
                if (_perfLog == null)
                {
                    _perfLog = Path.Combine(DefaultCacheDir(), "perf.log");
                    Directory.CreateDirectory(DefaultCacheDir());
                }
                File.AppendAllText(_perfLog,
                    string.Format("{0,7} ms  {1}{2}", _perfClock.ElapsedMilliseconds, label, Environment.NewLine));
            }
            catch { }
        }

        /// <summary>
        /// Profile folder for a normal run, matching CacheDir().
        ///
        /// TYPOZEN_PROFILE_DIR moves the whole profile somewhere else. Deliberately
        /// separate from TYPOZEN_TAB_E2E: that one also disables session restore and the
        /// single-instance server, which is right for the tab-content harness and wrong
        /// for the *-app suites, several of which exist precisely to test that a session
        /// comes back. This changes where the profile lives and nothing else.
        /// </summary>
        internal static string ProfileDirOverride()
        {
            string dir = Environment.GetEnvironmentVariable("TYPOZEN_PROFILE_DIR");
            return string.IsNullOrWhiteSpace(dir) ? null : dir.Trim();
        }

        private static string DefaultCacheDir()
        {
            return ProfileDirOverride() ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TypoZen_Cache");
        }

        [STAThread]
        public static void Main(string[] args)
        {
            PerfMark("--- Main entered (process start + .NET/WPF load precede this)");
            // --debug, and Phase 6 (ZenSeek): --reader --search --line --match-index + path.
            LaunchRequest launch = LaunchRequest.ParseArgs(args);
            if (launch.Debug)
                DebugLogEnabled = true;
            if (!DebugLogEnabled
                && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("TYPOZEN_DEBUG")))
            {
                DebugLogEnabled = true;
            }


            string initialFile = launch.FilePath;

            // Automated tests may run multiple processes against throwaway profiles.
            bool e2e = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("TYPOZEN_TAB_E2E"));
            if (!e2e)
            {
                bool createdNew;
                Mutex mutex = null;
                try
                {
                    mutex = new Mutex(true, SingleInstanceMutexName, out createdNew);
                }
                catch
                {
                    createdNew = true;
                    mutex = null;
                }

                if (!createdNew)
                {
                    // Another TypoZen is running — open the file there as a tab and exit.
                    try { if (mutex != null) mutex.Dispose(); } catch { }
                    if (HandoffToRunningInstance(launch))
                        return;
                    // Pipe not ready yet (race on cold start): few quick retries only.
                    for (int i = 0; i < 8; i++)
                    {
                        Thread.Sleep(50);
                        if (HandoffToRunningInstance(launch))
                            return;
                    }
                    // Last resort: start a second window rather than drop the file open.
                    // Still install the open pipe so further Explorer opens can attach.
                }
                else
                {
                    try
                    {
                        var app = new Application();
                        var win = new TypoZenWindow(launch);
                        win.StartSingleInstanceOpenServer();
                        app.Run(win);
                    }
                    finally
                    {
                        if (mutex != null)
                        {
                            try { mutex.ReleaseMutex(); } catch { }
                            try { mutex.Dispose(); } catch { }
                        }
                    }
                    return;
                }
            }

            {
                var app = new Application();
                var win = new TypoZenWindow(launch);
                if (!e2e) win.StartSingleInstanceOpenServer();
                app.Run(win);
            }
        }

        /// <summary>
        /// Tell the running TypoZen to open a path (or just activate if path is empty).
        /// Returns true if the handoff message was delivered.
        /// </summary>
        private static bool HandoffToRunningInstance(LaunchRequest req)
        {
            try
            {
                using (var client = new NamedPipeClientStream(".", OpenPipeName, PipeDirection.Out))
                {
                    // Short connect: running instance answers immediately; long timeout
                    // made Explorer "Open with" feel 3× slower than File → Open.
                    client.Connect(250);
                    using (var writer = new StreamWriter(client, new UTF8Encoding(false)) { AutoFlush = true })
                    {
                        // One line: plain path (Explorer) or path + #tz1 options (ZenSeek).
                        writer.WriteLine(req != null ? req.ToPipeLine() : "");
                    }
                }
                
                // We are the foreground process (ZenSeek launched us). Give the OS permission
                // for the existing background process to take the foreground when it receives this pipe message.
                try { AllowSetForegroundWindow(unchecked((uint)-1)); } catch { }
                
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    public class TypoZenWindow : Window
    {
        private bool _suppressNextAltMenu;

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var source = PresentationSource.FromVisual(this) as System.Windows.Interop.HwndSource;
            if (source != null)
            {
                source.AddHook(WndProc);
            }
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            const int WM_SYSCOMMAND = 0x0112;
            const int SC_KEYMENU = 0xF100;
            if (msg == WM_SYSCOMMAND && (wParam.ToInt32() & 0xFFF0) == SC_KEYMENU)
            {
                if (_suppressNextAltMenu)
                {
                    _suppressNextAltMenu = false;
                    handled = true;
                    return IntPtr.Zero;
                }
            }
            return IntPtr.Zero;
        }

        private WebView2 _webView;
        /// <summary>Second surface for PDF / image / media (Chromium-native read-only).</summary>
        private WebView2 _nativeWebView;
        private WinForms.Panel _webViewPanel;
        private string _mappedNativeFolder;
        private string _mappedLoadFolder;
        private string _nativeNavigatedPath;
        private bool _nativeSurfaceVisible;
        private System.Drawing.Color _currentThemeBg = System.Drawing.Color.FromArgb(30, 30, 30);
        private string _currentFilePath = null;
        // Last engine document pushed into the page (tab switch skip-remount).
        private int _loadedEngineTabId = -1;
        private string _loadedEnginePath = "";
        private int _loadedEngineContentLen = -1;
        private int _loadedEngineContentHash = 0;
        private string _initialFileToOpen = null;
        private LaunchRequest _pendingLaunch;
        private int _launchHintPasses = 0;
        private bool _isDirty = false;
        private string _appDir;

        /// <summary>How a tab is painted and whether it can be edited.</summary>
        private enum DocKind
        {
            Engine = 0,  // Markdown / text — Preview / Source / Reader
            Book = 1,    // .epub — engine HTML, Reader locked
            Native = 2   // PDF / image / media — Chromium surface, Reader chrome
        }

        private enum NativeRole
        {
            None = 0,
            Pdf,
            Image,
            Video,
            Audio,
            /// <summary>HTML page — rendered by Chromium (default open policy).</summary>
            Page
        }

        /// <summary>In-memory document tab (one buffer per open file / untitled).</summary>
        private sealed class DocTab
        {
            public int Id;
            public string FilePath;   // null = untitled
            public string Content;   // last known markdown (empty for Book / Native)
            public bool IsDirty;
            public string SourceEncoding; // encoding the file was read as (display only)
            public DocKind Kind = DocKind.Engine;
            public NativeRole NativeRole = NativeRole.None;

            // Byte-fidelity: the editor works in LF internally and its serializer drops
            // trailing blank lines, so without these an untouched file came back with
            // every CRLF rewritten to LF and its final newline missing -- a whole-file
            // diff for a document nobody edited.
            /// <summary>Where reading got to in THIS tab; see the book_position handler.</summary>
            public int ResumeBlock = 0;

            /// <summary>
            /// 1 or 2 columns for THIS tab; 0 = never chosen (apply path defaults only).
            /// </summary>
            public int Columns = 0;

            /// <summary>
            /// Mode for THIS tab: "source", "preview", "reader", or "" = never chosen
            /// (path defaults: PreferSourceMode → source; books always Reader).
            /// Part of the same bag as Columns — one leave/enter rule, not global chrome.
            /// </summary>
            public string ViewMode = "";

            public string LineEnding = "\n";      // "\n" or "\r\n", from the file as loaded
            public string TrailingNewlines = "\n"; // exact run of newlines the file ended with

            // Last known on-disk identity, set at load and after a successful save.
            // Compared on activate / tab switch / save so an external edit is noticed.
            public DateTime DiskWriteTimeUtc = DateTime.MinValue;
            public long DiskLength = -1;
            public int DiskFingerprint;
            public bool DiskConflict; // dirty + disk newer; prompt when the tab is shown
            public string Title
            {
                get
                {
                    string name = string.IsNullOrEmpty(FilePath) ? "Untitled.md" : Path.GetFileName(FilePath);
                    return IsDirty ? name + " *" : name;
                }
            }
        }

        private readonly List<DocTab> _tabs = new List<DocTab>();
        private int _activeTabIndex = -1;
        private int _nextTabId = 1;
        private StackPanel _tabStrip;
        private bool _tabOpInProgress = false;
        private bool _restoringTabs = false; // block PersistTabSession while restoring
        private bool _diskCheckBusy;
        private DateTime _ignoreDiskWatchUntil = DateTime.MinValue;
        private readonly Dictionary<string, FileSystemWatcher> _diskWatchers =
            new Dictionary<string, FileSystemWatcher>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _pendingDiskChecks =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private DispatcherTimer _diskDebounceTimer;
        private const int MaxSessionTabs = 24;

        // File → Open Recent (persisted separately from prefs JSON regex patches)
        private const int MaxRecentFiles = 12;
        private readonly List<string> _recentFiles = new List<string>();

        // Privacy switches. Both default to the choice that writes least: session bodies
        // are the only place TypoZen puts document text anywhere other than the file you
        // chose, and the recent list is a record of what you opened. Defaulting bodies to
        // OFF costs nothing silently — closing already prompts to save every dirty tab,
        // so work is offered back to you rather than stashed in the cache behind your back.
        private bool _sessionRestoreContent;
        private bool _recentFilesEnabled = true;
        /// <summary>User chose "Don't show again" on the non-UTF-8 open warning.</summary>
        private bool _encodingWarnDisabled;
        private MenuItem _mRecentMenu;

        // Tab strip palette, refreshed by ApplyThemeChrome. Defaults match the original
        // hardcoded slate scheme so the strip still renders before the first theme apply.
        private SolidColorBrush _tabActiveBg = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#1E3A5F"));
        private SolidColorBrush _tabInactiveBg = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#1E293B"));
        private SolidColorBrush _tabActiveBorder = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#3B82F6"));
        private SolidColorBrush _tabInactiveBorder = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#334155"));
        private SolidColorBrush _tabHoverBg = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#243044"));
        private SolidColorBrush _tabText = new SolidColorBrush(Colors.White);
        private SolidColorBrush _tabTextMuted = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#94A3B8"));

        // UI Controls
        private TextBlock _lblStatus;
        private TextBlock _lblChapter;
        /// <summary>Model block index for the chapter shown in the status bar (-1 = none).</summary>
        private int _chapterBlockIndex = -1;
        private TextBlock _lblFilePath;
        private TextBlock _lblWordCount;
        private TextBlock _lblLineCount;
        private TextBlock _lblCharCount;
        private TextBlock _lblReadingTime;
        private TextBlock _lblZoom;
        private Border _statusIndicator;

        // WebView2 ZoomFactor (1.0 = 100%). Independent of theme font size.
        private const double ZoomMin = 0.5;
        private const double ZoomMax = 3.0;
        private const double ZoomStep = 0.1;
        private double _zoomFactor = 1.0;
        private bool _zoomApplying; // suppress ZoomFactorChanged while we set ZoomFactor
        // Phase 3A view selectors
        private Border _grpMode;
        private Button _btnColumnToggle, _btnScrollToggle;
        private readonly Dictionary<string, Button> _segments = new Dictionary<string, Button>();
        // Last state the page resolved. Cached only so a two-state button knows which
        // value to ask for next and so a column change can swap the window geometry.
        private int _viewColumns = 1;
        private string _viewScroll = "scroll";
        private string _viewMode = "preview";
        private bool _viewColumnsLocked, _viewScrollLocked;
        private bool _sidebarOpen = true;
        /// <summary>Opacity of a selected control's fill, over the theme accent.
        /// Smallest value at which all 27 themes stay visible; see the comment in
        /// ApplyTheme and tests/theme-contrast-selftest.mjs.</summary>
        private const byte SelectionFillAlpha = 0x48;

        private string _editorMode = "wysiwyg"; // "wysiwyg", "reader", "source"
        private bool _isPageAdvanceMode;
        private bool _isTwoColumnMode = false;
        private Rect? _col1Rect = null;
        private Rect? _col2Rect = null;
        private SolidColorBrush _modeGhostBorder = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#667788"));
        private SolidColorBrush _modeGhostFg = new SolidColorBrush(Colors.White);
        private SolidColorBrush _modeSourceBorder = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#A855F7"));
        private SolidColorBrush _modeSourceBg = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#33A855F7"));
        private ComboBox _cmbThemes;
        private int _currentThemeIndex = 0;
        private List<ThemeInfo> _themesList = new List<ThemeInfo>();
        private List<MenuItem> _themeMenuItems = new List<MenuItem>();
        private bool _forceClose = false;
        private bool _closePromptActive = false;
        private int _closeClickCount = 0;
        /// <summary>True while ExecuteScriptBlocking is nested — close/open must not re-enter.</summary>
        private int _scriptBlockDepth = 0;

        // Named-pipe listener: second process hands off Explorer "open file" paths here.
        private CancellationTokenSource _openPipeCts;
        private Thread _openPipeThread;
        private bool _editorReady;
        private readonly List<LaunchRequest> _pendingHandoffPaths = new List<LaunchRequest>();

        // The theme editor offers FAMILIES, not hand-written CSS stacks.
        //
        // It used to be ten literal stacks matched against a theme's FN by exact string,
        // which drifts from the palette the moment any theme is edited: Solarized Light's
        // "'Bookerly', 'Literata', serif" matched none of them, so the picker fell back to
        // entry 0 and Save rewrote the font to Inter. Patching that by appending the
        // unmatched stack as its own entry stopped the data loss but left a duplicate
        // "Bookerly (this theme)" sitting under "Bookerly / Georgia (Serif)" -- two rows
        // for one typeface, which is just the same modelling error made visible.
        //
        // A reader picks a typeface. The fallback chain is plumbing, so it does not belong
        // in the menu. Matching is then on the family a theme leads with, which cannot fail
        // for any stack that starts with a font we know about, however it is written.
        // Format: display name, generic fallback.
        private static readonly string[][] FontFamilies = new string[][]
        {
            new string[] { "Inter", "sans-serif" },
            new string[] { "Source Sans 3", "sans-serif" },
            new string[] { "Segoe UI", "sans-serif" },
            new string[] { "Merriweather", "serif" },
            new string[] { "Literata", "serif" },
            new string[] { "Bookerly", "serif" },
            new string[] { "Georgia", "serif" },
            new string[] { "Palatino Linotype", "serif" },
            new string[] { "Sitka Text", "serif" },
            new string[] { "Cascadia Mono", "monospace" },
            new string[] { "Consolas", "monospace" },
        };

        /// <summary>Family list as (label, CSS stack) pairs for the editor.</summary>
        private static string[][] FontPresets
        {
            get
            {
                var list = new string[FontFamilies.Length][];
                for (int i = 0; i < FontFamilies.Length; i++)
                {
                    list[i] = new string[]
                    {
                        FontFamilies[i][0],
                        "'" + FontFamilies[i][0] + "', " + FontFamilies[i][1]
                    };
                }
                return list;
            }
        }

        // Automated-test mode (TYPOZEN_TAB_E2E=<output dir>) runs against a throwaway
        // profile. It used to share the real one, so a previous session's localStorage
        // seeded the first tab (breaking the tab-count assertions) and the harness wrote
        // its scratch documents over the user's own unsaved work in settings.json.
        private readonly bool _e2eMode;
        private readonly string _e2eDir;

        /// <summary>
        /// Profile folder: WebView2 user data, settings.json, window_state.json, and the
        /// bookmark / book-position / tab-session stores.
        ///
        /// TYPOZEN_PROFILE_DIR (see Program.ProfileDirOverride) points this at a throwaway
        /// directory. The *-app suites set it per run, because without it every one of them
        /// read and wrote the reader's own profile: bookmark assertions depended on which
        /// suite had run before, and a test run left its fixtures in the reader's real
        /// bookmarks.txt and book_positions.txt.
        /// </summary>
        private string CacheDir()
        {
            if (_e2eMode) return Path.Combine(_e2eDir, "profile");
            string over = Program.ProfileDirOverride();
            if (over != null) return over;
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TypoZen_Cache");
        }

        /// <summary>
        /// Where a large document or book payload is staged for the page to fetch.
        ///
        /// Not the application folder: that can be OneDrive-synced, and Privacy Mode
        /// forbids writing document bytes next to the exe. Cache for ordinary use;
        /// the opaque TEMP session while Privacy Mode is on.
        /// </summary>
        private string LoadStageDir()
        {
            if (SuppressDocumentTraces())
            {
                string root = EpubReader.PrivateSessionRoot;
                if (string.IsNullOrEmpty(root))
                {
                    EpubReader.BeginPrivateSession();
                    root = EpubReader.PrivateSessionRoot;
                }
                if (!string.IsNullOrEmpty(root))
                    return Path.Combine(root, "load");
            }
            return Path.Combine(CacheDir(), "typozen_load");
        }

        /// <summary>
        /// Write a staged payload and return the https://localload/ URL the page fetches.
        /// </summary>
        private string StageLoadPayload(string fileName, string contents)
        {
            string dir = LoadStageDir();
            Directory.CreateDirectory(dir);
            PruneLoadStageDir(maxAgeMinutes: 5);
            MapLoadHost();
            File.WriteAllText(Path.Combine(dir, fileName), contents ?? "", new UTF8Encoding(false));
            return "https://localload/" + fileName;
        }

        /// <summary>
        /// Point localload at the current stage directory. Re-mapped when Privacy Mode
        /// moves the root, same reason MapBookHost re-maps.
        /// </summary>
        private void MapLoadHost()
        {
            if (_webView == null || _webView.CoreWebView2 == null) return;
            try
            {
                string dir = LoadStageDir();
                Directory.CreateDirectory(dir);
                try { _webView.CoreWebView2.ClearVirtualHostNameToFolderMapping("localload"); } catch { }
                // Allow: the page origin is https://localapp, and it fetch()es this host.
                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "localload", dir, CoreWebView2HostResourceAccessKind.Allow);
                _mappedLoadFolder = dir;
            }
            catch { }
        }

        /// <summary>
        /// Older builds staged under _appDir/typozen_load. Sweep leftover bodies at
        /// launch so a crash cannot leave a novel next to the exe.
        /// </summary>
        private void SweepLegacyAppLoadStage()
        {
            try
            {
                string dir = Path.Combine(_appDir, "typozen_load");
                if (!Directory.Exists(dir)) return;
                foreach (string pattern in new[] { "body_*.md", "book_*.json" })
                {
                    foreach (string f in Directory.GetFiles(dir, pattern))
                    {
                        try { File.Delete(f); } catch { }
                    }
                }
            }
            catch { }
        }

        /// <summary>
        /// Delete stale staged-load bodies from the current stage directory.
        /// </summary>
        /// <param name="maxAgeMinutes">
        /// Only remove files older than this. Use 5 during a session so a load still
        /// being fetched is never pulled out from under the page; use 0 on shutdown,
        /// when nothing can be in flight.
        /// </param>
        private void PruneLoadStageDir(int maxAgeMinutes)
        {
            try
            {
                string dir = LoadStageDir();
                if (!Directory.Exists(dir)) return;
                DateTime cutoff = DateTime.UtcNow.AddMinutes(-Math.Abs(maxAgeMinutes));
                foreach (string pattern in new[] { "body_*.md", "book_*.json" })
                {
                    foreach (string f in Directory.GetFiles(dir, pattern))
                    {
                        try
                        {
                            if (File.GetLastWriteTimeUtc(f) <= cutoff) File.Delete(f);
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }

        private string PrefsPath() { return Path.Combine(CacheDir(), "settings.json"); }
        private string WindowStatePath() { return Path.Combine(CacheDir(), "window_state.json"); }
        private string TabSessionPath() { return Path.Combine(CacheDir(), "tabs_session.txt"); }
        private string BookPositionsPath() { return Path.Combine(CacheDir(), "book_positions.txt"); }
        private string BookmarksPath() { return Path.Combine(CacheDir(), "bookmarks.txt"); }
        private string TabSessionBodiesDir() { return Path.Combine(CacheDir(), "session_bodies"); }

        public TypoZenWindow(LaunchRequest launch = null)
        {
            string e2e = Environment.GetEnvironmentVariable("TYPOZEN_TAB_E2E");
            _e2eMode = !string.IsNullOrWhiteSpace(e2e);
            _e2eDir = _e2eMode ? e2e.Trim() : null;

            // Before the XAML, not after the window loads. See _envTask.
            _envTask = StartWebView2Environment();
            Program.PerfMark("WebView2 environment requested");

            if (launch == null) launch = new LaunchRequest();
            _initialFileToOpen = launch.FilePath;
            if (launch.HasOpenHints)
            {
                _pendingLaunch = launch;
                _launchHintPasses = 0;
            }
            _appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
            Program.PerfMark("window ctor");
            SweepLegacyAppLoadStage();
            try { PruneLoadStageDir(maxAgeMinutes: 0); } catch { }
            PurgePendingWebStorage(); // must precede WebView2: it locks the store
            Program.PerfMark("storage purged");
            LoadXamlLayout();
            
            var menuDropAlignmentField = typeof(System.Windows.SystemParameters).GetField("_menuDropAlignment", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            Action setAlignmentValue = () =>
            {
                if (System.Windows.SystemParameters.MenuDropAlignment && menuDropAlignmentField != null)
                {
                    menuDropAlignmentField.SetValue(null, false);
                }
            };
            setAlignmentValue();
            System.Windows.SystemParameters.StaticPropertyChanged += (s, e) =>
            {
                if (e.PropertyName == "MenuDropAlignment")
                    setAlignmentValue();
            };
            Program.PerfMark("XAML loaded");
            this.Loaded += (s, e) => { Program.PerfMark("window Loaded"); InitializeWebViewAsync(); };
            this.Activated += Window_Activated;
            this.Closed += (s, e) =>
            {
                StopSingleInstanceOpenServer();
                DisposeDiskWatchers();
            };
        }

        /// <summary>
        /// Listen for paths from later TypoZen processes (Explorer double-click).
        /// Each path is opened as a tab in this window instead of a new instance.
        /// </summary>
        public void StartSingleInstanceOpenServer()
        {
            if (_e2eMode) return;
            if (_openPipeThread != null) return;
            _openPipeCts = new CancellationTokenSource();
            var ct = _openPipeCts.Token;
            _openPipeThread = new Thread(() => OpenPipeServerLoop(ct))
            {
                IsBackground = true,
                Name = "TypoZenOpenPipe"
            };
            _openPipeThread.Start();
        }

        private void StopSingleInstanceOpenServer()
        {
            try
            {
                if (_openPipeCts != null) _openPipeCts.Cancel();
            }
            catch { }
            // Connect once so a blocked WaitForConnection wakes up and exits.
            try
            {
                using (var client = new NamedPipeClientStream(".", Program.OpenPipeName, PipeDirection.Out))
                {
                    client.Connect(200);
                }
            }
            catch { }
        }

        private void OpenPipeServerLoop(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    using (var server = new NamedPipeServerStream(
                        Program.OpenPipeName,
                        PipeDirection.In,
                        2,
                        PipeTransmissionMode.Byte,
                        PipeOptions.None))
                    {
                        server.WaitForConnection();
                        if (ct.IsCancellationRequested) break;
                        string line = null;
                        using (var reader = new StreamReader(server, Encoding.UTF8))
                        {
                            try { line = reader.ReadLine(); }
                            catch { line = null; }
                        }
                        LaunchRequest req = LaunchRequest.FromPipeLine(line);
                        try
                        {
                            Dispatcher.BeginInvoke(new Action(() => HandleExternalOpenRequest(req)),
                                DispatcherPriority.Normal);
                        }
                        catch { }
                    }
                }
                catch (Exception)
                {
                    if (ct.IsCancellationRequested) break;
                    try { Thread.Sleep(150); } catch { }
                }
            }
        }

        private void BringToFrontForHandoff()
        {
            try
            {
                if (WindowState == WindowState.Minimized)
                    WindowState = WindowState.Normal;
                Show();
                Activate();
                
                // Flash topmost so the shell actually raises us over Explorer.
                Topmost = true;
                Topmost = false;
                
                // Aggressively steal foreground if Windows is blocking it
                bool foreground = TryForceForeground();
                
                Focus();
                if (foreground && _webView != null) _webView.Focus();
            }
            catch { }
        }

        /// <summary>
        /// Explorer / second-process / ZenSeek open request. Queues until the editor is
        /// ready so session restore does not wipe a tab opened mid-startup.
        /// </summary>
        private void HandleExternalOpenRequest(LaunchRequest req)
        {
            try { BringToFrontForHandoff(); } catch { }
            if (req == null) return;
            string path = req.FilePath;
            if (string.IsNullOrEmpty(path)) return;
            if (!File.Exists(path)) return;
            if (!_editorReady)
            {
                for (int i = 0; i < _pendingHandoffPaths.Count; i++)
                {
                    if (_pendingHandoffPaths[i] != null
                        && string.Equals(_pendingHandoffPaths[i].FilePath, path, StringComparison.OrdinalIgnoreCase))
                    {
                        if (req.HasOpenHints) _pendingHandoffPaths[i] = req;
                        return;
                    }
                }
                _pendingHandoffPaths.Add(req);
                return;
            }
            OpenWithLaunchRequest(req);
        }

        private void FlushPendingHandoffPaths()
        {
            if (_pendingHandoffPaths.Count == 0) return;
            var copy = new List<LaunchRequest>(_pendingHandoffPaths);
            _pendingHandoffPaths.Clear();
            for (int i = 0; i < copy.Count; i++)
            {
                try
                {
                    if (copy[i] != null && !string.IsNullOrEmpty(copy[i].FilePath)
                        && File.Exists(copy[i].FilePath))
                        OpenWithLaunchRequest(copy[i]);
                }
                catch { }
            }
        }

        private void OpenWithLaunchRequest(LaunchRequest req)
        {
            if (req == null || string.IsNullOrEmpty(req.FilePath)) return;
            if (req.HasOpenHints)
            {
                _pendingLaunch = req;
                _launchHintPasses = 0;
            }
            LoadFileFromPath(req.FilePath);
            ScheduleApplyPendingLaunch();
        }

        private void ScheduleApplyPendingLaunch()
        {
            if (_pendingLaunch == null || !_pendingLaunch.HasOpenHints) return;
            Dispatcher.BeginInvoke(new Action(() =>
            {
                try { ApplyPendingLaunchHints(); } catch { }
            }), DispatcherPriority.Background);
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(700) };
            timer.Tick += (s, e) =>
            {
                timer.Stop();
                try { ApplyPendingLaunchHints(); } catch { }
            };
            timer.Start();
        }

        private void ApplyPendingLaunchHints()
        {
            LaunchRequest req = _pendingLaunch;
            if (req == null || !req.HasOpenHints) return;
            if (_webView == null || _webView.CoreWebView2 == null) return;

            if (req.Reader)
                SendMsg("cmd:view_set:mode:reader");

            if (!string.IsNullOrEmpty(req.Search))
            {
                int mi = req.MatchIndex >= 0 ? req.MatchIndex : 0;
                SendMsg("external_find:" + Uri.EscapeDataString(req.Search)
                    + "|match=" + mi.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
            else if (req.Line >= 0)
            {
                SendMsg("external_goto_line:"
                    + (req.Line + 1).ToString(System.Globalization.CultureInfo.InvariantCulture));
            }

            _launchHintPasses++;
            if (_launchHintPasses >= 2)
            {
                _pendingLaunch = null;
                _launchHintPasses = 0;
            }
        }

        private void LoadXamlLayout()
        {
            string xamlPath = Path.Combine(_appDir, "TypoZen.xaml");
            if (!File.Exists(xamlPath))
            {
                WinForms.MessageBox.Show("Cannot find TypoZen.xaml in " + _appDir, "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                Environment.Exit(1);
            }

            try
            {
                using (var stream = new FileStream(xamlPath, FileMode.Open, FileAccess.Read))
                {
                    var window = (Window)XamlReader.Load(stream);
                    Program.PerfMark("   xaml: XamlReader.Load");
                    this.Title = window.Title;
                    this.Width = window.Width;
                    this.Height = window.Height;
                    this.WindowStartupLocation = window.WindowStartupLocation;
                    this.Background = window.Background;
                    this.FontFamily = window.FontFamily;
                    this.Resources = window.Resources;
                    try
                    {
                        string iconPath = Path.Combine(_appDir, "TypoZen.ico");
                        if (File.Exists(iconPath))
                        {
                            this.Icon = new System.Windows.Media.Imaging.BitmapImage(new Uri(iconPath, UriKind.Absolute));
                        }
                    }
                    catch {}
                    Program.PerfMark("   xaml: icon");

                    var scope = NameScope.GetNameScope(window);
                    if (scope != null)
                    {
                        NameScope.SetNameScope(this, scope);
                    }

                    var content = window.Content as UIElement;
                    window.Content = null;
                    this.Content = content;
                    ApplyNotepadTitleChrome();
                    Program.PerfMark("   xaml: title chrome");
                    RestoreWindowState();
                    Program.PerfMark("   xaml: window state restored");
                }
            }
            catch (Exception ex)
            {
                WinForms.MessageBox.Show("Error loading UI XAML: " + ex.Message, "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                Environment.Exit(1);
            }

            // Bind Status bar
            _lblStatus = (TextBlock)FindElement("lblStatus");
            _lblChapter = FindElement("lblChapter") as TextBlock;
            _lblFilePath = (TextBlock)FindElement("lblFilePath");
            _lblWordCount = (TextBlock)FindElement("lblWordCount");
            _lblLineCount = (TextBlock)FindElement("lblLineCount");
            _lblCharCount = (TextBlock)FindElement("lblCharCount");
            _lblReadingTime = (TextBlock)FindElement("lblReadingTime");
            _lblZoom = (TextBlock)FindElement("lblZoom");
            _statusIndicator = (Border)FindElement("statusIndicator");
            UpdateZoomLabel(); // reflects zoom restored from window_state

            if (_lblFilePath != null)
            {
                _lblFilePath.Cursor = Cursors.Hand;
                _lblFilePath.MouseLeftButtonUp += LblFilePath_MouseLeftButtonUp;
            }

            // Bind Menu & Toolbar buttons
            BindClick("mNew", (s, e) => NewTab());
            BindClick("mOpen", (s, e) => OpenFile());
            BindClick("btnNewTab", (s, e) => NewTab());
            _tabStrip = FindElement("tabStrip") as StackPanel;
            _mRecentMenu = FindElement("mRecentMenu") as MenuItem;
            LoadRecentFiles();
            RebuildRecentFilesMenu();
            Program.PerfMark("   xaml: recent files menu");
            BindClick("mSave", (s, e) => SaveFile());
            BindClick("mSaveAs", (s, e) => SaveFileAs());
            BindClick("mExportHtml", (s, e) => SendMsg("export_html"));
            BindClick("mExportPdf", (s, e) => ExportPdf());
            BindClick("mExit", (s, e) => this.Close());

            BindClick("mUndo", (s, e) => SendHistoryCmd("cmd:undo"));
            BindClick("mRedo", (s, e) => SendHistoryCmd("cmd:redo"));
            BindClick("mCut", (s, e) => SendMsg("cmd:cut"));
            BindClick("mCopy", (s, e) => SendMsg("cmd:copy"));
            BindClick("mPaste", (s, e) => PasteFromClipboard());
            BindClick("mFind", (s, e) =>
            {
                try { if (_webView != null) _webView.Focus(); } catch { }
                SendMsg("cmd:find");
            });
            BindClick("mGoToPage", (s, e) =>
            {
                try { if (_webView != null) _webView.Focus(); } catch { }
                SendMsg("cmd:goto_page");
            });
            BindClick("mMarkToggle", (s, e) => SendMsg("cmd:mark_toggle"));
            BindClick("mMarksPane", (s, e) => SendMsg("cmd:show_marks"));
            BindClick("mReturnJump", (s, e) => SendMsg("cmd:return_jump"));
            BindClick("mInsertLink", (s, e) => SendMsg("fmt:link"));
            BindClick("mInsertTable", (s, e) => SendMsg("fmt:table"));
            BindClick("mStrike", (s, e) => SendMsg("fmt:strike"));

            BindClick("mSidebarOutline", (s, e) => SendMsg("cmd:show_outline"));
            BindClick("mSidebarSearch", (s, e) => SendMsg("cmd:show_search"));
            BindClick("mSidebarMarks", (s, e) => SendMsg("cmd:show_marks"));
            BindClick("mToggleReveal", (s, e) => SendMsg("cmd:toggle_reveal"));
            BindClick("mToggleFocus", (s, e) => SendMsg("cmd:toggle_focus"));
            BindClick("mToggleTypewriter", (s, e) => SendMsg("cmd:toggle_typewriter"));
            BindClick("mMarginNarrow", (s, e) => SendMsg("cmd:set_margin_narrow"));
            BindClick("mMarginRegular", (s, e) => SendMsg("cmd:set_margin_regular"));
            BindClick("mMarginWide", (s, e) => SendMsg("cmd:set_margin_wide"));
            BindClick("mZoomIn", (s, e) => ZoomBy(+ZoomStep));
            BindClick("mZoomOut", (s, e) => ZoomBy(-ZoomStep));
            BindClick("mZoomReset", (s, e) => SetZoom(1.0));
            BindClick("mFullscreen", (s, e) => ToggleFullscreen());

            // Chrome visibility, word wrap, status bar, print
            BindClick("mChromeAutoHide", (s, e) => SetChromeAutoHide(!_chromeAutoHide));
            BindClick("mScrubberToggle", (s, e) => SetScrubberVisible(!_scrubberVisible));
            BindClick("mLineTight",   (s, e) => SetLineSpacing(0));
            BindClick("mLineNormal",  (s, e) => SetLineSpacing(1));
            BindClick("mLineRelaxed", (s, e) => SetLineSpacing(2));
            BindClick("mLineLoose",   (s, e) => SetLineSpacing(3));
            BindClick("mParaTight",   (s, e) => SetParaSpacing(0));
            BindClick("mParaNormal",  (s, e) => SetParaSpacing(1));
            BindClick("mParaRelaxed", (s, e) => SetParaSpacing(2));
            BindClick("mParaLoose",   (s, e) => SetParaSpacing(3));
            BindClick("mHoverGutter", (s, e) => SetBlockHover(_blockHover == 1 ? 0 : 1));
            BindClick("mResetView", (s, e) => ResetViewSettings());
            BindClick("mFontTheme",  (s, e) => SetFontType(0));
            BindClick("mFontSerif",  (s, e) => SetFontType(1));
            BindClick("mFontSans",   (s, e) => SetFontType(2));
            BindClick("mFontCustom", (s, e) => 
            {
                string seed = _customFontFamily;
                if (string.IsNullOrWhiteSpace(seed))
                {
                    if (_fontType == 0 && _currentThemeIndex >= 0 && _currentThemeIndex < _themesList.Count)
                        seed = _themesList[_currentThemeIndex].FN;
                    else if (_fontType == 1) seed = "Georgia, serif";
                    else if (_fontType == 2) seed = "'Segoe UI', sans-serif";
                }

                var dlg = new CustomFontWindow(seed, FontPresets, this.Background, this.Foreground);
                dlg.Owner = this;
                if (dlg.ShowDialog() == true)
                {
                    _customFontFamily = dlg.SelectedFontFamily;
                    SetFontType(3);
                }
                else
                {
                    for (int i = 0; i < FontTypeItems.Length; i++)
                        SetMenuChecked(FontTypeItems[i], i == _fontType);
                }
            });

            BindClick("mSizeExtraSmall", (s, e) => SetFontSizeOverride(0));
            BindClick("mSizeSmall",      (s, e) => SetFontSizeOverride(1));
            BindClick("mSizeNormal",     (s, e) => SetFontSizeOverride(2));
            BindClick("mSizeLarge",      (s, e) => SetFontSizeOverride(3));
            BindClick("mSizeExtraLarge", (s, e) => SetFontSizeOverride(4));

            BindClick("mJustify",     (s, e) => SetJustified(!_justified));
            BindClick("mSidebarAutoHide", (s, e) => SetSidebarAutoHide(!_sidebarAutoHide));
            BindClick("mAutosave", (s, e) => SetAutosave(!_autosave));
            BindClick("mPrivacyMode", (s, e) => SetPrivacyMode(!_privacyMode));
            BindClick("mWordWrap", (s, e) =>
            {
                // Disabled in the menu when wrap has no effect (Pages / Reader / epub).
                if (!IsWordWrapApplicable()) return;
                SetWordWrap(!_wordWrap);
            });
            BindClick("mStatusBarToggle", (s, e) => SetStatusBarVisible(!_statusBarVisible));
            BindClick("mSessionRestoreContent", (s, e) => SetSessionRestoreContent(!_sessionRestoreContent));
            BindClick("mRecentEnabled", (s, e) => SetRecentFilesEnabled(!_recentFilesEnabled));
            BindClick("mClearSearchHistory", (s, e) =>
            {
                try
                {
                    var prefs = LoadHostPrefs();
                    prefs.SearchHistory = new List<string>();
                    prefs.LastSearchQuery = "";
                    WriteHostPrefs(prefs);
                }
                catch { }
                SendMsg("cmd:clear_search_history");
            });
            BindClick("mClearData", (s, e) => ClearStoredData());

            // Status-bar chapter → jump to chapter start in the page.
            try
            {
                if (_lblChapter == null) _lblChapter = FindElement("lblChapter") as TextBlock;
                if (_lblChapter != null)
                {
                    _lblChapter.MouseLeftButtonUp += (s, e) =>
                    {
                        if (_chapterBlockIndex < 0) return;
                        try { if (_webView != null) _webView.Focus(); } catch { }
                        SendMsg("cmd:goto_chapter");
                    };
                }
            }
            catch { }

            BindClick("mHelpSyntax", (s, e) => SendMsg("cmd:help_syntax"));
            BindClick("mToggleDebug", (s, e) => SendMsg("cmd:toggle_debug_hud"));
            // About is an in-page themed panel (same shell as F1 help), not a system MessageBox.
            BindClick("mAbout", (s, e) => SendMsg("cmd:help_about"));

            // Formatting buttons
            BindClick("btnBold", (s, e) => SendMsg("fmt:bold"));
            BindClick("btnItalic", (s, e) => SendMsg("fmt:italic"));
            BindClick("btnStrike", (s, e) => SendMsg("fmt:strike"));
            BindClick("btnCode", (s, e) => SendMsg("fmt:code"));
            BindClick("btnH1", (s, e) => SendMsg("fmt:h1"));
            BindClick("btnH2", (s, e) => SendMsg("fmt:h2"));
            BindClick("btnH3", (s, e) => SendMsg("fmt:h3"));
            BindClick("btnH4", (s, e) => SendMsg("fmt:h4"));
            BindClick("btnH5", (s, e) => SendMsg("fmt:h5"));
            BindClick("btnH6", (s, e) => SendMsg("fmt:h6"));
            BindClick("btnQuote", (s, e) => SendMsg("fmt:quote"));
            BindClick("btnList", (s, e) => SendMsg("fmt:list"));
            BindClick("btnOrderedList", (s, e) => SendMsg("fmt:ol"));
            BindClick("btnChecklist", (s, e) => SendMsg("fmt:checklist"));
            BindClick("btnLink", (s, e) => SendMsg("fmt:link"));
            BindClick("btnTable", (s, e) => SendMsg("fmt:table"));
            BindClick("btnTableCustom", (s, e) => SendMsg("fmt:table_custom"));

            // Table editing. The page applies these to the table holding the caret.
            BindClick("mTblRowAbove", (s, e) => SendMsg("table:row_above"));
            BindClick("mTblRowBelow", (s, e) => SendMsg("table:row_below"));
            BindClick("mTblRowDelete", (s, e) => SendMsg("table:row_delete"));
            BindClick("mTblColLeft", (s, e) => SendMsg("table:col_left"));
            BindClick("mTblColRight", (s, e) => SendMsg("table:col_right"));
            BindClick("mTblColDelete", (s, e) => SendMsg("table:col_delete"));
            BindClick("mTblAlignLeft", (s, e) => SendMsg("table:align:left"));
            BindClick("mTblAlignCenter", (s, e) => SendMsg("table:align:center"));
            BindClick("mTblAlignRight", (s, e) => SendMsg("table:align:right"));
            BindClick("mTblAlignNone", (s, e) => SendMsg("table:align:"));

            BindClick("btnToggleSidebar", (s, e) => SendMsg("cmd:toggle_sidebar"));

            // Phase 3A segmented controls. Every segment just reports the click; the page's
            // resolver decides the resulting state and sends it back via view_state:, which
            // RenderViewSelectors paints. No selection state is tracked here, so the shell
            // and the page cannot disagree about which segment is on.
            BindSegment("btnModeSource", "mode", "source");
            BindSegment("btnModePreview", "mode", "preview");
            BindSegment("btnModeReader", "mode", "reader");
            // Column and Scroll are single two-state buttons. They still hold no authority:
            // the click just asks for the other value and the page's resolver decides.
            _btnColumnToggle = FindElement("btnColumnToggle") as Button;
            if (_btnColumnToggle != null)
            {
                _btnColumnToggle.Click += (s, e) =>
                {
                    // Intentional layout change for the active tab — the only place that
                    // writes tab.Columns during a normal session (session restore is the other).
                    int next = (_viewColumns == 2) ? 1 : 2;
                    if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                        && !_viewColumnsLocked)
                        _tabs[_activeTabIndex].Columns = next;
                    SendMsg("cmd:view_set:columns:" + next);
                    try { if (_webView != null) _webView.Focus(); } catch { }
                };
            }
            _btnScrollToggle = FindElement("btnScrollToggle") as Button;
            if (_btnScrollToggle != null)
            {
                _btnScrollToggle.Click += (s, e) =>
                {
                    SendMsg("cmd:view_set:scroll:" + (_viewScroll == "pagination" ? "scroll" : "pagination"));
                    try { if (_webView != null) _webView.Focus(); } catch { }
                };
            }

            _grpMode = FindElement("grpMode") as Border;
            RenderViewSelectors("preview", 1, "scroll", false, false);

            _cmbThemes = (ComboBox)FindElement("cmbThemes");
            if (_cmbThemes != null)
            {
                _cmbThemes.SelectionChanged += (s, e) =>
                {
                    if (_cmbThemes.SelectedIndex >= 0)
                    {
                        ApplyTheme(_cmbThemes.SelectedIndex);
                    }
                };
            }

            // Keyboard accelerators (WPF chrome). WebView-focused chords use
            // ComponentDispatcher filter — see InstallEditorKeyFilter.
            ApplyRestoredViewSettings(false);   // menus exist now; page settings wait for ready

            this.KeyDown += TypoZenWindow_KeyDown;
            InstallEditorKeyFilter();
            this.Closing += TypoZenWindow_Closing;
            this.Closed += (s, e) =>
            {
                UninstallEditorKeyFilter();
                SaveWindowState();
                PruneLoadStageDir(maxAgeMinutes: 0);   // nothing is in flight once we are closing
                try
                {
                    if (_webView != null)
                    {
                        _webView.Dispose();
                        _webView = null;
                    }
                }
                catch {}
                // After the WebView is gone, never before: Chromium holds handles on the
                // images it has fetched, so deleting the extraction while it is alive fails
                // silently and leaves exactly what privacy mode is there to remove. This is
                // the trigger — an ordinary exit clears the session's extracted books, and
                // the sweep inside catches anything a previous crash left behind.
                try { EpubReader.EndPrivateSession(); } catch { }
                Application.Current.Shutdown();
                Environment.Exit(0);
            };

            try
            {
                int savedThemeIdx = 0;
                string savedThemeName = null;
                string prefsPath = PrefsPath();
                if (File.Exists(prefsPath))
                {
                    string prefsText = File.ReadAllText(prefsPath, Encoding.UTF8);
                    var match = Regex.Match(prefsText, @"\""themeIndex\""\s*:\s*(\d+)");
                    if (match.Success) int.TryParse(match.Groups[1].Value, out savedThemeIdx);
                    var nameMatch = Regex.Match(prefsText, @"\""themeName\""\s*:\s*\""([^\""]*)\""");
                    if (nameMatch.Success) savedThemeName = nameMatch.Groups[1].Value;
                }
                string themesPath = Path.Combine(_appDir, "TypoZen_Themes.json");
                if (File.Exists(themesPath))
                {
                    string json = File.ReadAllText(themesPath, Encoding.UTF8);
                    PopulateThemeDropdown(json, savedThemeIdx, savedThemeName);
                }
            }
            catch {}
            Program.PerfMark("   xaml: themes populated");
        }

        /// <summary>
        /// Notepad-style layout: document tabs live in the window caption (title bar).
        ///
        /// Drag rule: empty caption areas must NOT have IsHitTestVisibleInChrome — then
        /// WindowChrome treats the mouse as non-client and the window moves. Only tabs,
        /// +, and custom min/max/close set the flag. Marking the whole tabBar (as before)
        /// made the entire top strip client-area and killed drag + system buttons.
        ///
        /// Caption buttons are custom: UseAeroCaptionButtons + GlassFrameThickness 0
        /// often draws no ─□× at all on modern Windows.
        /// </summary>
        private void ApplyNotepadTitleChrome()
        {
            try
            {
                const double captionH = 36;
                // contentRoot Margin (XAML = 6) leaves a WPF strip outside the WebView HWND.
                // Without it, WinFormsHost covers the client and WindowChrome never sees
                // left/right/bottom edge hits — only status-bar/corners worked.
                const double resizeInset = 6;
                var chrome = new WindowChrome
                {
                    CaptionHeight = captionH,
                    ResizeBorderThickness = new Thickness(resizeInset + 2),
                    GlassFrameThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(0),
                    UseAeroCaptionButtons = false
                };
                WindowChrome.SetWindowChrome(this, chrome);
                try { this.ResizeMode = ResizeMode.CanResize; } catch { }

                var tabBand = FindElement("tabBar") as FrameworkElement;
                if (tabBand != null)
                {
                    tabBand.Height = captionH;
                    // Do NOT set IsHitTestVisibleInChrome on the band: empty space must drag.
                    // Double-click caption area still maximizes via chrome.
                    tabBand.MouseLeftButtonDown -= TitleBar_MouseLeftButtonDown;
                    tabBand.MouseLeftButtonDown += TitleBar_MouseLeftButtonDown;
                }

                // Scroller/strip: leave default (false). Individual tab chips opt in when built.
                WireCaptionButton("btnWinMin", CaptionMin_Click);
                WireCaptionButton("btnWinMax", CaptionMax_Click);
                WireCaptionButton("btnWinClose", CaptionClose_Click);
                WireTabScrollButtons();
                UpdateMaximizeCaptionGlyph();
                UpdateContentResizeInset();
                this.StateChanged -= TypoZenWindow_StateChangedForCaption;
                this.StateChanged += TypoZenWindow_StateChangedForCaption;
                this.StateChanged -= TypoZenWindow_StateChangedForResizeInset;
                this.StateChanged += TypoZenWindow_StateChangedForResizeInset;
                this.SizeChanged -= TypoZenWindow_SizeChangedForTabs;
                this.SizeChanged += TypoZenWindow_SizeChangedForTabs;
            }
            catch { }
        }

        private void TypoZenWindow_StateChangedForResizeInset(object sender, EventArgs e)
        {
            UpdateContentResizeInset();
        }

        /// <summary>
        /// Keep a thin WPF margin around content so edges resize. When maximized, still
        /// leave a couple of pixels — Margin 0 put the WebView scrollbar under the
        /// monitor edge (Windows snap/hit-test zone), so it disappeared off-screen.
        /// </summary>
        private void UpdateContentResizeInset()
        {
            try
            {
                var root = FindElement("contentRoot") as FrameworkElement;
                if (root == null) return;
                if (this.WindowState == WindowState.Maximized)
                {
                    // Work-area edge still steals ~1–2px; keep scrollbar fully on-screen.
                    double m = 2;
                    try
                    {
                        var t = SystemParameters.WindowResizeBorderThickness;
                        m = Math.Max(2, Math.Max(t.Left, t.Right));
                        if (m > 8) m = 8; // don't leave a fat frame when maximized
                    }
                    catch { m = 2; }
                    root.Margin = new Thickness(m);
                }
                else
                    root.Margin = new Thickness(6);
            }
            catch { }
        }

        private void WireTabScrollButtons()
        {
            var left = FindElement("btnTabScrollLeft") as Button;
            var right = FindElement("btnTabScrollRight") as Button;
            var scroller = FindElement("tabScroller") as ScrollViewer;
            if (left != null)
            {
                try { WindowChrome.SetIsHitTestVisibleInChrome(left, true); } catch { }
                left.Click -= TabScrollLeft_Click;
                left.Click += TabScrollLeft_Click;
            }
            if (right != null)
            {
                try { WindowChrome.SetIsHitTestVisibleInChrome(right, true); } catch { }
                right.Click -= TabScrollRight_Click;
                right.Click += TabScrollRight_Click;
            }
            if (scroller != null)
            {
                scroller.PreviewMouseWheel -= TabScroller_PreviewMouseWheel;
                scroller.PreviewMouseWheel += TabScroller_PreviewMouseWheel;
                scroller.ScrollChanged -= TabScroller_ScrollChanged;
                scroller.ScrollChanged += TabScroller_ScrollChanged;
            }
        }

        private void TabScrollLeft_Click(object sender, RoutedEventArgs e)
        {
            var scroller = FindElement("tabScroller") as ScrollViewer;
            if (scroller == null) return;
            scroller.ScrollToHorizontalOffset(Math.Max(0, scroller.HorizontalOffset - 120));
            UpdateTabScrollButtons();
        }

        private void TabScrollRight_Click(object sender, RoutedEventArgs e)
        {
            var scroller = FindElement("tabScroller") as ScrollViewer;
            if (scroller == null) return;
            scroller.ScrollToHorizontalOffset(scroller.HorizontalOffset + 120);
            UpdateTabScrollButtons();
        }

        private void TabScroller_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
        {
            var scroller = sender as ScrollViewer;
            if (scroller == null) return;
            // Vertical wheel → horizontal tab scroll (Notepad-like when hovering the strip).
            scroller.ScrollToHorizontalOffset(scroller.HorizontalOffset - e.Delta);
            e.Handled = true;
            UpdateTabScrollButtons();
        }

        private void TabScroller_ScrollChanged(object sender, ScrollChangedEventArgs e)
        {
            UpdateTabScrollButtons();
        }

        private void TypoZenWindow_SizeChangedForTabs(object sender, SizeChangedEventArgs e)
        {
            try { UpdateTabScrollButtons(); } catch { }
        }

        /// <summary>
        /// Show ‹ › only when tabs overflow; keep the title bar free of a fat H-scrollbar.
        /// </summary>
        private void UpdateTabScrollButtons()
        {
            var scroller = FindElement("tabScroller") as ScrollViewer;
            var left = FindElement("btnTabScrollLeft") as UIElement;
            var right = FindElement("btnTabScrollRight") as UIElement;
            if (scroller == null) return;
            bool overflow = scroller.ExtentWidth > scroller.ViewportWidth + 1;
            if (left != null)
                left.Visibility = overflow ? Visibility.Visible : Visibility.Collapsed;
            if (right != null)
                right.Visibility = overflow ? Visibility.Visible : Visibility.Collapsed;
            var leftBtn = left as Button;
            if (leftBtn != null)
                leftBtn.IsEnabled = overflow && scroller.HorizontalOffset > 1;
            var rightBtn = right as Button;
            if (rightBtn != null)
                rightBtn.IsEnabled = overflow && scroller.HorizontalOffset < scroller.ScrollableWidth - 1;
        }

        /// <summary>Notepad-style: shrink tab title max-width as more tabs open.</summary>
        private double ComputeTabTitleMaxWidth()
        {
            int n = Math.Max(1, _tabs.Count);
            // Fit more tabs before overflow; still readable.
            if (n <= 5) return 160;
            if (n <= 8) return 120;
            if (n <= 12) return 90;
            if (n <= 16) return 72;
            return 56;
        }

        private void ScrollActiveTabIntoView()
        {
            try
            {
                var scroller = FindElement("tabScroller") as ScrollViewer;
                if (scroller == null || _tabStrip == null) return;
                if (_activeTabIndex < 0 || _activeTabIndex >= _tabs.Count) return;
                // Find the border for the active tab (dividers interleave; match by scanning).
                FrameworkElement chip = null;
                int tabI = 0;
                foreach (UIElement child in _tabStrip.Children)
                {
                    var b = child as Border;
                    if (b == null || !(b.Child is StackPanel)) continue; // skip thin dividers
                    if (tabI == _activeTabIndex) { chip = b; break; }
                    tabI++;
                }
                if (chip == null) return;
                // Bring into view within the horizontal scroller.
                var transform = chip.TransformToAncestor(scroller);
                var left = transform.Transform(new Point(0, 0)).X;
                var right = left + chip.ActualWidth;
                if (left < 0)
                    scroller.ScrollToHorizontalOffset(scroller.HorizontalOffset + left - 8);
                else if (right > scroller.ViewportWidth)
                    scroller.ScrollToHorizontalOffset(scroller.HorizontalOffset + (right - scroller.ViewportWidth) + 8);
                UpdateTabScrollButtons();
            }
            catch { }
        }

        private void CaptionMin_Click(object sender, RoutedEventArgs e)
        {
            this.WindowState = WindowState.Minimized;
        }

        private void CaptionMax_Click(object sender, RoutedEventArgs e)
        {
            ToggleMaximizeRestore();
        }

        private void CaptionClose_Click(object sender, RoutedEventArgs e)
        {
            this.Close();
        }

        private void WireCaptionButton(string name, RoutedEventHandler onClick)
        {
            var btn = FindElement(name) as Button;
            if (btn == null) return;
            try { WindowChrome.SetIsHitTestVisibleInChrome(btn, true); } catch { }
            // Avoid double-subscribe if chrome is reapplied (e.g. leave fullscreen).
            btn.Click -= onClick;
            btn.Click += onClick;
        }

        private void TypoZenWindow_StateChangedForCaption(object sender, EventArgs e)
        {
            UpdateMaximizeCaptionGlyph();
        }

        private void UpdateMaximizeCaptionGlyph()
        {
            var btn = FindElement("btnWinMax") as Button;
            if (btn == null) return;
            // MDL2: E922 Maximize, E923 Restore
            if (this.WindowState == WindowState.Maximized)
            {
                btn.Content = "\uE923";
                btn.ToolTip = "Restore";
            }
            else
            {
                btn.Content = "\uE922";
                btn.ToolTip = "Maximize";
            }
        }

        private void ToggleMaximizeRestore()
        {
            this.WindowState = this.WindowState == WindowState.Maximized
                ? WindowState.Normal
                : WindowState.Maximized;
        }

        /// <summary>
        /// Drag when the press is on empty title-bar chrome (not a tab/button).
        /// WindowChrome usually handles this alone; this is a reliable fallback if the
        /// press lands on the band background while still in the caption height.
        /// </summary>
        private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (e.ChangedButton != MouseButton.Left) return;
            // Tabs/buttons already handle their own clicks; don't steal those.
            if (e.OriginalSource is Button) return;
            var fe = e.OriginalSource as FrameworkElement;
            if (fe != null)
            {
                // Inside a tab chip (Border with a close button child) — leave it alone.
                DependencyObject d = fe;
                while (d != null && d != sender)
                {
                    if (d is Button) return;
                    // Tab chips set Cursor=Hand and live under tabStrip
                    var p = d as FrameworkElement;
                    if (p != null && p.Parent == _tabStrip) return;
                    d = System.Windows.Media.VisualTreeHelper.GetParent(d);
                }
            }
            try
            {
                if (e.ClickCount == 2)
                {
                    ToggleMaximizeRestore();
                    e.Handled = true;
                    return;
                }
                this.DragMove();
            }
            catch { }
        }

        private object FindElement(string name)
        {
            var obj = this.FindName(name);
            if (obj != null) return obj;

            var contentDo = this.Content as DependencyObject;
            if (contentDo != null)
            {
                obj = LogicalTreeHelper.FindLogicalNode(contentDo, name);
                if (obj != null) return obj;
            }
            return null;
        }

        private void BindClick(string name, RoutedEventHandler handler)
        {
            var elem = FindElement(name);
            var mi = elem as MenuItem;
            if (mi != null)
            {
                mi.Click += handler;
                return;
            }
            var btn = elem as Button;
            if (btn != null)
            {
                btn.Click += handler;
            }
        }

        // When WebView2 has focus, WPF Window.KeyDown often never fires, and with
        // AreBrowserAcceleratorKeysEnabled=false older WebView2 builds also swallow
        // Ctrl+Z before page JS. ThreadPreprocessMessage sees WM_KEYDOWN for the
        // focused child HWND so undo/format chords always reach HistoryManager.
        // Zoom uses a WinForms IMessageFilter as well: WPF preprocess often misses
        // Ctrl++/Ctrl+wheel once focus is inside the hosted WebView HWND.
        private bool _editorKeyFilterInstalled;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_MOUSEWHEEL = 0x020A;
        private const int VK_MENU = 0x12, VK_LMENU = 0xA4, VK_RMENU = 0xA5;

        private void InstallEditorKeyFilter()
        {
            if (_editorKeyFilterInstalled) return;
            try
            {
                ComponentDispatcher.ThreadPreprocessMessage += OnThreadPreprocessMessage;
                _editorKeyFilterInstalled = true;
            }
            catch { }
        }

        private void UninstallEditorKeyFilter()
        {
            if (!_editorKeyFilterInstalled) return;
            try { ComponentDispatcher.ThreadPreprocessMessage -= OnThreadPreprocessMessage; } catch { }
            _editorKeyFilterInstalled = false;
        }

        private void OnThreadPreprocessMessage(ref MSG msg, ref bool handled)
        {
            if (handled) return;
            if (!IsActive) return;

            // Zoom keys/wheel are handled in page JS → zoom:in/out/reset (WebView focus)
            // plus WPF KeyDown / View menu (chrome focus). Do not also handle here or
            // every step would fire twice.

            if (msg.message != WM_KEYDOWN && msg.message != WM_SYSKEYDOWN) return;

            // Alt arrives as WM_SYSKEYDOWN while WebView has focus. Reveal auto-hidden
            // chrome; Alt+letter opens File/Edit/View/Themes/Help (and Alt+S search).
            if (msg.message == WM_SYSKEYDOWN)
            {
                int k = msg.wParam.ToInt32() & 0xFFFF;
                bool bareAlt = (k == VK_MENU || k == VK_LMENU || k == VK_RMENU);
                if (bareAlt)
                {
                    _suppressNextAltMenu = false;
                    if (_chromeHidden)
                    {
                        SetChromeHidden(false);
                        _chromeHideAfter = DateTime.UtcNow.AddMilliseconds(ChromeHideDelayMs);
                    }
                }
                if ((WinForms.Control.ModifierKeys & WinForms.Keys.Alt) == WinForms.Keys.Alt
                    && (WinForms.Control.ModifierKeys & WinForms.Keys.Control) != WinForms.Keys.Control)
                {
                    if (k >= 0x41 && k <= 0x5A)
                    {
                        char letter = (char)('a' + (k - 0x41));
                        if (letter == 'f' || letter == 'e' || letter == 'v' || letter == 't' || letter == 'h')
                        {
                            handled = true;
                            char L = letter;
                            Dispatcher.BeginInvoke(new Action(() => OpenMenuByAccessKey(L)), DispatcherPriority.Send);
                        }
                        else if (letter == 's')
                        {
                            handled = true;
                            _suppressNextAltMenu = true;
                            Dispatcher.BeginInvoke(new Action(() => SendMsg("cmd:toggle_search_sidebar")),
                                DispatcherPriority.Send);
                        }
                    }
                    else if (k == 0xDC || k == 0xE2)
                    {
                        handled = true;
                        _suppressNextAltMenu = true;
                        Dispatcher.BeginInvoke(new Action(() => SendMsg("cmd:toggle_sidebar")), DispatcherPriority.Send);
                    }
                }
            }

            // Ctrl held? (GetKeyState high bit)
            bool ctrl = (WinForms.Control.ModifierKeys & WinForms.Keys.Control) == WinForms.Keys.Control;
            if (!ctrl) return;
            bool shift = (WinForms.Control.ModifierKeys & WinForms.Keys.Shift) == WinForms.Keys.Shift;

            int vk = msg.wParam.ToInt32() & 0xFFFF;
            string cmd = null;

            if (vk == 0x5A) cmd = shift ? "cmd:redo" : "cmd:undo";          // Z
            else if (vk == 0x59) cmd = "cmd:redo";                           // Y
            else if (vk == 0x42) cmd = "fmt:bold";                           // B
            else if (vk == 0x49) cmd = "fmt:italic";                         // I
            else if (vk == 0x4B) cmd = "fmt:link";                           // K
            else if (vk == 0x54) cmd = "fmt:table";                          // T
            else if (vk == 0x58 && shift) cmd = "fmt:strike";                // Ctrl+Shift+X
            // Ctrl+W / Ctrl+Tab: page JS posts tab:close|next|prev when the editor has
            // focus (05-model.js). Do not also handle Ctrl+Tab here — double-fire made
            // tab targets jump. Chrome-focused Ctrl+Tab is handled in Window.KeyDown.
            else if (vk == 0x46 && !shift) cmd = "cmd:find";                 // F
            else if (vk == 0x48) cmd = "cmd:find_replace";                   // H
            else return;

            // Swallow so page JS never also runs the same chord (double undo/format).
            handled = true;

            if (cmd == "cmd:find" || cmd == "cmd:find_replace")
            {
                string c = cmd;
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    try { if (_webView != null) _webView.Focus(); } catch { }
                    SendMsg(c);
                }), DispatcherPriority.Send);
                return;
            }
            {
                string c = cmd;
                // Undo/redo: when WebView has focus, page JS handles Ctrl+Z (reliable).
                // Host only injects when focus is outside the editor (toolbar/menu chrome),
                // so we do not depend on preprocess alone and avoid double-steps when both fire.
                if (c == "cmd:undo" || c == "cmd:redo")
                {
                    bool webViewFocused = false;
                    try
                    {
                        if (_webView != null && _webView.Focused) webViewFocused = true;
                        else if (_webView != null && _webView.ContainsFocus) webViewFocused = true;
                    }
                    catch { }
                    if (webViewFocused)
                    {
                        // Page keydown will undo; still swallow native message (handled=true above)
                        return;
                    }
                    Dispatcher.BeginInvoke(new Action(() => SendHistoryCmd(c)), DispatcherPriority.Send);
                }
                else
                    Dispatcher.BeginInvoke(new Action(() => SendMsg(c)), DispatcherPriority.Send);
            }
        }

        private void TypoZenWindow_KeyDown(object sender, KeyEventArgs e)
        {
            // Plain Alt reveals auto-hidden chrome when WPF chrome has focus.
            if (e.Key == Key.LeftAlt || e.Key == Key.RightAlt
                || e.SystemKey == Key.LeftAlt || e.SystemKey == Key.RightAlt)
            {
                _suppressNextAltMenu = false;
                if (_chromeHidden)
                {
                    SetChromeHidden(false);
                    _chromeHideAfter = DateTime.UtcNow.AddMilliseconds(ChromeHideDelayMs);
                }
            }
            // Alt+F/E/V/T/H open top-level menus; Alt+S is search sidebar.
            else if ((Keyboard.Modifiers & ModifierKeys.Alt) == ModifierKeys.Alt
                     && (Keyboard.Modifiers & ModifierKeys.Control) != ModifierKeys.Control)
            {
                Key sk = e.SystemKey != Key.None ? e.SystemKey : e.Key;
                char letter = '\0';
                if (sk == Key.F) letter = 'f';
                else if (sk == Key.E) letter = 'e';
                else if (sk == Key.V) letter = 'v';
                else if (sk == Key.T) letter = 't';
                else if (sk == Key.H) letter = 'h';
                else if (sk == Key.S)
                {
                    SendMsg("cmd:toggle_search_sidebar");
                    _suppressNextAltMenu = true;
                    e.Handled = true;
                }
                else if (sk == Key.Oem5 || sk == Key.OemBackslash)
                {
                    SendMsg("cmd:toggle_sidebar");
                    _suppressNextAltMenu = true;
                    e.Handled = true;
                }
                if (letter != '\0')
                {
                    OpenMenuByAccessKey(letter);
                    e.Handled = true;
                }
            }

            if ((Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
            {
                if (e.Key == Key.N) { NewTab(); e.Handled = true; }
                else if (e.Key == Key.O) { OpenFile(); e.Handled = true; }
                else if (e.Key == Key.S)
                {
                    if ((Keyboard.Modifiers & ModifierKeys.Shift) == ModifierKeys.Shift) SaveFileAs();
                    else SaveFile();
                    e.Handled = true;
                }
                else if (e.Key == Key.P && (Keyboard.Modifiers & ModifierKeys.Shift) != ModifierKeys.Shift)
                { ExportPdf(); e.Handled = true; }
                else if (e.Key == Key.G)
                {
                    try { if (_webView != null) _webView.Focus(); } catch { }
                    SendMsg("cmd:goto_page");
                    e.Handled = true;
                }
                else if (e.Key == Key.M && (Keyboard.Modifiers & ModifierKeys.Shift) == ModifierKeys.Shift)
                {
                    SendMsg("cmd:mark_toggle");
                    e.Handled = true;
                }
                else if (e.Key == Key.P && (Keyboard.Modifiers & ModifierKeys.Shift) == ModifierKeys.Shift)
                {
                    SendMsg("cmd:show_marks");
                    e.Handled = true;
                }
                else if (e.Key == Key.J && (Keyboard.Modifiers & ModifierKeys.Shift) == ModifierKeys.Shift)
                {
                    SendMsg("cmd:return_jump");
                    e.Handled = true;
                }
                else if (e.Key == Key.B) { SendMsg("fmt:bold"); e.Handled = true; }
                else if (e.Key == Key.I) { SendMsg("fmt:italic"); e.Handled = true; }
                else if (e.Key == Key.K) { SendMsg("fmt:link"); e.Handled = true; }
                else if (e.Key == Key.T) { SendMsg("fmt:table"); e.Handled = true; }
                else if (e.Key == Key.X && (Keyboard.Modifiers & ModifierKeys.Shift) == ModifierKeys.Shift)
                {
                    SendMsg("fmt:strike");
                    e.Handled = true;
                }
                // Ctrl+Z / Ctrl+Y: ONLY via ThreadPreprocessMessage + SendHistoryCmd.
                // Do not also handle here — that caused double undo when both fired.
                else if (e.Key == Key.Z || e.Key == Key.Y)
                {
                    e.Handled = true;
                }
                else if (e.Key == Key.F)
                {
                    // Give WebView keyboard focus so the find input can take caret
                    try { if (_webView != null) _webView.Focus(); } catch { }
                    SendMsg("cmd:find");
                    e.Handled = true;
                }
                else if (e.Key == Key.H)
                {
                    try { if (_webView != null) _webView.Focus(); } catch { }
                    SendMsg("cmd:find_replace");
                    e.Handled = true;
                }
                else if (e.Key == Key.W) { CloseActiveTab(); e.Handled = true; }
                else if (e.Key == Key.Tab)
                {
                    CycleTab((Keyboard.Modifiers & ModifierKeys.Shift) == ModifierKeys.Shift ? -1 : +1);
                    e.Handled = true;
                }
                else if (e.Key == Key.OemPlus || e.Key == Key.Add) { ZoomBy(+ZoomStep); e.Handled = true; }
                else if (e.Key == Key.OemMinus || e.Key == Key.Subtract) { ZoomBy(-ZoomStep); e.Handled = true; }
                else if (e.Key == Key.D0 || e.Key == Key.NumPad0) { SetZoom(1.0); e.Handled = true; }
            }
            // Alt+S opens the search sidebar. The page claims this itself while the WebView
            else if (e.Key == Key.D && (Keyboard.Modifiers & (ModifierKeys.Control | ModifierKeys.Shift)) == (ModifierKeys.Control | ModifierKeys.Shift))
            {
                SendMsg("cmd:toggle_debug_hud");
                e.Handled = true;
            }
            else if (e.Key == Key.F1) { SendMsg("cmd:help_syntax"); e.Handled = true; }
            else if (e.Key == Key.F7) { SendMsg("cmd:toggle_reveal"); e.Handled = true; }
            else if (e.Key == Key.F8) { SendMsg("cmd:toggle_focus"); e.Handled = true; }
            else if (e.Key == Key.F9) { SendMsg("cmd:toggle_typewriter"); e.Handled = true; }
            else if (e.Key == Key.F11) { ToggleFullscreen(); e.Handled = true; }
        }

        private void TypoZenWindow_Closing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            _closeClickCount++;

            // Second close (or force): always exit. Never block on the editor again —
            // a hung sync/load used to make the window unclosable.
            if (_forceClose || _closeClickCount >= 2 || _scriptBlockDepth > 0)
            {
                e.Cancel = false;
                try { SaveWindowState(); } catch { }
                try { PersistSessionMeta(); } catch { }
                try { PersistTabSession(); } catch { }
                return;
            }

            if (_closePromptActive)
            {
                // Nested close while prompting: force exit next path
                e.Cancel = false;
                try { SaveWindowState(); } catch { }
                try { PersistTabSession(); } catch { }
                return;
            }

            _closePromptActive = true;
            try
            {
                // Pull live text: allow stale only when the tab looks clean.
                bool synced = false;
                try
                {
                    synced = SyncActiveTabFromEditor(allowStaleIfClean: true, timeoutMs: 5000);
                }
                catch { synced = false; }

                if (!synced && !ActiveTabLooksClean())
                {
                    var stuck = WinForms.MessageBox.Show(
                        "Could not read the latest text from the editor.\n\n" +
                        "Recent typing may be lost if you close now.\n\n" +
                        "Yes = Close anyway\nNo = Stay open",
                        "Could not reach editor",
                        WinForms.MessageBoxButtons.YesNo,
                        WinForms.MessageBoxIcon.Warning,
                        WinForms.MessageBoxDefaultButton.Button2);
                    if (stuck != WinForms.DialogResult.Yes)
                    {
                        e.Cancel = true;
                        _closeClickCount = 0;
                        return;
                    }
                }

                var pending = GetDirtyTabs();
                for (int i = 0; i < pending.Count; i++)
                {
                    var tab = pending[i];
                    bool isActive = (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                        && _tabs[_activeTabIndex] == tab);

                    var res = WinForms.MessageBox.Show(
                        "Save changes to " + TabDisplayName(tab) + "?",
                        "Unsaved Changes",
                        WinForms.MessageBoxButtons.YesNoCancel,
                        WinForms.MessageBoxIcon.Warning);

                    if (res == WinForms.DialogResult.Cancel)
                    {
                        e.Cancel = true;
                        _closeClickCount = 0;
                        return;
                    }
                    if (res == WinForms.DialogResult.No)
                    {
                        DiscardTabEdits(tab);
                        continue;
                    }
                    // Active dirty tab: require a successful pull before write when possible.
                    if (isActive)
                    {
                        if (!SyncActiveTabFromEditor(allowStaleIfClean: false, timeoutMs: 8000))
                        {
                            var sure = WinForms.MessageBox.Show(
                                "Still could not read the editor.\n\n" +
                                "Save the last known text in memory? It may be incomplete.\n\n" +
                                "Yes = Save known text\nNo = Skip save\nCancel = Stay open",
                                "Could not reach editor",
                                WinForms.MessageBoxButtons.YesNoCancel,
                                WinForms.MessageBoxIcon.Warning,
                                WinForms.MessageBoxDefaultButton.Button3);
                            if (sure == WinForms.DialogResult.Cancel)
                            {
                                e.Cancel = true;
                                _closeClickCount = 0;
                                return;
                            }
                            if (sure != WinForms.DialogResult.Yes)
                                continue;
                        }
                    }
                    if (!SaveTabNow(tab, false))
                    {
                        e.Cancel = true;
                        _closeClickCount = 0;
                        return;
                    }
                }

                _isDirty = false;
                SaveWindowState();
                PersistSessionMeta();
                PersistTabSession();
            }
            finally { _closePromptActive = false; }
        }

        /// <summary>
        /// Pull editor before closing a tab. Dirty + failed sync → refuse (caller stays).
        /// </summary>
        private bool EnsureActiveEditorSyncedForClose()
        {
            try
            {
                if (SyncActiveTabFromEditor(allowStaleIfClean: true, timeoutMs: 5000))
                    return true;
            }
            catch { }
            if (ActiveTabLooksClean()) return true;
            if (_e2eMode) return true;
            NotifyEditorSyncFailedForTabOp();
            return false;
        }

        /// <summary>
        /// Every buffer with unsaved changes. Closing prompts for all of them; it used
        /// to consult the single _isDirty flag, which only tracks the active tab, so
        /// background tabs were discarded without a word.
        /// </summary>
        /// <summary>True when this tab is a read-only book (.epub). Never dirty, never save-prompt.</summary>
        private static bool IsBookTab(DocTab tab)
        {
            if (tab == null) return false;
            if (tab.Kind == DocKind.Book) return true;
            return !string.IsNullOrEmpty(tab.FilePath)
                && tab.FilePath.EndsWith(".epub", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsNativeTab(DocTab tab)
        {
            return tab != null && (tab.Kind == DocKind.Native || tab.NativeRole != NativeRole.None);
        }

        /// <summary>Book or native: never dirty, never save-over, Reader chrome.</summary>
        private static bool IsReadOnlyTab(DocTab tab)
        {
            return IsBookTab(tab) || IsNativeTab(tab);
        }

        private static bool IsNativePath(string path)
        {
            return ClassifyNativeRole(path) != NativeRole.None;
        }

        private static NativeRole ClassifyNativeRole(string path)
        {
            if (string.IsNullOrEmpty(path)) return NativeRole.None;
            string ext = Path.GetExtension(path);
            if (string.IsNullOrEmpty(ext)) return NativeRole.None;
            ext = ext.ToLowerInvariant();
            if (ext == ".pdf") return NativeRole.Pdf;
            if (ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif"
                || ext == ".webp" || ext == ".bmp" || ext == ".ico" || ext == ".svg"
                || ext == ".avif" || ext == ".jfif")
                return NativeRole.Image;
            if (ext == ".mp4" || ext == ".webm" || ext == ".ogv" || ext == ".mov")
                return NativeRole.Video;
            if (ext == ".mp3" || ext == ".wav" || ext == ".ogg" || ext == ".m4a" || ext == ".flac")
                return NativeRole.Audio;
            // HTML: render as a page (default). Relative CSS/images resolve via localview folder map.
            // CSS / XML / XAML are ordinary text — open in the editor (Source), not a native
            // "markup shell". A read-only <pre> is worse than Source and not a Chromium feature.
            if (ext == ".html" || ext == ".htm" || ext == ".xhtml")
                return NativeRole.Page;
            return NativeRole.None;
        }

        private static DocKind ClassifyDocKind(string path)
        {
            if (string.IsNullOrEmpty(path)) return DocKind.Engine;
            if (path.EndsWith(".epub", StringComparison.OrdinalIgnoreCase)) return DocKind.Book;
            if (ClassifyNativeRole(path) != NativeRole.None) return DocKind.Native;
            return DocKind.Engine;
        }

        private static string NativeRoleLabel(NativeRole role)
        {
            switch (role)
            {
                case NativeRole.Pdf: return "PDF";
                case NativeRole.Image: return "Image";
                case NativeRole.Video: return "Video";
                case NativeRole.Audio: return "Audio";
                case NativeRole.Page: return "HTML";
                default: return "File";
            }
        }

        private List<DocTab> GetDirtyTabs()
        {
            var list = new List<DocTab>();
            for (int i = 0; i < _tabs.Count; i++)
            {
                if (_tabs[i] == null || !_tabs[i].IsDirty) continue;
                // Books and native files cannot be dirty: read-only, nothing to write back.
                if (IsReadOnlyTab(_tabs[i]))
                {
                    _tabs[i].IsDirty = false;
                    continue;
                }
                list.Add(_tabs[i]);
            }
            return list;
        }

        /// <summary>Tab name without the dirty marker, for prompts.</summary>
        private static string TabDisplayName(DocTab tab)
        {
            if (tab == null) return "Untitled.md";
            return string.IsNullOrEmpty(tab.FilePath) ? "Untitled.md" : Path.GetFileName(tab.FilePath);
        }

        /// <summary>
        /// Write one specific tab to disk, synchronously.
        ///
        /// Callers must have synced the active buffer first (SyncActiveTabFromEditor);
        /// this writes tab.Content and never touches the editor, so it cannot be raced.
        /// The old path posted request_save to the page and wrote whatever came back to
        /// _currentFilePath — but that reply lands a message-loop turn later, by which
        /// time closing/switching a tab had already repointed _currentFilePath, so one
        /// tab's text was written into another tab's file.
        /// </summary>
        /// <summary>
        /// The editor buffer as file text: restores the line-ending style and the exact
        /// trailing newlines the file had when it was loaded.
        ///
        /// The editor is LF-internal (loadMarkdownContent splits on /\r?\n/, the
        /// serializer joins with "\n") and it drops trailing blank lines. Writing the
        /// buffer straight out therefore rewrote every line of a CRLF file and dropped
        /// the final newline of almost every file — opening a document and saving it
        /// without touching it produced a diff. New documents default to LF plus a
        /// single trailing newline.
        /// </summary>
        private static string ComposeFileText(DocTab tab)
        {
            string body = (tab.Content ?? "").Replace("\r\n", "\n");
            if (tab.LineEnding == "\r\n") body = body.Replace("\n", "\r\n");
            return body + (tab.TrailingNewlines ?? "");
        }

        // Pre-save content-loss guard. Every corruption bug this editor has had shared one
        // shape: content vanished and the save wrote the damage over the only good copy.
        // Since we keep no backups, the single moment the loss is still free to undo is
        // just before the overwrite — the old version is right there on disk.
        private const double LossRatioTrigger = 0.30;   // must lose this share of the file
        private const int LossMinDocChars = 200;        // ...of a document at least this big
        private const int LossMinLostChars = 200;       // ...and this much in absolute terms
        private int _lossPromptCount;                   // times the guard fired (E2E probe)

        /// <summary>
        /// Would writing <paramref name="newText"/> over <paramref name="oldText"/> drop a
        /// suspicious amount of content? Pure decision, no UI: the dialog is the caller's
        /// job, so this stays testable and cannot hang a headless run.
        /// Thresholds are deliberately blunt — this catches bulk loss, not a mangled word.
        /// </summary>
        private static bool WouldLoseContent(string oldText, string newText, out string summary)
        {
            summary = null;
            if (oldText == null || newText == null) return false;

            string oldN = oldText.Replace("\r\n", "\n");
            string newN = newText.Replace("\r\n", "\n");
            if (oldN.Length < LossMinDocChars) return false;      // too small to judge

            int lost = oldN.Length - newN.Length;
            if (lost < LossMinLostChars) return false;
            if ((double)lost / oldN.Length < LossRatioTrigger) return false;

            // Name what is going, or the dialog is unanswerable and gets clicked through.
            var oldLines = oldN.Split('\n');
            var newLines = newN.Split('\n');
            var kept = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < newLines.Length; i++) kept.Add(newLines[i].Trim());

            var vanished = new List<string>();
            for (int i = 0; i < oldLines.Length && vanished.Count < 5; i++)
            {
                string t = oldLines[i].Trim();
                if (t.Length == 0) continue;
                if (!kept.Contains(t)) vanished.Add(t.Length > 70 ? t.Substring(0, 70) + "..." : t);
            }

            var sb = new StringBuilder();
            sb.AppendLine("Saving would remove " + lost.ToString("N0") + " characters — " +
                (int)Math.Round(100.0 * lost / oldN.Length) + "% of the file.");
            sb.AppendLine();
            sb.AppendLine("On disk: " + oldLines.Length + " lines.  After saving: " + newLines.Length + " lines.");
            if (vanished.Count > 0)
            {
                sb.AppendLine();
                sb.AppendLine("Lines that would disappear:");
                for (int i = 0; i < vanished.Count; i++) sb.AppendLine("    " + vanished[i]);
            }
            summary = sb.ToString();
            return true;
        }

        /// <summary>
        /// Read the file we are about to overwrite and ask before dropping a big chunk of
        /// it. Returns false only if the user chose to cancel the save.
        /// </summary>
        private bool ConfirmOverwriteLoss(DocTab tab, string path, string newText)
        {
            if (tab == null || string.IsNullOrEmpty(path)) return true;
            if (!File.Exists(path)) return true;    // nothing to lose

            string oldText;
            try
            {
                string enc;
                oldText = ReadTextFileDetect(path, out enc);
            }
            catch { return true; }                  // unreadable: not our business to block

            string summary;
            if (!WouldLoseContent(oldText, newText, out summary)) return true;

            // Detection happens before the headless bail-out, so the E2E can prove the
            // guard is actually reached on the real save path rather than just unit-testing
            // the predicate and assuming it is wired up.
            _lossPromptCount++;
            if (_e2eMode) return true;              // never block a headless run on a dialog

            var res = WinForms.MessageBox.Show(
                summary + "\nSave anyway?",
                "Large amount of content would be lost",
                WinForms.MessageBoxButtons.YesNo,
                WinForms.MessageBoxIcon.Warning,
                WinForms.MessageBoxDefaultButton.Button2);   // default is No: don't overwrite
            return res == WinForms.DialogResult.Yes;
        }

        private bool SaveTabNow(DocTab tab, bool forceSaveAs)
        {
            if (tab == null) return false;

            string path = tab.FilePath;

            // A book is a source document, never a save target.
            //
            // Opening an .epub extracted it to text and left tab.FilePath pointing at the
            // book, so Ctrl+S wrote that text straight over it. The loss guard could not
            // help: ConfirmOverwriteLoss re-reads the old file through ReadTextFileDetect,
            // which for an .epub runs the extractor -- so it compared extracted text against
            // extracted text, found nothing lost, and destroyed the book without a prompt.
            //
            // Saving an epub therefore always means Save As, defaulting to a .md beside it.
            // In the reader architecture this is not a guard but the shape of the thing: an
            // epub document is read-only and writing it out is an export.
            bool isBook = IsBookTab(tab)
                || (!string.IsNullOrEmpty(path)
                    && path.EndsWith(".epub", StringComparison.OrdinalIgnoreCase));
            bool isNative = IsNativeTab(tab) || IsNativePath(path);
            // Native files have no engine text — Save is refuse, not "export as md".
            if (isNative && !forceSaveAs)
            {
                WinForms.MessageBox.Show(
                    "This file is opened for reading only." +
                    Environment.NewLine + Environment.NewLine +
                    "TypoZen does not overwrite PDF, images, or media.",
                    "Read only", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
                return false;
            }
            if (isBook) forceSaveAs = true;

            if (forceSaveAs || string.IsNullOrEmpty(path))
            {
                using (var dlg = new WinForms.SaveFileDialog())
                {
                    dlg.Filter = "Markdown File (*.md)|*.md|Text File (*.txt)|*.txt|All Files|*.*";
                    dlg.DefaultExt = "md";
                    dlg.Title = isBook ? "Export Book As" : "Save Document";
                    dlg.FileName = string.IsNullOrEmpty(tab.FilePath) ? "Untitled.md"
                        : (isBook || isNative
                            ? Path.GetFileNameWithoutExtension(tab.FilePath) + ".md"
                            : Path.GetFileName(tab.FilePath));
                    if (!string.IsNullOrEmpty(tab.FilePath))
                    {
                        try { dlg.InitialDirectory = Path.GetDirectoryName(tab.FilePath); } catch { }
                    }
                    if (dlg.ShowDialog() != WinForms.DialogResult.OK) return false;
                    path = dlg.FileName;
                }
            }

            try { path = Path.GetFullPath(path); } catch { }

            // Belt and braces: never write engine text over a book or native file.
            if (path.EndsWith(".epub", StringComparison.OrdinalIgnoreCase) || IsNativePath(path))
            {
                WinForms.MessageBox.Show(
                    "TypoZen will not write text over that file type." +
                    Environment.NewLine + Environment.NewLine +
                    "Choose a .md or .txt name instead.",
                    "Save", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Warning);
                return false;
            }

            // Never leave two tabs on the same path (Save As collision → silent overwrite).
            int otherIdx = IndexOfTabPath(path);
            if (otherIdx >= 0 && _tabs[otherIdx] != tab)
            {
                var other = _tabs[otherIdx];
                if (other.IsDirty)
                {
                    WinForms.MessageBox.Show(
                        "That file is already open in another tab with unsaved changes.\n\n" +
                        "Save or discard those edits first, or choose a different name.",
                        "File already open",
                        WinForms.MessageBoxButtons.OK,
                        WinForms.MessageBoxIcon.Warning);
                    return false;
                }
                // Clean duplicate tab: drop it so this tab becomes the sole owner.
                int removeAt = otherIdx;
                if (removeAt < _activeTabIndex) _activeTabIndex--;
                else if (removeAt == _activeTabIndex)
                {
                    // Should not happen (active is usually the saver); keep saver active.
                }
                _tabs.RemoveAt(removeAt);
                if (_activeTabIndex >= _tabs.Count)
                    _activeTabIndex = _tabs.Count - 1;
                // Re-find saver index after removal
                int self = _tabs.IndexOf(tab);
                if (self >= 0) _activeTabIndex = self;
            }

            string outText = ComposeFileText(tab);

            // Only guard an overwrite of this tab's OWN file. Save As onto some other
            // existing document is a deliberate replacement — comparing two unrelated
            // files would fire every time, and Windows already asked about overwriting.
            bool overwritingOwnFile = !forceSaveAs &&
                string.Equals(path, tab.FilePath, StringComparison.OrdinalIgnoreCase);
            if (overwritingOwnFile)
            {
                string ignored, ignoredEnc;
                if (EngineDiskTextChanged(tab, path, out ignored, out ignoredEnc) && !_e2eMode)
                {
                    var overwrite = WinForms.MessageBox.Show(
                        "This file has changed on disk since it was opened or last saved.\n\n" +
                        "Save anyway and overwrite those changes?",
                        "File changed on disk",
                        WinForms.MessageBoxButtons.YesNo,
                        WinForms.MessageBoxIcon.Warning,
                        WinForms.MessageBoxDefaultButton.Button2);
                    if (overwrite != WinForms.DialogResult.Yes) return false;
                }
            }
            if (overwritingOwnFile && !ConfirmOverwriteLoss(tab, path, outText)) return false;

            try
            {
                _ignoreDiskWatchUntil = DateTime.UtcNow.AddSeconds(2);
                WriteStateFileAtomic(path, outText);
            }
            catch (Exception ex)
            {
                WinForms.MessageBox.Show("Error saving file: " + ex.Message, "Error",
                    WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                return false;
            }

            tab.FilePath = path;
            tab.IsDirty = false;
            StampTabDisk(tab, path, outText);
            try { SyncDiskWatchers(); } catch { }
            // Images removed from the document are now unreferenced — recycle them.
            PruneOrphanedAssets(path, tab.Content);

            bool isActive = (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count && _tabs[_activeTabIndex] == tab);
            if (isActive)
            {
                _currentFilePath = path;
                _isDirty = false;
                SendMsg("save_success");
                UpdateStatusDisplay();
            }
            PersistSessionMeta();
            AddRecentFile(path);
            PersistTabSession();
            RebuildTabStrip();
            return true;
        }

        private static string DecodeJsStringResult(string encoded)
        {
            if (string.IsNullOrEmpty(encoded) || encoded == "null") return "";
            // WebView2 wraps script results as JSON values
            try
            {
                if (encoded.Length >= 2 && encoded[0] == '"' && encoded[encoded.Length - 1] == '"')
                {
                    // Lightweight JSON string unescape
                    string s = encoded.Substring(1, encoded.Length - 2);
                    var sb = new StringBuilder(s.Length);
                    for (int i = 0; i < s.Length; i++)
                    {
                        if (s[i] == '\\' && i + 1 < s.Length)
                        {
                            char n = s[++i];
                            if (n == 'n') sb.Append('\n');
                            else if (n == 'r') sb.Append('\r');
                            else if (n == 't') sb.Append('\t');
                            else if (n == '"' || n == '\\' || n == '/') sb.Append(n);
                            else if (n == 'u' && i + 4 < s.Length)
                            {
                                string hex = s.Substring(i + 1, 4);
                                int cp;
                                if (int.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out cp))
                                {
                                    sb.Append((char)cp);
                                    i += 4;
                                }
                                else sb.Append(n);
                            }
                            else sb.Append(n);
                        }
                        else sb.Append(s[i]);
                    }
                    return sb.ToString();
                }
            }
            catch { }
            return encoded;
        }

        /// <summary>
        /// Write a file without a torn-write window: full contents go to path.tmp in the
        /// same folder, flushed to disk, then swapped in as path.
        ///
        /// Used for:
        ///   • settings.json / session meta (prefs + scratchpad)
        ///   • the user's document on Save (so a crash mid-write cannot truncate the .md)
        ///
        /// Sequence:
        ///   1. Write + flush the complete temp file
        ///   2. Prefer File.Replace(tmp → path) so the original is never absent
        ///   3. If Replace fails (some network / OneDrive edge cases): delete original,
        ///      then rename temp → path (what you described as the simple mental model)
        ///
        /// Also creates the parent directory when missing.
        // ---- Reading position per book ------------------------------------------------
        //
        // A book is not a document you edit, it is one you are part way through. The tab
        // session records paths and buffers; it has no notion of "page 340 of Matter", and
        // a book's tab carries no text for a caret to sit in. So this is its own small
        // store, keyed by the book's path.
        //
        // Newest first, capped, so a reader who opens a hundred books does not accumulate a
        // hundred lines forever.
        private const int MaxRememberedBooks = 64;
        private Dictionary<string, int> _bookPositions;

        private void LoadBookPositions()
        {
            if (_bookPositions != null) return;
            _bookPositions = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            try
            {
                string path = BookPositionsPath();
                if (!File.Exists(path)) return;
                foreach (string line in File.ReadAllLines(path))
                {
                    // "<block>\t<path>"
                    int tab = line.IndexOf('\t');
                    if (tab <= 0) continue;
                    int block;
                    if (!int.TryParse(line.Substring(0, tab), out block)) continue;
                    string bookPath = line.Substring(tab + 1);
                    if (bookPath.Length == 0 || _bookPositions.ContainsKey(bookPath)) continue;
                    _bookPositions[bookPath] = block;
                    if (_bookPositions.Count >= MaxRememberedBooks) break;
                }
            }
            catch { }
        }

        private void SaveBookPositions(string mostRecent)
        {
            try
            {
                LoadBookPositions();
                var sb = new StringBuilder();
                var written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                // The book just read goes first, so the cap evicts what has been untouched
                // longest rather than whatever happens to hash first.
                if (!string.IsNullOrEmpty(mostRecent) && _bookPositions.ContainsKey(mostRecent))
                {
                    sb.AppendLine(_bookPositions[mostRecent] + "\t" + mostRecent);
                    written.Add(mostRecent);
                }
                foreach (var kv in _bookPositions)
                {
                    if (written.Count >= MaxRememberedBooks) break;
                    if (written.Contains(kv.Key)) continue;
                    sb.AppendLine(kv.Value + "\t" + kv.Key);
                    written.Add(kv.Key);
                }
                WriteStateFileAtomic(BookPositionsPath(), sb.ToString());
            }
            catch { }
        }

        private int RememberedBookPosition(string bookPath)
        {
            LoadBookPositions();
            int at;
            if (!string.IsNullOrEmpty(bookPath) && _bookPositions.TryGetValue(bookPath, out at)) return at;
            return -1;
        }

        // ---- Dictionary -----------------------------------------------------------
        //
        // Lookups are answered here rather than in the page because a dictionary worth
        // having is tens of megabytes, and marshalling that across the WebView bridge to
        // sit in the document's memory would cost more than the feature is worth. The page
        // asks for one word and gets one answer.
        //
        // dictionary.tsv / thesaurus.tsv ship beside the exe (WordNet 3.1, see
        // WORDNET-LICENSE.txt). CacheDir() is checked first so a drop-in file there
        // overrides the bundled one without touching the install. TSV rather than JSON
        // because a 40 MB JSON parse on first lookup would be felt.
        private Dictionary<string, string> _dictionary;
        private bool _dictionaryChecked;
        // WordNet is a thesaurus as well as a dictionary -- a synset is a set of words that
        // mean the same thing -- so the same converter writes both files from one pass, and
        // the same loader reads them. Separate rather than merged because a reader asking
        // "what does this mean" and one asking "what else could I say" are different
        // questions, and a popover answering both at once answers neither well.
        private Dictionary<string, string> _thesaurus;
        private bool _thesaurusChecked;

        private void LoadDictionary()
        {
            if (_dictionaryChecked) return;
            _dictionaryChecked = true;
            _dictionary = LoadLexicon("dictionary");
        }

        private void LoadThesaurus()
        {
            if (_thesaurusChecked) return;
            _thesaurusChecked = true;
            _thesaurus = LoadLexicon("thesaurus");
        }

        /// <summary>Read "&lt;stem&gt;.tsv" or "&lt;stem&gt;.json" from the cache or the app folder.</summary>
        private Dictionary<string, string> LoadLexicon(string stem)
        {
            foreach (string dir in new[] { CacheDir(), _appDir })
            {
                foreach (string name in new[] { stem + ".tsv", stem + ".json" })
                {
                    string path;
                    try { path = Path.Combine(dir, name); } catch { continue; }
                    if (!File.Exists(path)) continue;
                    try
                    {
                        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                        if (name.EndsWith(".tsv", StringComparison.OrdinalIgnoreCase))
                        {
                            foreach (string line in File.ReadLines(path))
                            {
                                int tab = line.IndexOf('	');
                                if (tab <= 0) continue;
                                string w = line.Substring(0, tab).Trim();
                                if (w.Length == 0 || map.ContainsKey(w)) continue;
                                map[w] = line.Substring(tab + 1).Trim();
                            }
                        }
                        else
                        {
                            // Deliberately not a JSON parser: this is a flat string map, and
                            // the app has no serializer dependency to reach for.
                            string text = File.ReadAllText(path, Encoding.UTF8);
                            // Verbatim string: the pattern is full of backslashes and doubling
                            // every one of them is how the previous attempt at this line
                            // failed to compile.
                            foreach (Match m in Regex.Matches(text,
                                @"""((?:[^""\\]|\\.)*)""\s*:\s*""((?:[^""\\]|\\.)*)"""))
                            {
                                string w = Regex.Unescape(m.Groups[1].Value).Trim();
                                if (w.Length == 0 || map.ContainsKey(w)) continue;
                                map[w] = Regex.Unescape(m.Groups[2].Value).Trim();
                            }
                        }
                        if (map.Count > 0) return map;
                    }
                    catch { }
                }
            }
            return null;
        }

        /// <summary>One word in, one definition out. Empty when there is nothing to look in.</summary>
        private void AnswerDefinition(string word)
        {
            LoadDictionary();
            string def = "";
            if (_dictionary != null && !string.IsNullOrEmpty(word))
            {
                if (!_dictionary.TryGetValue(word, out def))
                {
                    // A reader selects the word as it appears on the page, which is inflected
                    // far more often than not. Trying the obvious reductions is the difference
                    // between a dictionary that answers and one that shrugs at "walking".
                    foreach (string stem in WordStems(word))
                    {
                        if (_dictionary.TryGetValue(stem, out def)) break;
                    }
                }
            }
            // "definition:<installed>	<word>	<definition>	<synonyms>". Both in one reply
            // because both come from one lookup, and the page decides what to show.
            LoadThesaurus();
            string syn = "";
            if (_thesaurus != null && !string.IsNullOrEmpty(word))
            {
                if (!_thesaurus.TryGetValue(word, out syn))
                {
                    foreach (string stem in WordStems(word))
                    {
                        if (_thesaurus.TryGetValue(stem, out syn)) break;
                    }
                }
            }
            SendMsg("definition:" + (_dictionary != null ? "1" : "0") + "	" + word
                + "	" + (def ?? "") + "	" + (syn ?? ""));
        }

        private static IEnumerable<string> WordStems(string w)
        {
            if (w.Length > 4 && w.EndsWith("ies", StringComparison.OrdinalIgnoreCase))
                yield return w.Substring(0, w.Length - 3) + "y";
            if (w.Length > 3 && w.EndsWith("s", StringComparison.OrdinalIgnoreCase))
                yield return w.Substring(0, w.Length - 1);
            if (w.Length > 4 && w.EndsWith("es", StringComparison.OrdinalIgnoreCase))
                yield return w.Substring(0, w.Length - 2);
            if (w.Length > 4 && w.EndsWith("ed", StringComparison.OrdinalIgnoreCase))
            {
                yield return w.Substring(0, w.Length - 2);
                yield return w.Substring(0, w.Length - 1);
            }
            if (w.Length > 5 && w.EndsWith("ing", StringComparison.OrdinalIgnoreCase))
            {
                yield return w.Substring(0, w.Length - 3);
                yield return w.Substring(0, w.Length - 3) + "e";
            }
            if (w.Length > 4 && w.EndsWith("ly", StringComparison.OrdinalIgnoreCase))
                yield return w.Substring(0, w.Length - 2);
        }

        // ---- Bookmarks ------------------------------------------------------------
        //
        // The host is a keyed blob store and deliberately nothing more. A mark is a block
        // index, a fingerprint of the text it was set on, and a name -- all of which are
        // the page's business, because the page is what has a document model and knows how
        // to resolve one against the other. Serialising here as well would be a second
        // implementation of a format with one owner, and the two would drift.
        //
        // So one line per document, exactly the shape book_positions.txt already uses, and
        // capped by document for the same reason: an unbounded file keyed by every path
        // ever opened is a slow leak. Marks *within* a document are not capped -- a limit
        // on how many places you may mark in a book is a limit on how carefully you are
        // allowed to read it.
        private const int MaxBookmarkDocs = 64;
        private Dictionary<string, string> _bookmarks;

        private void LoadBookmarks()
        {
            if (_bookmarks != null) return;
            _bookmarks = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                string path = BookmarksPath();
                if (!File.Exists(path)) return;
                foreach (string line in File.ReadAllLines(path))
                {
                    // "<path>\t<payload>" — path first here, unlike book_positions, because
                    // the payload is the variable-length part and a split on the first tab
                    // must not be able to land inside it.
                    int tab = line.IndexOf('\t');
                    if (tab <= 0) continue;
                    string docPath = line.Substring(0, tab);
                    string payload = line.Substring(tab + 1);
                    if (docPath.Length == 0 || _bookmarks.ContainsKey(docPath)) continue;
                    _bookmarks[docPath] = payload;
                    if (_bookmarks.Count >= MaxBookmarkDocs) break;
                }
            }
            catch { }
        }

        private void SaveBookmarks(string mostRecent)
        {
            try
            {
                LoadBookmarks();
                var sb = new StringBuilder();
                var written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                // Most recently touched first, so the cap evicts the document left alone
                // longest rather than whichever happens to hash first.
                if (!string.IsNullOrEmpty(mostRecent) && _bookmarks.ContainsKey(mostRecent))
                {
                    sb.AppendLine(mostRecent + "\t" + _bookmarks[mostRecent]);
                    written.Add(mostRecent);
                }
                foreach (var kv in _bookmarks)
                {
                    if (written.Count >= MaxBookmarkDocs) break;
                    if (written.Contains(kv.Key)) continue;
                    sb.AppendLine(kv.Key + "\t" + kv.Value);
                    written.Add(kv.Key);
                }
                WriteStateFileAtomic(BookmarksPath(), sb.ToString());
            }
            catch { }
        }

        private string RememberedBookmarks(string docPath)
        {
            LoadBookmarks();
            string payload;
            if (!string.IsNullOrEmpty(docPath) && _bookmarks.TryGetValue(docPath, out payload))
                return payload ?? "";
            return "";
        }

        private void RememberBookmarks(string docPath, string payload)
        {
            // Marks made in privacy mode live for the session and are not written.
            if (SuppressDocumentTraces()) return;
            if (string.IsNullOrEmpty(docPath)) return;
            LoadBookmarks();
            payload = payload ?? "";
            // A newline would break the one-line-per-document format outright; the page
            // does not send one, and this is the place that must not depend on that.
            payload = payload.Replace("\r", "").Replace("\n", "");
            string had;
            if (_bookmarks.TryGetValue(docPath, out had) && had == payload) return;
            if (payload.Length == 0) _bookmarks.Remove(docPath);
            else _bookmarks[docPath] = payload;
            SaveBookmarks(payload.Length == 0 ? null : docPath);
        }

        /// <summary>Hand a document's marks to the page, or an empty list if it has none.</summary>
        private void SendBookmarksForCurrentDocument()
        {
            string p = _currentFilePath;
            string payload = "";
            if (!string.IsNullOrEmpty(p))
            {
                try { payload = RememberedBookmarks(Path.GetFullPath(p)); } catch { }
            }
            SendMsg("marks_load:" + payload);
        }

        private void RememberBookPosition(string bookPath, int block)
        {
            if (SuppressDocumentTraces()) return;
            if (string.IsNullOrEmpty(bookPath) || block < 0) return;
            LoadBookPositions();
            int had;
            if (_bookPositions.TryGetValue(bookPath, out had) && had == block) return;
            _bookPositions[bookPath] = block;
            SaveBookPositions(bookPath);
        }

        /// </summary>
        private static void WriteStateFileAtomic(string path, string contents)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            string tmp = path + ".tmp";
            var enc = new UTF8Encoding(false);
            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(fs, enc))
            {
                writer.Write(contents);
                writer.Flush();
                fs.Flush(true); // through to disk before the swap
            }

            if (!File.Exists(path))
            {
                File.Move(tmp, path);
                return;
            }

            // Prefer Replace with a backup so the original is never deleted without a copy.
            string backup = path + ".bak";
            try
            {
                try { if (File.Exists(backup)) File.Delete(backup); } catch { }
                File.Replace(tmp, path, backup);
                try { if (File.Exists(backup)) File.Delete(backup); } catch { }
                return;
            }
            catch
            {
                // OneDrive / locked files: move original aside, then promote temp.
                // Never File.Delete(path) while tmp is the only good copy.
                string old = path + ".old";
                try { if (File.Exists(old)) File.Delete(old); } catch { }
                try
                {
                    File.Move(path, old);
                    try
                    {
                        File.Move(tmp, path);
                        try { File.Delete(old); } catch { }
                        return;
                    }
                    catch
                    {
                        // Restore original if promote failed.
                        try
                        {
                            if (!File.Exists(path) && File.Exists(old))
                                File.Move(old, path);
                        }
                        catch { }
                        throw;
                    }
                }
                catch
                {
                    // Last resort: leave tmp beside the original for recovery.
                    throw;
                }
            }
        }

        /// <summary>Remember last file path (and clear dirty scratch when a real file is open).</summary>
        private void PersistSessionMeta()
        {
            try
            {
                // Re-merge through host prefs so we never leave a raw page blob on disk.
                MergeAndWriteHostPrefs(null);
            }
            catch { }
        }

        /// <summary>
        /// Revert a dirty tab after the user chose "No" on close — so session restore
        /// does not resurrect edits they explicitly discarded.
        /// </summary>
        private void DiscardTabEdits(DocTab tab)
        {
            if (tab == null) return;
            if (!string.IsNullOrEmpty(tab.FilePath) && File.Exists(tab.FilePath))
            {
                try
                {
                    string enc;
                    string content = ReadTextFileDetect(tab.FilePath, out enc);
                    tab.LineEnding = DetectLineEnding(content);
                    tab.TrailingNewlines = DetectTrailingNewlines(content);
                    tab.Content = content.Replace("\r\n", "\n").TrimEnd('\n');
                    tab.SourceEncoding = enc;
                    tab.IsDirty = false;
                    StampTabDisk(tab, tab.FilePath, content);
                    return;
                }
                catch { }
            }
            tab.Content = "";
            tab.IsDirty = false;
        }

        /// <summary>
        /// Record what the file on disk looked like after a load or save, so a later
        /// check can tell "OneDrive touched mtime" from "git wrote new bytes".
        /// </summary>
        private void StampTabDisk(DocTab tab, string path, string diskText)
        {
            if (tab == null) return;
            tab.DiskConflict = false;
            tab.DiskFingerprint = ContentFingerprint(diskText ?? "");
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                tab.DiskWriteTimeUtc = DateTime.MinValue;
                tab.DiskLength = -1;
                return;
            }
            try
            {
                var fi = new FileInfo(path);
                tab.DiskWriteTimeUtc = fi.LastWriteTimeUtc;
                tab.DiskLength = fi.Length;
            }
            catch
            {
                tab.DiskWriteTimeUtc = DateTime.MinValue;
                tab.DiskLength = -1;
            }
        }

        private void StampTabDiskFromPath(DocTab tab, string path)
        {
            if (tab == null) return;
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                StampTabDisk(tab, path, "");
                return;
            }
            try
            {
                string enc;
                string text = ReadTextFileDetect(path, out enc);
                StampTabDisk(tab, path, text);
            }
            catch
            {
                StampTabDisk(tab, path, "");
            }
        }

        private static bool IsEngineDiskTab(DocTab tab)
        {
            if (tab == null || string.IsNullOrEmpty(tab.FilePath)) return false;
            if (tab.Kind == DocKind.Book || tab.Kind == DocKind.Native) return false;
            if (tab.FilePath.EndsWith(".epub", StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }

        /// <summary>
        /// Fast path: length and write-time still match the stamp. 2 s slop covers FAT
        /// resolution and OneDrive restamping a file it did not rewrite.
        /// </summary>
        private static bool DiskStampMatches(DocTab tab, FileInfo fi)
        {
            if (tab == null || fi == null || tab.DiskLength < 0) return false;
            if (fi.Length != tab.DiskLength) return false;
            return Math.Abs((fi.LastWriteTimeUtc - tab.DiskWriteTimeUtc).TotalSeconds) < 2.0;
        }

        /// <summary>
        /// True when the file's text is not the text we last loaded or saved.
        /// OneDrive mtime-only noise is restamped and returns false.
        /// </summary>
        private bool EngineDiskTextChanged(DocTab tab, string path, out string diskText, out string encodingName)
        {
            diskText = null;
            encodingName = null;
            if (!IsEngineDiskTab(tab) || string.IsNullOrEmpty(path)) return false;
            if (!File.Exists(path)) return false;
            FileInfo fi;
            try { fi = new FileInfo(path); }
            catch { return false; }
            if (DiskStampMatches(tab, fi)) return false;
            try
            {
                diskText = ReadTextFileDetect(path, out encodingName);
            }
            catch { return false; }
            if (ContentFingerprint(diskText ?? "") == tab.DiskFingerprint)
            {
                StampTabDisk(tab, path, diskText);
                return false;
            }
            return true;
        }

        private void Window_Activated(object sender, EventArgs e)
        {
            if (!_editorReady || _tabOpInProgress || _diskCheckBusy) return;
            CheckAllEngineTabsDisk();
        }

        /// <summary>
        /// Background dirty tabs only raise DiskConflict; the prompt waits until
        /// that tab is shown. Clean tabs reload without asking.
        /// </summary>
        private void CheckAllEngineTabsDisk()
        {
            if (_e2eMode || _diskCheckBusy) return;
            for (int i = 0; i < _tabs.Count; i++)
            {
                var tab = _tabs[i];
                if (!IsEngineDiskTab(tab)) continue;
                bool prompt = (i == _activeTabIndex);
                CheckEngineTabDisk(tab, prompt);
            }
        }

        private void CheckEngineTabDisk(DocTab tab, bool canPrompt)
        {
            if (_e2eMode || tab == null) return;
            if (_tabOpInProgress || _diskCheckBusy) return;
            if (!IsEngineDiskTab(tab)) return;
            if (DateTime.UtcNow < _ignoreDiskWatchUntil) return;

            string path = tab.FilePath;
            string diskText;
            string encodingName;
            if (!EngineDiskTextChanged(tab, path, out diskText, out encodingName))
            {
                tab.DiskConflict = false;
                return;
            }

            bool active = (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                && _tabs[_activeTabIndex] == tab);
            bool looksClean = !tab.IsDirty && !(active && _isDirty);

            // Host dirty flags lag the page (stats 150 ms; typing ping is best-effort).
            // Silent-reload of the active tab without a live pull can throw away a
            // keystroke if disk also changed in that window. Same reason close reads
            // getDocumentStateTagged instead of trusting the flag.
            if (looksClean && active)
            {
                _diskCheckBusy = true;
                try
                {
                    bool synced = SyncActiveTabFromEditor(allowStaleIfClean: false, timeoutMs: 3000);
                    if (!synced || tab.IsDirty || _isDirty)
                        looksClean = false;
                }
                finally { _diskCheckBusy = false; }
            }

            if (looksClean)
            {
                ReloadEngineTabFromDisk(tab, diskText, encodingName);
                return;
            }

            tab.DiskConflict = true;
            if (!canPrompt) return;
            PromptDiskNewer(tab, diskText, encodingName);
        }

        private void PromptDiskNewer(DocTab tab, string diskText, string encodingName)
        {
            if (tab == null || _e2eMode) return;
            _diskCheckBusy = true;
            try
            {
                var choice = WinForms.MessageBox.Show(
                    "This file has changed on disk.\n\n" +
                    Path.GetFileName(tab.FilePath) + "\n\n" +
                    "Yes = Reload from disk (discard your unsaved edits)\n" +
                    "No = Keep editing (Save will overwrite the disk copy)\n" +
                    "Cancel = Save your copy as a new file",
                    "File changed on disk",
                    WinForms.MessageBoxButtons.YesNoCancel,
                    WinForms.MessageBoxIcon.Warning,
                    WinForms.MessageBoxDefaultButton.Button2);
                if (choice == WinForms.DialogResult.Yes)
                    ReloadEngineTabFromDisk(tab, diskText, encodingName);
                else if (choice == WinForms.DialogResult.No)
                    StampTabDisk(tab, tab.FilePath, diskText); // accept; don't nag until another change
                else
                    SaveTabNow(tab, true);
            }
            finally
            {
                _diskCheckBusy = false;
                tab.DiskConflict = false;
            }
        }

        private void ReloadEngineTabFromDisk(DocTab tab, string diskText, string encodingName)
        {
            if (tab == null || string.IsNullOrEmpty(tab.FilePath) || !File.Exists(tab.FilePath))
                return;
            try
            {
                if (diskText == null)
                    diskText = ReadTextFileDetect(tab.FilePath, out encodingName);
                else if (string.IsNullOrEmpty(encodingName))
                    encodingName = tab.SourceEncoding ?? "UTF-8";
                tab.LineEnding = DetectLineEnding(diskText);
                tab.TrailingNewlines = DetectTrailingNewlines(diskText);
                tab.Content = (diskText ?? "").Replace("\r\n", "\n").TrimEnd('\n');
                tab.SourceEncoding = encodingName;
                tab.IsDirty = false;
                tab.Kind = DocKind.Engine;
                tab.NativeRole = NativeRole.None;
                StampTabDisk(tab, tab.FilePath, diskText);
                bool active = (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                    && _tabs[_activeTabIndex] == tab);
                if (active)
                {
                    _isDirty = false;
                    ApplyTabToEditor(tab);
                }
                else
                    RebuildTabStrip();
            }
            catch { }
        }

        private void QueueDiskPathCheck(string path)
        {
            if (_e2eMode || string.IsNullOrEmpty(path)) return;
            if (DateTime.UtcNow < _ignoreDiskWatchUntil) return;
            try { path = Path.GetFullPath(path); } catch { return; }
            _pendingDiskChecks.Add(path);
            if (_diskDebounceTimer == null)
            {
                _diskDebounceTimer = new DispatcherTimer
                {
                    Interval = TimeSpan.FromMilliseconds(400)
                };
                _diskDebounceTimer.Tick += (s, e) =>
                {
                    _diskDebounceTimer.Stop();
                    var pending = new List<string>(_pendingDiskChecks);
                    _pendingDiskChecks.Clear();
                    for (int i = 0; i < pending.Count; i++)
                    {
                        string p = pending[i];
                        for (int t = 0; t < _tabs.Count; t++)
                        {
                            var tab = _tabs[t];
                            if (!IsEngineDiskTab(tab)) continue;
                            if (!string.Equals(Path.GetFullPath(tab.FilePath), p, StringComparison.OrdinalIgnoreCase))
                                continue;
                            CheckEngineTabDisk(tab, t == _activeTabIndex);
                        }
                    }
                };
            }
            _diskDebounceTimer.Stop();
            _diskDebounceTimer.Start();
        }

        private void SyncDiskWatchers()
        {
            var want = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < _tabs.Count; i++)
            {
                var tab = _tabs[i];
                if (!IsEngineDiskTab(tab) || !File.Exists(tab.FilePath)) continue;
                try
                {
                    string dir = Path.GetDirectoryName(Path.GetFullPath(tab.FilePath));
                    if (!string.IsNullOrEmpty(dir)) want.Add(dir);
                }
                catch { }
            }
            var drop = new List<string>();
            foreach (var kv in _diskWatchers)
            {
                if (!want.Contains(kv.Key)) drop.Add(kv.Key);
            }
            for (int i = 0; i < drop.Count; i++)
            {
                try { _diskWatchers[drop[i]].Dispose(); } catch { }
                _diskWatchers.Remove(drop[i]);
            }
            foreach (string dir in want)
            {
                if (_diskWatchers.ContainsKey(dir)) continue;
                if (!Directory.Exists(dir)) continue;
                try
                {
                    var w = new FileSystemWatcher(dir);
                    w.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName;
                    w.IncludeSubdirectories = false;
                    FileSystemEventHandler onEvt = (s, e) =>
                    {
                        string full = e.FullPath;
                        try
                        {
                            Dispatcher.BeginInvoke(new Action(() => QueueDiskPathCheck(full)),
                                DispatcherPriority.Background);
                        }
                        catch { }
                    };
                    w.Changed += onEvt;
                    w.Created += onEvt;
                    w.Renamed += (s, e) =>
                    {
                        try
                        {
                            Dispatcher.BeginInvoke(new Action(() =>
                            {
                                QueueDiskPathCheck(e.FullPath);
                                QueueDiskPathCheck(e.OldFullPath);
                            }), DispatcherPriority.Background);
                        }
                        catch { }
                    };
                    w.EnableRaisingEvents = true;
                    _diskWatchers[dir] = w;
                }
                catch { }
            }
        }

        private void DisposeDiskWatchers()
        {
            try { if (_diskDebounceTimer != null) _diskDebounceTimer.Stop(); } catch { }
            foreach (var kv in _diskWatchers)
            {
                try { kv.Value.Dispose(); } catch { }
            }
            _diskWatchers.Clear();
            _pendingDiskChecks.Clear();
        }

        /// <summary>
        /// Snapshot open tabs for next launch (Notepad-style). Clean on-disk files store
        /// path only; dirty and untitled tabs store buffer bodies under session_bodies/.
        /// Bodies are written before the index and orphans are removed only after the
        /// index is committed — never wipe the body dir first (crash mid-persist used
        /// to lose every unsaved buffer).
        /// </summary>
        private void PersistTabSession()
        {
            if (_restoringTabs) return;
            // Privacy mode: the open documents are not written down, and any previous
            // index goes with them -- otherwise closing would leave the last ordinary
            // session on disk, looking current.
            if (SuppressDocumentTraces())
            {
                try { File.Delete(TabSessionPath()); } catch { }
                return;
            }
            try
            {
                EnsureAtLeastOneTab();
                string cache = CacheDir();
                if (!Directory.Exists(cache)) Directory.CreateDirectory(cache);
                string bodyDir = TabSessionBodiesDir();

                if (!_sessionRestoreContent)
                {
                    // Opted out: drop bodies after writing a path-only index.
                    int n0 = Math.Min(_tabs.Count, MaxSessionTabs);
                    int active0 = _activeTabIndex;
                    if (active0 < 0) active0 = 0;
                    if (active0 >= n0) active0 = Math.Max(0, n0 - 1);
                    var sb0 = new StringBuilder();
                    sb0.AppendLine("TZTABS1");
                    sb0.AppendLine("active=" + active0);
                    sb0.AppendLine("count=" + n0);
                    sb0.AppendLine();
                    for (int i = 0; i < n0; i++)
                    {
                        var tab = _tabs[i];
                        sb0.AppendLine("[tab " + i + "]");
                        sb0.AppendLine("path=" + (tab.FilePath ?? ""));
                        sb0.AppendLine("dirty=" + (tab.IsDirty ? "1" : "0"));
                        sb0.AppendLine("kind=" + DocKindToken(tab));
                        sb0.AppendLine("le=" + ((tab.LineEnding == "\r\n") ? "crlf" : "lf"));
                        sb0.AppendLine("trail=" + EncodeTrailToken(tab.TrailingNewlines ?? ""));
                        sb0.AppendLine("resume=" + tab.ResumeBlock);
                        sb0.AppendLine("cols=" + tab.Columns);
                        sb0.AppendLine("mode=" + (tab.ViewMode ?? ""));
                        sb0.AppendLine("body=");
                        sb0.AppendLine();
                    }
                    WriteStateFileAtomic(TabSessionPath(), sb0.ToString());
                    if (Directory.Exists(bodyDir))
                    {
                        try
                        {
                            foreach (string f in Directory.GetFiles(bodyDir))
                                try { File.Delete(f); } catch { }
                            Directory.Delete(bodyDir);
                        }
                        catch { }
                    }
                    return;
                }

                Directory.CreateDirectory(bodyDir);

                int n = Math.Min(_tabs.Count, MaxSessionTabs);
                int active = _activeTabIndex;
                if (active < 0) active = 0;
                if (active >= n) active = n - 1;

                var keepBodies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var sb = new StringBuilder();
                sb.AppendLine("TZTABS1");
                sb.AppendLine("active=" + active);
                sb.AppendLine("count=" + n);
                sb.AppendLine();

                for (int i = 0; i < n; i++)
                {
                    var tab = _tabs[i];
                    string path = tab.FilePath ?? "";
                    bool dirty = tab.IsDirty;
                    bool needBody = dirty || string.IsNullOrEmpty(path) || !File.Exists(path);
                    string le = (tab.LineEnding == "\r\n") ? "crlf" : "lf";
                    string trail = EncodeTrailToken(tab.TrailingNewlines ?? "");

                    sb.AppendLine("[tab " + i + "]");
                    sb.AppendLine("path=" + path);
                    sb.AppendLine("dirty=" + (dirty ? "1" : "0"));
                    sb.AppendLine("kind=" + DocKindToken(tab));
                    sb.AppendLine("le=" + le);
                    sb.AppendLine("trail=" + trail);
                    sb.AppendLine("resume=" + tab.ResumeBlock);
                    sb.AppendLine("cols=" + tab.Columns);
                    sb.AppendLine("mode=" + (tab.ViewMode ?? ""));
                    // Native / book: never store body (not engine text).
                    if (IsReadOnlyTab(tab)) needBody = false;
                    if (needBody)
                    {
                        string bodyName = "t" + i + ".md";
                        string bodyPath = Path.Combine(bodyDir, bodyName);
                        string tmpBody = bodyPath + ".new";
                        File.WriteAllText(tmpBody, tab.Content ?? "", new UTF8Encoding(false));
                        try
                        {
                            if (File.Exists(bodyPath))
                            {
                                try { File.Replace(tmpBody, bodyPath, null); }
                                catch
                                {
                                    try { File.Delete(bodyPath); } catch { }
                                    File.Move(tmpBody, bodyPath);
                                }
                            }
                            else File.Move(tmpBody, bodyPath);
                        }
                        catch
                        {
                            try { if (File.Exists(tmpBody)) File.Move(tmpBody, bodyPath); } catch { }
                        }
                        keepBodies.Add(bodyName);
                        sb.AppendLine("body=" + bodyName);
                    }
                    else
                    {
                        sb.AppendLine("body=");
                    }
                    sb.AppendLine();
                }

                // Index last: crash before this leaves previous index + old bodies intact.
                WriteStateFileAtomic(TabSessionPath(), sb.ToString());

                // Orphans only after a successful index write.
                try
                {
                    foreach (string f in Directory.GetFiles(bodyDir))
                    {
                        string name = Path.GetFileName(f);
                        if (name != null && name.EndsWith(".new", StringComparison.OrdinalIgnoreCase))
                        {
                            try { File.Delete(f); } catch { }
                            continue;
                        }
                        if (name != null && !keepBodies.Contains(name))
                        {
                            try { File.Delete(f); } catch { }
                        }
                    }
                }
                catch { }
            }
            catch { }
        }

        private static string EncodeTrailToken(string trailing)
        {
            if (string.IsNullOrEmpty(trailing)) return "none";
            if (trailing == "\n") return "lf";
            if (trailing == "\r\n") return "crlf";
            if (trailing == "\n\n") return "lf2";
            // Fallback: length of trailing newlines only
            return "n" + trailing.Length;
        }

        private static string DecodeTrailToken(string token)
        {
            if (string.IsNullOrEmpty(token) || token == "none") return "";
            if (token == "lf") return "\n";
            if (token == "crlf") return "\r\n";
            if (token == "lf2") return "\n\n";
            if (token.Length > 1 && token[0] == 'n')
            {
                int n;
                if (int.TryParse(token.Substring(1), out n) && n > 0 && n < 20)
                    return new string('\n', n);
            }
            return "\n";
        }

        /// <summary>
        /// Rebuild _tabs from the last session file. Returns true if at least one tab
        /// was restored (caller should not also open lastFilePath alone).
        /// </summary>
        private bool TryRestoreTabSession()
        {
            try
            {
                string path = TabSessionPath();
                if (!File.Exists(path)) return false;
                string text = File.ReadAllText(path, Encoding.UTF8);
                if (string.IsNullOrEmpty(text) || !text.StartsWith("TZTABS1")) return false;

                string bodyDir = TabSessionBodiesDir();
                int active = 0;
                int count = 0;
                var lines = text.Replace("\r\n", "\n").Split('\n');
                for (int i = 0; i < lines.Length; i++)
                {
                    string line = lines[i].TrimEnd();
                    if (line.StartsWith("active=")) int.TryParse(line.Substring(7), out active);
                    else if (line.StartsWith("count=")) int.TryParse(line.Substring(6), out count);
                }
                if (count <= 0) return false;
                if (count > MaxSessionTabs) count = MaxSessionTabs;

                var restored = new List<DocTab>();
                for (int t = 0; t < count; t++)
                {
                    string prefix = "[tab " + t + "]";
                    int start = -1;
                    for (int i = 0; i < lines.Length; i++)
                    {
                        if (lines[i].Trim() == prefix) { start = i + 1; break; }
                    }
                    if (start < 0) continue;

                    string tabPath = "";
                    bool dirty = false;
                    string le = "lf";
                    string trailTok = "lf";
                    string bodyName = "";
                    string kindTok = "";
                    string modeTok = "";
                    int resumeBlock = 0;
                    int cols = 0;
                    for (int i = start; i < lines.Length; i++)
                    {
                        string line = lines[i].TrimEnd();
                        if (line.StartsWith("[tab ")) break;
                        if (line.StartsWith("path=")) tabPath = line.Substring(5);
                        else if (line.StartsWith("dirty=")) dirty = line.Substring(6) == "1";
                        else if (line.StartsWith("kind=")) kindTok = line.Substring(5);
                        else if (line.StartsWith("le=")) le = line.Substring(3);
                        else if (line.StartsWith("trail=")) trailTok = line.Substring(6);
                        else if (line.StartsWith("resume=")) int.TryParse(line.Substring(7), out resumeBlock);
                        else if (line.StartsWith("cols=")) int.TryParse(line.Substring(5), out cols);
                        else if (line.StartsWith("mode=")) modeTok = line.Substring(5).Trim();
                        else if (line.StartsWith("body=")) bodyName = line.Substring(5);
                    }

                    var tab = new DocTab
                    {
                        Id = _nextTabId++,
                        FilePath = string.IsNullOrWhiteSpace(tabPath) ? null : tabPath,
                        LineEnding = (le == "crlf") ? "\r\n" : "\n",
                        TrailingNewlines = DecodeTrailToken(trailTok),
                        IsDirty = dirty,
                        ResumeBlock = resumeBlock,
                        // A session written before this field existed says nothing, which is
                        // 0 and means "no choice recorded" -- not "one column".
                        Columns = (cols == 2) ? 2 : (cols == 1 ? 1 : 0),
                        ViewMode = NormalizeTabViewMode(modeTok)
                    };
                    ApplyDocKindFromSession(tab, kindTok);

                    // Book / native: path only — never ReadTextFileDetect (binary).
                    //
                    // HTML is path-classified as Native (default open = rendered page), but a
                    // session can still record kind=engine when the user was in Mode → Source
                    // (markup). Honor that so restore reloads markup as editor Source rather
                    // than forcing Native and leaving Mode chrome wrong.
                    bool sessionEngine = string.Equals(kindTok, "engine", StringComparison.OrdinalIgnoreCase);
                    bool pathBook = !string.IsNullOrEmpty(tab.FilePath)
                        && tab.FilePath.EndsWith(".epub", StringComparison.OrdinalIgnoreCase);
                    bool pathNativeDefault = !sessionEngine
                        && !pathBook
                        && ClassifyDocKind(tab.FilePath) != DocKind.Engine;
                    if (pathBook || pathNativeDefault || tab.Kind == DocKind.Book
                        || (tab.Kind == DocKind.Native && !sessionEngine))
                    {
                        if (string.IsNullOrEmpty(tab.FilePath) || !File.Exists(tab.FilePath))
                            continue;
                        if (sessionEngine && IsHtmlPath(tab.FilePath))
                        {
                            tab.Kind = DocKind.Engine;
                            tab.NativeRole = NativeRole.None;
                        }
                        else
                        {
                            tab.Kind = pathBook ? DocKind.Book : ClassifyDocKind(tab.FilePath);
                            tab.NativeRole = pathBook ? NativeRole.None : ClassifyNativeRole(tab.FilePath);
                            tab.Content = "";
                            tab.IsDirty = false;
                            restored.Add(tab);
                            continue;
                        }
                    }
                    else if (sessionEngine)
                    {
                        tab.Kind = DocKind.Engine;
                        tab.NativeRole = NativeRole.None;
                    }

                    string body = null;
                    if (!string.IsNullOrEmpty(bodyName))
                    {
                        string bodyPath = Path.Combine(bodyDir, bodyName);
                        if (File.Exists(bodyPath))
                        {
                            try { body = File.ReadAllText(bodyPath, Encoding.UTF8); }
                            catch { body = null; }
                        }
                    }

                    if (body != null)
                    {
                        tab.Content = body.Replace("\r\n", "\n");
                        // Untitled with body, or dirty path with body
                        if (string.IsNullOrEmpty(tab.FilePath))
                            tab.IsDirty = true; // unsaved buffer
                        else if (!File.Exists(tab.FilePath))
                        {
                            // Path gone — keep buffer as untitled so work is not lost
                            tab.FilePath = null;
                            tab.IsDirty = true;
                        }
                        else
                            StampTabDiskFromPath(tab, tab.FilePath);
                    }
                    else if (!string.IsNullOrEmpty(tab.FilePath) && File.Exists(tab.FilePath))
                    {
                        try
                        {
                            string enc;
                            string content = ReadTextFileDetect(tab.FilePath, out enc);
                            tab.LineEnding = DetectLineEnding(content);
                            tab.TrailingNewlines = DetectTrailingNewlines(content);
                            tab.Content = content.Replace("\r\n", "\n").TrimEnd('\n');
                            tab.SourceEncoding = enc;
                            tab.IsDirty = false;
                            StampTabDisk(tab, tab.FilePath, content);
                        }
                        catch
                        {
                            continue; // skip unreadable file
                        }
                    }
                    else
                    {
                        // No body and no readable file — skip empty junk unless sole tab later
                        if (string.IsNullOrEmpty(tab.FilePath))
                        {
                            tab.Content = "";
                            tab.IsDirty = false;
                        }
                        else
                            continue;
                    }

                    restored.Add(tab);
                }

                if (restored.Count == 0) return false;

                _tabs.Clear();
                for (int i = 0; i < restored.Count; i++)
                    _tabs.Add(restored[i]);
                if (active < 0) active = 0;
                if (active >= _tabs.Count) active = _tabs.Count - 1;
                _activeTabIndex = active;
                ApplyTabToEditor(_tabs[_activeTabIndex]);
                try { SyncDiskWatchers(); } catch { }
                return true;
            }
            catch
            {
                return false;
            }
        }

        private void CloseActiveTab()
        {
            EnsureAtLeastOneTab();
            CloseTabAt(_activeTabIndex);
        }

        private void CycleTab(int delta)
        {
            EnsureAtLeastOneTab();
            if (_tabs.Count <= 1) return;
            int n = _tabs.Count;
            int next = (_activeTabIndex + delta) % n;
            if (next < 0) next += n;
            SwitchToTab(next);
        }

        private string RecentFilesPath()
        {
            return Path.Combine(CacheDir(), "recent_files.json");
        }

        /// <summary>
        /// Undo JSON string escaping in ONE pass. Chained String.Replace calls cannot do
        /// this: unescaping \\ first turns "C:\\tests" into "C:\tests", and the next call
        /// -- looking for a literal backslash-t -- then eats the real folder name and
        /// leaves a TAB character. That is why the recent list held unopenable duplicates
        /// of every path under a folder starting with t, n, r or b.
        /// </summary>
        private static string JsonUnescape(string s)
        {
            if (string.IsNullOrEmpty(s) || s.IndexOf('\\') < 0) return s;
            var sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c != '\\' || i + 1 >= s.Length) { sb.Append(c); continue; }
                char n = s[++i];
                switch (n)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case '/': sb.Append('/'); break;
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case 'u':
                        int cp;
                        if (i + 4 < s.Length && int.TryParse(s.Substring(i + 1, 4),
                                System.Globalization.NumberStyles.HexNumber,
                                System.Globalization.CultureInfo.InvariantCulture, out cp))
                        { sb.Append((char)cp); i += 4; }
                        else sb.Append(n);
                        break;
                    default: sb.Append(n); break;
                }
            }
            return sb.ToString();
        }

        private void LoadRecentFiles()
        {
            _recentFiles.Clear();
            try
            {
                string path = RecentFilesPath();
                if (!File.Exists(path)) return;
                string json = File.ReadAllText(path, Encoding.UTF8);
                // Simple ["path1","path2"] parser — no nested objects
                foreach (Match m in Regex.Matches(json, @"\""((?:\\.|[^\""])*)\"""))
                {
                    string p = JsonUnescape(m.Groups[1].Value);
                    if (string.IsNullOrWhiteSpace(p)) continue;
                    try { p = Path.GetFullPath(p); } catch { }
                    bool dup = false;
                    for (int i = 0; i < _recentFiles.Count; i++)
                    {
                        if (string.Equals(_recentFiles[i], p, StringComparison.OrdinalIgnoreCase))
                        { dup = true; break; }
                    }
                    if (!dup) _recentFiles.Add(p);
                    if (_recentFiles.Count >= MaxRecentFiles) break;
                }
            }
            catch { }
        }

        private void SaveRecentFiles()
        {
            try
            {
                string cacheDir = CacheDir();
                if (!Directory.Exists(cacheDir)) Directory.CreateDirectory(cacheDir);
                var sb = new StringBuilder();
                sb.Append('[');
                for (int i = 0; i < _recentFiles.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    string p = _recentFiles[i] ?? "";
                    p = p.Replace("\\", "\\\\").Replace("\"", "\\\"");
                    sb.Append('"').Append(p).Append('"');
                }
                sb.Append(']');
                WriteStateFileAtomic(RecentFilesPath(), sb.ToString());
            }
            catch { }
        }

        /// <summary>
        /// Keep unsaved buffers across restarts, or don't. Off means session_bodies\ is
        /// never written; you still get the save prompt for every dirty tab on close.
        /// </summary>
        private void SetSessionRestoreContent(bool on)
        {
            _sessionRestoreContent = on;
            SetMenuChecked("mSessionRestoreContent", on);
            // The page keeps its own copy in localStorage, which the host never touches.
            SendMsg(on ? "cmd:persist_content_on" : "cmd:persist_content_off");
            if (!on)
            {
                // Take effect now rather than at next save — turning it off should mean
                // the text is gone, not gone eventually.
                try
                {
                    string bodyDir = TabSessionBodiesDir();
                    if (Directory.Exists(bodyDir))
                    {
                        foreach (string f in Directory.GetFiles(bodyDir))
                            try { File.Delete(f); } catch { }
                        try { Directory.Delete(bodyDir); } catch { }
                    }
                }
                catch { }
            }
            SaveWindowState();
        }

        /// <summary>Record which files were opened, or don't. Off wipes the list too.</summary>
        private void SetRecentFilesEnabled(bool on)
        {
            _recentFilesEnabled = on;
            SetMenuChecked("mRecentEnabled", on);
            if (!on)
            {
                _recentFiles.Clear();
                try { File.Delete(RecentFilesPath()); } catch { }
                RebuildRecentFilesMenu();
            }
            SaveWindowState();
        }

        /// <summary>
        /// Delete everything TypoZen has stored about your documents. Your documents
        /// themselves are never touched — only the cache folder.
        /// </summary>
        private void ClearStoredData()
        {
            var res = WinForms.MessageBox.Show(
                "Delete TypoZen's stored data?\n\n" +
                "This removes:\n" +
                "  • unsaved text kept for session restore\n" +
                "  • the list of open tabs\n" +
                "  • the recent files list\n" +
                "  • recent Search queries\n" +
                "  • pasted images held in the cache\n" +
                "  • saved web storage (cleared on next launch)\n\n" +
                "Your documents are not touched. Only " + CacheDir() + " is affected.",
                "Clear Stored Data",
                WinForms.MessageBoxButtons.OKCancel,
                WinForms.MessageBoxIcon.Warning);
            if (res != WinForms.DialogResult.OK) return;

            string cache = CacheDir();
            try
            {
                string bodyDir = TabSessionBodiesDir();
                if (Directory.Exists(bodyDir))
                {
                    foreach (string f in Directory.GetFiles(bodyDir)) try { File.Delete(f); } catch { }
                    try { Directory.Delete(bodyDir); } catch { }
                }
            }
            catch { }
            try { File.Delete(TabSessionPath()); } catch { }
            try { File.Delete(RecentFilesPath()); } catch { }
            _recentFiles.Clear();
            RebuildRecentFilesMenu();

            // Pasted images that were never written beside a document.
            try
            {
                string assets = Path.Combine(cache, "assets");
                if (Directory.Exists(assets))
                {
                    foreach (string f in Directory.GetFiles(assets)) try { File.Delete(f); } catch { }
                }
            }
            catch { }

            // Blank document scratch fields and recent searches; keep theme/mode.
            try
            {
                var prefs = LoadHostPrefs();
                prefs.LastFilePath = "";
                prefs.LastContent = "";
                prefs.SearchHistory = new List<string>();
                prefs.LastSearchQuery = "";
                prefs.FindMatchCase = false;
                prefs.FindWholeWord = false;
                WriteHostPrefs(prefs);
            }
            catch { }

            // The WebView2 profile holds localStorage in a LevelDB, which keeps superseded
            // values on disk until it feels like compacting. It is locked while the browser
            // is running, so flag it and delete the store at next launch instead.
            try { File.WriteAllText(Path.Combine(cache, "purge_webstorage.flag"), "1"); } catch { }
            try { SendMsg("cmd:clear_local_storage"); } catch { }

            WinForms.MessageBox.Show(
                "Stored data cleared.\n\nSaved web storage is removed the next time TypoZen starts.",
                "Clear Stored Data", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
        }

        /// <summary>
        /// Runs before WebView2 exists, because the LevelDB is locked once it does.
        /// </summary>
        private void PurgePendingWebStorage()
        {
            try
            {
                string cache = CacheDir();
                string flag = Path.Combine(cache, "purge_webstorage.flag");
                if (!File.Exists(flag)) return;
                string store = Path.Combine(cache, "EBWebView", "Default", "Local Storage");
                if (Directory.Exists(store))
                {
                    try { Directory.Delete(store, true); } catch { }
                }
                // Only once the store is actually gone. Clear Stored Data tells the reader
                // "saved web storage is removed the next time TypoZen starts", and the
                // delete above can fail -- the profile is locked by a still-closing
                // browser process, or a file is held. Dropping the flag anyway retired a
                // promise that was never kept, silently, and nothing would retry it.
                // Keeping it means the next launch tries again, which is the whole point
                // of deferring the delete to startup.
                if (!Directory.Exists(store)) File.Delete(flag);
            }
            catch { }
        }

        /// <summary>Push a path to the top of Open Recent (MRU). Missing files stay listed until opened.</summary>
        private void AddRecentFile(string path)
        {
            if (SuppressDocumentTraces()) return;
            if (!_recentFilesEnabled) return;
            if (string.IsNullOrWhiteSpace(path)) return;
            try { path = Path.GetFullPath(path); } catch { return; }
            for (int i = _recentFiles.Count - 1; i >= 0; i--)
            {
                if (string.Equals(_recentFiles[i], path, StringComparison.OrdinalIgnoreCase))
                    _recentFiles.RemoveAt(i);
            }
            _recentFiles.Insert(0, path);
            while (_recentFiles.Count > MaxRecentFiles)
                _recentFiles.RemoveAt(_recentFiles.Count - 1);
            SaveRecentFiles();
            RebuildRecentFilesMenu();
        }

        private void RebuildRecentFilesMenu()
        {
            if (_mRecentMenu == null) return;
            _mRecentMenu.Items.Clear();
            if (_recentFiles.Count == 0)
            {
                _mRecentMenu.Items.Add(new MenuItem { Header = "(none)", IsEnabled = false });
                return;
            }
            for (int i = 0; i < _recentFiles.Count; i++)
            {
                string full = _recentFiles[i];
                string header = full;
                try
                {
                    // Prefer "folder\file.md" so near-identical names are distinguishable
                    string dir = Path.GetDirectoryName(full);
                    string name = Path.GetFileName(full);
                    if (!string.IsNullOrEmpty(dir) && !string.IsNullOrEmpty(name))
                    {
                        string leaf = Path.GetFileName(dir);
                        header = string.IsNullOrEmpty(leaf) ? name : (leaf + "\\" + name);
                    }
                }
                catch { }
                if (i < 9) header = "_" + (i + 1) + "  " + header;
                else header = "   " + header;

                var item = new MenuItem
                {
                    Header = header,
                    ToolTip = full,
                    Tag = full
                };
                string openPath = full;
                item.Click += (s, e) =>
                {
                    if (!File.Exists(openPath))
                    {
                        WinForms.MessageBox.Show(
                            "This file no longer exists:\n" + openPath,
                            "Open Recent",
                            WinForms.MessageBoxButtons.OK,
                            WinForms.MessageBoxIcon.Information);
                        // Drop missing entry
                        for (int j = _recentFiles.Count - 1; j >= 0; j--)
                        {
                            if (string.Equals(_recentFiles[j], openPath, StringComparison.OrdinalIgnoreCase))
                                _recentFiles.RemoveAt(j);
                        }
                        SaveRecentFiles();
                        RebuildRecentFilesMenu();
                        return;
                    }
                    LoadFileFromPath(openPath);
                };
                _mRecentMenu.Items.Add(item);
            }
            _mRecentMenu.Items.Add(new Separator());
            var clearItem = new MenuItem { Header = "_Clear recent list" };
            clearItem.Click += (s, e) =>
            {
                _recentFiles.Clear();
                SaveRecentFiles();
                RebuildRecentFilesMenu();
            };
            _mRecentMenu.Items.Add(clearItem);
        }

        private void SaveWindowState()
        {
            try
            {
                if (this.WindowStyle == WindowStyle.None) return; // Do not overwrite state with fullscreen dimensions

                // Fold the live size into the slot for the column count currently showing,
                // so quitting saves it as well as switching layouts does.
                CaptureColumnRect();

                string cacheDir = CacheDir();
                if (!Directory.Exists(cacheDir)) Directory.CreateDirectory(cacheDir);
                string path = Path.Combine(cacheDir, "window_state.json");
                
                string stateStr = "Normal";
                double w = this.Width;
                double h = this.Height;
                double l = this.Left;
                double t = this.Top;

                if (this.WindowState == WindowState.Maximized)
                {
                    stateStr = "Maximized";
                    w = this.RestoreBounds.Width;
                    h = this.RestoreBounds.Height;
                    l = this.RestoreBounds.Left;
                    t = this.RestoreBounds.Top;
                }

                string json = string.Format(System.Globalization.CultureInfo.InvariantCulture,
                    "{{\"state\":\"{0}\",\"width\":{1},\"height\":{2},\"left\":{3},\"top\":{4},\"zoom\":{5}," +
                    "\"chrome\":\"{6}\",\"wordWrap\":{7},\"statusBar\":{8}," +
                    "\"scrubber\":{21},\"lineSpacing\":{22},\"paraSpacing\":{23}," +
                    "\"justified\":{24},\"sidebarAutoHide\":{25},\"autosave\":{26},\"privacyMode\":{27}," +
                    "\"blockHover\":{28},\"fontType\":{29},\"fontFamily\":\"{30}\",\"fontSize\":{31}," +
                    "\"sessionBodies\":{9},\"recentFiles\":{10},\"encodingWarn\":{11}," +
                    "\"isTwoCol\":{12},\"w2\":{13},\"h2\":{14},\"l2\":{15},\"t2\":{16}," +
                    "\"w1\":{17},\"h1\":{18},\"l1\":{19},\"t1\":{20}}}",
                    stateStr, w, h, l, t, _zoomFactor,
                    _chromeAutoHide ? "auto" : "always", _wordWrap ? "true" : "false", _statusBarVisible ? "true" : "false",
                    _sessionRestoreContent ? "true" : "false", _recentFilesEnabled ? "true" : "false",
                    _encodingWarnDisabled ? "false" : "true",
                    _isTwoColumnMode ? "true" : "false",
                    _col2Rect.HasValue ? _col2Rect.Value.Width : 0, _col2Rect.HasValue ? _col2Rect.Value.Height : 0, _col2Rect.HasValue ? _col2Rect.Value.Left : 0, _col2Rect.HasValue ? _col2Rect.Value.Top : 0,
                    _col1Rect.HasValue ? _col1Rect.Value.Width : 0, _col1Rect.HasValue ? _col1Rect.Value.Height : 0, _col1Rect.HasValue ? _col1Rect.Value.Left : 0, _col1Rect.HasValue ? _col1Rect.Value.Top : 0,
                    _scrubberVisible ? "true" : "false", _lineSpacing, _paraSpacing,
                    _justified ? "true" : "false", _sidebarAutoHide ? "true" : "false",
                    _autosave ? "true" : "false", _privacyMode ? "true" : "false",
                    _blockHover, _fontType, _customFontFamily.Replace("\"", "\\\""), _fontSize);

                WriteStateFileAtomic(path, json);
            }
            catch {}
        }

        private void RestoreWindowState()
        {
            try
            {
                string path = WindowStatePath();
                if (!File.Exists(path)) return;

                string json = File.ReadAllText(path, Encoding.UTF8);
                var mState = Regex.Match(json, @"\""state\""\s*:\s*\""([^\""]+)\""");
                var mW = Regex.Match(json, @"\""width\""\s*:\s*([\d\.]+)");
                var mH = Regex.Match(json, @"\""height\""\s*:\s*([\d\.]+)");
                var mL = Regex.Match(json, @"\""left\""\s*:\s*([\d\.\-]+)");
                var mT = Regex.Match(json, @"\""top\""\s*:\s*([\d\.\-]+)");
                var mZ = Regex.Match(json, @"\""zoom\""\s*:\s*([\d\.]+)");
                var mEncWarn = Regex.Match(json, @"\""encodingWarn\""\s*:\s*(true|false)");
                
                var mIsTwo = Regex.Match(json, @"\""isTwoCol\""\s*:\s*(true|false)");
                if (mIsTwo.Success) _isTwoColumnMode = (mIsTwo.Groups[1].Value == "true");

                var mw2 = Regex.Match(json, @"\""w2\""\s*:\s*([\d\.\-]+)");
                var mh2 = Regex.Match(json, @"\""h2\""\s*:\s*([\d\.\-]+)");
                var ml2 = Regex.Match(json, @"\""l2\""\s*:\s*([\d\.\-]+)");
                var mt2 = Regex.Match(json, @"\""t2\""\s*:\s*([\d\.\-]+)");
                if (mw2.Success && mh2.Success && ml2.Success && mt2.Success) {
                    double w2, h2, l2, t2;
                    if (double.TryParse(mw2.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out w2) && w2 > 0) {
                        double.TryParse(mh2.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out h2);
                        double.TryParse(ml2.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out l2);
                        double.TryParse(mt2.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out t2);
                        _col2Rect = new Rect(l2, t2, w2, h2);
                    }
                }

                var mw1 = Regex.Match(json, @"\""w1\""\s*:\s*([\d\.\-]+)");
                var mh1 = Regex.Match(json, @"\""h1\""\s*:\s*([\d\.\-]+)");
                var ml1 = Regex.Match(json, @"\""l1\""\s*:\s*([\d\.\-]+)");
                var mt1 = Regex.Match(json, @"\""t1\""\s*:\s*([\d\.\-]+)");
                if (mw1.Success && mh1.Success && ml1.Success && mt1.Success) {
                    double w1, h1, l1, t1;
                    if (double.TryParse(mw1.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out w1) && w1 > 0) {
                        double.TryParse(mh1.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out h1);
                        double.TryParse(ml1.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out l1);
                        double.TryParse(mt1.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out t1);
                        _col1Rect = new Rect(l1, t1, w1, h1);
                    }
                }
                // encodingWarn:true = show warnings (default). false = user opted out.
                if (mEncWarn.Success) _encodingWarnDisabled = (mEncWarn.Groups[1].Value == "false");

                if (mW.Success && mH.Success)
                {
                    double w, h;
                    if (double.TryParse(mW.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out w) &&
                        double.TryParse(mH.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out h))
                    {
                        if (w >= 300 && h >= 200)
                        {
                            this.Width = w;
                            this.Height = h;
                        }
                    }
                }

                if (mL.Success && mT.Success)
                {
                    double l, t;
                    if (double.TryParse(mL.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out l) &&
                        double.TryParse(mT.Groups[1].Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out t))
                    {
                        if (l >= SystemParameters.VirtualScreenLeft - 100 &&
                            t >= SystemParameters.VirtualScreenTop - 100 &&
                            l < SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth - 100 &&
                            t < SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight - 100)
                        {
                            this.WindowStartupLocation = WindowStartupLocation.Manual;
                            this.Left = l;
                            this.Top = t;
                        }
                    }
                }

                if (mState.Success && mState.Groups[1].Value == "Maximized")
                {
                    this.WindowState = WindowState.Maximized;
                }

                if (mZ.Success)
                {
                    double z;
                    if (double.TryParse(mZ.Groups[1].Value, System.Globalization.NumberStyles.Any,
                        System.Globalization.CultureInfo.InvariantCulture, out z))
                    {
                        _zoomFactor = ClampZoom(z);
                    }
                }

                // Deliberately outside the zoom block: these used to be nested inside it,
                // so a state file without a zoom entry silently dropped every view setting.
                var mChrome = Regex.Match(json, @"\""chrome\""\s*:\s*\""(\w+)\""");
                if (mChrome.Success)
                {
                    string cm = mChrome.Groups[1].Value;
                    _chromeAutoHide = (cm == "auto" || cm == "typing");
                }
                var mWrap = Regex.Match(json, @"\""wordWrap\""\s*:\s*(true|false)");
                if (mWrap.Success) _wordWrap = mWrap.Groups[1].Value == "true";
                var mSb = Regex.Match(json, @"\""statusBar\""\s*:\s*(true|false)");
                if (mSb.Success) _statusBarVisible = mSb.Groups[1].Value == "true";
                var mScrub = Regex.Match(json, @"\""scrubber\""\s*:\s*(true|false)");
                if (mScrub.Success) _scrubberVisible = mScrub.Groups[1].Value == "true";
                var mLine = Regex.Match(json, @"\""lineSpacing\""\s*:\s*(\d+)");
                if (mLine.Success) _lineSpacing = Clamp4(int.Parse(mLine.Groups[1].Value));
                var mPara = Regex.Match(json, @"\""paraSpacing\""\s*:\s*(\d+)");
                if (mPara.Success) _paraSpacing = Clamp4(int.Parse(mPara.Groups[1].Value));
                var mHover = Regex.Match(json, @"\""blockHover\""\s*:\s*(\d+)");
                if (mHover.Success) _blockHover = ClampBlockHover(int.Parse(mHover.Groups[1].Value));
                var mFT = Regex.Match(json, @"\""fontType\""\s*:\s*(\d+)");
                if (mFT.Success) _fontType = Math.Max(0, Math.Min(3, int.Parse(mFT.Groups[1].Value)));
                var mFF = Regex.Match(json, @"\""fontFamily\""\s*:\s*\""([^\""]*)\""");
                if (mFF.Success) _customFontFamily = mFF.Groups[1].Value;
                var mFS = Regex.Match(json, @"\""fontSize\""\s*:\s*(\d+)");
                if (mFS.Success) _fontSize = Math.Max(0, Math.Min(4, int.Parse(mFS.Groups[1].Value)));
                var mJust = Regex.Match(json, @"\""justified\""\s*:\s*(true|false)");
                if (mJust.Success) _justified = mJust.Groups[1].Value == "true";
                var mSideAuto = Regex.Match(json, @"\""sidebarAutoHide\""\s*:\s*(true|false)");
                var mAuto = Regex.Match(json, @"\""autosave\""\s*:\s*(true|false)");
                if (mAuto.Success) _autosave = mAuto.Groups[1].Value == "true";
                var mPriv = Regex.Match(json, @"\""privacyMode\""\s*:\s*(true|false)");
                if (mPriv.Success) _privacyMode = mPriv.Groups[1].Value == "true";
                if (mSideAuto.Success) _sidebarAutoHide = mSideAuto.Groups[1].Value == "true";
                var mBodies = Regex.Match(json, @"\""sessionBodies\""\s*:\s*(true|false)");
                if (mBodies.Success) _sessionRestoreContent = mBodies.Groups[1].Value == "true";
                var mRecent = Regex.Match(json, @"\""recentFiles\""\s*:\s*(true|false)");
                if (mRecent.Success) _recentFilesEnabled = mRecent.Groups[1].Value == "true";
            }
            catch {}
        }

        private static double ClampZoom(double z)
        {
            if (z < ZoomMin) return ZoomMin;
            if (z > ZoomMax) return ZoomMax;
            // Snap to one decimal so 1.0000001 from float noise stays clean
            return Math.Round(z, 2);
        }

        private void ZoomBy(double delta)
        {
            // Prefer live control value so we step from native Ctrl+wheel zoom too
            double current = _zoomFactor;
            try
            {
                if (_webView != null && _webView.CoreWebView2 != null)
                    current = _webView.ZoomFactor;
            }
            catch { }
            SetZoom(current + delta);
        }

        private void SetZoom(double factor)
        {
            _zoomFactor = ClampZoom(factor);
            _zoomApplying = true;
            try
            {
                ApplyZoomToWebView();
                UpdateZoomLabel();
            }
            finally { _zoomApplying = false; }
            // Persist without waiting for close — matches "remember my zoom". Coalesced
            // because zoom arrives one notch at a time; see SaveWindowStateDebounced.
            SaveWindowStateDebounced();
        }

        private DispatcherTimer _windowStateSaveTimer;

        /// <summary>
        /// Fold a burst of window-state writes into one, a beat after the last change.
        /// </summary>
        /// <remarks>
        /// The state file is small but the write is not free: it is a create-temp,
        /// write, File.Replace sequence on the UI thread, measured at ~3.7 ms. Zoom
        /// arrives one wheel notch at a time and every notch used to pay it, so a single
        /// Ctrl+wheel gesture across twenty notches spent ~75 ms writing twenty copies of
        /// a file that only the last one describes. Nothing waits for the close -- the
        /// point of writing zoom eagerly -- it just stops writing once per notch. Closing
        /// calls SaveWindowState directly, so a pending coalesce cannot be lost.
        /// </remarks>
        private void SaveWindowStateDebounced()
        {
            if (_windowStateSaveTimer == null)
            {
                _windowStateSaveTimer = new DispatcherTimer
                {
                    Interval = TimeSpan.FromMilliseconds(400)
                };
                _windowStateSaveTimer.Tick += (s, e) =>
                {
                    _windowStateSaveTimer.Stop();
                    try { SaveWindowState(); } catch { }
                };
            }
            _windowStateSaveTimer.Stop();
            _windowStateSaveTimer.Start();
        }

        /// <summary>
        /// Wire one segment of a segmented control. The click only reports what was
        /// pressed; the page's resolveViewState decides what the new state is and echoes
        /// it back on view_state:, so the rules live in exactly one place.
        /// </summary>
        private void BindSegment(string name, string selector, string value)
        {
            var b = FindElement(name) as Button;
            if (b == null) return;
            _segments[name] = b;
            b.Click += (s, e) =>
            {
                // HTML: rendered native page by default; Source mode is how you see markup
                // (same Mode control as Markdown — no separate "View Source" command).
                if (selector == "mode" && HandleHtmlModeSegmentClick(value))
                    return;
                // Intentional view change for THIS tab (same bag as columns).
                if (selector == "mode"
                    && _activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                    && _tabs[_activeTabIndex] != null
                    && !IsBookTab(_tabs[_activeTabIndex])
                    && !IsNativeTab(_tabs[_activeTabIndex]))
                {
                    string m = NormalizeTabViewMode(value);
                    if (!string.IsNullOrEmpty(m))
                        _tabs[_activeTabIndex].ViewMode = m;
                }
                SendMsg("cmd:view_set:" + selector + ":" + value);
                try { if (_webView != null) _webView.Focus(); } catch { }
            };
        }

        /// <summary>
        /// HTML is not Markdown. Mode means:
        ///   Source  = editable markup (editor — the only edit path)
        ///   Preview = not used for HTML (Markdown WYSIWYG of tags is a lie; left locked)
        ///   Reader  = true HTML page, read-only
        /// Returns true if the click was fully handled.
        /// </summary>
        private bool HandleHtmlModeSegmentClick(string mode)
        {
            try
            {
                if (_activeTabIndex < 0 || _activeTabIndex >= _tabs.Count) return false;
                var tab = _tabs[_activeTabIndex];
                if (tab == null || string.IsNullOrEmpty(tab.FilePath)) return false;
                if (!IsHtmlPath(tab.FilePath)) return false;

                if (mode == "preview")
                {
                    // Ignore — Preview stays locked for HTML (see PaintNativeChrome / tooltips).
                    return true;
                }

                if (IsNativeTab(tab) && tab.NativeRole == NativeRole.Page)
                {
                    if (mode == "source")
                    {
                        OpenAsEditorText(tab.FilePath);
                        return true;
                    }
                    // Reader: already on the rendered page
                    return true;
                }

                // Engine HTML (Source): Reader opens the real rendered page.
                if (!IsNativeTab(tab) && !IsBookTab(tab) && mode == "reader")
                {
                    if (!SyncActiveTabFromEditor(allowStaleIfClean: true, timeoutMs: 3000))
                        return true;
                    OpenNative(tab.FilePath, forceLoad: true);
                    return true;
                }
            }
            catch { }
            return false;
        }

        /// <summary>
        /// Paint the three segmented controls from the state the page resolved.
        /// A locked group is disabled and dimmed, which is what stops the user pressing a
        /// segment that cannot apply -- the resolver guarantees an unlocked route always
        /// exists, so this never becomes a dead end.
        /// </summary>
        private void RenderViewSelectors(string mode, int columns, string scroll,
                                         bool columnsLocked, bool scrollLocked)
        {
            SelectSegment("btnModeSource", mode == "source");
            SelectSegment("btnModePreview", mode == "preview");
            SelectSegment("btnModeReader", mode == "reader");
            // Window geometry is remembered per column count, so switching columns also
            // restores the size the user last chose for that layout. Do this before the
            // cached value moves on -- the outgoing rect belongs to the old column count.
            if (columns != _viewColumns) ApplyColumnWindowGeometry(columns);

            _viewColumns = columns;
            _viewScroll = scroll;
            _viewMode = mode;
            _viewColumnsLocked = columnsLocked;
            _viewScrollLocked = scrollLocked;
            _isPageAdvanceMode = (scroll == "pagination");

            // tab.Columns is NOT written here.
            //
            // view_state is "what the page is showing right now". After opening a book the
            // first paint is always 1-col until RequestTabColumns runs; writing that 1 back
            // erased the tab's remembered 2-col. Source→book was the worst case: columns
            // commands while Source is active are ignored (locked to 1), the book mounts
            // as 1-col, this echo stored 1, and load_done re-applied 1. Preview→book often
            // already had a free column state so the race was less visible.
            //
            // One rule: tab.Columns is only set by (1) session restore cols=, (2) the user
            // clicking the column control. RequestTabColumns / view_state only *apply* or
            // *paint* — they never overwrite memory.

            // Keep legacy mode chrome in step for Word Wrap / toolbars that still read it.
            if (mode == "source") _editorMode = "source";
            else if (mode == "reader") _editorMode = "reader";
            else _editorMode = "wysiwyg";
            RefreshEditingAvailability();

            // A book has no Source and no Preview. There is no markdown behind it to
            // show, and nothing to preview an edit of — offering both asked the reader to
            // choose between two things that do not exist for this document, and choosing
            // one is how the publisher's HTML ended up being rewritten as source.
            //
            // Pages goes with them: a book is always paginated, so Scroll is not a state
            // it has either. That leaves the column count as the only view choice on the
            // toolbar, which is the only one a book actually offers.
            bool isBook = IsEpubPath(_currentFilePath);
            bool isNative = IsNativePath(_currentFilePath)
                || (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count && IsNativeTab(_tabs[_activeTabIndex]));
            bool isNativeHtml = isNative && IsHtmlPath(_currentFilePath);
            bool isEngineHtml = !isNative && !isBook && IsHtmlPath(_currentFilePath);
            bool readOnlyDoc = isBook || isNative;
            // HTML: Source always available; Preview always locked; Reader for render.
            // PDF/image/media: Source+Preview locked.
            bool lockSource = readOnlyDoc && !isNativeHtml && !isEngineHtml;
            bool lockPreview = isNative || isBook || isEngineHtml || isNativeHtml;

            if (_btnColumnToggle != null)
            {
                // Shade a two-state button whenever it is NOT on its default, so the
                // toolbar reads like the Mode pillbox: shading means "switched on".
                // 1-Col and Scroll are the defaults, so 2-Col and Pages are the lit states.
                _btnColumnToggle.Content = columns == 2 ? "2-Col" : "1-Col";
                SetToolbarActive(_btnColumnToggle, columns == 2);
                SetControlLocked(_btnColumnToggle, columnsLocked || isNative);
            }
            if (_btnScrollToggle != null)
            {
                _btnScrollToggle.Content = scroll == "pagination" ? "Pages" : "Scroll";
                SetToolbarActive(_btnScrollToggle, scroll == "pagination");
                SetControlLocked(_btnScrollToggle, scrollLocked || readOnlyDoc);
            }

            // The two dead segments are locked individually rather than the whole group,
            // so Reader keeps its full-strength selected fill. "You are reading" is still
            // worth saying, and dimming the group would have said it at 30%.
            //
            // The group itself stays enabled. This line used to force that unconditionally
            // and that is exactly why Source and Preview stayed live on a book: it ran
            // last and overrode whatever the resolver had asked for.
            if (_grpMode != null) { _grpMode.IsEnabled = true; _grpMode.Opacity = 1.0; }
            Button segSource, segPreview;
            if (_segments.TryGetValue("btnModeSource", out segSource))
                SetControlLocked(segSource, lockSource);
            if (_segments.TryGetValue("btnModePreview", out segPreview))
                SetControlLocked(segPreview, lockPreview);

            // And put a book that is somehow not in Reader back into it. Disabling the
            // controls stops it happening from here on; a session restored from before
            // this change, or any route that does not pass through those buttons, can
            // still arrive in the wrong place. The correction settles immediately because
            // the next view_state has mode == reader and this stops firing.
            // Native tabs do not use the engine mode machine — chrome only (see ShowNativeSurface).
            if (isBook && !string.Equals(mode, "reader", StringComparison.OrdinalIgnoreCase))
                SendMsg("cmd:view_set:mode:reader");
        }

        /// <summary>
        /// Remember the window rect for the column count being left, then restore whatever
        /// the user last used for the one being entered.
        ///
        /// 1-column and 2-column want genuinely different window shapes, and deriving one
        /// from the other (say, twice the width at the same height) breaks down as soon as
        /// the monitor, the margins or the font size differ. Each is simply stored.
        /// </summary>
        private void ApplyColumnWindowGeometry(int toColumns)
        {
            if (this.WindowState != WindowState.Normal) return; // maximized/fullscreen: leave alone

            CaptureColumnRect();
            _isTwoColumnMode = (toColumns == 2);

            Rect? next = _isTwoColumnMode ? _col2Rect : _col1Rect;
            if (!next.HasValue || next.Value.Width <= 0) return;   // nothing saved yet: keep the current size

            this.Width = next.Value.Width;
            this.Height = next.Value.Height;
            // Only move the window if the saved position still lands on a connected screen.
            if (next.Value.Left >= SystemParameters.VirtualScreenLeft - 100 &&
                next.Value.Top >= SystemParameters.VirtualScreenTop - 100 &&
                next.Value.Left < SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth - 100 &&
                next.Value.Top < SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight - 100)
            {
                this.Left = next.Value.Left;
                this.Top = next.Value.Top;
            }
        }

        /// <summary>Store the current window rect against the column count in force.</summary>
        private void CaptureColumnRect()
        {
            if (this.WindowState != WindowState.Normal) return;
            var r = new Rect(this.Left, this.Top, this.Width, this.Height);
            if (_isTwoColumnMode) _col2Rect = r; else _col1Rect = r;
        }

        private void SetToolbarActive(Button b, bool active)
        {
            if (b == null) return;
            // Fill and weight only, deliberately leaving the outline alone.
            //
            // A selected pillbox segment is a fill and nothing else: SegmentButton draws
            // with BorderThickness 0, so the brush SelectSegment assigns to BorderBrush
            // never appears. ToolbarStateButton does draw a 1px border, so recolouring it
            // to the accent gave these buttons an outline the pillbox never gets -- which
            // is why 2-Col read as a stronger selection than Preview. The resting outline
            // now stays put and only the fill changes, so both say "selected" the same way.
            b.Background = active ? (_modeSourceBg ?? SystemColors.HighlightBrush) : Brushes.Transparent;
            b.FontWeight = active ? FontWeights.SemiBold : FontWeights.Normal;
        }

        // How far a control recedes when it cannot be pressed.
        //
        // 0.45 was chosen when two buttons used this and the reader met them one at a
        // time. Reader mode greys nine at once, and nine faint controls in a row still
        // read as a toolbar -- the group was legible enough to keep drawing the eye to
        // something it could not use. One value, not one per control: "unavailable"
        // should look the same everywhere, and the Column and Scroll buttons quieting by
        // the same amount is the point, not a side effect.
        private const double LockedOpacity = 0.30;

        // UIElement, not Control: IsEnabled and Opacity both live there, and the segment
        // groups are Borders, which are Decorators rather than Controls.
        private void SetControlLocked(UIElement c, bool locked)
        {
            if (c == null) return;
            c.IsEnabled = !locked;
            c.Opacity = locked ? LockedOpacity : 1.0;
        }

        private void SelectSegment(string name, bool on)
        {
            Button b;
            if (!_segments.TryGetValue(name, out b) || b == null) return;
            if (on)
            {
                b.Background = _modeSourceBg ?? SystemColors.HighlightBrush;
                b.BorderBrush = _modeSourceBorder ?? Brushes.Gray;
                b.FontWeight = FontWeights.SemiBold;
            }
            else
            {
                b.Background = Brushes.Transparent;
                b.BorderBrush = Brushes.Transparent;
                b.FontWeight = FontWeights.Normal;
            }
        }

        private void ApplyZoomToWebView()
        {
            try
            {
                if (_nativeSurfaceVisible && _nativeWebView != null)
                    _nativeWebView.ZoomFactor = _zoomFactor;
                else if (_webView != null)
                    _webView.ZoomFactor = _zoomFactor;
            }
            catch { }
            // ZoomFactor scales the whole page, chrome included, while the WPF menus never
            // scale. Tell the page the factor so the sidebar can divide it back out and
            // keep sitting at menu size at any zoom.
            try { SendMsg("cmd:host_zoom:" + _zoomFactor.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture)); }
            catch { }
        }

        private void UpdateZoomLabel()
        {
            if (_lblZoom == null)
                _lblZoom = FindElement("lblZoom") as TextBlock;
            if (_lblZoom == null) return;
            int pct = (int)Math.Round(_zoomFactor * 100.0);
            // Always marshal to WPF dispatcher (filter can run on WinForms pump path)
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.BeginInvoke(new Action(UpdateZoomLabel));
                return;
            }
            _lblZoom.Text = pct + "%";
        }

        /// <summary>
        /// Keep status % in sync when WebView2 changes ZoomFactor natively
        /// (Ctrl+wheel still does this even with browser accelerators disabled).
        /// </summary>
        private void WebView_ZoomFactorChanged(object sender, EventArgs e)
        {
            if (_zoomApplying) return;
            try
            {
                if (_webView == null) return;
                double z = ClampZoom(_webView.ZoomFactor);
                if (Math.Abs(z - _zoomFactor) < 0.001) return;
                _zoomFactor = z;
                UpdateZoomLabel();
                // Native Ctrl+wheel: one event per notch, so this is the burst that
                // SaveWindowStateDebounced exists for.
                SaveWindowStateDebounced();
            }
            catch { }
        }

        /// <summary>
        /// The WebView2 environment, started before the XAML is parsed.
        /// </summary>
        /// <remarks>
        /// Creating it needs nothing from the window -- a cache directory and the command
        /// line, both known at construction -- while the controller that follows it does
        /// need a window handle and cannot be moved. Started at the top of the constructor
        /// it overlaps the ~360ms XamlReader.Load rather than queueing behind it, and is
        /// ready by the time window.Loaded asks for it. Measured before: environment ready
        /// at 546ms, of which 90ms was spent waiting for it after the window had loaded.
        /// </remarks>
        private Task<CoreWebView2Environment> _envTask;

        private Task<CoreWebView2Environment> StartWebView2Environment()
        {
            try
            {
                string userDataDir = CacheDir();
                if (!Directory.Exists(userDataDir)) Directory.CreateDirectory(userDataDir);
                return CoreWebView2Environment.CreateAsync(null, userDataDir, BuildWebView2Options());
            }
            catch (Exception ex)
            {
                Program.PerfMark("WebView2 environment could not be started early: " + ex.Message);
                return null;
            }
        }

        /// <summary>Command-line switches for the browser process. One definition, so the
        /// early start and any later retry cannot drift apart.</summary>
        private CoreWebView2EnvironmentOptions BuildWebView2Options()
        {
            // With --debug, open the DevTools protocol on a fixed port so a test can drive
            // THIS process rather than a copy of the page in a separate browser.
            //
            // Every attempt to fix column switching until now was verified against
            // TypoZen_Template.html loaded in plain Chrome, where the fault does not occur --
            // so the tests passed and the app stayed broken, repeatedly. The harness needs to
            // attach to the real WebView2, with the real WPF host, real window size and real
            // focus behaviour. Off unless --debug, so an ordinary run never opens a port.
            string extraArgs =
                "--host-resolver-rules=\"MAP localapp 127.0.0.1, MAP docfolder 127.0.0.1, MAP localbooks 127.0.0.1, MAP localview 127.0.0.1, MAP localload 127.0.0.1\""
                + " --disable-background-networking"
                + " --disable-component-update"
                + " --disable-sync"
                + " --no-first-run"
                + " --no-default-browser-check";
            if (Program.DebugLogEnabled)
            {
                extraArgs += " --remote-debugging-port=" + Program.RemoteDebugPort.ToString(System.Globalization.CultureInfo.InvariantCulture)
                           + " --remote-allow-origins=*";
            }
            return new CoreWebView2EnvironmentOptions(extraArgs, null, null, false);
        }

        private async void InitializeWebViewAsync()
        {
            var border = (Border)FindElement("webViewContainer");
            if (border == null) return;

            var host = new WindowsFormsHost();
            host.Background = this.Background;
            // One WinForms panel holds editor + native reader WebViews (same bounds; one visible).
            _webViewPanel = new WinForms.Panel();
            _webViewPanel.Dock = WinForms.DockStyle.Fill;
            _webViewPanel.BackColor = _currentThemeBg;

            _webView = new WebView2();
            _webView.BackColor = _currentThemeBg;
            try { _webView.DefaultBackgroundColor = _currentThemeBg; } catch {}
            _webView.Dock = WinForms.DockStyle.Fill;
            _webViewPanel.Controls.Add(_webView);

            host.Child = _webViewPanel;
            border.Child = host;

            string userDataDir = CacheDir();
            if (!Directory.Exists(userDataDir)) Directory.CreateDirectory(userDataDir);

            try
            {
                // localapp/docfolder are virtual hosts served from disk by
                // SetVirtualHostNameToFolderMapping - they are not real names. Chromium still
                // runs a DNS lookup for them on every navigation, and on a machine whose DNS
                // is remote (a VPN, say) that NXDOMAIN round trip costs ~2 s *per navigation*
                // before the mapping is consulted. Measured here: 2,063 ms -> 61 ms.
                // Pinning them to loopback skips the lookup. localbooks / localview /
                // localload were added later and must stay on this list or they pay
                // the same NXDOMAIN cost. The app itself makes no network requests.
                // Second group: WebView2's browser process otherwise runs Chromium background
                // services on startup - component updates, Safe Browsing list refreshes, sync -
                // even though this app never requests a URL. Switched off here.
                //
                // Page loads are untouched: a document referencing a remote image still fetches
                // it. The cost is that such a fetch is no longer checked against a freshly
                // updated Safe Browsing list.
                //
                // NOT fully silent. Measured: the WebView2 browser process still holds two TLS
                // connections to Microsoft-owned addresses (40.99.x / 52.98.x, they vary per
                // run) from startup, with no page having requested anything. Seven flag
                // combinations were tried - domain-reliability, no-pings, no-service-autorun,
                // several --disable-features guesses, crash/breakpad - and none removed them.
                // The endpoint is NOT identified: it does not appear in the Windows DNS cache
                // (Chromium resolves independently) nor in --log-net-log output. Do not assume
                // it is any particular service without re-measuring.
                // This is runtime traffic, not the app's: the page issues no requests and no
                // document content is involved. Stopping it entirely needs something outside
                // the app - a firewall rule on msedgewebview2.exe (which would also block
                // remote images in documents), or machine-level Edge policy.
                // With --debug, open the DevTools protocol on a fixed port so a test can
                // drive THIS process rather than a copy of the page in a separate browser.
                //
                // Every attempt to fix column switching until now was verified against
                // TypoZen_Template.html loaded in plain Chrome, where the fault does not
                // occur -- so the tests passed and the app stayed broken, repeatedly. The
                // harness needs to attach to the real WebView2, with the real WPF host,
                // real window size and real focus behaviour. Off unless --debug, so an
                // ordinary run never opens a port.
                // Started before the XAML was parsed; usually finished by now. Falls back
                // to creating it here if the early start could not run.
                Task<CoreWebView2Environment> envTask = _envTask;
                if (envTask == null)
                {
                    envTask = CoreWebView2Environment.CreateAsync(null, userDataDir, BuildWebView2Options());
                    Program.PerfMark("WebView2 environment started late (no early task)");
                }
                var env = await envTask;
                Program.PerfMark("WebView2 environment ready");
                await _webView.EnsureCoreWebView2Async(env);
                Program.PerfMark("WebView2 controller ready");

                _webView.BackColor = _currentThemeBg;
                try { _webView.DefaultBackgroundColor = _currentThemeBg; } catch {}

                _webView.CoreWebView2.Settings.AreDevToolsEnabled = Program.DebugLogEnabled;
                _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                // Disable Chromium page-find (Ctrl+F) and other browser accelerators.
                // Page-find was counting sidebar outline duplicates and failing to scroll #main-container.
                // NOTE: with this false, Ctrl+Z may never reach page JS or WPF KeyDown when WebView
                // has focus (older WebView2 builds lack AcceleratorKeyPressed). We use a WinForms
                // IMessageFilter (InstallEditorKeyFilter) so undo/format chords always work.
                try { _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false; } catch {}
                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping("localapp", _appDir, CoreWebView2HostResourceAccessKind.Allow);
                MapBookHost();
                MapLoadHost();
                MapDocumentFolder(_currentFilePath);
                AttachEditorNavigationGuards(_webView.CoreWebView2);
                _webView.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;

                // Native Ctrl+wheel still mutates ZoomFactor — mirror it into the status bar.
                try { _webView.ZoomFactorChanged += WebView_ZoomFactorChanged; } catch { }

                // Restore zoom before first paint (ZoomFactor is on the control, not CoreWebView2)
                ApplyZoomToWebView();
                UpdateZoomLabel();
                
                _webView.CoreWebView2.NavigationCompleted += (s, e) => {
                    Program.PerfMark("template navigation completed");
                    if (!e.IsSuccess)
                    {
                        WinForms.MessageBox.Show("WebView navigation failed: " + e.WebErrorStatus, "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                    }
                    // Navigation can reset zoom on some runtimes — re-apply
                    ApplyZoomToWebView();
                    UpdateZoomLabel();
                    _webView.Focus();
                };

                string htmlPath = Path.Combine(_appDir, "TypoZen_Template.html");
                if (File.Exists(htmlPath))
                {
                    // Cache-bust on the newest of the template, CSS, and JS modules.
                    // Using only the HTML mtime left WebView serving stale 02-layout /
                    // 03-shell after search fixes, so ZenSeek still opened Ctrl+F + sidebar.
                    long ticks = File.GetLastWriteTimeUtc(htmlPath).Ticks;
                    try
                    {
                        string cssPath = Path.Combine(_appDir, "css", "typozen.css");
                        if (File.Exists(cssPath))
                            ticks = Math.Max(ticks, File.GetLastWriteTimeUtc(cssPath).Ticks);
                        string modDir = Path.Combine(_appDir, "js", "modules");
                        if (Directory.Exists(modDir))
                        {
                            foreach (string f in Directory.GetFiles(modDir, "*.js"))
                                ticks = Math.Max(ticks, File.GetLastWriteTimeUtc(f).Ticks);
                        }
                    }
                    catch { }

                    // Stamp ?v= onto script/link tags so module edits cannot stick in the
                    // WebView HTTP cache after a full navigation (query on the HTML alone
                    // is not enough — classic script src URLs were unversioned).
                    string navName = "TypoZen_Template.html";
                    try
                    {
                        string html = File.ReadAllText(htmlPath);
                        string v = ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        html = System.Text.RegularExpressions.Regex.Replace(
                            html,
                            @"src=""(js/modules/[^""]+\.js)(?:\?[^""]*)?""",
                            "src=\"$1?v=" + v + "\"");
                        html = System.Text.RegularExpressions.Regex.Replace(
                            html,
                            @"href=""(css/typozen\.css)(?:\?[^""]*)?""",
                            "href=\"$1?v=" + v + "\"");
                        // About modal: the version comes from Program.AppVersion, so the
                        // page never holds a second copy to fall out of step with the
                        // assembly resource. Idempotent -- the group match spans whatever
                        // a previous stamp left behind.
                        html = System.Text.RegularExpressions.Regex.Replace(
                            html,
                            @"(<div class=""tz-about-version"" id=""aboutVersion"">)[^<]*(</div>)",
                            "${1}Version " + Program.AppVersion + "${2}");
                        string stamped = Path.Combine(_appDir, "TypoZen_Template.runtime.html");
                        // Only when it would actually differ. The stamp is derived from
                        // module mtimes, so between edits every launch regenerated a file
                        // byte-identical to the one already there -- and rewrote it anyway.
                        // The app folder is a synced folder (OneDrive), where a write is not
                        // free even when the content is: it is an upload, a version, and a
                        // sync notification, on every start of the app, forever. Reading
                        // 30 KB back to compare costs less than the write it usually avoids.
                        bool needWrite = true;
                        try
                        {
                            if (File.Exists(stamped))
                                needWrite = !string.Equals(File.ReadAllText(stamped), html, StringComparison.Ordinal);
                        }
                        catch { needWrite = true; }   // unreadable: rewrite it
                        if (needWrite) File.WriteAllText(stamped, html);
                        navName = "TypoZen_Template.runtime.html";
                    }
                    catch { /* fall back to unstamped template */ }

                    Program.PerfMark(string.Format(
                        "navigating (webview {0}x{1} visible={2}, window visible={3})",
                        _webView.Width, _webView.Height, _webView.Visible, this.IsVisible));
                    // perf=1 switches on the page-side marks; absent, they are inert.
                    _webView.CoreWebView2.Navigate("https://localapp/" + navName + "?v=" + ticks
                        + (Program.PerfEnabled ? "&perf=1" : ""));
                }
                else
                {
                    WinForms.MessageBox.Show("Cannot find TypoZen_Template.html in " + _appDir, "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                }
            }
            catch (Exception ex)
            {
                WinForms.MessageBox.Show("Failed to initialize WebView2: " + ex.Message, "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
            }
        }

        private void CoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string msg = e.TryGetWebMessageAsString();
            if (string.IsNullOrEmpty(msg)) return;

            // Page-side startup marks, batched and flushed at "ready". Format: perf:<ms>|<label>
            // The page clock starts at navigation, so these are offsets within template load.
            if (msg.StartsWith("perf:"))
            {
                int bar = msg.IndexOf('|');
                if (bar > 5) Program.PerfMark("        page +" + msg.Substring(5, bar - 5) + " ms  " + msg.Substring(bar + 1));
                return;
            }
            else if (msg.StartsWith("telemetry:"))
            {
                // Only with --debug. Normal runs must not write a log beside the exe.
                if (!Program.DebugLogEnabled) return;
                try
                {
                    string logPath = System.IO.Path.Combine(_appDir, "debug.log");
                    System.IO.File.AppendAllText(logPath, string.Format("[{0:HH:mm:ss.fff}] {1}\n", DateTime.Now, msg.Substring(10)));
                }
                catch { }
                return;
            }

            // Page-side zoom chords (editor focused) — most reliable path for hosted WebView2
            if (msg == "zoom:in")
            {
                ZoomBy(+ZoomStep);
                return;
            }
            if (msg == "zoom:out")
            {
                ZoomBy(-ZoomStep);
                return;
            }
            if (msg == "zoom:reset")
            {
                SetZoom(1.0);
                return;
            }

            // A link in the document pointing somewhere outside it.
            //
            // Only http, https and mailto are ever handed to the shell. The address comes
            // from document content, and a document is not a trusted thing to be told
            // "start this" by: without the check, a link with a file: or a custom scheme
            // would be a way to make opening a note launch a program. Everything else that
            // looks like a path goes through open_doc below, which opens it as a document
            // and cannot run it.
            if (msg.StartsWith("open_external:"))
            {
                try
                {
                    string url = Uri.UnescapeDataString(msg.Substring("open_external:".Length));
                    if (Regex.IsMatch(url, @"^(https?|mailto):", RegexOptions.IgnoreCase))
                    {
                        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
                    }
                    else
                    {
                        NotifyLink("This link was not opened.\n\n" + url + "\n\nOnly http, https and mailto links are followed.");
                    }
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine("open_external: " + ex.Message);
                }
                return;
            }

            // A link to another file, resolved against the document that contains it --
            // which only the host can do, because only the host knows where that document
            // lives. Opened the way File -> Open opens anything, never handed to the shell,
            // so a link to an .exe becomes a failed document open rather than a program.
            // "Show in Folder" on the link chip. Same resolution as open_doc, then the
            // same Explorer call the status-bar path already makes.
            if (msg.StartsWith("reveal_doc:"))
            {
                try
                {
                    string full = ResolveLinkPath(Uri.UnescapeDataString(msg.Substring("reveal_doc:".Length)));
                    if (full == null) return;
                    if (File.Exists(full))
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = "explorer.exe",
                            Arguments = "/select,\"" + full + "\"",
                            UseShellExecute = true
                        });
                    }
                    else NotifyLink("Link target not found:\n\n" + full);
                }
                catch (Exception ex) { System.Diagnostics.Debug.WriteLine("reveal_doc: " + ex.Message); }
                return;
            }

            if (msg.StartsWith("open_doc:"))
            {
                try
                {
                    string full = ResolveLinkPath(Uri.UnescapeDataString(msg.Substring("open_doc:".Length)));
                    if (full == null) return;
                    if (File.Exists(full))
                    {
                        // Deferred, never straight from here. LoadFileFromPath pulls editor
                        // state with a blocking script call, and that result cannot arrive
                        // while this WebView2 message handler is still on the stack waiting
                        // for it: it stalls to the timeout and reports that the editor could
                        // not be reached. Session restore learned this the same way.
                        string openPath = full;
                        Dispatcher.BeginInvoke(new Action(delegate
                        {
                            try { LoadFileFromPath(openPath); } catch { }
                        }), DispatcherPriority.Background);
                    }
                    else NotifyLink("Link target not found:\n\n" + full);
                }
                catch (Exception ex) { System.Diagnostics.Debug.WriteLine("open_doc: " + ex.Message); }
                return;
            }

            // About -> "Report a problem or suggest a feature". Most readers arrive through
            // a Releases zip and never see the repository, so a feedback route that lives
            // only on GitHub is one nobody uses.
            if (msg == "feedback")
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = Program.IssuesUrl,
                        UseShellExecute = true
                    });
                }
                catch (Exception ex)
                {
                    // A machine with no browser association must not take the editor down.
                    System.Diagnostics.Debug.WriteLine("feedback link: " + ex.Message);
                }
                return;
            }

            if (msg.StartsWith("ready"))
            {
                Program.PerfMark("page reported ready (template JS initialised)");
                string prefsPath = PrefsPath();
                string prefsJson = null;
                string lastFilePath = null;
                if (File.Exists(prefsPath))
                {
                    try
                    {
                        prefsJson = File.ReadAllText(prefsPath, Encoding.UTF8);
                        var pathMatch = Regex.Match(prefsJson, @"\""lastFilePath\""\s*:\s*\""((?:\\.|[^\""])*)\""");
                        if (pathMatch.Success)
                        {
                            // JsonUnescape, like every other reader here. This was the one
                            // site still undoing the escaping with two chained Replace
                            // calls. That form was *correct*, but only by accident: it
                            // handles \\ and \" and nothing else, and the reason nothing
                            // else turns up is that Windows rejects every other character
                            // JsonEscape emits an escape for -- tab, newline, and the
                            // control range -- in a path. So the field's own validity was
                            // load-bearing. Routed through the shared helper instead, both
                            // so the assumption stops being load-bearing and so there is
                            // one unescaper to be right rather than two.
                            lastFilePath = JsonUnescape(pathMatch.Groups[1].Value);
                        }
                    }
                    catch {}
                }

                string themesPath = Path.Combine(_appDir, "TypoZen_Themes.json");
                if (File.Exists(themesPath))
                {
                    string json = File.ReadAllText(themesPath, Encoding.UTF8);
                    SendMsg("init_themes:" + json);
                }

                ApplyRestoredViewSettings(true);   // page is ready: word wrap can apply too

                // Document tabs: start with one buffer
                EnsureAtLeastOneTab();
                RebuildTabStrip();

                // Automated tab content E2E (env TYPOZEN_TAB_E2E = output dir) skips session restore
                if (_e2eMode)
                {
                    if (!string.IsNullOrEmpty(prefsJson))
                        SendMsg("restore_prefs:" + StripLastContentFromPrefs(prefsJson));
                    ScheduleTabContentE2E();
                    _editorReady = true;
                }
                else
                {
                    // Multi-tab session first (Notepad-style). CLI file still opens/focuses after.
                    bool restoredSession = false;
                    _restoringTabs = true;
                    try
                    {
                        if (!string.IsNullOrEmpty(prefsJson))
                            SendMsg("restore_prefs:" + StripLastContentFromPrefs(prefsJson));

                        Program.PerfMark("session restore: begin");
                        restoredSession = TryRestoreTabSession();
                        Program.PerfMark("session restore: done (" + _tabs.Count + " tabs)");

                        if (!restoredSession)
                        {
                            // Legacy single-file / scratchpad path
                            if (!string.IsNullOrEmpty(_initialFileToOpen) && File.Exists(_initialFileToOpen))
                            {
                                // fall through after block
                            }
                            else if (!string.IsNullOrEmpty(lastFilePath) && File.Exists(lastFilePath))
                            {
                                // Deferred for the same reason as the requested-file load below:
                                // LoadFileFromPath issues a blocking script call, which cannot
                                // complete while this WebView2 message handler is still running.
                                string lastToOpen = lastFilePath;
                                Dispatcher.BeginInvoke(new Action(() =>
                                {
                                    Program.PerfMark("last file: load begin");
                                    LoadFileFromPath(lastToOpen);
                                    Program.PerfMark("last file: load done");
                                }), DispatcherPriority.Background);
                                restoredSession = true; // skip scratchpad
                            }
                            else if (!string.IsNullOrEmpty(prefsJson))
                            {
                                // Full prefs including lastContent scratchpad
                                SendMsg("restore_prefs:" + prefsJson);
                                if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count)
                                {
                                    _tabs[_activeTabIndex].FilePath = null;
                                    _tabs[_activeTabIndex].IsDirty = false;
                                }
                                RebuildTabStrip();
                                restoredSession = true;
                            }
                        }
                    }
                    finally { _restoringTabs = false; }

                    // CLI path: open/focus even when a session was restored
                    if (!string.IsNullOrEmpty(_initialFileToOpen) && File.Exists(_initialFileToOpen))
                    {
                        string fileToOpen = _initialFileToOpen;
                        LaunchRequest cliLaunch = _pendingLaunch;
                        _initialFileToOpen = null;
                        // Deferred out of this WebView2 message handler on purpose.
                        // LoadFileFromPath pulls editor state with a blocking script call, and
                        // that result cannot be delivered while we are still inside the handler
                        // that WebView2 is dispatching - it stalls for the full timeout instead
                        // (two 3s waits, ~6s of dead time on every cold open from Explorer).
                        Dispatcher.BeginInvoke(new Action(() =>
                        {
                            Program.PerfMark("requested file: load begin");
                            if (cliLaunch != null && cliLaunch.HasOpenHints)
                            {
                                cliLaunch.FilePath = fileToOpen;
                                OpenWithLaunchRequest(cliLaunch);
                            }
                            else
                                LoadFileFromPath(fileToOpen);
                            Program.PerfMark("requested file: load done  <<< user sees their document");
                        }), DispatcherPriority.Background);
                    }
                    else if (!restoredSession)
                    {
                        RebuildTabStrip();
                    }

                    _editorReady = true;
                    FlushPendingHandoffPaths();
                }
            }
            else if (msg == "tab:close")
            {
                CloseActiveTab();
            }
            else if (msg == "tab:next")
            {
                CycleTab(+1);
            }
            else if (msg == "tab:prev")
            {
                CycleTab(-1);
            }
            else if (msg.StartsWith("save_prefs:"))
            {
                try
                {
                    // Host owns settings.json: merge allowlisted page fields only.
                    // Never write-through the raw page blob (could wipe host fields or
                    // stash multi‑MB lastContent).
                    MergeAndWriteHostPrefs(msg.Substring(11));
                }
                catch {}
            }
            else if (msg.StartsWith("stats:"))
            {
                // words, chars, readTime, isDirty, totalLines, caretLine [, selWords, selChars]
                var parts = msg.Substring(6).Split(',');
                if (parts.Length >= 4)
                {
                    int selWords = 0, selChars = 0;
                    if (parts.Length >= 8)
                    {
                        int.TryParse(parts[6], out selWords);
                        int.TryParse(parts[7], out selChars);
                    }
                    if (_lblWordCount != null)
                    {
                        _lblWordCount.Text = selWords > 0 || selChars > 0
                            ? (Grouped(selWords.ToString()) + " / " + Grouped(parts[0]) + " words")
                            : (Grouped(parts[0]) + " words");
                    }
                    if (_lblCharCount != null)
                    {
                        _lblCharCount.Text = selWords > 0 || selChars > 0
                            ? (Grouped(selChars.ToString()) + " / " + Grouped(parts[1]) + " chars")
                            : (Grouped(parts[1]) + " chars");
                    }
                    if (_lblReadingTime != null) _lblReadingTime.Text = Grouped(parts[2]) + " min read";
                    bool dirty = parts[3] == "true";
                    _isDirty = dirty;
                    if (dirty) ArmAutosave();
                    // Not while a tab operation is in flight. Stats are debounced and the
                    // page is mid-swap, so this flag describes whichever document the page
                    // happens to hold -- not the tab this index now names. A book being
                    // opened marked the Markdown tab it replaced as unsaved.
                    if (!_tabOpInProgress
                        && _activeTabIndex >= 0 && _activeTabIndex < _tabs.Count)
                    {
                        var statsTab = _tabs[_activeTabIndex];
                        // Books and native tabs are never dirty.
                        if (IsReadOnlyTab(statsTab)) dirty = false;
                        bool wasDirty = statsTab.IsDirty;
                        statsTab.IsDirty = dirty;
                        if (wasDirty != dirty) RebuildTabStrip();
                    }
                    if (_lblLineCount != null)
                    {
                        string total = parts.Length >= 5 ? parts[4] : "0";
                        string caret = parts.Length >= 6 ? parts[5] : "?";
                        // Ln current / total — answers "what line am I on?"
                        // Not Grouped(): a line number is a coordinate, not a count, and
                        // the search sidebar prints the same number raw in its gutter.
                        // Grouping here made one line read as "1,037" in the status bar
                        // and "1037" three inches to the left.
                        _lblLineCount.Text = "Ln " + caret + "/" + total;
                    }
                    UpdateStatusDisplay();
                }
            }
            else if (msg.StartsWith("view_flags:"))
            {
                // view_flags:reveal=1,focus=0,typewriter=1
                try
                {
                    string body = msg.Substring(11);
                    bool focusOn = body.Contains("focus=1");
                    bool typeOn = body.Contains("typewriter=1");
                    SetMenuChecked("mToggleReveal", body.Contains("reveal=1"));
                    SetMenuChecked("mToggleFocus", focusOn);
                    SetMenuChecked("mToggleTypewriter", typeOn);
                }
                catch {}
            }
            // NOTE: save_content: / save_as_content: are no longer sent or handled.
            // Saving pulls content synchronously (SaveTabNow) so a reply can never land
            // after the active tab changed. The page still answers request_save:, but
            // nothing sends it — that responder is dead code worth deleting.
            else if (msg.StartsWith("image_data_req:"))
            {
                // Fallback when the https://docfolder mapping does not serve the file.
                // Read the bytes here and hand them back as a data: URI — no virtual host,
                // no cross-origin question, works regardless of path oddities.
                try
                {
                    string rel = msg.Substring(15);
                    if (string.IsNullOrEmpty(_currentFilePath)) return;
                    // Reject path traversal early
                    if (rel.IndexOf("..", StringComparison.Ordinal) >= 0) return;
                    string docDir = Path.GetDirectoryName(Path.GetFullPath(_currentFilePath));
                    if (string.IsNullOrEmpty(docDir)) return;
                    string docDirPrefix = Path.GetFullPath(docDir);
                    if (!docDirPrefix.EndsWith(Path.DirectorySeparatorChar.ToString())
                        && !docDirPrefix.EndsWith(Path.AltDirectorySeparatorChar.ToString()))
                        docDirPrefix += Path.DirectorySeparatorChar;
                    string candidate = Path.GetFullPath(Path.Combine(docDir, rel.Replace('/', Path.DirectorySeparatorChar)));

                    // Must live under the document folder (trailing-separator prefix check).
                    if (!candidate.StartsWith(docDirPrefix, StringComparison.OrdinalIgnoreCase)) return;
                    if (!File.Exists(candidate)) return;
                    var info = new FileInfo(candidate);
                    if (info.Length > 12 * 1024 * 1024) return;   // don't inline huge files

                    string ext = (Path.GetExtension(candidate) ?? "").TrimStart('.').ToLowerInvariant();
                    // Only serve image types (not arbitrary co-located files).
                    if (ext != "png" && ext != "jpg" && ext != "jpeg" && ext != "gif"
                        && ext != "webp" && ext != "bmp" && ext != "svg")
                        return;
                    string mime =
                        ext == "jpg" || ext == "jpeg" ? "image/jpeg" :
                        ext == "gif" ? "image/gif" :
                        ext == "webp" ? "image/webp" :
                        ext == "bmp" ? "image/bmp" :
                        ext == "svg" ? "image/svg+xml" : "image/png";

                    string b64 = Convert.ToBase64String(File.ReadAllBytes(candidate));
                    SendMsg("image_data:" + rel + "\n" + "data:" + mime + ";base64," + b64);
                }
                catch { }
            }
            else if (msg.StartsWith("image_paste:"))
            {
                // image_paste:<ext>:<base64>
                try
                {
                    string body = msg.Substring(12);
                    int sep = body.IndexOf(':');
                    string ext = sep > 0 ? body.Substring(0, sep) : "png";
                    string b64 = sep > 0 ? body.Substring(sep + 1) : "";
                    if (string.IsNullOrEmpty(_currentFilePath))
                    {
                        WinForms.MessageBox.Show(
                            "Save the document first.\n\nImages are stored next to the file, so TypoZen needs to know where it lives.",
                            "Paste image", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
                        return;
                    }
                    byte[] bytes = Convert.FromBase64String(b64);
                    string rel = SaveImageBesideDocument(bytes, ext);
                    if (!string.IsNullOrEmpty(rel)) SendMsg("insert_image:" + rel);
                }
                catch (Exception ex)
                {
                    WinForms.MessageBox.Show("Could not save the image: " + ex.Message, "Paste image",
                        WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                }
            }
            else if (msg.StartsWith("export_html_content:"))
            {
                string html = msg.Substring(20);
                ExecuteExportHtml(html);
            }
            else if (msg.StartsWith("menu_access:"))
            {
                // Alt+<letter>, forwarded from the page. Open the top-level menu whose
                // access key matches — derived from the "_File" style headers, so it stays
                // correct if a header is renamed.
                OpenMenuByAccessKey(msg.Length > 12 ? msg[12] : '\0');
            }
            else if (msg.StartsWith("book_position:"))
            {
                // Historical name: any saved path (epub or markdown) may remember a block.
                int block;
                if (int.TryParse(msg.Substring(14), out block))
                {
                    // Not while a tab operation is in flight. The page debounces this, so a
                    // report armed by the document being left can arrive after the switch
                    // has already pointed _currentFilePath at the new one -- which wrote a
                    // .txt's block number against a book's path and reopened the book at
                    // its cover.
                    if (_tabOpInProgress) return;

                    // On the tab as well as against the path. The path store answers
                    // "reopen this file where I left it"; the tab answers "come back to
                    // this tab where I left it", which is a different question when the
                    // same file is open twice and the only one an untitled buffer can ask.
                    if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count)
                        _tabs[_activeTabIndex].ResumeBlock = block;

                    string p = _currentFilePath;
                    if (!string.IsNullOrEmpty(p))
                    {
                        try { RememberBookPosition(Path.GetFullPath(p), block); } catch { }
                    }
                }
            }
            else if (msg.StartsWith("define:"))
            {
                AnswerDefinition(msg.Substring(7).Trim());
            }
            else if (msg.StartsWith("marks_set:"))
            {
                // The page owns the format and sends the whole list; the host keys it
                // by path and writes it. Not while a tab operation is in flight, for the
                // same reason book_position is not: a report armed by the document being
                // left can arrive after _currentFilePath already points at the new one,
                // which would file one document's marks against another's path.
                if (_tabOpInProgress) return;
                string p = _currentFilePath;
                if (!string.IsNullOrEmpty(p))
                {
                    try { RememberBookmarks(Path.GetFullPath(p), msg.Substring(10)); }
                    catch { }
                }
            }
            else if (msg.StartsWith("view_state:"))
            {
                // "view_state:<mode>,<columns>,<scroll>,<columnsLocked>,<scrollLocked>"
                //
                // Paint synchronously. mode_changed: updates Mode pills on this same
                // message thread. When view_state was deferred via BeginInvoke, a later
                // mode_changed could run first and then a stale view_state repainted
                // Source over a live WYSIWYG surface ("fake Source" on cold start).
                //
                // While a native tab is active the editor WebView still posts prefs
                // echoes; those must not overwrite PaintNativeChrome (Reader).
                if (ShouldIgnoreEditorModeChrome())
                    return;
                string[] p = msg.Substring(11).Split(',');
                if (p.Length >= 5)
                {
                    string vMode = p[0];
                    int vCols = p[1] == "2" ? 2 : 1;
                    string vScroll = p[2];
                    bool cLock = p[3] == "1";
                    bool sLock = p[4] == "1";
                    try
                    {
                        RenderViewSelectors(vMode, vCols, vScroll, cLock, sLock);
                        RefreshEditingAvailability();
                    }
                    catch { }
                }
            }
            else if (msg.StartsWith("sidebar_state:"))
            {
                // Remembered, not just painted: a theme change recomputes the brushes and
                // has to repaint every stateful control. Without the field the sidebar
                // button kept whatever colour it was first given and drifted out of step
                // with the theme, since nothing else knew whether it was on.
                //
                // User toggles pin the sidebar open (or clear the pin when closed). Edge
                // hover does not send this — so hover cannot pin.
                _sidebarOpen = msg.Substring(14) == "1";
                _sidebarPinned = _sidebarOpen;
                UpdateChromeWatch();
                Dispatcher.BeginInvoke(new Action(() =>
                    SetToolbarActive(FindElement("btnToggleSidebar") as Button, _sidebarOpen)),
                    DispatcherPriority.Normal);
            }
            else if (msg.StartsWith("chapter:"))
            {
                // "chapter:<blockIndex>\t<title>" — index is for click-to-jump; empty title hides.
                string body = msg.Length > 8 ? msg.Substring(8) : "";
                int bi = -1;
                string title = body;
                int tab = body.IndexOf('\t');
                if (tab >= 0)
                {
                    int.TryParse(body.Substring(0, tab), out bi);
                    title = body.Substring(tab + 1);
                }
                else if (body.Length > 0 && body[0] >= '0' && body[0] <= '9')
                {
                    // Tolerate bare index with no title.
                    int.TryParse(body, out bi);
                    title = "";
                }
                _chapterBlockIndex = bi;
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    try
                    {
                        if (_lblChapter == null) _lblChapter = FindElement("lblChapter") as TextBlock;
                        if (_lblChapter != null)
                        {
                            _lblChapter.Text = string.IsNullOrEmpty(title) ? "" : title;
                            _lblChapter.Visibility = string.IsNullOrEmpty(title)
                                ? Visibility.Collapsed : Visibility.Visible;
                        }
                    }
                    catch { }
                }), DispatcherPriority.Background);
            }
            else if (msg == "focus_webview")
            {
                // The page asks for keyboard focus back. Alt chords (Alt+S) put WPF into
                // menu mode on the Alt key up, which moves focus to the menu bar after the
                // page has already focused its own control -- typing then went to the menu.
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    try { if (_webView != null) _webView.Focus(); } catch { }
                }), DispatcherPriority.Input);
            }
            else if (msg == "reveal_chrome")
            {
                // Alt, forwarded from the page. Neither Window.KeyDown nor the message
                // filter sees it while the WebView owns focus: its HWND belongs to the
                // browser process, so those keys never reach our message loop.
                if (_chromeHidden)
                {
                    SetChromeHidden(false);
                    _chromeHideAfter = DateTime.UtcNow.AddMilliseconds(3000);
                }
            }
            else if (msg == "typing")
            {
                // Mark dirty immediately so leave/open cannot skip sync while stats lag.
                // Nor while a tab operation is in flight: the page is mid-swap, so this
                // describes whatever it currently holds rather than the tab this index names.
                if (_tabOpInProgress) { OnUserTyping(); return; }
                bool activeIsBook = _activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                    && !string.IsNullOrEmpty(_tabs[_activeTabIndex].FilePath)
                    && _tabs[_activeTabIndex].FilePath.EndsWith(".epub", StringComparison.OrdinalIgnoreCase);
                if (!activeIsBook)
                {
                    _isDirty = true;
                    if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count)
                        _tabs[_activeTabIndex].IsDirty = true;
                }
                OnUserTyping();
            }
            else if (msg == "load_done")
            {
                // Large staged open / book open finished — apply ZenSeek jump/highlight.
                ScheduleApplyPendingLaunch();
                // Re-apply THIS tab's view bag + position after content is really on the page.
                // Column remount must run before resume, or we land at the top again.
                try
                {
                    int idx = _activeTabIndex;
                    Dispatcher.BeginInvoke(new Action(() =>
                    {
                        try
                        {
                            if (idx < 0 || idx >= _tabs.Count || idx != _activeTabIndex) return;
                            var t = _tabs[idx];
                            ApplyTabView(t);
                            RequestTabResume(t);
                        }
                        catch { }
                    }), DispatcherPriority.Loaded);
                }
                catch { }
            }
            else if (msg.StartsWith("load_failed:"))
            {
                if (!_e2eMode)
                {
                    WinForms.MessageBox.Show(
                        "Could not load the document into the editor.\n\n"
                        + (msg.Length > 12 ? msg.Substring(12) : "Unknown error")
                        + "\n\nThe tab still holds the file text; try switching away and back.",
                        "Load failed",
                        WinForms.MessageBoxButtons.OK,
                        WinForms.MessageBoxIcon.Warning);
                }
                // Best-effort: push host buffer again as plain inline content.
                try
                {
                    if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count)
                    {
                        string c = _tabs[_activeTabIndex].Content ?? "";
                        if (c.Length > 0 && c.Length <= LoadContentInlineMaxChars * 2)
                            SendMsg("load_content_plain:" + c);
                    }
                }
                catch { }
            }
            else if (msg.StartsWith("open_file_path:"))
            {
                // MUST NOT run inline. We are inside the WebView's message callback, and
                // LoadFileFromPath blocks on a script round trip (SyncActiveTabFromEditor)
                // that the WebView cannot answer until this callback returns — so it waited
                // out the timeout. Defer to a fresh dispatcher turn so the round trip can
                // complete. Use Normal (not Background): large-file loads need the same
                // priority as menu Open, or nested script/message pumps starve.
                string path = msg.Substring(15);
                Dispatcher.BeginInvoke(new Action(() => LoadFileFromPath(path)),
                    DispatcherPriority.Normal);
            }
            else if (msg.StartsWith("mode_changed:"))
            {
                // Word Wrap is enabled or greyed out by mode, so the field has to be
                // current before the refresh runs. RenderViewSelectors sets it too, from
                // view_state:, but a mode change is reported by both and whichever
                // arrives first must leave the same answer behind.
                //
                // Native HTML/PDF/media: ignore the hidden editor's mode (prefs often
                // restore "source") so Source does not light over Reader chrome.
                if (ShouldIgnoreEditorModeChrome())
                    return;
                string m = msg.Substring(13);
                if (string.IsNullOrEmpty(m)) m = "wysiwyg";
                _editorMode = m;
                // Keep Mode pillbox and _viewMode aligned (load_content_plain only posted
                // mode_changed without a view_state, so Source lit Reader after HTML→Source).
                if (string.Equals(m, "source", StringComparison.OrdinalIgnoreCase))
                    _viewMode = "source";
                else if (string.Equals(m, "reader", StringComparison.OrdinalIgnoreCase))
                    _viewMode = "reader";
                else
                    _viewMode = "preview";
                try
                {
                    SelectSegment("btnModeSource", _viewMode == "source");
                    SelectSegment("btnModePreview", _viewMode == "preview");
                    SelectSegment("btnModeReader", _viewMode == "reader");
                }
                catch { }
                Dispatcher.BeginInvoke(new Action(RefreshEditingAvailability),
                    DispatcherPriority.Normal);
            }
            else if (msg.StartsWith("margin_changed:"))
            {
                string m = msg.Substring(15);
                UpdateMarginChecks(m);
            }
        }

        private void UpdateMarginChecks(string margin)
        {
            var mN = (MenuItem)FindElement("mMarginNarrow");
            var mR = (MenuItem)FindElement("mMarginRegular");
            var mW = (MenuItem)FindElement("mMarginWide");
            if (mN != null) mN.IsChecked = (margin == "narrow");
            if (mR != null) mR.IsChecked = (margin == "regular");
            if (mW != null) mW.IsChecked = (margin == "wide");
        }

        private static string StripLastContentFromPrefs(string prefsJson)
        {
            if (string.IsNullOrEmpty(prefsJson)) return prefsJson;
            // Prevent scratchpad from overwriting a real file load
            return Regex.Replace(prefsJson, @"\""lastContent\""\s*:\s*\""(?:\\.|[^\""])*\""\s*,?", "");
        }

        /// <summary>
        /// Host-owned settings.json fields. Page may update allowlisted view prefs only;
        /// document text is never stored here (tab session owns that).
        /// </summary>
        private sealed class HostPrefs
        {
            public int ThemeIndex;
            public string ThemeName = "";
            public string Mode = "wysiwyg";
            public bool SidebarCollapsed;
            public bool RevealOnFocus;
            public bool FocusMode;
            public bool TypewriterMode;
            public string Margin = "narrow";
            public string LastFilePath = "";
            public string LastContent = ""; // always written empty
            /// <summary>Global Search-tab recent queries (most recent first, max 8).</summary>
            public List<string> SearchHistory = new List<string>();
            /// <summary>Last text left in the Search box (restored on Alt+S).</summary>
            public string LastSearchQuery = "";
            public bool FindMatchCase;
            public bool FindWholeWord;
            /// <summary>"outline" or "search".</summary>
            public string SidebarTab = "outline";
        }

        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length + 8);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                            sb.AppendFormat(System.Globalization.CultureInfo.InvariantCulture, "\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        // JsonUnescape already defined earlier for recent-files / path parsing.

        private static string ExtractJsonString(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"");
            if (!m.Success) return null;
            return JsonUnescape(m.Groups[1].Value);
        }

        private static bool? ExtractJsonBool(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(true|false)");
            if (!m.Success) return null;
            return m.Groups[1].Value == "true";
        }

        private static int? ExtractJsonInt(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+)");
            if (!m.Success) return null;
            int v;
            if (!int.TryParse(m.Groups[1].Value, out v)) return null;
            return v;
        }

        /// <summary>
        /// Parse a JSON string array value for one key. Used for searchHistory.
        /// Returns an empty list when the key is present as [] or missing entries.
        /// Returns null when the key is absent so callers can leave the field alone.
        /// </summary>
        private static System.Collections.Generic.List<string> ExtractJsonStringArray(string json, string key)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(key)) return null;
            var head = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\\[");
            if (!head.Success) return null;
            int i = head.Index + head.Length;
            var list = new System.Collections.Generic.List<string>();
            while (i < json.Length)
            {
                while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
                if (i >= json.Length) break;
                if (json[i] == ']') break;
                if (json[i] == ',') { i++; continue; }
                if (json[i] != '"') break;
                i++; // opening quote
                var sb = new StringBuilder();
                while (i < json.Length)
                {
                    char c = json[i++];
                    if (c == '\\' && i < json.Length)
                    {
                        char n = json[i++];
                        switch (n)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                if (i + 3 < json.Length)
                                {
                                    int code;
                                    if (int.TryParse(json.Substring(i, 4),
                                        System.Globalization.NumberStyles.HexNumber,
                                        System.Globalization.CultureInfo.InvariantCulture, out code))
                                        sb.Append((char)code);
                                    i += 4;
                                }
                                break;
                            default: sb.Append(n); break;
                        }
                    }
                    else if (c == '"') break;
                    else sb.Append(c);
                }
                string s = sb.ToString().Trim();
                if (s.Length > 0 && list.Count < 8 && !list.Contains(s))
                    list.Add(s);
            }
            return list;
        }

        private static string FormatJsonStringArray(System.Collections.Generic.List<string> items)
        {
            if (items == null || items.Count == 0) return "[]";
            var sb = new StringBuilder();
            sb.Append('[');
            int n = 0;
            for (int i = 0; i < items.Count && n < 8; i++)
            {
                string s = items[i];
                if (string.IsNullOrEmpty(s)) continue;
                if (n > 0) sb.Append(',');
                sb.Append('"').Append(JsonEscape(s)).Append('"');
                n++;
            }
            sb.Append(']');
            return sb.ToString();
        }

        private HostPrefs LoadHostPrefs()
        {
            var p = new HostPrefs();
            try
            {
                string path = PrefsPath();
                if (!File.Exists(path)) return p;
                string json = File.ReadAllText(path, Encoding.UTF8);
                int? ti = ExtractJsonInt(json, "themeIndex");
                if (ti.HasValue) p.ThemeIndex = ti.Value;
                string s;
                s = ExtractJsonString(json, "themeName"); if (s != null) p.ThemeName = s;
                s = ExtractJsonString(json, "mode"); if (s != null) p.Mode = s;
                s = ExtractJsonString(json, "margin"); if (s != null) p.Margin = s;
                s = ExtractJsonString(json, "lastFilePath"); if (s != null) p.LastFilePath = s;
                // lastContent deliberately not loaded into host prefs for rewrite (always blank out)
                bool? b;
                b = ExtractJsonBool(json, "sidebarCollapsed"); if (b.HasValue) p.SidebarCollapsed = b.Value;
                b = ExtractJsonBool(json, "revealOnFocus"); if (b.HasValue) p.RevealOnFocus = b.Value;
                b = ExtractJsonBool(json, "focusMode"); if (b.HasValue) p.FocusMode = b.Value;
                b = ExtractJsonBool(json, "typewriterMode"); if (b.HasValue) p.TypewriterMode = b.Value;
                var hist = ExtractJsonStringArray(json, "searchHistory");
                if (hist != null) p.SearchHistory = hist;
                s = ExtractJsonString(json, "lastSearchQuery"); if (s != null) p.LastSearchQuery = s;
                s = ExtractJsonString(json, "sidebarTab");
                if (s == "outline" || s == "search") p.SidebarTab = s;
                b = ExtractJsonBool(json, "findMatchCase"); if (b.HasValue) p.FindMatchCase = b.Value;
                b = ExtractJsonBool(json, "findWholeWord"); if (b.HasValue) p.FindWholeWord = b.Value;
            }
            catch { }
            return p;
        }

        private void WriteHostPrefs(HostPrefs p)
        {
            if (p == null) p = new HostPrefs();
            string tab = (p.SidebarTab == "search") ? "search" : "outline";
            // Never persist document body in settings.json (tab session owns unsaved text).
            string json = "{"
                + "\"themeIndex\":" + p.ThemeIndex + ","
                + "\"themeName\":\"" + JsonEscape(p.ThemeName ?? "") + "\","
                + "\"mode\":\"" + JsonEscape(string.IsNullOrEmpty(p.Mode) ? "wysiwyg" : p.Mode) + "\","
                + "\"sidebarCollapsed\":" + (p.SidebarCollapsed ? "true" : "false") + ","
                + "\"revealOnFocus\":" + (p.RevealOnFocus ? "true" : "false") + ","
                + "\"focusMode\":" + (p.FocusMode ? "true" : "false") + ","
                + "\"typewriterMode\":" + (p.TypewriterMode ? "true" : "false") + ","
                + "\"margin\":\"" + JsonEscape(string.IsNullOrEmpty(p.Margin) ? "narrow" : p.Margin) + "\","
                + "\"lastFilePath\":\"" + JsonEscape(p.LastFilePath ?? "") + "\","
                + "\"searchHistory\":" + FormatJsonStringArray(p.SearchHistory) + ","
                + "\"lastSearchQuery\":\"" + JsonEscape(p.LastSearchQuery ?? "") + "\","
                + "\"findMatchCase\":" + (p.FindMatchCase ? "true" : "false") + ","
                + "\"findWholeWord\":" + (p.FindWholeWord ? "true" : "false") + ","
                + "\"sidebarTab\":\"" + tab + "\","
                + "\"lastContent\":\"\""
                + "}";
            string prefsPath = PrefsPath();
            string dir = Path.GetDirectoryName(prefsPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            WriteStateFileAtomic(prefsPath, json);
        }

        /// <summary>
        /// Merge allowlisted fields from a page prefs payload into host settings and write.
        /// pageJson may be null (host-only update, e.g. lastFilePath).
        /// </summary>
        private void MergeAndWriteHostPrefs(string pageJson)
        {
            var prefs = LoadHostPrefs();

            // Privacy mode keeps the view settings and drops everything that names a
            // document. Written as a wipe of the merged result rather than as conditions on
            // each assignment below, so a field added later is suppressed by default instead
            // of leaking until someone remembers this exists.
            bool priv = SuppressDocumentTraces();

            if (!string.IsNullOrEmpty(pageJson))
            {
                int? ti = ExtractJsonInt(pageJson, "themeIndex");
                if (ti.HasValue && ti.Value >= 0) prefs.ThemeIndex = ti.Value;

                string s = ExtractJsonString(pageJson, "themeName");
                if (s != null) prefs.ThemeName = s;

                s = ExtractJsonString(pageJson, "mode");
                if (s == "source" || s == "wysiwyg") prefs.Mode = s;

                s = ExtractJsonString(pageJson, "margin");
                if (s == "narrow" || s == "regular" || s == "wide") prefs.Margin = s;

                bool? b;
                b = ExtractJsonBool(pageJson, "sidebarCollapsed"); if (b.HasValue) prefs.SidebarCollapsed = b.Value;
                b = ExtractJsonBool(pageJson, "revealOnFocus"); if (b.HasValue) prefs.RevealOnFocus = b.Value;
                b = ExtractJsonBool(pageJson, "focusMode"); if (b.HasValue) prefs.FocusMode = b.Value;
                b = ExtractJsonBool(pageJson, "typewriterMode"); if (b.HasValue) prefs.TypewriterMode = b.Value;
                var hist = ExtractJsonStringArray(pageJson, "searchHistory");
                if (hist != null && !priv) prefs.SearchHistory = hist;
                s = ExtractJsonString(pageJson, "lastSearchQuery");
                if (s != null && !priv) prefs.LastSearchQuery = s;
                s = ExtractJsonString(pageJson, "sidebarTab");
                if (s == "outline" || s == "search" || s == "marks") prefs.SidebarTab = s;
                b = ExtractJsonBool(pageJson, "findMatchCase"); if (b.HasValue) prefs.FindMatchCase = b.Value;
                b = ExtractJsonBool(pageJson, "findWholeWord"); if (b.HasValue) prefs.FindWholeWord = b.Value;
                // lastContent from page is ignored (document text does not belong in settings).
            }

            // Host authority for path + theme name alignment with live UI.
            if (!string.IsNullOrEmpty(_currentFilePath) && !priv)
                prefs.LastFilePath = _currentFilePath;
            // Belt and braces: in privacy mode the fields that name a document are cleared
            // on the way out, so a value merged in from an older file cannot survive.
            if (priv)
            {
                prefs.LastFilePath = "";
                prefs.LastContent = "";
                prefs.LastSearchQuery = "";
                prefs.SearchHistory = new List<string>();
            }
            if (_currentThemeIndex >= 0 && _currentThemeIndex < _themesList.Count)
            {
                prefs.ThemeIndex = _currentThemeIndex;
                if (!string.IsNullOrEmpty(_themesList[_currentThemeIndex].Name))
                    prefs.ThemeName = _themesList[_currentThemeIndex].Name;
            }

            prefs.LastContent = "";
            WriteHostPrefs(prefs);
        }

        /// <summary>
        /// Warn once when a file is not plain UTF-8: save will rewrite as UTF-8 (no BOM).
        /// </summary>
        private void MaybeWarnEncodingConversion(string path, string encodingName)
        {
            if (_e2eMode || _encodingWarnDisabled) return;
            if (string.IsNullOrEmpty(encodingName) || encodingName == "UTF-8") return;

            var res = WinForms.MessageBox.Show(
                "This file was opened as:\n  " + encodingName + "\n\n" +
                "When you save, TypoZen will write UTF-8 without a BOM.\n" +
                "Your text is kept; only the on-disk encoding changes.\n\n" +
                (string.IsNullOrEmpty(path) ? "" : ("File:\n  " + path + "\n\n")) +
                "Yes = OK\n" +
                "No = Don't show this warning again",
                "Encoding notice",
                WinForms.MessageBoxButtons.YesNo,
                WinForms.MessageBoxIcon.Information,
                WinForms.MessageBoxDefaultButton.Button1);

            if (res == WinForms.DialogResult.No)
            {
                _encodingWarnDisabled = true;
                try { SaveWindowState(); } catch { }
            }
        }

        private void SetMenuChecked(string name, bool isChecked)
        {
            var mi = FindElement(name) as MenuItem;
            if (mi != null) mi.IsChecked = isChecked;
        }


        private void PopulateThemeDropdown(string json, int startIdx = 0, string preferredName = null)
        {
            _themesList.Clear();
            // Must be cleared with the rest. ApplyTheme ticks _themeMenuItems[idx], so this
            // list is only meaningful while it is index-parallel to _themesList. Saving a
            // custom theme re-reads the JSON and rebuilds everything else, so leaving this
            // one to grow left every tick landing on a stale MenuItem from the previous
            // build -- the checkmark stayed on whatever was selected before, and clicking a
            // custom theme appeared to do nothing because the item WPF had just ticked was
            // cleared again by the mismatched loop.
            _themeMenuItems.Clear();
            if (_cmbThemes != null) _cmbThemes.Items.Clear();

            var menu = (MenuItem)FindElement("mThemesMenu");
            if (menu != null) menu.Items.Clear();

            try
            {
                var objects = Regex.Matches(json, @"\{[^{}]+\}");
                int idx = 0;
                
                var colDark = new StackPanel { Margin = new Thickness(0, 0, 16, 0) };
                var colLight = new StackPanel { Margin = new Thickness(0, 0, 16, 0) };
                var colMono = new StackPanel { Margin = new Thickness(0, 0, 0, 0) };
                
                var darkHeader = new TextBlock { Text = "Dark Themes", FontWeight = FontWeights.SemiBold, Opacity = 0.5, Margin = new Thickness(12, 4, 8, 8), FontSize = 11 };
                var lightHeader = new TextBlock { Text = "Light Themes", FontWeight = FontWeights.SemiBold, Opacity = 0.5, Margin = new Thickness(12, 4, 8, 8), FontSize = 11 };
                var monoHeader = new TextBlock { Text = "Mono Themes", FontWeight = FontWeights.SemiBold, Opacity = 0.5, Margin = new Thickness(12, 4, 8, 8), FontSize = 11 };
                
                colDark.Children.Add(darkHeader);
                colLight.Children.Add(lightHeader);
                colMono.Children.Add(monoHeader);

                int customCount = 0;
                var customItems = new List<MenuItem>();
                var darkItems = new List<MenuItem>();
                var lightItems = new List<MenuItem>();
                var monoItems = new List<MenuItem>();

                foreach (Match om in objects)
                {
                    string obj = om.Value;
                    var nameM = Regex.Match(obj, @"\""Name\""\s*:\s*\""([^\""]+)\""");
                    var fnM = Regex.Match(obj, @"\""FN\""\s*:\s*\""([^\""]+)\""");
                    var fsM = Regex.Match(obj, @"\""FS\""\s*:\s*(\d+)");
                    var bgM = Regex.Match(obj, @"\""Bg\""\s*:\s*\""([^\""]+)\""");
                    var txM = Regex.Match(obj, @"\""Tx\""\s*:\s*\""([^\""]+)\""");
                    var hiM = Regex.Match(obj, @"\""Hi\""\s*:\s*\""([^\""]+)\""");
                    if (!nameM.Success || !bgM.Success || !txM.Success || !hiM.Success) continue;

                    string themeName = nameM.Groups[1].Value;
                    string fn = fnM.Success ? fnM.Groups[1].Value : "'Segoe UI', sans-serif";
                    int fs = 14;
                    if (fsM.Success) int.TryParse(fsM.Groups[1].Value, out fs);
                    string bg = bgM.Groups[1].Value;
                    string tx = txM.Groups[1].Value;
                    string hi = hiM.Groups[1].Value;
                    bool custom = Regex.IsMatch(obj, @"\""Custom\""\s*:\s*true", RegexOptions.IgnoreCase);
                    _themesList.Add(new ThemeInfo { Name = themeName, FN = fn, FS = fs, Bg = bg, Tx = tx, Hi = hi, Custom = custom });

                    int currentIdx = idx;
                    if (_cmbThemes != null) _cmbThemes.Items.Add(themeName);

                    if (menu != null)
                    {
                        var mi = new MenuItem { Header = themeName, IsCheckable = true };
                        _themeMenuItems.Add(mi);
                        mi.Click += (s, ev) => {
                            if (_cmbThemes != null) _cmbThemes.SelectedIndex = currentIdx;
                            else ApplyTheme(currentIdx);
                            menu.IsSubmenuOpen = false;
                        };

                        if (custom)
                        {
                            customItems.Add(mi);
                            customCount++;
                        }
                        else if (fn.IndexOf("mono", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            monoItems.Add(mi);
                        }
                        else
                        {
                            bool isLight = false;
                            try
                            {
                                var c = (Color)ColorConverter.ConvertFromString(bg);
                                double brightness = 0.299 * c.R + 0.587 * c.G + 0.114 * c.B;
                                isLight = brightness > 128;
                            }
                            catch { }

                            if (isLight) lightItems.Add(mi);
                            else darkItems.Add(mi);
                        }
                    }
                    idx++;
                }

                if (menu != null)
                {
                    darkItems.Sort((a, b) => string.Compare(a.Header.ToString(), b.Header.ToString(), StringComparison.OrdinalIgnoreCase));
                    lightItems.Sort((a, b) => string.Compare(a.Header.ToString(), b.Header.ToString(), StringComparison.OrdinalIgnoreCase));
                    monoItems.Sort((a, b) => string.Compare(a.Header.ToString(), b.Header.ToString(), StringComparison.OrdinalIgnoreCase));
                    customItems.Sort((a, b) => string.Compare(a.Header.ToString(), b.Header.ToString(), StringComparison.OrdinalIgnoreCase));

                    foreach (var m in darkItems) colDark.Children.Add(m);
                    foreach (var m in lightItems) colLight.Children.Add(m);
                    foreach (var m in monoItems) colMono.Children.Add(m);

                    if (customCount > 0)
                    {
                        colMono.Children.Add(new Border { Height = 1, Background = Brushes.Gray, Opacity = 0.3, Margin = new Thickness(12, 6, 12, 6) });
                        colMono.Children.Add(new TextBlock { Text = "Custom Themes", FontWeight = FontWeights.SemiBold, Opacity = 0.5, Margin = new Thickness(12, 4, 8, 4), FontSize = 11 });
                        foreach (var cmi in customItems)
                            colMono.Children.Add(cmi);
                    }

                    var customize = new TextBlock 
                    { 
                        Text = "Customise Theme...", 
                        FontWeight = FontWeights.SemiBold, 
                        TextAlignment = TextAlignment.Center,
                        Padding = new Thickness(0, 8, 0, 8),
                        Background = Brushes.Transparent,
                        Cursor = Cursors.Hand
                    };
                    customize.MouseEnter += (s, ev) => customize.Background = new SolidColorBrush(Color.FromArgb(20, 128, 128, 128));
                    customize.MouseLeave += (s, ev) => customize.Background = Brushes.Transparent;
                    customize.MouseDown += (s, ev) => { 
                        menu.IsSubmenuOpen = false; 
                        OpenThemeCustomize(); 
                    };

                    var grid = new Grid();
                    grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                    grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

                    grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                    Grid.SetColumn(colDark, 0); Grid.SetRow(colDark, 0);
                    Grid.SetColumn(colLight, 1); Grid.SetRow(colLight, 0);
                    Grid.SetColumn(colMono, 2); Grid.SetRow(colMono, 0);

                    grid.Children.Add(colDark);
                    grid.Children.Add(colLight);
                    grid.Children.Add(colMono);
                    
                    var bottomPanel = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
                    bottomPanel.Children.Add(new Border { Height = 1, Background = Brushes.Gray, Opacity = 0.3, Margin = new Thickness(12, 0, 12, 6) });
                    bottomPanel.Children.Add(customize);

                    Grid.SetRow(bottomPanel, 1);
                    Grid.SetColumn(bottomPanel, 0);
                    Grid.SetColumnSpan(bottomPanel, 3);
                    grid.Children.Add(bottomPanel);
                    
                    var containerMi = new MenuItem { Header = grid, StaysOpenOnClick = true };
                    
                    var template = new ControlTemplate(typeof(MenuItem));
                    var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
                    presenter.SetBinding(ContentPresenter.ContentProperty, new System.Windows.Data.Binding("Header") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
                    template.VisualTree = presenter;
                    containerMi.Template = template;

                    menu.Items.Add(containerMi);
                }

                int resolve = startIdx;
                if (!string.IsNullOrEmpty(preferredName))
                {
                    int byName = _themesList.FindIndex(t => string.Equals(t.Name, preferredName, StringComparison.OrdinalIgnoreCase));
                    if (byName >= 0) resolve = byName;
                }
                if (resolve < 0 || resolve >= _themesList.Count) resolve = 0;

                if (_cmbThemes != null && _cmbThemes.Items.Count > resolve) _cmbThemes.SelectedIndex = resolve;
                else if (_cmbThemes != null && _cmbThemes.Items.Count > 0) _cmbThemes.SelectedIndex = 0;
                else if (_themesList.Count > resolve) ApplyTheme(resolve);
                else if (_themesList.Count > 0) ApplyTheme(0);
            }
            catch {}
        }

        private void OpenThemeCustomize()
        {
            ThemeInfo seed;
            if (_currentThemeIndex >= 0 && _currentThemeIndex < _themesList.Count)
                seed = CloneTheme(_themesList[_currentThemeIndex]);
            else if (_themesList.Count > 0)
                seed = CloneTheme(_themesList[0]);
            else
                seed = new ThemeInfo
                {
                    Name = "My Theme",
                    FN = "'Inter', 'Segoe UI', sans-serif",
                    FS = 14,
                    Bg = "#1E1E1E",
                    Tx = "#D4D4D4",
                    Hi = "#007ACC"
                };

            int restoreIdx = _currentThemeIndex;
            var dlg = new ThemeCustomizeWindow(seed, FontPresets, this.Background, this.Foreground);
            dlg.Owner = this;
            dlg.PreviewRequested += (t) => PreviewTheme(t);
            dlg.SaveAsNewRequested += (t) =>
            {
                if (SaveThemeAsNew(t))
                {
                    dlg.DialogResult = true;
                    dlg.Close();
                }
            };
            dlg.DeleteRequested += () =>
            {
                if (DeleteTheme(restoreIdx))
                {
                    dlg.DialogResult = true;
                    dlg.Close();
                }
            };

            bool? result = dlg.ShowDialog();
            if (result != true)
            {
                // Cancel or close without save — restore previous theme
                if (restoreIdx >= 0 && restoreIdx < _themesList.Count)
                    ApplyTheme(restoreIdx);
            }
        }

        private static ThemeInfo CloneTheme(ThemeInfo t)
        {
            if (t == null) return null;
            return new ThemeInfo
            {
                Name = t.Name,
                FN = t.FN,
                FS = t.FS,
                Bg = t.Bg,
                Tx = t.Tx,
                Hi = t.Hi,
                Custom = t.Custom
            };
        }

        private void PreviewTheme(ThemeInfo t)
        {
            if (t == null) return;
            ApplyThemeChrome(t);
            // Live preview in WebView without writing prefs / changing themeIndex
            string payload = BuildThemeJsonObject(t);
            SendMsg("preview_theme:" + payload);
        }

        private bool SaveThemeAsNew(ThemeInfo t)
        {
            if (t == null) return false;
            string name = (t.Name ?? "").Trim();
            if (string.IsNullOrEmpty(name))
            {
                WinForms.MessageBox.Show("Please enter a theme name.", "Customise Theme",
                    WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
                return false;
            }
            if (!IsValidHexColor(t.Bg) || !IsValidHexColor(t.Tx) || !IsValidHexColor(t.Hi))
            {
                WinForms.MessageBox.Show("Colors must be #RRGGBB hex values.", "Customise Theme",
                    WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Warning);
                return false;
            }
            if (string.IsNullOrWhiteSpace(t.FN))
                t.FN = "'Inter', 'Segoe UI', sans-serif";
            if (t.FS < 10 || t.FS > 28) t.FS = 14;

            // Avoid exact name collisions
            string baseName = name;
            int n = 2;
            while (_themesList.Exists(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase)))
            {
                name = baseName + " (" + n + ")";
                n++;
            }
            t.Name = name;

            try
            {
                _themesList.Add(new ThemeInfo
                {
                    Name = t.Name,
                    FN = t.FN,
                    FS = t.FS,
                    Bg = NormalizeHex(t.Bg),
                    Tx = NormalizeHex(t.Tx),
                    Hi = NormalizeHex(t.Hi),
                    Custom = true      // user-created: eligible for Delete Theme
                });

                string themesPath = Path.Combine(_appDir, "TypoZen_Themes.json");
                string json = SerializeThemesJson(_themesList);
                File.WriteAllText(themesPath, json, new UTF8Encoding(false));

                int newIdx = _themesList.Count - 1;
                PopulateThemeDropdown(json, newIdx, t.Name);
                SendMsg("init_themes:" + json);
                ApplyTheme(newIdx);
                return true;
            }
            catch (Exception ex)
            {
                WinForms.MessageBox.Show("Could not save theme:\n" + ex.Message, "Customise Theme",
                    WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                return false;
            }
        }

        private static bool IsValidHexColor(string hex)
        {
            if (string.IsNullOrWhiteSpace(hex)) return false;
            hex = hex.Trim();
            return Regex.IsMatch(hex, @"^#([0-9A-Fa-f]{6})$");
        }

        private static string NormalizeHex(string hex)
        {
            if (string.IsNullOrWhiteSpace(hex)) return "#000000";
            hex = hex.Trim();
            if (hex.Length == 7 && hex[0] == '#')
                return "#" + hex.Substring(1).ToUpperInvariant();
            return hex;
        }

        private static string EscapeJson(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static string BuildThemeJsonObject(ThemeInfo t)
        {
            return string.Format(
                "{{\"Name\":\"{0}\",\"FN\":\"{1}\",\"FS\":{2},\"Bg\":\"{3}\",\"Tx\":\"{4}\",\"Hi\":\"{5}\"{6}}}",
                EscapeJson(t.Name ?? "Preview"),
                EscapeJson(t.FN ?? "'Segoe UI', sans-serif"),
                t.FS > 0 ? t.FS : 14,
                EscapeJson(NormalizeHex(t.Bg)),
                EscapeJson(NormalizeHex(t.Tx)),
                EscapeJson(NormalizeHex(t.Hi)),
                t.Custom ? ",\"Custom\":true" : "");
        }

        /// <summary>
        /// Delete a theme the user created. Built-in themes are refused — they are part of
        /// the shipped set, and removing one would be silently undone by any reinstall.
        /// </summary>
        private bool DeleteTheme(int idx)
        {
            if (idx < 0 || idx >= _themesList.Count) return false;
            var victim = _themesList[idx];

            if (!victim.Custom)
            {
                WinForms.MessageBox.Show(
                    "\"" + victim.Name + "\" is a built-in theme and cannot be deleted.\n\n"
                    + "Only themes you created with Customise Theme can be removed.",
                    "Delete Theme", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
                return false;
            }
            if (_themesList.Count <= 1)
            {
                WinForms.MessageBox.Show("This is the only theme left.", "Delete Theme",
                    WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
                return false;
            }
            if (WinForms.MessageBox.Show(
                    "Delete the theme \"" + victim.Name + "\"?\n\nThis cannot be undone.",
                    "Delete Theme", WinForms.MessageBoxButtons.YesNo,
                    WinForms.MessageBoxIcon.Warning) != WinForms.DialogResult.Yes) return false;

            try
            {
                _themesList.RemoveAt(idx);

                // Land on a valid neighbour; if the deleted theme was active, move off it.
                int next = _currentThemeIndex;
                if (next == idx) next = Math.Max(0, idx - 1);
                else if (next > idx) next--;
                if (next < 0 || next >= _themesList.Count) next = 0;

                string themesPath = Path.Combine(_appDir, "TypoZen_Themes.json");
                string json = SerializeThemesJson(_themesList);
                File.WriteAllText(themesPath, json, new UTF8Encoding(false));

                PopulateThemeDropdown(json, next, _themesList[next].Name);
                SendMsg("init_themes:" + json);
                ApplyTheme(next);
                return true;
            }
            catch (Exception ex)
            {
                WinForms.MessageBox.Show("Could not delete theme:\n" + ex.Message, "Delete Theme",
                    WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                return false;
            }
        }

        private static string SerializeThemesJson(List<ThemeInfo> list)
        {
            var sb = new StringBuilder();
            sb.AppendLine("[");
            for (int i = 0; i < list.Count; i++)
            {
                var t = list[i];
                sb.Append("  ");
                sb.Append(BuildThemeJsonObject(t));
                if (i < list.Count - 1) sb.Append(",");
                sb.AppendLine();
            }
            sb.Append("]");
            sb.AppendLine();
            return sb.ToString();
        }

        private void ApplyTheme(int idx)
        {
            if (idx < 0 || idx >= _themesList.Count) return;
            _currentThemeIndex = idx;
            SendMsg("set_theme:" + idx);
            var t = _themesList[idx];

            if (_cmbThemes != null && _cmbThemes.SelectedIndex != idx)
            {
                _cmbThemes.SelectedIndex = idx;
            }
            if (_themeMenuItems != null)
            {
                for (int i = 0; i < _themeMenuItems.Count; i++)
                {
                    if (_themeMenuItems[i] != null) _themeMenuItems[i].IsChecked = (i == idx);
                }
            }

            ApplyThemeChrome(t);
        }

        /// <summary>Apply Bg/Tx/Hi to WPF chrome (shared by ApplyTheme and live preview).</summary>
        private void ApplyThemeChrome(ThemeInfo t)
        {
            if (t == null) return;
            try
            {
                var conv = new BrushConverter();
                var bgBrush = (SolidColorBrush)conv.ConvertFromString(t.Bg); bgBrush.Freeze();
                var txBrush = (SolidColorBrush)conv.ConvertFromString(t.Tx); txBrush.Freeze();
                var hiBrush = (SolidColorBrush)conv.ConvertFromString(t.Hi); hiBrush.Freeze();

                bool isLight = IsColorLight(t.Bg);
                var hoverBgBrush = (SolidColorBrush)conv.ConvertFromString(AdjustHexBrightness(t.Bg, isLight ? -0.06f : 0.08f)); hoverBgBrush.Freeze();
                var borderBrush = (SolidColorBrush)conv.ConvertFromString(AdjustHexBrightness(t.Bg, isLight ? -0.15f : 0.15f)); borderBrush.Freeze();
                var hoverTxBrush = (SolidColorBrush)conv.ConvertFromString(IsColorLight(t.Hi) ? "#000000" : "#FFFFFF"); hoverTxBrush.Freeze();
                var mutedTxBrush = (SolidColorBrush)conv.ConvertFromString(AdjustHexBrightness(t.Tx, isLight ? 0.25f : -0.25f)); mutedTxBrush.Freeze();
                // Mode toggle: outline stronger than ActiveBorder alone (visible on light/parchment).
                _modeGhostBorder = (SolidColorBrush)conv.ConvertFromString(AdjustHexBrightness(t.Bg, isLight ? -0.28f : 0.32f));
                _modeGhostBorder.Freeze();
                _modeGhostFg = txBrush;
                _modeSourceBorder = hiBrush;
                try
                {
                    var c = (Color)ColorConverter.ConvertFromString(t.Hi);
                    // 0x28 was too faint for every theme, not just the awkward ones: even
                    // Obsidian Pure, whose accent contrasts with its background at 19.5,
                    // produced a selection fill of only 1.400 against it (1.0 being
                    // invisible). Diluting any colour to 16% gives a weak result.
                    //
                    // 0x48 is the smallest opacity at which all 27 themes clear a 1.25
                    // contrast ratio, worst case 1.288. It is a single constant because a
                    // single constant is now sufficient: the three themes that needed more
                    // did so because their accent was too close to their background, and
                    // that is fixed in TypoZen_Themes.json where it belongs.
                    // tests/theme-contrast-selftest.mjs holds both halves of that.
                    c.A = SelectionFillAlpha;
                    _modeSourceBg = new SolidColorBrush(c);
                    _modeSourceBg.Freeze();
                }
                catch
                {
                    _modeSourceBg = Brushes.Transparent;
                }

                // The selected segment is painted with _modeSourceBg at the moment it is
                // rendered, so a theme change has to repaint it. Without this it kept
                // whatever brush it was first drawn with -- on startup that is the #33A855F7
                // purple default, which then sat there clashing with every warm theme.
                RenderViewSelectors(_viewMode, _viewColumns, _viewScroll,
                                    _viewColumnsLocked, _viewScrollLocked);
                // Painted from a message rather than from the view state, so it needs
                // repainting here too or it keeps the previous theme's accent.
                SetToolbarActive(FindElement("btnToggleSidebar") as Button, _sidebarOpen);

                this.Background = bgBrush;
                this.Foreground = txBrush;

                var wpfColor = bgBrush.Color;
                _currentThemeBg = System.Drawing.Color.FromArgb(wpfColor.A, wpfColor.R, wpfColor.G, wpfColor.B);
                if (_webView != null)
                {
                    _webView.BackColor = _currentThemeBg;
                    try { _webView.DefaultBackgroundColor = _currentThemeBg; } catch {}
                }
                var borderContainer = (Border)FindElement("webViewContainer");
                if (borderContainer != null)
                {
                    var h = borderContainer.Child as WindowsFormsHost;
                    if (h != null) h.Background = bgBrush;
                }

                this.Resources[SystemColors.MenuBrushKey] = bgBrush;
                this.Resources[SystemColors.MenuBarBrushKey] = bgBrush;
                this.Resources[SystemColors.MenuTextBrushKey] = txBrush;
                this.Resources[SystemColors.MenuHighlightBrushKey] = hiBrush;
                this.Resources[SystemColors.HighlightBrushKey] = hiBrush;
                this.Resources[SystemColors.HighlightTextBrushKey] = hoverTxBrush;
                this.Resources[SystemColors.ControlBrushKey] = bgBrush;
                this.Resources[SystemColors.ControlTextBrushKey] = txBrush;
                this.Resources[SystemColors.WindowBrushKey] = bgBrush;
                this.Resources[SystemColors.WindowTextBrushKey] = txBrush;
                this.Resources[SystemColors.ActiveBorderBrushKey] = borderBrush;

                // Elevated command surface (menu + active tab); tab strip keeps base bg.
                var chromeElevated = (SolidColorBrush)conv.ConvertFromString(AdjustHexBrightness(t.Bg, isLight ? -0.06f : 0.08f));
                chromeElevated.Freeze();

                var topMenu = FindElement("topMenu") as Menu;
                if (topMenu != null)
                {
                    topMenu.Background = chromeElevated;
                    topMenu.Foreground = txBrush;
                    foreach (object item in topMenu.Items)
                    {
                        var mi = item as MenuItem;
                        if (mi != null)
                        {
                            mi.ClearValue(MenuItem.ForegroundProperty);
                            mi.Background = Brushes.Transparent;
                            foreach (object subItem in mi.Items)
                            {
                                var subMi = subItem as MenuItem;
                                if (subMi != null)
                                {
                                    subMi.ClearValue(MenuItem.ForegroundProperty);
                                    subMi.ClearValue(MenuItem.BackgroundProperty);
                                    foreach (object subSubItem in subMi.Items)
                                    {
                                        var subSubMi = subSubItem as MenuItem;
                                        var subSubSep = subSubItem as Separator;
                                        if (subSubMi != null)
                                        {
                                            subSubMi.ClearValue(MenuItem.ForegroundProperty);
                                            subSubMi.ClearValue(MenuItem.BackgroundProperty);
                                        }
                                        else if (subSubSep != null) subSubSep.Background = borderBrush;
                                    }
                                }
                                else
                                {
                                    var sep = subItem as Separator;
                                    if (sep != null) sep.Background = borderBrush;
                                }
                            }
                        }
                    }
                }
                // Tab strip and command bar; seam is tabSeam (behind tabs), not a Border stroke.
                var tabBand = FindElement("tabBar") as Border;
                if (tabBand != null)
                {
                    tabBand.Background = bgBrush;
                    tabBand.BorderThickness = new Thickness(0);
                }
                var seam = FindElement("tabSeam") as System.Windows.Shapes.Rectangle;
                if (seam != null)
                {
                    seam.Fill = borderBrush;
                    seam.Visibility = _chromeHidden ? Visibility.Collapsed : Visibility.Visible;
                }
                foreach (string capName in new[] { "btnWinMin", "btnWinMax", "btnWinClose" })
                {
                    var cap = FindElement(capName) as Button;
                    if (cap == null) continue;
                    cap.Foreground = txBrush;
                    cap.Background = Brushes.Transparent;
                    cap.BorderBrush = Brushes.Transparent;
                }
                var toolbar = FindElement("topToolbar") as Border;
                if (toolbar != null)
                {
                    toolbar.Background = chromeElevated;
                    toolbar.BorderBrush = borderBrush;
                }
                // Format dropdowns sit on the command bar
                foreach (string menuName in new string[] { "headingMenu", "listMenu", "tableMenu" })
                {
                    var tbMenu = FindElement(menuName) as Menu;
                    if (tbMenu == null) continue;
                    tbMenu.Background = Brushes.Transparent;
                    tbMenu.Foreground = txBrush;
                    foreach (object item in tbMenu.Items)
                    {
                        var mi = item as MenuItem;
                        if (mi == null) continue;
                        mi.ClearValue(MenuItem.ForegroundProperty);
                        mi.ClearValue(MenuItem.BackgroundProperty);
                        foreach (object sub in mi.Items)
                        {
                            var subMi = sub as MenuItem;
                            if (subMi != null)
                            {
                                subMi.ClearValue(MenuItem.ForegroundProperty);
                                subMi.ClearValue(MenuItem.BackgroundProperty);
                            }
                        }
                    }
                }
                var statusBar = FindElement("statusBar") as Border;
                if (statusBar != null)
                {
                    statusBar.Background = bgBrush;
                    statusBar.BorderBrush = borderBrush;
                }
                var themeBorder = FindElement("themeIndicatorBorder") as Border;
                if (themeBorder != null) themeBorder.Background = hoverBgBrush;
                var lblThemeName = FindElement("lblThemeName") as TextBlock;
                if (lblThemeName != null)
                {
                    lblThemeName.Text = "Theme: " + t.Name;
                    lblThemeName.Foreground = hiBrush;
                }

                var lblStatus = FindElement("lblStatus") as TextBlock;
                if (lblStatus != null) lblStatus.Foreground = txBrush;
                var lblFilePath = FindElement("lblFilePath") as TextBlock;
                if (lblFilePath != null) lblFilePath.Foreground = mutedTxBrush;
                var lblWordCount = FindElement("lblWordCount") as TextBlock;
                if (lblWordCount != null) lblWordCount.Foreground = txBrush;
                var lblLineCount = FindElement("lblLineCount") as TextBlock;
                if (lblLineCount != null) lblLineCount.Foreground = txBrush;
                var lblCharCount = FindElement("lblCharCount") as TextBlock;
                if (lblCharCount != null) lblCharCount.Foreground = mutedTxBrush;
                var lblReadingTime = FindElement("lblReadingTime") as TextBlock;
                if (lblReadingTime != null) lblReadingTime.Foreground = mutedTxBrush;
                var lblZoom = FindElement("lblZoom") as TextBlock;
                if (lblZoom != null) lblZoom.Foreground = mutedTxBrush;

                _tabActiveBg = chromeElevated;
                _tabInactiveBg = Brushes.Transparent; // borderless labels on the strip
                _tabActiveBorder = borderBrush;
                _tabInactiveBorder = Brushes.Transparent;
                // Subtle lift on inactive hover (lighter/darker than title strip, softer than menu).
                _tabHoverBg = (SolidColorBrush)conv.ConvertFromString(AdjustHexBrightness(t.Bg, isLight ? -0.04f : 0.05f));
                _tabHoverBg.Freeze();
                _tabText = txBrush;
                _tabTextMuted = mutedTxBrush;
                RebuildTabStrip();
            }
            catch {}
        }

        private bool IsColorLight(string hex)
        {
            try
            {
                var c = (Color)ColorConverter.ConvertFromString(hex);
                double luminance = (0.299 * c.R + 0.587 * c.G + 0.114 * c.B) / 255.0;
                return luminance > 0.5;
            }
            catch { return false; }
        }

        private string AdjustHexBrightness(string hex, float factor)
        {
            try
            {
                var c = (Color)ColorConverter.ConvertFromString(hex);
                int r = (int)Math.Min(255, Math.Max(0, c.R + (255 * factor)));
                int g = (int)Math.Min(255, Math.Max(0, c.G + (255 * factor)));
                int b = (int)Math.Min(255, Math.Max(0, c.B + (255 * factor)));
                return string.Format("#{0:X2}{1:X2}{2:X2}", r, g, b);
            }
            catch { return hex; }
        }

        // --- Images -------------------------------------------------------------
        // The page is served from https://localapp/ (mapped to the app folder), so a
        // relative "![](pic.png)" beside the DOCUMENT would resolve against the app
        // folder and show a broken image. Map the current document's folder to a second
        // virtual host and rewrite relative image sources onto it at render time.
        private string _mappedDocFolder;

        private void MapDocumentFolder(string filePath)
        {
            try
            {
                if (_webView == null || _webView.CoreWebView2 == null) return;
                string dir = null;
                if (!string.IsNullOrEmpty(filePath))
                {
                    try { dir = Path.GetDirectoryName(Path.GetFullPath(filePath)); } catch { dir = null; }
                }
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return;
                if (string.Equals(dir, _mappedDocFolder, StringComparison.OrdinalIgnoreCase)) return;

                try { _webView.CoreWebView2.ClearVirtualHostNameToFolderMapping("docfolder"); } catch { }
                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "docfolder", dir, CoreWebView2HostResourceAccessKind.DenyCors);
                _mappedDocFolder = dir;
                SendMsg("doc_folder_mapped");
            }
            catch { }
        }

        /// <summary>
        /// Save a pasted/dropped image beside the document and return the relative path
        /// to reference it with. Assets live in "&lt;document&gt;-assets/" so they travel
        /// with the file and never collide between documents in one folder.
        /// </summary>
        /// <summary>
        /// Folder that holds a document's images. The name is sanitised because it ends up
        /// inside a URL: "my notes.md" produced "my notes-assets/", and the raw space made
        /// the image request fail silently. Save and prune must derive it identically.
        /// </summary>
        private static string AssetFolderName(string docPath)
        {
            string baseName = Path.GetFileNameWithoutExtension(docPath) ?? "document";
            string safe = Regex.Replace(baseName, @"[^A-Za-z0-9._-]+", "_").Trim('_');
            if (safe.Length == 0) safe = "document";
            return safe + "-assets";
        }

        private string SaveImageBesideDocument(byte[] bytes, string extension)
        {
            if (bytes == null || bytes.Length == 0) return null;
            if (string.IsNullOrEmpty(_currentFilePath))
            {
                WinForms.MessageBox.Show(
                    "Save the document first.\n\nImages are stored next to the file, so TypoZen needs to know where it lives.",
                    "Paste image", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
                return null;
            }

            string docDir = Path.GetDirectoryName(Path.GetFullPath(_currentFilePath));
            string assetDirName = AssetFolderName(_currentFilePath);
            string assetDir = Path.Combine(docDir, assetDirName);
            Directory.CreateDirectory(assetDir);

            string ext = string.IsNullOrEmpty(extension) ? "png" : extension.TrimStart('.').ToLowerInvariant();
            if (!Regex.IsMatch(ext, "^[a-z0-9]{1,5}$")) ext = "png";

            string name = "image-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "." + ext;
            string full = Path.Combine(assetDir, name);
            for (int i = 2; File.Exists(full) && i < 500; i++)
            {
                name = "image-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + i + "." + ext;
                full = Path.Combine(assetDir, name);
            }

            File.WriteAllBytes(full, bytes);
            MapDocumentFolder(_currentFilePath);
            return assetDirName + "/" + name;   // forward slashes: this goes into markdown
        }

        /// <summary>
        /// Remove asset files that the saved document no longer references.
        ///
        /// Deliberately runs on SAVE, not on every edit: deleting an image and undoing
        /// before saving must not cost you the file. Files go to the Recycle Bin, never
        /// a hard delete, and only files inside THIS document's own "-assets" folder are
        /// ever touched — an image you referenced by an absolute or shared path is not
        /// ours to remove.
        /// </summary>
        private void PruneOrphanedAssets(string docPath, string savedContent)
        {
            try
            {
                if (string.IsNullOrEmpty(docPath)) return;
                string full = Path.GetFullPath(docPath);
                string docDir = Path.GetDirectoryName(full);
                string baseName = Path.GetFileNameWithoutExtension(full);
                string assetDirName = AssetFolderName(full);
                string assetDir = Path.Combine(docDir, assetDirName);
                if (!Directory.Exists(assetDir)) return;

                // Collect every asset this folder's documents still reference. Sibling
                // documents that share a base name (notes.md and notes.txt) share the
                // asset folder, so union their references or saving one would prune the
                // other's images.
                var referenced = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                Action<string> collect = text =>
                {
                    if (string.IsNullOrEmpty(text)) return;
                    foreach (Match m in Regex.Matches(text, @"!\[[^\]]*\]\(([^)]+)\)"))
                    {
                        string target = m.Groups[1].Value.Trim().Replace('\\', '/');
                        int hash = target.IndexOfAny(new[] { '#', '?' });
                        if (hash >= 0) target = target.Substring(0, hash);
                        string prefix = assetDirName + "/";
                        if (target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                            referenced.Add(Path.GetFileName(target));
                    }
                };

                collect(savedContent);
                foreach (string sibling in Directory.GetFiles(docDir, baseName + ".*"))
                {
                    if (string.Equals(Path.GetFullPath(sibling), full, StringComparison.OrdinalIgnoreCase)) continue;
                    try { collect(File.ReadAllText(sibling)); } catch { }
                }
                // Open tabs may still hold unsaved image refs for this asset folder.
                for (int ti = 0; ti < _tabs.Count; ti++)
                {
                    var t = _tabs[ti];
                    if (t == null || string.IsNullOrEmpty(t.FilePath)) continue;
                    try
                    {
                        string tFull = Path.GetFullPath(t.FilePath);
                        if (string.Equals(tFull, full, StringComparison.OrdinalIgnoreCase)) continue;
                        if (!string.Equals(Path.GetDirectoryName(tFull), docDir, StringComparison.OrdinalIgnoreCase))
                            continue;
                        if (!string.Equals(AssetFolderName(tFull), assetDirName, StringComparison.OrdinalIgnoreCase))
                            continue;
                        collect(t.Content);
                    }
                    catch { }
                }

                int recycled = 0;
                foreach (string file in Directory.GetFiles(assetDir))
                {
                    if (referenced.Contains(Path.GetFileName(file))) continue;
                    try
                    {
                        Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(
                            file,
                            Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs,
                            Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
                        recycled++;
                    }
                    catch { }
                }

                // Tidy the folder away once nothing is left in it
                if (recycled > 0 && Directory.GetFiles(assetDir).Length == 0
                    && Directory.GetDirectories(assetDir).Length == 0)
                {
                    try { Directory.Delete(assetDir); } catch { }
                }
            }
            catch { }
        }

        // --- Chrome visibility -----------------------------------------------------
        // "always" (default), "auto" (hidden until the pointer nears the top), or
        // "typing" (visible until you start writing, then hidden until you reach for it).
        //
        // The pointer is polled rather than handled via MouseMove: the editor is a
        // WebView2 inside a WindowsFormsHost, an HWND child that swallows mouse input, so
        // WPF never sees the cursor while it is over your text.
        private bool _chromeAutoHide;
        // How far into the bottom of the window counts as reaching for the scrubber, and
        // how far past its edge still counts -- the pointer often overshoots onto the
        // taskbar, and losing the scrubber at that moment is exactly when it is wanted.
        private const double BottomBandPx = 56;
        private const double BottomReachPx = 24;

        private bool _chromeHidden;
        private DispatcherTimer _chromeWatch;
        private DateTime _chromeHideAfter = DateTime.MaxValue;
        // Device-independent pixels. Generous on purpose: a thin strip is a game of
        // pixel-hunting, and the cost of revealing too eagerly is trivial.
        private const int ChromeHotZonePx = 28;     // how close to the top counts as "reaching for it"
        private const int TitleBarReachPx = 80;     // also reveal from the title bar above the client area
        private const int ChromeHideDelayMs = 400;  // grace period so overshooting does not flicker

        private void StartChromeWatch()
        {
            if (_chromeWatch == null)
            {
                _chromeWatch = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(60) };
                _chromeWatch.Tick += (s, e) => ChromeWatchTick();
            }
            // Not "return if it exists": once UpdateChromeWatch can stop it, the object
            // outliving a Stop must still be restartable.
            if (!_chromeWatch.IsEnabled) _chromeWatch.Start();
        }

        /// <summary>
        /// Run the pointer watch only while a setting actually needs it.
        /// </summary>
        /// <remarks>
        /// The condition is ChromeWatchTick's own guard, stated once: chrome auto-hide, or
        /// an unpinned sidebar with edge-reveal switched on. Nothing used to stop the timer
        /// -- turning both settings off left it ticking for the life of the process, waking
        /// the UI thread ~17 times a second to re-read that guard and return. Cheap per
        /// tick, but it keeps the process off idle and out of the OS timer coalescing that
        /// a laptop on battery depends on. Every caller goes through here so the start
        /// condition and the tick's guard cannot drift apart.
        /// </remarks>
        private void UpdateChromeWatch()
        {
            if (_chromeAutoHide || (_sidebarAutoHide && !_sidebarPinned))
            {
                StartChromeWatch();
                return;
            }
            try { if (_chromeWatch != null) _chromeWatch.Stop(); } catch { }
        }

        /// <summary>True while a menu or toolbar dropdown is open — never hide under it.</summary>
        /// <summary>The menus ChromeWatchTick polls. Created by the XAML load, never replaced.</summary>
        private Menu[] _chromeWatchMenus;

        private bool IsAnyMenuOpen()
        {
            try
            {
                // Resolved once. This is reached on most watch ticks (~17/s while chrome
                // auto-hide is on -- nearTop and nearLeft short-circuit it only when the
                // pointer is in a reveal band), and looking four controls up by name every
                // time to get objects that cannot have changed is work for nothing.
                if (_chromeWatchMenus == null)
                {
                    var found = new List<Menu>(4);
                    foreach (string name in new[] { "topMenu", "headingMenu", "listMenu", "tableMenu" })
                    {
                        var m = FindElement(name) as Menu;
                        if (m != null) found.Add(m);
                    }
                    // Nothing found means the tree is not up yet, not that there are no
                    // menus: cache that and the answer is "no menu is ever open" forever.
                    if (found.Count == 0) return false;
                    _chromeWatchMenus = found.ToArray();
                }

                for (int i = 0; i < _chromeWatchMenus.Length; i++)
                {
                    Menu menu = _chromeWatchMenus[i];
                    if (menu.IsKeyboardFocusWithin) return true;
                    foreach (object item in menu.Items)
                    {
                        var mi = item as MenuItem;
                        if (mi != null && mi.IsSubmenuOpen) return true;
                    }
                }
            }
            catch { }
            return false;
        }

        private void ChromeWatchTick()
        {
            // Always run while auto-hide is on, or while the sidebar can edge-reveal —
            // which needs both the setting (View → Side Panel Auto-hide, off by default)
            // and a sidebar the user has actually closed.
            if (!_chromeAutoHide && (_sidebarPinned || !_sidebarAutoHide)) return;
            try
            {
                // Convert the physical cursor position into the SAME units as ActualWidth
                // (device-independent pixels). Comparing raw screen pixels against DIPs
                // made the hot zone wrong by the display scale factor — about 4 logical
                // pixels on a 150% display, which is impossible to hit on purpose.
                var screenPos = WinForms.Control.MousePosition;
                Point p = PointFromScreen(new Point(screenPos.X, screenPos.Y));
                double x = p.X;
                double y = p.Y;

                double chromeBottom = ChromeHeight();
                // Reveal from anywhere in the top band INCLUDING the title bar above the
                // client area (y is negative there) — moving the pointer to the top of the
                // window is the natural gesture, and it used to sail straight past.
                bool nearTop = ShouldRevealChrome(x, y, chromeBottom, _chromeHidden);

                // The bottom band brings the scrubber back on its own, without disturbing
                // the menu. Reading with no chrome at all is the point of auto-hide, and
                // reaching for the scrubber should not also flash the toolbar back.
                bool nearBottom = ShouldRevealScrubber(x, y);
                if (nearBottom != _bottomHover)
                {
                    _bottomHover = nearBottom;
                    ApplyChromeVisibility();
                }

                // Extreme left edge: temporary sidebar unless the user pinned it open —
                // and only when the reveal has been asked for. With the setting off the
                // band is dead, so the tick can still be running for chrome auto-hide
                // without the side panel following the pointer.
                bool nearLeft = _sidebarAutoHide && ShouldRevealSidebar(x, y);
                if (nearLeft != _leftHover)
                {
                    _leftHover = nearLeft;
                    if (!_sidebarPinned)
                    {
                        // Closing is deferred: the page refuses edge-close while the
                        // pointer is over #sidebar, and the stay band covers the full
                        // sidebar width. Immediate close at 280px used to yank the bar
                        // shut under Match case / Whole word (right side of the search row).
                        if (nearLeft)
                            SendMsg("cmd:sidebar_edge:1");
                        else
                            SendMsg("cmd:sidebar_edge:0");
                    }
                }

                if (!_chromeAutoHide) return;

                // Keep chrome up while the pointer is in the left band too: collapsing the
                // toolbar resizes the WebView and slides the sidebar controls under the
                // cursor mid-click.
                if (nearTop || nearLeft || IsAnyMenuOpen())
                {
                    _chromeHideAfter = DateTime.MaxValue;
                    if (_chromeHidden) SetChromeHidden(false);
                    return;
                }

                // Pointer is away. Hide again after a grace period.
                if (!_chromeHidden)
                {
                    if (_chromeHideAfter == DateTime.MaxValue)
                        _chromeHideAfter = DateTime.UtcNow.AddMilliseconds(ChromeHideDelayMs);
                    else if (DateTime.UtcNow >= _chromeHideAfter)
                        SetChromeHidden(true);
                }
            }
            catch { }
        }

        /// <summary>
        /// Pure reveal test, in device-independent pixels relative to the window client
        /// area. y is negative over the title bar. Split out so the geometry can be
        /// asserted directly rather than by chasing a real cursor.
        /// </summary>
        internal bool ShouldRevealChrome(double x, double y, double chromeBottom, bool currentlyHidden)
        {
            if (x < 0 || x > ActualWidth) return false;
            if (y < -TitleBarReachPx) return false;
            double limit = currentlyHidden ? ChromeHotZonePx : chromeBottom + 12;
            return y <= limit;
        }

        /// <summary>
        /// Pure bottom-band test, in the same device-independent pixels as ActualWidth.
        /// Split out for the same reason ShouldRevealChrome is: the alternative is asserting
        /// against a real cursor, and the watcher moves the pointer state out from under any
        /// test that tries.
        /// </summary>
        internal bool ShouldRevealScrubber(double x, double y)
        {
            if (x < 0 || x > ActualWidth) return false;
            return y >= ActualHeight - BottomBandPx && y <= ActualHeight + BottomReachPx;
        }

        /// <summary>
        /// Extreme left strip (and a little past the outer edge). Reveals the outline/search
        /// sidebar temporarily unless the user pinned it open with the toolbar/menu toggle.
        /// Hysteresis: thin strip to *open*; full sidebar width to *stay* once open (edge
        /// hover sticky via _leftHover, or pinned via _sidebarOpen). Match case / Whole word
        /// sit on the right of the 280px bar — stay band must cover those buttons.
        /// </summary>
        internal bool ShouldRevealSidebar(double x, double y)
        {
            if (y < -TitleBarReachPx || y > ActualHeight + BottomReachPx) return false;
            // Stay wide while the bar is open so chrome auto-hide and edge-close do not
            // fire mid-click on search options.
            bool stayWide = _leftHover || _sidebarOpen;
            double limit = stayWide ? LeftStayPx : LeftHotZonePx;
            return x >= -LeftReachPx && x <= limit;
        }

        // Full caption with tab chips vs slim strip (drag + min/max/close only).
        private const double CaptionHeightExpanded = 36;
        private const double CaptionHeightCollapsed = 28;

        private double ChromeHeight()
        {
            // Always count the caption strip (tabs may be tucked but ─□× remain).
            // Command row only when expanded.
            double h = 0;
            var band = FindElement("tabBar") as FrameworkElement;
            if (band != null && band.Visibility == Visibility.Visible)
                h += band.ActualHeight > 0 ? band.ActualHeight : CaptionHeightCollapsed;
            var bar = FindElement("topToolbar") as FrameworkElement;
            if (bar != null && bar.Visibility == Visibility.Visible) h += bar.ActualHeight;
            return h > 0 ? h : CaptionHeightCollapsed;
        }

        private void SetChromeHidden(bool hidden)
        {
            _chromeHidden = hidden;
            ApplyChromeVisibility();
        }

        /// <summary>
        /// One place decides what chrome is on screen.
        ///
        /// Three surfaces, two sources of truth. The View menu toggles say what the reader
        /// wants kept -- menu, scrubber, status bar -- and auto-hide temporarily overrides
        /// all three so a page of prose has nothing around it. Restoring does not turn
        /// things back on blindly: it returns to whatever the toggles ask for, so a reader
        /// who has switched the status bar off does not get it back every time the pointer
        /// brushes the top of the window.
        ///
        /// The scrubber is the exception that made this worth centralising: it lives in the
        /// page rather than the shell, so it is set by message, and while auto-hide is on it
        /// answers to the pointer being near the bottom instead of the top.
        /// </summary>
        private void ApplyChromeVisibility()
        {
            bool menuGone   = _chromeHidden;
            bool statusGone = _chromeHidden || !_statusBarVisible;
            bool scrubGone  = !_scrubberVisible || (_chromeHidden && !_bottomHover);

            var bar = FindElement("topToolbar") as UIElement;
            if (bar != null) bar.Visibility = menuGone ? Visibility.Collapsed : Visibility.Visible;

            var scroller = FindElement("tabScroller") as UIElement;
            if (scroller != null) scroller.Visibility = menuGone ? Visibility.Collapsed : Visibility.Visible;

            var sbar = FindElement("statusBar") as UIElement;
            if (sbar != null) sbar.Visibility = statusGone ? Visibility.Collapsed : Visibility.Visible;

            if (scrubGone != _scrubberSuppressed)
            {
                _scrubberSuppressed = scrubGone;
                SendMsg(scrubGone ? "cmd:scrubber_off" : "cmd:scrubber_on");
            }

            bool hidden = menuGone;

            var band = FindElement("tabBar") as Border;
            if (band != null)
            {
                band.Visibility = Visibility.Visible;
                band.Height = hidden ? CaptionHeightCollapsed : CaptionHeightExpanded;
                band.BorderThickness = new Thickness(0);
            }
            var seam = FindElement("tabSeam") as System.Windows.Shapes.Rectangle;
            if (seam != null)
                seam.Visibility = hidden ? Visibility.Collapsed : Visibility.Visible;

            // Keep WindowChrome caption height in sync so drag/double-click still match the strip.
            try
            {
                var chrome = WindowChrome.GetWindowChrome(this);
                if (chrome != null)
                    chrome.CaptionHeight = hidden ? CaptionHeightCollapsed : CaptionHeightExpanded;
            }
            catch { }
        }

        private bool _scrubberVisible = true;
        private bool _scrubberSuppressed;
        private bool _bottomHover;
        private bool _leftHover;
        /// <summary>True when the user opened the sidebar with the toggle (stays until closed).</summary>
        private bool _sidebarPinned = true;
        private const int LeftHotZonePx = 10;
        /// <summary>
        /// While edge-open (or while _leftHover), keep the left band live across the full
        /// sidebar (#sidebar is 280px) plus slack so the search option buttons stay usable.
        /// </summary>
        private const int LeftStayPx = 340;
        private const int LeftReachPx = 24;

        /// <summary>The reading scrubber, which lives in the page.</summary>
        private void SetScrubberVisible(bool on)
        {
            _scrubberVisible = on;
            SetMenuChecked("mScrubberToggle", on);
            ApplyChromeVisibility();
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>
        /// One switch, because the old "hide while typing" and "auto-hide" behaved almost
        /// identically — auto-hide already retracted on the first keystroke as well as on
        /// pointer-away, so the second option earned nothing.
        /// </summary>
        /// <summary>
        /// Open the top-level menu whose access key matches, and move keyboard focus to it.
        /// Focus matters: without it the menu opens but the arrow keys keep going to the
        /// editor, because the WebView still owns input.
        /// </summary>
        internal bool OpenMenuByAccessKey(char key)
        {
            if (key == '\0') return false;
            key = char.ToLowerInvariant(key);
            var topMenu = FindElement("topMenu") as Menu;
            if (topMenu == null) return false;

            if (_chromeHidden) SetChromeHidden(false);
            _chromeHideAfter = DateTime.MaxValue;   // keep it up while a menu is being used

            foreach (object item in topMenu.Items)
            {
                var mi = item as MenuItem;
                if (mi == null) continue;
                string header = mi.Header as string;
                if (string.IsNullOrEmpty(header)) continue;
                int us = header.IndexOf('_');
                if (us < 0 || us + 1 >= header.Length) continue;
                if (char.ToLowerInvariant(header[us + 1]) != key) continue;

                try
                {
                    Activate();
                    Focus();                     // pull input back from the WebView's HWND
                    mi.Focus();
                    Keyboard.Focus(mi);
                    mi.IsSubmenuOpen = true;
                }
                catch { }
                return true;
            }
            return false;
        }

        private void SetChromeAutoHide(bool on)
        {
            _chromeAutoHide = on;
            SetMenuChecked("mChromeAutoHide", on);

            _chromeHideAfter = DateTime.MaxValue;
            if (!on) SetChromeHidden(false);
            // Pointer watch also drives left-edge sidebar hover when the bar is unpinned
            // and that reveal is switched on.
            UpdateChromeWatch();
            // Starts visible either way: you watch it retract rather than wondering where
            // it went, which is what makes the behaviour discoverable without a tutorial.
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>The page reports typing; hide the chrome if that is the chosen mode.</summary>
        private void OnUserTyping()
        {
            if (!_chromeAutoHide) return;
            if (_chromeHidden) return;
            if (IsAnyMenuOpen()) return;
            SetChromeHidden(true);
            _chromeHideAfter = DateTime.MaxValue;
        }

        private void ResetViewSettings()
        {
            SetParaSpacing(1);
            SetLineSpacing(1);
            SetBlockHover(1);
            SetFontType(0);
            SetFontSizeOverride(2);
            SetJustified(false);
            SetWordWrap(true);
            SendMsg("cmd:set_margin_regular");
            SetZoom(1.0);
            
            SetChromeAutoHide(false);
            SetSidebarAutoHide(false);
            SetStatusBarVisible(true);
            SetScrubberVisible(true);
            
            var mFocus = (MenuItem)FindElement("mToggleFocus");
            if (mFocus != null && mFocus.IsChecked) SendMsg("cmd:toggle_focus");
            
            var mType = (MenuItem)FindElement("mToggleTypewriter");
            if (mType != null && mType.IsChecked) SendMsg("cmd:toggle_typewriter");
            
            var mReveal = (MenuItem)FindElement("mToggleReveal");
            if (mReveal != null && mReveal.IsChecked) SendMsg("cmd:toggle_reveal");
            
            SaveWindowState();
        }

        private void SetWordWrap(bool on)
        {
            _wordWrap = on;
            SetMenuChecked("mWordWrap", on);
            // Only push the body class when wrap can take effect. Preference is still
            // stored so leaving Pages/Reader restores what the user chose.
            if (IsWordWrapApplicable())
                SendMsg(on ? "cmd:wordwrap_on" : "cmd:wordwrap_off");
            RefreshEditingAvailability();
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>
        /// Word wrap only affects Source and scroll Preview. In Pages / Reader / epub the
        /// page axis is horizontal, so unwrap was overridden in CSS (and used to look like
        /// a corrupt book). Grey the menu item out instead of leaving a live-looking tick.
        /// </summary>
        /// <summary>True when the active tab is on the native WebView surface (not editor Source).</summary>
        private bool ActiveTabIsNativeSurface()
        {
            if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count && IsNativeTab(_tabs[_activeTabIndex]))
                return true;
            // Path alone is not enough: HTML may be editor Source while still ending in .html.
            return _nativeSurfaceVisible && IsNativePath(_currentFilePath);
        }

        private bool IsWordWrapApplicable()
        {
            if (IsEpubPath(_currentFilePath)) return false;
            if (ActiveTabIsNativeSurface()) return false;
            if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count && IsReadOnlyTab(_tabs[_activeTabIndex]))
                return false;
            if (string.Equals(_viewMode, "reader", StringComparison.OrdinalIgnoreCase)) return false;
            if (string.Equals(_editorMode, "reader", StringComparison.OrdinalIgnoreCase)) return false;
            // Source always wraps via the textarea path.
            if (string.Equals(_viewMode, "source", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(_editorMode, "source", StringComparison.OrdinalIgnoreCase)) return true;
            // Preview: only when scrolling, not paginated.
            if (_isPageAdvanceMode) return false;
            if (string.Equals(_viewScroll, "pagination", StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }

        /// <summary>
        /// Group a count with the local thousands separator: 40772 -> "40,772".
        ///
        /// The status bar's job is to be read at a glance, and "205842" is not read at a
        /// glance -- it is counted. Anything that is not a plain integer is passed through
        /// untouched, so a placeholder like "?" survives.
        /// </summary>
        private static string Grouped(string n)
        {
            long v;
            if (long.TryParse((n ?? "").Trim(), out v)) return v.ToString("N0");
            return n ?? "";
        }

        private static bool IsEpubPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            return path.EndsWith(".epub", StringComparison.OrdinalIgnoreCase);
        }

        private static string DocKindToken(DocTab tab)
        {
            if (tab == null) return "engine";
            if (IsNativeTab(tab) || tab.Kind == DocKind.Native) return "native";
            if (IsBookTab(tab) || tab.Kind == DocKind.Book) return "book";
            return "engine";
        }

        private static void ApplyDocKindFromSession(DocTab tab, string kindTok)
        {
            if (tab == null) return;
            if (string.Equals(kindTok, "native", StringComparison.OrdinalIgnoreCase))
            {
                tab.Kind = DocKind.Native;
                tab.NativeRole = ClassifyNativeRole(tab.FilePath);
                return;
            }
            if (string.Equals(kindTok, "book", StringComparison.OrdinalIgnoreCase))
            {
                tab.Kind = DocKind.Book;
                return;
            }
            // Infer from path when older sessions omit kind=
            tab.Kind = ClassifyDocKind(tab.FilePath);
            tab.NativeRole = ClassifyNativeRole(tab.FilePath);
        }

        private void RefreshWordWrapMenuAvailability()
        {
            try
            {
                var mi = FindElement("mWordWrap") as MenuItem;
                if (mi == null) return;
                bool applicable = IsWordWrapApplicable();
                mi.IsEnabled = applicable;
                mi.ToolTip = applicable
                    ? "Wrap long lines (Source and scroll Preview)"
                    : "Word wrap does not apply while reading pages or a book";
                if (!applicable)
                {
                    // Do not show a live-looking tick while wrap cannot affect the page.
                    mi.IsChecked = false;
                    // Ensure unwrap is not left active under Pages/Reader (belt + CSS).
                    SendMsg("cmd:wordwrap_on");
                }
                else
                {
                    mi.IsChecked = _wordWrap;
                    // Restore the real preference when returning to Source / scroll Preview.
                    SendMsg(_wordWrap ? "cmd:wordwrap_on" : "cmd:wordwrap_off");
                }
            }
            catch { }
        }

        /// <summary>True when the document can accept an edit at all.</summary>
        /// <remarks>
        /// Reader sets #editor to contenteditable="false", for a book and for Markdown
        /// alike, so every formatting command is a no-op there. Source and Preview both
        /// take edits, paginated or not — this is about the document, not the layout.
        /// </remarks>
        private bool IsDocumentEditable()
        {
            if (IsEpubPath(_currentFilePath)) return false;
            if (ActiveTabIsNativeSurface()) return false;
            if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count && IsReadOnlyTab(_tabs[_activeTabIndex]))
                return false;
            if (string.Equals(_viewMode, "reader", StringComparison.OrdinalIgnoreCase)) return false;
            if (string.Equals(_editorMode, "reader", StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }

        /// <summary>
        /// True when Mode pills must follow the native surface (Reader for HTML/PDF/…)
        /// rather than the hidden editor WebView's mode_changed / view_state.
        /// </summary>
        private bool ShouldIgnoreEditorModeChrome()
        {
            if (_nativeSurfaceVisible) return true;
            if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                && IsNativeTab(_tabs[_activeTabIndex]))
                return true;
            return false;
        }

        /// <summary>
        /// Sync Mode pillbox + host mode fields after leaving native HTML for Source
        /// (or returning to render). Does not rely on the page's view_state echo.
        /// </summary>
        private void ApplyHostModeChrome(string mode)
        {
            if (string.IsNullOrEmpty(mode)) mode = "preview";
            mode = mode.ToLowerInvariant();
            _viewMode = mode;
            if (mode == "source") _editorMode = "source";
            else if (mode == "reader") _editorMode = "reader";
            else { _viewMode = "preview"; _editorMode = "wysiwyg"; mode = "preview"; }

            try
            {
                SelectSegment("btnModeSource", mode == "source");
                SelectSegment("btnModePreview", mode == "preview");
                SelectSegment("btnModeReader", mode == "reader");
            }
            catch { }

            try
            {
                bool html = IsHtmlPath(_currentFilePath);
                bool book = IsEpubPath(_currentFilePath);
                bool nativeNonHtml = ActiveTabIsNativeSurface() && !html;
                Button segSource, segPreview;
                if (_segments.TryGetValue("btnModeSource", out segSource))
                    SetControlLocked(segSource, book || nativeNonHtml);
                // Preview = Markdown editor mode — never for HTML files.
                if (_segments.TryGetValue("btnModePreview", out segPreview))
                {
                    SetControlLocked(segPreview, book || nativeNonHtml || html);
                    if (html)
                        try { segPreview.ToolTip = "Not used for HTML — use Source to edit markup, Reader to view the page."; } catch { }
                }
                if (!book && !ActiveTabIsNativeSurface() && !html)
                {
                    if (_btnColumnToggle != null) SetControlLocked(_btnColumnToggle, false);
                    if (_btnScrollToggle != null) SetControlLocked(_btnScrollToggle, false);
                }
            }
            catch { }

            RefreshEditingAvailability();
        }

        // The format controls, and the Edit items that duplicate three of them. Menus are
        // Controls too, so the three dropdowns lock the same way the buttons do.
        private static readonly string[] FormatControls =
        {
            "btnBold", "btnItalic", "btnStrike", "btnCode",
            "headingMenu", "btnQuote", "listMenu",
            "btnLink", "tableMenu",
            "mInsertLink", "mInsertTable", "mStrike",
        };
        private readonly Dictionary<string, object> _formatTips = new Dictionary<string, object>();

        /// <summary>
        /// Grey the formatting controls whenever the document cannot take an edit.
        ///
        /// They were live-looking and inert in Reader and on every epub: nine toolbar
        /// controls plus three Edit items that do nothing, with no way to tell from
        /// looking. Word Wrap already greys itself and says why (RefreshWordWrapMenu-
        /// Availability); this is the same courtesy for the rest, using the same
        /// SetControlLocked the Column and Scroll buttons use, so "unavailable" has one
        /// appearance across the whole toolbar.
        ///
        /// Greyed rather than hidden, deliberately. Collapsing them would reflow the
        /// centre group, so switching modes would shuffle buttons under the pointer and
        /// the reader would lose track of what the app can do at all.
        /// </summary>
        private void RefreshFormatAvailability()
        {
            try
            {
                bool editable = IsDocumentEditable();
                string why = IsEpubPath(_currentFilePath)
                    ? "A book is read-only — formatting applies to documents you can edit"
                    : (IsNativePath(_currentFilePath) || (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count && IsNativeTab(_tabs[_activeTabIndex])))
                        ? "This file is read-only — open a Markdown or text document to format"
                        : "Reader is read-only — switch to Preview or Source to format text";
                foreach (string name in FormatControls)
                {
                    var c = FindElement(name) as Control;
                    if (c == null) continue;
                    // Remember the control's own tooltip once, so restoring it does not
                    // depend on this method having written the current one.
                    if (!_formatTips.ContainsKey(name)) _formatTips[name] = c.ToolTip;
                    SetControlLocked(c, !editable);
                    c.ToolTip = editable ? _formatTips[name] : why;
                }
            }
            catch { }
        }

        /// <summary>
        /// One call for "the document or the view changed, so re-decide what is available".
        ///
        /// Both halves answer the same question and were drifting apart: Word Wrap knew it
        /// did not apply to a book, and the nine format controls beside it did not.
        /// </summary>
        private void RefreshEditingAvailability()
        {
            RefreshWordWrapMenuAvailability();
            RefreshFormatAvailability();
        }

        private void SetStatusBarVisible(bool on)
        {
            _statusBarVisible = on;
            SetMenuChecked("mStatusBarToggle", on);
            ApplyChromeVisibility();
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        // Four steps each, centred on what the stylesheet already shipped: one notch
        // tighter for readers who want more words per page, two looser for the ones who
        // find dense prose hard to track. Presets rather than a number box -- every value
        // here has been looked at on a real page, which is not true of an open field.
        private static readonly double[] LineSpacingPresets = { 1.4, 1.6, 1.8, 2.0 };
        private static readonly int[] ParaSpacingPresets = { 1, 3, 7, 12 };
        private static readonly string[] LineSpacingItems =
            { "mLineTight", "mLineNormal", "mLineRelaxed", "mLineLoose" };
        private static readonly string[] ParaSpacingItems =
            { "mParaTight", "mParaNormal", "mParaRelaxed", "mParaLoose" };

        private int _lineSpacing = 1;
        private int _paraSpacing = 1;
        /// <summary>
        /// Whether hovering a paragraph offers its bookmark gutter: 0=off, 1=gutter.
        /// Default on. This is only the hover preview — a bookmark is always drawn.
        /// </summary>
        private int _blockHover = 1;
        private static readonly string[] BlockHoverKeys = { "off", "gutter" };


        private int _fontType = 0; // 0=Theme, 1=Serif, 2=Sans, 3=Custom
        private string _customFontFamily = "";
        private int _fontSize = 2; // 0=XS, 1=S, 2=Normal, 3=L, 4=XL
        
        private static readonly string[] FontTypeItems = { "mFontTheme", "mFontSerif", "mFontSans", "mFontCustom" };
        private static readonly string[] FontSizeItems = { "mSizeExtraSmall", "mSizeSmall", "mSizeNormal", "mSizeLarge", "mSizeExtraLarge" };

        /// <summary>
        /// Also the migration from the four-way version of this setting
        /// (0=none 1=wash 2=edge 3=hint): anything that drew something becomes the
        /// gutter, and only an explicit "off" stays off.
        /// </summary>
        private static int ClampBlockHover(int index)
        {
            return (index <= 0) ? 0 : 1;
        }

        /// <summary>Height of a line of body text, as a multiple of the font size.</summary>
        private void SetLineSpacing(int index)
        {
            _lineSpacing = Clamp4(index);
            for (int i = 0; i < LineSpacingItems.Length; i++)
                SetMenuChecked(LineSpacingItems[i], i == _lineSpacing);
            SendMsg("cmd:set_line_spacing:" + LineSpacingPresets[_lineSpacing].ToString(
                System.Globalization.CultureInfo.InvariantCulture));
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>Gap between paragraphs, in pixels.</summary>
        private void SetParaSpacing(int index)
        {
            _paraSpacing = Clamp4(index);
            for (int i = 0; i < ParaSpacingItems.Length; i++)
                SetMenuChecked(ParaSpacingItems[i], i == _paraSpacing);
            SendMsg("cmd:set_para_spacing:" + ParaSpacingPresets[_paraSpacing].ToString(
                System.Globalization.CultureInfo.InvariantCulture));
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>
        /// Whether hovering a paragraph previews its bookmark. Not a paint style for the
        /// block: the page has one hover cue and it lives in the gutter, so this is on or
        /// off. A bookmark that exists is always drawn, whatever this says.
        /// </summary>
        private void SetBlockHover(int index)
        {
            _blockHover = ClampBlockHover(index);
            SetMenuChecked("mHoverGutter", _blockHover == 1);
            SendMsg("cmd:set_block_hover:" + BlockHoverKeys[_blockHover]);
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        private void SetFontType(int index)
        {
            _fontType = index;
            if (_fontType > 3) _fontType = 3;
            if (_fontType < 0) _fontType = 0;
            for (int i = 0; i < FontTypeItems.Length; i++)
                SetMenuChecked(FontTypeItems[i], i == _fontType);

            string family = "";
            if (_fontType == 1) family = "Georgia, serif";
            else if (_fontType == 2) family = "'Segoe UI', sans-serif";
            else if (_fontType == 3) family = _customFontFamily;

            var customMenuItem = this.FindName("mFontCustom") as System.Windows.Controls.MenuItem;
            if (customMenuItem != null)
            {
                if (_fontType == 3 && !string.IsNullOrWhiteSpace(_customFontFamily))
                    customMenuItem.Header = "Custom: " + _customFontFamily;
                else
                    customMenuItem.Header = "_Custom...";
            }

            SendMsg("cmd:set_font_family:" + family);
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        private void SetFontSizeOverride(int index)
        {
            _fontSize = index;
            if (_fontSize > 4) _fontSize = 4;
            if (_fontSize < 0) _fontSize = 0;
            for (int i = 0; i < FontSizeItems.Length; i++)
                SetMenuChecked(FontSizeItems[i], i == _fontSize);

            SendMsg("cmd:set_font_size:" + _fontSize);
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>
        /// Off by default, for books as much as for Markdown.
        ///
        /// Every test book asks to be justified -- Xeelee on 96 rules, Matter on 7 -- and
        /// that is the publisher describing a printed measure they set with hyphenation
        /// and a typesetter's eye. A browser has neither: it justifies by stretching word
        /// spaces alone, over a measure that changes with the window, so a narrow column
        /// of a novel comes out with rivers of white running down it. applyBookStyles
        /// rewrites those declarations to read the same custom property this sets, so the
        /// choice is one switch over both kinds of document and the publisher's centred
        /// and right-aligned rules are left exactly as written.
        /// </summary>
        private bool _justified;

        private void SetJustified(bool on)
        {
            _justified = on;
            SetMenuChecked("mJustify", on);
            SendMsg("cmd:set_justify:" + (on ? "1" : "0"));
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>
        /// Whether the left screen edge reveals the sidebar while it is closed.
        ///
        /// Off by default. The reveal fires on any pointer travel into the leftmost strip,
        /// which for someone who closed the sidebar on purpose reads as the panel opening
        /// by itself. Independent of chrome auto-hide: one is about the toolbar, this is
        /// about the side panel, and wanting a bare reading window is not the same as
        /// wanting the outline to follow the mouse.
        /// </summary>
        private bool _sidebarAutoHide;

        private void SetSidebarAutoHide(bool on)
        {
            _sidebarAutoHide = on;
            SetMenuChecked("mSidebarAutoHide", on);
            if (!on && _leftHover)
            {
                // Switched off mid-hover: the page is holding a bar open that nothing will
                // now close, because the tick that would send sidebar_edge:0 has stopped.
                _leftHover = false;
                if (!_sidebarPinned) SendMsg("cmd:sidebar_edge:0");
            }
            UpdateChromeWatch();
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>
        /// Save a dirty document a moment after typing stops. Off unless asked for.
        ///
        /// Off by default because it changes what a file on disk means: with it on, closing
        /// without saving is no longer a way to discard an experiment. That is a choice
        /// about the reader's own files and not one to make for them.
        ///
        /// Deliberately narrow. It runs only for a tab that already has a path, is dirty,
        /// and is not a book -- so it can never raise a Save As dialog at rest, which is
        /// what an unattended save must never do. An untitled buffer stays untitled and is
        /// covered by session restore instead; a book cannot be written at all.
        ///
        /// It goes through SaveTabNow like every other save, so the atomic write, the
        /// per-tab line-ending fidelity and the overwrite-loss guard all apply unchanged.
        /// The guard can still speak up -- it fires only when a save would destroy a lot of
        /// text, and that is worth interrupting for however the save was triggered.
        /// </summary>
        private bool _autosave;
        private DispatcherTimer _autosaveTimer;
        private const int AutosaveIdleMs = 2000;

        private void SetAutosave(bool on)
        {
            _autosave = on;
            SetMenuChecked("mAutosave", on);
            if (!on && _autosaveTimer != null) _autosaveTimer.Stop();
            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>Restart the idle clock. Typing pushes the save out, it does not stack.</summary>
        private void ArmAutosave()
        {
            if (!_autosave) return;
            if (_autosaveTimer == null)
            {
                _autosaveTimer = new DispatcherTimer
                {
                    Interval = TimeSpan.FromMilliseconds(AutosaveIdleMs)
                };
                _autosaveTimer.Tick += (s, e) => { _autosaveTimer.Stop(); AutosaveNow(); };
            }
            _autosaveTimer.Stop();
            _autosaveTimer.Start();
        }

        private void AutosaveNow()
        {
            if (!_autosave || SuppressDocumentTraces()) return;
            if (_tabOpInProgress || _scriptBlockDepth > 0) { ArmAutosave(); return; }
            if (_activeTabIndex < 0 || _activeTabIndex >= _tabs.Count) return;
            var tab = _tabs[_activeTabIndex];
            if (tab == null || !tab.IsDirty) return;
            if (string.IsNullOrEmpty(tab.FilePath)) return;      // never prompt for a path
            if (IsReadOnlyTab(tab)) return;                      // book / native never written
            // The buffer must be current, or autosave would write a stale copy over the
            // file it is meant to be protecting. A failed pull means try again later.
            if (!SyncActiveTabFromEditor()) { ArmAutosave(); return; }
            if (!tab.IsDirty) return;
            string ignored, ignoredEnc;
            if (EngineDiskTextChanged(tab, tab.FilePath, out ignored, out ignoredEnc))
            {
                // Never unattended-overwrite an external edit. Prompt if we can.
                tab.DiskConflict = true;
                CheckEngineTabDisk(tab, true);
                return;
            }
            try { SaveTabNow(tab, false); } catch { }
        }

        // A stale state file naming a fifth preset must not throw on startup.
        private static int Clamp4(int i) { return i < 0 ? 0 : (i > 3 ? 3 : i); }

        /// <summary>
        /// One switch that stops TypoZen writing down what you are reading or writing.
        ///
        /// The individual toggles each answer a narrow question, and a person who wants
        /// privacy should not have to find all of them and know which files each governs.
        /// This is that question asked once: while it is on, nothing that names a document,
        /// its contents, its position or its history reaches disk.
        ///
        /// Suppressed: the tab session, reading positions, bookmarks and annotations, the
        /// recent files list, autosave, and the document-identifying half of settings.json
        /// -- last file, last content, search history, last query.
        ///
        /// Deliberately NOT suppressed: window size, theme, margins, spacing and the other
        /// view settings. Those describe the application rather than the reader, and losing
        /// them every launch would be a cost with no privacy in return. Written down here
        /// because a privacy switch that quietly does less than its name is worse than one
        /// that does less openly.
        ///
        /// Forward-looking only. Turning it on stops new writes; it does not delete what is
        /// already stored, because bookmarks and annotations are the reader's own work and a
        /// toggle that silently destroyed them would be indefensible. File > Privacy >
        /// Clear Stored Data remains the deliberate way to remove what is already there.
        /// </summary>
        private bool _privacyMode;

        private void SetPrivacyMode(bool on)
        {
            _privacyMode = on;
            SetMenuChecked("mPrivacyMode", on);
            // The switches it subsumes are disabled rather than merely overridden: a tick
            // that does nothing is a lie about what the app will do.
            foreach (string name in new[] { "mAutosave", "mSessionRestoreContent", "mRecentEnabled" })
            {
                var mi = FindElement(name) as MenuItem;
                if (mi != null) mi.IsEnabled = !on;
            }
            if (on && _autosaveTimer != null) _autosaveTimer.Stop();

            // Extraction goes somewhere disposable while this is on. Switching mid-session
            // only affects books opened from here -- one already open keeps the directory it
            // was unpacked into, because its images are still being fetched from it.
            if (on)
            {
                if (EpubReader.PrivateSessionRoot == null) EpubReader.BeginPrivateSession();
            }
            else
            {
                EpubReader.EndPrivateSession();
            }
            MapBookHost();
            MapLoadHost();

            if (!_applyingRestoredSettings) SaveWindowState();
        }

        /// <summary>
        /// Point the book virtual host at wherever extraction is currently going.
        ///
        /// Re-mapped rather than set once, because privacy mode moves the root: an image
        /// URL in a book payload is https://localbooks/<key>/..., and that has to resolve
        /// whether the key sits in the application folder or in this session's temporary
        /// one.
        /// </summary>
        private void MapBookHost()
        {
            if (_webView == null || _webView.CoreWebView2 == null) return;
            try
            {
                string root = EpubReader.CacheRoot(_appDir);
                Directory.CreateDirectory(root);
                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "localbooks", root, CoreWebView2HostResourceAccessKind.DenyCors);
            }
            catch { }
        }

        /// <summary>
        /// Keep the editor WebView on the template. A book sanitizer miss or a
        /// target=_blank that the page did not intercept must not replace
        /// TypoZen_Template with some other origin — chrome.webview messages still
        /// arrive after that, and open_doc / save_prefs would then run against
        /// whoever is on the page.
        /// </summary>
        private void AttachEditorNavigationGuards(CoreWebView2 core)
        {
            if (core == null) return;
            core.NavigationStarting += (s, e) =>
            {
                try
                {
                    if (!IsAllowedEditorNavigation(e.Uri)) e.Cancel = true;
                }
                catch { }
            };
            core.NewWindowRequested += (s, e) =>
            {
                try
                {
                    e.Handled = true;
                    string url = e.Uri ?? "";
                    if (Regex.IsMatch(url, @"^(https?|mailto):", RegexOptions.IgnoreCase))
                    {
                        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
                    }
                }
                catch { }
            };
        }

        private static bool IsAllowedEditorNavigation(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return false;
            if (uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return true;
            if (uri.StartsWith("https://localapp/", StringComparison.OrdinalIgnoreCase)) return true;
            if (uri.StartsWith("https://docfolder/", StringComparison.OrdinalIgnoreCase)) return true;
            if (uri.StartsWith("https://localbooks/", StringComparison.OrdinalIgnoreCase)) return true;
            if (uri.StartsWith("https://localload/", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private void AttachNativeNavigationGuards(CoreWebView2 core)
        {
            if (core == null) return;
            core.NavigationStarting += (s, e) =>
            {
                try
                {
                    string uri = e.Uri ?? "";
                    if (IsAllowedNativeNavigation(uri)) return;
                    if (Regex.IsMatch(uri, @"^(https?|mailto):", RegexOptions.IgnoreCase))
                    {
                        e.Cancel = true;
                        try
                        {
                            Process.Start(new ProcessStartInfo { FileName = uri, UseShellExecute = true });
                        }
                        catch { }
                        return;
                    }
                    e.Cancel = true;
                }
                catch { }
            };
            core.NewWindowRequested += (s, e) =>
            {
                try
                {
                    e.Handled = true;
                    string url = e.Uri ?? "";
                    if (Regex.IsMatch(url, @"^(https?|mailto):", RegexOptions.IgnoreCase))
                    {
                        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
                    }
                }
                catch { }
            };
        }

        private static bool IsAllowedNativeNavigation(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return false;
            if (uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return true;
            if (uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return true;
            if (uri.StartsWith("https://localview/", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        /// <summary>True when nothing that names a document may be written.</summary>
        private bool SuppressDocumentTraces() { return _privacyMode; }


        private bool _wordWrap = true;
        private bool _statusBarVisible = true;
        private bool _applyingRestoredSettings;

        /// <summary>
        /// Push restored View settings through their real setters.
        ///
        /// RestoreWindowState only fills the fields. Without this, a restored auto-hide
        /// never started its pointer watch (so hover could not reveal the chrome) and never
        /// ticked its menu item — leaving the setting on, the menu saying off, and the
        /// first click appearing to do nothing because it toggled the field back.
        /// </summary>
        private void ApplyRestoredViewSettings(bool includePageSettings)
        {
            _applyingRestoredSettings = true;
            try
            {
                SetChromeAutoHide(_chromeAutoHide);
                SetSidebarAutoHide(_sidebarAutoHide);
                SetPrivacyMode(_privacyMode);
                SetAutosave(_autosave);
                SetStatusBarVisible(_statusBarVisible);
                SetScrubberVisible(_scrubberVisible);
                SetMenuChecked("mSessionRestoreContent", _sessionRestoreContent);
                SetMenuChecked("mRecentEnabled", _recentFilesEnabled);
                if (includePageSettings)
                {
                    SetWordWrap(_wordWrap);
                    SetLineSpacing(_lineSpacing);
                    SetParaSpacing(_paraSpacing);
                    SetBlockHover(_blockHover);
                    SetJustified(_justified);
                    SetFontType(_fontType);
                    SetFontSizeOverride(_fontSize);

                    // The scrubber lives in the page, so its state is only real once the
                    // page exists. ApplyChromeVisibility above ran against no WebView and
                    // its message went nowhere; resend now, or a reader who switched the
                    // scrubber off would find it back on every launch.
                    SendMsg(_scrubberSuppressed ? "cmd:scrubber_off" : "cmd:scrubber_on");
                    // The page defaults to not persisting content; tell it the real setting
                    // once it exists, or an opted-in user would silently lose the feature.
                    SendMsg(_sessionRestoreContent ? "cmd:persist_content_on" : "cmd:persist_content_off");
                    
                    SendMsg("cmd:debug_log:" + (Program.DebugLogEnabled ? "1" : "0"));

                    // Restore through the resolver, not set_column_mode. The raw command
                    // applies columns and nothing else, which produced 2 columns still
                    // marked as Scroll -- a combination the rules forbid, because two
                    // columns need a bottom boundary to flow into. view_set makes the
                    // resolver turn Pagination on as it would for a click.
                    if (_isTwoColumnMode) SendMsg("cmd:view_set:columns:2");

                    // Then ask the page what its state actually is and paint the selectors
                    // from the answer. Without this the toolbar kept the hardcoded defaults
                    // it was built with (1-Col / Scroll) while the restored document was
                    // already showing two paginated columns.
                    SendMsg("cmd:view_sync");
                }
            }
            finally { _applyingRestoredSettings = false; }
        }

        private void SendMsg(string msg)
        {
            if (_webView != null && _webView.CoreWebView2 != null)
            {
                _webView.CoreWebView2.PostWebMessageAsString(msg);
            }
        }

        // Below this, ship text inline via postMessage. Above: stage file + async fetch
        // (avoids multi‑hundred‑KB COM marshaling on every open).
        private const int LoadContentInlineMaxChars = 96 * 1024;

        /// <summary>
        /// Extensions that belong in Source (Notepad-class), not Markdown Preview.
        /// Includes .txt and code/markup that is not HTML-to-render.
        /// </summary>
        private static bool PreferSourceModeForPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string ext = Path.GetExtension(path);
            if (string.IsNullOrEmpty(ext)) return false;
            ext = ext.ToLowerInvariant();
            return ext == ".txt" || ext == ".log" || ext == ".csv"
                || ext == ".css" || ext == ".xml" || ext == ".xaml"
                || ext == ".xsl" || ext == ".xslt" || ext == ".json"
                || ext == ".html" || ext == ".htm" || ext == ".xhtml";
        }

        private static bool IsHtmlPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string ext = Path.GetExtension(path);
            if (string.IsNullOrEmpty(ext)) return false;
            ext = ext.ToLowerInvariant();
            return ext == ".html" || ext == ".htm" || ext == ".xhtml";
        }

        /// <summary>
        /// Load a file into the editor as text (Source), even if it would normally open
        /// as a native HTML page. Used when the user presses the Mode → Source segment.
        /// </summary>
        private void OpenAsEditorText(string path)
        {
            LoadFileFromPath(path, forceEditorText: true);
        }

        /// <summary>
        /// Push content into the editor without blocking. Plain/Source is chosen by
        /// document type (txt/log/csv/css/xml/xaml/…), not by size — virtualized Preview
        /// handles large markdown without building a full WYSIWYG DOM.
        /// </summary>
        private void LoadContentToEditor(string content, bool markDirty = false, string filePathHint = null, int resumeAt = 0)
        {
            content = content ?? "";
            bool plain = PreferSourceModeForPath(filePathHint);
            try
            {
                if (content.Length <= LoadContentInlineMaxChars)
                {
                    SendMsg((plain ? "load_content_plain:" : "load_content:") + content);
                    if (markDirty) SendMsg("mark_dirty");
                    // Inline loads resume via RequestTabResume after ApplyTabView.
                    return;
                }

                // Large payload: unique stage file per load (avoids concurrent open races).
                // localload, not localapp: the app folder is not a place for document
                // bodies (OneDrive, Privacy Mode).
                string fileName = "body_" + Guid.NewGuid().ToString("N") + ".md";
                string url = StageLoadPayload(fileName, content) + (plain ? "|plain=1" : "");
                if (resumeAt > 0 && !plain)
                    url += "|at=" + resumeAt;
                SendMsg("fetch_and_load:" + url);
                if (markDirty) SendMsg("mark_dirty");
            }
            catch (Exception ex)
            {
                try
                {
                    SendMsg((plain ? "load_content_plain:" : "load_content:") + content);
                    if (markDirty) SendMsg("mark_dirty");
                }
                catch
                {
                    if (!_e2eMode)
                    {
                        WinForms.MessageBox.Show(
                            "Could not load the document into the editor.\n\n" + ex.Message,
                            "Load failed",
                            WinForms.MessageBoxButtons.OK,
                            WinForms.MessageBoxIcon.Warning);
                    }
                }
            }
        }

        /// <summary>True when the active tab has no unsaved edits (skip editor sync on open).</summary>
        private bool ActiveTabLooksClean()
        {
            if (_isDirty) return false;
            if (_activeTabIndex < 0 || _activeTabIndex >= _tabs.Count) return true;
            return !_tabs[_activeTabIndex].IsDirty;
        }

        private static int ContentFingerprint(string content)
        {
            if (string.IsNullOrEmpty(content)) return 0;
            // Cheap stable-enough key: length + ends (not a crypto hash).
            int h = content.Length;
            h = (h * 31) + content[0];
            h = (h * 31) + content[content.Length - 1];
            if (content.Length > 64)
                h = (h * 31) + content[content.Length / 2];
            return h;
        }

        private bool EngineTabAlreadyOnPage(DocTab tab, string content)
        {
            if (tab == null) return false;
            if (tab.Id != _loadedEngineTabId) return false;
            if (!string.Equals(tab.FilePath ?? "", _loadedEnginePath ?? "", StringComparison.Ordinal))
                return false;
            content = content ?? "";
            if (content.Length != _loadedEngineContentLen) return false;
            if (ContentFingerprint(content) != _loadedEngineContentHash) return false;
            return true;
        }

        private void RememberEnginePageLoad(DocTab tab, string content)
        {
            if (tab == null)
            {
                _loadedEngineTabId = -1;
                return;
            }
            content = content ?? "";
            _loadedEngineTabId = tab.Id;
            _loadedEnginePath = tab.FilePath ?? "";
            _loadedEngineContentLen = content.Length;
            _loadedEngineContentHash = ContentFingerprint(content);
        }

        private void InvalidateEnginePageLoad()
        {
            _loadedEngineTabId = -1;
            _loadedEnginePath = "";
            _loadedEngineContentLen = -1;
            _loadedEngineContentHash = 0;
        }

        /// <summary>
        /// Single host entry for undo/redo. Debounces so ThreadPreprocess + Window.KeyDown
        /// (or double menu) cannot fire two steps for one physical Ctrl+Z.
        /// </summary>
        private long _lastHistoryCmdTicks;
        private void SendHistoryCmd(string cmd)
        {
            if (string.IsNullOrEmpty(cmd)) return;
            long now = Environment.TickCount;
            // Short debounce only (double menu click). Must not block rapid Ctrl+Z steps.
            int elapsed = unchecked((int)(now - _lastHistoryCmdTicks));
            if (elapsed >= 0 && elapsed < 40) return;
            _lastHistoryCmdTicks = now;
            SendMsg(cmd);
        }

        /// <summary>
        /// Menu Paste: same content path as Ctrl+V. WebView2 blocks document.execCommand('paste');
        /// host clipboard → paste_text → JS insertPastedPlainText (shared with the paste event).
        /// </summary>
        private void PasteFromClipboard()
        {
            try
            {
                try { if (_webView != null) _webView.Focus(); } catch { }
                string text = null;
                try
                {
                    if (Clipboard.ContainsText())
                        text = Clipboard.GetText(TextDataFormat.UnicodeText);
                }
                catch { }
                if (string.IsNullOrEmpty(text))
                {
                    try
                    {
                        if (WinForms.Clipboard.ContainsText())
                            text = WinForms.Clipboard.GetText();
                    }
                    catch { }
                }
                if (string.IsNullOrEmpty(text)) return;
                SendMsg("paste_text:" + text);
            }
            catch { }
        }

        private void EnsureAtLeastOneTab()
        {
            if (_tabs.Count == 0)
            {
                _tabs.Add(new DocTab
                {
                    Id = _nextTabId++,
                    FilePath = null,
                    Content = "",
                    IsDirty = false
                });
                _activeTabIndex = 0;
            }
            if (_activeTabIndex < 0 || _activeTabIndex >= _tabs.Count)
                _activeTabIndex = 0;
        }

        // Host↔editor document pull. Keep timeouts SHORT — long PushFrame freezes Close.
        private const int DocStateChunkChars = 256 * 1024;
        private const int DocStateFetchTimeoutMs = 8000;
        private const int DocStateCloseTimeoutMs = 2000;

        /// <summary>
        /// Run a script that returns a JSON string value. Short timeout only.
        /// Re-entrant calls return null immediately (avoids nested PushFrame deadlock).
        /// </summary>
        private string ExecuteScriptBlocking(string script, int timeoutMs)
        {
            if (_scriptBlockDepth > 0) return null;
            if (timeoutMs > 15000) timeoutMs = 15000;
            if (timeoutMs < 200) timeoutMs = 200;
            try
            {
                if (_webView == null || _webView.CoreWebView2 == null) return null;
                _scriptBlockDepth++;
                string result = null;
                bool done = false;
                var frame = new DispatcherFrame();
                var timer = new DispatcherTimer
                {
                    Interval = TimeSpan.FromMilliseconds(timeoutMs)
                };
                timer.Tick += (s, e) =>
                {
                    timer.Stop();
                    if (!done) { result = null; frame.Continue = false; }
                };
                timer.Start();
                var scriptTask = _webView.CoreWebView2.ExecuteScriptAsync(script);
                scriptTask.ContinueWith(t =>
                {
                    try
                    {
                        if (t.IsCompleted && !t.IsFaulted && !t.IsCanceled)
                            result = DecodeJsStringResult(t.Result);
                        else
                            result = null;
                    }
                    catch { result = null; }
                    finally
                    {
                        done = true;
                        Dispatcher.BeginInvoke(new Action(() =>
                        {
                            try { timer.Stop(); } catch { }
                            frame.Continue = false;
                        }), DispatcherPriority.Send);
                    }
                }, TaskScheduler.Default);
                var _perfSw = Program.PerfEnabled ? Stopwatch.StartNew() : null;
                Dispatcher.PushFrame(frame);
                try { timer.Stop(); } catch { }
                if (_perfSw != null)
                {
                    // Only the interesting ones: a stall, or a give-up. Everything else is noise.
                    _perfSw.Stop();
                    if (_perfSw.ElapsedMilliseconds >= 50 || (result == null && !done))
                    {
                        string tag = script.Length > 60 ? script.Substring(0, 60).Replace("\n", " ") : script.Replace("\n", " ");
                        Program.PerfMark(string.Format("   ExecuteScriptBlocking {0} ms{1} (budget {2} ms) :: {3}",
                            _perfSw.ElapsedMilliseconds, (done ? "" : "  *** TIMED OUT ***"), timeoutMs, tag));
                    }
                }
                return result;
            }
            catch { return null; }
            finally
            {
                if (_scriptBlockDepth > 0) _scriptBlockDepth--;
            }
        }

        /// <summary>
        /// Pull tagged document state. On large docs prefer a single tagged string when
        /// the page is in source mode (textarea). Chunk path has a hard overall budget.
        /// </summary>
        private string FetchDocumentStateBlocking(int timeoutMs = DocStateFetchTimeoutMs)
        {
            try
            {
                if (_webView == null || _webView.CoreWebView2 == null) return null;
                if (timeoutMs > 15000) timeoutMs = 15000;

                // Fast path: source mode returns textarea value in one shot (large docs open there).
                string tagged = ExecuteScriptBlocking(
                    "(function(){ try {" +
                    "  if (state && state.mode === 'source' && sourceEditor) {" +
                    "    var c = sourceEditor.value || '';" +
                    "    return (c !== state.lastSavedContent ? '1' : '0') + c;" +
                    "  }" +
                    "  return getDocumentStateTagged();" +
                    "} catch(e) { try { return getMarkdownContent(false); } catch(e2) { return null; } } })()",
                    timeoutMs);
                if (tagged != null) return tagged;

                // Chunked fallback with tight budget (save path only typically).
                string meta = ExecuteScriptBlocking(
                    "(function(){ try { return prepareDocumentStateForHost(); } catch(e) { return null; } })()",
                    Math.Min(timeoutMs, 5000));
                if (meta == null || meta.Length < 3
                    || (meta[0] != '0' && meta[0] != '1') || meta[1] != ':')
                    return null;

                int len;
                if (!int.TryParse(meta.Substring(2), out len) || len < 0) return null;
                // Too large to pull within close budget — fail fast, use host buffer.
                if (len > 2 * 1024 * 1024 && timeoutMs <= DocStateCloseTimeoutMs)
                {
                    ExecuteScriptBlocking(
                        "(function(){ try { releaseDocumentStateForHost(); } catch(e) {} return ''; })()",
                        500);
                    return null;
                }

                var sb = new StringBuilder(len + 1);
                sb.Append(meta[0]);
                int offset = 0;
                var sw = Stopwatch.StartNew();
                while (offset < len)
                {
                    int n = Math.Min(DocStateChunkChars, len - offset);
                    int remaining = timeoutMs - (int)sw.ElapsedMilliseconds;
                    if (remaining < 500) break;
                    string chunk = ExecuteScriptBlocking(
                        "(function(){ try { return getDocumentStateChunk(" + offset + "," + n + "); }" +
                        " catch(e) { return null; } })()",
                        Math.Min(remaining, 5000));
                    if (chunk == null || (n > 0 && chunk.Length == 0)) break;
                    sb.Append(chunk);
                    offset += chunk.Length;
                    if (chunk.Length < n) break;
                }
                ExecuteScriptBlocking(
                    "(function(){ try { releaseDocumentStateForHost(); } catch(e) {} return ''; })()",
                    500);
                if (offset == len) return sb.ToString();
                return null;
            }
            catch { return null; }
        }

        private async Task<string> FetchEditorContentAsync()
        {
            try
            {
                if (_webView == null || _webView.CoreWebView2 == null) return null;
                string r = await _webView.CoreWebView2.ExecuteScriptAsync(
                    "(function(){ try { return getMarkdownContent(); } catch(e) { return ''; } })()");
                return DecodeJsStringResult(r) ?? "";
            }
            catch { return null; }
        }

        /// <summary>
        /// Pull live editor text + dirty flag into the active tab.
        /// Returns true only when the WebView answered. On false the tab buffer is left
        /// unchanged — callers must not treat it as "current" for Save/Close.
        /// </summary>
        /// <param name="allowStaleIfClean">
        /// When true and the editor cannot be read, succeed using the last in-memory
        /// buffer ONLY if the tab looks clean. Dirty tabs always fail closed so we never
        /// silently abandon live edits. Never use allowStale on Save of a dirty buffer.
        /// </param>
        private bool SyncActiveTabFromEditor(bool allowStaleIfClean = false, int timeoutMs = -1)
        {
            if (_activeTabIndex < 0 || _activeTabIndex >= _tabs.Count) return true;

            // A book has nothing to pull. It is read-only, it is never dirty, it is never
            // saved, and ApplyTabToEditor reloads it from the file rather than from Content.
            // Pulling it anyway marshalled the whole book across the WebView bridge on every
            // tab switch -- Matter is 1,043,141 characters, which the page produces in 2ms
            // and the bridge takes six seconds to hand over. That blew the 3s budget, so
            // leaving a book tab either stalled for six seconds or failed and abandoned the
            // switch entirely.
            var activeTab = _tabs[_activeTabIndex];
            bool activeIsBook = IsBookTab(activeTab)
                || (!string.IsNullOrEmpty(_currentFilePath)
                    && _currentFilePath.EndsWith(".epub", StringComparison.OrdinalIgnoreCase));
            bool activeIsNative = IsNativeTab(activeTab)
                || IsNativePath(_currentFilePath)
                || IsNativePath(activeTab.FilePath);
            if (activeIsBook || activeIsNative)
            {
                if (!string.IsNullOrEmpty(_currentFilePath)) activeTab.FilePath = _currentFilePath;
                activeTab.Content = "";      // never the book's/native markup
                activeTab.IsDirty = false;
                _isDirty = false;
                return true;
            }

            if (timeoutMs < 0) timeoutMs = DocStateFetchTimeoutMs;

            // Clean leave: keep the last in-memory buffer and skip the WebView round trip.
            // Typing sets _isDirty / tab.IsDirty immediately (msg "typing"), so this does
            // not drop unsaved work. Dirty tabs still pull the full body below.
            if (allowStaleIfClean && ActiveTabLooksClean())
            {
                if (!string.IsNullOrEmpty(_currentFilePath)) activeTab.FilePath = _currentFilePath;
                return true;
            }

            // If already inside a blocking script, do not nest — treat as stale/fail.
            if (_scriptBlockDepth > 0)
            {
                if (allowStaleIfClean && ActiveTabLooksClean()) return true;
                return false;
            }

            // Cheap dirty probe before a full body pull. Host may still say dirty after
            // undo-to-saved or a lagging flag; page Source compare / model join is enough
            // to clear that without marshalling multi‑MB markdown.
            try
            {
                string flag = ExecuteScriptBlocking(
                    "(function(){ try {" +
                    "  if (typeof getDocumentDirtyFlag === 'function') return getDocumentDirtyFlag();" +
                    "  return '1';" +
                    "} catch(e) { return '1'; } })()",
                    Math.Min(Math.Max(timeoutMs, 200), 800));
                if (flag == "0")
                {
                    activeTab.IsDirty = false;
                    _isDirty = false;
                    if (!string.IsNullOrEmpty(_currentFilePath)) activeTab.FilePath = _currentFilePath;
                    return true;
                }
            }
            catch { /* fall through to full pull */ }

            string tagged = FetchDocumentStateBlocking(timeoutMs);
            if (tagged == null)
            {
                if (allowStaleIfClean && ActiveTabLooksClean()) return true;
                return false;
            }

            // getDocumentStateTagged prefixes "1"/"0" for dirty. Reading it here makes
            // the close path authoritative: the stats message that sets _isDirty is
            // debounced, so a keystroke in the last few ms before closing would
            // otherwise look like a clean buffer and skip the save prompt.
            bool dirty = _isDirty;
            string content = tagged;
            if (tagged.Length >= 1 && (tagged[0] == '0' || tagged[0] == '1'))
            {
                dirty = (tagged[0] == '1');
                content = tagged.Substring(1);
            }

            var tab = _tabs[_activeTabIndex];
            tab.Content = content;
            tab.FilePath = _currentFilePath;
            // Books never dirty, even if the page snapshot disagrees with lastSavedContent.
            if (IsBookTab(tab)
                || (!string.IsNullOrEmpty(_currentFilePath)
                    && _currentFilePath.EndsWith(".epub", StringComparison.OrdinalIgnoreCase)))
            {
                dirty = false;
            }
            tab.IsDirty = dirty;
            _isDirty = dirty;
            return true;
        }

        private void NotifyEditorSyncFailedForSave()
        {
            if (_e2eMode) return;
            WinForms.MessageBox.Show(
                "Could not read the latest text from the editor.\n\n" +
                "The file was not saved. Try again in a moment.",
                "Could not reach editor",
                WinForms.MessageBoxButtons.OK,
                WinForms.MessageBoxIcon.Warning);
        }

        private void NotifyEditorSyncFailedForTabOp()
        {
            if (_e2eMode) return;
            WinForms.MessageBox.Show(
                "Could not read the latest text from the editor.\n\n" +
                "Staying on this tab so recent typing is not lost. Try again in a moment.",
                "Could not reach editor",
                WinForms.MessageBoxButtons.OK,
                WinForms.MessageBoxIcon.Warning);
        }

        /// <summary>
        /// Host-driven multi-tab content isolation test. Set env TYPOZEN_TAB_E2E to an output directory.
        /// Writes tab-e2e-result.txt (PASS/FAIL + log) then closes the app.
        /// </summary>
        private void ScheduleTabContentE2E()
        {
            if (!_e2eMode) return;
            string dir = _e2eDir;
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(900) };
            timer.Tick += async (s, e) =>
            {
                timer.Stop();
                await RunTabContentE2EAsync(dir.Trim());
            };
            timer.Start();
        }

        private async Task RunTabContentE2EAsync(string dir)
        {
            var log = new StringBuilder();
            bool ok = true;
            Action<string> Pass = m => log.AppendLine("OK  " + m);
            Action<string> Fail = m => { ok = false; log.AppendLine("FAIL " + m); };

            // Refuse to run against a stale binary. A locked exe once made the build fail
            // while the harness happily reported PASS against the previous compile — a
            // green run for code that was never built is worse than no run at all.
            // (Only the .cs matters: the template and themes are runtime assets.)
            try
            {
                string srcPath = Path.Combine(_appDir, "TypoZen_App.cs");
                string exePath = System.Reflection.Assembly.GetEntryAssembly() != null
                    ? System.Reflection.Assembly.GetEntryAssembly().Location
                    : Path.Combine(_appDir, "TypoZen.exe");
                if (File.Exists(srcPath) && File.Exists(exePath))
                {
                    DateTime srcTime = File.GetLastWriteTimeUtc(srcPath);
                    DateTime exeTime = File.GetLastWriteTimeUtc(exePath);
                    if (srcTime > exeTime)
                    {
                        string msg =
                            "STALE BINARY\nTypoZen_App.cs is newer than TypoZen.exe - rebuild before running the E2E.\n" +
                            "  TypoZen_App.cs : " + srcTime.ToString("yyyy-MM-dd HH:mm:ss.fff") + " UTC" + "\n" +
                            "  TypoZen.exe    : " + exeTime.ToString("yyyy-MM-dd HH:mm:ss.fff") + " UTC" + "\n";
                        try { Directory.CreateDirectory(dir); } catch { }
                        try
                        {
                            File.WriteAllText(Path.Combine(dir, "tab-e2e-result.txt"),
                                "FAIL\n" + msg, new UTF8Encoding(false));
                        }
                        catch { }
                        _forceClose = true;
                        Close();
                        return;
                    }
                }
            }
            catch { }
            const string TOKEN_A = "TAB_TOKEN_ALPHA_7f3c";
            const string TOKEN_B = "TAB_TOKEN_BRAVO_9e2d";
            // ================= CORE EDITING LOOP =================
            // Runs FIRST, before any feature-specific probe. This is the sequence a user
            // performs constantly — type, Enter, type, Enter twice, Backspace, Delete —
            // asserting the document AND the caret after every step.
            //
            // It exists because the suite had grown around whatever I last edited: "Enter
            // at line start" was covered the day I touched it, while "Enter at end of
            // line" had no test at all and shipped broken. Text is inserted with
            // execCommand('insertText'), which fires the same beforeinput/input events as
            // real typing, so this exercises the production path rather than a shortcut.
            try
            {
                string coreJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                    "(function(){" +
                    "  var out = [];" +
                    "  function blocks(){ return Array.prototype.slice.call(document.querySelectorAll('#editor .block')); }" +
                    "  function caret(){" +
                    "    var s = window.getSelection();" +
                    "    var blk = s && s.anchorNode ? getAncestorBlock(s.anchorNode) : null;" +
                    "    var off = -1;" +
                    "    try { var r = document.createRange(); r.selectNodeContents(blk);" +
                    "          r.setEnd(s.anchorNode, s.anchorOffset); off = r.toString().length; } catch(e){}" +
                    "    return { i: blk ? blocks().indexOf(blk) : -1, off: off };" +
                    "  }" +
                    "  function snap(name){ out.push({ step: name, doc: getMarkdownContent(false)," +
                    "      n: blocks().length, caret: caret() }); }" +
                    "  function type(t){ editor.focus(); document.execCommand('insertText', false, t); }" +
                    "  function enter(){ var s = window.getSelection();" +
                    "      var blk = s && s.anchorNode ? getAncestorBlock(s.anchorNode) : null;" +
                    "      if (blk) handleEnterAtBlock(blk, false); }" +
                    "  function caretToStartOfBlock(i){ var b = blocks()[i]; var r = document.createRange();" +
                    "      r.selectNodeContents(b); r.collapse(true);" +
                    "      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }" +
                    "  loadMarkdownContent('');" +
                    "  editor.focus(); caretToStartOfBlock(0);" +
                    "  type('alpha');      snap('type');" +
                    "  enter();            snap('enterAtEnd');" +
                    "  type('beta');       snap('typeOnNewLine');" +
                    "  enter(); enter();   snap('enterTwice');" +
                    "  caretToStartOfBlock(1); enter(); snap('enterAtStart');" +
                    // Backspace at the start of a line must merge it into the previous one.
                    // execCommand('delete') on a collapsed caret is what the browser does
                    // for a real Backspace, so this exercises whichever path actually runs.
                    "  loadMarkdownContent('alpha\\nbeta');" +
                    "  editor.focus(); caretToStartOfBlock(1);" +
                    "  editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Backspace', bubbles:true, cancelable:true}));" +
                    "  snap('backspaceMerge');" +
                    // Undo must put it back
                    "  HistoryManager.undo();" +
                    "  snap('undoAfterMerge');" +
                    // Enter on a list line continues the list
                    "  loadMarkdownContent('- item');" +
                    "  editor.focus();" +
                    "  (function(){ var b = blocks()[0]; var r = document.createRange();" +
                    "     r.selectNodeContents(b); r.collapse(false);" +
                    "     var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); })();" +
                    "  enter();" +
                    "  snap('listContinuation');" +

                    // ---- The structural paths that were never audited ----
                    // Each one changes block structure through the browser rather than our
                    // handlers, and the one-block-one-line serializer keeps only the first
                    // child of a block — which is how Delete and Backspace ate whole lines.
                    "  function selectAcross(i0, off0, i1, off1){" +
                    "    var bs = blocks();" +
                    "    var t0 = bs[i0].innerText !== undefined ? bs[i0] : bs[i0];" +
                    "    var r = document.createRange();" +
                    "    var n0 = bs[i0].querySelector('p') || bs[i0];" +
                    "    var n1 = bs[i1].querySelector('p') || bs[i1];" +
                    "    r.setStart(n0.firstChild || n0, off0);" +
                    "    r.setEnd(n1.firstChild || n1, off1);" +
                    "    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                    "  }" +
                    "  function pasteText(t){" +
                    "    var dt = new DataTransfer(); dt.setData('text/plain', t);" +
                    "    editor.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles:true, cancelable:true}));" +
                    "  }" +

                    // 1. multi-line paste at a caret
                    "  loadMarkdownContent('alpha');" +
                    "  editor.focus();" +
                    "  (function(){ var b = blocks()[0]; var r = document.createRange();" +
                    "     r.selectNodeContents(b); r.collapse(false);" +
                    "     var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); })();" +
                    "  pasteText('\\nuno\\ndos\\ntres');" +
                    "  snap('pasteMultiline');" +

                    // 2. deleting a selection that spans two lines (what Ctrl+X does)
                    "  loadMarkdownContent('alpha\\nbeta\\ngamma');" +
                    "  editor.focus(); selectAcross(0, 2, 2, 3);" +
                    "  document.execCommand('delete');" +
                    "  snap('crossBlockDelete');" +

                    // 3. pasting over a selection that spans two lines
                    "  loadMarkdownContent('alpha\\nbeta\\ngamma');" +
                    "  editor.focus(); selectAcross(0, 2, 2, 3);" +
                    "  pasteText('XX');" +
                    "  snap('pasteOverCrossBlock');" +

                    // 4. spellcheck replacement (browser fires insertReplacementText)
                    "  loadMarkdownContent('teh word');" +
                    "  editor.focus();" +
                    "  (function(){ var p = blocks()[0].querySelector('p') || blocks()[0];" +
                    "     var r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 3);" +
                    "     var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); })();" +
                    "  document.execCommand('insertText', false, 'the');" +
                    "  snap('spellReplace');" +

                    // Arrow navigation between lines. Most of this logic sits in a per-block
                    // keydown listener that never fires, so what actually moves the caret is
                    // the browser. Pinned before removing that dead code, to prove nothing
                    // real was living in it.
                    "  loadMarkdownContent('first line\\nsecond line\\nthird line');" +
                    "  editor.focus(); caretToStartOfBlock(1);" +
                    "  (function(){" +
                    "    var keys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'];" +
                    "    for (var i = 0; i < keys.length; i++) {" +
                    "      editor.dispatchEvent(new KeyboardEvent('keydown'," +
                    "        {key: keys[i], bubbles: true, cancelable: true}));" +
                    "    }" +
                    "  })();" +
                    "  snap('arrowKeysLeaveDocIntact');" +

                    // Enter must keep the caret ON SCREEN. Fill past the viewport, put the
                    // caret on the last line, then press Enter repeatedly: the new line has
                    // to be inside the scroll container, not below the fold with the user
                    // typing blind.
                    "  var many = [];" +
                    "  for (var i = 0; i < 60; i++) many.push('line ' + i);" +
                    "  loadMarkdownContent(many.join('\\n'));" +
                    "  editor.focus();" +
                    "  caretToStartOfBlock(blocks().length - 1);" +
                    "  for (var k = 0; k < 6; k++) enter();" +
                    "  var s2 = window.getSelection();" +
                    "  var cb = s2 && s2.anchorNode ? getAncestorBlock(s2.anchorNode) : null;" +
                    "  var visible = false, cRect = null, bRect = null;" +
                    "  if (cb) {" +
                    "    cRect = mainContainer.getBoundingClientRect();" +
                    "    bRect = cb.getBoundingClientRect();" +
                    "    visible = bRect.top >= cRect.top - 1 && bRect.bottom <= cRect.bottom + 1;" +
                    "  }" +
                    "  out.push({ step: 'caretVisibleAfterEnter', visible: visible," +
                    "    caretTop: cb ? Math.round(bRect.top) : -1," +
                    "    viewBottom: cb ? Math.round(cRect.bottom) : -1 });" +
                    // leave no trace: later probes assume a clean, reusable first tab
                    "  loadMarkdownContent('');" +
                    "  state.lastSavedContent = getMarkdownContent(false);" +
                    "  return JSON.stringify(out);" +
                    "})()"));
                log.AppendLine("COREEDIT " + coreJson);

                // Which per-block listeners saw anything during all of the above (typing,
                // Enter, Backspace, paste, cut, cross-block delete, spellcheck replace)?
                string fireJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                    "JSON.stringify(window.__tzBlockFire)"));
                log.AppendLine("BLOCKFIRE " + fireJson);
                if (fireJson.IndexOf("\"keydown\":0", StringComparison.Ordinal) >= 0 &&
                    fireJson.IndexOf("\"input\":0", StringComparison.Ordinal) >= 0)
                    Pass("no editing logic is attached per block (it would never run)");
                else
                    Fail("a per-block listener fired: " + fireJson + " — editing handlers belong on #editor");

                Action<string, string, string> step = (name, needle, why) =>
                {
                    if (coreJson.IndexOf(needle, StringComparison.Ordinal) >= 0) Pass("core editing: " + why);
                    else Fail("core editing: " + why + " — expected " + needle + " in " + coreJson);
                };
                // typing five characters leaves one block, caret after them
                step("type", "\"step\":\"type\",\"doc\":\"alpha\",\"n\":1,\"caret\":{\"i\":0,\"off\":5}",
                    "typing puts text in the line and the caret after it");
                // Enter at end: a second block, caret ON it (this is what shipped broken)
                step("enterAtEnd", "\"step\":\"enterAtEnd\",\"doc\":\"alpha\",\"n\":2,\"caret\":{\"i\":1,\"off\":0}",
                    "Enter at end of line moves the caret to the new line");
                step("typeOnNewLine", "\"step\":\"typeOnNewLine\",\"doc\":\"alpha\\nbeta\",\"n\":2,\"caret\":{\"i\":1,\"off\":4}",
                    "typing continues on the new line");
                // two Enters: two more blocks, caret on the last
                step("enterTwice", "\"step\":\"enterTwice\",\"doc\":\"alpha\\nbeta\",\"n\":4,\"caret\":{\"i\":3,\"off\":0}",
                    "pressing Enter twice adds two lines and keeps the caret with you");
                // Enter at start of 'beta': blank line above, caret stays on the text
                step("enterAtStart", "\"step\":\"enterAtStart\",\"doc\":\"alpha\\n\\nbeta\",\"n\":5,\"caret\":{\"i\":2,\"off\":0}",
                    "Enter at start of a line pushes it down and the caret follows the text");
                step("caretVisible", "\"step\":\"caretVisibleAfterEnter\",\"visible\":true",
                    "the caret stays on screen when Enter pushes past the bottom");
                // Backspace at line start joins the lines and KEEPS BOTH halves. It used to
                // merge an "empty" line in and destroy the text that was on it.
                step("backspaceMerge", "\"step\":\"backspaceMerge\",\"doc\":\"alphabeta\",\"n\":1",
                    "Backspace joins two lines without losing either one");
                step("undoAfterMerge", "\"step\":\"undoAfterMerge\",\"doc\":\"alpha\\nbeta\",\"n\":2",
                    "undo restores the two lines after a merge");
                step("listContinuation", "\"step\":\"listContinuation\",\"doc\":\"- item\\n- \",\"n\":2",
                    "Enter on a list line continues the list");

                // The four structural paths the browser used to drive on its own. Each of
                // these failed before the editor-level input/cut/dragstart guards went in:
                // the DOM changed, data-raw did not, and getBlockRaw preferred whichever of
                // the two was LONGER — so every shrinking edit silently reverted.
                step("pasteMultiline", "\"step\":\"pasteMultiline\",\"doc\":\"alpha\\nuno\\ndos\\ntres\",\"n\":4",
                    "pasting several lines creates a line for each");
                step("crossBlockDelete", "\"step\":\"crossBlockDelete\",\"doc\":\"alma\",\"n\":1",
                    "deleting a selection spanning lines joins the surviving halves");
                step("pasteOverCrossBlock", "\"step\":\"pasteOverCrossBlock\",\"doc\":\"alXXma\",\"n\":1",
                    "pasting over a selection spanning lines replaces it in place");
                step("spellReplace", "\"step\":\"spellReplace\",\"doc\":\"the word\",\"n\":1",
                    "replacing a word in place keeps the correction");
                step("arrowKeys", "\"step\":\"arrowKeysLeaveDocIntact\",\"doc\":\"first line\\nsecond line\\nthird line\",\"n\":3",
                    "arrow and Home/End keys never alter the document");
            }
            catch (Exception exCore)
            {
                Fail("core editing loop threw: " + exCore.Message);
            }

            // ...and reset the host-side buffer to match, so the tab-reuse tests below
            // still start from a clean untitled document.
            if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count)
            {
                _tabs[_activeTabIndex].Content = "";
                _tabs[_activeTabIndex].IsDirty = false;
                _isDirty = false;
            }

            try
            {
                Directory.CreateDirectory(dir);
                string pathA = Path.Combine(dir, "tab_a.md");
                string pathB = Path.Combine(dir, "tab_b.md");
                File.WriteAllText(pathA, "# Doc A\n\n" + TOKEN_A + "\n", new UTF8Encoding(false));
                File.WriteAllText(pathB, "# Doc B\n\n" + TOKEN_B + "\n", new UTF8Encoding(false));

                LoadFileFromPath(pathA);
                await Task.Delay(700);
                string ed = await FetchEditorContentAsync();
                if (ed != null && ed.Contains(TOKEN_A)) Pass("open A → editor has TOKEN_A");
                else Fail("open A → editor missing TOKEN_A got=[" + Trunc(ed) + "]");

                NewTab();
                await Task.Delay(400);
                LoadFileFromPath(pathB);
                await Task.Delay(700);
                ed = await FetchEditorContentAsync();
                if (ed != null && ed.Contains(TOKEN_B)) Pass("open B → editor has TOKEN_B");
                else Fail("open B → editor missing TOKEN_B got=[" + Trunc(ed) + "]");

                // Expect exactly two file tabs after open A + New + open B (reuse empty untitled)
                if (_tabs.Count == 2) Pass("tab count=2 (no leftover empty untitled)");
                else Fail("expected exactly 2 tabs after A+New+B, got " + _tabs.Count);

                int aIdx = IndexOfTabPath(pathA);
                int bIdx = IndexOfTabPath(pathB);
                if (aIdx < 0) Fail("tab for A not found");
                else Pass("A tab index=" + aIdx);
                if (bIdx < 0) Fail("tab for B not found");
                else Pass("B tab index=" + bIdx);

                // Switch to A by path index
                if (aIdx >= 0)
                {
                    SwitchToTab(aIdx);
                    await Task.Delay(800);
                    ed = await FetchEditorContentAsync();
                    if (ed != null && ed.Contains(TOKEN_A)) Pass("switch→A editor has TOKEN_A");
                    else Fail("switch→A missing TOKEN_A got=[" + Trunc(ed) + "]");
                    if (ed != null && ed.Contains(TOKEN_B)) Fail("switch→A leaked TOKEN_B");
                    else if (ed != null) Pass("switch→A no TOKEN_B leak");
                }

                // Switch to B
                if (bIdx >= 0)
                {
                    SwitchToTab(bIdx);
                    await Task.Delay(800);
                    ed = await FetchEditorContentAsync();
                    if (ed != null && ed.Contains(TOKEN_B)) Pass("switch→B editor has TOKEN_B");
                    else Fail("switch→B missing TOKEN_B got=[" + Trunc(ed) + "]");
                    if (ed != null && ed.Contains(TOKEN_A)) Fail("switch→B leaked TOKEN_A");
                    else if (ed != null) Pass("switch→B no TOKEN_A leak");
                }

                // In-memory buffers
                for (int i = 0; i < _tabs.Count; i++)
                {
                    string c = _tabs[i].Content ?? "";
                    string fp = _tabs[i].FilePath ?? "(untitled)";
                    log.AppendLine("  tab[" + i + "] path=" + Path.GetFileName(fp) + " content=[" + Trunc(c) + "]");
                }
                if (aIdx >= 0)
                {
                    string ca = _tabs[aIdx].Content ?? "";
                    if (ca.Contains(TOKEN_A)) Pass("tab[A].Content has TOKEN_A");
                    else Fail("tab[A].Content missing TOKEN_A");
                }
                if (bIdx >= 0)
                {
                    string cb = _tabs[bIdx].Content ?? "";
                    if (cb.Contains(TOKEN_B)) Pass("tab[B].Content has TOKEN_B");
                    else Fail("tab[B].Content missing TOKEN_B");
                }

                // Round-trip A again
                if (aIdx >= 0)
                {
                    SwitchToTab(aIdx);
                    await Task.Delay(800);
                    ed = await FetchEditorContentAsync();
                    if (ed != null && ed.Contains(TOKEN_A)) Pass("2nd switch→A still has TOKEN_A");
                    else Fail("2nd switch→A lost TOKEN_A got=[" + Trunc(ed) + "]");
                }

                // --- Regression: a save must target its own tab, never the active path ---
                // Closing a dirty tab used to call the async SaveFile(); the reply landed
                // after the tab was removed and _currentFilePath had moved to the next
                // tab, writing one document's text into another document's file.
                if (aIdx >= 0 && bIdx >= 0)
                {
                    SwitchToTab(bIdx);
                    await Task.Delay(700);
                    const string EDIT_A = "EDITED_IN_TAB_A_4b21";
                    string bDiskBefore = File.ReadAllText(pathB);

                    _tabs[aIdx].Content = "# Doc A\n\n" + TOKEN_A + "\n" + EDIT_A + "\n";
                    _tabs[aIdx].IsDirty = true;

                    bool saved = SaveTabNow(_tabs[aIdx], false);
                    if (saved) Pass("SaveTabNow(inactive A) succeeded");
                    else Fail("SaveTabNow(inactive A) returned false");

                    string aDisk = File.ReadAllText(pathA);
                    string bDiskAfter = File.ReadAllText(pathB);

                    if (aDisk.Contains(EDIT_A)) Pass("A.md received A's edit");
                    else Fail("A.md missing A's edit got=[" + Trunc(aDisk) + "]");
                    if (bDiskAfter == bDiskBefore) Pass("B.md byte-identical while saving A");
                    else Fail("B.md changed while saving A got=[" + Trunc(bDiskAfter) + "]");
                    if (!bDiskAfter.Contains(EDIT_A)) Pass("B.md free of A's text (no cross-tab write)");
                    else Fail("CROSS-TAB WRITE: B.md contains A's text");
                    if (!_tabs[aIdx].IsDirty) Pass("A marked clean after save");
                    else Fail("A still dirty after save");
                    if (_activeTabIndex == bIdx) Pass("active tab still B after saving A");
                    else Fail("active tab moved to " + _activeTabIndex + " while saving inactive A");
                    string cur = _currentFilePath == null ? "null" : Path.GetFullPath(_currentFilePath);
                    if (cur == Path.GetFullPath(pathB)) Pass("_currentFilePath still points at B");
                    else Fail("_currentFilePath drifted to [" + cur + "]");
                }

                // --- Regression: close prompts for EVERY dirty buffer ---
                // Closing only checked _isDirty (active tab only), so unsaved background
                // tabs were dropped silently and never reached the prefs scratchpad.
                if (_tabs.Count >= 2)
                {
                    for (int i = 0; i < _tabs.Count; i++) _tabs[i].IsDirty = false;
                    _tabs[0].IsDirty = true;
                    _tabs[1].IsDirty = true;
                    int pendingCount = GetDirtyTabs().Count;
                    if (pendingCount == 2) Pass("close would prompt for both dirty buffers");
                    else Fail("close would prompt for " + pendingCount + " buffer(s), expected 2");

                    for (int i = 0; i < _tabs.Count; i++) _tabs[i].IsDirty = false;
                    if (GetDirtyTabs().Count == 0) Pass("no prompts when nothing is dirty");
                    else Fail("clean buffers still queued for prompting");
                }

                // --- Regression: non-UTF-8 files must decode correctly ---
                // Everything used to be read as UTF-8, so ANSI / UTF-16 files loaded as
                // mojibake and the first save wrote that mojibake back over the original.
                {
                    const string ACCENTS = "café naïve Grüße";
                    string ansiPath = Path.Combine(dir, "enc_ansi.txt");
                    string utf16Path = Path.Combine(dir, "enc_utf16.txt");
                    string utf8BomPath = Path.Combine(dir, "enc_utf8bom.md");
                    string plainPath = Path.Combine(dir, "enc_plain.md");

                    File.WriteAllText(ansiPath, ACCENTS, Encoding.Default);
                    File.WriteAllText(utf16Path, ACCENTS, new UnicodeEncoding(false, true));
                    File.WriteAllText(utf8BomPath, ACCENTS, new UTF8Encoding(true));
                    File.WriteAllText(plainPath, ACCENTS, new UTF8Encoding(false));

                    string encName;
                    string got = ReadTextFileDetect(ansiPath, out encName);
                    if (got == ACCENTS) Pass("ANSI file decoded correctly (" + encName + ")");
                    else Fail("ANSI decode wrong enc=" + encName + " got=[" + Trunc(got) + "]");

                    got = ReadTextFileDetect(utf16Path, out encName);
                    if (got == ACCENTS) Pass("UTF-16 LE file decoded correctly (" + encName + ")");
                    else Fail("UTF-16 decode wrong enc=" + encName + " got=[" + Trunc(got) + "]");

                    got = ReadTextFileDetect(utf8BomPath, out encName);
                    if (got == ACCENTS && encName.IndexOf("BOM") >= 0) Pass("UTF-8 BOM stripped (" + encName + ")");
                    else Fail("UTF-8 BOM decode wrong enc=" + encName + " got=[" + Trunc(got) + "]");

                    got = ReadTextFileDetect(plainPath, out encName);
                    if (got == ACCENTS && encName == "UTF-8") Pass("plain UTF-8 unchanged");
                    else Fail("plain UTF-8 decode wrong enc=" + encName + " got=[" + Trunc(got) + "]");

                    // Round trip through the editor: open the ANSI file, save it, reread.
                    LoadFileFromPath(ansiPath);
                    await Task.Delay(700);
                    string edEnc = await FetchEditorContentAsync();
                    if (edEnc != null && edEnc.Contains("café")) Pass("editor shows decoded accents");
                    else Fail("editor mojibake got=[" + Trunc(edEnc) + "]");

                    int ansiIdx = IndexOfTabPath(ansiPath);
                    if (ansiIdx >= 0 && SaveTabNow(_tabs[ansiIdx], false))
                    {
                        string after = ReadTextFileDetect(ansiPath, out encName);
                        if (after.Contains("café") && after.Contains("Grüße"))
                            Pass("saved back as UTF-8 with accents intact (" + encName + ")");
                        else
                            Fail("save mangled accents enc=" + encName + " got=[" + Trunc(after) + "]");
                    }
                    else Fail("could not save the reopened ANSI file");
                }

                // --- Regression: state files are written atomically ---
                {
                    string atomicPath = Path.Combine(dir, "atomic_probe.json");
                    File.WriteAllText(atomicPath, "{\"old\":true}", new UTF8Encoding(false));
                    WriteStateFileAtomic(atomicPath, "{\"new\":true}");
                    string readBack = File.ReadAllText(atomicPath);
                    if (readBack == "{\"new\":true}") Pass("atomic write replaced existing file");
                    else Fail("atomic write result=[" + Trunc(readBack) + "]");
                    if (!File.Exists(atomicPath + ".tmp")) Pass("no .tmp left behind");
                    else Fail(".tmp file left behind after atomic write");

                    string nestedPath = Path.Combine(dir, "made", "up", "dirs", "state.json");
                    WriteStateFileAtomic(nestedPath, "{\"ok\":1}");
                    if (File.Exists(nestedPath)) Pass("atomic write creates missing directories");
                    else Fail("atomic write did not create the directory chain");
                }

                // --- Regression: the close path must see an edit made microseconds ago ---
                // Stats are debounced (150ms), so _isDirty can lag. If the save-on-close
                // prompt trusted that flag, typing and immediately hitting the X would
                // look like a clean buffer and silently discard the edit.
                {
                    LoadFileFromPath(pathA);
                    await Task.Delay(800);
                    SyncActiveTabFromEditor();
                    int idx = _activeTabIndex;
                    if (idx >= 0 && idx < _tabs.Count)
                    {
                        if (!_tabs[idx].IsDirty) Pass("freshly loaded buffer reads clean");
                        else Fail("freshly loaded buffer already reported dirty");

                        // Edit, then sync with NO pause for the debounce to fire.
                        await _webView.CoreWebView2.ExecuteScriptAsync(
                            "(function(){ var b = document.querySelector('#editor .block');" +
                            " if (b) b.setAttribute('data-raw', '# Doc A EDITED_JUST_NOW'); })()");
                        SyncActiveTabFromEditor();

                        if (_tabs[idx].IsDirty) Pass("edit seen immediately, before the stats debounce fires");
                        else Fail("DIRTY MISSED: closing now would silently discard the edit");
                        if ((_tabs[idx].Content ?? "").IndexOf("EDITED_JUST_NOW", StringComparison.Ordinal) >= 0)
                            Pass("synced buffer contains the fresh edit");
                        else Fail("synced buffer missing the fresh edit");
                        if (GetDirtyTabs().Count >= 1) Pass("dirty buffer would be prompted on close");
                        else Fail("dirty buffer would NOT be prompted on close");

                        _tabs[idx].IsDirty = false; // leave the app closable without prompts
                    }
                }

                // --- Regression: open + save untouched must be byte-identical ---
                // The editor is LF-internal and its serializer drops trailing blank
                // lines, so saving a file nobody edited used to rewrite every line of a
                // CRLF document and drop the final newline of almost any document.
                {
                    Func<string, string, bool> sameBytes = (p1, p2) =>
                    {
                        byte[] a = File.ReadAllBytes(p1);
                        byte[] b = File.ReadAllBytes(p2);
                        if (a.Length != b.Length) return false;
                        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
                        return true;
                    };

                    var shapes = new List<string[]>
                    {
                        new string[] { "lf_trailing.md",   "# Title\n\nBody text here.\n\n- one\n- two\n" },
                        new string[] { "lf_none.md",       "# Title\n\nBody text here.\n\n- one\n- two" },
                        new string[] { "crlf.md",          "# Title\r\n\r\nBody text here.\r\n\r\n- one\r\n- two\r\n" },
                        new string[] { "lf_multi.md",      "# Title\n\nBody text here.\n\n\n" },
                        // Emphasis markers, snake_case and code spans must come back
                        // exactly as typed, not normalised to the editor's preferred form.
                        new string[] { "emphasis.md",
                            "# Title\n\n_italic_ and __bold__ and ___both___\n\n*star* and **starbold**\n\n" +
                            "A `code_span_here` plus MAX_BUFFER_SIZE and an ![img](pic.png).\n" }
                    };

                    foreach (var shape in shapes)
                    {
                        string fPath = Path.Combine(dir, shape[0]);
                        string original = Path.Combine(dir, shape[0] + ".orig");
                        File.WriteAllText(fPath, shape[1], new UTF8Encoding(false));
                        File.WriteAllText(original, shape[1], new UTF8Encoding(false));

                        LoadFileFromPath(fPath);
                        await Task.Delay(700);

                        int ti = IndexOfTabPath(fPath);
                        if (ti < 0) { Fail("roundtrip " + shape[0] + ": tab not found"); continue; }
                        SyncActiveTabFromEditor();
                        if (!SaveTabNow(_tabs[ti], false)) { Fail("roundtrip " + shape[0] + ": save failed"); continue; }

                        if (sameBytes(fPath, original)) Pass("open+save untouched is byte-identical: " + shape[0]);
                        else
                        {
                            string got = File.ReadAllText(fPath);
                            Fail("roundtrip " + shape[0] + " CHANGED got=[" + Trunc(got) + "] want=[" + Trunc(shape[1]) + "]");
                        }
                    }
                }

                // --- Regression: the stats path must not destroy the caret ---
                // getMarkdownContent() expands fragmented blocks, which rewrites
                // block.innerHTML and wipes any selection inside. That was safe while it
                // only ran inside the input handler (which re-focuses straight after);
                // once stats were debounced onto a timer it could fire between keystrokes
                // and silently drop the caret, so the next Enter went nowhere.
                {
                    LoadFileFromPath(pathA);
                    await Task.Delay(800);
                    string caretProbe =
                        "(function(){" +
                        "  var b = document.querySelector('#editor .block');" +
                        "  if (!b) return 'no-block';" +
                        // Simulate what Chrome leaves behind while typing: text + trailing <br>
                        "  b.innerHTML = '<p>typed line one<br></p>';" +
                        "  b.setAttribute('data-raw', 'typed line one');" +
                        "  var tn = b.querySelector('p').firstChild;" +
                        "  var r = document.createRange();" +
                        "  r.setStart(tn, 5); r.collapse(true);" +
                        "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                        "  var before = s.anchorNode;" +
                        // The debounced stats pass — what actually fires mid-edit on a
                        // timer. It must be a pure read. (getMarkdownContent() with repair
                        // on is still allowed to restructure; only edit paths call it.)
                        "  updateStatsNow();" +
                        "  var s2 = window.getSelection();" +
                        "  var after = s2 ? s2.anchorNode : null;" +
                        "  return JSON.stringify({" +
                        "    hadCaret: !!before," +
                        "    stillConnected: !!(before && before.isConnected)," +
                        "    selectionAlive: !!(after && after.isConnected)," +
                        "    blocks: document.querySelectorAll('#editor .block').length });" +
                        "})()";
                    string caretRaw = await _webView.CoreWebView2.ExecuteScriptAsync(caretProbe);
                    string caretJson = DecodeJsStringResult(caretRaw);
                    log.AppendLine("CARET " + caretJson);
                    if (caretJson.IndexOf("\"stillConnected\":true", StringComparison.Ordinal) >= 0)
                        Pass("caret survives a stats-path serialize");
                    else
                        Fail("CARET LOST during getMarkdownContent: " + caretJson);
                }

                // --- Regression: forward Delete pulls the next line up ---
                // Driven with a REAL keystroke, not a synthesised KeyboardEvent. Only
                // #editor is contenteditable, so a real Delete targets #editor and never
                // reaches a listener on a child .block — a dispatch aimed straight at the
                // block "passed" against a handler that could never fire in practice.
                await RunForwardDeleteKeyCase("alpha\\n\\ngamma", 1, "alpha\ngamma", 2,
                    "empty line, text below", Pass, Fail, log);
                await RunForwardDeleteKeyCase("alpha\\n\\n\\ngamma", 1, "alpha\n\ngamma", 3,
                    "empty line, EMPTY line below", Pass, Fail, log);
                await RunForwardDeleteKeyCase("alpha\\nbravo", 0, "alphabravo", 1,
                    "end of a text line", Pass, Fail, log);

                // --- Regression: emptying a line must not spawn phantom blank lines ---
                // Chrome leaves a filler <br> in a block whose text you just deleted; the
                // split logic counted it as another visual line, so deleting the last
                // characters of a line gave that line back plus two blank ones.
                {
                    string fillerProbe =
                        "(function(){" +
                        "  loadMarkdownContent('dfvbgdf\\nfg\\ngf\\ngbf');" +
                        "  var before = document.querySelectorAll('#editor .block').length;" +
                        "  var b = document.querySelectorAll('#editor .block')[1];" +
                        // exactly what Chrome leaves after you delete 'f' then 'g'
                        "  b.innerHTML = '<p><br></p>';" +
                        "  b.setAttribute('data-raw', '');" +
                        "  expandAllFragmentedBlocks();" +
                        "  return JSON.stringify({" +
                        "    before: before," +
                        "    after: document.querySelectorAll('#editor .block').length," +
                        "    doc: getMarkdownContent(false) });" +
                        "})()";
                    string fillerJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(fillerProbe));
                    log.AppendLine("FILLER " + fillerJson);
                    if (fillerJson.IndexOf("\"before\":4", StringComparison.Ordinal) >= 0
                        && fillerJson.IndexOf("\"after\":4", StringComparison.Ordinal) >= 0)
                        Pass("emptying a line spawns no phantom blank lines");
                    else
                        Fail("phantom blank lines from filler <br>: " + fillerJson);
                }

                // --- Regression: copied text is one line per line ---
                // Blocks are div > p, and the browser's text/plain serialization gives
                // paragraphs blank-line separation, so pasting into Notepad double-spaced.
                {
                    string copyProbe =
                        "(function(){" +
                        "  loadMarkdownContent('dfvbgdf\\nfg\\ngf\\ngbf');" +
                        "  var all = document.querySelectorAll('#editor .block');" +
                        "  var r = document.createRange();" +
                        "  r.setStartBefore(all[0]); r.setEndAfter(all[all.length-1]);" +
                        "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                        "  var ours = selectionToPlainText();" +
                        "  var browserDefault = s.toString();" +
                        "  return JSON.stringify({ ours: ours, browser: browserDefault });" +
                        "})()";
                    string copyJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(copyProbe));
                    log.AppendLine("COPY " + copyJson);
                    bool oursSingleSpaced = copyJson.IndexOf("\"ours\":\"dfvbgdf\\ngf", StringComparison.Ordinal) >= 0
                        || copyJson.IndexOf("\"ours\":\"dfvbgdf\\nfg\\ngf\\ngbf\"", StringComparison.Ordinal) >= 0;
                    if (oursSingleSpaced) Pass("copied text is single-spaced (one line per line)");
                    else Fail("copied text not single-spaced: " + copyJson);
                }

                // --- Active line: tint only, no left bar ---
                // The bar duplicated the caret and the tint, and collided with blockquote
                // (also an accent-coloured left border, one pixel wider).
                {
                    string styleProbe =
                        "(function(){" +
                        "  loadMarkdownContent('alpha\\n> quoted line');" +
                        "  var all = document.querySelectorAll('#editor .block');" +
                        "  var b = all[0];" +
                        "  b.classList.add('focused');" +
                        "  var cs = getComputedStyle(b);" +
                        "  var q = all[1] ? all[1].querySelector('blockquote') : null;" +
                        "  return JSON.stringify({" +
                        "    focusedShadow: cs.boxShadow," +
                        "    focusedBg: cs.backgroundColor," +
                        "    quoteBorder: q ? getComputedStyle(q).borderLeftWidth : null });" +
                        "})()";
                    string styleJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(styleProbe));
                    log.AppendLine("ACTIVELINE " + styleJson);
                    bool noBar = styleJson.IndexOf("\"focusedShadow\":\"none\"", StringComparison.Ordinal) >= 0;
                    bool hasTint = styleJson.IndexOf("\"focusedBg\":\"rgba(0, 0, 0, 0)\"", StringComparison.Ordinal) < 0;
                    if (noBar) Pass("active line has no left bar");
                    else Fail("active line still draws a left bar: " + styleJson);
                    if (hasTint) Pass("active line keeps its tint");
                    else Fail("active line lost its tint: " + styleJson);
                }

                // --- Table editing end to end: caret in a cell -> host message -> markdown ---
                {
                    string tableProbe =
                        "(function(){" +
                        "  loadMarkdownContent('| Name | Qty |\\n| --- | ---: |\\n| Apple | 3 |\\n| Pear | 5 |');" +
                        "  var blk = document.querySelector('#editor .block');" +
                        "  var cell = blk.querySelectorAll('tbody tr')[0].querySelectorAll('td')[0];" +
                        "  var r = document.createRange(); r.selectNodeContents(cell); r.collapse(false);" +
                        "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                        "  var ctx = getTableContext();" +
                        "  var seen = { row: ctx ? ctx.rowIndex : null, col: ctx ? ctx.colIndex : null };" +
                        "  applyTableOp('row_below', null);" +
                        "  var afterRow = blk.getAttribute('data-raw');" +
                        "  applyTableOp('col_right', null);" +
                        "  var afterCol = blk.getAttribute('data-raw');" +
                        "  applyTableOp('align', 'center');" +
                        "  var afterAlign = blk.getAttribute('data-raw');" +
                        "  return JSON.stringify({ seen: seen, afterRow: afterRow," +
                        "    afterCol: afterCol, afterAlign: afterAlign," +
                        "    rendersTable: !!blk.querySelector('table') });" +
                        "})()";
                    string tableJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(tableProbe));
                    log.AppendLine("TABLE " + tableJson);

                    if (tableJson.IndexOf("\"row\":0", StringComparison.Ordinal) >= 0
                        && tableJson.IndexOf("\"col\":0", StringComparison.Ordinal) >= 0)
                        Pass("caret maps to the right table cell");
                    else Fail("caret -> cell mapping wrong: " + tableJson);

                    if (tableJson.IndexOf("| Apple | 3 |\\n|  |  |\\n| Pear | 5 |", StringComparison.Ordinal) >= 0)
                        Pass("insert row below lands under the caret's row");
                    else Fail("row insert wrong: " + tableJson);

                    if (tableJson.IndexOf("| Name |  | Qty |", StringComparison.Ordinal) >= 0)
                        Pass("insert column right widens every row");
                    else Fail("column insert wrong: " + tableJson);

                    if (tableJson.IndexOf("\"rendersTable\":true", StringComparison.Ordinal) >= 0)
                        Pass("the edited table still renders as a table");
                    else Fail("table stopped rendering: " + tableJson);
                }

                // --- Alignment must MOVE THE TEXT, not just change the markdown ---
                // The first version of this feature wrote ":---:" correctly and rendered
                // nothing: the separator row was parsed only to be skipped. Assert the
                // computed style of the cells, which is what the user actually sees.
                {
                    string alignProbe =
                        "(function(){" +
                        "  loadMarkdownContent('| L | C | R |\\n| :--- | :---: | ---: |\\n| a | b | c |');" +
                        "  var blk = document.querySelector('#editor .block');" +
                        "  var tds = blk.querySelectorAll('tbody tr td');" +
                        "  var ths = blk.querySelectorAll('thead th');" +
                        "  var read = function(el){ return el ? getComputedStyle(el).textAlign : null; };" +
                        // Read BEFORE mutating: applyTableOp replaces the block's innerHTML,
                        // and getComputedStyle on a detached node returns empty strings.
                        "  var body = [read(tds[0]), read(tds[1]), read(tds[2])];" +
                        "  var head = [read(ths[0]), read(ths[1]), read(ths[2])];" +
                        // now flip the first column to centre through the real op
                        "  var r = document.createRange(); r.selectNodeContents(tds[0]); r.collapse(false);" +
                        "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                        "  applyTableOp('align', 'center');" +
                        "  var after = document.querySelector('#editor .block');" +
                        "  return JSON.stringify({" +
                        "    body: body," +
                        "    head: head," +
                        "    afterFlip: read(after.querySelectorAll('tbody tr td')[0])," +
                        "    afterRaw: after.getAttribute('data-raw')," +
                        "    reserialized: blockHtmlToMarkdown(after) });" +
                        "})()";
                    string alignJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(alignProbe));
                    log.AppendLine("ALIGN " + alignJson);

                    if (alignJson.IndexOf("\"body\":[\"left\",\"center\",\"right\"]", StringComparison.Ordinal) >= 0)
                        Pass("body cells are visually aligned per column");
                    else Fail("body cell alignment not applied: " + alignJson);

                    if (alignJson.IndexOf("\"head\":[\"left\",\"center\",\"right\"]", StringComparison.Ordinal) >= 0)
                        Pass("header cells are visually aligned per column");
                    else Fail("header cell alignment not applied: " + alignJson);

                    if (alignJson.IndexOf("\"afterFlip\":\"center\"", StringComparison.Ordinal) >= 0)
                        Pass("the align menu visibly moves the text");
                    else Fail("align op did not change the rendered alignment: " + alignJson);

                    if (alignJson.IndexOf("| :---: | :---: | ---: |", StringComparison.Ordinal) >= 0)
                        Pass("alignment survives DOM -> markdown serialization");
                    else Fail("serialization reset the alignment: " + alignJson);
                }

                // --- Features added outside this session: verify they actually work ---
                {
                    // Strikethrough: renders as <del> AND round-trips back to ~~
                    string strikeJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                        "(function(){" +
                        "  loadMarkdownContent('~~gone~~ and **bold**');" +
                        "  var b = document.querySelector('#editor .block');" +
                        "  return JSON.stringify({ html: b.innerHTML, back: blockHtmlToMarkdown(b) });" +
                        "})()"));
                    log.AppendLine("STRIKE " + strikeJson);
                    if (strikeJson.IndexOf("<del>gone</del>", StringComparison.Ordinal) >= 0)
                        Pass("strikethrough renders");
                    else Fail("strikethrough did not render: " + strikeJson);
                    if (strikeJson.IndexOf("~~gone~~ and **bold**", StringComparison.Ordinal) >= 0)
                        Pass("strikethrough survives the markdown round trip");
                    else Fail("strikethrough lost on serialize: " + strikeJson);

                    // Selection word count: select "alpha beta" out of four words
                    await _webView.CoreWebView2.ExecuteScriptAsync(
                        "(function(){" +
                        "  loadMarkdownContent('alpha beta gamma delta');" +
                        "  var t = document.querySelector('#editor .block p').firstChild;" +
                        "  var r = document.createRange(); r.setStart(t,0); r.setEnd(t,10);" +
                        "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                        "  updateStatsNow();" +
                        "})()");
                    await Task.Delay(500);
                    string wc = _lblWordCount != null ? (_lblWordCount.Text ?? "") : "";
                    log.AppendLine("SELWORDS \"" + wc + "\"");
                    // Counts are grouped for reading (40,772), so the separator has to be
                    // allowed here and stripped before parsing. Today's fixture is four
                    // words and \d+ would still match; it would start lying at a thousand.
                    var wcMatch = Regex.Match(wc, @"^([\d,]+) / ([\d,]+) words$");
                    int selN = 0, totN = 0;
                    if (wcMatch.Success)
                    {
                        int.TryParse(wcMatch.Groups[1].Value.Replace(",", ""), out selN);
                        int.TryParse(wcMatch.Groups[2].Value.Replace(",", ""), out totN);
                    }
                    if (wcMatch.Success && selN > 0 && selN <= totN)
                        Pass("selection word count shows selected / total (" + wc + ")");
                    else Fail("selection word count wrong: \"" + wc + "\"");

                    // Zoom: the page's zoom:in message must move WebView2's ZoomFactor
                    double z0 = 1.0;
                    try { z0 = _webView.ZoomFactor; } catch { }
                    await _webView.CoreWebView2.ExecuteScriptAsync("chrome.webview.postMessage('zoom:in')");
                    await Task.Delay(400);
                    double z1 = 1.0;
                    try { z1 = _webView.ZoomFactor; } catch { }
                    await _webView.CoreWebView2.ExecuteScriptAsync("chrome.webview.postMessage('zoom:reset')");
                    await Task.Delay(400);
                    double z2 = 1.0;
                    try { z2 = _webView.ZoomFactor; } catch { }
                    log.AppendLine("ZOOM before=" + z0 + " afterIn=" + z1 + " afterReset=" + z2);
                    if (z1 > z0) Pass("zoom in increases ZoomFactor (" + z0 + " -> " + z1 + ")");
                    else Fail("zoom in did nothing: " + z0 + " -> " + z1);
                    if (Math.Abs(z2 - 1.0) < 0.001) Pass("zoom reset returns to 100%");
                    else Fail("zoom reset left factor at " + z2);

                    // Recent files: the MRU list and its menu
                    log.AppendLine("RECENT count=" + _recentFiles.Count +
                        " menuItems=" + (_mRecentMenu != null ? _mRecentMenu.Items.Count : -1));
                    if (_recentFiles.Count > 0) Pass("recent files list is populated (" + _recentFiles.Count + ")");
                    else Fail("recent files list is empty");
                    if (_mRecentMenu != null && _mRecentMenu.Items.Count > 0)
                        Pass("Open Recent menu is built (" + _mRecentMenu.Items.Count + " items)");
                    else Fail("Open Recent menu not built");

                    // Tab session: a session file is written and reloads
                    if (File.Exists(TabSessionPath())) Pass("tab session file exists");
                    else log.AppendLine("NOTE tab session not written yet at probe time (written on close)");
                }

                // --- Image paste: bytes -> file beside the document -> relative markdown ---
                {
                    string imgDoc = Path.Combine(dir, "my image doc.md");
                    File.WriteAllText(imgDoc, "# Doc with image\n\ncaret here\n", new UTF8Encoding(false));
                    LoadFileFromPath(imgDoc);
                    await Task.Delay(700);

                    // 1x1 transparent PNG
                    const string PNG_B64 =
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
                    // A real paste always happens with a caret in the document; put one
                    // there so the probe exercises the same path a user would.
                    await _webView.CoreWebView2.ExecuteScriptAsync(
                        "(function(){" +
                        "  var blocks = document.querySelectorAll('#editor .block');" +
                        "  var last = blocks[blocks.length - 1];" +
                        "  editor.focus();" +
                        "  var r = document.createRange(); r.selectNodeContents(last); r.collapse(false);" +
                        "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                        "})()");
                    await Task.Delay(200);
                    await _webView.CoreWebView2.ExecuteScriptAsync(
                        "chrome.webview.postMessage('image_paste:png:" + PNG_B64 + "')");
                    await Task.Delay(1200);

                    // Also exercise the REAL paste path: a ClipboardEvent carrying a File,
                    // which is what a screenshot paste actually delivers. Posting
                    // image_paste: directly (below) only proves the host half.
                    string pasteDiag = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                        "(function(){" +
                        "  try {" +
                        "    var bin = atob('" +
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" +
                        "');" +
                        "    var arr = new Uint8Array(bin.length);" +
                        "    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);" +
                        "    var file = new File([arr], 'shot.png', { type: 'image/png' });" +
                        "    var dt = new DataTransfer();" +
                        "    dt.items.add(file);" +
                        "    var found = typeof firstImageFile === 'function' ? !!firstImageFile(dt) : null;" +
                        "    var ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });" +
                        "    var delivered = editor.dispatchEvent(ev);" +
                        "    return JSON.stringify({ firstImageFileFound: found, defaultPrevented: !delivered });" +
                        "  } catch (e) { return JSON.stringify({ error: String(e) }); }" +
                        "})()"));
                    log.AppendLine("PASTE-EVENT " + pasteDiag);
                    await Task.Delay(1500);
                    string pasteAssets = Path.Combine(dir, "my_image_doc-assets");
                    int afterRealPaste = Directory.Exists(pasteAssets) ? Directory.GetFiles(pasteAssets, "*.png").Length : 0;
                    log.AppendLine("PASTE-EVENT saved=" + afterRealPaste);
                    if (pasteDiag.IndexOf("\"firstImageFileFound\":true", StringComparison.Ordinal) >= 0)
                        Pass("paste event exposes the image file");
                    else Fail("clipboard image not detected: " + pasteDiag);
                    if (afterRealPaste >= 1) Pass("a real paste event saves the image");
                    else Fail("real paste event produced no file (host never got image_paste)");

                    string assetDir = Path.Combine(dir, "my_image_doc-assets");
                    string[] saved = Directory.Exists(assetDir) ? Directory.GetFiles(assetDir, "*.png") : new string[0];
                    log.AppendLine("IMAGE assetDir=" + Directory.Exists(assetDir) + " files=" + saved.Length);
                    if (saved.Length >= 1) Pass("pasted image saved beside the document (" + saved.Length + ")");
                    else Fail("no image was saved");
                    if (saved.Length > 0 && new FileInfo(saved[0]).Length > 0)
                        Pass("saved image has real bytes (" + new FileInfo(saved[0]).Length + ")");
                    else Fail("saved image is empty");

                    string imgJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                        "(function(){" +
                        "  var img = document.querySelector('#editor img');" +
                        "  return JSON.stringify({" +
                        "    md: getMarkdownContent(false)," +
                        "    src: img ? img.getAttribute('src') : null," +
                        "    dataSrc: img ? img.getAttribute('data-src') : null }); })()"));
                    log.AppendLine("IMAGE " + imgJson);

                    if (imgJson.IndexOf("my_image_doc-assets/image-", StringComparison.Ordinal) >= 0)
                        Pass("markdown references the image by relative path");
                    else Fail("image markdown not inserted: " + imgJson);
                    if (imgJson.IndexOf("\"src\":\"data:image/", StringComparison.Ordinal) >= 0)
                        Pass("image is served to the page as bytes (no hanging virtual-host request)");
                    else Fail("image src not resolved: " + imgJson);
                    if (imgJson.IndexOf("\"md\":\"# Doc with image", StringComparison.Ordinal) >= 0
                        && imgJson.IndexOf("https://docfolder", StringComparison.Ordinal) ==
                           imgJson.LastIndexOf("https://docfolder", StringComparison.Ordinal))
                        Pass("the display URL never leaks into the markdown");
                    else Fail("display URL leaked into the document: " + imgJson);
                }

                // --- Removing an image from the document recycles its file on save ---
                {
                    string pruneDoc = Path.Combine(dir, "prune.md");
                    string pruneAssets = Path.Combine(dir, "prune-assets");
                    Directory.CreateDirectory(pruneAssets);
                    string keep = Path.Combine(pruneAssets, "keep.png");
                    string drop = Path.Combine(pruneAssets, "drop.png");
                    string outside = Path.Combine(dir, "not_ours.png");
                    File.WriteAllBytes(keep, new byte[] { 1, 2, 3 });
                    File.WriteAllBytes(drop, new byte[] { 4, 5, 6 });
                    File.WriteAllBytes(outside, new byte[] { 7, 8, 9 });
                    File.WriteAllText(pruneDoc,
                        "# Prune\n\n![a](prune-assets/keep.png)\n\n![b](prune-assets/drop.png)\n\n![c](not_ours.png)\n",
                        new UTF8Encoding(false));

                    LoadFileFromPath(pruneDoc);
                    await Task.Delay(700);

                    // Drop the second image, keep the others, then save
                    int pIdx = IndexOfTabPath(pruneDoc);
                    if (pIdx >= 0)
                    {
                        _tabs[pIdx].Content = "# Prune\n\n![a](prune-assets/keep.png)\n\n![c](not_ours.png)";
                        SaveTabNow(_tabs[pIdx], false);
                        await Task.Delay(400);
                    }

                    log.AppendLine("PRUNE keep=" + File.Exists(keep) + " drop=" + File.Exists(drop) +
                        " outside=" + File.Exists(outside));
                    if (File.Exists(keep)) Pass("a still-referenced image is kept");
                    else Fail("PRUNE deleted an image that is still referenced");
                    if (!File.Exists(drop)) Pass("the removed image is recycled on save");
                    else Fail("removed image was not cleaned up");
                    if (File.Exists(outside)) Pass("images outside the document's own assets folder are never touched");
                    else Fail("PRUNE deleted a file outside the assets folder");
                }

                // --- Does a real document's image actually LOAD? naturalWidth is the truth ---
                // Rendering an <img> proves nothing: alt="" plus a failed load collapses to
                // nothing visible, which looks identical to "the image was never inserted".
                {
                    // Opt-in performance probe. Drop a substantial real document at
                    // tests\perf-probe.md to time the open and reopen paths against
                    // something representative; skipped entirely when absent, which is
                    // the normal case. Located relative to the app so it works on any
                    // machine rather than only the one it was written on.
                    string realDoc = Path.Combine(_appDir, "tests", "perf-probe.md");
                    if (File.Exists(realDoc))
                    {
                        var swOpen = System.Diagnostics.Stopwatch.StartNew();
                        LoadFileFromPath(realDoc);
                        swOpen.Stop();
                        log.AppendLine("OPEN-MS " + swOpen.ElapsedMilliseconds);
                        await Task.Delay(2000);

                        // The sidebar case: clicking a file that is ALREADY an open tab.
                        // This is the path users actually hit, and it was doing a blocking
                        // serialize plus two full document rebuilds.
                        var swReopen = System.Diagnostics.Stopwatch.StartNew();
                        LoadFileFromPath(realDoc);
                        swReopen.Stop();
                        log.AppendLine("REOPEN-MS " + swReopen.ElapsedMilliseconds);
                        await Task.Delay(600);

                        // Where does the time actually go in the page? Break the load into
                        // its parts: block construction, the stats serialize, and the
                        // history snapshot (which serializes AGAIN, with repair).
                        string breakdown = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                            "(function(){" +
                            "  var md = getMarkdownContent(false);" +
                            "  var t0 = performance.now();" +
                            "  loadMarkdownContent(md);" +
                            "  var tLoad = performance.now() - t0;" +
                            "  var t1 = performance.now();" +
                            "  updateStatsNow();" +
                            "  var tStats = performance.now() - t1;" +
                            "  var t2 = performance.now();" +
                            "  getMarkdownContent(true);" +   // the repairing serialize
                            "  var tRepair = performance.now() - t2;" +
                            "  var t3 = performance.now();" +
                            "  HistoryManager.resetToCurrent();" +
                            "  var tHist = performance.now() - t3;" +
                            "  return JSON.stringify({" +
                            "    blocks: document.querySelectorAll('#editor .block').length," +
                            "    loadMs: Math.round(tLoad)," +
                            "    statsMs: Math.round(tStats)," +
                            "    repairSerializeMs: Math.round(tRepair)," +
                            "    historyMs: Math.round(tHist) });" +
                            "})()"));
                        log.AppendLine("PAGELOAD " + breakdown);

                        // THE REAL SIDEBAR PATH: the page posts open_file_path, exactly as
                        // clicking a file in the Files list does. Everything measured above
                        // called LoadFileFromPath straight from C#, which skips the
                        // WebMessage callback the click actually arrives on.
                        // Switch to a DIFFERENT file, the way a sidebar click does. Clicking
                        // the already-active file is correctly a no-op, so measuring that
                        // just times out the poll loop and tells you nothing.
                        LoadFileFromPath(pathA);
                        await Task.Delay(800);
                        string jsPath = realDoc.Replace("\\", "\\\\");
                        var swClick = System.Diagnostics.Stopwatch.StartNew();
                        await _webView.CoreWebView2.ExecuteScriptAsync(
                            "chrome.webview.postMessage('open_file_path:" + jsPath + "')");
                        bool changed = false;
                        for (int poll = 0; poll < 120; poll++)
                        {
                            string cur = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                                "String(getMarkdownContent(false)).slice(0, 80)"));
                            if (cur.IndexOf(TOKEN_A, StringComparison.Ordinal) < 0)
                            {
                                changed = true;
                                break;
                            }
                            await Task.Delay(25);
                        }
                        swClick.Stop();
                        log.AppendLine("SIDEBAR-CLICK-MS " + swClick.ElapsedMilliseconds + " changed=" + changed);
                        if (changed && swClick.ElapsedMilliseconds < 1000)
                            Pass("opening from the Files list is responsive (" + swClick.ElapsedMilliseconds + "ms)");
                        else
                            Fail("opening from the Files list took " + swClick.ElapsedMilliseconds + "ms (changed=" + changed + ")");
                        string loadJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                            "(function(){" +
                            "  var imgs = Array.prototype.slice.call(document.querySelectorAll('#editor img'));" +
                            "  return JSON.stringify({" +
                            "    count: imgs.length," +
                            "    detail: imgs.map(function(i){ return {" +
                            "      src: i.getAttribute('src')," +
                            "      complete: i.complete," +
                            "      natural: i.naturalWidth }; }) });" +
                            "})()"));
                        log.AppendLine("IMGLOAD " + loadJson);
                        log.AppendLine("IMGLOAD mappedFolder=[" + (_mappedDocFolder ?? "null") + "]" +
                            " currentFile=[" + (_currentFilePath ?? "null") + "]");

                        // Ask the network stack why. fetch() surfaces the real error where
                        // an <img> just silently gives up.
                        await _webView.CoreWebView2.ExecuteScriptAsync(
                            "var probeImg = document.querySelector('#editor img');" +
                            "window.__probe = probeImg ? 'pending' : 'no image in document';" +
                            "if (probeImg) fetch(probeImg.src)" +
                            "  .then(function(r){ window.__probe = 'status ' + r.status; })" +
                            "  .catch(function(e){ window.__probe = 'error ' + e; });");
                        await Task.Delay(1500);
                        log.AppendLine("IMGFETCH " + DecodeJsStringResult(
                            await _webView.CoreWebView2.ExecuteScriptAsync("String(window.__probe)")));
                        if (loadJson.IndexOf("\"count\":0", StringComparison.Ordinal) >= 0)
                            Fail("no <img> elements rendered for a document that references images");
                        else if (loadJson.IndexOf("\"natural\":0", StringComparison.Ordinal) >= 0)
                            Fail("image element exists but FAILED TO LOAD: " + loadJson);
                        else Pass("document images actually load (naturalWidth > 0)");
                    }
                    else log.AppendLine("NOTE sample document not present, skipped image load check");
                }

                // --- New View options: chrome modes, word wrap, status bar ---
                {
                    // Auto-hide: command row + tab chips tuck; slim caption (─□×) stays.
                    var band = FindElement("tabBar") as FrameworkElement;
                    var bar = FindElement("topToolbar") as FrameworkElement;
                    var tabs = FindElement("tabScroller") as FrameworkElement;
                    var sbar = FindElement("statusBar") as FrameworkElement;

                    SetChromeAutoHide(false);
                    await Task.Delay(150);
                    bool visibleAlways = bar != null && bar.Visibility == Visibility.Visible
                        && band != null && band.Visibility == Visibility.Visible
                        && tabs != null && tabs.Visibility == Visibility.Visible;
                    if (visibleAlways) Pass("auto-hide off keeps the bars visible");
                    else Fail("chrome hidden while auto-hide is off");

                    SetChromeAutoHide(true);
                    OnUserTyping();
                    await Task.Delay(150);
                    bool hidTyping = bar != null && bar.Visibility != Visibility.Visible
                        && tabs != null && tabs.Visibility != Visibility.Visible
                        && band != null && band.Visibility == Visibility.Visible;
                    if (hidTyping) Pass("chrome hides when typing starts");
                    else Fail("chrome did not hide on typing");

                    // ...and a menu being open must veto hiding
                    SetChromeAutoHide(false);
                    await Task.Delay(100);
                    SetChromeAutoHide(true);
                    var topMenu = FindElement("topMenu") as Menu;
                    var firstItem = topMenu != null && topMenu.Items.Count > 0 ? topMenu.Items[0] as MenuItem : null;
                    if (firstItem != null)
                    {
                        firstItem.IsSubmenuOpen = true;
                        OnUserTyping();
                        await Task.Delay(150);
                        bool stayed = bar != null && bar.Visibility == Visibility.Visible
                            && tabs != null && tabs.Visibility == Visibility.Visible;
                        firstItem.IsSubmenuOpen = false;
                        if (stayed) Pass("an open menu vetoes auto-hide");
                        else Fail("chrome hid out from under an open menu");
                    }
                    SetChromeAutoHide(false);

                    SetStatusBarVisible(false);
                    await Task.Delay(100);
                    bool sbHidden = sbar.Visibility != Visibility.Visible;
                    SetStatusBarVisible(true);
                    await Task.Delay(100);
                    bool sbBack = sbar.Visibility == Visibility.Visible;
                    if (sbHidden && sbBack) Pass("status bar toggles");
                    else Fail("status bar toggle failed (hidden=" + sbHidden + " back=" + sbBack + ")");

                    // --- Auto-hide clears EVERYTHING, and the manual toggles under it ---
                    //
                    // Auto-hide used to tuck the command bar and the tab chips and leave the
                    // status bar and the scrubber sitting there, which is not "no UI". The
                    // three toggles beside it are the same surfaces held by hand, and the
                    // interesting case is what a reveal restores: whatever the toggles ask
                    // for, not everything. A reader who switched the status bar off must not
                    // get it back every time the pointer brushes the top of the window.
                    SetChromeAutoHide(true);
                    SetChromeHidden(true);
                    await Task.Delay(150);
                    bool allGone = bar != null && bar.Visibility != Visibility.Visible
                        && tabs != null && tabs.Visibility != Visibility.Visible
                        && sbar != null && sbar.Visibility != Visibility.Visible
                        && _scrubberSuppressed;
                    log.AppendLine("AUTOHIDE-ALL bar=" + (bar == null ? "?" : bar.Visibility.ToString())
                        + " tabs=" + (tabs == null ? "?" : tabs.Visibility.ToString())
                        + " status=" + (sbar == null ? "?" : sbar.Visibility.ToString())
                        + " scrubberOff=" + _scrubberSuppressed);
                    if (allGone) Pass("auto-hide clears the status bar and the scrubber too, not just the menu");
                    else Fail("auto-hide left some UI on screen");

                    // The bottom band is the scrubber's own reveal: reaching for it must not
                    // also flash the toolbar back.
                    //
                    // The watch has to be stopped for this. It is running -- auto-hide is on
                    // -- and it writes _bottomHover from where the mouse actually is, so it
                    // overwrote the value under test within the first tick and the check
                    // failed against correct code.
                    bool watchWasOn = _chromeWatch != null && _chromeWatch.IsEnabled;
                    if (_chromeWatch != null) _chromeWatch.Stop();
                    _bottomHover = true;
                    ApplyChromeVisibility();
                    await Task.Delay(100);
                    bool scrubBack = !_scrubberSuppressed;
                    bool menuStayedGone = bar != null && bar.Visibility != Visibility.Visible;
                    if (scrubBack && menuStayedGone)
                        Pass("pointer at the bottom brings the scrubber back and leaves the menu hidden");
                    else Fail("bottom reveal wrong (scrubber=" + scrubBack + " menuHidden=" + menuStayedGone + ")");
                    _bottomHover = false;
                    ApplyChromeVisibility();
                    if (watchWasOn && _chromeWatch != null) _chromeWatch.Start();

                    // And the band geometry itself, as a pure function: the bottom strip of
                    // the window and a little past its edge, because the pointer overshoots
                    // onto the taskbar exactly when the scrubber is wanted.
                    bool bandInside = ShouldRevealScrubber(200, ActualHeight - 10);
                    bool bandOvershoot = ShouldRevealScrubber(200, ActualHeight + 12);
                    bool bandMissMiddle = ShouldRevealScrubber(200, ActualHeight / 2);
                    bool bandMissOffRight = ShouldRevealScrubber(ActualWidth + 30, ActualHeight - 10);
                    log.AppendLine("SCRUBZONE inside=" + bandInside + " overshoot=" + bandOvershoot +
                        " middle=" + bandMissMiddle + " offRight=" + bandMissOffRight);
                    if (bandInside && bandOvershoot && !bandMissMiddle && !bandMissOffRight)
                        Pass("the scrubber reveal band is the bottom strip, not the middle of the page");
                    else Fail("scrubber reveal geometry wrong");

                    // Revealing honours the toggles rather than turning everything on.
                    SetStatusBarVisible(false);
                    SetChromeHidden(false);
                    await Task.Delay(150);
                    bool respected = bar != null && bar.Visibility == Visibility.Visible
                        && sbar != null && sbar.Visibility != Visibility.Visible;
                    if (respected) Pass("revealing brings back the menu but respects a status bar switched off by hand");
                    else Fail("revealing overrode the manual status bar setting");
                    SetStatusBarVisible(true);
                    SetChromeAutoHide(false);
                    await Task.Delay(100);

                    // Menu is always discoverable (auto-hide top edge); no View > Menu toggle.
                    Pass("menu is not a manual toggle (always discoverable from the top edge)");

                    // Left-edge sidebar hover geometry (open strip is thin; stay band is wide).
                    bool leftHit = ShouldRevealSidebar(4, ActualHeight / 2);
                    bool leftMiss = ShouldRevealSidebar(80, ActualHeight / 2);
                    bool leftOvershoot = ShouldRevealSidebar(-10, ActualHeight / 2);
                    if (leftHit && !leftMiss && leftOvershoot)
                        Pass("sidebar reveal band is the extreme left strip");
                    else Fail("sidebar reveal geometry wrong (hit=" + leftHit + " miss=" + leftMiss + " overshoot=" + leftOvershoot + ")");
                    // Stay band must cover the 280px sidebar (search options live near its right).
                    _leftHover = true;
                    bool stayOnOptions = ShouldRevealSidebar(300, ActualHeight / 2);
                    bool stayPastBar = ShouldRevealSidebar(380, ActualHeight / 2);
                    _leftHover = false;
                    if (stayOnOptions && !stayPastBar)
                        Pass("sidebar stay band covers the full bar including search options");
                    else Fail("sidebar stay band wrong (options=" + stayOnOptions + " past=" + stayPastBar + ")");

                    SetScrubberVisible(false);
                    await Task.Delay(100);
                    bool scrubOff = _scrubberSuppressed;
                    SetScrubberVisible(true);
                    await Task.Delay(100);
                    if (scrubOff && !_scrubberSuppressed) Pass("View > Scrubber toggles the scrubber");
                    else Fail("scrubber toggle failed (off=" + scrubOff + " backOn=" + !_scrubberSuppressed + ")");

                    // Spacing presets: four each, and the menu must tick exactly one.
                    SetLineSpacing(3);
                    SetParaSpacing(0);
                    await Task.Delay(100);
                    int lineTicks = 0, paraTicks = 0;
                    foreach (var n in LineSpacingItems)
                    { var mi = FindElement(n) as MenuItem; if (mi != null && mi.IsChecked) lineTicks++; }
                    foreach (var n in ParaSpacingItems)
                    { var mi = FindElement(n) as MenuItem; if (mi != null && mi.IsChecked) paraTicks++; }
                    var looseItem = FindElement("mLineLoose") as MenuItem;
                    var tightItem = FindElement("mParaTight") as MenuItem;
                    bool ticksRight = lineTicks == 1 && paraTicks == 1
                        && looseItem != null && looseItem.IsChecked
                        && tightItem != null && tightItem.IsChecked;
                    log.AppendLine("SPACING lineTicks=" + lineTicks + " paraTicks=" + paraTicks);
                    if (ticksRight) Pass("spacing presets tick exactly the one chosen");
                    else Fail("spacing menu ticks wrong (line=" + lineTicks + " para=" + paraTicks + ")");

                    // A state file naming a preset that no longer exists must not throw.
                    SetLineSpacing(99);
                    SetParaSpacing(-5);
                    await Task.Delay(50);
                    if (_lineSpacing == 3 && _paraSpacing == 0) Pass("an out-of-range preset clamps instead of throwing");
                    else Fail("preset clamping wrong (line=" + _lineSpacing + " para=" + _paraSpacing + ")");
                    SetLineSpacing(1);
                    SetParaSpacing(1);

                    // Reveal geometry, in DIPs relative to the client area. y<0 is the
                    // title bar. This was compared against physical pixels before, making
                    // the hot zone ~4 logical px and effectively unreachable.
                    bool hitJustBelowTop = ShouldRevealChrome(200, 5, 80, true);
                    bool hitInTitleBar = ShouldRevealChrome(200, -40, 80, true);
                    bool hitAtHotZoneEdge = ShouldRevealChrome(200, 27, 80, true);
                    bool missDeepInDoc = ShouldRevealChrome(200, 400, 80, true);
                    bool missOffLeft = ShouldRevealChrome(-5, 5, 80, true);
                    bool staysWhileOverChrome = ShouldRevealChrome(200, 70, 80, false);
                    log.AppendLine("CHROMEZONE below=" + hitJustBelowTop + " title=" + hitInTitleBar +
                        " edge=" + hitAtHotZoneEdge + " deep=" + missDeepInDoc +
                        " offLeft=" + missOffLeft + " overChrome=" + staysWhileOverChrome);
                    if (hitJustBelowTop && hitInTitleBar && hitAtHotZoneEdge
                        && !missDeepInDoc && !missOffLeft && staysWhileOverChrome)
                        Pass("chrome reveal zone is reachable (top strip and title bar, not the document)");
                    else Fail("chrome reveal geometry wrong");

                    // Restore path: settings loaded from disk must be APPLIED, not just
                    // assigned. Previously a restored auto-hide left the pointer watch
                    // unstarted and the menu item unticked, so hover did nothing and the
                    // first click on the menu appeared to be ignored.
                    SetChromeAutoHide(false);
                    await Task.Delay(100);
                    _chromeAutoHide = true;                  // as RestoreWindowState leaves it
                    _statusBarVisible = false;
                    _scrubberVisible = false;
                    ApplyRestoredViewSettings(false);
                    await Task.Delay(150);

                    var scrubItem = FindElement("mScrubberToggle") as MenuItem;
                    bool newOnesApplied = scrubItem != null && !scrubItem.IsChecked
                        && _scrubberSuppressed;
                    if (newOnesApplied) Pass("restored Scrubber setting is applied and ticked to match");
                    else Fail("restored Scrubber setting ignored or out of sync with its menu item");
                    _scrubberVisible = true;
                    ApplyRestoredViewSettings(false);
                    await Task.Delay(100);

                    var autoItem = FindElement("mChromeAutoHide") as MenuItem;
                    bool menuTicked = autoItem != null && autoItem.IsChecked;
                    bool watchRunning = _chromeWatch != null && _chromeWatch.IsEnabled;
                    bool sbarApplied = sbar.Visibility != Visibility.Visible;
                    log.AppendLine("RESTORE ticked=" + menuTicked + " watch=" + watchRunning + " statusBarHidden=" + sbarApplied);
                    if (menuTicked) Pass("restored auto-hide ticks its menu item");
                    else Fail("restored auto-hide left the menu unticked (click would appear to do nothing)");
                    if (watchRunning) Pass("restored auto-hide starts the pointer watch (hover can reveal)");
                    else Fail("restored auto-hide never started the pointer watch");
                    if (sbarApplied) Pass("restored status-bar setting is applied");
                    else Fail("restored status-bar setting ignored");

                    SetChromeAutoHide(false);
                    SetStatusBarVisible(true);
                    await Task.Delay(100);

                    // Alt+<letter> must open the matching menu. WPF draws the underlines
                    // but never receives the key while the editor has focus.
                    var accessResults = new List<string>();
                    bool allOpened = true;
                    foreach (var probe in new[] {
                        new object[] { 'f', "File" }, new object[] { 'e', "Edit" },
                        new object[] { 'v', "View" }, new object[] { 't', "Themes" },
                        new object[] { 'h', "Help" } })
                    {
                        char k = (char)probe[0];
                        var tm = FindElement("topMenu") as Menu;

                        // Settle first: WPF's menu state machine drops an open request that
                        // lands while the previous menu is still closing, which made this
                        // test flake on whichever key happened to follow too quickly.
                        foreach (object it0 in tm.Items)
                        {
                            var m0 = it0 as MenuItem;
                            if (m0 != null) m0.IsSubmenuOpen = false;
                        }
                        await Task.Delay(120);

                        bool matched = OpenMenuByAccessKey(k);
                        await Task.Delay(120);
                        bool anyOpen = false;
                        foreach (object itChk in tm.Items)
                        {
                            var mChk = itChk as MenuItem;
                            if (mChk != null && mChk.IsSubmenuOpen) anyOpen = true;
                        }
                        if (!anyOpen)
                        {
                            // Retry once. A real user presses Alt+V alone, not five menus
                            // in two seconds, so a single retry does not hide a real fault.
                            await Task.Delay(200);
                            matched = OpenMenuByAccessKey(k);
                            await Task.Delay(200);
                        }

                        anyOpen = false;
                        foreach (object it in tm.Items)
                        {
                            var m2 = it as MenuItem;
                            if (m2 != null && m2.IsSubmenuOpen) anyOpen = true;
                            if (m2 != null) m2.IsSubmenuOpen = false;   // close again
                        }
                        await Task.Delay(120);
                        accessResults.Add(k + "=" + (matched && anyOpen));
                        if (!(matched && anyOpen)) allOpened = false;
                    }
                    log.AppendLine("ALTKEYS " + string.Join(" ", accessResults.ToArray()));
                    if (allOpened) Pass("Alt+F/E/V/T/H each open their menu");
                    else Fail("some Alt access keys did not open a menu: " + string.Join(" ", accessResults.ToArray()));

                    if (!OpenMenuByAccessKey('z')) Pass("an unmatched Alt key opens nothing");
                    else Fail("Alt+Z opened a menu it should not have");

                    // ---- Pre-save content-loss guard ----
                    // Replaces backups: with no copies kept, the only chance to catch a
                    // corrupting save is the instant before it overwrites the good copy.
                    {
                        var bigDoc = new StringBuilder();
                        for (int i = 0; i < 40; i++) bigDoc.AppendLine("This is line " + i + " of a real document.");
                        string big = bigDoc.ToString();
                        string sum;

                        bool catastrophe = WouldLoseContent(big, "This is line 0 of a real document.", out sum);
                        // The summary lists the first few vanished lines — here that is
                        // line 1 onward, since line 0 is the one the corrupt save kept.
                        bool namesLines = sum != null &&
                            sum.IndexOf("This is line 1 of a real document.", StringComparison.Ordinal) >= 0 &&
                            sum.IndexOf("Lines that would disappear", StringComparison.Ordinal) >= 0 &&
                            sum.IndexOf("% of the file", StringComparison.Ordinal) >= 0;
                        bool smallEdit = WouldLoseContent(big, big.Replace("This is line 7 of a real document.\r\n", ""), out sum);
                        bool identical = WouldLoseContent(big, big, out sum);
                        bool grew = WouldLoseContent(big, big + "more text added here", out sum);
                        bool tinyDoc = WouldLoseContent("short note", "", out sum);

                        log.AppendLine("LOSSGUARD catastrophe=" + catastrophe + " names=" + namesLines +
                            " smallEdit=" + smallEdit + " identical=" + identical + " grew=" + grew + " tiny=" + tinyDoc);
                        if (catastrophe) Pass("a save that would drop most of the document is flagged");
                        else Fail("bulk content loss went unflagged");
                        if (namesLines) Pass("the warning names the lines that would disappear");
                        else Fail("warning gives the user nothing to judge — it would be clicked through");
                        if (!smallEdit) Pass("deleting a line is not flagged");
                        else Fail("ordinary editing triggers the loss guard");
                        if (!identical) Pass("an unchanged save is not flagged");
                        else Fail("saving an unchanged document triggers the guard");
                        if (!grew) Pass("adding content is not flagged");
                        else Fail("growing a document triggers the guard");
                        if (!tinyDoc) Pass("a short note is below the judging threshold");
                        else Fail("clearing a two-word note triggers the guard");

                        // Wiring: the predicate must actually be consulted by SaveTabNow.
                        string lossPath = Path.Combine(dir, "lossguard.md");
                        File.WriteAllText(lossPath, big, new UTF8Encoding(false));
                        var lossTab = new DocTab
                        {
                            Id = _nextTabId++, FilePath = lossPath,
                            Content = big.Replace("\r\n", "\n").TrimEnd('\n'), IsDirty = false
                        };
                        _tabs.Add(lossTab);
                        int before = _lossPromptCount;
                        lossTab.Content = "everything else is gone";   // simulate a corrupting save
                        lossTab.IsDirty = true;
                        SaveTabNow(lossTab, false);
                        bool guardRan = _lossPromptCount > before;

                        int before2 = _lossPromptCount;
                        lossTab.Content = File.ReadAllText(lossPath).Replace("\r\n", "\n").TrimEnd('\n') + "\nan added line";
                        lossTab.IsDirty = true;
                        SaveTabNow(lossTab, false);
                        bool quietOnNormal = _lossPromptCount == before2;

                        log.AppendLine("LOSSWIRED fired=" + guardRan + " quietOnNormalSave=" + quietOnNormal);
                        if (guardRan) Pass("Ctrl+S on a gutted document reaches the loss guard");
                        else Fail("the loss guard is never consulted on the real save path");
                        if (quietOnNormal) Pass("a normal save does not disturb you");
                        else Fail("the guard fires on ordinary saves");

                        _tabs.Remove(lossTab);
                        try { File.Delete(lossPath); } catch { }
                    }

                    // ---- Privacy: what gets written outside your own files ----
                    // The menu items must exist under the names the code binds to. A
                    // mismatch here compiles and runs fine, and the menu entry just quietly
                    // does nothing — which is how the auto-hide toggle shipped broken.
                    var miBodies = FindElement("mSessionRestoreContent") as MenuItem;
                    var miRecent = FindElement("mRecentEnabled") as MenuItem;
                    var miClear = FindElement("mClearData") as MenuItem;
                    log.AppendLine("PRIVMENU bodies=" + (miBodies != null) + " recent=" + (miRecent != null) +
                        " clear=" + (miClear != null));
                    if (miBodies != null && miRecent != null && miClear != null)
                        Pass("Privacy menu items exist under the names the handlers bind to");
                    else Fail("a Privacy menu item is missing or renamed — its menu entry would do nothing");
                    if (miBodies != null && !miBodies.IsChecked)
                        Pass("remembering unsaved documents is off by default");
                    else Fail("unsaved-document persistence defaulted to ON");
                    // Clicking the item (not calling the setter) must actually flip state.
                    if (miBodies != null)
                    {
                        bool before = _sessionRestoreContent;
                        miBodies.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
                        await Task.Delay(120);
                        bool flipped = _sessionRestoreContent != before;
                        if (flipped) Pass("clicking the Privacy toggle changes the setting");
                        else Fail("the Privacy menu item is not wired to anything");
                        SetSessionRestoreContent(before);
                    }

                    // A path under a folder starting with t (or n, r, b) used to come back
                    // from the recent list with a control character in place of the folder
                    // name, because the reader unescaped \\ and \t in two passes.
                    string trickyPath = Path.Combine(CacheDir(), "tests", "newbackup", "note.md");
                    bool recentWas = _recentFilesEnabled;
                    _recentFilesEnabled = true;
                    var savedRecent = new List<string>(_recentFiles);
                    _recentFiles.Clear();
                    _recentFiles.Add(trickyPath);
                    SaveRecentFiles();
                    LoadRecentFiles();
                    string roundTripped = _recentFiles.Count == 1 ? _recentFiles[0] : "(count=" + _recentFiles.Count + ")";
                    log.AppendLine("RECENTPATH in=" + trickyPath + " out=" + roundTripped);
                    if (roundTripped == trickyPath) Pass("a recent path with \\t in it survives a save/load round trip");
                    else Fail("recent path mangled on reload: expected " + trickyPath + " got " + roundTripped);
                    if (roundTripped.IndexOf('\t') < 0) Pass("no control characters injected into recent paths");
                    else Fail("recent path contains a TAB where a folder name should be");

                    // Turning the recent list off must wipe it, not just stop appending.
                    SetRecentFilesEnabled(false);
                    AddRecentFile(trickyPath);
                    bool recentOffClean = _recentFiles.Count == 0 && !File.Exists(RecentFilesPath());
                    log.AppendLine("RECENTOFF count=" + _recentFiles.Count + " fileGone=" + !File.Exists(RecentFilesPath()));
                    if (recentOffClean) Pass("disabling the recent list clears it and stops recording");
                    else Fail("recent list survived being switched off");
                    SetRecentFilesEnabled(recentWas);
                    _recentFiles.Clear();
                    _recentFiles.AddRange(savedRecent);
                    SaveRecentFiles();

                    // Session bodies are the only place document text is written outside the
                    // file you chose. Default off, and switching off must delete what exists.
                    bool bodiesWas = _sessionRestoreContent;
                    SetSessionRestoreContent(true);
                    _tabs[_activeTabIndex].Content = "secret draft text";
                    _tabs[_activeTabIndex].IsDirty = true;
                    PersistTabSession();
                    bool wroteWhenOn = Directory.Exists(TabSessionBodiesDir()) &&
                        Directory.GetFiles(TabSessionBodiesDir()).Length > 0;

                    SetSessionRestoreContent(false);
                    bool goneAfterOff = !Directory.Exists(TabSessionBodiesDir());
                    PersistTabSession();
                    bool stillGone = !Directory.Exists(TabSessionBodiesDir()) ||
                        Directory.GetFiles(TabSessionBodiesDir()).Length == 0;

                    log.AppendLine("BODIES on=" + wroteWhenOn + " removedOnOff=" + goneAfterOff + " staysOff=" + stillGone);
                    if (wroteWhenOn) Pass("opting in stores unsaved text for session restore");
                    else Fail("session restore is on but no body was written");
                    if (goneAfterOff) Pass("opting out deletes the stored text immediately");
                    else Fail("stored text survived opting out");
                    if (stillGone) Pass("no document text is written while opted out");
                    else Fail("body written despite session restore being off");

                    // Dirty tabs are still offered back on close, which is what makes
                    // default-off safe rather than a silent data loss.
                    if (GetDirtyTabs().Count >= 1) Pass("unsaved work is still prompted on close when opted out");
                    else Fail("a dirty tab would close without a prompt");

                    _tabs[_activeTabIndex].Content = "";
                    _tabs[_activeTabIndex].IsDirty = false;
                    SetSessionRestoreContent(bodiesWas);

                    // Focus / Typewriter lost their toolbar buttons. They must still work
                    // from the View menu, and the menu checkmark must still reflect state —
                    // that feedback used to be the button's highlight.
                    bool noFocusBtn = FindElement("btnFocusMode") == null;
                    bool noTypeBtn = FindElement("btnTypewriterMode") == null;
                    var miFocus = FindElement("mToggleFocus") as MenuItem;
                    var miType = FindElement("mToggleTypewriter") as MenuItem;
                    bool focusBefore = miFocus != null && miFocus.IsChecked;

                    SendMsg("cmd:toggle_focus");
                    await Task.Delay(500);
                    bool focusFlipped = miFocus != null && miFocus.IsChecked != focusBefore;
                    SendMsg("cmd:toggle_focus");   // back
                    await Task.Delay(400);

                    log.AppendLine("DEMOTED focusBtnGone=" + noFocusBtn + " typeBtnGone=" + noTypeBtn +
                        " menuTracksState=" + focusFlipped);
                    if (noFocusBtn && noTypeBtn) Pass("Focus/Typewriter buttons removed from the toolbar");
                    else Fail("toolbar buttons still present");
                    if (miFocus != null && miType != null) Pass("both remain in the View menu");
                    else Fail("View menu entries missing after demotion");
                    if (focusFlipped) Pass("View menu checkmark still tracks Focus Mode state");
                    else Fail("menu checkmark no longer reflects state");

                    // Enter at the START of a line must carry the text down and leave the
                    // caret at the start of it. It used to land at the END, so a second
                    // Enter split there and produced a blank line below as well.
                    string enterJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                        "(function(){" +
                        "  loadMarkdownContent('alpha\\nbgf\\nomega');" +
                        "  var b = document.querySelectorAll('#editor .block')[1];" +
                        "  editor.focus();" +
                        "  var r = document.createRange(); r.selectNodeContents(b); r.collapse(true);" +   // START of 'bgf'
                        "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                        "  handleEnterAtBlock(b, false);" +
                        "  var sel2 = window.getSelection();" +
                        "  var blk = sel2 && sel2.anchorNode ? getAncestorBlock(sel2.anchorNode) : null;" +
                        "  var caretAtStart = false;" +
                        "  try {" +
                        "    var probe = document.createRange();" +
                        "    probe.selectNodeContents(blk);" +
                        "    probe.setEnd(sel2.anchorNode, sel2.anchorOffset);" +
                        "    caretAtStart = probe.toString().length === 0;" +
                        "  } catch (e) {}" +
                        "  return JSON.stringify({" +
                        "    doc: getMarkdownContent(false)," +
                        "    caretBlockRaw: blk ? blk.getAttribute('data-raw') : null," +
                        "    caretAtStart: caretAtStart });" +
                        "})()"));
                    log.AppendLine("ENTERSPLIT " + enterJson);
                    if (enterJson.IndexOf("alpha\\n\\nbgf\\nomega", StringComparison.Ordinal) >= 0)
                        Pass("Enter at line start inserts the blank line above");
                    else Fail("Enter at line start produced the wrong document: " + enterJson);
                    if (enterJson.IndexOf("\"caretBlockRaw\":\"bgf\"", StringComparison.Ordinal) >= 0
                        && enterJson.IndexOf("\"caretAtStart\":true", StringComparison.Ordinal) >= 0)
                        Pass("caret stays at the start of the text that moved down");
                    else Fail("caret landed in the wrong place after Enter: " + enterJson);

                    // The ordinary case: caret at the END of a line, press Enter. Must give a
                    // new empty line below with the caret on it.
                    string enterEndJson = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                        "(function(){" +
                        "  loadMarkdownContent('alpha\\nbgf\\nomega');" +
                        "  var all = document.querySelectorAll('#editor .block');" +
                        "  var b = all[1];" +
                        "  editor.focus();" +
                        "  var r = document.createRange(); r.selectNodeContents(b); r.collapse(false);" +  // END of 'bgf'
                        "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                        "  handleEnterAtBlock(b, false);" +
                        "  var sel2 = window.getSelection();" +
                        "  var blk = sel2 && sel2.anchorNode ? getAncestorBlock(sel2.anchorNode) : null;" +
                        "  var blocks = Array.prototype.slice.call(document.querySelectorAll('#editor .block'));" +
                        "  return JSON.stringify({" +
                        "    doc: getMarkdownContent(false)," +
                        "    blocks: blocks.length," +
                        "    caretIndex: blk ? blocks.indexOf(blk) : -1," +
                        "    caretBlockRaw: blk ? blk.getAttribute('data-raw') : null });" +
                        "})()"));
                    log.AppendLine("ENTEREND " + enterEndJson);
                    if (enterEndJson.IndexOf("\"caretIndex\":2", StringComparison.Ordinal) >= 0
                        && enterEndJson.IndexOf("\"caretBlockRaw\":\"\"", StringComparison.Ordinal) >= 0)
                        Pass("Enter at line end puts the caret on the new empty line");
                    else Fail("Enter at line end left the caret wrong: " + enterEndJson);

                    SetWordWrap(false);
                    await Task.Delay(250);
                    string wrapOff = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                        "String(document.body.classList.contains('nowrap'))"));
                    SetWordWrap(true);
                    await Task.Delay(250);
                    string wrapOn = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                        "String(document.body.classList.contains('nowrap'))"));
                    log.AppendLine("WORDWRAP off=" + wrapOff + " on=" + wrapOn);
                    if (wrapOff == "true" && wrapOn == "false") Pass("word wrap toggles the page");
                    else Fail("word wrap did not apply: off=" + wrapOff + " on=" + wrapOn);
                }

                // --- Perf probe: cost of the per-keystroke path on a large document ---
                // Logged, not asserted: absolute numbers vary by machine, but the
                // before/after ratio is what matters when touching the hot path.
                {
                    var big = new StringBuilder();
                    for (int i = 1; i <= 3000; i++)
                    {
                        if (i % 20 == 0) big.Append("## Section ").Append(i).Append('\n');
                        else if (i % 7 == 0) big.Append("- list item ").Append(i).Append(" with some_snake_case and `code`\n");
                        else big.Append("Line ").Append(i).Append(" of the benchmark document with **bold** text and enough prose to be realistic.\n");
                    }
                    string perfPath = Path.Combine(dir, "perf_large.md");
                    File.WriteAllText(perfPath, big.ToString(), new UTF8Encoding(false));

                    LoadFileFromPath(perfPath);
                    await Task.Delay(3000);

                    string script =
                        "(function(){" +
                        "  var blocks = document.querySelectorAll('#editor .block').length;" +
                        "  var t0 = performance.now();" +
                        "  for (var i = 0; i < 5; i++) getMarkdownContent();" +
                        "  var getMs = (performance.now() - t0) / 5;" +
                        "  var t1 = performance.now();" +
                        "  for (var j = 0; j < 5; j++) updateStatsNow();" +
                        "  var statsMs = (performance.now() - t1) / 5;" +
                        // What a keystroke actually costs now: updateStats() only arms a
                        // timer, so 100 simulated keypresses should be ~free.
                        "  var t2 = performance.now();" +
                        "  for (var k = 0; k < 100; k++) updateStats();" +
                        "  var perKeystrokeMs = (performance.now() - t2) / 100;" +
                        "  return JSON.stringify({ blocks: blocks," +
                        "    getMarkdownContentMs: Math.round(getMs * 100) / 100," +
                        "    updateStatsNowMs: Math.round(statsMs * 100) / 100," +
                        "    perKeystrokeMs: Math.round(perKeystrokeMs * 1000) / 1000 });" +
                        "})()";
                    string rawPerf = await _webView.CoreWebView2.ExecuteScriptAsync(script);
                    log.AppendLine("PERF " + DecodeJsStringResult(rawPerf));
                }
            }
            catch (Exception ex)
            {
                ok = false;
                log.AppendLine("EXCEPTION " + ex);
            }

            try
            {
                string outPath = Path.Combine(dir, "tab-e2e-result.txt");
                File.WriteAllText(outPath, (ok ? "PASS\n" : "FAIL\n") + log.ToString(), new UTF8Encoding(false));
            }
            catch { }

            try
            {
                _forceClose = true;
                Close();
            }
            catch { }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        /// <summary>
        /// Take the foreground so SendKeys lands on us. Windows refuses a bare
        /// SetForegroundWindow from a process that did not start in the foreground;
        /// attaching to the current foreground thread's input queue lifts that.
        /// </summary>
        private bool TryForceForeground()
        {
            try
            {
                IntPtr ours = new System.Windows.Interop.WindowInteropHelper(this).Handle;
                if (ours == IntPtr.Zero) return false;
                if (GetForegroundWindow() == ours) return true;

                IntPtr fg = GetForegroundWindow();
                uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
                uint self = GetCurrentThreadId();

                bool attached = false;
                if (fgThread != 0 && fgThread != self) attached = AttachThreadInput(fgThread, self, true);
                try
                {
                    ShowWindow(ours, 9); // SW_RESTORE
                    SetForegroundWindow(ours);
                    Activate();
                }
                finally
                {
                    if (attached) AttachThreadInput(fgThread, self, false);
                }
                return GetForegroundWindow() == ours;
            }
            catch { return false; }
        }

        /// <summary>
        /// Put the caret at the end of block[blockIndex] and press a real Delete key, then
        /// check what the document became. SendKeys goes to whatever window is foreground,
        /// so this refuses to fire unless TypoZen actually owns the foreground — a stray
        /// {DEL} into another app would be someone else's data.
        /// </summary>
        private async Task RunForwardDeleteKeyCase(string jsDocLiteral, int blockIndex,
            string expected, int expectedBlocks, string label,
            Action<string> Pass, Action<string> Fail, StringBuilder log)
        {
            try
            {
                string setup =
                    "(function(){" +
                    "  loadMarkdownContent('" + jsDocLiteral + "');" +
                    "  var blocks = document.querySelectorAll('#editor .block');" +
                    "  if (blocks.length <= " + blockIndex + ") return 'setup-failed';" +
                    "  var b = blocks[" + blockIndex + "];" +
                    "  editor.focus();" +
                    "  var r = document.createRange();" +
                    "  r.selectNodeContents(b); r.collapse(false);" + // end of that line
                    "  var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);" +
                    "  window.__tzDeleteSeen = 0;" +
                    "  return 'ok:' + blocks.length;" +
                    "})()";
                string setupRes = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(setup));
                if (setupRes.IndexOf("ok:", StringComparison.Ordinal) < 0)
                {
                    Fail("forward Delete [" + label + "]: setup failed (" + setupRes + ")");
                    return;
                }

                bool foreground = TryForceForeground();
                if (foreground && _webView != null) _webView.Focus();
                await Task.Delay(400);

                // Diagnostic: exactly what the handler will see when the key arrives.
                string diag =
                    "(function(){" +
                    "  var s = window.getSelection();" +
                    "  var all = Array.prototype.slice.call(document.querySelectorAll('#editor .block'));" +
                    "  var an = s && s.anchorNode;" +
                    "  var blk = an ? getAncestorBlock(an) : null;" +
                    "  var nx = blk ? blk.nextElementSibling : null;" +
                    "  return JSON.stringify({" +
                    "    collapsed: s ? s.isCollapsed : null," +
                    "    anchorName: an ? an.nodeName : null," +
                    "    anchorIsBlock: !!(an && an.classList && an.classList.contains('block'))," +
                    "    blockIdx: blk ? all.indexOf(blk) : -1," +
                    "    atEnd: blk ? isCaretAtEndOfBlock(blk) : null," +
                    "    nextIsBlock: !!(nx && nx.classList && nx.classList.contains('block'))," +
                    "    activeEl: document.activeElement ? document.activeElement.id : null });" +
                    "})()";
                log.AppendLine("  PRE[" + label + "] " + DecodeJsStringResult(
                    await _webView.CoreWebView2.ExecuteScriptAsync(diag)));

                // Verify the starting document really is what setup asked for. SendKeys is
                // asynchronous: a keystroke from an earlier case can land during this one's
                // setup and quietly change it, after which a correct merge looks like a bug.
                // jsDocLiteral carries JS-escaped newlines ("alpha\\n\\ngamma"); turn those
                // into real ones to compare against the serialized document.
                string expectedStart = jsDocLiteral.Replace("\\n", "\n");
                string beforeDoc = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                    "String(getMarkdownContent(false))"));
                if (beforeDoc != expectedStart)
                {
                    await Task.Delay(400);   // let any late keystroke land, then rebuild
                    await _webView.CoreWebView2.ExecuteScriptAsync(setup);
                    await Task.Delay(200);
                    beforeDoc = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(
                        "String(getMarkdownContent(false))"));
                    if (beforeDoc != expectedStart)
                    {
                        log.AppendLine("NOTE forward Delete [" + label + "] SKIPPED - stray input corrupted the " +
                            "starting document (harness): got " + Trunc(beforeDoc));
                        return;
                    }
                }

                string how;
                if (foreground)
                {
                    // Real keystroke: proves the handler is registered where the browser
                    // actually delivers keys, which a synthesised event aimed at a .block
                    // does not (only #editor is contenteditable, so that is the target).
                    WinForms.SendKeys.SendWait("{DEL}");
                    how = "real key";
                }
                else
                {
                    // Headless / unattended fallback: dispatch at #editor, the element the
                    // browser targets. Weaker than a real key, so say so in the log.
                    await _webView.CoreWebView2.ExecuteScriptAsync(
                        "editor.dispatchEvent(new KeyboardEvent('keydown', " +
                        "{key:'Delete', bubbles:true, cancelable:true}))");
                    how = "synthetic at #editor";
                    log.AppendLine("NOTE forward Delete [" + label + "] used " + how + " (window not foreground)");
                }
                await Task.Delay(500);

                string read =
                    "(function(){ return JSON.stringify({" +
                    "  seen: window.__tzDeleteSeen || 0," +
                    "  after: getMarkdownContent(false)," +
                    "  blocks: document.querySelectorAll('#editor .block').length }); })()";
                string json = DecodeJsStringResult(await _webView.CoreWebView2.ExecuteScriptAsync(read));
                log.AppendLine("DELETE[" + label + "] " + json);

                string wantAfter = "\"after\":\"" + expected.Replace("\n", "\\n") + "\"";
                string wantBlocks = "\"blocks\":" + expectedBlocks;
                bool matched = json.IndexOf(wantAfter, StringComparison.Ordinal) >= 0
                    && json.IndexOf(wantBlocks, StringComparison.Ordinal) >= 0;
                bool delivered = json.IndexOf("\"seen\":0", StringComparison.Ordinal) < 0;
                if (matched)
                    Pass("forward Delete [" + label + "] via " + how);
                else if (!delivered)
                    log.AppendLine("NOTE forward Delete [" + label + "] SKIPPED - the keystroke never reached the page " +
                        "(SendKeys/foreground problem, not the editor): " + json);
                else
                    Fail("forward Delete [" + label + "] handler RAN but produced the wrong result: " + json +
                        "  (document before the key was " + Trunc(beforeDoc) + ")");
            }
            catch (Exception ex)
            {
                Fail("forward Delete [" + label + "] threw: " + ex.Message);
            }
        }

        private static string Trunc(string s)
        {
            if (s == null) return "null";
            s = s.Replace("\r", "\\r").Replace("\n", "\\n");
            return s.Length <= 120 ? s : s.Substring(0, 120) + "...";
        }

        /// <summary>
        /// Clean untitled buffer we can replace on Open (empty or default new_document text).
        /// </summary>
        private static bool IsReusableEmptyUntitled(DocTab tab)
        {
            if (tab == null) return false;
            if (!string.IsNullOrEmpty(tab.FilePath)) return false;
            if (tab.IsDirty) return false;
            string c = (tab.Content ?? "").Trim();
            if (string.IsNullOrEmpty(c)) return true;
            // TypoZen_Template new_document / empty scratchpad
            if (c.IndexOf("Start typing here", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (c.Equals("# Untitled Document", StringComparison.OrdinalIgnoreCase)) return true;
            if (c.StartsWith("# Untitled Document", StringComparison.OrdinalIgnoreCase)
                && c.Length < 80) return true;
            // First-run welcome document from the template. Generated, never authored by
            // the user (editing it sets IsDirty, which already disqualifies reuse above),
            // so opening a file on a fresh profile should not strand it in its own tab.
            if (c.StartsWith("# Welcome to TypoZen", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private int IndexOfTabPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return -1;
            string full;
            try { full = Path.GetFullPath(path); }
            catch { full = path; }
            for (int i = 0; i < _tabs.Count; i++)
            {
                if (string.IsNullOrEmpty(_tabs[i].FilePath)) continue;
                try
                {
                    if (string.Equals(Path.GetFullPath(_tabs[i].FilePath), full, StringComparison.OrdinalIgnoreCase))
                        return i;
                }
                catch { }
            }
            return -1;
        }

        private void ApplyTabToEditor(DocTab tab)
        {
            if (tab == null) return;

            // A book has no text to apply, so applying it would show an empty document.
            // This is the path a restored session and every tab switch goes through, which
            // is how a restored book tab came back blank: the tab remembered the file and
            // the file is not something Content can hold.
            if (!string.IsNullOrEmpty(tab.FilePath)
                && tab.FilePath.EndsWith(".epub", StringComparison.OrdinalIgnoreCase))
            {
                tab.Kind = DocKind.Book;
                tab.NativeRole = NativeRole.None;
                ShowEditorSurface();
                _currentFilePath = tab.FilePath;
                _isDirty = false;
                InvalidateEnginePageLoad();
                RefreshEditingAvailability();
                // Strip updates now; OpenBook is deferred and would leave the strip on the
                // previous tab until the book finished extracting.
                RebuildTabStrip();
                Dispatcher.BeginInvoke(new Action(() => OpenBook(tab.FilePath, true)),
                    DispatcherPriority.Normal);
                return;
            }

            // PDF / image / media — Chromium native surface, not DocumentModel.
            if (IsNativeTab(tab) || IsNativePath(tab.FilePath))
            {
                tab.Kind = DocKind.Native;
                if (tab.NativeRole == NativeRole.None)
                    tab.NativeRole = ClassifyNativeRole(tab.FilePath);
                tab.Content = "";
                tab.IsDirty = false;
                _currentFilePath = tab.FilePath;
                _isDirty = false;
                InvalidateEnginePageLoad();
                RefreshEditingAvailability();
                Dispatcher.BeginInvoke(new Action(() => OpenNative(tab.FilePath, true)),
                    DispatcherPriority.Normal);
                return;
            }

            tab.Kind = DocKind.Engine;
            tab.NativeRole = NativeRole.None;
            ShowEditorSurface();
            _currentFilePath = tab.FilePath;
            MapDocumentFolder(_currentFilePath);   // images resolve per document
            _isDirty = tab.IsDirty;
            RefreshEditingAvailability();
            // Teardown of book CSS/layout is handled inside loadMarkdownContent when
            // kind was epub (wasBook). Do not send leave_book_surface first — that raced
            // and could remount HTML as Markdown.
            string content = tab.Content ?? "";
            // Path-keyed store fills ResumeBlock before load so staged |at= can land first paint.
            if (tab.ResumeBlock <= 0 && !string.IsNullOrEmpty(tab.FilePath))
            {
                try
                {
                    int fromPath = RememberedBookPosition(Path.GetFullPath(tab.FilePath));
                    if (fromPath > 0) tab.ResumeBlock = fromPath;
                }
                catch { }
            }
            // Skip full remount when the page already holds this tab's buffer (A→B→A).
            bool alreadyLoaded = EngineTabAlreadyOnPage(tab, content);
            if (!alreadyLoaded)
            {
                if (string.IsNullOrEmpty(content) && string.IsNullOrEmpty(tab.FilePath) && !tab.IsDirty)
                    SendMsg("new_document");
                else
                    LoadContentToEditor(content, tab.IsDirty, tab.FilePath, tab.ResumeBlock);
                RememberEnginePageLoad(tab, content);
            }

            // Mode + columns first (column remount moves the view). Then position last.
            ApplyTabView(tab);
            RequestTabResume(tab);
            SendBookmarksForCurrentDocument();
            UpdateStatusDisplay();
            // Session/recent I/O off the open hot path — was adding disk latency on every click.
            if (!_restoringTabs)
            {
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    try { PersistSessionMeta(); } catch { }
                    try { PersistTabSession(); } catch { }
                }), DispatcherPriority.Background);
            }
            // Unconditionally. This is the only repaint every caller has: restore, New Tab,
            // closing the active tab and switching all end here, and the one path that
            // returns before reaching it (SwitchToTab onto the tab already showing) calls
            // RebuildTabStrip itself for exactly that reason.
            //
            // It used to be guarded by `if (!string.IsNullOrEmpty(tab.FilePath))`, with no
            // braces, so an untitled tab was never drawn. The tab was created, made active,
            // loaded and persisted -- everything except appearing. Clicking + therefore
            // looked like it did nothing at all, and every click added another invisible
            // tab: a session file with ten untitled tabs behind a strip showing one. A
            // restart did not clear it because the session restored all ten and then took
            // this same branch. Only a tab with a path ever repainted the strip, which is
            // why opening a file appeared to fix it.
            RebuildTabStrip();
        }

        /// <summary>
        /// ONE rule for per-tab view state (mode + columns):
        ///   the reader chooses  → the click handler writes the bag (column toggle,
        ///                         Mode segment) — and session restore fills it on load
        ///   enter tab           → ApplyTabView (read bag onto the page after content is up)
        ///   leave tab           → SnapshotActiveTabView records POSITION only
        ///
        /// Nothing derived from paint state (_viewMode / _viewColumns / view_state) ever
        /// writes the bag: during a mount the page reports what it has managed to draw so
        /// far, not what the tab is for. Path defaults only fill empty fields, in
        /// ApplyTabView, without being stored.
        /// </summary>
        private static string NormalizeTabViewMode(string mode)
        {
            if (string.IsNullOrEmpty(mode)) return "";
            mode = mode.Trim().ToLowerInvariant();
            if (mode == "wysiwyg") mode = "preview";
            if (mode == "source" || mode == "preview" || mode == "reader") return mode;
            return "";
        }

        private void SnapshotActiveTabView()
        {
            if (_activeTabIndex < 0 || _activeTabIndex >= _tabs.Count) return;
            var tab = _tabs[_activeTabIndex];
            if (tab == null || IsNativeTab(tab)) return;

            // Mode and columns are NOT written here.
            //
            // _viewMode / _viewColumns are paint state -- "what the page is showing right
            // now" -- and the whole reason ApplyViewState stopped writing the bag is that
            // paint state lies during a mount: a book's first paint is 1-col until
            // RequestTabColumns runs. Leaving a tab through this path mid-mount put that
            // 1 straight back into tab.Columns and erased the spread, which is the same
            // defect by a different door.
            //
            // The bag only needs writing when the reader makes a choice, and every such
            // route already writes it: the column toggle button, the Mode segment click
            // (view_set handler), and session restore. Books are forced to Reader by
            // loadBookPayload, so there is nothing to record for them either.
            //
            // Position is different: it is not a choice, it is where they got to, and
            // nothing else captures it in time for a quick switch. So that stays.

            // Position: one integer (model block). book_position is debounced 1.2s, so a
            // quick tab switch never updated ResumeBlock — and clean leave skips the full
            // content pull. Cheap script; no document body.
            // Prefer live viewport block, then anchor, then sticky line → block (status used
            // to show Ln 1 while sticky held the real place).
            try
            {
                string r = ExecuteScriptBlocking(
                    "(function(){ try {" +
                    "  if (typeof currentReadingBlock === 'function') {" +
                    "    var b = currentReadingBlock();" +
                    "    if (b >= 0) return String(b);" +
                    "  }" +
                    "  if (typeof _readingAnchor === 'number' && _readingAnchor >= 0)" +
                    "    return String(_readingAnchor|0);" +
                    "  if (typeof _stickyLineCache === 'number' && _stickyLineCache > 1" +
                    "      && typeof modelLocationFromDocumentLine === 'function') {" +
                    "    try {" +
                    "      var loc = modelLocationFromDocumentLine(_stickyLineCache);" +
                    "      if (loc && loc.blockIndex >= 0) return String(loc.blockIndex|0);" +
                    "    } catch (eL) {}" +
                    "  }" +
                    "  return '0';" +
                    "} catch(e) { return '0'; } })()",
                    400);
                int bi;
                if (int.TryParse(r, out bi) && bi > 0)
                    tab.ResumeBlock = bi;
            }
            catch { }
        }

        /// <summary>Apply this tab's mode + columns to the page (does not write the bag).</summary>
        private void ApplyTabView(DocTab tab)
        {
            if (tab == null) return;
            if (IsNativeTab(tab)) return;

            if (IsBookTab(tab))
            {
                // Mode is forced by loadBookPayload; only columns are free.
                RequestTabColumns(tab);
                return;
            }

            string mode = NormalizeTabViewMode(tab.ViewMode);
            if (string.IsNullOrEmpty(mode) && PreferSourceModeForPath(tab.FilePath))
                mode = "source";
            if (string.IsNullOrEmpty(mode))
                mode = "preview";

            try
            {
                ApplyHostModeChrome(mode);
                SendMsg("cmd:view_set:mode:" + mode);
            }
            catch { }

            RequestTabColumns(tab);
        }

        /// <summary>Jump to the tab's ResumeBlock after view apply (remount may have moved us).</summary>
        private void RequestTabResume(DocTab tab)
        {
            if (tab == null || tab.ResumeBlock <= 0) return;
            try { SendMsg("resume_at:" + tab.ResumeBlock); } catch { }
        }

        /// <summary>
        /// Apply the tab's remembered column layout to the page (does not write tab.Columns).
        /// Books: call after load_done / Reader. While Source is active the page ignores it.
        /// </summary>
        private void RequestTabColumns(DocTab tab)
        {
            if (tab == null || tab.Columns <= 0) return;
            SendMsg("cmd:view_set:columns:" + (tab.Columns == 2 ? "2" : "1"));
        }

        private void RebuildTabStrip()
        {
            if (_tabStrip == null) return;
            _tabStrip.Children.Clear();
            EnsureAtLeastOneTab();

            // Tab chips stay rebuilt in the strip even while auto-hide has them tucked —
            // only the scroller's Visibility follows chrome. Forcing Visible here used to
            // undo SetChromeHidden on the first stats/dirty RebuildTabStrip after typing.
            var tabScroller = FindElement("tabScroller") as UIElement;
            if (tabScroller != null)
                tabScroller.Visibility = _chromeHidden ? Visibility.Collapsed : Visibility.Visible;

            // Layout (strip Margin top 5, tabBar height 36, seam at y=35):
            //   Inactive: height 24 → bottom at 29, gap above seam.
            //   Active: same top, height 31 → covers through the seam line; open bottom,
            //   fill = command bar so it reads as continuous with the menu.
            const double tabChipH = 24;
            const double activeExtra = 7; // gap + 1px seam
            double titleMax = ComputeTabTitleMaxWidth();

            for (int i = 0; i < _tabs.Count; i++)
            {
                int idx = i;
                var tab = _tabs[i];
                bool active = (i == _activeTabIndex);

                var border = new Border
                {
                    // Same top for every tab. Active only grows downward into the seam.
                    Height = active ? (tabChipH + activeExtra) : tabChipH,
                    // Slightly rounder active tab (item 6); inactive stays flat/borderless.
                    CornerRadius = active
                        ? new CornerRadius(8, 8, 0, 0)
                        : new CornerRadius(0),
                    Padding = active
                        ? new Thickness(10, 4, 6, 4)
                        : new Thickness(8, 3, 4, 3),
                    Margin = new Thickness(0, 0, 0, 0),
                    Cursor = Cursors.Hand,
                    Background = active ? _tabActiveBg : Brushes.Transparent,
                    BorderBrush = active ? _tabActiveBorder : Brushes.Transparent,
                    // Active: open bottom into the menu. Inactive: no box — dividers only.
                    BorderThickness = active
                        ? new Thickness(1, 1, 1, 0)
                        : new Thickness(0),
                    VerticalAlignment = VerticalAlignment.Top,
                    SnapsToDevicePixels = true
                };
                Panel.SetZIndex(border, active ? 2 : 0);
                try { WindowChrome.SetIsHitTestVisibleInChrome(border, true); } catch { }

                var row = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    VerticalAlignment = VerticalAlignment.Top
                };
                var title = new TextBlock
                {
                    Text = tab.Title,
                    FontSize = 12,
                    FontWeight = active ? FontWeights.SemiBold : FontWeights.Normal,
                    Foreground = active ? _tabText : _tabTextMuted,
                    Opacity = active ? 1.0 : 0.72,
                    VerticalAlignment = VerticalAlignment.Center,
                    MaxWidth = titleMax,
                    TextTrimming = TextTrimming.CharacterEllipsis
                };
                title.ToolTip = string.IsNullOrEmpty(tab.FilePath) ? "Untitled document" : tab.FilePath;

                var closeBtn = new Button
                {
                    Content = "×",
                    FontSize = 13,
                    FontWeight = FontWeights.Bold,
                    Padding = new Thickness(6, 0, 2, 0),
                    Margin = new Thickness(6, 0, 0, 0),
                    MinWidth = 22,
                    Background = Brushes.Transparent,
                    BorderThickness = new Thickness(0),
                    Foreground = _tabTextMuted,
                    // Inactive: hidden until hover (Opacity 0 keeps width so title doesn't jump).
                    Opacity = active ? 0.85 : 0,
                    IsHitTestVisible = active,
                    Cursor = Cursors.Hand,
                    ToolTip = "Close tab"
                };
                try { WindowChrome.SetIsHitTestVisibleInChrome(closeBtn, true); } catch { }
                closeBtn.Click += (s, e) =>
                {
                    e.Handled = true;
                    CloseTabAt(idx);
                };

                if (!active)
                {
                    border.MouseEnter += (s, e) =>
                    {
                        border.Background = _tabHoverBg;
                        title.Opacity = 0.92;
                        closeBtn.Opacity = 0.55;
                        closeBtn.IsHitTestVisible = true;
                    };
                    border.MouseLeave += (s, e) =>
                    {
                        border.Background = Brushes.Transparent;
                        title.Opacity = 0.72;
                        closeBtn.Opacity = 0;
                        closeBtn.IsHitTestVisible = false;
                    };
                }

                border.MouseLeftButtonUp += (s, e) =>
                {
                    if (e.OriginalSource is Button) return;
                    SwitchToTab(idx);
                };

                row.Children.Add(title);
                row.Children.Add(closeBtn);
                border.Child = row;
                _tabStrip.Children.Add(border);

                // Divider only between two inactive tabs. Next to the active tab the
                // selection border already marks the edge — a rule there is a double line.
                if (i < _tabs.Count - 1 && !active && (i + 1) != _activeTabIndex)
                {
                    var div = new Border
                    {
                        Width = 1,
                        Height = 12,
                        Margin = new Thickness(4, 6, 4, 0),
                        Background = _tabTextMuted,
                        Opacity = 0.28,
                        VerticalAlignment = VerticalAlignment.Top,
                        IsHitTestVisible = false,
                        SnapsToDevicePixels = true
                    };
                    _tabStrip.Children.Add(div);
                }
            }

            var addBtn = new Button
            {
                Content = "+",
                FontSize = 15,
                FontWeight = FontWeights.Bold,
                MinWidth = 26,
                Height = tabChipH,
                Padding = new Thickness(6, 1, 6, 1),
                Margin = new Thickness(2, 0, 0, 0),
                Background = Brushes.Transparent,
                BorderThickness = new Thickness(0),
                Foreground = _tabTextMuted,
                Cursor = Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Top,
                ToolTip = "New document tab"
            };
            try { WindowChrome.SetIsHitTestVisibleInChrome(addBtn, true); } catch { }
            addBtn.Click += (s, e) => NewTab();
            _tabStrip.Children.Add(addBtn);

            // After layout: show ‹ › only if needed; keep active tab visible.
            Dispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    UpdateTabScrollButtons();
                    ScrollActiveTabIntoView();
                }
                catch { }
            }), DispatcherPriority.Loaded);
        }

        private void SwitchToTab(int index)
        {
            if (_tabOpInProgress) return;
            if (index < 0 || index >= _tabs.Count) return;
            if (index == _activeTabIndex)
            {
                RebuildTabStrip();
                CheckEngineTabDisk(_tabs[_activeTabIndex], true);
                return;
            }
            Program.PerfMark("tab switch: begin (pulling editor state)");
            // Always attempt pull; stale only allowed when clean. Dirty + fail → stay put.
            if (!SyncActiveTabFromEditor(allowStaleIfClean: true, timeoutMs: 3000))
            {
                Program.PerfMark("tab switch: ABORTED - editor sync failed");
                NotifyEditorSyncFailedForTabOp();
                return;
            }
            Program.PerfMark("tab switch: state pulled");
            // One rule: bag the tab we leave before pointing at another.
            SnapshotActiveTabView();
            _tabOpInProgress = true;
            try
            {
                _activeTabIndex = index;
                ApplyTabToEditor(_tabs[_activeTabIndex]);
            }
            finally { _tabOpInProgress = false; }
            Program.PerfMark("tab switch: done  <<< new tab content on screen");
            if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count)
                CheckEngineTabDisk(_tabs[_activeTabIndex], true);
        }

        private void NewTab()
        {
            if (_tabOpInProgress) return;
            EnsureAtLeastOneTab();
            if (!SyncActiveTabFromEditor(allowStaleIfClean: true, timeoutMs: 3000))
            {
                NotifyEditorSyncFailedForTabOp();
                return;
            }
            SnapshotActiveTabView();
            _tabOpInProgress = true;
            try
            {
                var tab = new DocTab
                {
                    Id = _nextTabId++,
                    FilePath = null,
                    Content = "",
                    IsDirty = false
                };
                _tabs.Add(tab);
                _activeTabIndex = _tabs.Count - 1;
                ApplyTabToEditor(tab);
            }
            finally { _tabOpInProgress = false; }
        }

        private void CloseTabAt(int index)
        {
            if (_tabOpInProgress) return;
            if (index < 0 || index >= _tabs.Count) return;

            if (index == _activeTabIndex)
            {
                // Closing the live tab: require a successful sync, or an explicit
                // "close anyway" after the same Retry dialog used on app exit.
                if (!EnsureActiveEditorSyncedForClose()) return;
            }

            var tab = _tabs[index];
            // Books and native files are read-only. Never offer Save on close.
            if (IsReadOnlyTab(tab))
            {
                tab.IsDirty = false;
                if (index == _activeTabIndex) _isDirty = false;
            }
            else if (tab.IsDirty)
            {
                var res = WinForms.MessageBox.Show(
                    "Save changes to " + TabDisplayName(tab) + "?",
                    "Unsaved Changes",
                    WinForms.MessageBoxButtons.YesNoCancel,
                    WinForms.MessageBoxIcon.Warning);
                if (res == WinForms.DialogResult.Cancel) return;
                if (res == WinForms.DialogResult.Yes)
                {
                    // Active tab must re-sync successfully before write (never save stale
                    // after a "close anyway" from a failed editor pull).
                    if (index == _activeTabIndex && !SyncActiveTabFromEditor())
                    {
                        NotifyEditorSyncFailedForSave();
                        return;
                    }
                    // Writes this tab's own buffer, so removing the tab below cannot
                    // redirect the write elsewhere. Untitled tabs prompt for a path in place.
                    if (!SaveTabNow(tab, false)) return;
                }
            }

            _tabOpInProgress = true;
            try
            {
                bool closedActive = (index == _activeTabIndex);
                _tabs.RemoveAt(index);
                if (_tabs.Count == 0)
                {
                    _tabs.Add(new DocTab { Id = _nextTabId++, FilePath = null, Content = "", IsDirty = false });
                    _activeTabIndex = 0;
                    ApplyTabToEditor(_tabs[0]);
                }
                else
                {
                    if (index < _activeTabIndex)
                        _activeTabIndex--;
                    else if (_activeTabIndex >= _tabs.Count)
                        _activeTabIndex = _tabs.Count - 1;

                    if (closedActive)
                        ApplyTabToEditor(_tabs[_activeTabIndex]);
                    else
                    {
                        RebuildTabStrip();
                        PersistTabSession();
                    }
                }
            }
            finally { _tabOpInProgress = false; }
            try { SyncDiskWatchers(); } catch { }
        }

        private void OpenFile()
        {
            using (var dlg = new WinForms.OpenFileDialog())
            {
                dlg.Filter =
                    "Supported files|*.md;*.txt;*.markdown;*.epub;*.pdf;" +
                    "*.html;*.htm;*.xhtml;*.css;*.xml;*.xaml;*.xsl;*.xslt;*.json;" +
                    "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.ico;*.svg;*.avif;*.jfif;" +
                    "*.mp4;*.webm;*.ogv;*.mov;*.mp3;*.wav;*.ogg;*.m4a;*.flac|" +
                    "Documents|*.md;*.txt;*.markdown;*.epub;*.css;*.xml;*.xaml;*.json|" +
                    "HTML pages|*.html;*.htm;*.xhtml|" +
                    "PDF|*.pdf|" +
                    "Images|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.ico;*.svg;*.avif;*.jfif|" +
                    "Media|*.mp4;*.webm;*.ogv;*.mov;*.mp3;*.wav;*.ogg;*.m4a;*.flac|" +
                    "All Files|*.*";
                dlg.Title = "Open";
                if (_currentFilePath != null) dlg.InitialDirectory = Path.GetDirectoryName(_currentFilePath);
                else dlg.InitialDirectory = _appDir;

                if (dlg.ShowDialog() == WinForms.DialogResult.OK)
                {
                    LoadFileFromPath(dlg.FileName);
                }
            }
        }

        /// <summary>
        /// Read a text file honouring its BOM, falling back to the system ANSI codepage
        /// when the bytes are not valid UTF-8. Every file used to be decoded as UTF-8,
        /// which turned legacy ANSI and UTF-16 documents into mojibake — and the first
        /// save then wrote that mojibake back over the original. Content is always
        /// written back out as UTF-8 without a BOM, so the conversion is one-way but
        /// lossless (the codepage round trip is what used to destroy characters).
        /// </summary>
        private static string ReadTextFileDetect(string path, out string encodingName)
        {
            if (path.EndsWith(".epub", StringComparison.OrdinalIgnoreCase))
            {
                // A book is not text and is never read as text. It is opened through
                // EpubReader, which hands the page the book's own HTML; this returns empty
                // so nothing downstream mistakes a book for a document it could save.
                //
                // That mattered: ConfirmOverwriteLoss used to call this to fetch the "old"
                // contents of the file it was about to overwrite, got extracted text back,
                // compared it against extracted text, concluded nothing would be lost, and
                // let a Ctrl+S write plain text over the book.
                encodingName = "Epub";
                return "";
            }
            
            byte[] bytes = File.ReadAllBytes(path);
            encodingName = "UTF-8";
            if (bytes.Length == 0) return "";

            if (bytes.Length >= 4 && bytes[0] == 0xFF && bytes[1] == 0xFE && bytes[2] == 0x00 && bytes[3] == 0x00)
            {
                encodingName = "UTF-32 LE";
                return new UTF32Encoding(false, true).GetString(bytes, 4, bytes.Length - 4);
            }
            if (bytes.Length >= 4 && bytes[0] == 0x00 && bytes[1] == 0x00 && bytes[2] == 0xFE && bytes[3] == 0xFF)
            {
                encodingName = "UTF-32 BE";
                return new UTF32Encoding(true, true).GetString(bytes, 4, bytes.Length - 4);
            }
            if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            {
                encodingName = "UTF-8 (BOM)";
                return new UTF8Encoding(false).GetString(bytes, 3, bytes.Length - 3);
            }
            if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
            {
                encodingName = "UTF-16 LE";
                return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
            }
            if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
            {
                encodingName = "UTF-16 BE";
                return Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);
            }

            // No BOM: strict UTF-8 first (also covers plain ASCII), then system ANSI.
            try
            {
                return new UTF8Encoding(false, true).GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                encodingName = "ANSI (codepage " + Encoding.Default.CodePage + ")";
                return Encoding.Default.GetString(bytes);
            }
        }

        /// <summary>Dominant line ending in the file as loaded ("\r\n" or "\n").</summary>
        private static string DetectLineEnding(string content)
        {
            if (string.IsNullOrEmpty(content)) return "\n";
            int crlf = 0;
            int lfOnly = 0;
            for (int i = 0; i < content.Length; i++)
            {
                if (content[i] != '\n') continue;
                if (i > 0 && content[i - 1] == '\r') crlf++;
                else lfOnly++;
            }
            return crlf > lfOnly ? "\r\n" : "\n";
        }

        /// <summary>The exact run of newline characters a file ends with (often "\n").</summary>
        private static string DetectTrailingNewlines(string content)
        {
            if (string.IsNullOrEmpty(content)) return "";
            int end = content.Length;
            int i = end;
            while (i > 0 && (content[i - 1] == '\n' || content[i - 1] == '\r')) i--;
            return content.Substring(i, end - i);
        }

        // Opens that arrive while a tab op is mid-flight (queue; never drop).
        private readonly List<string> _pendingOpenPaths = new List<string>();

        /// <summary>
        /// Open a file from any entry point (menu, Files list, Windows Explorer / CLI args).
        /// Dirty leave is fail-closed. Re-opening a dirty tab prompts before disk reload.
        /// </summary>
        private void LoadFileFromPath(string path, bool forceEditorText = false)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path)) return;
                path = path.Trim().Trim('"');
                if (!File.Exists(path))
                {
                    if (!_e2eMode)
                    {
                        WinForms.MessageBox.Show(
                            "File not found:\n" + path,
                            "Open",
                            WinForms.MessageBoxButtons.OK,
                            WinForms.MessageBoxIcon.Warning);
                    }
                    return;
                }

                if (_tabOpInProgress)
                {
                    EnqueuePendingOpen(path);
                    return;
                }

                if (path.EndsWith(".epub", StringComparison.OrdinalIgnoreCase))
                {
                    OpenBook(path);
                    return;
                }

                // HTML defaults to rendered native page; forceEditorText = View Source path.
                if (!forceEditorText && IsNativePath(path))
                {
                    OpenNative(path);
                    return;
                }
                // Opening HTML as text while a native tab for the same path exists: reuse
                // is handled below by path match; we load as engine content.

                string encodingName;
                string raw = ReadTextFileDetect(path, out encodingName);
                string lineEnding = DetectLineEnding(raw);
                string trailing = DetectTrailingNewlines(raw);
                string content = raw.Replace("\r\n", "\n").TrimEnd('\n');
                path = Path.GetFullPath(path);
                // Non-UTF-8: save will convert — tell the user once (unless dismissed).
                MaybeWarnEncodingConversion(path, encodingName);

                // If already open in a tab, switch to it.
                for (int i = 0; i < _tabs.Count; i++)
                {
                    if (!string.IsNullOrEmpty(_tabs[i].FilePath) &&
                        string.Equals(Path.GetFullPath(_tabs[i].FilePath), path, StringComparison.OrdinalIgnoreCase))
                    {
                        // Leave current tab only after a successful pull when dirty.
                        if (i != _activeTabIndex)
                        {
                            if (!SyncActiveTabFromEditor(allowStaleIfClean: true, timeoutMs: 3000))
                            {
                                NotifyEditorSyncFailedForTabOp();
                                return;
                            }
                        }

                        bool diskDiffers = !string.Equals(_tabs[i].Content ?? "", content, StringComparison.Ordinal);
                        bool wasDirty = _tabs[i].IsDirty
                            || (i == _activeTabIndex && _isDirty);

                        // Dirty tab + disk differs: never silently wipe unsaved work.
                        if (wasDirty && diskDiffers)
                        {
                            var choice = _e2eMode
                                ? WinForms.DialogResult.No
                                : WinForms.MessageBox.Show(
                                    "This file is open with unsaved changes.\n\n" +
                                    "Yes = Reload from disk (discard edits)\n" +
                                    "No = Keep your edits\n" +
                                    "Cancel = Stay put",
                                    "Unsaved changes",
                                    WinForms.MessageBoxButtons.YesNoCancel,
                                    WinForms.MessageBoxIcon.Warning,
                                    WinForms.MessageBoxDefaultButton.Button2);
                            if (choice == WinForms.DialogResult.Cancel) return;
                            if (choice == WinForms.DialogResult.No)
                            {
                                // Keep edits: accept current disk so we do not prompt again
                                // until it changes once more.
                                StampTabDisk(_tabs[i], path, raw);
                                if (i != _activeTabIndex)
                                {
                                    _tabOpInProgress = true;
                                    try
                                    {
                                        _activeTabIndex = i;
                                        ApplyTabToEditor(_tabs[i]);
                                    }
                                    finally { _tabOpInProgress = false; }
                                }
                                else
                                {
                                    RebuildTabStrip();
                                    try { BringToFrontForHandoff(); } catch { }
                                }
                                DrainPendingOpen();
                                return;
                            }
                            // Yes = discard and load disk below
                        }

                        _tabOpInProgress = true;
                        try
                        {
                            _activeTabIndex = i;
                            // Convert native HTML → editor when opening as text (Mode Source).
                            _tabs[i].Kind = DocKind.Engine;
                            _tabs[i].NativeRole = NativeRole.None;
                            _tabs[i].SourceEncoding = encodingName;
                            _tabs[i].LineEnding = lineEnding;
                            _tabs[i].TrailingNewlines = trailing;
                            _currentFilePath = path;
                            if (!wasDirty || diskDiffers || forceEditorText)
                            {
                                // Reload from disk when clean, discard chosen, or converting native→text.
                                if (!wasDirty && !diskDiffers && !forceEditorText)
                                {
                                    _tabs[i].IsDirty = false;
                                    _isDirty = false;
                                    ApplyTabToEditor(_tabs[i]);
                                }
                                else
                                {
                                    _tabs[i].Content = content;
                                    _tabs[i].IsDirty = false;
                                    _isDirty = false;
                                    ShowEditorSurface();
                                    MapDocumentFolder(path);
                                    LoadContentToEditor(content, false, path);
                                    if (forceEditorText || PreferSourceModeForPath(path))
                                    {
                                        ApplyHostModeChrome("source");
                                        try { SendMsg("cmd:view_set:mode:source"); } catch { }
                                    }
                                    UpdateStatusDisplay();
                                    RebuildTabStrip();
                                }
                            }
                            else
                            {
                                _tabs[i].IsDirty = false;
                                _isDirty = false;
                                ApplyTabToEditor(_tabs[i]);
                                if (forceEditorText || PreferSourceModeForPath(path))
                                {
                                    ApplyHostModeChrome("source");
                                    try { SendMsg("cmd:view_set:mode:source"); } catch { }
                                }
                            }
                            StampTabDisk(_tabs[i], path, raw);
                            try { SyncDiskWatchers(); } catch { }
                        }
                        finally { _tabOpInProgress = false; }

                        Dispatcher.BeginInvoke(new Action(() =>
                        {
                            try { AddRecentFile(path); } catch { }
                            try { PersistTabSession(); } catch { }
                        }), DispatcherPriority.Background);
                        DrainPendingOpen();
                        return;
                    }
                }

                // New tab path: pull current buffer first (fail-closed when dirty).
                EnsureAtLeastOneTab();
                if (!SyncActiveTabFromEditor(allowStaleIfClean: true, timeoutMs: 3000))
                {
                    NotifyEditorSyncFailedForTabOp();
                    return;
                }

                _tabOpInProgress = true;
                try
                {
                    DocTab tab;
                    if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                        && IsReusableEmptyUntitled(_tabs[_activeTabIndex]))
                    {
                        tab = _tabs[_activeTabIndex];
                    }
                    else
                    {
                        tab = new DocTab { Id = _nextTabId++ };
                        _tabs.Add(tab);
                        _activeTabIndex = _tabs.Count - 1;
                    }

                    tab.FilePath = path;
                    tab.Content = content;
                    tab.IsDirty = false;
                    tab.Kind = DocKind.Engine;
                    tab.NativeRole = NativeRole.None;
                    tab.SourceEncoding = encodingName;
                    tab.LineEnding = lineEnding;
                    tab.TrailingNewlines = trailing;
                    StampTabDisk(tab, path, raw);
                    ApplyTabToEditor(tab);
                    try { SyncDiskWatchers(); } catch { }
                    if (forceEditorText || PreferSourceModeForPath(path))
                    {
                        ApplyHostModeChrome("source");
                        try { SendMsg("cmd:view_set:mode:source"); } catch { }
                    }
                    Dispatcher.BeginInvoke(new Action(() =>
                    {
                        try { AddRecentFile(path); } catch { }
                    }), DispatcherPriority.Background);
                }
                finally { _tabOpInProgress = false; }
                DrainPendingOpen();
            }
            catch (Exception ex)
            {
                _tabOpInProgress = false;
                WinForms.MessageBox.Show("Error opening file: " + ex.Message, "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                DrainPendingOpen();
            }
        }

        /// <summary>
        /// Open an .epub as a book: the page gets the book's own HTML, not text.
        ///
        /// The payload is staged to a file and fetched rather than pushed through the
        /// message channel, because a single omnibus runs to tens of megabytes of markup and
        /// the staging route already exists for large documents.
        ///
        /// tab.Content stays empty on purpose. A book has no Markdown behind it, and an
        /// empty Content means every path that would save, diff or restore it as text finds
        /// nothing to write -- which is the behaviour wanted, expressed as a fact about the
        /// document rather than as a guard bolted onto each of those paths.
        /// </summary>
        private void OpenBook(string path, bool forceLoad = false)
        {
            path = Path.GetFullPath(path);

            // Reuse the tab if the book is already open, but always load it.
            //
            // Switching and returning was wrong in the one case that matters: a session
            // restores its tabs, and a book's tab carries no text, so a restored book tab
            // is an empty document. Opening the book then found "already open", switched to
            // the empty tab and stopped -- the book appeared to open and showed nothing.
            // Extraction is cached, so loading again costs a re-read rather than a re-unzip.
            int existing = -1;
            for (int i = 0; i < _tabs.Count; i++)
            {
                if (!string.IsNullOrEmpty(_tabs[i].FilePath) &&
                    string.Equals(Path.GetFullPath(_tabs[i].FilePath), path, StringComparison.OrdinalIgnoreCase))
                {
                    existing = i;
                    break;
                }
            }

            if (!forceLoad && existing >= 0 && existing == _activeTabIndex && _editorReady && !string.IsNullOrEmpty(_currentFilePath) && string.Equals(Path.GetFullPath(_currentFilePath), path, StringComparison.OrdinalIgnoreCase))
            {
                // The book is already the active document in the DOM. Do not reload it,
                // otherwise it wipes out incoming external search requests from ZenSeek.
                return;
            }

            string assetDir;
            string payload = EpubReader.ReadToPayload(path, _appDir, out assetDir);
            if (payload == null)
            {
                WinForms.MessageBox.Show(
                    "That file could not be read as an epub." + Environment.NewLine +
                    Environment.NewLine + Path.GetFileName(path),
                    "Open Book", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Warning);
                return;
            }

            if (existing < 0 || existing != _activeTabIndex)
            {
                if (!SyncActiveTabFromEditor(allowStaleIfClean: true, timeoutMs: 3000))
                {
                    NotifyEditorSyncFailedForTabOp();
                    return;
                }
                SnapshotActiveTabView();
            }

            _tabOpInProgress = true;
            try
            {
                DocTab tab;
                if (existing >= 0)
                {
                    tab = _tabs[existing];
                    _activeTabIndex = existing;
                }
                else if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                    && IsReusableEmptyUntitled(_tabs[_activeTabIndex]))
                {
                    tab = _tabs[_activeTabIndex];
                }
                else
                {
                    tab = new DocTab { Id = _nextTabId++ };
                    _tabs.Add(tab);
                    _activeTabIndex = _tabs.Count - 1;
                }

                tab.FilePath = path;
                tab.Content = "";
                tab.IsDirty = false;
                tab.Kind = DocKind.Book;
                tab.NativeRole = NativeRole.None;
                tab.SourceEncoding = "Epub";
                ShowEditorSurface();
                _currentFilePath = path;
                _isDirty = false;
                RefreshEditingAvailability();

                RebuildTabStrip();

                string fileName = "book_" + Guid.NewGuid().ToString("N") + ".json";
                string bookUrl = StageLoadPayload(fileName, payload);

                // Reopen where they stopped reading. A book with no remembered position --
                // or one remembered at the very start -- opens at the cover, as it should.
                // When ZenSeek/CLI opens with --search, skip resume: last-read block and
                // the search match race (page thrash 13↔141) until only one jump wins.
                int resumeAt = RememberedBookPosition(path);
                // Only for the book the launch actually names. A ZenSeek launch carries a
                // search, and the reason to skip the resume is that the remembered block and
                // the search match would fight over the view -- which is true of that one
                // document and of nothing else. The request also survives two loads before
                // it is cleared, so as written it silently sent every book opened in between
                // to its cover.
                if (_pendingLaunch != null && !string.IsNullOrEmpty(_pendingLaunch.Search)
                    && !string.IsNullOrEmpty(_pendingLaunch.FilePath)
                    && string.Equals(Path.GetFullPath(_pendingLaunch.FilePath), path,
                                     StringComparison.OrdinalIgnoreCase))
                    resumeAt = -1;
                SendMsg("fetch_and_load_book:" + bookUrl
                    + (resumeAt > 0 ? "|at=" + resumeAt : ""));
                RequestTabColumns(tab);
                SendBookmarksForCurrentDocument();

                Dispatcher.BeginInvoke(new Action(() =>
                {
                    try { AddRecentFile(path); } catch { }
                    // Every other path that opens a file persists the session; this one did
                    // not, so a book was only ever remembered if some later action happened
                    // to persist. Open a book, close the app, and the tab was not there.
                    try { PersistTabSession(); } catch { }
                }), DispatcherPriority.Background);
            }
            catch (Exception ex)
            {
                WinForms.MessageBox.Show("Could not open the book: " + ex.Message,
                    "Open Book", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Warning);
            }
            finally { _tabOpInProgress = false; }

            DrainPendingOpen();
        }

        /// <summary>
        /// Open a PDF / image / media file on the native Chromium surface (read-only).
        /// See docs/native-reader-plan.md.
        /// </summary>
        private void OpenNative(string path, bool forceLoad = false)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return;
                path = Path.GetFullPath(path);
                NativeRole role = ClassifyNativeRole(path);
                if (role == NativeRole.None) return;

                int existing = -1;
                for (int i = 0; i < _tabs.Count; i++)
                {
                    if (!string.IsNullOrEmpty(_tabs[i].FilePath) &&
                        string.Equals(Path.GetFullPath(_tabs[i].FilePath), path, StringComparison.OrdinalIgnoreCase))
                    {
                        existing = i;
                        break;
                    }
                }

                if (!forceLoad && existing >= 0 && existing == _activeTabIndex
                    && string.Equals(_nativeNavigatedPath, path, StringComparison.OrdinalIgnoreCase)
                    && _nativeSurfaceVisible)
                {
                    return;
                }

                if (existing < 0 || existing != _activeTabIndex)
                {
                    if (!SyncActiveTabFromEditor(allowStaleIfClean: true, timeoutMs: 3000))
                    {
                        NotifyEditorSyncFailedForTabOp();
                        return;
                    }
                }

                _tabOpInProgress = true;
                try
                {
                    DocTab tab;
                    if (existing >= 0)
                    {
                        tab = _tabs[existing];
                        _activeTabIndex = existing;
                    }
                    else if (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                        && IsReusableEmptyUntitled(_tabs[_activeTabIndex]))
                    {
                        tab = _tabs[_activeTabIndex];
                    }
                    else
                    {
                        tab = new DocTab { Id = _nextTabId++ };
                        _tabs.Add(tab);
                        _activeTabIndex = _tabs.Count - 1;
                    }

                    tab.FilePath = path;
                    tab.Content = "";
                    tab.IsDirty = false;
                    tab.Kind = DocKind.Native;
                    tab.NativeRole = role;
                    tab.SourceEncoding = NativeRoleLabel(role);
                    _currentFilePath = path;
                    _isDirty = false;

                    ShowNativeSurface();
                    NavigateNative(path, role);
                    PaintNativeChrome(role);
                    RefreshEditingAvailability();
                    RebuildTabStrip();
                    UpdateStatusDisplay();

                    Dispatcher.BeginInvoke(new Action(() =>
                    {
                        try { AddRecentFile(path); } catch { }
                        try { PersistTabSession(); } catch { }
                    }), DispatcherPriority.Background);
                }
                finally { _tabOpInProgress = false; }
                DrainPendingOpen();
            }
            catch (Exception ex)
            {
                _tabOpInProgress = false;
                WinForms.MessageBox.Show("Could not open file: " + ex.Message,
                    "Open", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Warning);
                DrainPendingOpen();
            }
        }

        private void ShowEditorSurface()
        {
            _nativeSurfaceVisible = false;
            try
            {
                if (_webView != null)
                {
                    _webView.Visible = true;
                    _webView.BringToFront();
                }
                if (_nativeWebView != null) _nativeWebView.Visible = false;
            }
            catch { }
            try { ApplyZoomToWebView(); } catch { }
        }

        private void ShowNativeSurface()
        {
            _nativeSurfaceVisible = true;
            try
            {
                if (_webView != null) _webView.Visible = false;
                if (_nativeWebView != null)
                {
                    _nativeWebView.Visible = true;
                    _nativeWebView.BringToFront();
                }
            }
            catch { }
            try { ApplyZoomToWebView(); } catch { }
        }

        private void PaintNativeChrome(NativeRole role)
        {
            // Reader-like chrome. HTML: Source + Preview unlock (edit paths); Reader = render.
            try
            {
                SelectSegment("btnModeSource", false);
                SelectSegment("btnModePreview", false);
                SelectSegment("btnModeReader", true);
                _editorMode = "reader";
                _viewMode = "reader";
            }
            catch { }
            try
            {
                bool html = (role == NativeRole.Page);
                Button segSource, segPreview;
                // HTML: Source = edit markup; Preview locked (not Markdown WYSIWYG);
                // Reader = this surface. PDF/image/media: all mode locked.
                if (_segments.TryGetValue("btnModeSource", out segSource))
                {
                    SetControlLocked(segSource, !html);
                    if (html) try { segSource.ToolTip = "Edit HTML markup"; } catch { }
                }
                if (_segments.TryGetValue("btnModePreview", out segPreview))
                {
                    SetControlLocked(segPreview, true);
                    if (html)
                        try { segPreview.ToolTip = "Not used for HTML — Markdown Preview is not an HTML page. Use Source to edit, Reader to view."; } catch { }
                }
                if (_btnColumnToggle != null) SetControlLocked(_btnColumnToggle, true);
                if (_btnScrollToggle != null) SetControlLocked(_btnScrollToggle, true);
            }
            catch { }
            try
            {
                if (_lblChapter != null) _lblChapter.Text = NativeRoleLabel(role);
                if (_lblWordCount != null) _lblWordCount.Text = "";
                if (_lblLineCount != null) _lblLineCount.Text = "";
                if (_lblCharCount != null) _lblCharCount.Text = "";
                if (_lblReadingTime != null) _lblReadingTime.Text = "";
            }
            catch { }
        }

        private async void EnsureNativeWebViewAsync()
        {
            if (_nativeWebView != null && _nativeWebView.CoreWebView2 != null) return;
            if (_webViewPanel == null || _webView == null) return;
            try
            {
                if (_nativeWebView == null)
                {
                    _nativeWebView = new WebView2();
                    _nativeWebView.BackColor = _currentThemeBg;
                    try { _nativeWebView.DefaultBackgroundColor = _currentThemeBg; } catch { }
                    _nativeWebView.Dock = WinForms.DockStyle.Fill;
                    _nativeWebView.Visible = false;
                    _webViewPanel.Controls.Add(_nativeWebView);
                }
                string userDataDir = CacheDir();
                Task<CoreWebView2Environment> envTask = _envTask;
                if (envTask == null)
                    envTask = CoreWebView2Environment.CreateAsync(null, userDataDir, BuildWebView2Options());
                var env = await envTask;
                await _nativeWebView.EnsureCoreWebView2Async(env);
                try { _nativeWebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true; } catch { }
                try { _nativeWebView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true; } catch { }
                try { _nativeWebView.ZoomFactorChanged += WebView_ZoomFactorChanged; } catch { }
                try { AttachNativeNavigationGuards(_nativeWebView.CoreWebView2); } catch { }
                // .xaml / some markup is treated as a download, not a document — cancel the
                // shelf so we don't stack "Open file" bubbles over the wrong surface.
                try
                {
                    _nativeWebView.CoreWebView2.DownloadStarting += (s, e) =>
                    {
                        try { e.Cancel = true; } catch { }
                        try { e.Handled = true; } catch { }
                    };
                }
                catch { }
                // HTML "Reader" must be host read-only. Navigating TypoZen_Template.html (or any
                // contenteditable page) left the document editable while the Mode pill said Reader.
                try
                {
                    _nativeWebView.CoreWebView2.NavigationCompleted += (s, e) =>
                    {
                        try
                        {
                            if (!e.IsSuccess) return;
                            if (!_nativeSurfaceVisible) return;
                            if (_activeTabIndex < 0 || _activeTabIndex >= _tabs.Count) return;
                            var tab = _tabs[_activeTabIndex];
                            if (tab == null || tab.NativeRole != NativeRole.Page) return;
                            EnforceNativeHtmlReadOnly();
                        }
                        catch { }
                    };
                }
                catch { }
                ApplyZoomToWebView();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("Native WebView init: " + ex.Message);
            }
        }

        /// <summary>
        /// Strip editing on a rendered HTML page so Reader means read-only. Source mode
        /// is how the user edits markup.
        /// </summary>
        private async void EnforceNativeHtmlReadOnly()
        {
            try
            {
                if (_nativeWebView == null || _nativeWebView.CoreWebView2 == null) return;
                const string js =
                    @"(function(){
                        try { document.designMode = 'off'; } catch (e0) {}
                        try {
                            var all = document.querySelectorAll('[contenteditable]');
                            for (var i = 0; i < all.length; i++) {
                                all[i].setAttribute('contenteditable', 'false');
                                all[i].contentEditable = 'false';
                            }
                        } catch (e1) {}
                        try {
                            document.addEventListener('beforeinput', function (ev) {
                                ev.preventDefault();
                            }, true);
                            document.addEventListener('keydown', function (ev) {
                                if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
                                var k = ev.key;
                                if (k === 'Backspace' || k === 'Delete' || k.length === 1)
                                    ev.preventDefault();
                            }, true);
                        } catch (e2) {}
                        return 'ok';
                    })()";
                await _nativeWebView.CoreWebView2.ExecuteScriptAsync(js);
            }
            catch { }
        }

        private void MapNativeFolder(string filePath)
        {
            try
            {
                if (_nativeWebView == null || _nativeWebView.CoreWebView2 == null) return;
                string dir = null;
                if (!string.IsNullOrEmpty(filePath))
                {
                    try { dir = Path.GetDirectoryName(Path.GetFullPath(filePath)); } catch { dir = null; }
                }
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return;
                if (string.Equals(dir, _mappedNativeFolder, StringComparison.OrdinalIgnoreCase)) return;
                try { _nativeWebView.CoreWebView2.ClearVirtualHostNameToFolderMapping("localview"); } catch { }
                _nativeWebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "localview", dir, CoreWebView2HostResourceAccessKind.DenyCors);
                _mappedNativeFolder = dir;
            }
            catch { }
        }

        private void NavigateNative(string path, NativeRole role)
        {
            // Fire-and-forget ensure + navigate (OpenNative is sync for tab model).
            Dispatcher.BeginInvoke(new Action(async () =>
            {
                try
                {
                    EnsureNativeWebViewAsync();
                    // Wait briefly for CoreWebView2
                    for (int i = 0; i < 40; i++)
                    {
                        if (_nativeWebView != null && _nativeWebView.CoreWebView2 != null) break;
                        await Task.Delay(50);
                    }
                    if (_nativeWebView == null || _nativeWebView.CoreWebView2 == null)
                    {
                        WinForms.MessageBox.Show("Could not start the reader surface.",
                            "Open", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Warning);
                        return;
                    }
                    MapNativeFolder(path);
                    string name = Path.GetFileName(path);
                    // Virtual host is the file's directory; URL is just the file name.
                    string fileUrl = "https://localview/" + Uri.EscapeDataString(name);

                    string bg = string.Format("#{0:X2}{1:X2}{2:X2}",
                        _currentThemeBg.R, _currentThemeBg.G, _currentThemeBg.B);
                    string fg = "#E4E4E7";

                    // PDF / HTML: navigate file URL (relative assets for HTML).
                    if (role == NativeRole.Pdf || role == NativeRole.Page)
                    {
                        _nativeWebView.CoreWebView2.Navigate(fileUrl);
                        // NavigationCompleted also enforces; call again after settle for
                        // pages that enable contenteditable late (e.g. TypoZen_Template.html).
                        if (role == NativeRole.Page)
                        {
                            await Task.Delay(200);
                            EnforceNativeHtmlReadOnly();
                            await Task.Delay(400);
                            EnforceNativeHtmlReadOnly();
                        }
                    }
                    else if (role == NativeRole.Image)
                    {
                        string html =
                            "<!DOCTYPE html><html><head><meta charset=\"utf-8\"/>" +
                            "<style>html,body{margin:0;height:100%;background:" + bg +
                            ";display:flex;align-items:center;justify-content:center;overflow:auto}" +
                            "img{max-width:100%;max-height:100%;object-fit:contain}</style></head><body>" +
                            "<img src=\"" + fileUrl + "\" alt=\"\"/></body></html>";
                        _nativeWebView.CoreWebView2.NavigateToString(html);
                    }
                    else if (role == NativeRole.Video)
                    {
                        _nativeWebView.CoreWebView2.NavigateToString(
                            BuildNativeMediaShellHtml(fileUrl, name, bg, fg, isVideo: true));
                    }
                    else if (role == NativeRole.Audio)
                    {
                        _nativeWebView.CoreWebView2.NavigateToString(
                            BuildNativeMediaShellHtml(fileUrl, name, bg, fg, isVideo: false));
                    }
                    _nativeNavigatedPath = path;
                    ShowNativeSurface();
                    try { _nativeWebView.Focus(); } catch { }
                }
                catch (Exception ex)
                {
                    WinForms.MessageBox.Show("Could not display file: " + ex.Message,
                        "Open", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Warning);
                }
            }), DispatcherPriority.Normal);
        }

        /// <summary>
        /// Minimal media page with browser controls and a clear message when the
        /// OS/Edge cannot decode the file (common for phone HEVC / HVC1 video).
        /// </summary>
        private static string BuildNativeMediaShellHtml(
            string fileUrl, string displayName, string bg, string fg, bool isVideo)
        {
            string safeName = System.Net.WebUtility.HtmlEncode(displayName ?? "");
            string tag = isVideo ? "video" : "audio";
            string mediaStyle = isVideo
                ? "video{max-width:100%;max-height:min(100%,calc(100% - 4rem));background:#000}"
                : "audio{width:min(480px,90%)}";
            // Full element error is rare for HEVC: Edge often plays AAC audio and leaves a
            // black frame without firing 'error'. Detect videoWidth/Height === 0 after load.
            string hevcHint =
                " <span class=\"hint\">Many phone recordings use <em>HEVC (H.265 / HVC1)</em>. " +
                "Install <em>HEVC Video Extensions</em> from the Microsoft Store, " +
                "or open the file in VLC / the Photos app.</span>";
            return
                "<!DOCTYPE html><html><head><meta charset=\"utf-8\"/>" +
                "<style>" +
                "html,body{margin:0;height:100%;background:" + bg + ";color:" + fg + ";" +
                "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
                "font-family:system-ui,Segoe UI,sans-serif;padding:16px;box-sizing:border-box}" +
                mediaStyle +
                ".wrap{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:36rem;text-align:center}" +
                ".title{font-size:13px;opacity:.75;margin:0;word-break:break-all}" +
                // High-contrast panel: theme text colour alone washes out on light themes
                // when mixed with low-alpha fills (unreadable “Video picture not available”).
                "#err{display:none;margin:0;padding:14px 16px;border-radius:8px;max-width:100%;" +
                "background:#1e293b;color:#f8fafc;border:1px solid #334155;" +
                "font-size:13px;line-height:1.5;text-align:left;box-shadow:0 4px 16px rgba(0,0,0,.2)}" +
                "#err.show{display:block}" +
                "#err strong{display:block;margin-bottom:8px;font-size:15px;font-weight:600;color:#fff}" +
                "#err .hint{margin:10px 0 0;display:block;font-size:12px;line-height:1.45;color:#cbd5e1}" +
                "#err em{font-style:normal;font-weight:600;color:#93c5fd}" +
                "</style></head><body><div class=\"wrap\">" +
                "<p class=\"title\">" + safeName + "</p>" +
                "<" + tag + " id=\"m\" src=\"" + fileUrl + "\" controls controlslist=\"nodownload\"" +
                (isVideo ? " playsinline" : "") + "></" + tag + ">" +
                "<div id=\"err\" role=\"alert\"></div>" +
                "</div><script>" +
                "(function(){" +
                "var m=document.getElementById('m'),box=document.getElementById('err');" +
                "if(!m||!box)return;" +
                "var shown=false;" +
                "function show(title,detail){" +
                "if(shown)return;shown=true;" +
                "box.innerHTML='<strong>'+title+'</strong>'+detail;" +
                "box.className='show';" +
                "}" +
                "m.addEventListener('error',function(){" +
                "var code=(m.error&&m.error.code)||0;" +
                (isVideo
                    ? "show('Cannot play video'," +
                      "'TypoZen uses the same engine as Edge. '" +
                      "+(code===4||code===3" +
                      "?'The format or video codec is not available on this PC.'" +
                      ":'The file could not be loaded.')+" +
                      "'" + hevcHint.Replace("'", "\\'") + "');"
                    : "show('Cannot play audio'," +
                      "'This audio file is not supported by Edge on this PC (codec or corrupt file).');") +
                "});" +
                (isVideo
                    ? "function checkPicture(){" +
                      "if(shown)return;" +
                      // readyState HAVE_CURRENT_DATA+ and still no decoded frame size
                      "if(m.readyState<2)return;" +
                      "var dur=m.duration;" +
                      "if(!(dur>0)||!isFinite(dur))return;" +
                      "if((m.videoWidth|0)>0&&(m.videoHeight|0)>0)return;" +
                      "show('Video picture not available'," +
                      "'Sound may still play, but there is no video frame. '" +
                      "+'Usually the container demuxes while the video codec (often HEVC) is missing.'" +
                      "+'" + hevcHint.Replace("'", "\\'") + "');" +
                      "}" +
                      "m.addEventListener('loadeddata',checkPicture);" +
                      "m.addEventListener('canplay',checkPicture);" +
                      "m.addEventListener('playing',function(){setTimeout(checkPicture,150);});" +
                      "m.addEventListener('timeupdate',function onTu(){" +
                      "if(m.currentTime>0.05){m.removeEventListener('timeupdate',onTu);checkPicture();}" +
                      "});" +
                      "setTimeout(checkPicture,800);"
                    : "") +
                "})();" +
                "</script></body></html>";
        }

        private void EnqueuePendingOpen(string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            for (int i = 0; i < _pendingOpenPaths.Count; i++)
            {
                if (string.Equals(_pendingOpenPaths[i], path, StringComparison.OrdinalIgnoreCase))
                    return;
            }
            _pendingOpenPaths.Add(path);
        }

        private void DrainPendingOpen()
        {
            if (_pendingOpenPaths.Count == 0) return;
            string next = _pendingOpenPaths[0];
            _pendingOpenPaths.RemoveAt(0);
            Dispatcher.BeginInvoke(new Action(() => LoadFileFromPath(next)),
                DispatcherPriority.Normal);
        }

        private void SaveFile()
        {
            SaveActiveTab(false);
        }

        private void SaveFileAs()
        {
            SaveActiveTab(true);
        }

        /// <summary>
        /// Sync the editor into the active buffer, then write that buffer.
        /// Synchronous by design — see SaveTabNow for why the async round trip went.
        /// If the editor cannot be read, do not write (avoids saving a stale buffer).
        /// </summary>
        private void SaveActiveTab(bool saveAs)
        {
            EnsureAtLeastOneTab();
            if (!SyncActiveTabFromEditor())
            {
                NotifyEditorSyncFailedForSave();
                return;
            }
            if (_activeTabIndex < 0 || _activeTabIndex >= _tabs.Count) return;
            if (SaveTabNow(_tabs[_activeTabIndex], saveAs))
            {
            }
        }

        private void ExecuteExportHtml(string html)
        {
            using (var dlg = new WinForms.SaveFileDialog())
            {
                dlg.Filter = "HTML Document (*.html)|*.html|All Files|*.*";
                dlg.DefaultExt = "html";
                dlg.Title = "Export as HTML";
                if (_currentFilePath != null) dlg.FileName = Path.GetFileNameWithoutExtension(_currentFilePath) + ".html";
                else dlg.FileName = "Document.html";

                if (dlg.ShowDialog() == WinForms.DialogResult.OK)
                {
                    try
                    {
                        File.WriteAllText(dlg.FileName, html, Encoding.UTF8);
                        WinForms.MessageBox.Show("Exported successfully to " + dlg.FileName, "Export Complete", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
                    }
                    catch (Exception ex)
                    {
                        WinForms.MessageBox.Show("Error exporting HTML: " + ex.Message, "Error", WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Error);
                    }
                }
            }
        }

        /// <summary>
        /// Print / Export PDF (Ctrl+P). Use the surface the user is looking at:
        /// native WebView for PDF/image/media tabs, editor WebView otherwise.
        /// Printing the hidden editor while a PDF is up looks like a broken Print.
        /// </summary>
        private void ExportPdf()
        {
            try
            {
                bool nativeActive = _nativeSurfaceVisible
                    && _activeTabIndex >= 0 && _activeTabIndex < _tabs.Count
                    && IsNativeTab(_tabs[_activeTabIndex]);
                if (nativeActive
                    && _nativeWebView != null
                    && _nativeWebView.CoreWebView2 != null)
                {
                    _nativeWebView.CoreWebView2.ShowPrintUI(CoreWebView2PrintDialogKind.Browser);
                    return;
                }
            }
            catch { }

            if (_webView != null && _webView.CoreWebView2 != null)
            {
                // Refuse rather than print a fraction of the document.
                //
                // Chromium prints the DOM, and under virtualisation or page windowing the
                // DOM is a window onto the document rather than the document: measured at
                // 54 blocks of 3767 while scrolling a 205,842-character file. Printing it
                // produced a PDF of about one per cent, looking entirely plausible, with
                // nothing to say the rest was missing -- the same projection-for-document
                // mistake that saving and copying are both guarded against.
                //
                // Stopped rather than papered over. Mounting the whole document to print it
                // is exactly the work windowing exists to avoid, and on a 45,486-block
                // omnibus is not obviously survivable; a partial PDF, meanwhile, is an
                // artefact the reader keeps and may send to someone.
                string partial = EditorDomPartialForPrint();
                if (!string.IsNullOrEmpty(partial))
                {
                    WinForms.MessageBox.Show(
                        "This document is too large to print directly.\n\n" +
                        "TypoZen lays out long documents a piece at a time, so only " +
                        partial + " blocks are in the page right now. Printing would " +
                        "produce a PDF containing just that piece, with nothing to show " +
                        "the rest was missing.\n\n" +
                        "Save the file and print it from another application instead.",
                        "Cannot print the whole document",
                        WinForms.MessageBoxButtons.OK,
                        WinForms.MessageBoxIcon.Warning);
                    return;
                }
                _webView.CoreWebView2.ShowPrintUI(CoreWebView2PrintDialogKind.Browser);
            }
        }

        /// <summary>
        /// "" when the page holds the whole document and may be printed; otherwise
        /// "mounted of total", for the message. Fails open: an unanswered page prints, so a
        /// broken probe can never make Print silently stop working.
        /// </summary>
        private string EditorDomPartialForPrint()
        {
            try
            {
                string r = ExecuteScriptBlocking(
                    "(function(){ try {" +
                    "  if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks) return '';" +
                    "  var ed = document.getElementById('editor');" +
                    "  if (!ed) return '';" +
                    "  var total = DocumentModel.blocks.length;" +
                    "  var mounted = ed.querySelectorAll('.block').length;" +
                    "  var windowed = (DocumentModel.virtEnabled === true)" +
                    "    || (typeof pageWindowingActive === 'function' && pageWindowingActive());" +
                    "  if (!windowed || mounted >= total) return '';" +
                    "  return mounted + ' of ' + total;" +
                    "} catch (e) { return ''; } })()",
                    900);
                return string.IsNullOrWhiteSpace(r) ? "" : r.Trim();
            }
            catch { return ""; }
        }

        private void ToggleFullscreen()
        {
            if (this.WindowState == WindowState.Maximized && this.WindowStyle == WindowStyle.None)
            {
                this.WindowStyle = WindowStyle.SingleBorderWindow;
                ApplyNotepadTitleChrome();
                this.WindowState = WindowState.Normal;
            }
            else
            {
                this.WindowStyle = WindowStyle.None;
                this.WindowState = WindowState.Maximized;
            }
        }

        private void UpdateStatusDisplay()
        {
            if (_lblFilePath != null)
            {
                if (!string.IsNullOrEmpty(_currentFilePath))
                {
                    _lblFilePath.Text = Path.GetFileName(_currentFilePath);
                    var activeTab = (_activeTabIndex >= 0 && _activeTabIndex < _tabs.Count) ? _tabs[_activeTabIndex] : null;
                    string enc = (activeTab != null && !string.IsNullOrEmpty(activeTab.SourceEncoding))
                        ? activeTab.SourceEncoding : "UTF-8";
                    // Anything that is not plain UTF-8 gets converted on save — say so.
                    string encLine = enc.StartsWith("UTF-8") && enc.IndexOf("BOM") < 0
                        ? "Encoding: UTF-8"
                        : "Encoding: " + enc + "  →  saved as UTF-8";
                    _lblFilePath.ToolTip = _currentFilePath + "\n" + encLine + "\n\nClick to show in File Explorer";
                    _lblFilePath.Cursor = Cursors.Hand;
                }
                else
                {
                    _lblFilePath.Text = "Untitled.md";
                    _lblFilePath.ToolTip = "Unsaved document";
                    _lblFilePath.Cursor = Cursors.Arrow;
                }
            }

            if (_lblStatus != null)
            {
                if (_isDirty)
                {
                    _lblStatus.Text = "Unsaved *";
                    _lblStatus.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#F59E0B"));
                    if (_statusIndicator != null) _statusIndicator.Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#F59E0B"));
                }
                else
                {
                    _lblStatus.Text = "Saved";
                    _lblStatus.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#10B981"));
                    if (_statusIndicator != null) _statusIndicator.Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#10B981"));
                }
            }
        }

        /// <summary>
        /// A link's target as a full path, or null when it cannot be resolved.
        /// </summary>
        /// <remarks>
        /// Relative to the document that contains the link, which only the host knows.
        /// A trailing #section or ?query belongs to the link, not to the filename.
        /// </remarks>
        private string ResolveLinkPath(string rel)
        {
            if (rel == null) return null;
            rel = rel.Trim();
            int cut = rel.IndexOfAny(new[] { '#', '?' });
            if (cut >= 0) rel = rel.Substring(0, cut);
            rel = rel.Replace('/', Path.DirectorySeparatorChar).Trim();
            if (rel.Length == 0) return null;
            if (Path.IsPathRooted(rel)) return Path.GetFullPath(rel);

            string baseDir = string.IsNullOrEmpty(_currentFilePath)
                ? null : Path.GetDirectoryName(_currentFilePath);
            if (string.IsNullOrEmpty(baseDir))
            {
                NotifyLink("This document has not been saved yet, so a link relative to it has nowhere to start from.\n\nSave it first, then the link will resolve beside it.");
                return null;
            }
            return Path.GetFullPath(Path.Combine(baseDir, rel));
        }

        /// <summary>
        /// Why a link the reader clicked did not open.
        /// </summary>
        /// <remarks>
        /// A dialog rather than the status bar: that bar says Saved / Unsaved and nothing
        /// else, and borrowing it would both overwrite the dirty state and be gone before
        /// it was read. Following a link is a deliberate act -- Ctrl+click in Preview -- so
        /// silence is the wrong answer when it goes nowhere, which is the whole complaint
        /// this handling exists to fix.
        /// </remarks>
        private void NotifyLink(string message)
        {
            if (_e2eMode) return;
            // Deferred out of the WebView2 message handler, never shown from inside it. A
            // modal pumps its own message loop, and this handler is what WebView2 is in the
            // middle of dispatching -- the same shape as the blocking script call that once
            // sat here and cost six seconds of dead time on every cold open.
            try
            {
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    try
                    {
                        WinForms.MessageBox.Show(message, "Link",
                            WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
                    }
                    catch { }
                }), DispatcherPriority.Background);
            }
            catch { }
        }

        private void LblFilePath_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
        {
            try
            {
                if (string.IsNullOrEmpty(_currentFilePath)) return;
                string path = _currentFilePath;
                if (File.Exists(path))
                {
                    // Select the file in Explorer
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "explorer.exe",
                        Arguments = "/select,\"" + path + "\"",
                        UseShellExecute = true
                    });
                }
                else
                {
                    string dir = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = "explorer.exe",
                            Arguments = "\"" + dir + "\"",
                            UseShellExecute = true
                        });
                    }
                }
            }
            catch (Exception ex)
            {
                WinForms.MessageBox.Show("Could not open File Explorer:\n" + ex.Message, "TypoZen",
                    WinForms.MessageBoxButtons.OK, WinForms.MessageBoxIcon.Information);
            }
        }

    }

    /// <summary>Theme model shared by the app and the basic theme editor.</summary>
    public class ThemeInfo
    {
        public string Name;
        public string FN;
        public int FS;
        public string Bg;
        public string Tx;
        public string Hi;
        /// <summary>
        /// True for themes the user saved via Customise Theme. Serialized so it survives
        /// a restart. Built-in themes have no such marker and are protected from deletion.
        /// </summary>
        public bool Custom;
    }

    public class CustomFontWindow : Window
    {
        public string SelectedFontFamily { get; private set; }
        private readonly ComboBox _cmbFont;
        private readonly string[][] _fontPresets;

        private static string LeadingFamily(string fn)
        {
            string s = (fn ?? "").Split(',')[0].Trim().Trim('\'', '"').Trim();
            return s.Length > 0 ? s : "Custom";
        }

        public CustomFontWindow(string seedFamily, string[][] fontPresets, System.Windows.Media.Brush bg, System.Windows.Media.Brush fg)
        {
            _fontPresets = fontPresets ?? new string[0][];
            SelectedFontFamily = seedFamily;

            Title = "Custom Font";
            Width = 350;
            MinHeight = 180;
            SizeToContent = SizeToContent.Height;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            ResizeMode = ResizeMode.NoResize;
            Background = bg;
            Foreground = fg;

            var root = new StackPanel { Margin = new Thickness(20) };
            
            var lbl = new TextBlock { Text = "Select Font Family", Margin = new Thickness(0, 0, 0, 8), FontWeight = FontWeights.SemiBold };
            root.Children.Add(lbl);

            _cmbFont = new ComboBox { Height = 28, Margin = new Thickness(0, 0, 0, 20) };
            int selectedIndex = -1;
            string seedLeading = LeadingFamily(seedFamily);
            for (int i = 0; i < _fontPresets.Length; i++)
            {
                _cmbFont.Items.Add(new ComboBoxItem { Content = _fontPresets[i][0], FontFamily = new System.Windows.Media.FontFamily(_fontPresets[i][1]) });
                if (string.Equals(seedLeading, LeadingFamily(_fontPresets[i][1]), StringComparison.OrdinalIgnoreCase))
                    selectedIndex = i;
            }

            if (selectedIndex < 0 && string.IsNullOrWhiteSpace(seedFamily) && _fontPresets.Length > 0)
            {
                selectedIndex = 0;
            }
            else if (selectedIndex < 0 && !string.IsNullOrWhiteSpace(seedFamily))
            {
                _cmbFont.Items.Add(new ComboBoxItem { Content = seedLeading, FontFamily = new System.Windows.Media.FontFamily(seedFamily) });
                selectedIndex = _cmbFont.Items.Count - 1;
            }

            if (_cmbFont.Items.Count > 0 && selectedIndex >= 0)
                _cmbFont.SelectedIndex = selectedIndex;

            root.Children.Add(_cmbFont);

            var btnPanel = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            
            var btnCancel = new Button { Content = "Cancel", Width = 80, Height = 30, Margin = new Thickness(0, 0, 10, 0) };
            btnCancel.Click += (s, e) => { DialogResult = false; Close(); };
            btnPanel.Children.Add(btnCancel);

            var btnOk = new Button { Content = "Apply", Width = 80, Height = 30, IsDefault = true };
            btnOk.Click += (s, e) => {
                if (_cmbFont.SelectedIndex >= 0 && _cmbFont.SelectedIndex < _fontPresets.Length)
                    SelectedFontFamily = _fontPresets[_cmbFont.SelectedIndex][1];
                else if (_cmbFont.SelectedIndex >= _fontPresets.Length && !string.IsNullOrWhiteSpace(seedFamily))
                    SelectedFontFamily = seedFamily;
                DialogResult = true;
                Close();
            };
            btnPanel.Children.Add(btnOk);

            root.Children.Add(btnPanel);
            Content = root;
        }
    }

    /// <summary>
    /// Basic theme editor: name, colors, font preset. Live preview; Save as New only (no built-in overwrite).
    /// </summary>
    public class ThemeCustomizeWindow : Window
    {
        public event Action<ThemeInfo> PreviewRequested;
        public event Action<ThemeInfo> SaveAsNewRequested;
        public event Action DeleteRequested;

        private readonly TextBox _txtName;
        private readonly TextBox _txtBg;
        private readonly TextBox _txtTx;
        private readonly TextBox _txtHi;
        private readonly Border _swatchBg;
        private readonly Border _swatchTx;
        private readonly Border _swatchHi;
        private readonly ComboBox _cmbFont;
        private readonly ComboBox _cmbSize;
        private string[][] _fontPresets;
        private readonly string _resetName;
        private readonly string _resetFn;
        private readonly string _resetBg;
        private readonly string _resetTx;
        private readonly string _resetHi;
        private readonly int _resetFontIndex;
        private readonly int _resetFs;

        /// <summary>First family in a CSS font stack, unquoted — the label a reader expects.</summary>
        private static string LeadingFamily(string fn)
        {
            string s = (fn ?? "").Split(',')[0].Trim().Trim('\'', '"').Trim();
            return s.Length > 0 ? s : "Custom";
        }

        public ThemeCustomizeWindow(ThemeInfo seed, string[][] fontPresets, System.Windows.Media.Brush appBg, System.Windows.Media.Brush appFg)
        {
            _fontPresets = fontPresets ?? new string[0][];
            string name = seed != null && seed.Name != null ? seed.Name : "My Theme";
            string fn = seed != null && seed.FN != null ? seed.FN : "'Inter', 'Segoe UI', sans-serif";
            string bg = seed != null && seed.Bg != null ? seed.Bg : "#1E1E1E";
            string tx = seed != null && seed.Tx != null ? seed.Tx : "#D4D4D4";
            string hi = seed != null && seed.Hi != null ? seed.Hi : "#007ACC";
            _resetFs = seed != null && seed.FS > 0 ? seed.FS : 14;

            // Suggest a new name so Save as New feels natural
            if (!name.EndsWith("(Custom)", StringComparison.OrdinalIgnoreCase) && !name.StartsWith("My ", StringComparison.OrdinalIgnoreCase))
                name = name + " (Custom)";

            // The font list is a curated set of stacks, matched by exact string. A theme
            // whose stack is not one of them -- any hand-edited palette, and Solarized
            // Light once its fallback was changed from Georgia to Literata -- matched
            // nothing and fell back to index 0. That was not merely a wrong label: the
            // dialog previews from the selection and BuildTheme() saves from it, so opening
            // Customise Theme on such a theme and pressing Save silently rewrote its font
            // to Inter. A default that quietly discards the value it failed to read is
            // worse than no default.
            //
            // Nothing is substituted now. An unrecognised stack is added to the list as
            // itself and selected, so the dialog always shows the font the theme actually
            // uses and saving cannot change a font the user did not touch.
            // Match on the family the theme leads with. Whole-string matching could only
            // fail for any stack we did not write ourselves, and its failure was silent.
            int selectedFont = -1;
            string seedFamily = LeadingFamily(fn);
            for (int i = 0; i < _fontPresets.Length; i++)
            {
                if (string.Equals(seedFamily, LeadingFamily(_fontPresets[i][1]),
                        StringComparison.OrdinalIgnoreCase))
                {
                    selectedFont = i;
                    break;
                }
            }
            // A family we do not list at all still gets shown as itself rather than being
            // replaced by whatever happens to be first.
            if (selectedFont < 0 && !string.IsNullOrWhiteSpace(fn))
            {
                var extended = new string[_fontPresets.Length + 1][];
                Array.Copy(_fontPresets, extended, _fontPresets.Length);
                extended[_fontPresets.Length] = new string[] { seedFamily, fn };
                _fontPresets = extended;
                selectedFont = _fontPresets.Length - 1;
            }
            if (selectedFont < 0) selectedFont = 0;

            // Snapshot for Reset (values shown when the dialog opened)
            _resetName = name;
            _resetFn = fn;
            _resetBg = bg;
            _resetTx = tx;
            _resetHi = hi;
            _resetFontIndex = selectedFont;

            Title = "Customise Theme";
            Width = 460;
            MinHeight = 480;
            SizeToContent = SizeToContent.Height;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            ResizeMode = ResizeMode.NoResize;
            Background = appBg;
            Foreground = appFg;

            var root = new Grid { Margin = new Thickness(16, 16, 16, 20) };
            for (int r = 0; r < 12; r++)
                root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            int row = 0;

            _txtName = AddLabeledText(root, ref row, "Name", name);

            _txtBg = AddColorRow(root, ref row, "Background", bg, out _swatchBg);
            _txtTx = AddColorRow(root, ref row, "Text", tx, out _swatchTx);
            _txtHi = AddColorRow(root, ref row, "Accent", hi, out _swatchHi);

            var fontSizeLabelGrid = new Grid { Margin = new Thickness(0, 8, 0, 4) };
            fontSizeLabelGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            fontSizeLabelGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(100) });

            var fontLabel = new TextBlock { Text = "Font", FontWeight = FontWeights.SemiBold };
            Grid.SetColumn(fontLabel, 0);
            fontSizeLabelGrid.Children.Add(fontLabel);

            var sizeLabel = new TextBlock { Text = "Size", FontWeight = FontWeights.SemiBold, Margin = new Thickness(8, 0, 0, 0) };
            Grid.SetColumn(sizeLabel, 1);
            fontSizeLabelGrid.Children.Add(sizeLabel);

            Grid.SetRow(fontSizeLabelGrid, row++);
            root.Children.Add(fontSizeLabelGrid);

            var fontSizesComboGrid = new Grid { Margin = new Thickness(0, 0, 0, 4) };
            fontSizesComboGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            fontSizesComboGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(100) });

            _cmbFont = new ComboBox { Height = 28 };
            for (int i = 0; i < _fontPresets.Length; i++)
                _cmbFont.Items.Add(_fontPresets[i][0]);
            if (_cmbFont.Items.Count > 0) _cmbFont.SelectedIndex = selectedFont;
            _cmbFont.SelectionChanged += (s, e) => RequestPreview();
            Grid.SetColumn(_cmbFont, 0);
            fontSizesComboGrid.Children.Add(_cmbFont);

            // Editable so any value in range can be typed, not just the presets.
            _cmbSize = new ComboBox { Height = 28, Margin = new Thickness(8, 0, 0, 0), IsEditable = true };
            foreach (int sz in new[] { 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28 })
                _cmbSize.Items.Add(sz.ToString());
            _cmbSize.Text = _resetFs.ToString();
            _cmbSize.SelectionChanged += (s, e) => RequestPreview();
            _cmbSize.LostFocus += (s, e) => RequestPreview();
            _cmbSize.KeyDown += (s, e) => { if (e.Key == Key.Enter) { RequestPreview(); e.Handled = true; } };
            Grid.SetColumn(_cmbSize, 1);
            fontSizesComboGrid.Children.Add(_cmbSize);

            Grid.SetRow(fontSizesComboGrid, row++);
            root.Children.Add(fontSizesComboGrid);

            // Spacer so buttons sit lower / clearer of the font row
            var spacer = new Border { Height = 28 };
            Grid.SetRow(spacer, row++);
            root.Children.Add(spacer);

            var btnRow = new DockPanel { Margin = new Thickness(0, 8, 0, 4), LastChildFill = false };

            var leftBtns = new StackPanel { Orientation = Orientation.Horizontal };

            var btnReset = new Button
            {
                Content = "Reset",
                Width = 90,
                Height = 30,
                Margin = new Thickness(0, 0, 8, 0),
                ToolTip = "Undo all edits and restore the original theme colors"
            };
            btnReset.Click += (s, e) => ResetToOriginal();
            leftBtns.Children.Add(btnReset);

            var btnDelete = new Button
            {
                Content = "Delete",
                Width = 90,
                Height = 30,
                Margin = new Thickness(0, 0, 8, 0),
                ToolTip = "Delete this custom theme"
            };
            btnDelete.Click += (s, e) =>
            {
                if (DeleteRequested != null) DeleteRequested();
            };

            if (seed != null && seed.Custom)
            {
                leftBtns.Children.Add(btnDelete);
            }

            DockPanel.SetDock(leftBtns, Dock.Left);

            var rightBtns = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right
            };
            // No Preview button: the preview is already live. RequestPreview() fires on
            // dialog load, on every colour edit (picker, Enter, focus loss), on font and
            // size change, and on Reset — so an explicit button did nothing the dialog
            // had not already done a moment earlier.
            var btnSave = new Button
            {
                Content = "Save as New",
                Width = 110,
                Height = 30,
                Margin = new Thickness(0, 0, 8, 0),
                FontWeight = FontWeights.SemiBold,
                ToolTip = "Save your changes as a new custom theme. Built-in themes are protected."
            };
            btnSave.Click += (s, e) =>
            {
                var t = BuildTheme();
                if (t != null && SaveAsNewRequested != null) SaveAsNewRequested(t);
            };
            var btnCancel = new Button { Content = "Cancel", Width = 90, Height = 30, IsCancel = true };
            btnCancel.Click += (s, e) => { DialogResult = false; Close(); };
            
            rightBtns.Children.Add(btnSave);
            rightBtns.Children.Add(btnCancel);
            DockPanel.SetDock(rightBtns, Dock.Right);

            btnRow.Children.Add(leftBtns);
            btnRow.Children.Add(rightBtns);
            Grid.SetRow(btnRow, row);
            root.Children.Add(btnRow);

            Content = root;
            Loaded += (s, e) => RequestPreview();
        }

        private void ResetToOriginal()
        {
            _txtName.Text = _resetName;
            _txtBg.Text = _resetBg;
            _txtTx.Text = _resetTx;
            _txtHi.Text = _resetHi;
            UpdateSwatch(_swatchBg, _resetBg);
            UpdateSwatch(_swatchTx, _resetTx);
            UpdateSwatch(_swatchHi, _resetHi);
            if (_cmbFont.Items.Count > 0)
                _cmbFont.SelectedIndex = Math.Max(0, Math.Min(_resetFontIndex, _cmbFont.Items.Count - 1));
            if (_cmbSize != null) _cmbSize.Text = _resetFs.ToString();
            RequestPreview();
        }

        private TextBox AddLabeledText(Grid root, ref int row, string label, string value)
        {
            var lbl = new TextBlock { Text = label, Margin = new Thickness(0, 4, 0, 4), FontWeight = FontWeights.Normal, Opacity = 0.8 };
            Grid.SetRow(lbl, row++);
            root.Children.Add(lbl);
            var tb = new TextBox { Text = value, Height = 28, Margin = new Thickness(0, 0, 0, 4), Padding = new Thickness(6, 4, 6, 4) };
            Grid.SetRow(tb, row++);
            root.Children.Add(tb);
            return tb;
        }

        private TextBox AddColorRow(Grid root, ref int row, string label, string hex, out Border swatch)
        {
            var lbl = new TextBlock { Text = label, Margin = new Thickness(0, 6, 0, 4), FontWeight = FontWeights.Normal, Opacity = 0.8 };
            Grid.SetRow(lbl, row++);
            root.Children.Add(lbl);

            var panel = new DockPanel { Margin = new Thickness(0, 0, 0, 8), LastChildFill = true };
            
            var btnPick = new Button
            {
                Width = 48,
                Height = 28,
                Margin = new Thickness(0, 0, 8, 0),
                ToolTip = "Pick color",
                Padding = new Thickness(0)
            };
            DockPanel.SetDock(btnPick, Dock.Left);
            
            swatch = new Border
            {
                Width = 24,
                Height = 20,
                CornerRadius = new CornerRadius(2),
                BorderBrush = new SolidColorBrush(Color.FromRgb(0x44, 0x44, 0x44)),
                BorderThickness = new Thickness(1)
            };
            btnPick.Content = swatch;

            var tb = new TextBox
            {
                Text = hex,
                Height = 28,
                Padding = new Thickness(6, 4, 6, 4),
                VerticalContentAlignment = VerticalAlignment.Center,
                FontFamily = new FontFamily("Consolas, Courier New, monospace")
            };
            try { swatch.Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); } catch { }

            Border sw = swatch;
            TextBox box = tb;
            btnPick.Click += (s, e) =>
            {
                using (var cd = new WinForms.ColorDialog())
                {
                    cd.FullOpen = true;
                    try
                    {
                        var c = (Color)ColorConverter.ConvertFromString(box.Text.Trim());
                        cd.Color = System.Drawing.Color.FromArgb(c.R, c.G, c.B);
                    }
                    catch { }
                    if (cd.ShowDialog() == WinForms.DialogResult.OK)
                    {
                        box.Text = string.Format("#{0:X2}{1:X2}{2:X2}", cd.Color.R, cd.Color.G, cd.Color.B);
                        UpdateSwatch(sw, box.Text);
                        RequestPreview();
                    }
                }
            };
            tb.LostFocus += (s, e) =>
            {
                UpdateSwatch(sw, box.Text);
                RequestPreview();
            };
            tb.KeyDown += (s, e) =>
            {
                if (e.Key == Key.Enter)
                {
                    UpdateSwatch(sw, box.Text);
                    RequestPreview();
                    e.Handled = true;
                }
            };

            panel.Children.Add(btnPick);
            panel.Children.Add(tb);
            Grid.SetRow(panel, row++);
            root.Children.Add(panel);
            return tb;
        }

        private static void UpdateSwatch(Border swatch, string hex)
        {
            try
            {
                if (swatch != null)
                    swatch.Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex.Trim()));
            }
            catch { }
        }

        private ThemeInfo BuildTheme()
        {
            string fn = _resetFn;
            int fi = _cmbFont.SelectedIndex;
            if (fi >= 0 && fi < _fontPresets.Length)
            {
                // Picking the family the theme already had is not a change, so keep its
                // original stack verbatim -- fallbacks included. Recomposing it would
                // quietly turn "'Bookerly', 'Literata', serif" into "'Bookerly', serif"
                // just because the dialog was opened and saved.
                fn = string.Equals(LeadingFamily(_fontPresets[fi][1]), LeadingFamily(_resetFn),
                        StringComparison.OrdinalIgnoreCase)
                    ? _resetFn
                    : _fontPresets[fi][1];
            }
            if (string.IsNullOrWhiteSpace(fn)) fn = "'Inter', sans-serif";

            // Clamp to the same range SaveThemeAsNew enforces, so preview and save agree.
            int fs = _resetFs > 0 ? _resetFs : 14;
            if (_cmbSize != null)
            {
                int typed;
                string raw = (_cmbSize.Text ?? "").Trim();
                if (int.TryParse(raw, out typed) && typed >= 10 && typed <= 28) fs = typed;
            }

            return new ThemeInfo
            {
                Name = _txtName.Text != null ? _txtName.Text.Trim() : "My Theme",
                FN = fn,
                FS = fs,
                Bg = _txtBg.Text != null ? _txtBg.Text.Trim() : "#1E1E1E",
                Tx = _txtTx.Text != null ? _txtTx.Text.Trim() : "#D4D4D4",
                Hi = _txtHi.Text != null ? _txtHi.Text.Trim() : "#007ACC"
            };
        }

        private void RequestPreview()
        {
            var t = BuildTheme();
            if (PreviewRequested != null) PreviewRequested(t);
        }
    }
}
