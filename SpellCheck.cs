using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Markup;

namespace TypoZen
{
    /// <summary>
    /// Spelling via WPF's built-in checker (PresentationFramework), not WordNet.
    ///
    /// WordNet lemmas (Look up) are not a spell list: they do not know "teh" from "the",
    /// and using them as one would underline every inflection. WPF ships English / French
    /// / German / Spanish dictionaries with .NET 4, so this works even when the Windows
    /// ISpellChecker COM factory is not registered.
    ///
    /// Must be called on the UI thread — the host already is, inside WebMessageReceived.
    /// </summary>
    internal static class WindowsSpell
    {
        public sealed class Hit
        {
            public int Start;
            public int Length;
            public string Word;
            public string[] Suggestions;
        }

        const int MaxTextChars = 8000;
        const int MaxSuggestions = 5;
        const int MaxHits = 40;

        static TextBox _box;
        static bool _tried;
        static string _userWordsPath;
        static string _lexPath;
        static string _lastError = "";
        static readonly HashSet<string> _userWords =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public static bool Available
        {
            get { Ensure(); return _box != null; }
        }

        public static string LastError { get { Ensure(); return _lastError ?? ""; } }

        public static void ConfigureUserWords(string path)
        {
            _userWordsPath = path;
            try
            {
                if (!string.IsNullOrEmpty(path) && File.Exists(path))
                {
                    foreach (string line in File.ReadAllLines(path, Encoding.UTF8))
                    {
                        string w = (line ?? "").Trim();
                        if (w.Length >= 2 && w[0] != '#') _userWords.Add(w);
                    }
                }
            }
            catch { }
            Ensure();
            RebuildLexicon();
        }

        public static Hit[] Check(string text)
        {
            Ensure();
            if (_box == null || string.IsNullOrEmpty(text)) return new Hit[0];
            if (text.Length > MaxTextChars) text = text.Substring(0, MaxTextChars);
            var hits = new List<Hit>();
            try
            {
                _box.Text = text;
                int pos = 0;
                while (hits.Count < MaxHits)
                {
                    int start = _box.GetNextSpellingErrorCharacterIndex(pos, LogicalDirection.Forward);
                    if (start < 0) break;
                    int len = _box.GetSpellingErrorLength(start);
                    if (len <= 0) { pos = start + 1; continue; }
                    string word = text.Substring(start, Math.Min(len, text.Length - start));
                    if (!IsCheckableWord(word)) { pos = start + len; continue; }
                    var sugg = new List<string>();
                    try
                    {
                        var err = _box.GetSpellingError(start);
                        if (err != null)
                        {
                            foreach (string s in err.Suggestions)
                            {
                                if (string.IsNullOrEmpty(s)) continue;
                                sugg.Add(s);
                                if (sugg.Count >= MaxSuggestions) break;
                            }
                        }
                    }
                    catch { }
                    hits.Add(new Hit
                    {
                        Start = start,
                        Length = len,
                        Word = word,
                        Suggestions = sugg.ToArray()
                    });
                    pos = start + len;
                }
            }
            catch (Exception ex)
            {
                _lastError = ex.GetType().Name + ": " + ex.Message;
            }
            return hits.ToArray();
        }

        public static void Add(string word, bool persist)
        {
            word = (word ?? "").Trim();
            if (word.Length < 2) return;
            _userWords.Add(word);
            if (persist)
            {
                try
                {
                    if (!string.IsNullOrEmpty(_userWordsPath))
                    {
                        string dir = Path.GetDirectoryName(_userWordsPath);
                        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                            Directory.CreateDirectory(dir);
                        File.AppendAllText(_userWordsPath, word + "\r\n", Encoding.UTF8);
                    }
                }
                catch { }
            }
            RebuildLexicon();
        }

        public static void Ignore(string word)
        {
            word = (word ?? "").Trim();
            if (word.Length < 2) return;
            Ensure();
            if (_box == null) return;
            try
            {
                _box.Text = word;
                int start = _box.GetNextSpellingErrorCharacterIndex(0, LogicalDirection.Forward);
                if (start >= 0)
                {
                    var err = _box.GetSpellingError(start);
                    if (err != null) err.IgnoreAll();
                }
            }
            catch { }
        }

        static void Ensure()
        {
            if (_tried) return;
            _tried = true;
            try
            {
                _box = new TextBox();
                SpellCheck.SetIsEnabled(_box, true);
                string tag = CultureInfo.CurrentUICulture.Name;
                if (string.IsNullOrEmpty(tag)) tag = "en-US";
                try { _box.Language = XmlLanguage.GetLanguage(tag); }
                catch { _box.Language = XmlLanguage.GetLanguage("en-US"); }
                _lastError = "";
            }
            catch (Exception ex)
            {
                _box = null;
                _lastError = ex.GetType().Name + ": " + ex.Message;
            }
        }

        static void RebuildLexicon()
        {
            Ensure();
            if (_box == null) return;
            try
            {
                if (string.IsNullOrEmpty(_lexPath))
                {
                    string dir = !string.IsNullOrEmpty(_userWordsPath)
                        ? Path.GetDirectoryName(_userWordsPath)
                        : Path.GetTempPath();
                    if (string.IsNullOrEmpty(dir)) dir = Path.GetTempPath();
                    _lexPath = Path.Combine(dir, "typozen_user.lex");
                }
                var sb = new StringBuilder();
                sb.AppendLine("#LID 1033");
                foreach (string w in _userWords) sb.AppendLine(w);
                File.WriteAllText(_lexPath, sb.ToString(), Encoding.UTF8);
                var dicts = SpellCheck.GetCustomDictionaries(_box);
                dicts.Clear();
                dicts.Add(new Uri(_lexPath));
            }
            catch { }
        }

        static bool IsCheckableWord(string w)
        {
            if (string.IsNullOrEmpty(w) || w.Length < 2) return false;
            int letters = 0;
            bool allUpper = true;
            for (int i = 0; i < w.Length; i++)
            {
                char c = w[i];
                if (char.IsLetter(c))
                {
                    letters++;
                    if (!char.IsUpper(c)) allUpper = false;
                }
                else if (c == '\'' || c == '\u2019' || c == '-') { }
                else if (char.IsDigit(c)) return false;
                else if (c == '@' || c == '/' || c == ':' || c == '_' || c == '.') return false;
            }
            if (letters < 2) return false;
            if (allUpper && letters <= 5) return false;
            return true;
        }
    }
}
