using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace TypoZen
{
    /// <summary>
    /// Direct client for Microsoft Edge Natural Text-to-Speech service.
    /// Connects via native TLS/TCP WebSocket (no external NuGet, no DLL shims, zero Defender false-positives).
    /// Purely opt-in: zero network activity when disabled or during Privacy Mode.
    /// </summary>
    public static class EdgeSpeechClient
    {
        private const string Host = "speech.platform.bing.com";
        private const int Port = 443;
        private const string TrustedClientToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
        private const string SecMsGecVersion = "1-143.0.3650.75";
        private const string Origin = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
        private const string UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

        public class EdgeVoice
        {
            public string ShortName { get; }
            public string DisplayName { get; }
            public string Culture { get; }
            public string Gender { get; }

            public EdgeVoice(string shortName, string displayName, string culture, string gender)
            {
                ShortName = shortName;
                DisplayName = displayName;
                Culture = culture;
                Gender = gender;
            }
        }

        /// <summary>
        /// Curated collection of high-quality Microsoft Natural voices.
        /// </summary>
        public static readonly List<EdgeVoice> CuratedVoices = new List<EdgeVoice>
        {
            // United Kingdom
            new EdgeVoice("en-GB-SoniaNeural", "Microsoft Sonia (Online)", "en-GB", "Female"),
            new EdgeVoice("en-GB-RyanNeural", "Microsoft Ryan (Online)", "en-GB", "Male"),
            new EdgeVoice("en-GB-LibbyNeural", "Microsoft Libby (Online)", "en-GB", "Female"),
            new EdgeVoice("en-GB-MaisieNeural", "Microsoft Maisie (Online)", "en-GB", "Female"),
            new EdgeVoice("en-GB-ThomasNeural", "Microsoft Thomas (Online)", "en-GB", "Male"),

            // United States
            new EdgeVoice("en-US-JennyNeural", "Microsoft Jenny (Online)", "en-US", "Female"),
            new EdgeVoice("en-US-GuyNeural", "Microsoft Guy (Online)", "en-US", "Male"),
            new EdgeVoice("en-US-AriaNeural", "Microsoft Aria (Online)", "en-US", "Female"),
            new EdgeVoice("en-US-ChristopherNeural", "Microsoft Christopher (Online)", "en-US", "Male"),
            new EdgeVoice("en-US-EricNeural", "Microsoft Eric (Online)", "en-US", "Male"),
            new EdgeVoice("en-US-MichelleNeural", "Microsoft Michelle (Online)", "en-US", "Female"),
            new EdgeVoice("en-US-AnaNeural", "Microsoft Ana (Online)", "en-US", "Female"),

            // Australia
            new EdgeVoice("en-AU-NatashaNeural", "Microsoft Natasha (Online)", "en-AU", "Female"),
            new EdgeVoice("en-AU-WilliamNeural", "Microsoft William (Online)", "en-AU", "Male"),

            // Canada
            new EdgeVoice("en-CA-ClaraNeural", "Microsoft Clara (Online)", "en-CA", "Female"),
            new EdgeVoice("en-CA-LiamNeural", "Microsoft Liam (Online)", "en-CA", "Male"),

            // Ireland
            new EdgeVoice("en-IE-EmilyNeural", "Microsoft Emily (Online)", "en-IE", "Female"),
            new EdgeVoice("en-IE-ConnorNeural", "Microsoft Connor (Online)", "en-IE", "Male"),

            // India
            new EdgeVoice("en-IN-NeerjaNeural", "Microsoft Neerja (Online)", "en-IN", "Female"),
            new EdgeVoice("en-IN-PrabhatNeural", "Microsoft Prabhat (Online)", "en-IN", "Male"),

            // New Zealand & South Africa
            new EdgeVoice("en-NZ-MollyNeural", "Microsoft Molly (Online)", "en-NZ", "Female"),
            new EdgeVoice("en-NZ-MitchellNeural", "Microsoft Mitchell (Online)", "en-NZ", "Male"),
            new EdgeVoice("en-ZA-LeahNeural", "Microsoft Leah (Online)", "en-ZA", "Female"),
            new EdgeVoice("en-ZA-LukeNeural", "Microsoft Luke (Online)", "en-ZA", "Male"),

            // European Languages
            new EdgeVoice("fr-FR-DeniseNeural", "Microsoft Denise (Online)", "fr-FR", "Female"),
            new EdgeVoice("fr-FR-HenriNeural", "Microsoft Henri (Online)", "fr-FR", "Male"),
            new EdgeVoice("de-DE-KatjaNeural", "Microsoft Katja (Online)", "de-DE", "Female"),
            new EdgeVoice("de-DE-ConradNeural", "Microsoft Conrad (Online)", "de-DE", "Male"),
            new EdgeVoice("es-ES-ElviraNeural", "Microsoft Elvira (Online)", "es-ES", "Female"),
            new EdgeVoice("es-ES-AlvaroNeural", "Microsoft Alvaro (Online)", "es-ES", "Male"),
            new EdgeVoice("it-IT-ElsaNeural", "Microsoft Elsa (Online)", "it-IT", "Female"),
            new EdgeVoice("it-IT-DiegoNeural", "Microsoft Diego (Online)", "it-IT", "Male"),
            new EdgeVoice("ja-JP-NanamiNeural", "Microsoft Nanami (Online)", "ja-JP", "Female"),
            new EdgeVoice("ja-JP-KeitaNeural", "Microsoft Keita (Online)", "ja-JP", "Male")
        };

        public static List<VoiceInfo> GetVoices()
        {
            var list = new List<VoiceInfo>();
            foreach (var v in CuratedVoices)
            {
                list.Add(new VoiceInfo
                {
                    Id = "edge:" + v.ShortName,
                    Name = v.DisplayName,
                    IsSapi = false,
                    Kind = "cloud",
                    Culture = v.Culture,
                    Gender = v.Gender
                });
            }
            return list;
        }

        private static string GenerateSecMsGec()
        {
            // Windows File Time epoch (1601-01-01) is 11644473600 seconds before Unix epoch
            long unixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            double ticks = (double)(unixSeconds + 11644473600L);
            ticks -= ticks % 300; // Round down to 5-minute window
            ticks *= 1e7;         // Convert seconds to 100-nanosecond intervals

            string strToHash = ticks.ToString("F0", System.Globalization.CultureInfo.InvariantCulture) + TrustedClientToken;
            using (var sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.ASCII.GetBytes(strToHash));
                var sb = new StringBuilder(hash.Length * 2);
                foreach (byte b in hash) sb.Append(b.ToString("X2"));
                return sb.ToString();
            }
        }

        private static string GenerateMuid()
        {
            byte[] bytes = new byte[16];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var sb = new StringBuilder(32);
            foreach (byte b in bytes) sb.Append(b.ToString("X2"));
            return sb.ToString();
        }

        public static async Task<bool> SynthesizeToFileAsync(
            string text,
            string voiceShortName,
            double speed,
            string outputPath,
            Action<string> log = null,
            CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(text)) return false;
            if (string.IsNullOrEmpty(voiceShortName)) voiceShortName = "en-GB-SoniaNeural";

            string gec = GenerateSecMsGec();
            string connId = Guid.NewGuid().ToString("N");
            string path = string.Format(
                "/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken={0}&ConnectionId={1}&Sec-MS-GEC={2}&Sec-MS-GEC-Version={3}",
                TrustedClientToken, connId, gec, SecMsGecVersion);

            TcpClient tcp = null;
            SslStream ssl = null;
            FileStream outStream = null;

            try
            {
                ct.ThrowIfCancellationRequested();

                tcp = new TcpClient();
                var connectTask = tcp.ConnectAsync(Host, Port);
                using (ct.Register(() => { try { tcp?.Close(); } catch { } }))
                {
                    await connectTask.ConfigureAwait(false);
                }

                ct.ThrowIfCancellationRequested();

                ssl = new SslStream(tcp.GetStream(), false);
                await ssl.AuthenticateAsClientAsync(Host).ConfigureAwait(false);

                // Create Sec-WebSocket-Key
                byte[] keyBytes = new byte[16];
                using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(keyBytes);
                string secKey = Convert.ToBase64String(keyBytes);
                string muid = GenerateMuid();

                string req = "GET " + path + " HTTP/1.1\r\n" +
                             "Host: " + Host + "\r\n" +
                             "Upgrade: websocket\r\n" +
                             "Connection: Upgrade\r\n" +
                             "Sec-WebSocket-Key: " + secKey + "\r\n" +
                             "Sec-WebSocket-Version: 13\r\n" +
                             "User-Agent: " + UserAgent + "\r\n" +
                             "Origin: " + Origin + "\r\n" +
                             "Pragma: no-cache\r\n" +
                             "Cache-Control: no-cache\r\n" +
                             "Cookie: muid=" + muid + ";\r\n\r\n";

                byte[] reqBytes = Encoding.ASCII.GetBytes(req);
                await ssl.WriteAsync(reqBytes, 0, reqBytes.Length, ct).ConfigureAwait(false);
                await ssl.FlushAsync(ct).ConfigureAwait(false);

                // Read HTTP Upgrade response
                string statusLine = await ReadLineAsync(ssl, ct).ConfigureAwait(false);
                if (statusLine == null || !statusLine.Contains("101"))
                {
                    log?.Invoke("edge-tts handshake failed: " + (statusLine ?? "no response"));
                    return false;
                }

                // Consume remaining headers until empty line
                while (true)
                {
                    string h = await ReadLineAsync(ssl, ct).ConfigureAwait(false);
                    if (string.IsNullOrEmpty(h)) break;
                }

                // 1. Send speech.config
                string cfgJson = "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}";
                string cfgMsg = "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" + cfgJson;
                await SendWsFrameAsync(ssl, Encoding.UTF8.GetBytes(cfgMsg), 0x01, ct).ConfigureAwait(false);

                // 2. Send SSML
                int ratePct = (int)Math.Round((speed - 1.0) * 100.0);
                string rateStr = (ratePct >= 0 ? "+" : "") + ratePct + "%";
                string escapedText = System.Security.SecurityElement.Escape(text);

                string ssml = string.Format(
                    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
                    "<voice name='{0}'>" +
                    "<prosody pitch='+0Hz' rate='{1}' volume='+0%'>{2}</prosody>" +
                    "</voice></speak>",
                    voiceShortName, rateStr, escapedText);

                string reqId = Guid.NewGuid().ToString("N");
                string ssmlMsg = "X-RequestId:" + reqId + "\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n" + ssml;
                await SendWsFrameAsync(ssl, Encoding.UTF8.GetBytes(ssmlMsg), 0x01, ct).ConfigureAwait(false);

                // 3. Receive binary audio frames into file
                outStream = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.Read);
                bool turnEnd = false;

                while (!turnEnd)
                {
                    ct.ThrowIfCancellationRequested();

                    byte[] hdr = await ReadExactAsync(ssl, 2, ct).ConfigureAwait(false);
                    int opcode = hdr[0] & 0x0F;
                    int payloadLen = hdr[1] & 0x7F;

                    if (payloadLen == 126)
                    {
                        byte[] ext = await ReadExactAsync(ssl, 2, ct).ConfigureAwait(false);
                        payloadLen = (ext[0] << 8) | ext[1];
                    }
                    else if (payloadLen == 127)
                    {
                        byte[] ext = await ReadExactAsync(ssl, 8, ct).ConfigureAwait(false);
                        // Big-endian uint64 length
                        long l = 0;
                        for (int i = 0; i < 8; i++) l = (l << 8) | ext[i];
                        payloadLen = (int)l;
                    }

                    byte[] payload = await ReadExactAsync(ssl, payloadLen, ct).ConfigureAwait(false);

                    if (opcode == 0x01)
                    {
                        // Text frame
                        string txt = Encoding.UTF8.GetString(payload);
                        if (txt.IndexOf("Path:turn.end", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            turnEnd = true;
                        }
                    }
                    else if (opcode == 0x02)
                    {
                        // Binary frame: 2-byte header length, then ASCII headers, then audio bytes
                        if (payload.Length > 2)
                        {
                            int headerLen = (payload[0] << 8) | payload[1];
                            int audioStart = 2 + headerLen;
                            if (payload.Length > audioStart)
                            {
                                int audioBytes = payload.Length - audioStart;
                                await outStream.WriteAsync(payload, audioStart, audioBytes, ct).ConfigureAwait(false);
                            }
                        }
                    }
                    else if (opcode == 0x08)
                    {
                        // Close frame
                        turnEnd = true;
                    }
                }

                outStream.Flush();
                return outStream.Length > 0;
            }
            catch (OperationCanceledException)
            {
                log?.Invoke("edge-tts cancelled");
                return false;
            }
            catch (Exception ex)
            {
                log?.Invoke("edge-tts error: " + ex.Message);
                return false;
            }
            finally
            {
                try { outStream?.Dispose(); } catch { }
                try { ssl?.Dispose(); } catch { }
                try { tcp?.Close(); } catch { }
            }
        }

        private static async Task SendWsFrameAsync(Stream stream, byte[] payload, byte opcode, CancellationToken ct)
        {
            byte[] mask = new byte[4];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(mask);

            byte[] masked = new byte[payload.Length];
            for (int i = 0; i < payload.Length; i++)
            {
                masked[i] = (byte)(payload[i] ^ mask[i % 4]);
            }

            var header = new List<byte>();
            header.Add((byte)(0x80 | opcode)); // FIN + opcode

            int len = payload.Length;
            if (len <= 125)
            {
                header.Add((byte)(0x80 | len)); // Mask bit set
            }
            else if (len <= 65535)
            {
                header.Add((byte)(0x80 | 126));
                header.Add((byte)((len >> 8) & 0xFF));
                header.Add((byte)(len & 0xFF));
            }
            else
            {
                header.Add((byte)(0x80 | 127));
                for (int i = 7; i >= 0; i--) header.Add((byte)((len >> (i * 8)) & 0xFF));
            }

            header.AddRange(mask);
            byte[] hdrBytes = header.ToArray();

            await stream.WriteAsync(hdrBytes, 0, hdrBytes.Length, ct).ConfigureAwait(false);
            await stream.WriteAsync(masked, 0, masked.Length, ct).ConfigureAwait(false);
            await stream.FlushAsync(ct).ConfigureAwait(false);
        }

        private static async Task<byte[]> ReadExactAsync(Stream stream, int count, CancellationToken ct)
        {
            byte[] buffer = new byte[count];
            int read = 0;
            while (read < count)
            {
                int n = await stream.ReadAsync(buffer, read, count - read, ct).ConfigureAwait(false);
                if (n <= 0) throw new EndOfStreamException("Connection closed by remote host");
                read += n;
            }
            return buffer;
        }

        private static async Task<string> ReadLineAsync(Stream stream, CancellationToken ct)
        {
            var sb = new StringBuilder();
            byte[] b = new byte[1];
            while (true)
            {
                int n = await stream.ReadAsync(b, 0, 1, ct).ConfigureAwait(false);
                if (n <= 0) break;
                char c = (char)b[0];
                if (c == '\r') continue;
                if (c == '\n') break;
                sb.Append(c);
            }
            return sb.ToString();
        }
    }
}
