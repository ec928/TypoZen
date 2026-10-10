using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace TypoZen
{
    /// <summary>
    /// Read Aloud > Narration Monitor: a window beside the reading that shows, as each piece starts
    /// to play, exactly what the narrator was given -- who speaks, in which voice, the text as the
    /// engine received it (after Breeze's translation of the tags), the instruction, the strength --
    /// and the settings that shape every piece. The page reports each piece (host_narr_monitor:);
    /// nothing here is written anywhere, so it shows the book's text on screen and nowhere else.
    /// narration.log is a different record: when pieces were asked for, from the cache or not, and
    /// played, with lengths and file names but never the text or the instruction. The label at the
    /// bottom finds that file, as the file name in the status bar does.
    /// </summary>
    internal static class NarrationMonitor
    {
        private static Window _win;
        private static TextBlock _settings;
        private static TextBox _now;
        private static TextBox _before;
        private static TextBlock _logLabel;
        private static readonly List<string> _entries = new List<string>();
        private static bool _stale;
        private static Func<string, string> _logFor;
        private static string _engine;
        private const int Kept = 30;

        public static bool IsOpen { get { return _win != null; } }

        /// <summary>
        /// Opens it, or brings it forward. `closed` is told when the reader closes it. `logFor` gives
        /// narration.log's path for an engine ("qwen" or "breeze").
        /// </summary>
        public static void Open(Window owner, Action closed, Func<string, string> logFor)
        {
            if (_win != null) { _win.Activate(); return; }
            var w = new Window
            {
                Title = "Narration Monitor", Width = 600, Height = 560, MinWidth = 420, MinHeight = 320,
                ShowInTaskbar = false, ResizeMode = ResizeMode.CanResizeWithGrip,
                WindowStartupLocation = WindowStartupLocation.Manual,
                Background = owner != null ? owner.Background : null, Foreground = owner != null ? owner.Foreground : null
            };
            try
            {
                w.Owner = owner;
                if (owner != null) { w.Left = owner.Left + Math.Max(0, owner.ActualWidth - 620); w.Top = owner.Top + 80; }
            }
            catch { }
            DialogTheme.Apply(w, owner);
            Func<string, TextBlock> heading = t => new TextBlock { Text = t, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 10, 0, 4) };
            _settings = new TextBlock { TextWrapping = TextWrapping.Wrap, Opacity = 0.85, Text = "Nothing has been read yet." };
            _now = new TextBox
            {
                IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                MinHeight = 150, FontSize = 12.5, BorderThickness = new Thickness(1), Text = "Press Read Aloud with a narrator voice chosen."
            };
            // One text, newest first, so Ctrl+A and Copy take all of it; entries wrap to the width.
            // While the reader has a selection, new pieces wait, so it is not lost under them.
            _before = new TextBox
            {
                IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, FontSize = 11.5, BorderThickness = new Thickness(1),
                Text = string.Join("\r\n\r\n", _entries)
            };
            _before.SelectionChanged += (s, e) => { if (_stale && _before.SelectionLength == 0) ShowEntries(); };
            var top = new StackPanel { Margin = new Thickness(14, 4, 14, 0) };
            top.Children.Add(heading("Settings for every piece"));
            top.Children.Add(_settings);
            top.Children.Add(heading("Playing now"));
            top.Children.Add(_now);
            top.Children.Add(heading("Before"));
            var copy = new Button { Content = "Copy all", Padding = new Thickness(10, 2, 10, 2), Margin = new Thickness(0, 0, 12, 0) };
            copy.Click += (s, e) =>
            {
                try { Clipboard.SetText(_now.Text + "\r\n\r\n" + string.Join("\r\n\r\n", _entries)); } catch { }
            };
            _logFor = logFor;
            _logLabel = new TextBlock { VerticalAlignment = VerticalAlignment.Center, Cursor = System.Windows.Input.Cursors.Hand, Opacity = 0.85 };
            _logLabel.MouseLeftButtonUp += (s, e) => RevealLog();
            ShowLog(_engine ?? NewestEngine());
            var bottom = new DockPanel { Margin = new Thickness(14, 0, 14, 12) };
            DockPanel.SetDock(copy, Dock.Left);
            bottom.Children.Add(copy);
            bottom.Children.Add(_logLabel);
            var outer = new DockPanel();
            DockPanel.SetDock(top, Dock.Top);
            outer.Children.Add(top);
            DockPanel.SetDock(bottom, Dock.Bottom);
            outer.Children.Add(bottom);
            _before.Margin = new Thickness(14, 0, 14, 10);
            outer.Children.Add(_before);
            if (w.Foreground != null) outer.SetValue(TextElement.ForegroundProperty, w.Foreground);
            w.Content = outer;
            w.Closed += (s, e) => { _win = null; if (closed != null) closed(); };
            _win = w;
            w.Show();
        }

        public static void Close()
        {
            var w = _win;
            _win = null;
            if (w != null) try { w.Close(); } catch { }
        }

        /// <summary>
        /// One piece from the page, as it starts to play. `voiceName` turns a voice id into the name
        /// the reader knows it by, for the engine named in the settings.
        /// </summary>
        public static void Piece(string json, Func<string, string, string> voiceName, Func<string, string> speakerName)
        {
            if (_win == null) return;
            try
            {
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object o;
                var st = d.TryGetValue("settings", out o) ? o as Dictionary<string, object> ?? new Dictionary<string, object>() : new Dictionary<string, object>();
                string engine = Str(st, "engine") == "breeze" ? "Breeze" : "Qwen";
                bool breeze = engine == "Breeze";

                var sb = new StringBuilder();
                sb.Append(engine).Append(" narrator, voice ").Append(Str(st, "voice"));
                sb.Append(".  Speed ").Append(Num(st, "speed", 1).ToString("0.##")).Append('.');
                string instr = Str(st, "instruction");
                sb.Append("  Standing instruction: ").Append(instr.Length == 0 ? "none" : "“" + instr + "”").Append('.');
                bool cues = st.TryGetValue("cuesOn", out o) && o is bool && (bool)o;
                sb.Append("  Emotion cues: ").Append(cues ? "on" : "off");
                string cue = Str(st, "cue");
                if (cues && cue.Length > 0) sb.Append(", worded “").Append(cue.TrimEnd().TrimEnd('.')).Append("”.");
                else sb.Append('.');
                if (breeze) sb.Append("  Emotion strength: ").Append(Num(st, "strength", 4).ToString("0.#")).Append('.');
                if (st.TryGetValue("private", out o) && o is bool && (bool)o) sb.Append("  Privacy Mode: on.");
                _settings.Text = sb.ToString();

                string role = Str(d, "role");
                string voice = voiceName(engine, Str(d, "voice"));
                double secs = Num(d, "seconds", 0);
                bool cached = d.TryGetValue("cached", out o) && o is bool && (bool)o;
                double ownStrength = Num(d, "strength", 0);
                // Compact: a header, then two lines per part -- the text, and the instruction with its
                // strength -- and no blank lines (Ed, 2026-10-09: "hard to read").
                var now = new StringBuilder();
                // Who speaks, then in which voice: a character by the name the cast found for them.
                string who = role == "dialogue" ? speakerName(Str(d, "speaker")) : "Narrator";
                now.Append(who).Append(" · voice ").Append(voice)
                   .Append(" · ").Append(secs.ToString("0.0")).Append("s · ").Append(cached ? "saved" : "rendered");
                if (ownStrength > 0) now.Append(" · line strength ").Append(ownStrength.ToString("0.#"));
                var parts = d.TryGetValue("parts", out o) ? o as System.Collections.IEnumerable : null;
                int count = CountParts(parts), n = 0;
                foreach (var po in parts ?? new object[0])
                {
                    var p = po as Dictionary<string, object>;
                    if (p == null) continue;
                    n++;
                    string text = Str(p, "text"), ins = Str(p, "instruction");
                    string mark = count > 1 ? n + ". " : "";
                    string pad = new string(' ', mark.Length);
                    now.Append("\r\n").Append(mark).Append("Text: ").Append(text);
                    now.Append("\r\n").Append(pad).Append("Instruction: ").Append(ins.Length == 0 ? "none" : ins);
                    if (breeze && ins.Length > 0) now.Append("  (strength ").Append(Num(p, "strength", 1).ToString("0.#")).Append(')');
                }
                _now.Text = now.ToString();
                // History keeps the whole of it -- text, instruction, strength, part by part -- not the
                // first words alone (Ed, 2026-10-09: "log history is incomplete").
                _entries.Insert(0, DateTime.Now.ToString("HH:mm:ss") + "  " + now.ToString().TrimEnd());
                while (_entries.Count > Kept) _entries.RemoveAt(_entries.Count - 1);
                ShowEntries();
                ShowLog(breeze ? "breeze" : "qwen", st.TryGetValue("private", out o) && o is bool && (bool)o);
            }
            catch (Exception ex) { if (_now != null) _now.Text = "Could not show this piece: " + ex.Message; }
        }

        private static void ShowEntries()
        {
            if (_before == null) return;
            if (_before.SelectionLength > 0) { _stale = true; return; }
            _stale = false;
            _before.Text = string.Join("\r\n\r\n", _entries);
        }

        /// <summary>The engine whose narration.log was written last, before any piece says which.</summary>
        private static string NewestEngine()
        {
            try
            {
                string q = _logFor != null ? _logFor("qwen") : null, b = _logFor != null ? _logFor("breeze") : null;
                DateTime tq = q != null && File.Exists(q) ? File.GetLastWriteTime(q) : DateTime.MinValue;
                DateTime tb = b != null && File.Exists(b) ? File.GetLastWriteTime(b) : DateTime.MinValue;
                return tb > tq ? "breeze" : "qwen";
            }
            catch { return "qwen"; }
        }

        private static void ShowLog(string engine, bool privacy = false)
        {
            _engine = engine;
            if (_logLabel == null || _logFor == null) return;
            string path = _logFor(engine) ?? "";
            _logLabel.Text = "Narration log: " + Path.GetFileName(Path.GetDirectoryName(path)) + "\\" + Path.GetFileName(path)
                + (privacy ? " (not written in Privacy Mode)" : "");
            _logLabel.ToolTip = path + "\r\nClick to show it in File Explorer. It records when each piece was asked for "
                + "and played, never its text or instruction.";
        }

        /// <summary>Selects narration.log in File Explorer, or opens its folder if there is none yet.</summary>
        private static void RevealLog()
        {
            try
            {
                string path = _logFor != null ? _logFor(_engine ?? "qwen") : null;
                if (string.IsNullOrEmpty(path)) return;
                if (File.Exists(path))
                    Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = "/select,\"" + path + "\"", UseShellExecute = true });
                else if (Directory.Exists(Path.GetDirectoryName(path)))
                    Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = "\"" + Path.GetDirectoryName(path) + "\"", UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not open File Explorer:\n" + ex.Message, "TypoZen", MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }

        private static int CountParts(System.Collections.IEnumerable parts)
        {
            int c = 0;
            foreach (var p in parts ?? new object[0]) c++;
            return c;
        }

        private static string Str(Dictionary<string, object> d, string k)
        {
            object o;
            return d != null && d.TryGetValue(k, out o) && o != null ? Convert.ToString(o) : "";
        }

        private static double Num(Dictionary<string, object> d, string k, double fallback)
        {
            object o;
            try { return d != null && d.TryGetValue(k, out o) && o != null ? Convert.ToDouble(o) : fallback; }
            catch { return fallback; }
        }
    }
}
