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
    /// File > Read Aloud > Narrator Manager.
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
            /// <summary>The narrator being edited made it, so it may be deleted and exported here.</summary>
            public bool Mine;
            /// <summary>"qwen" for a voice in the Qwen narrator's folder, which both narrators read.</summary>
            public string Source = "";
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
            /// <summary>Breeze's Emotion strength; 0 with Qwen, which has none.</summary>
            public double Strength;
            public int Seed { get { return 1234 + Take - 1; } }
            public string Describe() { return Take > 1 ? Label + ", take " + Take : Label; }
        }

        /// <summary>
        /// The narrator the window edits: Qwen or Breeze, the choice at the top when both are
        /// installed (docs/internal/breeze-tts-plan.md 4.4a). Instruction, cues and casts are shared;
        /// the voice, the voice library and the calls are that narrator's.
        /// </summary>
        /// <summary>Play sample's line when the reader has not set one: the line every voice's recording says.</summary>
        private const string DefaultSample = "\u201cYou should have waited for me,\u201d she said quietly, and for a while neither of them spoke.";
        private const string SampleTip = "Plays this voice saying the sample line. Right-click to change the line, how it is said, or go back to the default.";

        private sealed class Side
        {
            public bool Breeze;
            public NarratorEngine Engine { get { return Breeze ? BreezeNarrator.Engine : QwenNarrator.Engine; } }
            public string Name { get { return Breeze ? "Breeze" : "Qwen"; } }
            public string AudioDir(string cacheDir) { return Breeze ? BreezeNarrator.CacheDir(cacheDir) : QwenNarrator.CacheDir(cacheDir); }
            public string VoicesDir(string cacheDir)
            {
                return System.IO.Path.Combine(Breeze ? BreezeNarrator.RootDir(cacheDir) : QwenNarrator.RootDir(cacheDir), "voices");
            }
            public string AudioHost { get { return Breeze ? BreezeNarrator.HostName : QwenNarrator.HostName; } }
            public string AudioHostPrivate { get { return Breeze ? BreezeNarrator.PrivateHostName : QwenNarrator.PrivateHostName; } }
        }

        // Narration, a line tagged as said quietly, one tagged as snapped, and an amount: each of
        // the things the Reading settings change is in it. Kept for the session once edited.
        private static string _sample =
            "The rain had not stopped for three days, and the harbour lights were smeared across the black water. Mara pushed the door open and stood there, dripping.\r\n"
            + "“You said you’d be back by Tuesday,” Tom said quietly. “It’s Friday.”\r\n"
            + "“I know,” she snapped. “The ferry cost me £86 and it still ran four hours late.”";

        /// <summary>
        /// `breezeReading`: Read Aloud uses the Breeze narrator now. `narratorChosen` is told, on Save,
        /// when the reader picked the other narrator at the top (true for Breeze).
        /// </summary>
        public static void Show(Window owner, string cacheDir, string appDir, string book, Action<string> sendToPage, Action saved,
                                bool breezeReading, Action<bool> narratorChosen)
        {
            Build(owner, cacheDir, appDir, book, sendToPage, saved, true, breezeReading, narratorChosen).ShowDialog();
        }

        /// <summary>
        /// The window, ready to show. `start` false leaves the narrator alone, for rendering the
        /// layout without showing it (checking the design by eye before a release).
        /// </summary>
        internal static Window Build(Window owner, string cacheDir, string appDir, string book, Action<string> sendToPage, Action saved, bool start,
                                     bool breezeReading = false, Action<bool> narratorChosen = null)
        {
            var settings = QwenNarrator.LoadSettings(cacheDir);
            bool haveQwen = QwenNarrator.Installed(cacheDir, appDir), haveBreeze = BreezeNarrator.Installed(cacheDir, appDir);
            // The narrator Read Aloud uses, when it is one of these; otherwise whichever is installed.
            var side = new Side { Breeze = haveBreeze && (breezeReading || !haveQwen) };
            bool openedBreeze = side.Breeze;
            Func<string> savedVoice = () => side.Breeze ? settings.BreezeVoice : settings.Voice;
            var cast = QwenNarrator.LoadCast(cacheDir, book);
            var voices = new List<VoiceItem>();
            SoundPlayer player = null;
            Trial kept = null;              // Try it: Previous, the last different settings played
            string playing = null;          // Try it: "Current" or "Previous" while one is preparing or playing
            Action applyPlay = null;        // shows that row's Play as Stop; set once the buttons exist

            var win = new Window
            {
                Title = "Narrator Manager",
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
            DialogTheme.Apply(win, owner);

            // ---- building blocks. Spacing is on one grid: 4 within a group, 8 between controls,
            // 16 between sections and at the edges.
            Func<string, TextBlock> heading = t => new TextBlock { Text = t, FontWeight = FontWeights.SemiBold, FontSize = 13.5, Margin = new Thickness(0, 10, 0, 3) };
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

            RadioButton pickQwen = null, pickBreeze = null;
            if (haveQwen && haveBreeze)
            {
                left.Children.Add(heading("Narrator"));
                pickQwen = new RadioButton { Content = "Qwen", GroupName = "narrator", IsChecked = !side.Breeze, Margin = new Thickness(0, 0, 16, 0) };
                pickBreeze = new RadioButton { Content = "Breeze", GroupName = "narrator", IsChecked = side.Breeze };
                if (win.Foreground != null) { pickQwen.Foreground = win.Foreground; pickBreeze.Foreground = win.Foreground; }
                left.Children.Add(row(new UIElement[] { pickQwen, pickBreeze }));
                left.Children.Add(note("Read Aloud uses the one you save. Voices are each narrator's own; the instruction, cues and casts are shared."));
            }

            left.Children.Add(heading("Voice"));
            var voiceBox = new ComboBox { MinWidth = 220 };
            var playVoice = button("▶ Sample");
            playVoice.ToolTip = SampleTip;
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
            // A voice's description can be selected and copied (Ed, 2026-10-09): read-only text, drawn as
            // a note is -- no box, no border -- so it looks the same as before.
            Func<TextBox> selectable = () => new TextBox
            {
                IsReadOnly = true, TextWrapping = TextWrapping.Wrap, BorderThickness = new Thickness(0),
                Background = Brushes.Transparent, Padding = new Thickness(0), Opacity = 0.72, Margin = new Thickness(0, 0, 0, 8),
                Cursor = Cursors.IBeam
            };
            var voiceDesc = selectable();
            left.Children.Add(voiceDesc);

            left.Children.Add(heading("Instruction"));
            left.Children.Add(note("How every paragraph is read, in your words. Empty means none."));
            var presetBox = new ComboBox { MinWidth = 300 };
            var presetRow = new DockPanel { Margin = new Thickness(0, 3, 0, 3) };
            var presetLabel = new TextBlock { Text = "Preset", Width = 56, VerticalAlignment = VerticalAlignment.Center };
            DockPanel.SetDock(presetLabel, Dock.Left);
            presetRow.Children.Add(presetLabel);
            presetRow.Children.Add(presetBox);
            left.Children.Add(presetRow);
            var instructionBox = new TextBox { Text = settings.Instruction, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Height = 64, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
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
            var cueExample = note("“Go,” she whispered  →  “whispered” is added to the instruction.");
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

            // ---- Breeze's own settings: shown once Breeze is installed; greyed, saying why, while
            // Qwen is chosen at the top (the window's one rule for what only one narrator has).
            var strengthSlider = new Slider
            {
                Minimum = 1, Maximum = 10, TickFrequency = 0.5, IsSnapToTickEnabled = true, Width = 220,
                Value = settings.BreezeStrength, VerticalAlignment = VerticalAlignment.Center
            };
            var strengthValue = new TextBlock { Width = 40, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 0, 0) };
            Action showStrength = () => strengthValue.Text = strengthSlider.Value.ToString("0.#");
            showStrength();
            var breezePanel = new StackPanel();
            var breezeWhy = note("Breeze only.");
            breezeWhy.Margin = new Thickness(22, 0, 0, 4);
            if (haveBreeze)
            {
                var strengthLabel = new TextBlock { Text = "Emotion strength", Width = 120, VerticalAlignment = VerticalAlignment.Center };
                breezePanel.Margin = new Thickness(22, 4, 0, 0);
                breezePanel.ToolTip = "How hard Breeze follows an instruction: an emotion cue, a bracket beside a speaker, a [[double bracket]] "
                    + "or a mood tag such as [sad]. 1 barely; 4 is Breeze's own recommendation; higher pushes harder and may start to sound strained. "
                    + "A tag's own number, [sad:9], wins for its line; a cast character has their own on Cast for this book. "
                    + "Narration with no instruction is not affected. Above 1, those lines take about half as long again to prepare.";
                breezePanel.Children.Add(row(new UIElement[] { strengthLabel, strengthSlider, strengthValue }));
                breezePanel.Children.Add(note("1 barely · 4 recommended · 10 strongest. [sad:9] sets one line."));
                left.Children.Add(breezePanel);
                left.Children.Add(breezeWhy);
            }
            // Cue wording is no longer shown (2026-10-09): it only words punctuation cues, and its
            // default told the narrator to hold back. cueBox still carries the saved wording through Save.

            // ---- Try it: its own panel, always in view
            var tryPanel = new DockPanel();
            var tryTop = new StackPanel();
            DockPanel.SetDock(tryTop, Dock.Top);
            tryTop.Children.Add(heading("Try it"));
            tryTop.Children.Add(note("The settings on the left, saved or not, on this text. Ctrl+Enter plays."));
            var sampleBox = new TextBox { Text = _sample, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Height = 170, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
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
            // While the narrator starts: its clock, here beside the Play it is holding up, not only in the footer.
            var startLine = new TextBlock { TextWrapping = TextWrapping.Wrap, Opacity = 0.75, Margin = new Thickness(0, 2, 0, 6), Visibility = Visibility.Collapsed };
            tryTop.Children.Add(startLine);
            // No Stop of its own: the Play of whichever row is preparing or playing becomes
            // Stop (applyPlay), where the eye and the pointer already are.

            var toldBox = new TextBox
            {
                IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                FontSize = 11.5, MinHeight = 90, MaxHeight = 320, Text = "Play something to see the instruction each paragraph was given."
            };
            var toldFold = fold("What the narrator was told", toldBox);
            toldFold.IsExpanded = false;      // opened when something has been played
            toldFold.Margin = new Thickness(0, 8, 0, 0);
            tryPanel.Children.Add(tryTop);
            tryPanel.Children.Add(toldFold);

            var tryCard = new Border
            {
                Child = tryPanel, Padding = new Thickness(16, 0, 16, 16), CornerRadius = new CornerRadius(6),
                Background = new SolidColorBrush(Color.FromArgb(0x1C, 0x80, 0x80, 0x80)),
                BorderBrush = new SolidColorBrush(Color.FromArgb(0x40, 0x80, 0x80, 0x80)), BorderThickness = new Thickness(1),
                Margin = new Thickness(0, 16, 0, 0), VerticalAlignment = VerticalAlignment.Top
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
            libPlay.ToolTip = SampleTip;
            var exportVoice = button("Export...");
            exportVoice.ToolTip = "Saves this voice as a .tzvoice file, to keep or use on another PC. Designing from the same description makes a different person each time, so a voice you like is worth keeping.";
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
            var libDesc = selectable();
            lib.Children.Add(libDesc);

            lib.Children.Add(heading("Design a new voice"));
            var designNote = note("");
            lib.Children.Add(designNote);
            var descBox = new TextBox { TextWrapping = TextWrapping.Wrap, AcceptsReturn = false, Height = 48, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            lib.Children.Add(descBox);
            var design = primary("Create 3 candidates");
            var fromSelected = button("Start from the selected voice");
            fromSelected.ToolTip = "Puts the selected voice's description in the box, to change and design from.";
            fromSelected.Margin = new Thickness(8, 0, 0, 0);
            design.Margin = new Thickness(0);
            var designRow = row(new UIElement[] { design, fromSelected });
            designRow.Margin = new Thickness(0, 8, 0, 0);
            lib.Children.Add(designRow);
            var candidates = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
            lib.Children.Add(candidates);

            // Clone: Breeze only. Shown once Breeze is installed; with Qwen chosen it stays in view,
            // greyed, saying why -- one rule for every control one narrator lacks.
            var clonePanel = new StackPanel();
            var cloneWhy = note("Clone needs the Breeze narrator: choose Breeze at the top of the Narrator window.");
            var cloneFile = button("Choose recording...");
            var cloneFileName = new TextBlock { VerticalAlignment = VerticalAlignment.Center, Opacity = 0.8, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 340 };
            var cloneWords = new TextBox { TextWrapping = TextWrapping.Wrap, AcceptsReturn = false, Height = 48, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            var cloneFrom = new TextBox { Width = 56, Height = 26, VerticalContentAlignment = VerticalAlignment.Center, Margin = new Thickness(6, 0, 12, 0) };
            var cloneTo = new TextBox { Width = 56, Height = 26, VerticalContentAlignment = VerticalAlignment.Center, Margin = new Thickness(6, 0, 0, 0) };
            var cloneGo = primary("Make a candidate");
            cloneGo.HorizontalAlignment = HorizontalAlignment.Left;
            cloneGo.Margin = new Thickness(0, 8, 0, 0);
            string clonePath = null;
            if (haveBreeze)
            {
                lib.Children.Add(heading("Clone a voice from a recording"));
                clonePanel.Children.Add(note("3 to 20 seconds of one person, and exactly the words they say. Only a voice you have the right to use."));
                clonePanel.Children.Add(row(new UIElement[] { cloneFile, cloneFileName }));
                clonePanel.Children.Add(new TextBlock { Text = "The words said in the recording", Margin = new Thickness(0, 8, 0, 4) });
                clonePanel.Children.Add(cloneWords);
                var useDesign = button("Use the design passage");
                useDesign.ToolTip = "The passage every designed voice is recorded reading. Record the speaker reading it, then choose that recording.";
                useDesign.Margin = new Thickness(0, 8, 0, 0);
                useDesign.HorizontalAlignment = HorizontalAlignment.Left;
                useDesign.Click += (s, e) => cloneWords.Text = "The road ran straight across the plain, and the mountains beyond it were pale with distance. "
                    + "She had been walking since the morning, and the light had not changed at all. There was nothing to mark the hours but the sound of her own steps.";
                clonePanel.Children.Add(useDesign);
                clonePanel.Children.Add(row(new UIElement[] {
                    new TextBlock { Text = "Use from", VerticalAlignment = VerticalAlignment.Center }, cloneFrom,
                    new TextBlock { Text = "to", VerticalAlignment = VerticalAlignment.Center }, cloneTo,
                    new TextBlock { Text = "  seconds (optional)", VerticalAlignment = VerticalAlignment.Center, Opacity = 0.72 } }));
                clonePanel.Children.Add(cloneGo);
                lib.Children.Add(cloneWhy);
                lib.Children.Add(clonePanel);
            }
            var libStatus = new TextBlock { TextWrapping = TextWrapping.Wrap, Opacity = 0.9, VerticalAlignment = VerticalAlignment.Center };
            var libBusy = new ProgressBar { IsIndeterminate = true, Height = 4, Margin = new Thickness(0, 0, 0, 8), Visibility = Visibility.Collapsed };

            // ================================================================ Cast
            var castRows = new List<Tuple<string, string, ComboBox, TextBox>>();     // key, name, voice, instruction
            var castPlays = new List<Button>();
            var castPanel = new StackPanel();
            var castEmpty = note("No characters yet. Find characters lists who speaks in this book.");
            castEmpty.Margin = new Thickness(36, 8, 0, 0);
            Button findCast = null;
            StackPanel castPage = null;
            if (!string.IsNullOrEmpty(book))
            {
                castPage = new StackPanel();
                castPage.Children.Add(heading("Cast for this book"));
                castPage.Children.Add(note("Give a character a voice and their quoted lines are read in it; the narrator reads the rest. Who speaks comes from the text (\u201csaid Ferbin\u201d). Instruction and Strength are optional."));
                if (QwenNarrator.PrivateMode)
                    castPage.Children.Add(note("Privacy Mode is on: this book's cast is kept until TypoZen closes and is not saved to disk."));
                findCast = button("Find characters");
                findCast.HorizontalAlignment = HorizontalAlignment.Left;
                findCast.Margin = new Thickness(0, 0, 0, 8);
                castPage.Children.Add(findCast);
                castPage.Children.Add(row(new UIElement[] {
                    new TextBlock { Width = 28, Margin = new Thickness(0, 0, 8, 0) },
                    new TextBlock { Text = "Character", Width = 160, Opacity = 0.7 },
                    new TextBlock { Text = "Lines", Width = 44, Opacity = 0.7 },
                    new TextBlock { Text = "Voice", Width = 220, Margin = new Thickness(8, 0, 0, 0), Opacity = 0.7 },
                    new TextBlock { Text = "Instruction", Width = 360, Margin = new Thickness(8, 0, 0, 0), Opacity = 0.7 },
                    new TextBlock { Text = "Strength", Width = 60, Margin = new Thickness(8, 0, 0, 0), Opacity = 0.7,
                                    ToolTip = "Breeze only: how hard this character's lines follow their instruction, 1 to 10." }
                }));
                castPage.Children.Add(castPanel);
                castPage.Children.Add(castEmpty);
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
            // Each character's Breeze strength as typed, kept across the rows being rebuilt; the
            // boxes themselves, so the narrator choice can grey them under Qwen.
            var castStrengthText = new Dictionary<string, string>();
            var castStrengthBoxes = new Dictionary<string, TextBox>();
            Func<string, double> castStrengthOf = key =>
            {
                string t; double v;
                if (castStrengthText.TryGetValue(key, out t) && double.TryParse(t, out v)) return Math.Max(1, Math.Min(10, v));
                return QwenNarrator.CastStrengthDefault;
            };
            Action<string, string, string, string> addCastRow = (key, name, chosen, line) =>
            {
                foreach (var r in castRows) if (r.Item1 == key) return;
                var cb = voicePicker(chosen);
                if (!castStrengthText.ContainsKey(key))
                {
                    double had;
                    castStrengthText[key] = (cast.Strengths.TryGetValue(key, out had) ? had : QwenNarrator.CastStrengthDefault).ToString("0.#");
                }
                var strengthBox = new TextBox
                {
                    Text = castStrengthText[key], Width = 44, Height = 28, Margin = new Thickness(8, 0, 0, 0),
                    VerticalContentAlignment = VerticalAlignment.Center, MaxLength = 4, IsEnabled = side.Breeze,
                    ToolTip = "Breeze only: how hard this character's lines follow their instruction, 1 to 10 (default 4). A tag's own number, [sad:9], still wins."
                };
                strengthBox.TextChanged += (s, e) => castStrengthText[key] = strengthBox.Text;
                castStrengthBoxes[key] = strengthBox;
                var sayBox = new TextBox
                {
                    Text = line ?? "", Width = 360, Height = 28, Margin = new Thickness(8, 0, 0, 0),
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
                        id = narr != null && narr.Id != null ? narr.Id : (savedVoice() ?? "");
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
                                    { "instruction", spoken },
                                    { "strength", castStrengthOf(key) }
                                }
                            }}
                        };
                        string json = side.Engine.Call("POST", "/render", new JavaScriptSerializer().Serialize(body), 120000);
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
                        string folder = isPrivate && !string.IsNullOrEmpty(side.Engine.PrivateCacheDir)
                            ? side.Engine.PrivateCacheDir
                            : side.AudioDir(cacheDir);
                        win.Dispatcher.Invoke((Action)(() => play(System.IO.Path.Combine(folder, file))));
                        say("");
                    });
                };
                castRows.Add(Tuple.Create(key, name, cb, sayBox));
                // "Anna  (4 lines)", as Find characters names them: the name and the count in columns of their own.
                string shownName = name ?? key, lineCount = "";
                int paren = shownName.IndexOf("  (");
                if (paren > 0)
                {
                    lineCount = shownName.Substring(paren + 3).Replace(" lines)", "").Replace(" line)", "").TrimEnd(')');
                    shownName = shownName.Substring(0, paren);
                }
                var label = new TextBlock
                {
                    Text = shownName, Width = 160, VerticalAlignment = VerticalAlignment.Center,
                    TextTrimming = TextTrimming.CharacterEllipsis, ToolTip = name
                };
                var lines = new TextBlock { Text = lineCount, Width = 44, VerticalAlignment = VerticalAlignment.Center, Opacity = 0.7 };
                // An empty instruction box says what it is for, rather than looking unfinished.
                var sayCell = new Grid { Margin = sayBox.Margin };
                sayBox.Margin = new Thickness(0);
                var sayHint = new TextBlock { Text = "Optional: how they speak, e.g. gruff and slow", Opacity = 0.45, IsHitTestVisible = false,
                                              VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(7, 0, 0, 0) };
                sayHint.Visibility = sayBox.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                sayBox.TextChanged += (s, e) => sayHint.Visibility = sayBox.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                sayCell.Children.Add(sayBox);
                sayCell.Children.Add(sayHint);
                // Up and Down step the strength by a half, within 1 to 10.
                strengthBox.PreviewKeyDown += (s, e) =>
                {
                    if (e.Key != Key.Up && e.Key != Key.Down) return;
                    double v = castStrengthOf(key) + (e.Key == Key.Up ? 0.5 : -0.5);
                    strengthBox.Text = Math.Max(1, Math.Min(10, v)).ToString("0.#");
                    strengthBox.CaretIndex = strengthBox.Text.Length;
                    e.Handled = true;
                };
                var castLine = row(new UIElement[] { playLine, label, lines, cb, sayCell, strengthBox });
                castLine.Margin = new Thickness(0);
                var stripe = new Border { Child = castLine, Padding = new Thickness(0, 3, 4, 3), CornerRadius = new CornerRadius(3) };
                if (castPanel.Children.Count % 2 == 1) stripe.SetResourceReference(Border.BackgroundProperty, "TzButton");
                castPanel.Children.Add(stripe);
                castEmpty.Visibility = Visibility.Collapsed;
            };

            // A voice the library can act on: one of the reader's, not built in.
            // Any of the reader's voices, whichever narrator is chosen (Ed, 2026-10-09: Delete looked broken
            // on a Qwen-made voice with Breeze chosen). Never the built-in narrator or a model's own speaker.
            Func<VoiceItem, bool> removable = v => v != null && !string.IsNullOrEmpty(v.Preview) && v.Source != "builtin"
                                                  && (v.Mine || (side.Breeze && v.Source == "qwen"));
            Action refreshLibButtons = () =>
            {
                var v = libList.SelectedItem as VoiceItem;
                deleteVoice.IsEnabled = removable(v);
                // Any voice with its recordings on disk can be saved, including the other narrator's;
                // only deleting is limited to the narrator that owns it.
                exportVoice.IsEnabled = v != null && !string.IsNullOrEmpty(v.Preview) && System.IO.File.Exists(v.Preview);
            };

            Action fillVoices = () =>
            {
                string keep = voiceBox.SelectedItem is VoiceItem ? ((VoiceItem)voiceBox.SelectedItem).Id : savedVoice();
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
                castStrengthBoxes.Clear();
                castPlays.Clear();
                castPanel.Children.Clear();
                castEmpty.Visibility = Visibility.Visible;
                foreach (var r in old)
                    addCastRow(r.Item1, r.Item2, castRowVoice(r.Item3), r.Item4.Text);
                refreshLibButtons();
            };

            Action loadVoices = () =>
            {
                string json = side.Engine.Call("GET", "/voices", null, 10000);
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                var list = new List<VoiceItem>();
                foreach (var o in (d["voices"] as System.Collections.IEnumerable) ?? new object[0])
                {
                    var v = o as Dictionary<string, object>;
                    if (v == null) continue;
                    object src, bi;
                    // Breeze lists the Qwen narrator's voices too, which only Qwen may delete.
                    bool mine = side.Breeze ? (v.TryGetValue("source", out src) && Convert.ToString(src) == "breeze")
                                            : !(v.TryGetValue("builtin", out bi) && bi is bool && (bool)bi);
                    list.Add(new VoiceItem
                    {
                        Id = Convert.ToString(v["id"]),
                        Name = Convert.ToString(v["name"]),
                        Description = Convert.ToString(v["description"]),
                        Preview = Convert.ToString(v["preview"]),
                        Mine = mine,
                        Source = side.Breeze ? (v.TryGetValue("source", out src) ? Convert.ToString(src) : "") : (mine ? "qwen" : "builtin")
                    });
                }
                win.Dispatcher.Invoke((Action)(() => { voices.Clear(); voices.AddRange(list); fillVoices(); }));
            };

            // Anything that needs the narrator goes through here: off the UI thread, with the
            // buttons that would start another such call disabled until it is done.
            var busyButtons = new List<Button> { playVoice, libPlay, deleteVoice, design, importVoice, playA, takeA, cloneGo };
            // Find characters asks the page, not the narrator, so it is never held up by one (it was: the
            // whole window sat greyed for the narrator's 40-second start, 2026-10-09).
            // These need the narrator itself, and wait while it starts; the rest of the window does not.
            var needNarrator = new List<Button> { playA, takeA, design, cloneGo, importVoice, deleteVoice };
            bool narratorReady = !start;
            Action gateNarrator = () =>
            {
                if (narratorReady) return;
                foreach (var b in needNarrator) { b.IsEnabled = false; b.ToolTip = "Waiting for the narrator to start"; }
            };
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
                            gateNarrator();
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
                    Voice = v != null ? v.Id : savedVoice(),
                    VoiceName = v != null ? v.Name : "the narrator's voice",
                    Instruction = instr,
                    Cue = cue,
                    Direct = direct,
                    Label = (v != null ? v.Name : "Narrator's voice") + ", " + words + ", cues "
                          + (!direct ? "off" : cue == QwenNarrator.DefaultCue ? "on" : "on in your wording")
                          + (side.Breeze ? ", strength " + strengthSlider.Value.ToString("0.#") : ""),
                    Strength = side.Breeze ? strengthSlider.Value : 0,
                    Take = currentTake
                };
            };
            Func<Trial, Trial, bool> sameSettings = (x, y) => x != null && y != null && x.Voice == y.Voice && x.Strength == y.Strength
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
            strengthSlider.ValueChanged += (s, e) => { showStrength(); updateA(); };
            directBox.Unchecked += (s, e) => updateA();
            cueBox.TextChanged += (s, e) => updateA();
            voiceBox.SelectionChanged += (s, e) =>
            {
                var v = voiceBox.SelectedItem as VoiceItem;
                voiceDesc.Text = v != null ? v.Description : "";
                updateA();
            };
            Action<VoiceItem> startFrom = v =>
            {
                if (v == null || string.IsNullOrWhiteSpace(v.Description)) { say("This voice has no description to start from."); return; }
                descBox.Text = v.Description;
                descBox.Focus();
                descBox.CaretIndex = descBox.Text.Length;
                say("Change the description, then Create 3 candidates.");
            };
            fromSelected.Click += (s, e) => startFrom(libList.SelectedItem as VoiceItem);
            var libMenu = new ContextMenu();
            libMenu.SetResourceReference(Control.BackgroundProperty, "TzField");
            libMenu.SetResourceReference(Control.ForegroundProperty, "TzText");
            var copyDesc = new MenuItem { Header = "Copy description" };
            copyDesc.Click += (s, e) =>
            {
                var v = libList.SelectedItem as VoiceItem;
                if (v == null || string.IsNullOrWhiteSpace(v.Description)) { say("This voice has no description."); return; }
                try { Clipboard.SetText(v.Description); say("Copied the description of \"" + v.Name + "\"."); }
                catch (Exception ex) { say("Could not copy: " + ex.Message); }
            };
            var useDesc = new MenuItem { Header = "Use as starting point" };
            useDesc.Click += (s, e) => startFrom(libList.SelectedItem as VoiceItem);
            libMenu.Items.Add(copyDesc);
            libMenu.Items.Add(useDesc);
            // Right-click picks the voice under the pointer first, as lists everywhere else do.
            libList.PreviewMouseRightButtonDown += (s, e) =>
            {
                var hit = e.OriginalSource as DependencyObject;
                while (hit != null && !(hit is ListBoxItem)) hit = VisualTreeHelper.GetParent(hit);
                if (hit != null) ((ListBoxItem)hit).IsSelected = true;
            };
            libMenu.Opened += (s, e) =>
            {
                var v = libList.SelectedItem as VoiceItem;
                copyDesc.IsEnabled = useDesc.IsEnabled = v != null && !string.IsNullOrWhiteSpace(v.Description);
            };
            libList.ContextMenu = libMenu;
            // A right-click menu opens in a window of its own and need not find this one's styles, so
            // it is handed the theme's just before it opens (DialogTheme; the white strip, 2026-10-09).
            libList.ContextMenuOpening += (s, e) =>
            {
                var menuStyle = libList.TryFindResource(typeof(ContextMenu)) as Style;
                var itemStyle = libList.TryFindResource(typeof(MenuItem)) as Style;
                if (menuStyle != null && libMenu.Style != menuStyle) libMenu.Style = menuStyle;
                if (itemStyle != null) libMenu.ItemContainerStyle = itemStyle;
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
                    Title = title, Width = 520, SizeToContent = SizeToContent.Height, ResizeMode = ResizeMode.NoResize,
                    WindowStartupLocation = WindowStartupLocation.CenterOwner, ShowInTaskbar = false, Owner = win,
                    Background = win.Background, Foreground = win.Foreground
                };
                DialogTheme.Apply(w, win);
                // Wraps and grows with what is in it, up to a few lines: one line 26 high scrolled a sentence
                // off to the left and clipped its descenders (2026-10-09). Enter still means OK.
                var box = new TextBox { Text = initial ?? "", Margin = new Thickness(0, 8, 0, 14), MinHeight = 30, MaxHeight = 110,
                                        TextWrapping = TextWrapping.Wrap, AcceptsReturn = false, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                                        Padding = new Thickness(6, 5, 6, 5) };
                var ok = new Button { Content = "OK", Width = 88, Height = 30, IsDefault = true, Margin = new Thickness(0, 0, 8, 0) };
                var no = new Button { Content = "Cancel", Width = 88, Height = 30, IsCancel = true };
                ok.Click += (s, e) => w.DialogResult = true;
                var panel = new StackPanel { Margin = new Thickness(20, 16, 20, 18) };
                panel.Children.Add(new TextBlock { Text = prompt, TextWrapping = TextWrapping.Wrap });
                panel.Children.Add(box);
                var br = row(new UIElement[] { ok, no });
                br.HorizontalAlignment = HorizontalAlignment.Right;
                panel.Children.Add(br);
                w.Content = panel;
                w.Loaded += (s, e) => { box.Focus(); box.CaretIndex = box.Text.Length; };
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
                    { "base", side.Engine.BaseUrl }, { "audioHost", side.AudioHost }, { "audioHostPrivate", side.AudioHostPrivate },
                    { "text", text }, { "voice", t.Voice },
                    { "instruction", t.Instruction }, { "cue", t.Cue }, { "direct", t.Direct }, { "seed", t.Seed }, { "strength", t.Strength }
                });
                // Nothing will play after all: that row's Stop goes back to Play.
                Action notPlaying = () => win.Dispatcher.BeginInvoke((Action)(() => { playing = null; applyPlay(); }));
                playing = which;
                work("Preparing " + which + ":", 15, () =>
                {
                    bool up = side.Engine.EnsureRunning(cacheDir, appDir, m => { }, CancellationToken.None).Result;
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
                    sb.Append(which).Append(": ").Append(t.Describe()).Append("\r\n");
                    string last = null;
                    double secs = 0;
                    int n = 0;
                    foreach (var o in (d["pieces"] as System.Collections.IEnumerable) ?? new object[0])
                    {
                        var piece = (Dictionary<string, object>)o;
                        string ptext = Convert.ToString(piece["text"]), cue = Convert.ToString(piece["cue"]), ins = Convert.ToString(piece["instruction"]);
                        secs += Convert.ToDouble(piece["seconds"]);
                        // The Narration Monitor's layout: the text, then the instruction with its strength and
                        // where its cue came from, one line each (Ed, 2026-10-09: "what's this?").
                        string mark = (++n) + ". ", pad = new string(' ', mark.Length);
                        string strength = "";
                        object partsO;
                        if (ins.Length > 0 && piece.TryGetValue("parts", out partsO) && partsO is System.Collections.IEnumerable)
                            foreach (var po in (System.Collections.IEnumerable)partsO)
                            {
                                var p = po as Dictionary<string, object>;
                                if (p != null && Convert.ToString(p["instruction"]).Length > 0) strength = Convert.ToDouble(p["strength"]).ToString("0.#");
                            }
                        var why = new List<string>();
                        if (strength.Length > 0) why.Add("strength " + strength);
                        if (cue.Length > 0) why.Add("from “" + cue + "”");
                        sb.Append(mark).Append("Text: ").Append(ptext.Length > 100 ? ptext.Substring(0, 100) + "..." : ptext).Append("\r\n");
                        sb.Append(pad).Append("Instruction: ").Append(ins.Length == 0 ? "none" : ins);
                        if (why.Count > 0) sb.Append("  (").Append(string.Join(", ", why.ToArray())).Append(")");
                        sb.Append("\r\n");
                        last = ins;
                    }
                    win.Dispatcher.Invoke((Action)(() => { toldBox.Text = sb.ToString(); toldFold.IsExpanded = true; }));
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
                    playB.IsEnabled = takeB.IsEnabled = kept != null && narratorReady;
                }
                gateNarrator();
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
            // Play sample says the reader's own line, in their instruction, when they have set one
            // (right-click a Sample button); otherwise the recording kept with the voice.
            Action<VoiceItem> playSample = null;
            Action<VoiceItem> playOwnSample = v =>
            {
                if (!narratorReady) { say("The narrator is still starting: try again in a moment."); return; }
                string id = v != null ? v.Id : "";
                string text = string.IsNullOrWhiteSpace(settings.SampleText) ? DefaultSample : settings.SampleText.Trim();
                string told = (settings.SampleInstruction ?? "").Trim();
                double strength = side.Breeze ? strengthSlider.Value : 0;
                work("Reading the sample line in this voice:", 10, () =>
                {
                    var block = new Dictionary<string, object> { { "id", 0 }, { "text", text }, { "role", "narration" }, { "instruction", told } };
                    var body = new Dictionary<string, object> { { "voice", id }, { "instruction", "" }, { "blocks", new object[] { block } }, { "reading", 0 } };
                    if (strength > 0) body["strength"] = strength;
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                        side.Engine.Call("POST", "/render", new JavaScriptSerializer().Serialize(body), 120000));
                    Dictionary<string, object> item = null;
                    foreach (var o in (d["items"] as System.Collections.IEnumerable) ?? new object[0]) { item = o as Dictionary<string, object>; break; }
                    if (item == null) { say("Nothing came back to play."); return; }
                    object priv;
                    bool isPrivate = item.TryGetValue("private", out priv) && priv is bool && (bool)priv;
                    string folder = isPrivate && !string.IsNullOrEmpty(side.Engine.PrivateCacheDir) ? side.Engine.PrivateCacheDir : side.AudioDir(cacheDir);
                    win.Dispatcher.Invoke((Action)(() => play(System.IO.Path.Combine(folder, Convert.ToString(item["file"])))));
                    say("");
                });
            };
            playSample = v =>
            {
                if (!string.IsNullOrWhiteSpace(settings.SampleText) || !string.IsNullOrWhiteSpace(settings.SampleInstruction)) { playOwnSample(v); return; }
                if (v != null && !string.IsNullOrEmpty(v.Preview) && System.IO.File.Exists(v.Preview)) { play(v.Preview); return; }
                if (!narratorReady) { say("This voice has no recording yet, and the narrator is still starting: try again in a moment."); return; }
                string id = v != null ? v.Id : "";
                work("Rendering a sample in this voice:", 15, () =>
                {
                    string json = side.Engine.Call("POST", "/preview", new JavaScriptSerializer().Serialize(
                        new Dictionary<string, object> { { "voice", id }, { "style", "" } }), 120000);
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                    win.Dispatcher.Invoke((Action)(() => play(Convert.ToString(d["file"]))));
                    say("");
                });
            };
            playVoice.Click += (s, e) => playSample(voiceBox.SelectedItem as VoiceItem);
            libPlay.Click += (s, e) => playSample(libList.SelectedItem as VoiceItem);

            // Right-click a Sample button: the line it says and how, saved at once with the narrator
            // settings, and the way back to the voice's own recording.
            Action<string, string> saveSample = (text, told) =>
            {
                settings.SampleText = text ?? "";
                settings.SampleInstruction = told ?? "";
                try
                {
                    var onDisk = QwenNarrator.LoadSettings(cacheDir);
                    onDisk.SampleText = settings.SampleText;
                    onDisk.SampleInstruction = settings.SampleInstruction;
                    QwenNarrator.SaveSettings(cacheDir, onDisk);
                }
                catch (Exception ex) { say("Could not save the sample: " + ex.Message); }
            };
            Func<FrameworkElement, ContextMenu> sampleMenu = owner2 =>
            {
                var m = new ContextMenu();
                var text = new MenuItem { Header = "Change sample text..." };
                var told = new MenuItem { Header = "Change sample instruction..." };
                var reset = new MenuItem { Header = "Use the default sample" };
                text.Click += (s, e) =>
                {
                    string t = ask("Sample text", "What Play sample says in each voice.", string.IsNullOrWhiteSpace(settings.SampleText) ? DefaultSample : settings.SampleText);
                    if (t == null) return;
                    saveSample(t.Trim() == DefaultSample ? "" : t.Trim(), settings.SampleInstruction);
                    say("Play sample now says your line.");
                };
                told.Click += (s, e) =>
                {
                    string t = ask("Sample instruction", "How the sample is said, e.g. angry and fast. Empty for none.", settings.SampleInstruction ?? "");
                    if (t == null) return;
                    saveSample(settings.SampleText, t.Trim());
                    say(t.Trim().Length == 0 ? "The sample is said with no instruction." : "The sample is said: " + t.Trim() + ".");
                };
                reset.Click += (s, e) => { saveSample("", ""); say("Play sample plays each voice's own recording again."); };
                m.Items.Add(text);
                m.Items.Add(told);
                m.Items.Add(reset);
                // Opened in a window of its own: handed the theme just before (see the voice list's menu).
                owner2.ContextMenuOpening += (s, e) =>
                {
                    var ms = owner2.TryFindResource(typeof(ContextMenu)) as Style;
                    var its = owner2.TryFindResource(typeof(MenuItem)) as Style;
                    if (ms != null && m.Style != ms) m.Style = ms;
                    if (its != null) m.ItemContainerStyle = its;
                    reset.IsEnabled = !string.IsNullOrWhiteSpace(settings.SampleText) || !string.IsNullOrWhiteSpace(settings.SampleInstruction);
                };
                return m;
            };
            playVoice.ContextMenu = sampleMenu(playVoice);
            libPlay.ContextMenu = sampleMenu(libPlay);
            // A disabled button gets no right-click; it is only disabled while something else runs.
            ContextMenuService.SetShowOnDisabled(playVoice, true);
            ContextMenuService.SetShowOnDisabled(libPlay, true);

            deleteVoice.Click += (s, e) =>
            {
                var v = libList.SelectedItem as VoiceItem;
                if (!removable(v)) return;
                // A voice in the Qwen narrator's folder is read by Breeze too: say it goes from both.
                bool shared = v.Source == "qwen" && haveBreeze && haveQwen;
                if (MessageBox.Show(win, "Delete the voice \"" + v.Name + "\"? "
                                    + (shared ? "It was made with the Qwen narrator and both narrators use it, so it goes from both. " : "")
                                    + "It goes to the Recycle Bin, so it can be restored from there; copies you exported are not touched. "
                                    + "Characters using it go back to the narrator's voice.",
                                    "Narrator", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
                string id = v.Id;
                bool both = side.Breeze && v.Source == "qwen";
                work("Deleting...", 0, () =>
                {
                    side.Engine.Call("POST", "/voices/delete", new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "id", id }, { "both", both } }), 10000);
                    loadVoices();
                    say("Deleted \"" + v.Name + "\".");
                });
            };

            // Export is the voice's own folder in one zip, written aside and moved into place so a
            // failed write never leaves half a file where the reader chose to keep their voice.
            exportVoice.Click += (s, e) =>
            {
                var v = libList.SelectedItem as VoiceItem;
                if (v == null || string.IsNullOrEmpty(v.Preview) || !System.IO.File.Exists(v.Preview)) return;
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
                        foreach (string f in new[] { "print.npy", "meta.json", "preview.wav", "design.wav", "reference.wav" })
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
                    Filter = "Saved voices (*.tzvoice, or print.npy or reference.wav in a voice folder)|*.tzvoice;print.npy;reference.wav"
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
                                side.Engine.Call("POST", "/voices/import", new JavaScriptSerializer().Serialize(
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

            // The candidates a design or a clone came back with, each with Play, a name and Keep.
            // Called off the UI thread with the narrator's answer.
            Action<string> showCandidates = json =>
            {
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
                                    var keptReply = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                                        side.Engine.Call("POST", "/voices/keep", new JavaScriptSerializer().Serialize(
                                            new Dictionary<string, object> { { "candidate", cid }, { "name", nm } }), 10000));
                                    string keptId = keptReply != null && keptReply.ContainsKey("id") ? Convert.ToString(keptReply["id"]) : "";
                                    loadVoices();
                                    // The new voice selected and in view: the list kept its old place, so a voice
                                    // filed mid-alphabet looked as if it had not been kept (2026-10-09).
                                    win.Dispatcher.Invoke((Action)(() =>
                                    {
                                        foreach (var listed in libList.Items)
                                        {
                                            var vi = listed as VoiceItem;
                                            if (vi == null || vi.Id != keptId) continue;
                                            libList.SelectedItem = vi;
                                            libList.ScrollIntoView(vi);
                                            break;
                                        }
                                    }));
                                    say("Kept \"" + nm + "\", selected in the list. Choose it on the Reading tab, or for a character on Cast.");
                                });
                            };
                            candidates.Children.Add(row(new UIElement[] { label, p, name, k }));
                        }
                    }));
            };

            design.Click += (s, e) =>
            {
                string desc = descBox.Text.Trim();
                if (desc.Length == 0) { say("Describe the voice first."); return; }
                candidates.Children.Clear();
                // Candidates are made with no style: what you hear is the voice itself, exactly
                // as narration will use it with the standard reading.
                string style = "";
                // Breeze: two candidates, each its one recording (about 27s). Qwen makes its three in one batch,
                // so fewer would not be quicker.
                int count = side.Breeze ? 2 : 3;
                work("Creating " + (count == 2 ? "two" : "three") + " candidates from your description. The graphics card is busy meanwhile.", side.Breeze ? 30 : 90, () =>
                {
                    showCandidates(side.Engine.Call("POST", "/design", new JavaScriptSerializer().Serialize(
                        new Dictionary<string, object> { { "description", desc }, { "count", count }, { "style", style } }), 300000));
                    say((count == 2 ? "Two" : "Three") + " candidates. Play them, then name and keep the one you want.");
                });
            };

            cloneFile.Click += (s, e) =>
            {
                var dlg = new Microsoft.Win32.OpenFileDialog
                {
                    Title = "A recording to clone the voice from",
                    Filter = "Recordings (*.wav, *.flac, *.ogg, *.mp3)|*.wav;*.flac;*.ogg;*.mp3"
                };
                if (dlg.ShowDialog(win) != true) return;
                clonePath = dlg.FileName;
                cloneFileName.Text = System.IO.Path.GetFileName(clonePath);
                cloneFileName.ToolTip = clonePath;
            };
            cloneGo.Click += (s, e) =>
            {
                if (clonePath == null) { say("Choose the recording first."); return; }
                string words = cloneWords.Text.Trim();
                if (words.Length == 0) { say("Type exactly what is said in the recording."); return; }
                string fromText = cloneFrom.Text.Trim(), toText = cloneTo.Text.Trim();
                double secs;
                if ((fromText.Length > 0 && !double.TryParse(fromText, out secs)) || (toText.Length > 0 && !double.TryParse(toText, out secs)))
                { say("From and to are seconds into the recording, such as 2.5; or leave them empty."); return; }
                candidates.Children.Clear();
                string path = clonePath;
                work("Cloning the voice from the recording:", 10, () =>
                {
                    var body = new Dictionary<string, object> { { "path", path }, { "transcript", words } };
                    if (fromText.Length > 0) body["start"] = fromText;
                    if (toText.Length > 0) body["end"] = toText;
                    showCandidates(side.Engine.Call("POST", "/voices/clone", new JavaScriptSerializer().Serialize(body), 120000));
                    say("Play the candidate, then name and keep it. If it does not sound like the recording, check that the words match it exactly.");
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
                    if (v != null) { if (side.Breeze) settings.BreezeVoice = v.Id; else settings.Voice = v.Id; }
                    settings.Instruction = instructionBox.Text.Trim();
                    settings.Cue = cueBox.Text.Trim().Length > 0 ? cueBox.Text.Trim() : QwenNarrator.DefaultCue;
                    settings.Direct = directBox.IsChecked == true;
                    settings.BreezeStrength = strengthSlider.Value;
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
                            cast.Strengths[r.Item1] = castStrengthOf(r.Item1);
                        }
                        else
                        {
                            cast.Voices.Remove(r.Item1);
                            cast.Names.Remove(r.Item1);
                            cast.Instructions.Remove(r.Item1);
                            cast.Strengths.Remove(r.Item1);
                        }
                    }
                    QwenNarrator.SaveCast(cacheDir, book, cast);
                    // The other narrator picked at the top: Read Aloud reads with it from now on.
                    if (side.Breeze != openedBreeze && narratorChosen != null) narratorChosen(side.Breeze);
                    openedBreeze = side.Breeze;
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
                if (side.Breeze != openedBreeze
                    || (v != null && v.Id != savedVoice()) || instructionBox.Text.Trim() != (settings.Instruction ?? "").Trim()
                    || cue != (settings.Cue ?? "").Trim() || (directBox.IsChecked == true) != settings.Direct
                    || Math.Abs(strengthSlider.Value - settings.BreezeStrength) > 0.01) return true;
                foreach (var r in castRows)
                {
                    string now = castRowVoice(r.Item3), was;
                    if (!cast.Voices.TryGetValue(r.Item1, out was)) was = "";
                    if (now != was) return true;
                    string sayNow = (r.Item4.Text ?? "").Trim(), sayWas;
                    if (!cast.Instructions.TryGetValue(r.Item1, out sayWas)) sayWas = "";
                    if (sayNow != sayWas.Trim()) return true;
                    double strengthWas;
                    if (!cast.Strengths.TryGetValue(r.Item1, out strengthWas)) strengthWas = QwenNarrator.CastStrengthDefault;
                    if (now.Length > 0 && Math.Abs(castStrengthOf(r.Item1) - strengthWas) > 0.01) return true;
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
                    foreach (bool breeze in new[] { false, true })
                    {
                        string dir = System.IO.Path.Combine(new Side { Breeze = breeze }.VoicesDir(cacheDir), "_candidates");
                        if (System.IO.Directory.Exists(dir)) System.IO.Directory.Delete(dir, true);
                    }
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
                DialogTheme.Apply(vw, win);
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
            // Breeze's list holds the Qwen narrator's voices as well as its own: each is read from
            // whichever folder has it, its own first.
            Action fillFromDisk = () =>
            {
                voices.Clear();
                string ownDir = side.VoicesDir(cacheDir), qwenDir = new Side { Breeze = false }.VoicesDir(cacheDir);
                foreach (var v in side.Breeze ? BreezeNarrator.SavedVoices(cacheDir) : QwenNarrator.SavedVoices(cacheDir))
                {
                    string dir = System.IO.Path.Combine(ownDir, v.Key);
                    bool mine = System.IO.Directory.Exists(dir);
                    if (!mine) dir = System.IO.Path.Combine(qwenDir, v.Key);
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
                        Preview = System.IO.File.Exists(prev) ? prev : "",
                        Mine = mine && v.Key != QwenNarrator.DefaultVoiceId && model == null,
                        Source = v.Key == QwenNarrator.DefaultVoiceId || model != null ? "builtin" : mine && side.Breeze ? "breeze" : "qwen"
                    });
                }
            };

            // The narrator is needed for everything else here: start it (a no-op when it is up), then list the voices.
            int startGen = 0;
            Action startSide = () =>
            {
                int gen = ++startGen;
                narratorReady = false;
                gateNarrator();
                Action<string> show = m => win.Dispatcher.BeginInvoke((Action)(() =>
                {
                    if (gen != startGen) return;
                    startLine.Text = m ?? "";
                    startLine.Visibility = string.IsNullOrEmpty(m) ? Visibility.Collapsed : Visibility.Visible;
                }));
                show("Starting the " + side.Name + " narrator...");
                var engine = side.Engine;
                Task.Run(() =>
                {
                    bool up = false;
                    try { up = engine.EnsureRunning(cacheDir, appDir, m => { if (!string.IsNullOrEmpty(m)) show(m); }, CancellationToken.None).Result; }
                    catch (Exception ex) { show("The narrator did not start: " + ex.Message); }
                    if (gen != startGen) return;
                    if (!up) { show("The narrator did not start, so Play, Design and Clone are not available now."); return; }
                    try { loadVoices(); } catch { }
                    win.Dispatcher.BeginInvoke((Action)(() =>
                    {
                        if (gen != startGen) return;
                        narratorReady = true;
                        foreach (var b in needNarrator) b.ToolTip = null;
                        if (busyWhat == null) foreach (var b in needNarrator) b.IsEnabled = true;
                        refreshLibButtons();
                        applyPlay();
                        startLine.Visibility = Visibility.Collapsed;
                    }));
                });
            };

            // What depends on which narrator is chosen: the voices, Design's wording, Clone.
            Action applySide = () =>
            {
                designNote.Text = side.Breeze ? "Age, accent, texture. Two candidates come back, in about half a minute."
                                              : "Age, accent, texture. Three candidates come back, in about a minute and a half.";
                design.Content = side.Breeze ? "Create 2 candidates" : "Create 3 candidates";
                clonePanel.IsEnabled = side.Breeze;
                breezePanel.IsEnabled = side.Breeze;
                foreach (var box in castStrengthBoxes.Values) box.IsEnabled = side.Breeze;
                breezePanel.Opacity = side.Breeze ? 1 : 0.5;
                breezeWhy.Visibility = side.Breeze ? Visibility.Collapsed : Visibility.Visible;
                clonePanel.Opacity = side.Breeze ? 1 : 0.5;
                cloneWhy.Visibility = side.Breeze ? Visibility.Collapsed : Visibility.Visible;
                candidates.Children.Clear();
                fillFromDisk();
                fillVoices();
                updateA();
            };
            applySide();

            if (pickQwen != null)
            {
                RoutedEventHandler switched = (s, e) =>
                {
                    bool breeze = pickBreeze.IsChecked == true;
                    if (breeze == side.Breeze) return;
                    // A trial in the other narrator's voice would go on playing from its folder.
                    if (playing != null) stopTrial();
                    side.Breeze = breeze;
                    applySide();
                    if (start) startSide();
                };
                pickQwen.Checked += switched;
                pickBreeze.Checked += switched;
            }

            if (start) startSide();

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
