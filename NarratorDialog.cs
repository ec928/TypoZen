using System;
using System.Collections.Generic;
using System.Media;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;

namespace TypoZen
{
    /// <summary>
    /// File > Read Aloud > Narrator settings.
    ///
    /// Three tabs, by how often each is used. Reading holds what shapes every narration -- the
    /// voice, the whole instruction, emotion cues -- on the left, and Try it on the right, always
    /// in view, so a change is made and heard without scrolling: Current plays the settings on
    /// screen, Previous the last different ones played, each labelled with what it is. Voices is the library (play,
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

        /// <summary>The last Build's Voices window, unshown: for rendering its layout to check it.</summary>
        internal static Func<Window> VoicesWindowForTest;

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
            // Which rendering of these settings: take 1 is narration's own (seed 1234); each
            // further take is another seed, so one take can be told from the settings' effect.
            public int Take = 1;
            public int Seed { get { return 1234 + Take - 1; } }
            public string Describe() { return Label + ", take " + Take; }
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
            Trial kept = null;              // Try it: Previous, the last different settings played
            string playing = null;          // Try it: "Current" or "Previous" while one is preparing or playing
            Action applyPlay = null;        // shows that row's Play as Stop; set once the buttons exist

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

            // ---- building blocks. Spacing is on one grid: 4 within a group, 8 between controls,
            // 16 between sections and at the edges.
            Func<string, TextBlock> heading = t => new TextBlock { Text = t, FontWeight = FontWeights.SemiBold, FontSize = 13.5, Margin = new Thickness(0, 16, 0, 4) };
            Func<string, TextBlock> note = t => new TextBlock { Text = t, TextWrapping = TextWrapping.Wrap, Opacity = 0.72, Margin = new Thickness(0, 0, 0, 8) };
            Func<string, Button> button = t => new Button { Content = t, Padding = new Thickness(12, 2, 12, 2), Height = 28, Margin = new Thickness(0, 0, 8, 0) };
            // The action a section exists for -- Save, Play -- in the accent colour, so the eye
            // finds it first. A template of its own: the system one repaints the background pale
            // on hover, which would leave white text unreadable.
            var accent = new SolidColorBrush(Color.FromRgb(0x2F, 0x6B, 0xD6));
            Func<string, Button> primary = t =>
            {
                var b = button(t);
                b.Foreground = Brushes.White;
                b.FontWeight = FontWeights.SemiBold;
                var tpl = new ControlTemplate(typeof(Button));
                var bd = new FrameworkElementFactory(typeof(Border), "bd");
                bd.SetValue(Border.BackgroundProperty, accent);
                bd.SetValue(Border.CornerRadiusProperty, new CornerRadius(3));
                bd.SetValue(Border.PaddingProperty, new Thickness(12, 2, 12, 2));
                var cp = new FrameworkElementFactory(typeof(ContentPresenter));
                cp.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
                cp.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
                bd.AppendChild(cp);
                tpl.VisualTree = bd;
                var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
                hover.Setters.Add(new Setter(Border.BackgroundProperty, new SolidColorBrush(Color.FromRgb(0x43, 0x7E, 0xE6)), "bd"));
                var down = new Trigger { Property = System.Windows.Controls.Primitives.ButtonBase.IsPressedProperty, Value = true };
                down.Setters.Add(new Setter(Border.BackgroundProperty, new SolidColorBrush(Color.FromRgb(0x24, 0x57, 0xB3)), "bd"));
                var off = new Trigger { Property = UIElement.IsEnabledProperty, Value = false };
                off.Setters.Add(new Setter(UIElement.OpacityProperty, 0.45, "bd"));
                tpl.Triggers.Add(hover); tpl.Triggers.Add(down); tpl.Triggers.Add(off);
                b.Template = tpl;
                b.Cursor = Cursors.Hand;
                return b;
            };
            Func<UIElement[], StackPanel> row = items =>
            {
                var p = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 4) };
                foreach (var i in items) p.Children.Add(i);
                return p;
            };
            // A tab's content in the window's own colours: the tab strip keeps the system look,
            // the page under it matches TypoZen's theme.
            Func<UIElement, Border> page = content =>
            {
                var b = new Border { Child = content, Padding = new Thickness(16, 4, 16, 16), Background = win.Background };
                if (win.Foreground != null) b.SetValue(TextElement.ForegroundProperty, win.Foreground);
                return b;
            };
            Func<UIElement, ScrollViewer> scrolling = content => new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
            Func<string, UIElement, Expander> fold = (title, content) =>
            {
                var x = new Expander { Header = new TextBlock { Text = title, FontWeight = FontWeights.SemiBold }, Content = content, Margin = new Thickness(0, 8, 0, 4) };
                if (win.Foreground != null) x.Foreground = win.Foreground;
                return x;
            };
            Func<string, CheckBox> check = t => { var c = new CheckBox { Content = t, Margin = new Thickness(0, 2, 0, 2) }; if (win.Foreground != null) c.Foreground = win.Foreground; return c; };

            // ================================================================ Reading
            var left = new StackPanel { Margin = new Thickness(0, 0, 16, 0) };

            left.Children.Add(heading("Voice"));
            var voiceBox = new ComboBox { MinWidth = 220 };
            var playVoice = button("▶ Sample");
            playVoice.ToolTip = "The recording made when this voice was designed";
            // The library acts at once, so it has a window of its own with Close, not Save/Cancel.
            var manageVoices = button("Manage voices...");
            manageVoices.ToolTip = "Design, import, export or delete voices";
            var voiceRow = new DockPanel { Margin = new Thickness(0, 4, 0, 4) };
            DockPanel.SetDock(manageVoices, Dock.Right);
            DockPanel.SetDock(playVoice, Dock.Right);
            playVoice.Margin = new Thickness(8, 0, 0, 0);
            manageVoices.Margin = new Thickness(8, 0, 0, 0);
            voiceRow.Children.Add(manageVoices);
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
            var instructionCell = new Grid { Margin = new Thickness(0, 8, 0, 8) };
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
            var cueExample = note("“Go,” she whispered  →  the standing instruction, then whispered.  Off, only the standing instruction is sent.");
            cueExample.Margin = new Thickness(22, 0, 0, 4);
            left.Children.Add(cueExample);
            var cueBox = new TextBox { Text = settings.Cue, TextWrapping = TextWrapping.Wrap, Height = 48, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            var cuePanel = new StackPanel();
            cuePanel.Children.Add(cueBox);
            cuePanel.Children.Add(note("Added after the instruction when a line has a cue. {cue} becomes the cue itself."));
            // The original wording is always one click away, so trying another loses nothing.
            var restoreCue = button("Restore default wording");
            restoreCue.HorizontalAlignment = HorizontalAlignment.Left;
            restoreCue.Click += (s, e) => cueBox.Text = QwenNarrator.DefaultCue;
            Action refreshRestore = () => restoreCue.IsEnabled = cueBox.Text.Trim() != QwenNarrator.DefaultCue;
            cueBox.TextChanged += (s, e) => refreshRestore();
            refreshRestore();
            cuePanel.Children.Add(restoreCue);
            var cueFold = fold("Cue wording", cuePanel);
            cueFold.Margin = new Thickness(22, 2, 0, 2);
            left.Children.Add(cueFold);

            // ---- Try it: its own panel, always in view
            var tryPanel = new DockPanel();
            var tryTop = new StackPanel();
            DockPanel.SetDock(tryTop, Dock.Top);
            tryTop.Children.Add(heading("Try it"));
            tryTop.Children.Add(note("Plays this text with the settings on the left, saved or not, exactly as narration would. One paragraph per line; Ctrl+Enter plays."));
            var sampleBox = new TextBox { Text = _sample, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Height = 120, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            tryTop.Children.Add(sampleBox);
            var useSelection = button("Use text selected in the document");
            useSelection.HorizontalAlignment = HorizontalAlignment.Left;
            useSelection.Margin = new Thickness(0, 8, 0, 8);
            tryTop.Children.Add(useSelection);

            // Current and Previous: what each is, and a Play for each. Previous fills itself -- the
            // last different settings played -- so comparing is play, change, play, then switch.
            // ("Keep A as B", a step of its own, was not understood.)
            var ab = new Grid { Margin = new Thickness(0, 0, 0, 6) };
            ab.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            ab.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            ab.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            ab.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            ab.RowDefinitions.Add(new RowDefinition());
            ab.RowDefinitions.Add(new RowDefinition());
            Func<string, TextBlock> slot = t => new TextBlock { Text = t, FontWeight = FontWeights.SemiBold, Width = 70, VerticalAlignment = VerticalAlignment.Center };
            var aSummary = new TextBlock { TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 4, 8, 4) };
            var bSummary = new TextBlock { TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 4, 8, 4), Opacity = 0.72, Text = "Play, change something on the left, and play again: what you heard before appears here." };
            var playA = button("▶ Play");
            var playB = button("▶ Play");
            var takeA = button("↻ New take");
            var takeB = button("↻ New take");
            takeA.ToolTip = takeB.ToolTip = "The same settings rendered afresh, so a setting's effect can be told from one take's luck. Narration uses take 1.";
            playA.Margin = playB.Margin = new Thickness(0, 4, 8, 4);
            takeA.Margin = takeB.Margin = new Thickness(0, 4, 0, 4);
            playA.MinWidth = playB.MinWidth = 76;
            playB.IsEnabled = takeB.IsEnabled = false;
            Action<UIElement, int, int> put = (el, r, c) => { Grid.SetRow(el, r); Grid.SetColumn(el, c); ab.Children.Add(el); };
            put(slot("Current"), 0, 0); put(aSummary, 0, 1); put(playA, 0, 2); put(takeA, 0, 3);
            put(slot("Previous"), 1, 0); put(bSummary, 1, 1); put(playB, 1, 2); put(takeB, 1, 3);
            tryTop.Children.Add(ab);
            // No Stop of its own: the Play of whichever row is preparing or playing becomes
            // Stop (applyPlay), where the eye and the pointer already are.

            var toldBox = new TextBox
            {
                IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                FontSize = 11.5, MinHeight = 90, Text = "Play something to see the instruction each paragraph was given."
            };
            var toldFold = fold("What the narrator was told", toldBox);
            toldFold.IsExpanded = true;
            toldFold.Margin = new Thickness(0, 8, 0, 0);
            tryPanel.Children.Add(tryTop);
            tryPanel.Children.Add(toldFold);

            var tryCard = new Border
            {
                Child = tryPanel, Padding = new Thickness(16, 0, 16, 16), CornerRadius = new CornerRadius(6),
                Background = new SolidColorBrush(Color.FromArgb(0x1C, 0x80, 0x80, 0x80)),
                BorderBrush = new SolidColorBrush(Color.FromArgb(0x40, 0x80, 0x80, 0x80)), BorderThickness = new Thickness(1),
                Margin = new Thickness(0, 16, 0, 0)
            };

            var reading = new Grid();
            reading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 360 });
            reading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 360 });
            var leftScroll = scrolling(left);
            Grid.SetColumn(leftScroll, 0);
            Grid.SetColumn(tryCard, 1);
            reading.Children.Add(leftScroll);
            reading.Children.Add(tryCard);

            // ================================================================ Voices (own window)
            // Everything here acts at once -- a deleted voice goes to the Recycle Bin there and
            // then -- so it lives in a window with Close, not beside Save and Cancel.
            var lib = new StackPanel();
            lib.Children.Add(heading("Your voices"));
            var libList = new ListBox { Height = 180, MinWidth = 320 };
            var libPlay = button("▶ Play sample");
            var exportVoice = button("Export...");
            var deleteVoice = button("Delete...");
            var importVoice = button("Import...");
            foreach (var b in new[] { libPlay, exportVoice, deleteVoice, importVoice }) { b.Margin = new Thickness(0, 0, 0, 8); b.HorizontalContentAlignment = HorizontalAlignment.Left; }
            var libButtons = new StackPanel { Margin = new Thickness(8, 0, 0, 0), Width = 132 };
            libButtons.Children.Add(libPlay);
            libButtons.Children.Add(exportVoice);
            libButtons.Children.Add(deleteVoice);
            libButtons.Children.Add(new Separator { Margin = new Thickness(0, 0, 0, 8), Opacity = 0.4 });
            libButtons.Children.Add(importVoice);
            var libRow = new DockPanel { Margin = new Thickness(0, 4, 0, 4) };
            DockPanel.SetDock(libButtons, Dock.Right);
            libRow.Children.Add(libButtons);
            libRow.Children.Add(libList);
            lib.Children.Add(libRow);
            var libDesc = note("");
            lib.Children.Add(libDesc);
            lib.Children.Add(note("Export saves a voice as one .tzvoice file; Import brings one back. A designed voice cannot be made again, so export the ones you keep."));

            lib.Children.Add(heading("Design a new voice"));
            lib.Children.Add(note("Describe who they are: age, accent, texture. Three candidates come back; name and keep the one you want. About a minute and a half."));
            var descBox = new TextBox { TextWrapping = TextWrapping.Wrap, AcceptsReturn = false, Height = 48, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            lib.Children.Add(descBox);
            var design = primary("Create 3 candidates");
            design.HorizontalAlignment = HorizontalAlignment.Left;
            design.Margin = new Thickness(0, 8, 0, 0);
            lib.Children.Add(design);
            var candidates = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
            lib.Children.Add(candidates);
            var libStatus = new TextBlock { TextWrapping = TextWrapping.Wrap, Opacity = 0.9, VerticalAlignment = VerticalAlignment.Center };
            var libBusy = new ProgressBar { IsIndeterminate = true, Height = 4, Margin = new Thickness(0, 0, 0, 8), Visibility = Visibility.Collapsed };

            // ================================================================ Cast
            var castRows = new List<Tuple<string, string, ComboBox, TextBox>>();     // key, name, voice, instruction
            var castPlays = new List<Button>();
            var castPanel = new StackPanel();
            Button findCast = null;
            StackPanel castPage = null;
            if (!string.IsNullOrEmpty(book))
            {
                castPage = new StackPanel();
                castPage.Children.Add(heading("Cast for this book"));
                castPage.Children.Add(note("Give characters voices of their own: their lines are spoken in that voice, and the narrator reads the rest. Who speaks is read from the text (\"said Ferbin\"); an untagged or ambiguous line stays with the narrator."));
                castPage.Children.Add(note("Instruction is optional. When it is filled in, that character's lines are told it, the same way the narrator's instruction is told to the narration. Leave it empty and the line is told only to speak in character."));
                if (QwenNarrator.PrivateMode)
                    castPage.Children.Add(note("Privacy Mode is on: this book's cast is kept until TypoZen closes and is not saved to disk."));
                findCast = button("Find characters");
                findCast.HorizontalAlignment = HorizontalAlignment.Left;
                findCast.Margin = new Thickness(0, 0, 0, 8);
                castPage.Children.Add(findCast);
                castPage.Children.Add(row(new UIElement[] {
                    new TextBlock { Width = 28, Margin = new Thickness(0, 0, 8, 0) },
                    new TextBlock { Text = "Character", Width = 200, Opacity = 0.7 },
                    new TextBlock { Text = "Voice", Width = 220, Margin = new Thickness(8, 0, 0, 0), Opacity = 0.7 },
                    new TextBlock { Text = "Instruction", Width = 420, Margin = new Thickness(8, 0, 0, 0), Opacity = 0.7 }
                }));
                castPage.Children.Add(castPanel);
            }

            // ================================================================ window
            var tabs = new TabControl { Margin = new Thickness(16, 16, 16, 0), Background = win.Background, BorderThickness = new Thickness(0) };
            Func<string, UIElement, TabItem> tab = (title, content) => new TabItem { Header = new TextBlock { Text = title, FontSize = 13 }, Content = page(content), Padding = new Thickness(16, 4, 16, 4) };
            tabs.Items.Add(tab("Reading", reading));
            if (castPage != null) tabs.Items.Add(tab("Cast for this book", scrolling(castPage)));

            var status = new TextBlock { TextWrapping = TextWrapping.Wrap, Opacity = 0.9, VerticalAlignment = VerticalAlignment.Center };
            var busyBar = new ProgressBar { IsIndeterminate = true, Height = 4, Margin = new Thickness(0, 0, 0, 8), Visibility = Visibility.Collapsed };
            var save = primary("Save");
            save.Width = 92; save.IsDefault = true;
            var cancel = button("Cancel");
            cancel.Width = 92; cancel.IsCancel = true; cancel.Margin = new Thickness(0);
            // Try it plays unsaved settings, so it is easy to forget to save them.
            var unsaved = new TextBlock { Text = "Unsaved changes", Opacity = 0.8, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 12, 0), Visibility = Visibility.Hidden };
            var buttons = row(new UIElement[] { unsaved, save, cancel });
            var footerRow = new DockPanel();
            DockPanel.SetDock(buttons, Dock.Right);
            footerRow.Children.Add(buttons);
            footerRow.Children.Add(status);
            var footer = new StackPanel { Margin = new Thickness(16, 8, 16, 16) };
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
            // Where progress and messages show: this window's footer, or the Voices window's
            // while that is open.
            TextBlock statusNow = status;
            ProgressBar busyNow = busyBar;
            var clock = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            Action showClock = () =>
            {
                if (busyWhat == null) return;
                int s = (int)(DateTime.Now - busySince).TotalSeconds;
                string c = busyExpect <= 0 ? s + "s"
                         : s <= busyExpect ? s + "s of about " + busyExpect + "s"
                         : s + "s, longer than the usual " + busyExpect + "s";
                statusNow.Text = busyWhat + " " + c;
            };
            clock.Tick += (s, e) => showClock();
            // A message from inside a job replaces the running one and stops its clock: the
            // narrator's start-up reports its own seconds.
            Action<string> say = m => win.Dispatcher.BeginInvoke((Action)(() => { busyWhat = null; statusNow.Text = m ?? ""; }));

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

            // The voice a cast row is set to. Rows are built before the voice list exists, so
            // the combo's only item is then "Narrator's voice" and its selection is not a
            // choice. Tag keeps the id the row was given until the reader actually picks one,
            // including Narrator's voice. Save uses this, so opening the window cannot wipe a
            // character.
            Func<ComboBox, string> castRowVoice = cb =>
            {
                var sel = cb == null ? null : cb.SelectedItem as VoiceItem;
                string shown = sel != null && sel.Id != null ? sel.Id : "";
                string want = cb != null && cb.Tag is string ? (string)cb.Tag : "";
                if (shown.Length > 0) return shown;
                if (want.Length == 0 || cb == null) return "";
                foreach (var o in cb.Items)
                {
                    var v = o as VoiceItem;
                    if (v != null && v.Id == want) return "";
                }
                return want;
            };
            Func<string, ComboBox> voicePicker = selected =>
            {
                var cb = new ComboBox { Width = 220, Margin = new Thickness(8, 0, 0, 0), Tag = selected ?? "" };
                cb.Items.Add(new VoiceItem { Id = "", Name = "Narrator's voice" });
                foreach (var v in voices) cb.Items.Add(v);
                cb.SelectedIndex = 0;
                for (int i = 1; i < cb.Items.Count; i++) if (((VoiceItem)cb.Items[i]).Id == selected) cb.SelectedIndex = i;
                cb.SelectionChanged += (s, e) =>
                {
                    var item = cb.SelectedItem as VoiceItem;
                    if (item == null) return;
                    string id = item.Id ?? "";
                    if (id.Length == 0)
                    {
                        string want = cb.Tag as string ?? "";
                        if (want.Length > 0)
                        {
                            bool listed = false;
                            foreach (var o in cb.Items)
                            {
                                var v = o as VoiceItem;
                                if (v != null && v.Id == want) { listed = true; break; }
                            }
                            // The placeholder, while the saved voice is not in the list yet.
                            if (!listed) return;
                        }
                    }
                    cb.Tag = id;
                };
                return cb;
            };

            // Assigned below, once the busy-button list exists. The row's play button calls it.
            Action<string, double, Action> work = null;
            Action<string, string, string, string> addCastRow = (key, name, chosen, line) =>
            {
                foreach (var r in castRows) if (r.Item1 == key) return;
                var cb = voicePicker(chosen);
                var sayBox = new TextBox
                {
                    Text = line ?? "", Width = 420, Height = 28, Margin = new Thickness(8, 0, 0, 0),
                    VerticalContentAlignment = VerticalAlignment.Center, MaxLength = 1500,
                    ToolTip = "Sent with this character's lines. Leave empty to keep the usual in-character line."
                };
                // One short line, in the voice and instruction on this row, the same way a cast
                // line is told them. The box is read at the click, so it can be heard before Save.
                var playLine = button("\u25B6");
                playLine.Width = 28;
                playLine.Padding = new Thickness(0);
                playLine.FocusVisualStyle = null;
                playLine.ToolTip = "Play \u201cYou should have waited for me.\u201d in the voice chosen here, told the instruction in this row.";
                if (busyWhat != null) playLine.IsEnabled = false;
                castPlays.Add(playLine);
                playLine.Click += (s, e) =>
                {
                    string id = castRowVoice(cb);
                    if (id.Length == 0)
                    {
                        var narr = voiceBox.SelectedItem as VoiceItem;
                        id = narr != null && narr.Id != null ? narr.Id : (settings.Voice ?? "");
                    }
                    if (id.Length == 0) { say("Choose a voice for this character first."); return; }
                    string spoken = (sayBox.Text ?? "").Trim();
                    string who = name ?? "";
                    int cut = who.IndexOf("  (");
                    if (cut > 0) who = who.Substring(0, cut);
                    try { if (player != null) player.Stop(); } catch { }
                    if (playing != null)
                    {
                        playing = null;
                        try { sendToPage("cmd:narrator_trial_stop"); } catch { }
                        if (applyPlay != null) applyPlay();
                    }
                    work("Playing " + who + ":", 12, () =>
                    {
                        var body = new Dictionary<string, object>
                        {
                            { "voice", id },
                            { "blocks", new object[] {
                                new Dictionary<string, object> {
                                    { "id", 0 },
                                    { "text", "You should have waited for me." },
                                    { "role", "dialogue" },
                                    { "voice", id },
                                    { "instruction", spoken }
                                }
                            }}
                        };
                        string json = QwenNarrator.Call("POST", "/render", new JavaScriptSerializer().Serialize(body), 120000);
                        var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                        Dictionary<string, object> item = null;
                        object items;
                        if (d != null && d.TryGetValue("items", out items))
                            foreach (var o in (items as System.Collections.IEnumerable) ?? new object[0])
                            {
                                item = o as Dictionary<string, object>;
                                if (item != null) break;
                            }
                        if (item == null) { say("Nothing came back to play."); return; }
                        string file = Convert.ToString(item["file"]);
                        object priv;
                        bool isPrivate = item.TryGetValue("private", out priv) && priv is bool && (bool)priv;
                        string folder = isPrivate && !string.IsNullOrEmpty(QwenNarrator.PrivateCacheDir)
                            ? QwenNarrator.PrivateCacheDir
                            : QwenNarrator.CacheDir(cacheDir);
                        win.Dispatcher.Invoke((Action)(() => play(System.IO.Path.Combine(folder, file))));
                        say("");
                    });
                };
                castRows.Add(Tuple.Create(key, name, cb, sayBox));
                var label = new TextBlock
                {
                    Text = name, Width = 200, VerticalAlignment = VerticalAlignment.Center,
                    TextTrimming = TextTrimming.CharacterEllipsis, ToolTip = name
                };
                castPanel.Children.Add(row(new UIElement[] { playLine, label, cb, sayBox }));
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
                var old = new List<Tuple<string, string, ComboBox, TextBox>>(castRows);
                castRows.Clear();
                castPlays.Clear();
                castPanel.Children.Clear();
                foreach (var r in old)
                    addCastRow(r.Item1, r.Item2, castRowVoice(r.Item3), r.Item4.Text);
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
            var busyButtons = new List<Button> { playVoice, libPlay, deleteVoice, design, importVoice, playA, takeA };
            if (findCast != null) busyButtons.Add(findCast);
            // `expect` is the usual time in seconds, shown against a running clock; 0 for none.
            work = (what, expect, job) =>
            {
                foreach (var b in busyButtons) b.IsEnabled = false;
                foreach (var b in castPlays) b.IsEnabled = false;
                playB.IsEnabled = takeB.IsEnabled = false;
                busyWhat = what; busySince = DateTime.Now; busyExpect = expect;
                var bar = busyNow;
                var line = statusNow;
                bar.Visibility = Visibility.Visible;
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
                            bar.Visibility = Visibility.Collapsed;
                            if (busyWhat != null) { busyWhat = null; line.Text = ""; }
                            foreach (var b in busyButtons) b.IsEnabled = true;
                            foreach (var b in castPlays) b.IsEnabled = true;
                            playB.IsEnabled = takeB.IsEnabled = kept != null;
                            if (applyPlay != null) applyPlay();
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

            // ---- Try it: Current is the settings on screen, Previous the last different ones played
            TaskCompletionSource<string> pendingTrial = null;
            Trial lastPlayed = null;
            int currentTake = 1;            // Current's take; back to 1 whenever a setting changes
            Trial onScreen = null;
            Func<Trial> current = () =>
            {
                var v = voiceBox.SelectedItem as VoiceItem;
                var p = presetBox.SelectedItem as PresetItem;
                string instr = instructionBox.Text.Trim();
                // Enough of the reader's own words to tell two of them apart.
                string[] w = instr.Split(new[] { ' ', '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                string words = instr.Length == 0 ? "no instruction"
                             : p != null ? "the " + p.Name + " instruction"
                             : "your instruction “" + string.Join(" ", w, 0, Math.Min(6, w.Length)) + (w.Length > 6 ? "…" : "") + "”";
                string cue = cueBox.Text.Trim().Length > 0 ? cueBox.Text.Trim() : QwenNarrator.DefaultCue;
                bool direct = directBox.IsChecked == true;
                return new Trial
                {
                    Voice = v != null ? v.Id : settings.Voice,
                    VoiceName = v != null ? v.Name : "the narrator's voice",
                    Instruction = instr,
                    Cue = cue,
                    Direct = direct,
                    Label = (v != null ? v.Name : "Narrator's voice") + ", " + words + ", cues "
                          + (!direct ? "off" : cue == QwenNarrator.DefaultCue ? "on" : "on in your wording"),
                    Take = currentTake
                };
            };
            Func<Trial, Trial, bool> sameSettings = (x, y) => x != null && y != null && x.Voice == y.Voice
                && x.Instruction == y.Instruction && x.Direct == y.Direct && (!x.Direct || x.Cue == y.Cue);
            Action updateA = () =>
            {
                var t = current();
                if (onScreen != null && !sameSettings(onScreen, t)) { currentTake = 1; t = current(); }
                onScreen = t;
                aSummary.Text = t.Describe();
            };

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
                    { "instruction", t.Instruction }, { "cue", t.Cue }, { "direct", t.Direct }, { "seed", t.Seed }
                });
                // Nothing will play after all: that row's Stop goes back to Play.
                Action notPlaying = () => win.Dispatcher.BeginInvoke((Action)(() => { playing = null; applyPlay(); }));
                playing = which;
                work("Preparing " + which + ":", 15, () =>
                {
                    bool up = QwenNarrator.EnsureRunning(cacheDir, appDir, m => { }, CancellationToken.None).Result;
                    if (!up) { notPlaying(); say("The narrator is not running, so nothing can be tried now."); return; }
                    var tcs = new TaskCompletionSource<string>();
                    pendingTrial = tcs;
                    win.Dispatcher.Invoke((Action)(() => sendToPage("cmd:narrator_trial:" + json)));
                    if (!tcs.Task.Wait(180000))
                    {
                        win.Dispatcher.Invoke((Action)(() => sendToPage("cmd:narrator_trial_stop")));
                        notPlaying();
                        say("No answer after three minutes; stopped.");
                        return;
                    }
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(tcs.Task.Result);
                    string kind = Convert.ToString(d["kind"]);
                    if (kind == "error") { notPlaying(); say("That did not work: " + Convert.ToString(d["message"])); return; }
                    if (kind != "ready") { notPlaying(); say(""); return; }
                    var sb = new System.Text.StringBuilder();
                    sb.Append(which).Append(": ").Append(t.Describe()).Append("\r\n\r\n");
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
                applyPlay();            // work() disabled the buttons; this row's Stop stays live
            };
            Action playCurrent = () =>
            {
                var t = current();
                // What was heard before becomes Previous, once the settings differ from it --
                // another take of the same settings does not.
                if (lastPlayed != null && !sameSettings(lastPlayed, t))
                {
                    kept = lastPlayed;
                    bSummary.Text = kept.Describe();
                    bSummary.Opacity = 1;
                }
                lastPlayed = t;
                runTrial(t, "Current");
            };
            Action stopTrial = () =>
            {
                sendToPage("cmd:narrator_trial_stop");
                var p = pendingTrial;
                if (p != null) p.TrySetResult("{\"kind\":\"stopped\"}");
                playing = null;
                applyPlay();
                say("");
            };
            // While a row is preparing or playing, its Play reads Stop and the other controls
            // wait; once nothing is, every button is itself again.
            applyPlay = () =>
            {
                playA.Content = playing == "Current" ? "■ Stop" : "▶ Play";
                playB.Content = playing == "Previous" ? "■ Stop" : "▶ Play";
                if (playing != null)
                {
                    playA.IsEnabled = playing == "Current";
                    playB.IsEnabled = playing == "Previous";
                    takeA.IsEnabled = takeB.IsEnabled = false;
                }
                else if (busyBar.Visibility != Visibility.Visible)
                {
                    playA.IsEnabled = takeA.IsEnabled = true;
                    playB.IsEnabled = takeB.IsEnabled = kept != null;
                }
            };
            playA.Click += (s, e) => { if (playing == "Current") stopTrial(); else playCurrent(); };
            takeA.Click += (s, e) => { currentTake++; updateA(); playCurrent(); };
            playB.Click += (s, e) => { if (playing == "Previous") stopTrial(); else if (kept != null) runTrial(kept, "Previous"); };
            takeB.Click += (s, e) =>
            {
                if (kept == null) return;
                kept.Take++;
                bSummary.Text = kept.Describe();
                runTrial(kept, "Previous");
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
                    else if (kind == "ended")
                    {
                        win.Dispatcher.BeginInvoke((Action)(() => { playing = null; applyPlay(); }));
                        say("");
                    }
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
                            bool whole = false;
                            List<Dictionary<string, object>> list;
                            var ser = new JavaScriptSerializer();
                            if (json != null && json.TrimStart().StartsWith("{"))
                            {
                                var wrap = ser.Deserialize<Dictionary<string, object>>(json);
                                object w, chars;
                                list = new List<Dictionary<string, object>>();
                                if (wrap != null && wrap.TryGetValue("whole", out w) && w is bool) whole = (bool)w;
                                if (wrap != null && wrap.TryGetValue("characters", out chars))
                                {
                                    foreach (var o in (chars as System.Collections.IEnumerable) ?? new object[0])
                                    {
                                        var c = o as Dictionary<string, object>;
                                        if (c != null) list.Add(c);
                                    }
                                }
                            }
                            else list = ser.Deserialize<List<Dictionary<string, object>>>(json)
                                       ?? new List<Dictionary<string, object>>();
                            int shown = 0;
                            foreach (var c in list)
                            {
                                if (shown++ >= 30) break;
                                string key = Convert.ToString(c["key"]);
                                string name = Convert.ToString(c["name"]) + "  (" + Convert.ToString(c["lines"]) + " lines)";
                                string chosen;
                                string line;
                                addCastRow(key, name, cast.Voices.TryGetValue(key, out chosen) ? chosen : "",
                                           cast.Instructions.TryGetValue(key, out line) ? line : "");
                            }
                            say(list.Count == 0
                                ? (whole ? "No named speakers found in this book."
                                         : "No named speakers found in the part of the book that is loaded.")
                                : (whole ? "The most frequent speakers in this book. Give voices to the ones you want."
                                         : "The most frequent speakers in the loaded part of the book. Give voices to the ones you want."));
                        }
                        catch (Exception ex) { say("Could not read the character list: " + ex.Message); }
                    }));
                };
            }

            Func<bool> doSave = () =>
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
                        string id = castRowVoice(r.Item3);
                        string line = (r.Item4.Text ?? "").Trim();
                        if (id.Length > 0)
                        {
                            cast.Voices[r.Item1] = id;
                            cast.Names[r.Item1] = r.Item2;
                            if (line.Length > 0) cast.Instructions[r.Item1] = line;
                            else cast.Instructions.Remove(r.Item1);
                        }
                        else
                        {
                            cast.Voices.Remove(r.Item1);
                            cast.Names.Remove(r.Item1);
                            cast.Instructions.Remove(r.Item1);
                        }
                    }
                    QwenNarrator.SaveCast(cacheDir, book, cast);
                    if (saved != null) saved();
                    return true;
                }
                catch (Exception ex) { say("Could not save: " + ex.Message); return false; }
            };
            save.Click += (s, e) => { if (doSave()) win.DialogResult = true; };

            // Unsaved changes: the settings on screen against what is saved, cast included.
            Func<bool> dirty = () =>
            {
                var v = voiceBox.SelectedItem as VoiceItem;
                string cue = cueBox.Text.Trim().Length > 0 ? cueBox.Text.Trim() : QwenNarrator.DefaultCue;
                if ((v != null && v.Id != settings.Voice) || instructionBox.Text.Trim() != (settings.Instruction ?? "").Trim()
                    || cue != (settings.Cue ?? "").Trim() || (directBox.IsChecked == true) != settings.Direct) return true;
                foreach (var r in castRows)
                {
                    string now = castRowVoice(r.Item3), was;
                    if (!cast.Voices.TryGetValue(r.Item1, out was)) was = "";
                    if (now != was) return true;
                    string sayNow = (r.Item4.Text ?? "").Trim(), sayWas;
                    if (!cast.Instructions.TryGetValue(r.Item1, out sayWas)) sayWas = "";
                    if (sayNow != sayWas.Trim()) return true;
                }
                return false;
            };
            var dirtyTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
            dirtyTimer.Tick += (s, e) => unsaved.Visibility = dirty() ? Visibility.Visible : Visibility.Hidden;
            dirtyTimer.Start();
            // Closing with the window's X while changes are unsaved asks; Cancel means discard.
            win.Closing += (s, e) =>
            {
                if (win.DialogResult != null || !dirty()) return;
                var answer = MessageBox.Show(win, "Save the changes to the narrator settings?", "Narrator",
                                             MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
                if (answer == MessageBoxResult.Cancel) e.Cancel = true;
                else if (answer == MessageBoxResult.Yes && !doSave()) e.Cancel = true;
            };

            sampleBox.PreviewKeyDown += (s, e) =>
            {
                if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Control) != 0)
                {
                    e.Handled = true;
                    if (playing == null && playA.IsEnabled) playCurrent();
                }
            };

            // ---- the Voices window: the library, which acts at once, with Close and nothing else
            // Unkept candidates from "Create 3 candidates" are files on disk until the next
            // design; they go when the library closes, so nothing half-chosen is left behind.
            Action clearCandidates = () =>
            {
                try
                {
                    string dir = System.IO.Path.Combine(QwenNarrator.RootDir(cacheDir), "voices", "_candidates");
                    if (System.IO.Directory.Exists(dir)) System.IO.Directory.Delete(dir, true);
                }
                catch { }
            };
            Func<Window> makeVoicesWindow = () =>
            {
                var vw = new Window
                {
                    Title = "Voices", Width = 640, Height = 640, MinWidth = 520, MinHeight = 460,
                    WindowStartupLocation = WindowStartupLocation.CenterOwner, ResizeMode = ResizeMode.CanResizeWithGrip,
                    ShowInTaskbar = false, Background = win.Background, Foreground = win.Foreground
                };
                try { vw.Owner = win; } catch { }
                var close = button("Close");
                close.Width = 92; close.IsCancel = true; close.Margin = new Thickness(0);
                close.Click += (s2, e2) => vw.Close();
                var vFooterRow = new DockPanel();
                DockPanel.SetDock(close, Dock.Right);
                vFooterRow.Children.Add(close);
                vFooterRow.Children.Add(libStatus);
                var vFooter = new StackPanel { Margin = new Thickness(16, 8, 16, 16) };
                vFooter.Children.Add(libBusy);
                vFooter.Children.Add(vFooterRow);
                if (win.Foreground != null) vFooter.SetValue(TextElement.ForegroundProperty, win.Foreground);
                var vOuter = new DockPanel { Background = win.Background };
                DockPanel.SetDock(vFooter, Dock.Bottom);
                vOuter.Children.Add(vFooter);
                var libScroll = scrolling(lib);
                vOuter.Children.Add(page(libScroll));
                vw.Content = vOuter;
                statusNow = libStatus; busyNow = libBusy;
                libStatus.Text = "Changes here take effect at once.";
                // A design still running would write its candidates after they were cleared.
                vw.Closing += (s2, e2) =>
                {
                    if (busyWhat != null && libBusy.Visibility == Visibility.Visible)
                    {
                        e2.Cancel = true;
                        libStatus.Text = "Wait for this to finish: " + busyWhat;
                    }
                };
                vw.Closed += (s2, e2) =>
                {
                    statusNow = status; busyNow = busyBar;
                    candidates.Children.Clear();
                    clearCandidates();
                    // Detach the library and its status line, so the next opening can show them.
                    libScroll.Content = null;
                    vFooterRow.Children.Remove(libStatus);
                    vFooter.Children.Remove(libBusy);
                };
                return vw;
            };
            VoicesWindowForTest = makeVoicesWindow;
            manageVoices.Click += (s, e) => makeVoicesWindow().ShowDialog();

            // Saved cast rows show at once, before any scan.
            foreach (var kv in cast.Voices)
            {
                string name;
                string savedSay;
                addCastRow(kv.Key, cast.Names.TryGetValue(kv.Key, out name) ? name : kv.Key, kv.Value,
                           cast.Instructions.TryGetValue(kv.Key, out savedSay) ? savedSay : "");
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
                dirtyTimer.Stop();
                clearCandidates();
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
