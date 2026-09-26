using System;
using System.Collections.Generic;
using System.Media;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace TypoZen
{
    /// <summary>
    /// File > Read Aloud > Narrator settings.
    ///
    /// Three tabs, by how often each is used. Reading holds what shapes every narration -- the
    /// voice, the whole instruction, emotion cues -- on the left, and Try it on the right, always
    /// in view, so a change is made and heard without scrolling: A plays the settings on screen,
    /// B a set kept for comparison, each labelled with what it is. Voices is the library (play,
    /// import, export, delete, design new ones), which acts at once. Cast is this book's
    /// characters, shown only with a book open. Save and Cancel cover Reading and Cast.
    ///
    /// Everything is words, not sliders. A voice is made by describing it; the narrator renders
    /// three candidates, because the same words make a slightly different person each time, and
    /// keeping one saves its voice-print so it is that same person from then on. The instruction
    /// is shown whole and edited as it stands -- nothing hidden is added to it -- with presets as
    /// starting points and the reader's own saved beside them. Try it reads text through
    /// narration's own preparation, so a setting is judged by ear rather than assumed.
    ///
    /// The narrator does the work over its loopback API; this window only asks and plays what
    /// comes back. Calls that take time run off the UI thread and say what they are doing.
    /// </summary>
    internal static class NarratorDialog
    {
        /// <summary>Set while the dialog is open: the page's answer to a cast scan (host_narrator_cast).</summary>
        public static Action<string> CastScanArrived;

        /// <summary>Set while the dialog is open: the page's answers to Try it (host_narrator_trial).</summary>
        public static Action<string> TrialArrived;

        private sealed class VoiceItem
        {
            public string Id;
            public string Name;
            public string Description;
            public string Preview;
            public override string ToString() { return Name; }
        }

        private sealed class PresetItem
        {
            public string Name;
            public string Text;
            public bool Mine;
            public override string ToString() { return Mine ? Name : Name + "  (built in)"; }
        }

        /// <summary>Everything a Try it reading depends on, so one can be kept and compared.</summary>
        private sealed class Trial
        {
            public string Voice, VoiceName, Instruction, Cue, Label;
            public bool Direct;
        }

        // Narration, a line tagged as said quietly, one tagged as snapped, and an amount: each of
        // the things the Reading settings change is in it. Kept for the session once edited.
        private static string _sample =
            "The rain had not stopped for three days, and the harbour lights were smeared across the black water. Mara pushed the door open and stood there, dripping.\r\n"
            + "“You said you’d be back by Tuesday,” Tom said quietly. “It’s Friday.”\r\n"
            + "“I know,” she snapped. “The ferry cost me £86 and it still ran four hours late.”";

        public static void Show(Window owner, string cacheDir, string appDir, string book, Action<string> sendToPage, Action saved)
        {
            Build(owner, cacheDir, appDir, book, sendToPage, saved, true).ShowDialog();
        }

        /// <summary>
        /// The window, ready to show. `start` false leaves the narrator alone, for rendering the
        /// layout without showing it (checking the design by eye before a release).
        /// </summary>
        internal static Window Build(Window owner, string cacheDir, string appDir, string book, Action<string> sendToPage, Action saved, bool start)
        {
            var settings = QwenNarrator.LoadSettings(cacheDir);
            var cast = QwenNarrator.LoadCast(cacheDir, book);
            var voices = new List<VoiceItem>();
            SoundPlayer player = null;
            Trial kept = null;              // Try it: B, the reading kept for comparison

            var win = new Window
            {
                Title = "Narrator",
                Width = 1000,
                Height = 740,
                MinWidth = 820,
                MinHeight = 640,            // below this, "What the narrator was told" has no room
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                ResizeMode = ResizeMode.CanResizeWithGrip,
                ShowInTaskbar = false,
                Background = owner != null ? owner.Background : null,
                Foreground = owner != null ? owner.Foreground : null
            };
            try { win.Owner = owner; } catch { }

            // ---- building blocks
            Func<string, TextBlock> heading = t => new TextBlock { Text = t, FontWeight = FontWeights.SemiBold, FontSize = 13.5, Margin = new Thickness(0, 16, 0, 4) };
            Func<string, TextBlock> note = t => new TextBlock { Text = t, TextWrapping = TextWrapping.Wrap, Opacity = 0.72, Margin = new Thickness(0, 0, 0, 6) };
            Func<string, Button> button = t => new Button { Content = t, Padding = new Thickness(10, 2, 10, 2), Height = 26, Margin = new Thickness(0, 0, 6, 0) };
            Func<UIElement[], StackPanel> row = items =>
            {
                var p = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 3, 0, 3) };
                foreach (var i in items) p.Children.Add(i);
                return p;
            };
            // A tab's content in the window's own colours: the tab strip keeps the system look,
            // the page under it matches TypoZen's theme.
            Func<UIElement, Border> page = content =>
            {
                var b = new Border { Child = content, Padding = new Thickness(18, 4, 18, 12), Background = win.Background };
                if (win.Foreground != null) b.SetValue(TextElement.ForegroundProperty, win.Foreground);
                return b;
            };
            Func<UIElement, ScrollViewer> scrolling = content => new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
            Func<string, UIElement, Expander> fold = (title, content) =>
            {
                var x = new Expander { Header = title, Content = content, Margin = new Thickness(0, 4, 0, 2) };
                if (win.Foreground != null) x.Foreground = win.Foreground;
                return x;
            };
            Func<string, CheckBox> check = t => { var c = new CheckBox { Content = t, Margin = new Thickness(0, 2, 0, 2) }; if (win.Foreground != null) c.Foreground = win.Foreground; return c; };

            // ================================================================ Reading
            var left = new StackPanel { Margin = new Thickness(0, 0, 18, 0) };

            left.Children.Add(heading("Voice"));
            var voiceBox = new ComboBox { MinWidth = 300 };
            var playVoice = button("▶ Sample");
            playVoice.ToolTip = "The recording made when this voice was designed";
            var voiceRow = new DockPanel { Margin = new Thickness(0, 3, 0, 3) };
            DockPanel.SetDock(playVoice, Dock.Right);
            playVoice.Margin = new Thickness(6, 0, 0, 0);
            voiceRow.Children.Add(playVoice);
            voiceRow.Children.Add(voiceBox);
            left.Children.Add(voiceRow);
            var voiceDesc = note("");
            left.Children.Add(voiceDesc);

            left.Children.Add(heading("Instruction"));
            left.Children.Add(note("Everything the narrator is told for each paragraph, exactly as written here. Leave it empty for no instruction at all."));
            var presetBox = new ComboBox { MinWidth = 300 };
            var presetRow = new DockPanel { Margin = new Thickness(0, 3, 0, 3) };
            var presetLabel = new TextBlock { Text = "Preset", Width = 56, VerticalAlignment = VerticalAlignment.Center };
            DockPanel.SetDock(presetLabel, Dock.Left);
            presetRow.Children.Add(presetLabel);
            presetRow.Children.Add(presetBox);
            left.Children.Add(presetRow);
            var instructionBox = new TextBox { Text = settings.Instruction, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Height = 96, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            // Empty is a real choice, so it says what it means rather than looking unfinished.
            var instructionHint = new TextBlock
            {
                Text = "No instruction: the narrator reads with nothing but the text.", Margin = new Thickness(6, 4, 6, 0),
                Foreground = Brushes.Gray, IsHitTestVisible = false, TextWrapping = TextWrapping.Wrap
            };
            var instructionCell = new Grid { Margin = new Thickness(0, 4, 0, 4) };
            instructionCell.Children.Add(instructionBox);
            instructionCell.Children.Add(instructionHint);
            left.Children.Add(instructionCell);
            instructionHint.Visibility = instructionBox.Text.Trim().Length == 0 ? Visibility.Visible : Visibility.Collapsed;
            instructionBox.TextChanged += (s, e) => instructionHint.Visibility = instructionBox.Text.Trim().Length == 0 ? Visibility.Visible : Visibility.Collapsed;
            var savePreset = button("Save as preset...");
            var deletePreset = button("Delete preset");
            left.Children.Add(row(new UIElement[] { savePreset, deletePreset }));

            left.Children.Add(heading("Emotion cues"));
            var directBox = check("Add a cue to lines tagged with how they are said");
            directBox.IsChecked = settings.Direct;
            left.Children.Add(directBox);
            var cueExample = note("“Go,” she whispered  →  whispered, hushed.  Off, the narrator judges emotion from the text alone.");
            cueExample.Margin = new Thickness(22, 0, 0, 4);
            left.Children.Add(cueExample);
            var cueBox = new TextBox { Text = settings.Cue, TextWrapping = TextWrapping.Wrap, Height = 48, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            var cuePanel = new StackPanel();
            cuePanel.Children.Add(cueBox);
            cuePanel.Children.Add(note("Added after the instruction when a line has a cue. {cue} becomes the cue itself."));
            var cueFold = fold("Cue wording", cuePanel);
            cueFold.Margin = new Thickness(22, 2, 0, 2);
            left.Children.Add(cueFold);

            // ---- Try it: its own panel, always in view
            var tryPanel = new DockPanel();
            var tryTop = new StackPanel();
            DockPanel.SetDock(tryTop, Dock.Top);
            tryTop.Children.Add(heading("Try it"));
            tryTop.Children.Add(note("Plays this text with the settings on the left, saved or not, prepared exactly as narration prepares it. One paragraph per line."));
            var sampleBox = new TextBox { Text = _sample, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Height = 120, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            tryTop.Children.Add(sampleBox);
            var useSelection = button("Use text selected in the document");
            useSelection.HorizontalAlignment = HorizontalAlignment.Left;
            useSelection.Margin = new Thickness(0, 6, 0, 10);
            tryTop.Children.Add(useSelection);

            // A and B: what each is, and a Play for each.
            var ab = new Grid { Margin = new Thickness(0, 0, 0, 6) };
            ab.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            ab.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            ab.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            ab.RowDefinitions.Add(new RowDefinition());
            ab.RowDefinitions.Add(new RowDefinition());
            Func<string, TextBlock> slot = t => new TextBlock { Text = t, FontWeight = FontWeights.Bold, FontSize = 15, Width = 24, VerticalAlignment = VerticalAlignment.Center };
            var aSummary = new TextBlock { TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 4, 8, 4) };
            var bSummary = new TextBlock { TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 4, 8, 4), Opacity = 0.72, Text = "Nothing kept yet. Keep A here, change something, then play each." };
            var playA = button("▶ Play A");
            var playB = button("▶ Play B");
            playA.Margin = playB.Margin = new Thickness(0, 3, 0, 3);
            playB.IsEnabled = false;
            Action<UIElement, int, int> put = (el, r, c) => { Grid.SetRow(el, r); Grid.SetColumn(el, c); ab.Children.Add(el); };
            put(slot("A"), 0, 0); put(aSummary, 0, 1); put(playA, 0, 2);
            put(slot("B"), 1, 0); put(bSummary, 1, 1); put(playB, 1, 2);
            tryTop.Children.Add(ab);
            var keepTry = button("Keep A as B");
            var stopTry = button("■ Stop");
            tryTop.Children.Add(row(new UIElement[] { keepTry, stopTry }));

            var toldBox = new TextBox
            {
                IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                FontSize = 11.5, MinHeight = 90, Text = "Play something to see the instruction each paragraph was given."
            };
            var toldFold = fold("What the narrator was told", toldBox);
            toldFold.IsExpanded = true;
            toldFold.Margin = new Thickness(0, 10, 0, 0);
            tryPanel.Children.Add(tryTop);
            tryPanel.Children.Add(toldFold);

            var tryCard = new Border
            {
                Child = tryPanel, Padding = new Thickness(14, 0, 14, 12), CornerRadius = new CornerRadius(6),
                Background = new SolidColorBrush(Color.FromArgb(0x1C, 0x80, 0x80, 0x80)),
                BorderBrush = new SolidColorBrush(Color.FromArgb(0x40, 0x80, 0x80, 0x80)), BorderThickness = new Thickness(1),
                Margin = new Thickness(0, 12, 0, 0)
            };

            var reading = new Grid();
            reading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 360 });
            reading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 360 });
            var leftScroll = scrolling(left);
            Grid.SetColumn(leftScroll, 0);
            Grid.SetColumn(tryCard, 1);
            reading.Children.Add(leftScroll);
            reading.Children.Add(tryCard);

            // ================================================================ Voices
            var lib = new StackPanel();
            lib.Children.Add(heading("Your voices"));
            lib.Children.Add(note("Changes here happen at once; Cancel does not undo them. The voice the narrator uses is chosen on the Reading tab."));
            var libList = new ListBox { Height = 170, MinWidth = 320 };
            var libPlay = button("▶ Play sample");
            var exportVoice = button("Export...");
            var deleteVoice = button("Delete...");
            var importVoice = button("Import...");
            foreach (var b in new[] { libPlay, exportVoice, deleteVoice, importVoice }) { b.Margin = new Thickness(0, 0, 0, 6); b.HorizontalContentAlignment = HorizontalAlignment.Left; }
            var libButtons = new StackPanel { Margin = new Thickness(10, 0, 0, 0), Width = 130 };
            libButtons.Children.Add(libPlay);
            libButtons.Children.Add(exportVoice);
            libButtons.Children.Add(deleteVoice);
            libButtons.Children.Add(new Separator { Margin = new Thickness(0, 4, 0, 10), Opacity = 0.4 });
            libButtons.Children.Add(importVoice);
            var libRow = new DockPanel { Margin = new Thickness(0, 4, 0, 4) };
            DockPanel.SetDock(libButtons, Dock.Right);
            libRow.Children.Add(libButtons);
            libRow.Children.Add(libList);
            lib.Children.Add(libRow);
            var libDesc = note("");
            lib.Children.Add(libDesc);
            lib.Children.Add(note("Export saves a voice as one .tzvoice file wherever you like; Import brings one back, on this PC or another. A designed voice cannot be made again, so export the ones you keep."));

            lib.Children.Add(heading("Design a new voice"));
            lib.Children.Add(note("Describe who they are: age, accent, texture. Three candidates come back, read by the narrator as each would sound; name and keep the one you want. About a minute and a half, and the graphics card is busy meanwhile."));
            var descBox = new TextBox { TextWrapping = TextWrapping.Wrap, AcceptsReturn = false, Height = 48, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            lib.Children.Add(descBox);
            var design = button("Create 3 candidates");
            design.HorizontalAlignment = HorizontalAlignment.Left;
            design.Margin = new Thickness(0, 6, 0, 0);
            lib.Children.Add(design);
            var candidates = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
            lib.Children.Add(candidates);

            // ================================================================ Cast
            var castRows = new List<Tuple<string, string, ComboBox>>();     // key, name, choice
            var castPanel = new StackPanel();
            Button findCast = null;
            StackPanel castPage = null;
            if (!string.IsNullOrEmpty(book))
            {
                castPage = new StackPanel();
                castPage.Children.Add(heading("Cast for this book"));
                castPage.Children.Add(note("Give characters voices of their own; their lines are then spoken in that voice and the narrator reads the rest. Characters left on the narrator's voice stay with the narrator. Who speaks is read from the text (\"said Ferbin\"), so an untagged or ambiguous line stays with the narrator."));
                castPage.Children.Add(note("A character's line is told only: \"Speak this line of dialogue as the character would say it, naturally and in character.\""));
                if (QwenNarrator.PrivateMode)
                    castPage.Children.Add(note("Privacy Mode is on: this book's cast is kept until TypoZen closes and is not saved to disk."));
                findCast = button("Find characters");
                findCast.HorizontalAlignment = HorizontalAlignment.Left;
                findCast.Margin = new Thickness(0, 4, 0, 8);
                castPage.Children.Add(findCast);
                castPage.Children.Add(castPanel);
            }

            // ================================================================ window
            var tabs = new TabControl { Margin = new Thickness(12, 12, 12, 0), Background = win.Background, BorderThickness = new Thickness(0) };
            Func<string, UIElement, TabItem> tab = (title, content) => new TabItem { Header = new TextBlock { Text = title, FontSize = 13 }, Content = page(content), Padding = new Thickness(16, 5, 16, 5) };
            tabs.Items.Add(tab("Reading", reading));
            tabs.Items.Add(tab("Voices", scrolling(lib)));
            if (castPage != null) tabs.Items.Add(tab("Cast for this book", scrolling(castPage)));

            var status = new TextBlock { TextWrapping = TextWrapping.Wrap, Opacity = 0.9, VerticalAlignment = VerticalAlignment.Center };
            var busyBar = new ProgressBar { IsIndeterminate = true, Height = 4, Margin = new Thickness(0, 0, 0, 6), Visibility = Visibility.Collapsed };
            var save = new Button { Content = "Save", Width = 90, Height = 28, IsDefault = true, Margin = new Thickness(0, 0, 8, 0) };
            var cancel = new Button { Content = "Cancel", Width = 90, Height = 28, IsCancel = true };
            var buttons = row(new UIElement[] { save, cancel });
            var footerRow = new DockPanel();
            DockPanel.SetDock(buttons, Dock.Right);
            footerRow.Children.Add(buttons);
            footerRow.Children.Add(status);
            var footer = new StackPanel { Margin = new Thickness(18, 8, 18, 14) };
            footer.Children.Add(busyBar);
            footer.Children.Add(footerRow);
            var outer = new DockPanel();
            DockPanel.SetDock(footer, Dock.Bottom);
            outer.Children.Add(footer);
            outer.Children.Add(tabs);
            if (win.Foreground != null) footer.SetValue(TextElement.ForegroundProperty, win.Foreground);
            win.Content = outer;

            // ================================================================ behaviour
            string busyWhat = null;
            DateTime busySince = DateTime.Now;
            double busyExpect = 0;
            var clock = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            Action showClock = () =>
            {
                if (busyWhat == null) return;
                int s = (int)(DateTime.Now - busySince).TotalSeconds;
                string c = busyExpect <= 0 ? s + "s"
                         : s <= busyExpect ? s + "s of about " + busyExpect + "s"
                         : s + "s, longer than the usual " + busyExpect + "s";
                status.Text = busyWhat + " " + c;
            };
            clock.Tick += (s, e) => showClock();
            // A message from inside a job replaces the running one and stops its clock: the
            // narrator's start-up reports its own seconds.
            Action<string> say = m => win.Dispatcher.BeginInvoke((Action)(() => { busyWhat = null; status.Text = m ?? ""; }));

            Action<string> play = path =>
            {
                try
                {
                    if (player != null) player.Stop();
                    player = new SoundPlayer(path);
                    player.Play();
                }
                catch (Exception ex) { say("Could not play the sample: " + ex.Message); }
            };

            Func<string, ComboBox> voicePicker = selected =>
            {
                var cb = new ComboBox { Width = 250 };
                cb.Items.Add(new VoiceItem { Id = "", Name = "Narrator's voice" });
                foreach (var v in voices) cb.Items.Add(v);
                cb.SelectedIndex = 0;
                for (int i = 1; i < cb.Items.Count; i++) if (((VoiceItem)cb.Items[i]).Id == selected) cb.SelectedIndex = i;
                return cb;
            };

            Action<string, string, string> addCastRow = (key, name, chosen) =>
            {
                foreach (var r in castRows) if (r.Item1 == key) return;
                var cb = voicePicker(chosen);
                castRows.Add(Tuple.Create(key, name, cb));
                var label = new TextBlock { Text = name, Width = 250, VerticalAlignment = VerticalAlignment.Center };
                castPanel.Children.Add(row(new UIElement[] { label, cb }));
            };

            // A voice the library can act on: one of the reader's, not built in.
            Func<VoiceItem, bool> removable = v => v != null && !string.IsNullOrEmpty(v.Preview);
            Action refreshLibButtons = () =>
            {
                var v = libList.SelectedItem as VoiceItem;
                deleteVoice.IsEnabled = exportVoice.IsEnabled = removable(v);
            };

            Action fillVoices = () =>
            {
                string keep = voiceBox.SelectedItem is VoiceItem ? ((VoiceItem)voiceBox.SelectedItem).Id : settings.Voice;
                string keepLib = libList.SelectedItem is VoiceItem ? ((VoiceItem)libList.SelectedItem).Id : keep;
                voiceBox.Items.Clear();
                libList.Items.Clear();
                foreach (var v in voices) { voiceBox.Items.Add(v); libList.Items.Add(v); }
                voiceBox.SelectedIndex = voices.Count > 0 ? 0 : -1;
                libList.SelectedIndex = voices.Count > 0 ? 0 : -1;
                for (int i = 0; i < voices.Count; i++)
                {
                    if (voices[i].Id == keep) voiceBox.SelectedIndex = i;
                    if (voices[i].Id == keepLib) libList.SelectedIndex = i;
                }
                // The cast pickers are rebuilt with the new list, keeping each choice.
                var old = new List<Tuple<string, string, ComboBox>>(castRows);
                castRows.Clear();
                castPanel.Children.Clear();
                foreach (var r in old)
                {
                    var sel = r.Item3.SelectedItem as VoiceItem;
                    addCastRow(r.Item1, r.Item2, sel != null ? sel.Id : "");
                }
                refreshLibButtons();
            };

            Action loadVoices = () =>
            {
                string json = QwenNarrator.Call("GET", "/voices", null, 10000);
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                var list = new List<VoiceItem>();
                foreach (var o in (d["voices"] as System.Collections.IEnumerable) ?? new object[0])
                {
                    var v = o as Dictionary<string, object>;
                    if (v == null) continue;
                    list.Add(new VoiceItem
                    {
                        Id = Convert.ToString(v["id"]),
                        Name = Convert.ToString(v["name"]),
                        Description = Convert.ToString(v["description"]),
                        Preview = Convert.ToString(v["preview"])
                    });
                }
                win.Dispatcher.Invoke((Action)(() => { voices.Clear(); voices.AddRange(list); fillVoices(); }));
            };

            // Anything that needs the narrator goes through here: off the UI thread, with the
            // buttons that would start another such call disabled until it is done.
            var busyButtons = new List<Button> { playVoice, libPlay, deleteVoice, design, importVoice, playA };
            if (findCast != null) busyButtons.Add(findCast);
            // `expect` is the usual time in seconds, shown against a running clock; 0 for none.
            Action<string, double, Action> work = (what, expect, job) =>
            {
                foreach (var b in busyButtons) b.IsEnabled = false;
                playB.IsEnabled = false;
                busyWhat = what; busySince = DateTime.Now; busyExpect = expect;
                busyBar.Visibility = Visibility.Visible;
                showClock();
                clock.Start();
                Task.Run(() =>
                {
                    try { job(); }
                    catch (Exception ex) { say("That did not work: " + ex.Message); }
                    finally
                    {
                        win.Dispatcher.BeginInvoke((Action)(() =>
                        {
                            clock.Stop();
                            busyBar.Visibility = Visibility.Collapsed;
                            if (busyWhat != null) { busyWhat = null; status.Text = ""; }
                            foreach (var b in busyButtons) b.IsEnabled = true;
                            playB.IsEnabled = kept != null;
                            refreshLibButtons();
                        }));
                    }
                });
            };

            // ---- presets: the built-in starting points, then the reader's own
            var presetItems = new List<PresetItem>();
            bool syncing = false;
            Action refreshPresetButtons = () =>
            {
                var sel = presetBox.SelectedItem as PresetItem;
                deletePreset.IsEnabled = sel != null && sel.Mine;
            };
            Action<string> fillPresets = select =>
            {
                presetItems.Clear();
                foreach (var kv in QwenNarrator.BuiltInPresets) presetItems.Add(new PresetItem { Name = kv.Key, Text = kv.Value });
                foreach (var kv in QwenNarrator.LoadPresets(cacheDir)) presetItems.Add(new PresetItem { Name = kv.Key, Text = kv.Value, Mine = true });
                syncing = true;
                presetBox.Items.Clear();
                foreach (var p in presetItems) presetBox.Items.Add(p);
                // The preset the box's text is, if any: which one is in use shows, and an edit
                // shows as no preset rather than as the one it started from.
                string text = instructionBox.Text.Trim();
                presetBox.SelectedItem = presetItems.Find(p => p.Name == select && p.Text.Trim() == text) ?? presetItems.Find(p => p.Text.Trim() == text);
                syncing = false;
                refreshPresetButtons();
            };

            // ---- Try it: A is the settings on screen, B a set kept for comparison
            TaskCompletionSource<string> pendingTrial = null;
            Func<Trial> current = () =>
            {
                var v = voiceBox.SelectedItem as VoiceItem;
                var p = presetBox.SelectedItem as PresetItem;
                string instr = instructionBox.Text.Trim();
                string words = instr.Length == 0 ? "no instruction"
                             : p != null ? "the " + p.Name + " instruction"
                             : "your own instruction";
                return new Trial
                {
                    Voice = v != null ? v.Id : settings.Voice,
                    VoiceName = v != null ? v.Name : "the narrator's voice",
                    Instruction = instr,
                    Cue = cueBox.Text.Trim().Length > 0 ? cueBox.Text.Trim() : QwenNarrator.DefaultCue,
                    Direct = directBox.IsChecked == true,
                    Label = (v != null ? v.Name : "Narrator's voice") + ", " + words + ", cues " + (directBox.IsChecked == true ? "on" : "off")
                };
            };
            Action updateA = () => { aSummary.Text = current().Label; };

            presetBox.SelectionChanged += (s, e) =>
            {
                refreshPresetButtons();
                var p = presetBox.SelectedItem as PresetItem;
                if (syncing || p == null) return;
                syncing = true;
                instructionBox.Text = p.Text;
                syncing = false;
                updateA();
            };
            instructionBox.TextChanged += (s, e) =>
            {
                if (!syncing)
                {
                    var p = presetBox.SelectedItem as PresetItem;
                    string text = instructionBox.Text.Trim();
                    if (p == null || p.Text.Trim() != text)
                    {
                        syncing = true;
                        presetBox.SelectedItem = presetItems.Find(x => x.Text.Trim() == text);
                        syncing = false;
                        refreshPresetButtons();
                    }
                }
                updateA();
            };
            directBox.Checked += (s, e) => updateA();
            directBox.Unchecked += (s, e) => updateA();
            cueBox.TextChanged += (s, e) => updateA();
            voiceBox.SelectionChanged += (s, e) =>
            {
                var v = voiceBox.SelectedItem as VoiceItem;
                voiceDesc.Text = v != null ? v.Description : "";
                updateA();
            };
            libList.SelectionChanged += (s, e) =>
            {
                var v = libList.SelectedItem as VoiceItem;
                libDesc.Text = v != null ? v.Description : "";
                refreshLibButtons();
            };

            // Asks for one line of text in a small window of its own; null if cancelled.
            Func<string, string, string, string> ask = (title, prompt, initial) =>
            {
                var w = new Window
                {
                    Title = title, Width = 380, SizeToContent = SizeToContent.Height, ResizeMode = ResizeMode.NoResize,
                    WindowStartupLocation = WindowStartupLocation.CenterOwner, ShowInTaskbar = false, Owner = win,
                    Background = win.Background, Foreground = win.Foreground
                };
                var box = new TextBox { Text = initial ?? "", Margin = new Thickness(0, 6, 0, 12), Height = 26, VerticalContentAlignment = VerticalAlignment.Center };
                var ok = new Button { Content = "OK", Width = 80, Height = 26, IsDefault = true, Margin = new Thickness(0, 0, 8, 0) };
                var no = new Button { Content = "Cancel", Width = 80, Height = 26, IsCancel = true };
                ok.Click += (s, e) => w.DialogResult = true;
                var panel = new StackPanel { Margin = new Thickness(16) };
                panel.Children.Add(new TextBlock { Text = prompt, TextWrapping = TextWrapping.Wrap });
                panel.Children.Add(box);
                var br = row(new UIElement[] { ok, no });
                br.HorizontalAlignment = HorizontalAlignment.Right;
                panel.Children.Add(br);
                w.Content = panel;
                w.Loaded += (s, e) => { box.Focus(); box.SelectAll(); };
                return w.ShowDialog() == true ? box.Text.Trim() : null;
            };

            savePreset.Click += (s, e) =>
            {
                var sel = presetBox.SelectedItem as PresetItem;
                string name = ask("Save as preset", "A name for this instruction. Saving under the name of one of your presets replaces it.", sel != null && sel.Mine ? sel.Name : "");
                if (name == null) return;
                if (name.Length == 0) { say("A preset needs a name."); return; }
                foreach (var kv in QwenNarrator.BuiltInPresets)
                    if (string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase)) { say("\"" + kv.Key + "\" is a built-in preset; choose another name."); return; }
                try
                {
                    var mine = QwenNarrator.LoadPresets(cacheDir);
                    int at = mine.FindIndex(kv => string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase));
                    var entry = new KeyValuePair<string, string>(name, instructionBox.Text.Trim());
                    if (at >= 0) mine[at] = entry; else mine.Add(entry);
                    QwenNarrator.SavePresets(cacheDir, mine);
                    fillPresets(name);
                    updateA();
                    say((at >= 0 ? "Updated" : "Saved") + " the preset \"" + name + "\".");
                }
                catch (Exception ex) { say("Could not save the preset: " + ex.Message); }
            };
            deletePreset.Click += (s, e) =>
            {
                var p = presetBox.SelectedItem as PresetItem;
                if (p == null || !p.Mine) return;
                if (MessageBox.Show(win, "Delete the preset \"" + p.Name + "\"? The instruction in the box stays as it is.", "Narrator",
                                    MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
                try
                {
                    var mine = QwenNarrator.LoadPresets(cacheDir);
                    mine.RemoveAll(kv => kv.Key == p.Name);
                    QwenNarrator.SavePresets(cacheDir, mine);
                    fillPresets(null);
                    updateA();
                    say("Deleted the preset \"" + p.Name + "\".");
                }
                catch (Exception ex) { say("Could not delete the preset: " + ex.Message); }
            };
            fillPresets(null);

            // The page prepares and plays the text (narrationTrial, 09-speech.js), so it goes
            // through what narration does; this side chooses the settings and shows what the
            // narrator was told.
            Action<Trial, string> runTrial = (t, which) =>
            {
                string text = sampleBox.Text;
                if (text.Trim().Length == 0) { say("Type or paste something to read first."); return; }
                _sample = text;
                string json = new JavaScriptSerializer().Serialize(new Dictionary<string, object>
                {
                    { "base", QwenNarrator.BaseUrl }, { "text", text }, { "voice", t.Voice },
                    { "instruction", t.Instruction }, { "cue", t.Cue }, { "direct", t.Direct }
                });
                work("Preparing " + which + ":", 15, () =>
                {
                    bool up = QwenNarrator.EnsureRunning(cacheDir, appDir, m => { }, CancellationToken.None).Result;
                    if (!up) { say("The narrator is not running, so nothing can be tried now."); return; }
                    var tcs = new TaskCompletionSource<string>();
                    pendingTrial = tcs;
                    win.Dispatcher.Invoke((Action)(() => sendToPage("cmd:narrator_trial:" + json)));
                    if (!tcs.Task.Wait(180000))
                    {
                        win.Dispatcher.Invoke((Action)(() => sendToPage("cmd:narrator_trial_stop")));
                        say("No answer after three minutes; stopped.");
                        return;
                    }
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(tcs.Task.Result);
                    string kind = Convert.ToString(d["kind"]);
                    if (kind == "error") { say("That did not work: " + Convert.ToString(d["message"])); return; }
                    if (kind != "ready") { say(""); return; }
                    var sb = new System.Text.StringBuilder();
                    sb.Append(which).Append(": ").Append(t.Label).Append("\r\n\r\n");
                    string last = null;
                    double secs = 0;
                    int n = 0;
                    foreach (var o in (d["pieces"] as System.Collections.IEnumerable) ?? new object[0])
                    {
                        var piece = (Dictionary<string, object>)o;
                        string ptext = Convert.ToString(piece["text"]), cue = Convert.ToString(piece["cue"]), ins = Convert.ToString(piece["instruction"]);
                        secs += Convert.ToDouble(piece["seconds"]);
                        sb.Append(++n).Append(". ").Append(ptext.Length > 60 ? ptext.Substring(0, 60) + "..." : ptext);
                        if (cue.Length > 0) sb.Append("   [cue: ").Append(cue).Append("]");
                        sb.Append("\r\n    ").Append(ins == last ? "(the same as above)" : ins.Length == 0 ? "(no instruction)" : ins).Append("\r\n");
                        last = ins;
                    }
                    win.Dispatcher.Invoke((Action)(() => toldBox.Text = sb.ToString()));
                    say("Playing " + which + " (" + secs.ToString("0") + "s).");
                });
            };
            playA.Click += (s, e) => runTrial(current(), "A");
            playB.Click += (s, e) => { if (kept != null) runTrial(kept, "B"); };
            stopTry.Click += (s, e) =>
            {
                sendToPage("cmd:narrator_trial_stop");
                var p = pendingTrial;
                if (p != null) p.TrySetResult("{\"kind\":\"stopped\"}");
                say("");
            };
            keepTry.Click += (s, e) =>
            {
                kept = current();
                bSummary.Text = kept.Label;
                bSummary.Opacity = 1;
                playB.IsEnabled = playA.IsEnabled;
                say("A is kept as B. Change anything on the left, then play A and B in turn.");
            };
            useSelection.Click += (s, e) => sendToPage("cmd:narrator_trial_selection");
            TrialArrived = json =>
            {
                try
                {
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                    string kind = Convert.ToString(d["kind"]);
                    if (kind == "selection")
                    {
                        string t = Convert.ToString(d["text"]).Trim();
                        win.Dispatcher.BeginInvoke((Action)(() =>
                        {
                            if (t.Length == 0) { status.Text = "Select some text in the document first, then press this again."; return; }
                            sampleBox.Text = t.Length > 3000 ? t.Substring(0, 3000) : t;
                            status.Text = t.Length > 3000 ? "The selection is long; its first 3000 characters are in the box." : "";
                        }));
                    }
                    else if (kind == "ended") say("");
                    else { var p = pendingTrial; if (p != null) p.TrySetResult(json); }
                }
                catch { }
            };

            // ---- the library
            // A kept voice plays the recording that was picked -- the same take heard as its
            // candidate. Rendering a fresh one here, with whatever style was in the box, is
            // what made "the voice I picked" sound like someone else (2026-09-23).
            Action<VoiceItem> playSample = v =>
            {
                if (v != null && !string.IsNullOrEmpty(v.Preview) && System.IO.File.Exists(v.Preview)) { play(v.Preview); return; }
                string id = v != null ? v.Id : "";
                work("Rendering a sample in this voice:", 15, () =>
                {
                    string json = QwenNarrator.Call("POST", "/preview", new JavaScriptSerializer().Serialize(
                        new Dictionary<string, object> { { "voice", id }, { "style", "" } }), 120000);
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                    win.Dispatcher.Invoke((Action)(() => play(Convert.ToString(d["file"]))));
                    say("");
                });
            };
            playVoice.Click += (s, e) => playSample(voiceBox.SelectedItem as VoiceItem);
            libPlay.Click += (s, e) => playSample(libList.SelectedItem as VoiceItem);

            deleteVoice.Click += (s, e) =>
            {
                var v = libList.SelectedItem as VoiceItem;
                if (!removable(v)) return;
                if (MessageBox.Show(win, "Delete the voice \"" + v.Name + "\"? It goes to the Recycle Bin, "
                                    + "so it can be restored from there; copies you exported are not touched. Characters using it go back to the narrator's voice.",
                                    "Narrator", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
                string id = v.Id;
                work("Deleting...", 0, () =>
                {
                    QwenNarrator.Call("POST", "/voices/delete", new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "id", id } }), 10000);
                    loadVoices();
                    say("Deleted \"" + v.Name + "\".");
                });
            };

            // Export is the voice's own folder in one zip, written aside and moved into place so a
            // failed write never leaves half a file where the reader chose to keep their voice.
            exportVoice.Click += (s, e) =>
            {
                var v = libList.SelectedItem as VoiceItem;
                if (!removable(v)) return;
                string dir = System.IO.Path.GetDirectoryName(v.Preview);
                string file = v.Name;
                foreach (char c in System.IO.Path.GetInvalidFileNameChars()) file = file.Replace(c, '-');
                var dlg = new Microsoft.Win32.SaveFileDialog
                {
                    Title = "Export voice",
                    FileName = file + ".tzvoice",
                    DefaultExt = ".tzvoice",
                    Filter = "TypoZen voice (*.tzvoice)|*.tzvoice"
                };
                if (dlg.ShowDialog(win) != true) return;
                string target = dlg.FileName, part = target + ".part";
                try
                {
                    if (System.IO.File.Exists(part)) System.IO.File.Delete(part);
                    using (var z = System.IO.Compression.ZipFile.Open(part, System.IO.Compression.ZipArchiveMode.Create))
                        foreach (string f in new[] { "print.npy", "meta.json", "preview.wav", "design.wav" })
                        {
                            string p = System.IO.Path.Combine(dir, f);
                            if (System.IO.File.Exists(p)) System.IO.Compression.ZipFileExtensions.CreateEntryFromFile(z, p, f);
                        }
                    if (System.IO.File.Exists(target)) System.IO.File.Delete(target);
                    System.IO.File.Move(part, target);
                    say("Exported \"" + v.Name + "\" to " + target + ".");
                }
                catch (Exception ex)
                {
                    try { System.IO.File.Delete(part); } catch { }
                    say("Could not export the voice: " + ex.Message);
                }
            };

            // Import is the narrator's: it checks the voice-print is a real one before keeping it.
            importVoice.Click += (s, e) =>
            {
                var dlg = new Microsoft.Win32.OpenFileDialog
                {
                    Title = "Import voices",
                    Multiselect = true,
                    Filter = "Saved voices (*.tzvoice, or print.npy in a voice folder)|*.tzvoice;print.npy"
                };
                if (dlg.ShowDialog(win) != true) return;
                string[] files = dlg.FileNames;
                work("Importing...", 0, () =>
                {
                    // The narrator's voice is left as it is: selecting what was imported would make
                    // it the narrator's voice at the next Save, which nobody asked for.
                    var said = new List<string>();
                    foreach (string f in files)
                    {
                        try
                        {
                            var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                                QwenNarrator.Call("POST", "/voices/import", new JavaScriptSerializer().Serialize(
                                    new Dictionary<string, object> { { "path", f } }), 30000));
                            string nm = Convert.ToString(d["name"]);
                            said.Add(d["already"] is bool && (bool)d["already"]
                                ? "\"" + nm + "\" is already installed"
                                : "imported \"" + nm + "\"");
                        }
                        catch (Exception ex) { said.Add(System.IO.Path.GetFileName(f) + ": " + ex.Message); }
                    }
                    loadVoices();
                    string all = string.Join("; ", said.ToArray());
                    bool any = said.Exists(x => x.StartsWith("imported"));
                    say(all.Substring(0, 1).ToUpper() + all.Substring(1) + "."
                        + (any ? " Choose it on the Reading tab, or for a character on Cast." : ""));
                });
            };

            design.Click += (s, e) =>
            {
                string desc = descBox.Text.Trim();
                if (desc.Length == 0) { say("Describe the voice first."); return; }
                candidates.Children.Clear();
                // Candidates are made with no style: what you hear is the voice itself, exactly
                // as narration will use it with the standard reading.
                string style = "";
                work("Creating three candidates from your description. The graphics card is busy meanwhile.", 90, () =>
                {
                    string json = QwenNarrator.Call("POST", "/design", new JavaScriptSerializer().Serialize(
                        new Dictionary<string, object> { { "description", desc }, { "count", 3 }, { "style", style } }), 300000);
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                    var list = (d["candidates"] as System.Collections.IEnumerable) ?? new object[0];
                    win.Dispatcher.Invoke((Action)(() =>
                    {
                        int n = 0;
                        foreach (var o in list)
                        {
                            var c = (Dictionary<string, object>)o;
                            string cid = Convert.ToString(c["candidate"]), path = Convert.ToString(c["preview"]);
                            n++;
                            var label = new TextBlock { Text = "Candidate " + n, Width = 90, VerticalAlignment = VerticalAlignment.Center };
                            var p = button("▶ Play");
                            p.Click += (s2, e2) => play(path);
                            var name = new TextBox { Width = 200, Margin = new Thickness(0, 0, 6, 0), VerticalContentAlignment = VerticalAlignment.Center };
                            var k = button("Keep");
                            k.Click += (s2, e2) =>
                            {
                                string nm = name.Text.Trim();
                                if (nm.Length == 0) { say("Give the voice a name first."); return; }
                                // Once only: a double click kept the same candidate twice.
                                k.IsEnabled = false;
                                name.IsEnabled = false;
                                work("Keeping \"" + nm + "\"...", 0, () =>
                                {
                                    QwenNarrator.Call("POST", "/voices/keep", new JavaScriptSerializer().Serialize(
                                        new Dictionary<string, object> { { "candidate", cid }, { "name", nm } }), 10000);
                                    loadVoices();
                                    say("Kept \"" + nm + "\". Choose it on the Reading tab, or for a character on Cast. "
                                        + "Export it to keep a copy of your own.");
                                });
                            };
                            candidates.Children.Add(row(new UIElement[] { label, p, name, k }));
                        }
                    }));
                    say("Three candidates, read by the narrator as each would sound. Play them, then name and keep the one you want.");
                });
            };

            // ---- cast
            if (findCast != null)
            {
                findCast.Click += (s, e) =>
                {
                    say("Looking for who speaks in this book...");
                    sendToPage("cmd:narrator_cast_scan");
                };
                CastScanArrived = json =>
                {
                    win.Dispatcher.BeginInvoke((Action)(() =>
                    {
                        try
                        {
                            var list = new JavaScriptSerializer().Deserialize<List<Dictionary<string, object>>>(json);
                            int shown = 0;
                            foreach (var c in list)
                            {
                                if (shown++ >= 30) break;
                                string key = Convert.ToString(c["key"]);
                                string name = Convert.ToString(c["name"]) + "  (" + Convert.ToString(c["lines"]) + " lines)";
                                string chosen;
                                addCastRow(key, name, cast.Voices.TryGetValue(key, out chosen) ? chosen : "");
                            }
                            say(list.Count == 0 ? "No named speakers found in the part of the book that is loaded."
                                                : "The most frequent speakers in the loaded part of the book. Give voices to the ones you want.");
                        }
                        catch (Exception ex) { say("Could not read the character list: " + ex.Message); }
                    }));
                };
            }

            save.Click += (s, e) =>
            {
                try
                {
                    var v = voiceBox.SelectedItem as VoiceItem;
                    settings.Voice = v != null ? v.Id : settings.Voice;
                    settings.Instruction = instructionBox.Text.Trim();
                    settings.Cue = cueBox.Text.Trim().Length > 0 ? cueBox.Text.Trim() : QwenNarrator.DefaultCue;
                    settings.Direct = directBox.IsChecked == true;
                    QwenNarrator.SaveSettings(cacheDir, settings);
                    foreach (var r in castRows)
                    {
                        var sel = r.Item3.SelectedItem as VoiceItem;
                        if (sel != null && sel.Id.Length > 0) { cast.Voices[r.Item1] = sel.Id; cast.Names[r.Item1] = r.Item2; }
                        else { cast.Voices.Remove(r.Item1); cast.Names.Remove(r.Item1); }
                    }
                    QwenNarrator.SaveCast(cacheDir, book, cast);
                    if (saved != null) saved();
                    win.DialogResult = true;
                }
                catch (Exception ex) { say("Could not save: " + ex.Message); }
            };

            // Saved cast rows show at once, before any scan.
            foreach (var kv in cast.Voices)
            {
                string name;
                addCastRow(kv.Key, cast.Names.TryGetValue(kv.Key, out name) ? name : kv.Key, kv.Value);
            }

            // The saved voices are on disk: list them now, so the choice is there while the
            // narrator loads. The narrator's own list replaces this once it is up.
            foreach (var v in QwenNarrator.SavedVoices(cacheDir))
            {
                string dir = System.IO.Path.Combine(QwenNarrator.RootDir(cacheDir), "voices", v.Key);
                string prev = System.IO.Path.Combine(dir, "preview.wav");
                object d;
                var meta = QwenNarrator.ReadJson(System.IO.Path.Combine(dir, "meta.json"));
                var model = Array.Find(QwenNarrator.ModelSpeakers, m => m[0] == v.Key);
                voices.Add(new VoiceItem
                {
                    Id = v.Key, Name = v.Value,
                    Description = meta.TryGetValue("description", out d) ? Convert.ToString(d)
                                : v.Key == QwenNarrator.DefaultVoiceId ? QwenNarrator.DefaultVoiceDescription
                                : model != null ? model[2] : "",
                    Preview = System.IO.File.Exists(prev) ? prev : ""
                });
            }
            fillVoices();
            updateA();

            // The narrator is needed for everything else here: start it (a no-op when it is up), then list the voices.
            if (start)
                work("Starting the narrator...", 0, () =>
                {
                    bool up = QwenNarrator.EnsureRunning(cacheDir, appDir, m => { if (!string.IsNullOrEmpty(m)) say(m); }, CancellationToken.None).Result;
                    if (!up) { say("The narrator did not start, so nothing here can be changed now."); return; }
                    loadVoices();
                    say("");
                });

            win.Closed += (s, e) =>
            {
                CastScanArrived = null;
                TrialArrived = null;
                _sample = sampleBox.Text;
                try { sendToPage("cmd:narrator_trial_stop"); } catch { }
                var p = pendingTrial;
                if (p != null) p.TrySetResult("{\"kind\":\"stopped\"}");
                try { if (player != null) player.Stop(); } catch { }
            };
            return win;
        }
    }
}
