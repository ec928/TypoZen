using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace TypoZen
{
    /// <summary>
    /// A word -> text map read from dictionary.tsv / thesaurus.tsv (or a .json drop-in).
    ///
    /// The bundled files are sorted by word, so they are looked up on disk: one pass at
    /// load notes every 64th word and where its line starts, and a lookup binary-searches
    /// those and reads the few lines after. That keeps about 2,400 short strings in memory
    /// instead of the whole file -- the in-memory map of the dictionary alone cost 39 MB and
    /// about 100 ms of parsing at every launch, and a larger dictionary would scale both.
    /// A lookup is one small read: about 0.1 ms on an SSD, about 8 ms on a hard disk,
    /// measured on 2026-09-19.
    ///
    /// A file that is not sorted -- a user's own, dropped into the cache folder -- or a
    /// .json one is loaded into memory as before, so any file that worked still works.
    /// </summary>
    internal abstract class Lexicon
    {
        public abstract bool TryGetValue(string word, out string value);

        /// <summary>Null when the file is missing, unreadable or has no entries.</summary>
        public static Lexicon Open(string path)
        {
            if (!File.Exists(path)) return null;
            try
            {
                if (path.EndsWith(".tsv", StringComparison.OrdinalIgnoreCase))
                {
                    Lexicon sorted = SortedFileLexicon.TryOpen(path);
                    if (sorted != null) return sorted;
                    return MemoryLexicon.FromTsv(path);
                }
                return MemoryLexicon.FromJson(path);
            }
            catch { return null; }
        }

        /// <summary>The comparison the build sorts by; lookups and the sort check must agree.</summary>
        internal static readonly StringComparer Order = StringComparer.OrdinalIgnoreCase;

        /// <summary>Whether the file really is on disk rather than in memory, for tests.</summary>
        public abstract bool OnDisk { get; }
    }

    internal sealed class MemoryLexicon : Lexicon
    {
        private readonly Dictionary<string, string> _map;
        private MemoryLexicon(Dictionary<string, string> map) { _map = map; }

        public override bool OnDisk { get { return false; } }
        public override bool TryGetValue(string word, out string value)
        {
            return _map.TryGetValue(word ?? "", out value);
        }

        public static MemoryLexicon FromTsv(string path)
        {
            var map = new Dictionary<string, string>(Lexicon.Order);
            foreach (string line in File.ReadLines(path))
            {
                int tab = line.IndexOf('\t');
                if (tab <= 0) continue;
                string w = line.Substring(0, tab).Trim();
                if (w.Length == 0 || map.ContainsKey(w)) continue;
                map[w] = line.Substring(tab + 1).Trim();
            }
            return map.Count > 0 ? new MemoryLexicon(map) : null;
        }

        public static MemoryLexicon FromJson(string path)
        {
            var map = new Dictionary<string, string>(Lexicon.Order);
            // Deliberately not a JSON parser: this is a flat string map, and the app has
            // no serializer dependency to reach for.
            string text = File.ReadAllText(path, Encoding.UTF8);
            // Verbatim string: the pattern is full of backslashes and doubling every one of
            // them is how the previous attempt at this line failed to compile.
            foreach (Match m in Regex.Matches(text,
                @"""((?:[^""\\]|\\.)*)""\s*:\s*""((?:[^""\\]|\\.)*)"""))
            {
                string w = Regex.Unescape(m.Groups[1].Value).Trim();
                if (w.Length == 0 || map.ContainsKey(w)) continue;
                map[w] = Regex.Unescape(m.Groups[2].Value).Trim();
            }
            return map.Count > 0 ? new MemoryLexicon(map) : null;
        }
    }

    internal sealed class SortedFileLexicon : Lexicon
    {
        private const int Stride = 64;
        private readonly string _path;
        private readonly object _gate = new object();
        private string[] _keys;
        private long[] _offsets;
        // What the index was built against. The installer can replace the file under a
        // running app, and offsets into the old file would land mid-line in the new one.
        private long _length;
        private DateTime _written;

        private SortedFileLexicon(string path) { _path = path; }

        public override bool OnDisk { get { return true; } }

        /// <summary>Null when the file is not sorted by word (or is empty).</summary>
        public static SortedFileLexicon TryOpen(string path)
        {
            var lex = new SortedFileLexicon(path);
            return lex.BuildIndex() ? lex : null;
        }

        /// <summary>
        /// One streaming pass over the bytes: note every Stride-th word and its line's
        /// offset, and give up the moment a word sorts before the one above it.
        /// </summary>
        private bool BuildIndex()
        {
            var keys = new List<string>();
            var offsets = new List<long>();
            var fi = new FileInfo(_path);
            long length = fi.Length;
            DateTime written = fi.LastWriteTimeUtc;

            using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read,
                                           FileShare.ReadWrite | FileShare.Delete, 1 << 16,
                                           FileOptions.SequentialScan))
            {
                byte[] buf = new byte[1 << 16];
                byte[] key = new byte[512];
                int keyLen = 0;
                bool inKey = true, tabSeen = false;
                long pos = 0, lineStart = 0;
                int entries = 0;
                string prev = null;
                bool first = true;
                int read;
                while ((read = fs.Read(buf, 0, buf.Length)) > 0)
                {
                    int i = 0;
                    if (first)
                    {
                        first = false;
                        // A BOM belongs to the file, not to the first word.
                        if (read >= 3 && buf[0] == 0xEF && buf[1] == 0xBB && buf[2] == 0xBF)
                        {
                            i = 3; lineStart = 3;
                        }
                    }
                    for (; i < read; i++)
                    {
                        byte b = buf[i];
                        if (b == (byte)'\n')
                        {
                            if (!Line(key, keyLen, tabSeen, lineStart, keys, offsets, ref prev, ref entries))
                                return false;
                            keyLen = 0; inKey = true; tabSeen = false;
                            lineStart = pos + i + 1;
                        }
                        else if (inKey)
                        {
                            if (b == (byte)'\t') { inKey = false; tabSeen = true; }
                            else if (keyLen < key.Length) key[keyLen++] = b;
                        }
                    }
                    pos += read;
                }
                if (!Line(key, keyLen, tabSeen, lineStart, keys, offsets, ref prev, ref entries))
                    return false;
                if (entries == 0) return false;
            }
            _keys = keys.ToArray();
            _offsets = offsets.ToArray();
            _length = length;
            _written = written;
            return true;
        }

        private static bool Line(byte[] key, int keyLen, bool tabSeen, long lineStart,
                                 List<string> keys, List<long> offsets, ref string prev, ref int entries)
        {
            if (!tabSeen || keyLen == 0) return true;
            string w = Encoding.UTF8.GetString(key, 0, keyLen).Trim();
            if (w.Length == 0) return true;
            if (prev != null && Order.Compare(prev, w) > 0) return false;   // not sorted
            if (entries % Stride == 0) { keys.Add(w); offsets.Add(lineStart); }
            prev = w;
            entries++;
            return true;
        }

        public override bool TryGetValue(string word, out string value)
        {
            value = null;
            string w = (word ?? "").Trim();
            if (w.Length == 0) return false;
            lock (_gate)
            {
                try
                {
                    var fi = new FileInfo(_path);
                    if (!fi.Exists) return false;
                    if (fi.Length != _length || fi.LastWriteTimeUtc != _written)
                    {
                        if (!BuildIndex()) return false;
                    }

                    // The last noted word strictly before this one: the first line with
                    // this word is after it and no later than the next noted word.
                    int lo = 0, hi = _keys.Length - 1, at = 0;
                    while (lo <= hi)
                    {
                        int mid = (lo + hi) / 2;
                        if (Order.Compare(_keys[mid], w) < 0) { at = mid; lo = mid + 1; }
                        else hi = mid - 1;
                    }

                    using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read,
                                                   FileShare.ReadWrite | FileShare.Delete, 4096,
                                                   FileOptions.RandomAccess))
                    {
                        fs.Position = _offsets[at];
                        using (var sr = new StreamReader(fs, new UTF8Encoding(false), false, 4096))
                        {
                            string line;
                            while ((line = sr.ReadLine()) != null)
                            {
                                int tab = line.IndexOf('\t');
                                if (tab <= 0) continue;
                                string k = line.Substring(0, tab).Trim();
                                if (k.Length == 0) continue;
                                int c = Order.Compare(k, w);
                                if (c == 0) { value = line.Substring(tab + 1).Trim(); return true; }
                                if (c > 0) return false;
                            }
                        }
                    }
                }
                catch { }
                return false;
            }
        }
    }
}
