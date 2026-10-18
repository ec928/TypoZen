using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace TypoZen
{
    /// <summary>One narrator voice as the picker and the short menu see it.</summary>
    internal sealed class VoiceEntry
    {
        public string Id, Name, Description, Gender, Role, Sample;
        public bool Favourite;
    }

    /// <summary>
    /// The narrators' voices, with what the reader has said about them: favourites, narrator or
    /// character, and the last few chosen. Shared by Qwen and Breeze, as their voices are, in
    /// voice-list.json beside narrator.json -- a file of its own, so Narrator Manager's Save,
    /// which rewrites narrator.json field by field, can never drop it.
    ///
    /// Breeze can make dozens of voices, and the Read Aloud menu listed every one (Ed,
    /// 2026-10-18). The menu now holds the voice in use, the favourites and the last five; the
    /// rest are in the picker (VoicePicker), searchable.
    /// </summary>
    internal static class VoiceList
    {
        public const int RecentKept = 5;

        private static string PathOf(string cacheDir) { return Path.Combine(QwenNarrator.RootDir(cacheDir), "voice-list.json"); }

        private sealed class Data
        {
            public List<string> Favourites = new List<string>();
            public Dictionary<string, string> Roles = new Dictionary<string, string>();
            public List<string> Recent = new List<string>();
        }

        private static Data Load(string cacheDir)
        {
            var r = new Data();
            var d = QwenNarrator.ReadJson(PathOf(cacheDir));
            object o;
            if (d.TryGetValue("favourites", out o) && o is IEnumerable && !(o is string))
                foreach (var x in (IEnumerable)o) if (x is string) r.Favourites.Add((string)x);
            if (d.TryGetValue("recent", out o) && o is IEnumerable && !(o is string))
                foreach (var x in (IEnumerable)o) if (x is string) r.Recent.Add((string)x);
            var roles = d.TryGetValue("roles", out o) ? o as Dictionary<string, object> : null;
            if (roles != null)
                foreach (var kv in roles) if (kv.Value is string) r.Roles[kv.Key] = (string)kv.Value;
            return r;
        }

        private static void Save(string cacheDir, Data data)
        {
            try
            {
                string path = PathOf(cacheDir);
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var d = new Dictionary<string, object>
                {
                    { "favourites", data.Favourites }, { "roles", data.Roles }, { "recent", data.Recent }
                };
                File.WriteAllText(path, QwenNarrator.FormatJson(new JavaScriptSerializer().Serialize(d)), Encoding.UTF8);
            }
            catch { }
        }

        /// <summary>A voice was chosen to read with: it goes to the front of the recent ones.</summary>
        public static void Used(string cacheDir, string id)
        {
            if (string.IsNullOrEmpty(id)) return;
            var d = Load(cacheDir);
            d.Recent.Remove(id);
            d.Recent.Insert(0, id);
            while (d.Recent.Count > 12) d.Recent.RemoveAt(d.Recent.Count - 1);
            Save(cacheDir, d);
        }

        public static List<string> Recent(string cacheDir) { return Load(cacheDir).Recent; }

        public static void SetFavourite(string cacheDir, string id, bool on)
        {
            var d = Load(cacheDir);
            d.Favourites.Remove(id);
            if (on) d.Favourites.Add(id);
            Save(cacheDir, d);
        }

        public static void SetRole(string cacheDir, string id, string role)
        {
            var d = Load(cacheDir);
            d.Roles[id] = role;
            Save(cacheDir, d);
        }

        /// <summary>Every voice this narrator can read in, with its gender, role, favourite mark and sample.</summary>
        public static List<VoiceEntry> Entries(string cacheDir, bool breeze)
        {
            var data = Load(cacheDir);
            var list = new List<VoiceEntry>();
            string ownDir = Path.Combine(breeze ? BreezeNarrator.RootDir(cacheDir) : QwenNarrator.RootDir(cacheDir), "voices");
            string qwenDir = Path.Combine(QwenNarrator.RootDir(cacheDir), "voices");
            foreach (var v in breeze ? BreezeNarrator.SavedVoices(cacheDir) : QwenNarrator.SavedVoices(cacheDir))
            {
                string dir = Path.Combine(ownDir, v.Key);
                if (!Directory.Exists(dir)) dir = Path.Combine(qwenDir, v.Key);
                var meta = QwenNarrator.ReadJson(Path.Combine(dir, "meta.json"));
                var model = Array.Find(QwenNarrator.ModelSpeakers, m => m[0] == v.Key);
                string desc = Str(meta, "description");
                if (desc.Length == 0)
                    desc = v.Key == QwenNarrator.DefaultVoiceId ? QwenNarrator.DefaultVoiceDescription : model != null ? model[2] : "";
                string role;
                if (!data.Roles.TryGetValue(v.Key, out role) || (role != "narrator" && role != "character"))
                    role = Str(meta, "made") == "archetype_generator" ? "character" : "narrator";
                string sample = "";
                foreach (string f in new[] { "preview.wav", "design.wav", "reference.wav" })
                    if (sample.Length == 0 && File.Exists(Path.Combine(dir, f))) sample = Path.Combine(dir, f);
                list.Add(new VoiceEntry
                {
                    Id = v.Key, Name = v.Value, Description = desc,
                    Gender = Gender(Str(meta, "gender"), desc + " " + v.Value),
                    Role = role, Sample = sample, Favourite = data.Favourites.Contains(v.Key)
                });
            }
            return list;
        }

        /// <summary>
        /// female, male, neutral, or "" when nothing says. The generated archetypes record it;
        /// for the reader's own voices the description usually says ("Female, around 35"). No guess
        /// beyond that: a voice whose words do not say is listed under any gender, not a wrong one.
        /// </summary>
        private static string Gender(string recorded, string words)
        {
            string g = (recorded ?? "").Trim().ToLowerInvariant();
            if (g == "female" || g == "male" || g == "neutral") return g;
            string w = (words ?? "").ToLowerInvariant();
            if (Regex.IsMatch(w, @"\b(female|woman|girl|lady|she|her)\b")) return "female";
            if (Regex.IsMatch(w, @"\b(male|man|boy|king|prince|he|his)\b")) return "male";
            if (Regex.IsMatch(w, @"\b(neutral|robot|robotic|alien|drone|android)\b")) return "neutral";
            return "";
        }

        private static string Str(Dictionary<string, object> d, string k)
        {
            object o;
            return d.TryGetValue(k, out o) && o is string ? ((string)o).Trim() : "";
        }
    }

    /// <summary>
    /// All voices: a narrator's whole library, searchable, opened from "All voices..." at the foot
    /// of its Read Aloud submenu (and so from the reading bar, whose voice button opens that menu).
    /// Choosing here is the same as choosing in the menu. Making, cloning and deleting voices stay
    /// in Narrator Manager ("Manage voices...").
    /// </summary>
    internal static class VoicePicker
    {
        public static void Show(Window owner, string cacheDir, bool breeze, string currentId,
                                Action<string, string> choose, Action manage)
        {
            var all = VoiceList.Entries(cacheDir, breeze);
            var w = new Window
            {
                Title = (breeze ? "Breeze" : "Qwen") + " voices", Width = 760, Height = 620, MinWidth = 560, MinHeight = 380,
                ShowInTaskbar = false, ResizeMode = ResizeMode.CanResizeWithGrip,
                WindowStartupLocation = owner != null ? WindowStartupLocation.CenterOwner : WindowStartupLocation.CenterScreen
            };
            try { w.Owner = owner; } catch { }
            DialogTheme.Apply(w, owner);
            var muted = w.TryFindResource("TzMuted") as Brush;
            var selected = w.TryFindResource("TzSelected") as Brush;

            var root = new DockPanel { Margin = new Thickness(16, 14, 16, 12) };

            // Top: the title and the search box.
            var top = new DockPanel { Margin = new Thickness(0, 0, 0, 10) };
            var searchCell = new Grid { Width = 260 };
            var search = new TextBox();
            var hint = new TextBlock { Text = "Search voices", Margin = new Thickness(8, 4, 0, 0), IsHitTestVisible = false, Foreground = muted };
            searchCell.Children.Add(search);
            searchCell.Children.Add(hint);
            DockPanel.SetDock(searchCell, Dock.Right);
            top.Children.Add(searchCell);
            top.Children.Add(new TextBlock { Text = (breeze ? "Breeze" : "Qwen") + " voices", FontSize = 16, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
            DockPanel.SetDock(top, Dock.Top);
            root.Children.Add(top);

            // Filters: what the voice is for, and its gender.
            string role = "narrator", gender = "";
            var chips = new WrapPanel { Margin = new Thickness(0, 0, 0, 10) };
            var roleChips = new List<Button>();
            var genderChips = new List<Button>();
            Action paintChips = () =>
            {
                foreach (var b in roleChips) b.Background = (string)b.Tag == role ? selected : (Brush)w.TryFindResource("TzButton");
                foreach (var b in genderChips) b.Background = (string)b.Tag == gender ? selected : (Brush)w.TryFindResource("TzButton");
            };
            Action refill = null;
            Func<string, string, bool, Button> chip = (text, tag, isRole) =>
            {
                var b = new Button { Content = text, Tag = tag, Margin = new Thickness(0, 0, 6, 0), Padding = new Thickness(12, 3, 12, 3) };
                b.Click += (s, e) => { if (isRole) role = tag; else gender = tag; paintChips(); refill(); };
                (isRole ? roleChips : genderChips).Add(b);
                chips.Children.Add(b);
                return b;
            };
            chip("Narrator", "narrator", true);
            chip("Character", "character", true);
            chip("All", "", true);
            chips.Children.Add(new Border { Width = 14 });
            chip("Any gender", "", false);
            chip("Female", "female", false);
            chip("Male", "male", false);
            chip("Neutral", "neutral", false);
            DockPanel.SetDock(chips, Dock.Top);
            root.Children.Add(chips);

            // Footer: Manage voices on the left; the count; Use voice and Close.
            var footer = new DockPanel { Margin = new Thickness(0, 10, 0, 0) };
            var manageBtn = new Button { Content = "Manage voices..." };
            DockPanel.SetDock(manageBtn, Dock.Left);
            footer.Children.Add(manageBtn);
            var right = new StackPanel { Orientation = Orientation.Horizontal };
            var useBtn = new Button { Content = "Use voice", IsDefault = true, Margin = new Thickness(0, 0, 8, 0), MinWidth = 90 };
            var closeBtn = new Button { Content = "Close", IsCancel = true, MinWidth = 80 };
            right.Children.Add(useBtn);
            right.Children.Add(closeBtn);
            DockPanel.SetDock(right, Dock.Right);
            footer.Children.Add(right);
            var count = new TextBlock { Foreground = muted, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) };
            footer.Children.Add(count);
            DockPanel.SetDock(footer, Dock.Bottom);
            root.Children.Add(footer);

            var list = new ListBox { HorizontalContentAlignment = HorizontalAlignment.Stretch };
            ScrollViewer.SetHorizontalScrollBarVisibility(list, ScrollBarVisibility.Disabled);
            root.Children.Add(list);
            w.Content = root;

            System.Windows.Media.MediaPlayer player = null;
            Action stop = () => { try { if (player != null) { player.Stop(); player.Close(); } } catch { } player = null; };
            Action<string> play = path =>
            {
                stop();
                try { player = new System.Windows.Media.MediaPlayer(); player.Open(new Uri(path)); player.Play(); } catch { }
            };

            // What to do once the window has gone: choosing or managing runs after it, not
            // inside it, so Narrator Manager is never opened on top of a closing dialog.
            Action after = null;
            Action<VoiceEntry> pick = e =>
            {
                if (e == null) return;
                stop();
                after = () => choose(e.Id, e.Name);
                w.Close();
            };

            Func<VoiceEntry, ListBoxItem> rowOf = e =>
            {
                var g = new Grid { Margin = new Thickness(0, 2, 0, 2) };
                foreach (var width in new[] { GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto, GridLength.Auto, GridLength.Auto, new GridLength(22) })
                    g.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
                var star = new Button { Content = e.Favourite ? "★" : "☆", Padding = new Thickness(6, 0, 6, 0), Margin = new Thickness(0, 0, 8, 0),
                                        ToolTip = "Favourite: kept in the Read Aloud menu", VerticalAlignment = VerticalAlignment.Center };
                star.Click += (s, a) => { e.Favourite = !e.Favourite; VoiceList.SetFavourite(cacheDir, e.Id, e.Favourite); star.Content = e.Favourite ? "★" : "☆"; };
                Grid.SetColumn(star, 0);
                var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
                text.Children.Add(new TextBlock { Text = e.Name, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis });
                if (e.Description.Length > 0)
                    text.Children.Add(new TextBlock { Text = Regex.Replace(e.Description, @"\s+", " "), Foreground = muted, FontSize = 11.5,
                                                      TextTrimming = TextTrimming.CharacterEllipsis, TextWrapping = TextWrapping.NoWrap, ToolTip = e.Description });
                Grid.SetColumn(text, 1);
                var tags = new TextBlock { Text = e.Gender, Foreground = muted, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 10, 0), MinWidth = 48 };
                Grid.SetColumn(tags, 2);
                var roleBtn = new Button { Content = e.Role, MinWidth = 78, Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center,
                                           ToolTip = "Narrator voices are for reading a book; character voices are for a cast. Click to change." };
                roleBtn.Click += (s, a) =>
                {
                    e.Role = e.Role == "narrator" ? "character" : "narrator";
                    VoiceList.SetRole(cacheDir, e.Id, e.Role);
                    roleBtn.Content = e.Role;
                };
                Grid.SetColumn(roleBtn, 3);
                var sampleBtn = new Button { Content = "▶ Sample", IsEnabled = e.Sample.Length > 0, VerticalAlignment = VerticalAlignment.Center,
                                             ToolTip = e.Sample.Length > 0 ? "Plays this voice's sample." : "This voice has no sample on disk." };
                sampleBtn.Click += (s, a) => play(e.Sample);
                Grid.SetColumn(sampleBtn, 4);
                var tick = new TextBlock { Text = e.Id == currentId ? "✓" : "", FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center,
                                           ToolTip = e.Id == currentId ? "The voice in use" : null };
                Grid.SetColumn(tick, 5);
                foreach (UIElement c in new UIElement[] { star, text, tags, roleBtn, sampleBtn, tick }) g.Children.Add(c);
                var item = new ListBoxItem { Content = g, Tag = e };
                item.MouseDoubleClick += (s, a) => { if (!(a.OriginalSource is DependencyObject) || !IsInButton((DependencyObject)a.OriginalSource)) pick(e); };
                return item;
            };

            refill = () =>
            {
                string q = (search.Text ?? "").Trim().ToLowerInvariant();
                hint.Visibility = q.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                list.Items.Clear();
                ListBoxItem current = null;
                foreach (var e in all)
                {
                    // The voice in use is always listed, whatever the filters, so its tick is never lost.
                    bool isCurrent = e.Id == currentId;
                    if (!isCurrent && role.Length > 0 && e.Role != role) continue;
                    if (!isCurrent && gender.Length > 0 && e.Gender != gender) continue;
                    if (q.Length > 0 && (e.Name + " " + e.Description).ToLowerInvariant().IndexOf(q, StringComparison.Ordinal) < 0) continue;
                    var item = rowOf(e);
                    list.Items.Add(item);
                    if (isCurrent) current = item;
                }
                count.Text = list.Items.Count + " of " + all.Count + " voices";
                if (current != null) list.SelectedItem = current;
                else if (list.Items.Count > 0) list.SelectedIndex = 0;
                if (list.SelectedItem != null) list.ScrollIntoView(list.SelectedItem);
                useBtn.IsEnabled = list.Items.Count > 0;
            };

            search.TextChanged += (s, e) => refill();
            search.PreviewKeyDown += (s, e) =>
            {
                // From the search box, Down moves into the list; Enter uses the selected voice.
                if (e.Key == Key.Down && list.Items.Count > 0) { list.Focus(); e.Handled = true; }
            };
            useBtn.Click += (s, e) => { var it = list.SelectedItem as ListBoxItem; pick(it != null ? it.Tag as VoiceEntry : null); };
            closeBtn.Click += (s, e) => w.Close();
            manageBtn.Click += (s, e) => { stop(); after = manage; w.Close(); };
            w.Closed += (s, e) => stop();
            w.Loaded += (s, e) => { search.Focus(); };

            paintChips();
            refill();
            w.ShowDialog();
            if (after != null) after();
        }

        private static bool IsInButton(DependencyObject d)
        {
            while (d != null)
            {
                if (d is Button) return true;
                d = d is Visual || d is System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(d) : LogicalTreeHelper.GetParent(d);
            }
            return false;
        }
    }
}
