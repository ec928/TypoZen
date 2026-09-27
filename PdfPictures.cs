namespace TypoZen
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Security.Cryptography;
    using System.Windows.Media.Imaging;
    using UglyToad.PdfPig;
    using UglyToad.PdfPig.Content;
    using UglyToad.PdfPig.Tokens;

    /// <summary>
    /// File > Save All Images in PDF, read straight from the file (PdfPig, Apache-2.0).
    ///
    /// The viewer (PDF.js) hands the page a picture only as decoded pixels. Saving from there
    /// meant interpreting every page just to find its pictures, re-encoding each one, and
    /// decoding candidate JPEGs to work out which original bytes belonged to which picture --
    /// all in JavaScript, one page at a time. This reads each picture's stored data directly:
    ///
    ///   Original  a JPEG or JPEG 2000 is written as the bytes the PDF holds; anything else
    ///             is written as a PNG made from its stored samples, which loses nothing.
    ///   Png       every picture as PNG: JPEGs are decoded once and saved losslessly.
    ///
    /// What this cannot hand over as it is -- a picture with a transparency mask (the mask is
    /// a separate image), a JBIG2 scan, a JPEG whose colours the PDF transforms, a CMYK or
    /// JPEG 2000 picture wanted as PNG -- is returned as a fallback, and the host has the
    /// viewer save exactly those, so nothing comes out worse than the viewer's own method.
    /// </summary>
    public static class PdfPictures
    {
        /// <summary>A picture for the viewer to save; Width -1 means every picture on the page.</summary>
        public sealed class Fallback { public int Page, Width, Height; }

        public sealed class Result
        {
            public int Files, Originals, Converted, Small, Repeats, Unreadable;
            public bool Cancelled;
            public string Error = "";
            /// <summary>Per page, the pictures written here, so the viewer numbers on after them.</summary>
            public Dictionary<int, int> WrittenOnPage = new Dictionary<int, int>();
            public List<Fallback> Fallbacks = new List<Fallback>();
        }

        /// <summary>
        /// Save the pictures on `pages` into `folder`, named as the viewer's method names them
        /// ("base - p001 - img01.jpg"), never over an existing file. Throws if the PDF cannot
        /// be opened at all -- a password the host was never told, a file this cannot parse --
        /// and the caller hands the whole job to the viewer.
        /// </summary>
        public static Result Extract(string pdfPath, IList<int> pages, string folder, string baseName,
                                     bool png, bool skipSmall, bool dedupe, bool perPage,
                                     Func<bool> cancelled, Action<int, int> progress)
        {
            var result = new Result();
            var seen = new HashSet<string>();
            int done = 0;
            using (var doc = PdfDocument.Open(pdfPath, new ParsingOptions { UseLenientParsing = true, SkipMissingFonts = true }))
            using (var sha = SHA256.Create())
            {
                int width = Math.Max(3, doc.NumberOfPages.ToString().Length);
                foreach (int p in pages)
                {
                    if (cancelled()) { result.Cancelled = true; break; }
                    int k = 0;
                    List<IPdfImage> images;
                    try { images = doc.GetPage(p).GetImages().ToList(); }
                    catch (Exception)
                    {
                        // A page this cannot read goes to the viewer whole.
                        result.Fallbacks.Add(new Fallback { Page = p, Width = -1, Height = -1 });
                        done++; progress(done, result.Files); continue;
                    }
                    foreach (var img in images)
                    {
                        if (cancelled()) { result.Cancelled = true; break; }
                        // A stencil mask is a shape to paint through, not a picture; the viewer's
                        // method never listed them either.
                        if (img.IsImageMask) continue;
                        int w = img.WidthInSamples, h = img.HeightInSamples;
                        if (skipSmall && (w < 32 || h < 32)) { result.Small++; continue; }

                        string ext;
                        byte[] bytes = null;
                        bool original = false;
                        try { bytes = Encode(img, png, out ext, out original); }
                        catch (Exception) { bytes = null; ext = null; }
                        if (bytes == null)
                        {
                            result.Fallbacks.Add(new Fallback { Page = p, Width = w, Height = h });
                            continue;
                        }
                        if (dedupe && !seen.Add(Convert.ToBase64String(sha.ComputeHash(bytes)))) { result.Repeats++; continue; }

                        k++;
                        string name = baseName + " - p" + p.ToString().PadLeft(width, '0') + " - img" + k.ToString().PadLeft(2, '0') + ext;
                        string dir = perPage ? Path.Combine(folder, "p" + p.ToString().PadLeft(width, '0')) : folder;
                        Directory.CreateDirectory(dir);
                        // Never over an existing file: a second save beside the first gets " (2)",
                        // as the viewer's method does (WritePdfExportFile).
                        string path = Path.Combine(dir, name);
                        for (int n = 2; File.Exists(path); n++)
                            path = Path.Combine(dir, Path.GetFileNameWithoutExtension(name) + " (" + n + ")" + ext);
                        using (var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write))
                            fs.Write(bytes, 0, bytes.Length);
                        result.Files++;
                        if (original) result.Originals++; else result.Converted++;
                    }
                    if (k > 0) result.WrittenOnPage[p] = k;
                    done++;
                    progress(done, result.Files);
                }
            }
            return result;
        }

        /// <summary>The picture as a file, or null to leave it to the viewer.</summary>
        private static byte[] Encode(IPdfImage img, bool png, out string ext, out bool original)
        {
            ext = null; original = false;
            // Transparency lives in a separate mask image; saved alone the picture would lose it.
            if (img.MaskImage != null) return null;
            var filters = Filters(img.ImageDictionary);
            string only = filters.Count == 1 ? filters[0] : null;
            bool plainDecode = DefaultDecode(img);

            if (only == "DCTDecode" || only == "DCT")
            {
                // A Decode array means the PDF shows these colours transformed; the file's own
                // bytes would not look like the page.
                if (!plainDecode) return null;
                byte[] jpeg = img.RawMemory.ToArray();
                if (jpeg.Length < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8) return null;
                if (!png) { ext = ".jpg"; original = true; return jpeg; }
                // As PNG: decoded once by Windows. CMYK colour needs the PDF's own conversion.
                if (img.ColorSpaceDetails != null && img.ColorSpaceDetails.NumberOfColorComponents == 4) return null;
                ext = ".png";
                return JpegToPng(jpeg);
            }
            if (only == "JPXDecode")
            {
                if (png) return null;                        // Windows cannot decode JPEG 2000
                byte[] jpx = img.RawMemory.ToArray();
                // A JP2 file (a box structure) or a bare codestream: named for which it is.
                bool jp2 = jpx.Length > 12 && jpx[4] == 0x6A && jpx[5] == 0x50 && jpx[6] == 0x20 && jpx[7] == 0x20;
                bool j2k = jpx.Length > 4 && jpx[0] == 0xFF && jpx[1] == 0x4F;
                if (!jp2 && !j2k) return null;
                ext = jp2 ? ".jp2" : ".j2k"; original = true;
                return jpx;
            }
            if (filters.Contains("JBIG2Decode")) return null;

            // Stored samples (Flate, LZW, run-length, CCITT fax, uncompressed): a PNG made from
            // them is exact. Original and PNG are the same thing here.
            byte[] pngBytes = FastPng(img);
            if (pngBytes == null && (!img.TryGetPng(out pngBytes) || pngBytes == null || pngBytes.Length == 0)) return null;
            ext = ".png";
            return pngBytes;
        }

        /// <summary>
        /// A PNG of a grey (1, 2, 4 or 8 bits) or 8-bit RGB picture, encoded by Windows rather
        /// than by PdfPig; null for anything else, which PdfPig's own TryGetPng then does.
        ///
        /// PdfPig decodes a picture in milliseconds, but its PNG encoder is managed code and took
        /// about 90 ms a page on the Dune Encyclopedia's scans -- 1-bit CCITT fax pages -- which
        /// made this slower than the viewer there. The samples are the same; only the encoder
        /// differs, and tests/pdf-pictures-direct-app.mjs checks the pixels match PdfPig's.
        /// </summary>
        public static byte[] FastPng(IPdfImage img)
        {
            string cs = NameValue(img.ImageDictionary, "ColorSpace", "CS");
            int bpc = img.BitsPerComponent, w = img.WidthInSamples, h = img.HeightInSamples, comps;
            System.Windows.Media.PixelFormat fmt;
            if (cs == "DeviceGray" || cs == "G")
            {
                comps = 1;
                if (bpc == 1) fmt = System.Windows.Media.PixelFormats.BlackWhite;
                else if (bpc == 2) fmt = System.Windows.Media.PixelFormats.Gray2;
                else if (bpc == 4) fmt = System.Windows.Media.PixelFormats.Gray4;
                else if (bpc == 8) fmt = System.Windows.Media.PixelFormats.Gray8;
                else return null;
            }
            else if ((cs == "DeviceRGB" || cs == "RGB") && bpc == 8) { comps = 3; fmt = System.Windows.Media.PixelFormats.Rgb24; }
            else return null;
            if (w <= 0 || h <= 0) return null;

            // Decode: as stored, or (grey only) inverted -- the scans' [1 0]. Anything else is a
            // mapping this does not reproduce.
            bool invert = false;
            var d = img.Decode;
            if (d != null && d.Count > 0 && !DefaultDecode(img))
            {
                if (comps == 1 && d.Count == 2 && Math.Abs(d[0] - 1) < 1e-9 && Math.Abs(d[1]) < 1e-9) invert = true;
                else return null;
            }

            Memory<byte> mem;
            if (!img.TryGetBytesAsMemory(out mem)) return null;
            byte[] data = mem.ToArray();
            int stride = (w * comps * bpc + 7) / 8;
            if (data.Length < stride * h) return null;
            // 1 - v for any bit depth, since every value is a whole number of bits.
            if (invert) for (int i = 0; i < data.Length; i++) data[i] = (byte)~data[i];

            var src = BitmapSource.Create(w, h, 72, 72, fmt, null, data, stride);
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(src));
            using (var ms = new MemoryStream())
            {
                enc.Save(ms);
                return ms.ToArray();
            }
        }

        /// <summary>A name-valued entry of a dictionary ("/DeviceGray"), or null.</summary>
        private static string NameValue(DictionaryToken dict, string key, string shortKey)
        {
            if (dict == null) return null;
            foreach (var kv in dict.Data)
            {
                if (kv.Key == key || kv.Key == shortKey)
                {
                    var n = kv.Value as NameToken;
                    return n != null ? n.Data : null;
                }
            }
            return null;
        }

        private static List<string> Filters(DictionaryToken dict)
        {
            var list = new List<string>();
            if (dict == null) return list;
            IToken t = null;
            foreach (var kv in dict.Data)
            {
                if (kv.Key == "Filter" || kv.Key == "F") { t = kv.Value; break; }
            }
            var name = t as NameToken;
            if (name != null) { list.Add(name.Data); return list; }
            var arr = t as ArrayToken;
            if (arr != null) foreach (var x in arr.Data) { var n = x as NameToken; if (n != null) list.Add(n.Data); }
            return list;
        }

        private static bool DefaultDecode(IPdfImage img)
        {
            var d = img.Decode;
            if (d == null || d.Count == 0) return true;
            for (int i = 0; i + 1 < d.Count; i += 2)
                if (Math.Abs(d[i]) > 1e-9 || Math.Abs(d[i + 1] - 1) > 1e-9) return false;
            return true;
        }

        private static byte[] JpegToPng(byte[] jpeg)
        {
            using (var ms = new MemoryStream(jpeg))
            {
                var dec = new JpegBitmapDecoder(ms, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                var enc = new PngBitmapEncoder();
                enc.Frames.Add(BitmapFrame.Create(dec.Frames[0]));
                using (var outMs = new MemoryStream())
                {
                    enc.Save(outMs);
                    return outMs.ToArray();
                }
            }
        }
    }
}
