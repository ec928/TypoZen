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
        /// <summary>
        /// Where a book's extracted assets live, so images and CSS resolve.
        ///
        /// In privacy mode this moves out of the application folder entirely rather than
        /// being swept afterwards, because the directory name is the leak: extraction is
        /// keyed by a readable name -- "Matter_-_Iain_M_Banks_68aa4804" -- so the mere
        /// existence of the folder says what was being read, for the whole session and
        /// after any crash. Redirecting the destination means nothing ever lands there,
        /// cleanup is one directory rather than per-book bookkeeping, and a private session
        /// neither pollutes nor evicts the ordinary cache.
        ///
        /// A book still has to be unzipped to be read, so this is a smaller claim than
        /// "nothing on disk": it is an opaquely named directory under TEMP, deleted when
        /// the window closes and swept on the next launch if that never happened.
        /// </summary>
        // stateDir, NOT the app folder. Extracting books beside the executable makes the
        // install directory writable-by-requirement, which it is not once the app is
        // installed anywhere protected (Program Files, or an MSIX package, where it is
        // read-only outright). The cache is per-user state and belongs with the rest of it.
        public static string CacheRoot(string stateDir)
        {
            // PrivateMode, not "is there a root": the root is now created at launch so
            // its virtual host can be mapped before the page navigates, so its mere
            // existence no longer means Privacy Mode is on.
            if (PrivateMode && PrivateSessionRoot != null) return PrivateSessionRoot;
            return Path.Combine(stateDir, "typozen_books");
        }

        /// <summary>Set while privacy mode is on; null means the ordinary cache.</summary>
        public static string PrivateSessionRoot;

        /// <summary>True while Privacy Mode is on. Set by the app, read by CacheRoot.</summary>
        public static bool PrivateMode;

        /// <summary>
        /// Name this PROCESS's private extraction directory, and make it. Idempotent:
        /// one root for the life of the window, because its virtual host is mapped once,
        /// before the page navigates, and a mapping added later never reaches the live
        /// document. Minting a fresh root per session would strand that mapping.
        /// </summary>
        public static string BeginPrivateSession()
        {
            if (PrivateSessionRoot != null) return PrivateSessionRoot;
            try
            {
                string dir = Path.Combine(Path.GetTempPath(),
                    "tz-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                PrivateSessionRoot = dir;
                return dir;
            }
            catch { PrivateSessionRoot = null; return null; }
        }

        /// <summary>
        /// Leaving Privacy Mode. This NO LONGER deletes the extraction directory.
        ///
        /// A book that is open at that moment is still reading its images out of it, and
        /// deleting it underneath the reader broke the book they were in the middle of.
        /// Cleaning up must not cost someone the thing they are using: the directory is
        /// removed on exit instead, by DisposePrivateSession, and a crash is covered by
        /// the sweep the app runs at launch. That sweep call is in the app's WebView init
        /// beside SweepAbandonedLoadDirs -- it was missing for a while, so a copy that was
        /// always killed rather than closed never cleared anything.
        /// </summary>
        public static void EndPrivateSession()
        {
            SweepAbandonedPrivateSessions();
        }

        /// <summary>Remove this process's private extraction directory. Exit only.</summary>
        public static void DisposePrivateSession()
        {
            string mine = PrivateSessionRoot;
            PrivateSessionRoot = null;
            PrivateMode = false;
            if (mine != null) { try { Directory.Delete(mine, true); } catch { } }
            SweepAbandonedPrivateSessions();
        }

        public static void SweepAbandonedPrivateSessions()
        {
            try
            {
                foreach (var d in new DirectoryInfo(Path.GetTempPath()).GetDirectories("tz-*"))
                {
                    // Only ours, and only once it cannot be a live sibling instance.
                    if (d.Name.Length != 35) continue;
                    if ((DateTime.UtcNow - d.LastWriteTimeUtc).TotalHours < 12) continue;
                    try { d.Delete(true); } catch { }
                }
            }
            catch { }
        }

        /// <summary>
        /// Extract a book and describe it as JSON for the page.
        /// Returns null when the file is not a readable epub, so the caller can fall back.
        /// </summary>
        public static string ReadToPayload(string epubPath, string stateDir, out string assetDir)
        {
            assetDir = null;
            try
            {
                // One directory per book, keyed by path so reopening reuses it rather than
                // unpacking a 5 MB omnibus again on every open.
                string key = StableKey(epubPath);
                string root = CacheRoot(stateDir);
                Directory.CreateDirectory(root);
                PruneOldBooks(root);
                string dir = Path.Combine(root, key);
                assetDir = dir;

                // The payload for a book that has not changed is the same payload. Building
                // it means re-reading every spine document out of the zip and JSON-escaping
                // the lot -- 1,043,141 characters for a mid-sized novel -- and that is what
                // made switching to an already-open book tab take six seconds. The extracted
                // assets are already cached against a stamp; this caches the payload beside
                // them, against the same stamp.
                string payloadPath = Path.Combine(dir, ".typozen-payload.json");
                string stampPath = Path.Combine(dir, ".typozen-stamp");
                string stampWas = null;
                try { if (File.Exists(stampPath)) stampWas = File.ReadAllText(stampPath); } catch { }

                using (var zip = ZipFile.OpenRead(epubPath))
                {
                    ExtractIfStale(zip, dir);

                    // Reuse only when the stamp is the one the payload was built from, so a
                    // re-extract (a changed book) always rebuilds it.
                    if (stampWas != null && File.Exists(payloadPath))
                    {
                        try
                        {
                            string stampNow = File.ReadAllText(stampPath);
                            if (stampNow == stampWas)
                            {
                                string cached = File.ReadAllText(payloadPath, new UTF8Encoding(false));
                                if (!string.IsNullOrEmpty(cached)) return cached;
                            }
                        }
                        catch { }
                    }

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

                    // Each stylesheet with its own folder, relative to the OPF: a url() in CSS
                    // is relative to the stylesheet, not the package. Resolved against the OPF
                    // folder, Alien: Covenant's OEBPS/Styles/x.css asking for ../Fonts/a.ttf
                    // looked for Fonts/ outside OEBPS and found nothing.
                    var css = new List<string>();
                    var cssDirs = new List<string>();
                    foreach (var kv in manifest)
                    {
                        if (!kv.Value.EndsWith(".css", StringComparison.OrdinalIgnoreCase)) continue;
                        string text = ReadEntry(zip, Join(opfDir, kv.Value)) ?? ReadEntry(zip, kv.Value);
                        if (text == null) continue;
                        css.Add(JsonStr(text));
                        cssDirs.Add(JsonStr(DirOf(kv.Value.Replace('\\', '/'))));
                    }

                    var toc = ReadToc(zip, opfXml, opfDir, manifest);

                    var sb = new StringBuilder();
                    sb.Append("{\"title\":").Append(JsonStr(MetaOf(opfXml, "title")));
                    sb.Append(",\"author\":").Append(JsonStr(MetaOf(opfXml, "creator")));
                    sb.Append(",\"assetsBase\":").Append(JsonStr(
                        // Books have their own virtual host, mapped to whichever root
                        // CacheRoot chose. Addressing them under localapp baked the
                        // application folder into every image URL, which cannot work
                        // once a private session extracts somewhere else.
                        "https://localbooks/" + key + "/" + opfDir));
                    sb.Append(",\"css\":[").Append(string.Join(",", css)).Append("]");
                    sb.Append(",\"cssDirs\":[").Append(string.Join(",", cssDirs)).Append("]");
                    sb.Append(",\"toc\":[").Append(string.Join(",", toc)).Append("]");
                    sb.Append(",\"docs\":[").Append(string.Join(",", docs)).Append("]}");
                    string payload = sb.ToString();
                    // Cache beside the assets so the next open of this book is a file read.
                    // Best effort: a failure here costs the next open its rebuild, nothing more.
                    try { File.WriteAllText(payloadPath, payload, new UTF8Encoding(false)); } catch { }
                    return payload;
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
            // "f1:" -- the extraction also unscrambles obfuscated fonts (RestoreObfuscatedFonts).
            // A cache stamped before that holds them still scrambled, so it must not match.
            string want = "f1:" + zip.Entries.Count + ":" + zip.Entries.Sum(e => (long)e.Length);
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
                // Trailing separator so dest = dir + "_evil\\…" does not match.
                string rootPrefix = Path.GetFullPath(dir);
                if (!rootPrefix.EndsWith(Path.DirectorySeparatorChar.ToString())
                    && !rootPrefix.EndsWith(Path.AltDirectorySeparatorChar.ToString()))
                    rootPrefix += Path.DirectorySeparatorChar;
                if (!dest.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    e.ExtractToFile(dest, true);
                }
                catch { }
            }
            try { RestoreObfuscatedFonts(zip, dir); } catch { }
            try { File.WriteAllText(stamp, want); } catch { }
        }

        /// <summary>
        /// Unscramble a book's embedded fonts, as every reading system is required to.
        ///
        /// EPUB lets a publisher obfuscate a font so it cannot be lifted out of the zip
        /// whole: META-INF/encryption.xml lists the files, and the first bytes of each are
        /// XORed with a key derived from the book's own identifier. Served as they were, the
        /// browser refused them and the text quietly fell back to the theme's typeface --
        /// Alien: Covenant's eleven fonts and Red Country's one, in a 148-book library.
        ///
        ///   IDPF  (http://www.idpf.org/2008/embedding): first 1040 bytes, XORed with the
        ///         SHA-1 of the package's unique identifier, whitespace removed.
        ///   Adobe (http://ns.adobe.com/pdf/enc#RC): first 1024 bytes, XORed with the 16
        ///         bytes of the book's urn:uuid identifier.
        /// Anything else in encryption.xml is real encryption (DRM) and is left alone.
        /// </summary>
        private static void RestoreObfuscatedFonts(ZipArchive zip, string dir)
        {
            string enc = ReadEntry(zip, "META-INF/encryption.xml");
            if (enc == null) return;
            string opfPath = FindOpfPath(zip);
            string opf = opfPath != null ? ReadEntry(zip, opfPath) : null;
            if (opf == null) return;

            // The unique identifier: <package unique-identifier="X"> names a dc:identifier.
            string uidRef = Attr(Regex.Match(opf, "<package\\b[^>]*>", RegexOptions.IgnoreCase).Value, "unique-identifier");
            string uid = null;
            var ids = Regex.Matches(opf, "<dc:identifier\\b([^>]*)>([\\s\\S]*?)</dc:identifier>", RegexOptions.IgnoreCase);
            foreach (Match m in ids)
            {
                if (uidRef != null && string.Equals(Attr("<x " + m.Groups[1].Value + ">", "id"), uidRef, StringComparison.Ordinal))
                { uid = System.Net.WebUtility.HtmlDecode(m.Groups[2].Value); break; }
            }
            if (uid == null && ids.Count > 0) uid = System.Net.WebUtility.HtmlDecode(ids[0].Groups[2].Value);
            if (uid == null) return;

            byte[] idpfKey;
            using (var sha = System.Security.Cryptography.SHA1.Create())
                idpfKey = sha.ComputeHash(Encoding.UTF8.GetBytes(Regex.Replace(uid, "[\\u0020\\u0009\\u000D\\u000A]", "")));

            // Adobe's key is the book's UUID: the unique identifier if it is one, else any.
            byte[] adobeKey = null;
            foreach (Match m in ids)
            {
                string v = System.Net.WebUtility.HtmlDecode(m.Groups[2].Value).Trim();
                bool isUid = uidRef != null && string.Equals(Attr("<x " + m.Groups[1].Value + ">", "id"), uidRef, StringComparison.Ordinal);
                var g = Regex.Match(v, "^(?:urn:uuid:)?([0-9a-fA-F]{8})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{12})$");
                if (!g.Success) continue;
                string hex = g.Groups[1].Value + g.Groups[2].Value + g.Groups[3].Value + g.Groups[4].Value + g.Groups[5].Value;
                var k = new byte[16];
                for (int i = 0; i < 16; i++) k[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
                if (adobeKey == null || isUid) adobeKey = k;
                if (isUid) break;
            }

            foreach (Match data in Regex.Matches(enc, "<(?:\\w+:)?EncryptedData\\b[\\s\\S]*?</(?:\\w+:)?EncryptedData>", RegexOptions.IgnoreCase))
            {
                var alg = Regex.Match(data.Value, "EncryptionMethod\\b[^>]*Algorithm\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
                var uri = Regex.Match(data.Value, "CipherReference\\b[^>]*URI\\s*=\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
                if (!alg.Success || !uri.Success) continue;
                byte[] key; int length;
                if (alg.Groups[1].Value == "http://www.idpf.org/2008/embedding") { key = idpfKey; length = 1040; }
                else if (alg.Groups[1].Value == "http://ns.adobe.com/pdf/enc#RC" && adobeKey != null) { key = adobeKey; length = 1024; }
                else continue;

                string rel = Uri.UnescapeDataString(uri.Groups[1].Value).Replace('\\', '/').TrimStart('/');
                string file = Path.GetFullPath(Path.Combine(dir, rel.Replace('/', Path.DirectorySeparatorChar)));
                if (!file.StartsWith(Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) continue;
                byte[] bytes = File.ReadAllBytes(file);
                int n = Math.Min(length, bytes.Length);
                for (int i = 0; i < n; i++) bytes[i] ^= key[i % key.Length];
                File.WriteAllBytes(file, bytes);
            }
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

        /// <summary>
        /// The cache folder name a given .epub unpacks into. Public so the app can tell
        /// which extracted folders belong to books that are open right now, and leave
        /// those alone when clearing stored data -- deleting the assets of a book someone
        /// is reading is the same mistake EndPrivateSession used to make.
        /// </summary>
        public static string CacheKeyFor(string epubPath)
        {
            return StableKey(epubPath);
        }

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
