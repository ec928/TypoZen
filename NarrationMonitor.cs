using System;
using System.Collections.Generic;
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
    /// </summary>
    internal static class NarrationMonitor
    {
        private static Window _win;
        private static TextBlock _settings;
        private static TextBox _now;
        private static ListBox _before;
        private const int Kept = 30;

        public static bool IsOpen { get { return _win != null; } }

        /// <summary>Opens it, or brings it forward. `closed` is told when the reader closes it.</summary>
        public static void Open(Window owner, Action closed)
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
            Func<string, TextBlock> heading = t => new TextBlock { Text = t, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 10, 0, 4) };
            _settings = new TextBlock { TextWrapping = TextWrapping.Wrap, Opacity = 0.85, Text = "Nothing has been read yet." };
            _now = new TextBox
            {
                IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                MinHeight = 150, FontSize = 12.5, BorderThickness = new Thickness(1), Text = "Press Read Aloud with a narrator voice chosen."
            };
            _before = new ListBox { FontSize = 11.5 };
            var top = new StackPanel { Margin = new Thickness(14, 4, 14, 0) };
            top.Children.Add(heading("Settings for every piece"));
            top.Children.Add(_settings);
            top.Children.Add(heading("Playing now"));
            top.Children.Add(_now);
            top.Children.Add(heading("Before"));
            var outer = new DockPanel();
            DockPanel.SetDock(top, Dock.Top);
            outer.Children.Add(top);
            _before.Margin = new Thickness(14, 0, 14, 14);
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
        public static void Piece(string json, Func<string, string, string> voiceName)
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
                if (cues && cue.Length > 0) sb.Append(", worded “").Append(cue).Append('”');
                sb.Append('.');
                if (breeze) sb.Append("  Emotion strength: ").Append(Num(st, "strength", 4).ToString("0.#")).Append('.');
                if (st.TryGetValue("private", out o) && o is bool && (bool)o) sb.Append("  Privacy Mode: on.");
                _settings.Text = sb.ToString();

                string role = Str(d, "role");
                string voice = voiceName(engine, Str(d, "voice"));
                double secs = Num(d, "seconds", 0);
                bool cached = d.TryGetValue("cached", out o) && o is bool && (bool)o;
                double ownStrength = Num(d, "strength", 0);
                var now = new StringBuilder();
                now.Append(role == "dialogue" ? "A character" : "The narrator").Append(", in ").Append(voice)
                   .Append(" — ").Append(secs.ToString("0.0")).Append("s, ").Append(cached ? "from saved audio" : "rendered just now");
                if (ownStrength > 0) now.Append(", the line's own strength ").Append(ownStrength.ToString("0.#"));
                now.Append("\r\n");
                int n = 0;
                var parts = d.TryGetValue("parts", out o) ? o as System.Collections.IEnumerable : null;
                string firstText = "";
                foreach (var po in parts ?? new object[0])
                {
                    var p = po as Dictionary<string, object>;
                    if (p == null) continue;
                    n++;
                    string text = Str(p, "text"), ins = Str(p, "instruction");
                    if (firstText.Length == 0) firstText = text;
                    now.Append("\r\n");
                    if (n > 1 || CountParts(parts) > 1) now.Append("Part ").Append(n).Append("\r\n");
                    now.Append("Text sent:   ").Append(text).Append("\r\n");
                    now.Append("Instruction: ").Append(ins.Length == 0 ? "none" : ins).Append("\r\n");
                    if (breeze)
                        now.Append("Strength:    ").Append(ins.Length == 0 ? "none (no instruction)" : Num(p, "strength", 1).ToString("0.#")).Append("\r\n");
                }
                _now.Text = now.ToString();
                _before.Items.Insert(0, DateTime.Now.ToString("HH:mm:ss") + "  " + (role == "dialogue" ? voice : "Narrator") + ": "
                                         + (firstText.Length > 90 ? firstText.Substring(0, 90) + "..." : firstText));
                while (_before.Items.Count > Kept) _before.Items.RemoveAt(_before.Items.Count - 1);
            }
            catch (Exception ex) { if (_now != null) _now.Text = "Could not show this piece: " + ex.Message; }
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
