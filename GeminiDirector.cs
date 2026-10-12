using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace TypoZen
{
    /// <summary>
    /// AI Script Director & Dialogue Attribution Engine powered by Google Gemini.
    /// Analyzes literary narrative, discovers characters, maps them to universal voice archetypes,
    /// and accurately attributes dialogue quotes across complex multi-turn banter and pronouns.
    /// </summary>
    public static class GeminiDirector
    {
        public const string DefaultModel = "gemini-2.5-flash";
        public const string FallbackModel = "gemini-2.0-flash";

        public sealed class VoiceOption
        {
            public string Id { get; set; }
            public string Name { get; set; }
            public string Description { get; set; }
        }

        public sealed class CharacterCast
        {
            public string Key { get; set; }
            public string Name { get; set; }
            public string Voice { get; set; }
            public string Instruction { get; set; }
            public double Strength { get; set; }
            public int Lines { get; set; }
        }

        public sealed class QuoteAttribution
        {
            public int Para { get; set; }
            public string Quote { get; set; }
            public string Speaker { get; set; }
            public string Cue { get; set; }
        }

        public sealed class GeminiCastResult
        {
            public List<CharacterCast> Characters = new List<CharacterCast>();
            public List<QuoteAttribution> Quotes = new List<QuoteAttribution>();
            public string ModelUsed { get; set; }
        }

        #region API Key Storage (DPAPI)

        private static string KeyFilePath()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(appData, "TypoZen", "gemini.key");
        }

        public static bool HasApiKey()
        {
            return !string.IsNullOrEmpty(GetApiKey());
        }

        public static string GetApiKey()
        {
            // 1. Environment variable
            string env = Environment.GetEnvironmentVariable("GEMINI_API_KEY");
            if (!string.IsNullOrEmpty(env)) return env.Trim();

            // 2. Encrypted DPAPI file
            string path = KeyFilePath();
            if (!File.Exists(path)) return "";
            try
            {
                byte[] enc = File.ReadAllBytes(path);
                byte[] raw = ProtectedData.Unprotect(enc, null, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(raw).Trim();
            }
            catch
            {
                // Fallback attempt if plain text
                try
                {
                    string txt = File.ReadAllText(path, Encoding.UTF8).Trim();
                    if (txt.StartsWith("AIza", StringComparison.OrdinalIgnoreCase)) return txt;
                }
                catch { }
                return "";
            }
        }

        public static void SaveApiKey(string key)
        {
            key = (key ?? "").Trim();
            string path = KeyFilePath();
            if (string.IsNullOrEmpty(key))
            {
                try { if (File.Exists(path)) File.Delete(path); } catch { }
                return;
            }
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                byte[] raw = Encoding.UTF8.GetBytes(key);
                byte[] enc = ProtectedData.Protect(raw, null, DataProtectionScope.CurrentUser);
                File.WriteAllBytes(path, enc);
            }
            catch (Exception)
            {
                // Fallback to obscure storage if DPAPI fails on specific system configurations
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllText(path, key, Encoding.UTF8);
            }
        }

        #endregion

        #region Prompt Construction & REST Client

        public static GeminiCastResult AnalyzeAndCast(string bookTitle, List<string> dialogueBlocks, List<VoiceOption> availableVoices, string customApiKey = null, string model = DefaultModel)
        {
            string apiKey = !string.IsNullOrEmpty(customApiKey) ? customApiKey.Trim() : GetApiKey();
            if (string.IsNullOrEmpty(apiKey))
                throw new InvalidOperationException("No Google Gemini API key provided. Please enter your Gemini API key.");

            if (dialogueBlocks == null || dialogueBlocks.Count == 0)
                throw new ArgumentException("No dialogue paragraphs provided to analyze.");

            // Build voice catalog description for Gemini
            var voiceSb = new StringBuilder();
            foreach (var v in availableVoices)
            {
                if (string.IsNullOrEmpty(v.Id)) continue;
                voiceSb.AppendLine(string.Format("- Voice ID: \"{0}\", Name: \"{1}\", Acoustic traits: \"{2}\"", v.Id, v.Name, v.Description ?? ""));
            }

            // Build dialogue text blocks
            var textSb = new StringBuilder();
            for (int i = 0; i < dialogueBlocks.Count; i++)
            {
                textSb.AppendLine(string.Format("[Paragraph {0}]: {1}", i, dialogueBlocks[i]));
            }

            string systemPrompt = 
@"You are an expert Audio Drama Casting Director and Literary Dialogue Attributor.
Analyze the provided novel excerpt, discover all speaking characters, map them to the best-fitting voice archetype from the provided catalog, and attribute each spoken dialogue quotation accurately.

RULES:
1. Character Attribution:
   - Identify the TRUE speaker for each quotation in [Paragraph N], resolving pronouns ('he said', 'she replied'), relational titles ('Paul's mother', 'the Duke's concubine'), epithets ('the old woman', 'the doctor'), and multi-turn banter without speech tags.
   - Use a clean, lowercase canonical key for each character (e.g., 'paul', 'jessica', 'leto', 'mohiam', 'gurney', 'chani', 'stilgar', 'hawat', 'piter', 'baron', 'yueh').
2. Voice Casting:
   - For every character, assign the best matching Voice ID from the available voice catalog based on gender, age, tone, and personality.
   - Provide a standing acting instruction (under 60 characters) and emotion strength (1.0 to 10.0, default 4.0).
   - Count the total dialogue lines spoken by each character.
3. Delivery Cues:
   - If the text indicates an emotional cue or tone for a quote (e.g. 'whispering', 'furious', 'dryly', 'coldly', 'reverent'), capture it as 'cue'. Otherwise empty string.

You must return ONLY a JSON object conforming strictly to this JSON schema:
{
  ""characters"": [
    {
      ""key"": ""canonical_id"",
      ""name"": ""Display Name"",
      ""voice"": ""voice-id-from-catalog"",
      ""instruction"": ""acting delivery instruction"",
      ""strength"": 4.0,
      ""lines"": 12
    }
  ],
  ""quotes"": [
    {
      ""para"": 0,
      ""quote"": ""quoted text"",
      ""speaker"": ""canonical_id"",
      ""cue"": ""optional emotional delivery cue""
    }
  ]
}";

            string userPrompt = string.Format(
@"BOOK TITLE: {0}

AVAILABLE VOICE CATALOG:
{1}

TEXT TO ANALYZE AND CAST:
{2}

Remember to return ONLY the JSON object.",
                bookTitle ?? "Book", voiceSb.ToString(), textSb.ToString());

            // Attempt request with primary model, fallback if needed
            string[] modelsToTry = new string[] { model, FallbackModel, "gemini-1.5-pro", "gemini-1.5-flash" };
            Exception lastEx = null;

            foreach (var m in modelsToTry)
            {
                try
                {
                    return ExecuteGeminiRequest(apiKey, m, systemPrompt, userPrompt);
                }
                catch (WebException wex)
                {
                    lastEx = wex;
                    string respBody = ReadErrorResponse(wex);
                    if (wex.Response is HttpWebResponse httpResp && ((int)httpResp.StatusCode == 404 || (int)httpResp.StatusCode == 400))
                    {
                        // Model not supported or deprecated, try next model in list
                        continue;
                    }
                    throw new InvalidOperationException("Gemini API error (" + wex.Message + "): " + respBody, wex);
                }
                catch (Exception ex)
                {
                    lastEx = ex;
                }
            }

            throw new InvalidOperationException("Could not complete Gemini request: " + (lastEx != null ? lastEx.Message : "unknown error"), lastEx);
        }

        private static GeminiCastResult ExecuteGeminiRequest(string apiKey, string model, string systemPrompt, string userPrompt)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            string url = string.Format("https://generativelanguage.googleapis.com/v1beta/models/{0}:generateContent?key={1}", model, apiKey);

            var reqBody = new Dictionary<string, object>
            {
                {
                    "systemInstruction", new Dictionary<string, object>
                    {
                        { "parts", new object[] { new Dictionary<string, object> { { "text", systemPrompt } } } }
                    }
                },
                {
                    "contents", new object[]
                    {
                        new Dictionary<string, object>
                        {
                            { "role", "user" },
                            { "parts", new object[] { new Dictionary<string, object> { { "text", userPrompt } } } }
                        }
                    }
                },
                {
                    "generationConfig", new Dictionary<string, object>
                    {
                        { "responseMimeType", "application/json" },
                        { "temperature", 0.2 }
                    }
                }
            };

            var serializer = new JavaScriptSerializer { MaxJsonLength = 20 * 1024 * 1024 };
            string jsonPayload = serializer.Serialize(reqBody);
            byte[] payloadBytes = Encoding.UTF8.GetBytes(jsonPayload);

            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.ContentLength = payloadBytes.Length;
            request.Timeout = 120000; // 2 minutes timeout for novel chunks

            using (var stream = request.GetRequestStream())
            {
                stream.Write(payloadBytes, 0, payloadBytes.Length);
            }

            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                string respJson = reader.ReadToEnd();
                return ParseGeminiResponse(respJson, model);
            }
        }

        private static string ReadErrorResponse(WebException wex)
        {
            if (wex.Response == null) return wex.Message;
            try
            {
                using (var r = new StreamReader(wex.Response.GetResponseStream(), Encoding.UTF8))
                {
                    return r.ReadToEnd();
                }
            }
            catch { return wex.Message; }
        }

        public static GeminiCastResult ParseGeminiResponse(string respJson, string model)
        {
            var ser = new JavaScriptSerializer { MaxJsonLength = 20 * 1024 * 1024 };
            var root = ser.Deserialize<Dictionary<string, object>>(respJson);
            if (root == null) throw new FormatException("Empty JSON response from Gemini API.");

            object candidatesObj;
            if (!root.TryGetValue("candidates", out candidatesObj) || !(candidatesObj is System.Collections.IList candidatesList) || candidatesList.Count == 0)
                throw new FormatException("Gemini returned no response candidates.");

            var firstCand = candidatesList[0] as Dictionary<string, object>;
            if (firstCand == null) throw new FormatException("Invalid candidate format in Gemini response.");

            object contentObj;
            if (!firstCand.TryGetValue("content", out contentObj) || !(contentObj is Dictionary<string, object> contentDict))
                throw new FormatException("Invalid content in Gemini candidate.");

            object partsObj;
            if (!contentDict.TryGetValue("parts", out partsObj) || !(partsObj is System.Collections.IList partsList) || partsList.Count == 0)
                throw new FormatException("No parts in Gemini response content.");

            var firstPart = partsList[0] as Dictionary<string, object>;
            object textObj;
            if (firstPart == null || !firstPart.TryGetValue("text", out textObj) || !(textObj is string rawText))
                throw new FormatException("No text in Gemini response part.");

            // Parse output JSON (strip markdown code fence if present)
            string cleanJson = rawText.Trim();
            if (cleanJson.StartsWith("```json", StringComparison.OrdinalIgnoreCase))
                cleanJson = cleanJson.Substring(7);
            else if (cleanJson.StartsWith("```", StringComparison.OrdinalIgnoreCase))
                cleanJson = cleanJson.Substring(3);
            if (cleanJson.EndsWith("```", StringComparison.OrdinalIgnoreCase))
                cleanJson = cleanJson.Substring(0, cleanJson.Length - 3);
            cleanJson = cleanJson.Trim();

            var data = ser.Deserialize<Dictionary<string, object>>(cleanJson);
            if (data == null) throw new FormatException("Could not deserialize cast output from Gemini.");

            var result = new GeminiCastResult { ModelUsed = model };

            // 1. Parse Characters
            object charsObj;
            if (data.TryGetValue("characters", out charsObj) && charsObj is System.Collections.IEnumerable charsEnum)
            {
                foreach (var item in charsEnum)
                {
                    if (item is Dictionary<string, object> c)
                    {
                        string key = Convert.ToString(c.ContainsKey("key") ? c["key"] : "").Trim().ToLowerInvariant();
                        string name = Convert.ToString(c.ContainsKey("name") ? c["name"] : key).Trim();
                        string voice = Convert.ToString(c.ContainsKey("voice") ? c["voice"] : "").Trim();
                        string instr = Convert.ToString(c.ContainsKey("instruction") ? c["instruction"] : "").Trim();
                        double strength = 4.0;
                        if (c.ContainsKey("strength") && c["strength"] != null)
                        {
                            try { strength = Math.Max(1.0, Math.Min(10.0, Convert.ToDouble(c["strength"]))); } catch { }
                        }
                        int lines = 0;
                        if (c.ContainsKey("lines") && c["lines"] != null)
                        {
                            try { lines = Convert.ToInt32(c["lines"]); } catch { }
                        }

                        if (!string.IsNullOrEmpty(key))
                        {
                            result.Characters.Add(new CharacterCast
                            {
                                Key = key,
                                Name = name,
                                Voice = voice,
                                Instruction = instr,
                                Strength = strength,
                                Lines = lines
                            });
                        }
                    }
                }
            }

            // 2. Parse Quotes
            object quotesObj;
            if (data.TryGetValue("quotes", out quotesObj) && quotesObj is System.Collections.IEnumerable quotesEnum)
            {
                foreach (var item in quotesEnum)
                {
                    if (item is Dictionary<string, object> q)
                    {
                        int para = 0;
                        if (q.ContainsKey("para") && q["para"] != null)
                        {
                            try { para = Convert.ToInt32(q["para"]); } catch { }
                        }
                        string quoteText = Convert.ToString(q.ContainsKey("quote") ? q["quote"] : "").Trim();
                        string speaker = Convert.ToString(q.ContainsKey("speaker") ? q["speaker"] : "").Trim().ToLowerInvariant();
                        string cue = Convert.ToString(q.ContainsKey("cue") ? q["cue"] : "").Trim();

                        if (!string.IsNullOrEmpty(quoteText) && !string.IsNullOrEmpty(speaker))
                        {
                            result.Quotes.Add(new QuoteAttribution
                            {
                                Para = para,
                                Quote = quoteText,
                                Speaker = speaker,
                                Cue = cue
                            });
                        }
                    }
                }
            }

            return result;
        }

        #endregion
    }
}
