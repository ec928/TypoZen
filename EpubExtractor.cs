namespace TypoZen
{
    using System;
    using System.IO;
    using System.IO.Compression;
    using System.Text;
    using System.Text.RegularExpressions;
    using System.Xml;
    using System.Collections.Generic;

    public static class EpubExtractor
    {
        public static string ExtractToMarkdown(string epubPath)
        {
            try
            {
                using (var archive = ZipFile.OpenRead(epubPath))
                {
                    // 1. Find META-INF/container.xml
                    var containerEntry = archive.GetEntry("META-INF/container.xml");
                    if (containerEntry == null) return "Invalid Epub: missing META-INF/container.xml";

                    string opfPath = null;
                    using (var stream = containerEntry.Open())
                    {
                        var doc = new XmlDocument();
                        doc.Load(stream);
                        var nsMgr = new XmlNamespaceManager(doc.NameTable);
                        nsMgr.AddNamespace("n", "urn:oasis:names:tc:opendocument:xmlns:container");
                        var rootfile = doc.SelectSingleNode("//n:rootfile", nsMgr);
                        if (rootfile != null && rootfile.Attributes["full-path"] != null)
                        {
                            opfPath = rootfile.Attributes["full-path"].Value;
                        }
                    }

                    if (string.IsNullOrEmpty(opfPath)) return "Invalid Epub: OPF not found.";

                    // 2. Parse OPF file
                    var opfEntry = archive.GetEntry(opfPath);
                    if (opfEntry == null) return "Invalid Epub: OPF file missing.";

                    string opfDir = Path.GetDirectoryName(opfPath).Replace('\\', '/');
                    if (!string.IsNullOrEmpty(opfDir) && !opfDir.EndsWith("/")) opfDir += "/";
                    else opfDir = "";

                    var manifest = new Dictionary<string, string>();
                    var spine = new List<string>();
                    
                    using (var stream = opfEntry.Open())
                    {
                        var doc = new XmlDocument();
                        doc.Load(stream);
                        var nsMgr = new XmlNamespaceManager(doc.NameTable);
                        nsMgr.AddNamespace("opf", "http://www.idpf.org/2007/opf");

                        var items = doc.SelectNodes("//opf:manifest/opf:item", nsMgr);
                        if (items != null)
                        {
                            foreach (XmlNode item in items)
                            {
                                string id = item.Attributes["id"] != null ? item.Attributes["id"].Value : null;
                                string href = item.Attributes["href"] != null ? item.Attributes["href"].Value : null;
                                if (id != null && href != null)
                                {
                                    manifest[id] = Uri.UnescapeDataString(href);
                                }
                            }
                        }

                        var itemrefs = doc.SelectNodes("//opf:spine/opf:itemref", nsMgr);
                        if (itemrefs != null)
                        {
                            foreach (XmlNode itemref in itemrefs)
                            {
                                string idref = itemref.Attributes["idref"] != null ? itemref.Attributes["idref"].Value : null;
                                if (idref != null) spine.Add(idref);
                            }
                        }
                    }

                    // 3. Extract text from spine
                    var sb = new StringBuilder();
                    foreach (var idref in spine)
                    {
                        string href;
                        if (manifest.TryGetValue(idref, out href))
                        {
                            string entryPath = opfDir + href;
                            var entry = archive.GetEntry(entryPath);
                            if (entry != null)
                            {
                                using (var stream = entry.Open())
                                using (var reader = new StreamReader(stream, Encoding.UTF8))
                                {
                                    string html = reader.ReadToEnd();
                                    sb.AppendLine(HtmlToMarkdown(html));
                                    sb.AppendLine();
                                    sb.AppendLine("---"); // page break between chapters
                                    sb.AppendLine();
                                }
                            }
                        }
                    }

                    return sb.ToString();
                }
            }
            catch (Exception ex)
            {
                return "Error extracting Epub: " + ex.Message;
            }
        }

        private static string HtmlToMarkdown(string html)
        {
            if (string.IsNullOrWhiteSpace(html)) return "";

            // Extract body content if present
            var bodyMatch = Regex.Match(html, @"<body[^>]*>(.*?)</body>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            if (bodyMatch.Success)
            {
                html = bodyMatch.Groups[1].Value;
            }

            // Remove script and style tags
            html = Regex.Replace(html, @"<(script|style)[^>]*>.*?</\1>", "", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            
            // Basic tags
            html = Regex.Replace(html, @"<h1[^>]*>(.*?)</h1>", "\n# $1\n", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = Regex.Replace(html, @"<h2[^>]*>(.*?)</h2>", "\n## $1\n", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = Regex.Replace(html, @"<h3[^>]*>(.*?)</h3>", "\n### $1\n", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = Regex.Replace(html, @"<h4[^>]*>(.*?)</h4>", "\n#### $1\n", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = Regex.Replace(html, @"<h5[^>]*>(.*?)</h5>", "\n##### $1\n", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = Regex.Replace(html, @"<h6[^>]*>(.*?)</h6>", "\n###### $1\n", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            
            html = Regex.Replace(html, @"<p[^>]*>(.*?)</p>", "\n$1\n", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = Regex.Replace(html, @"<br\s*/?>", "\n", RegexOptions.IgnoreCase);
            html = Regex.Replace(html, @"<hr\s*/?>", "\n---\n", RegexOptions.IgnoreCase);
            
            html = Regex.Replace(html, @"<b[^>]*>(.*?)</b>", "**$1**", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = Regex.Replace(html, @"<strong[^>]*>(.*?)</strong>", "**$1**", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = Regex.Replace(html, @"<i[^>]*>(.*?)</i>", "*$1*", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            html = Regex.Replace(html, @"<em[^>]*>(.*?)</em>", "*$1*", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            
            // Clean up remaining tags
            html = Regex.Replace(html, @"<[^>]+>", "");

            // Decode HTML entities
            html = System.Net.WebUtility.HtmlDecode(html);

            // Clean up whitespace
            html = Regex.Replace(html, @"^[ \t]+", "", RegexOptions.Multiline); // remove leading spaces
            html = Regex.Replace(html, @"\n{3,}", "\n\n"); // max 2 newlines
            
            return html.Trim();
        }
    }
}
