namespace TypoZen
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.IO.Compression;
    using System.Linq;
    using System.Text;
    using System.Text.RegularExpressions;

    /// <summary>
    /// Reads an .epub into a payload the page can open, and does no HTML processing.
    ///
    /// The division is deliberate. This half does what needs a filesystem -- unzip, the
    /// container and OPF, the spine in reading order, the table of contents, and a place the
    /// extracted assets can be fetched from. The page does everything that needs an HTML
    /// parser, because the browser is the HTML authority and a second parser here would
    /// disagree with it at the edges.
    ///
    /// It replaces EpubExtractor, which converted books to Markdown with regular
    /// expressions. Measured against Blindsight that lost every one of 6 images, 162 links,
    /// 170 list items and 210 footnote references, and broke 16 of 17 headings -- which
    /// leaves a reader with no outline and no chapter navigation. Markdown cannot hold what a
    /// typeset book uses, so the conversion is not fixable, only removable.
    /// </summary>
    public static class EpubReader
    {
        /// <summary>Where a book's extracted assets live, so images and CSS resolve.</summary>
        public static string CacheRoot(string appDir)
        {
            return Path.Combine(appDir, "typozen_books");
        }

        /// <summary>
        /// Extract a book and describe it as JSON for the page.
        /// Returns null when the file is not a readable epub, so the caller can fall back.
        /// </summary>
        public static string ReadToPayload(string epubPath, string appDir, out string assetDir)
        {
            assetDir = null;
            try
            {
                // One directory per book, keyed by path so reopening reuses it rather than
                // unpacking a 5 MB omnibus again on every open.
                string key = StableKey(epubPath);
                string root = CacheRoot(appDir);
                Directory.CreateDirectory(root);
                PruneOldBooks(root);
                string dir = Path.Combine(root, key);
                assetDir = dir;

                using (var zip = ZipFile.OpenRead(epubPath))
                {
                    ExtractIfStale(zip, dir);

                    string opfPath = FindOpfPath(zip);
                    if (opfPath == null) return null;
                    string opfXml = ReadEntry(zip, opfPath);
                    if (opfXml == null) return null;

                    string opfDir = DirOf(opfPath);
                    var manifest = ParseManifest(opfXml);
                    var spine = ParseSpine(opfXml, manifest);

                    var docs = new List<string>();
                    foreach (var href in spine)
                    {
                        string html = ReadEntry(zip, Join(opfDir, href)) ?? ReadEntry(zip, href);
                        if (html == null) continue;
                        docs.Add("{\"href\":" + JsonStr(href) + ",\"html\":" + JsonStr(html) + "}");
                    }
                    if (docs.Count == 0) return null;

                    var css = new List<string>();
                    foreach (var kv in manifest)
                    {
                        if (!kv.Value.EndsWith(".css", StringComparison.OrdinalIgnoreCase)) continue;
                        string text = ReadEntry(zip, Join(opfDir, kv.Value)) ?? ReadEntry(zip, kv.Value);
                        if (text != null) css.Add(JsonStr(text));
                    }

                    var toc = ReadToc(zip, opfXml, opfDir, manifest);

                    var sb = new StringBuilder();
                    sb.Append("{\"title\":").Append(JsonStr(MetaOf(opfXml, "title")));
                    sb.Append(",\"author\":").Append(JsonStr(MetaOf(opfXml, "creator")));
                    sb.Append(",\"assetsBase\":").Append(JsonStr(
                        "https://localapp/typozen_books/" + key + "/" + opfDir));
                    sb.Append(",\"css\":[").Append(string.Join(",", css)).Append("]");
                    sb.Append(",\"toc\":[").Append(string.Join(",", toc)).Append("]");
                    sb.Append(",\"docs\":[").Append(string.Join(",", docs)).Append("]}");
                    return sb.ToString();
                }
            }
            catch
            {
                return null;
            }
        }

        // --- container / OPF ------------------------------------------------------------

        private static string FindOpfPath(ZipArchive zip)
        {
            string container = ReadEntry(zip, "META-INF/container.xml");
            if (container != null)
            {
                var m = Regex.Match(container, "full-path\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
                if (m.Success) return Uri.UnescapeDataString(m.Groups[1].Value);
            }
            // Some books ship a broken container but a findable OPF; a reader that refuses
            // them is worse than one that looks.
            foreach (var e in zip.Entries)
            {
                if (e.FullName.EndsWith(".opf", StringComparison.OrdinalIgnoreCase)) return e.FullName;
            }
            return null;
        }

        private static Dictionary<string, string> ParseManifest(string opfXml)
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (Match m in Regex.Matches(opfXml, "<item\\b[^>]*>", RegexOptions.IgnoreCase))
            {
                string id = Attr(m.Value, "id");
                string href = Attr(m.Value, "href");
                if (id != null && href != null) map[id] = Uri.UnescapeDataString(href);
            }
            return map;
        }

        private static List<string> ParseSpine(string opfXml, Dictionary<string, string> manifest)
        {
            var list = new List<string>();
            foreach (Match m in Regex.Matches(opfXml, "<itemref\\b[^>]*>", RegexOptions.IgnoreCase))
            {
                string idref = Attr(m.Value, "idref");
                string href;
                if (idref != null && manifest.TryGetValue(idref, out href)) list.Add(href);
            }
            return list;
        }

        /// <summary>
        /// The book's own chapter list: EPUB 3 nav first, then EPUB 2 ncx.
        ///
        /// Not a refinement over reading headings -- a requirement. Dune contains no
        /// h1..h6 elements at all, its chapter titles being styled paragraphs, which is what
        /// Calibre produces and therefore what a large share of real books look like.
        /// </summary>
        private static List<string> ReadToc(ZipArchive zip, string opfXml, string opfDir,
                                            Dictionary<string, string> manifest)
        {
            var outp = new List<string>();

            string navHref = null, ncxHref = null;
            foreach (Match m in Regex.Matches(opfXml, "<item\\b[^>]*>", RegexOptions.IgnoreCase))
            {
                string href = Attr(m.Value, "href");
                if (href == null) continue;
                string props = Attr(m.Value, "properties") ?? "";
                string mt = Attr(m.Value, "media-type") ?? "";
                if (props.IndexOf("nav", StringComparison.OrdinalIgnoreCase) >= 0) navHref = href;
                if (mt.IndexOf("dtbncx", StringComparison.OrdinalIgnoreCase) >= 0) ncxHref = href;
            }
            if (ncxHref == null)
            {
                foreach (var kv in manifest)
                {
                    if (kv.Value.EndsWith(".ncx", StringComparison.OrdinalIgnoreCase)) { ncxHref = kv.Value; break; }
                }
            }

            if (navHref != null)
            {
                string nav = ReadEntry(zip, Join(opfDir, navHref)) ?? ReadEntry(zip, navHref);
                if (nav != null)
                {
                    string navDir = DirOf(Join(opfDir, navHref));
                    foreach (Match a in Regex.Matches(nav,
                        "<a\\b[^>]*href\\s*=\\s*\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>", RegexOptions.IgnoreCase))
                    {
                        string href = RelativeToOpf(navDir, opfDir, a.Groups[1].Value);
                        string text = StripTags(a.Groups[2].Value);
                        if (text.Length > 0) outp.Add(TocJson(text, 1, href));
                    }
                    if (outp.Count > 0) return outp;
                }
            }

            if (ncxHref != null)
            {
                string ncx = ReadEntry(zip, Join(opfDir, ncxHref)) ?? ReadEntry(zip, ncxHref);
                if (ncx != null)
                {
                    string ncxDir = DirOf(Join(opfDir, ncxHref));
                    foreach (Match np in Regex.Matches(ncx,
                        "<navPoint\\b[\\s\\S]*?</navPoint>", RegexOptions.IgnoreCase))
                    {
                        var label = Regex.Match(np.Value, "<text[^>]*>([\\s\\S]*?)</text>", RegexOptions.IgnoreCase);
                        var content = Regex.Match(np.Value, "<content\\b[^>]*src\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
                        if (!label.Success || !content.Success) continue;
                        string text = StripTags(label.Groups[1].Value);
                        if (text.Length == 0) continue;
                        outp.Add(TocJson(text, 1, RelativeToOpf(ncxDir, opfDir, content.Groups[1].Value)));
                    }
                }
            }
            return outp;
        }

        private static string TocJson(string title, int level, string href)
        {
            return "{\"title\":" + JsonStr(title) + ",\"level\":" + level + ",\"href\":" + JsonStr(href) + "}";
        }

        /// <summary>
        /// A nav/ncx href is relative to that file, which is not always the OPF directory.
        /// The page matches on filename as a fallback, but getting it right here means a
        /// book whose TOC lives in a subdirectory resolves rather than silently vanishing.
        /// </summary>
        private static string RelativeToOpf(string fromDir, string opfDir, string href)
        {
            string h = href.Split('#')[0];
            try { h = Uri.UnescapeDataString(h); } catch { }
            string full = Join(fromDir, h);
            if (opfDir.Length > 0 && full.StartsWith(opfDir, StringComparison.OrdinalIgnoreCase))
            {
                return full.Substring(opfDir.Length);
            }
            return full;
        }

        // --- extraction -----------------------------------------------------------------

        /// <summary>
        /// Unpack once. Reopening a book should be instant, not another 5 MB of inflate.
        /// A stamp file records which archive and size the directory holds.
        /// </summary>
        private static void ExtractIfStale(ZipArchive zip, string dir)
        {
            string stamp = Path.Combine(dir, ".typozen-stamp");
            string want = zip.Entries.Count + ":" + zip.Entries.Sum(e => (long)e.Length);
            if (File.Exists(stamp))
            {
                try { if (File.ReadAllText(stamp) == want) return; } catch { }
            }
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
            Directory.CreateDirectory(dir);

            foreach (var e in zip.Entries)
            {
                if (e.FullName.EndsWith("/")) continue;
                string dest = Path.GetFullPath(Path.Combine(dir, e.FullName.Replace('/', Path.DirectorySeparatorChar)));
                // Zip-slip: an archive must not write outside its own directory.
                if (!dest.StartsWith(Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    e.ExtractToFile(dest, true);
                }
                catch { }
            }
            try { File.WriteAllText(stamp, want); } catch { }
        }

        /// <summary>Keep the cache from growing without limit; books are large.</summary>
        private static void PruneOldBooks(string root, int keep = 8)
        {
            try
            {
                var dirs = new DirectoryInfo(root).GetDirectories()
                    .OrderByDescending(d => d.LastWriteTimeUtc).Skip(keep);
                foreach (var d in dirs) { try { d.Delete(true); } catch { } }
            }
            catch { }
        }

        // --- small helpers --------------------------------------------------------------

        private static string StableKey(string path)
        {
            string name = Path.GetFileNameWithoutExtension(path) ?? "book";
            name = Regex.Replace(name, "[^A-Za-z0-9_-]+", "_");
            if (name.Length > 40) name = name.Substring(0, 40);
            unchecked
            {
                int h = 23;
                foreach (char c in path.ToLowerInvariant()) h = h * 31 + c;
                return name + "_" + ((uint)h).ToString("x8");
            }
        }

        private static string ReadEntry(ZipArchive zip, string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            var e = zip.GetEntry(path);
            if (e == null)
            {
                // Archives are inconsistent about leading ./ and about case.
                string want = path.Replace('\\', '/').TrimStart('.', '/');
                foreach (var c in zip.Entries)
                {
                    if (string.Equals(c.FullName.TrimStart('.', '/'), want, StringComparison.OrdinalIgnoreCase))
                    { e = c; break; }
                }
            }
            if (e == null) return null;
            try
            {
                using (var s = e.Open())
                using (var r = new StreamReader(s, Encoding.UTF8, true))
                {
                    return r.ReadToEnd();
                }
            }
            catch { return null; }
        }

        private static string Attr(string tag, string name)
        {
            var m = Regex.Match(tag, "\\b" + name + "\\s*=\\s*\"([^\"]*)\"", RegexOptions.IgnoreCase);
            return m.Success ? m.Groups[1].Value : null;
        }

        private static string MetaOf(string opfXml, string tag)
        {
            var m = Regex.Match(opfXml, "<dc:" + tag + "[^>]*>([\\s\\S]*?)</dc:" + tag + ">", RegexOptions.IgnoreCase);
            return m.Success ? StripTags(m.Groups[1].Value) : "";
        }

        private static string StripTags(string s)
        {
            s = Regex.Replace(s ?? "", "<[^>]*>", "");
            s = System.Net.WebUtility.HtmlDecode(s);
            return Regex.Replace(s, "\\s+", " ").Trim();
        }

        private static string DirOf(string path)
        {
            int i = path.LastIndexOf('/');
            return i < 0 ? "" : path.Substring(0, i + 1);
        }

        private static string Join(string dir, string href)
        {
            if (string.IsNullOrEmpty(dir)) return href;
            string h = href.Replace('\\', '/');
            if (h.StartsWith("/")) return h.TrimStart('/');
            string combined = dir + h;
            // Resolve ../ so a nav in a subdirectory points where it means to.
            var parts = new List<string>();
            foreach (var seg in combined.Split('/'))
            {
                if (seg == "." || seg.Length == 0) continue;
                if (seg == ".." ) { if (parts.Count > 0) parts.RemoveAt(parts.Count - 1); continue; }
                parts.Add(seg);
            }
            return string.Join("/", parts);
        }

        private static string JsonStr(string s)
        {
            if (s == null) return "\"\"";
            var sb = new StringBuilder(s.Length + 16);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == '\u2028' || c == '\u2029')
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        }
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
