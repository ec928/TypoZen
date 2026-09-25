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
    /// File > Read Aloud > Narrator settings: the Qwen narrator's voice, how it reads, new voices
    /// designed from a description, and this book's cast.
    ///
    /// Everything is words, not sliders. A voice is made by describing it; the narrator renders
    /// three candidates, because the same words make a slightly different person each time, and
    /// keeping one saves its voice-print so it is that same person from then on. Style is how
    /// the narrator reads ("warmer, a little brisker"). The cast gives this book's characters
    /// voices of their own from the same library.
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

        private static readonly Dictionary<string, string> StylePresets = new Dictionary<string, string>
        {
            { "Measured", "" },
            { "Warm", "Warm and close, as if reading to one listener, unhurried, with a gentle smile in the voice where the text allows." },
            { "Brisk", "Brisk and clear, keeping the story moving, crisp at the ends of sentences, never rushed." },
            { "Dramatic", "Vivid and engaged, giving tension and emotion their full weight, with bold contrasts between quiet and intense moments." }
        };

        public static void Show(Window owner, string cacheDir, string appDir, string book, Action<string> sendToPage, Action saved)
        {
            var settings = QwenNarrator.LoadSettings(cacheDir);
            var cast = QwenNarrator.LoadCast(cacheDir, book);
            var voices = new List<VoiceItem>();
            SoundPlayer player = null;

            var win = new Window
            {
                Title = "Narrator",
                Width = 620,
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
            var playVoice = button("Play sample");
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

            // ---- style
            root.Children.Add(heading("How the narrator reads"));
            root.Children.Add(note("In your own words, or start from one of these. Empty is the standard measured reading, and keeps each voice exactly as you picked it: style words can change how the voice itself sounds. Applies to text narrated from now on."));
            var styleBox = new TextBox { Text = settings.Style, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, Height = 52, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            root.Children.Add(styleBox);
            var presets = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
            foreach (var kv in StylePresets)
            {
                var b = button(kv.Key);
                string text = kv.Value;
                b.Click += (s, e) => styleBox.Text = text;
                presets.Children.Add(b);
            }
            var previewStyle = button("Preview voice and style");
            presets.Children.Add(previewStyle);
            root.Children.Add(presets);

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
                root.Children.Add(note("Give characters voices of their own; their lines are then spoken in that voice and the narrator reads the rest. Characters left on the narrator's voice stay with the narrator. Who speaks is read from the text (\"said Ferbin\"), so an untagged or ambiguous line stays with the narrator."));
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
            var busyButtons = new List<Button> { playVoice, deleteVoice, previewStyle, design, importVoice };
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
                        }));
                    }
                });
            };

            Func<string> currentStyle = () => (string)win.Dispatcher.Invoke((Func<string>)(() => styleBox.Text.Trim()));
            Func<string> currentVoice = () => (string)win.Dispatcher.Invoke((Func<string>)(() =>
                voiceBox.SelectedItem is VoiceItem ? ((VoiceItem)voiceBox.SelectedItem).Id : ""));

            Action preview = () =>
            {
                string json = QwenNarrator.Call("POST", "/preview",
                    new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "voice", currentVoice() }, { "style", currentStyle() } }), 120000);
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                win.Dispatcher.Invoke((Action)(() => play(Convert.ToString(d["file"]))));
                say("");
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
            previewStyle.Click += (s, e) => work("Rendering a sample with this voice and style:", 15, preview);

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
                    settings.Style = styleBox.Text.Trim();
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

            win.Closed += (s, e) => { CastScanArrived = null; try { if (player != null) player.Stop(); } catch { } };
            win.ShowDialog();
        }
    }
}

