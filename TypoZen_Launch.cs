using System;
using System.IO;
using System.Text;

namespace TypoZen
{
    /// <summary>
    /// Phase 6 — how a document was requested: path plus optional ZenSeek hints.
    /// Pipe line is either a bare path (Explorer) or path + tab-separated #tz1 fields.
    /// FilePath avoids clashing with System.IO.Path.
    /// </summary>
    public sealed class LaunchRequest
    {
        public string FilePath;
        public bool Reader;
        public string Search;
        /// <summary>0-based line from ZenSeek's extracted text, or -1.</summary>
        public int Line = -1;
        /// <summary>0-based index among matches for Search, or -1 (first match).</summary>
        public int MatchIndex = -1;
        public bool Debug;

        public bool HasOpenHints
        {
            get
            {
                return Reader
                    || !string.IsNullOrEmpty(Search)
                    || Line >= 0
                    || MatchIndex >= 0;
            }
        }

        public static LaunchRequest ParseArgs(string[] args)
        {
            var r = new LaunchRequest();
            if (args == null) return r;
            for (int i = 0; i < args.Length; i++)
            {
                if (string.IsNullOrWhiteSpace(args[i])) continue;
                string a = args[i].Trim('\"', '\'');
                if (a.Equals("--debug", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("-debug", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("/debug", StringComparison.OrdinalIgnoreCase))
                {
                    r.Debug = true;
                    continue;
                }
                if (a.Equals("--reader", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("-reader", StringComparison.OrdinalIgnoreCase))
                {
                    r.Reader = true;
                    continue;
                }
                if (a.Equals("--search", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("-search", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("/search", StringComparison.OrdinalIgnoreCase))
                {
                    if (i + 1 < args.Length)
                    {
                        i++;
                        r.Search = args[i].Trim('\"', '\'');
                    }
                    continue;
                }
                if (a.StartsWith("--search=", StringComparison.OrdinalIgnoreCase))
                {
                    r.Search = a.Substring("--search=".Length).Trim('\"', '\'');
                    continue;
                }
                if (a.Equals("--line", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("-line", StringComparison.OrdinalIgnoreCase))
                {
                    if (i + 1 < args.Length)
                    {
                        i++;
                        int n;
                        if (int.TryParse(args[i].Trim('\"', '\''), out n) && n >= 0) r.Line = n;
                    }
                    continue;
                }
                if (a.StartsWith("--line=", StringComparison.OrdinalIgnoreCase))
                {
                    int n;
                    if (int.TryParse(a.Substring("--line=".Length).Trim('\"', '\''), out n) && n >= 0)
                        r.Line = n;
                    continue;
                }
                if (a.Equals("--match-index", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("--match", StringComparison.OrdinalIgnoreCase)
                    || a.Equals("-match-index", StringComparison.OrdinalIgnoreCase))
                {
                    if (i + 1 < args.Length)
                    {
                        i++;
                        int n;
                        if (int.TryParse(args[i].Trim('\"', '\''), out n) && n >= 0) r.MatchIndex = n;
                    }
                    continue;
                }
                if (a.StartsWith("--match-index=", StringComparison.OrdinalIgnoreCase))
                {
                    int n;
                    if (int.TryParse(a.Substring("--match-index=".Length).Trim('\"', '\''), out n) && n >= 0)
                        r.MatchIndex = n;
                    continue;
                }
                if (a.StartsWith("-", StringComparison.Ordinal))
                    continue;
                if (string.IsNullOrEmpty(r.FilePath))
                {
                    try { r.FilePath = Path.GetFullPath(a); }
                    catch { r.FilePath = a; }
                }
            }
            return r;
        }

        public string ToPipeLine()
        {
            if (string.IsNullOrEmpty(FilePath) && !HasOpenHints) return "";
            if (!HasOpenHints) return FilePath ?? "";
            var sb = new StringBuilder();
            sb.Append(FilePath ?? "");
            sb.Append("\t#tz1");
            if (Reader) sb.Append("\treader=1");
            if (!string.IsNullOrEmpty(Search))
                sb.Append("\tsearch=").Append(Uri.EscapeDataString(Search));
            if (Line >= 0) sb.Append("\tline=").Append(Line.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (MatchIndex >= 0)
                sb.Append("\tmatch=").Append(MatchIndex.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return sb.ToString();
        }

        public static LaunchRequest FromPipeLine(string line)
        {
            var r = new LaunchRequest();
            if (string.IsNullOrWhiteSpace(line)) return r;
            line = line.Trim().Trim('"');
            int tab = line.IndexOf('\t');
            if (tab < 0)
            {
                try { r.FilePath = Path.GetFullPath(line); } catch { r.FilePath = line; }
                return r;
            }
            string pathPart = line.Substring(0, tab);
            if (!string.IsNullOrWhiteSpace(pathPart))
            {
                try { r.FilePath = Path.GetFullPath(pathPart.Trim().Trim('"')); }
                catch { r.FilePath = pathPart.Trim().Trim('"'); }
            }
            string rest = line.Substring(tab + 1);
            string[] parts = rest.Split('\t');
            for (int i = 0; i < parts.Length; i++)
            {
                string p = parts[i];
                if (string.IsNullOrEmpty(p) || p.Equals("#tz1", StringComparison.OrdinalIgnoreCase))
                    continue;
                int eq = p.IndexOf('=');
                if (eq <= 0) continue;
                string key = p.Substring(0, eq);
                string val = p.Substring(eq + 1);
                if (key.Equals("reader", StringComparison.OrdinalIgnoreCase))
                    r.Reader = val == "1" || val.Equals("true", StringComparison.OrdinalIgnoreCase);
                else if (key.Equals("search", StringComparison.OrdinalIgnoreCase))
                {
                    try { r.Search = Uri.UnescapeDataString(val); }
                    catch { r.Search = val; }
                }
                else if (key.Equals("line", StringComparison.OrdinalIgnoreCase))
                {
                    int n;
                    if (int.TryParse(val, out n) && n >= 0) r.Line = n;
                }
                else if (key.Equals("match", StringComparison.OrdinalIgnoreCase))
                {
                    int n;
                    if (int.TryParse(val, out n) && n >= 0) r.MatchIndex = n;
                }
            }
            return r;
        }
    }
}
