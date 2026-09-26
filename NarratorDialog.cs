using System;
using System.Collections.Generic;
using System.Media;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace TypoZen
{
    /// <summary>
    /// File > Read Aloud > Narrator settings: the Qwen narrator's voice, what it is told, emotion
    /// cues, a place to try all of it on your own text, new voices designed from a description,
    /// and this book's cast.
    ///
    /// Everything is words, not sliders. A voice is made by describing it; the narrator renders
    /// three candidates, because the same words make a slightly different person each time, and
    /// keeping one saves its voice-print so it is that same person from then on. The instruction
    /// is shown whole and edited as it stands -- nothing hidden is added to it -- with presets as
    /// starting points and the reader's own saved beside them. Try it reads text through
    /// narration's own preparation and can keep one reading to compare against the next, so a
    /// setting is judged by ear rather than assumed. The cast gives this book's characters voices
    /// of their own from the same library.
    ///
    /// The narrator does the work over its loopback API; this window only asks and plays what
    /// comes back. Calls that take time run off the UI thread and say what they are doing.
    /// </summary>
    internal static class NarratorDialog
    {
        /// <summary>Set while the dialog is open: the page's answer to a cast scan (host_narrator_cast).</summary>
        public static Action<string> CastScanArrived;

        private sealed class VoiceItem
        {
            public string Id;
            public string Name;
            public string Description;
            public string Preview;
            public override string ToString() { return Name; }
        }

        /// <summary>Set while the dialog is open: the page's answers to Try it (host_narrator_trial).</summary>
        public static Action<string> TrialArrived;

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
        // the things the settings above change is in it. Kept for the session once edited.
        private static string _sample =
            "The rain had not stopped for three days, and the harbour lights were smeared across the black water. Mara pushed the door open and stood there, dripping.\r\n"
            + "“You said you’d be back by Tuesday,” Tom said quietly. “It’s Friday.”\r\n"
            + "“I know,” she snapped. “The ferry cost me £86 and it still ran four hours late.”";

        public static void Show(Window owner, string cacheDir, string appDir, string book, Action<string> sendToPage, Action saved)
        {
            var settings = QwenNarrator.LoadSettings(cacheDir);
            var cast = QwenNarrator.LoadCast(cacheDir, book);
            var voices = new List<VoiceItem>();
            SoundPlayer player = null;
            Trial kept = null;              // Try it: the reading kept for comparison

            var win = new Window
            {
                Title = "Narrator",
                Width = 660,
                SizeToContent = SizeToContent.Height,
                MaxHeight = 900,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                ResizeMode = ResizeMode.NoResize,
                ShowInTaskbar = false,
                Background = owner != null ? owner.Background : null,
                Foreground = owner != null ? owner.Foreground : null
            };
            try { win.Owner = owner; } catch { }

            var root = new StackPanel { Margin = new Thickness(18) };
            var scroll = new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = 860 };
            Func<string, TextBlock> heading = t => new TextBlock { Text = t, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 14, 0, 4) };
            Func<string, TextBlock> note = t => new TextBlock { Text = t, TextWrapping = TextWrapping.Wrap, Opacity = 0.75, Margin = new Thickness(0, 0, 0, 6) };
            Func<string, Button> button = t => new Button { Content = t, Padding = new Thickness(10, 2, 10, 2), Height = 26, Margin = new Thickness(0, 0, 6, 0) };
            Func<UIElement[], StackPanel> row = items =>
            {
                var p = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 2) };
                foreach (var i in items) p.Children.Add(i);
                return p;
            };
            // What is happening, pinned under the scrolling part so it is in view whichever
            // button was pressed: a busy bar and a clock while the narrator works.
            var status = new TextBlock { TextWrapping = TextWrapping.Wrap, Opacity = 0.9 };
            var busyBar = new ProgressBar { IsIndeterminate = true, Height = 4, Margin = new Thickness(0, 0, 0, 6), Visibility = Visibility.Collapsed };
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

            // ---- the narrator's voice
            root.Children.Add(heading("Narrator voice"));
            var voiceBox = new ComboBox { Width = 330, Margin = new Thickness(0, 0, 6, 0) };
            var voiceDesc = note("");
            // The take heard when the voice was designed, not narration: that is Try it, below.
            var playVoice = button("Play original sample");
            var deleteVoice = button("Delete");
            root.Children.Add(row(new UIElement[] { voiceBox, playVoice, deleteVoice }));
            root.Children.Add(voiceDesc);
            // A designed voice cannot be made again -- the same description gives a different
            // person -- so it has to be something the reader can keep where they like and bring
            // back, not only a folder of the extension's they would have to know about.
            var exportVoice = button("Export...");
            var importVoice = button("Import...");
            root.Children.Add(row(new UIElement[] { exportVoice, importVoice }));
            root.Children.Add(note("Export saves the chosen voice as one .tzvoice file wherever you like; Import brings one back, on this PC or another."));

            // ---- what the narrator is told: all of it, in the open (QwenNarrator, Settings)
            root.Children.Add(heading("What the narrator is told"));
            root.Children.Add(note("The whole instruction the narrator reads each paragraph by. Nothing is added to it except an emotion cue, and only if you tick that below. Start from a preset or write your own. These words can change how the voice itself sounds, so try them below before saving. Applies to text narrated from now on."));
            var presetBox = new ComboBox { Width = 330, Margin = new Thickness(0, 0, 6, 0) };
            var deletePreset = button("Delete preset");
            root.Children.Add(row(new UIElement[] { new TextBlock { Text = "Start from", Width = 80, VerticalAlignment = VerticalAlignment.Center }, presetBox, deletePreset }));
            var instructionBox = new TextBox { Text = settings.Instruction, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Height = 70, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Margin = new Thickness(0, 4, 0, 0) };
            root.Children.Add(instructionBox);
            var presetName = new TextBox { Width = 330, Margin = new Thickness(0, 0, 6, 0), VerticalContentAlignment = VerticalAlignment.Center };
            var savePreset = button("Save as preset");
            root.Children.Add(row(new UIElement[] { new TextBlock { Text = "Name", Width = 80, VerticalAlignment = VerticalAlignment.Center }, presetName, savePreset }));

            // ---- emotion cues: off unless ticked, and their wording editable too
            root.Children.Add(heading("Emotion"));
            root.Children.Add(note("The narrator judges the emotion of each scene from the text itself."));
            var directBox = new CheckBox
            {
                Content = "Also add a cue to lines tagged with how they are said (\"she whispered\" adds: whispered, hushed)",
                IsChecked = settings.Direct, Foreground = win.Foreground, Margin = new Thickness(0, 2, 0, 0)
            };
            root.Children.Add(directBox);
            var cueBox = new TextBox { Text = settings.Cue, TextWrapping = TextWrapping.Wrap, AcceptsReturn = false, Height = 40, Margin = new Thickness(22, 4, 0, 0), IsEnabled = settings.Direct };
            root.Children.Add(cueBox);
            var cueNote = note("The cue's wording, added after the instruction above; {cue} becomes the cue itself.");
            cueNote.Margin = new Thickness(22, 2, 0, 6);
            root.Children.Add(cueNote);
            directBox.Checked += (s, e) => cueBox.IsEnabled = true;
            directBox.Unchecked += (s, e) => cueBox.IsEnabled = false;

            // ---- try it: the reader's own text, through narration's own path
            root.Children.Add(heading("Try it"));
            root.Children.Add(note("Read with the settings on this screen, saved or not, and prepared exactly as narration prepares text: numbers as words, cues if ticked, long paragraphs cut. Each line is a paragraph. To compare, keep one reading, change anything above, then play each in turn."));
            var sampleBox = new TextBox { Text = _sample, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Height = 92, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            root.Children.Add(sampleBox);
            var playTry = button("Play");
            var stopTry = button("Stop");
            var useSelection = button("Use text selected in the document");
            var trialRow = row(new UIElement[] { playTry, stopTry, useSelection });
            trialRow.Margin = new Thickness(0, 6, 0, 2);
            root.Children.Add(trialRow);
            var keepTry = button("Keep these settings for comparison");
            var playKept = button("Play kept");
            playKept.IsEnabled = false;
            root.Children.Add(row(new UIElement[] { keepTry, playKept }));
            var keptLabel = note("");
            root.Children.Add(keptLabel);
            root.Children.Add(note("What the narrator was told, piece by piece, for the last reading:"));
            var toldBox = new TextBox
            {
                IsReadOnly = true, TextWrapping = TextWrapping.Wrap, Height = 110, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                FontSize = 11.5, Opacity = 0.85
            };
            root.Children.Add(toldBox);

            // ---- designing a voice
            root.Children.Add(heading("New voice"));
            root.Children.Add(note("Describe a voice: who they are, age, accent, texture. Three candidates come back, read by the narrator as it will sound; keep the one you like. About a minute and a half."));
            var descBox = new TextBox { TextWrapping = TextWrapping.Wrap, AcceptsReturn = false, Height = 44, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            root.Children.Add(descBox);
            var design = button("Create 3 candidates");
            design.HorizontalAlignment = HorizontalAlignment.Left;
            design.Margin = new Thickness(0, 6, 0, 0);
            root.Children.Add(design);
            var candidates = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
            root.Children.Add(candidates);

            // ---- cast
            var castRows = new List<Tuple<string, string, ComboBox>>();     // key, name, choice
            var castPanel = new StackPanel();
            Button findCast = null;
            if (!string.IsNullOrEmpty(book))
            {
                root.Children.Add(heading("Cast for this book"));
                root.Children.Add(note("Give characters voices of their own; their lines are then spoken in that voice and the narrator reads the rest. Characters left on the narrator's voice stay with the narrator. Who speaks is read from the text (\"said Ferbin\"), so an untagged or ambiguous line stays with the narrator. A character's line is told only: \"Speak this line of dialogue as the character would say it, naturally and in character.\""));
                if (QwenNarrator.PrivateMode)
                    root.Children.Add(note("Privacy Mode is on: this book's cast is kept until TypoZen closes and is not saved to disk."));
                findCast = button("Find characters");
                findCast.HorizontalAlignment = HorizontalAlignment.Left;
                root.Children.Add(findCast);
                root.Children.Add(castPanel);
            }

            var save = new Button { Content = "Save", Width = 90, Height = 26, IsDefault = true, Margin = new Thickness(0, 0, 8, 0) };
            var cancel = new Button { Content = "Cancel", Width = 90, Height = 26, IsCancel = true };
            var buttons = row(new UIElement[] { save, cancel });
            buttons.HorizontalAlignment = HorizontalAlignment.Right;
            buttons.Margin = new Thickness(0, 10, 0, 0);
            var footer = new StackPanel { Margin = new Thickness(18, 6, 18, 14) };
            footer.Children.Add(busyBar);
            footer.Children.Add(status);
            var keptNow = note("Voices and presets are kept as soon as you make them. Save applies the rest; Cancel leaves it as it was.");
            keptNow.Margin = new Thickness(0, 8, 0, 0);
            footer.Children.Add(keptNow);
            footer.Children.Add(buttons);
            var outer = new DockPanel();
            DockPanel.SetDock(footer, Dock.Bottom);
            outer.Children.Add(footer);
            outer.Children.Add(scroll);
            scroll.MaxHeight = 760;
            win.Content = outer;

            // ---- behaviour
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

            Action fillVoices = () =>
            {
                string keep = voiceBox.SelectedItem is VoiceItem ? ((VoiceItem)voiceBox.SelectedItem).Id : settings.Voice;
                voiceBox.Items.Clear();
                foreach (var v in voices) voiceBox.Items.Add(v);
                voiceBox.SelectedIndex = voices.Count > 0 ? 0 : -1;
                for (int i = 0; i < voices.Count; i++) if (voices[i].Id == keep) voiceBox.SelectedIndex = i;
                // The cast pickers are rebuilt with the new list, keeping each choice.
                var old = new List<Tuple<string, string, ComboBox>>(castRows);
                castRows.Clear();
                castPanel.Children.Clear();
                foreach (var r in old)
                {
                    var sel = r.Item3.SelectedItem as VoiceItem;
                    addCastRow(r.Item1, r.Item2, sel != null ? sel.Id : "");
                }
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

            voiceBox.SelectionChanged += (s, e) =>
            {
                var v = voiceBox.SelectedItem as VoiceItem;
                voiceDesc.Text = v != null ? v.Description : "";
                deleteVoice.IsEnabled = v != null && !string.IsNullOrEmpty(v.Preview);
                exportVoice.IsEnabled = deleteVoice.IsEnabled;     // the built-in voice ships with TypoZen
            };

            // Anything that needs the narrator goes through here: off the UI thread, with the
            // buttons that would start another such call disabled until it is done.
            var busyButtons = new List<Button> { playVoice, deleteVoice, design, importVoice, playTry };
            if (findCast != null) busyButtons.Add(findCast);
            // `expect` is the usual time in seconds, shown against a running clock; 0 for none.
            Action<string, double, Action> work = (what, expect, job) =>
            {
                foreach (var b in busyButtons) b.IsEnabled = false;
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
                            // Delete and Export stay off for the built-in voice, which ships
                            // with TypoZen; re-enabling every button left them live on it.
                            var sv = voiceBox.SelectedItem as VoiceItem;
                            deleteVoice.IsEnabled = exportVoice.IsEnabled = sv != null && !string.IsNullOrEmpty(sv.Preview);
                            playKept.IsEnabled = kept != null;
                        }));
                    }
                });
            };

            // ---- presets: the built-in starting points, then the reader's own
            var presetItems = new List<PresetItem>();
            bool syncing = false;
            Action<string> fillPresets = select =>
            {
                presetItems.Clear();
                foreach (var kv in QwenNarrator.BuiltInPresets) presetItems.Add(new PresetItem { Name = kv.Key, Text = kv.Value });
                foreach (var kv in QwenNarrator.LoadPresets(cacheDir)) presetItems.Add(new PresetItem { Name = kv.Key, Text = kv.Value, Mine = true });
                syncing = true;
                presetBox.Items.Clear();
                foreach (var p in presetItems) presetBox.Items.Add(p);
                syncing = false;
                // The preset the box's text is, if any: which one is in use shows, and an edit
                // shows as no preset rather than as the one it started from.
                string text = instructionBox.Text.Trim();
                PresetItem hit = presetItems.Find(p => p.Name == select && p.Text.Trim() == text) ?? presetItems.Find(p => p.Text.Trim() == text);
                syncing = true;
                presetBox.SelectedItem = hit;
                syncing = false;
                var sel = presetBox.SelectedItem as PresetItem;
                deletePreset.IsEnabled = sel != null && sel.Mine;
            };
            presetBox.SelectionChanged += (s, e) =>
            {
                var p = presetBox.SelectedItem as PresetItem;
                deletePreset.IsEnabled = p != null && p.Mine;
                if (syncing || p == null) return;
                syncing = true;
                instructionBox.Text = p.Text;
                syncing = false;
                if (p.Mine) presetName.Text = p.Name;
            };
            instructionBox.TextChanged += (s, e) =>
            {
                if (syncing) return;
                var p = presetBox.SelectedItem as PresetItem;
                string text = instructionBox.Text.Trim();
                if (p != null && p.Text.Trim() == text) return;
                var hit = presetItems.Find(x => x.Text.Trim() == text);
                syncing = true;
                presetBox.SelectedItem = hit;
                syncing = false;
                deletePreset.IsEnabled = hit != null && hit.Mine;
            };
            savePreset.Click += (s, e) =>
            {
                string name = presetName.Text.Trim();
                if (name.Length == 0) { say("Give the preset a name first."); return; }
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
                    say((at >= 0 ? "Updated" : "Saved") + " the preset \"" + name + "\".");
                }
                catch (Exception ex) { say("Could not save the preset: " + ex.Message); }
            };
            deletePreset.Click += (s, e) =>
            {
                var p = presetBox.SelectedItem as PresetItem;
                if (p == null || !p.Mine) return;
                if (MessageBox.Show(win, "Delete the preset \"" + p.Name + "\"? The text in the box stays as it is.", "Narrator",
                                    MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
                try
                {
                    var mine = QwenNarrator.LoadPresets(cacheDir);
                    mine.RemoveAll(kv => kv.Key == p.Name);
                    QwenNarrator.SavePresets(cacheDir, mine);
                    fillPresets(null);
                    say("Deleted the preset \"" + p.Name + "\".");
                }
                catch (Exception ex) { say("Could not delete the preset: " + ex.Message); }
            };
            fillPresets(null);

            // ---- try it: the page prepares and plays the text (narrationTrial, 09-speech.js), so
            // it goes through what narration does; this side chooses the settings and shows what
            // the narrator was told.
            TaskCompletionSource<string> pendingTrial = null;
            Func<Trial> current = () =>
            {
                var v = voiceBox.SelectedItem as VoiceItem;
                var p = presetBox.SelectedItem as PresetItem;
                string instr = instructionBox.Text.Trim();
                string words = instr.Length == 0 ? "no instruction"
                             : p != null ? "\"" + p.Name + "\""
                             : "your own instruction (" + instr.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).Length + " words)";
                return new Trial
                {
                    Voice = v != null ? v.Id : settings.Voice,
                    VoiceName = v != null ? v.Name : "the narrator's voice",
                    Instruction = instr,
                    Cue = cueBox.Text.Trim().Length > 0 ? cueBox.Text.Trim() : QwenNarrator.DefaultCue,
                    Direct = directBox.IsChecked == true,
                    Label = (v != null ? v.Name : "narrator's voice") + ", " + words + ", cues " + (directBox.IsChecked == true ? "on" : "off")
                };
            };
            Action<Trial> runTrial = t =>
            {
                string text = sampleBox.Text;
                if (text.Trim().Length == 0) { say("Type or paste something to read first."); return; }
                _sample = text;
                string json = new JavaScriptSerializer().Serialize(new Dictionary<string, object>
                {
                    { "base", QwenNarrator.BaseUrl }, { "text", text }, { "voice", t.Voice },
                    { "instruction", t.Instruction }, { "cue", t.Cue }, { "direct", t.Direct }
                });
                work("Reading it with " + t.Label + ":", 15, () =>
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
                    string last = null;
                    double secs = 0;
                    int n = 0;
                    foreach (var o in (d["pieces"] as System.Collections.IEnumerable) ?? new object[0])
                    {
                        var piece = (Dictionary<string, object>)o;
                        string ptext = Convert.ToString(piece["text"]), cue = Convert.ToString(piece["cue"]), ins = Convert.ToString(piece["instruction"]);
                        secs += Convert.ToDouble(piece["seconds"]);
                        sb.Append(++n).Append(". ").Append(ptext.Length > 70 ? ptext.Substring(0, 70) + "..." : ptext);
                        if (cue.Length > 0) sb.Append("   [cue: ").Append(cue).Append("]");
                        sb.Append("\r\n    ").Append(ins == last ? "(the same as above)" : ins.Length == 0 ? "(no instruction)" : ins).Append("\r\n");
                        last = ins;
                    }
                    win.Dispatcher.Invoke((Action)(() => toldBox.Text = sb.ToString()));
                    say("Playing " + t.Label + " (" + secs.ToString("0") + "s).");
                });
            };
            playTry.Click += (s, e) => runTrial(current());
            playKept.Click += (s, e) => { if (kept != null) runTrial(kept); };
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
                playKept.IsEnabled = playTry.IsEnabled;
                keptLabel.Text = "Kept for comparison: " + kept.Label + ".";
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

            // A kept voice plays the recording that was picked -- the same take heard as its
            // candidate. Rendering a fresh one here, with whatever style was in the box, is
            // what made "the voice I picked" sound like someone else (2026-09-23).
            playVoice.Click += (s, e) =>
            {
                var v = voiceBox.SelectedItem as VoiceItem;
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

            deleteVoice.Click += (s, e) =>
            {
                var v = voiceBox.SelectedItem as VoiceItem;
                if (v == null || string.IsNullOrEmpty(v.Preview)) return;
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
                var v = voiceBox.SelectedItem as VoiceItem;
                if (v == null || string.IsNullOrEmpty(v.Preview)) return;
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
                        + (any ? " Choose it in the lists above or below to use it." : ""));
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
                            var p = button("Play");
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
                                    say("Kept \"" + nm + "\". Choose it above for the narrator, or below for a character. "
                                        + "Export it to keep a copy of your own.");
                                });
                            };
                            candidates.Children.Add(row(new UIElement[] { label, p, name, k }));
                        }
                    }));
                    say("Three candidates, read by the narrator as each would sound. Play them, then name and keep the one you want.");
                });
            };

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
                voices.Add(new VoiceItem
                {
                    Id = v.Key, Name = v.Value,
                    Description = meta.TryGetValue("description", out d) ? Convert.ToString(d) : "",
                    Preview = System.IO.File.Exists(prev) ? prev : ""
                });
            }
            fillVoices();

            // The narrator is needed for everything else here: start it (a no-op when it is up), then list the voices.
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
            win.ShowDialog();
        }
    }
}

