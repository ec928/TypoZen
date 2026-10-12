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
        public const string DefaultModel = "gemini-3.8-flash";
        public const string FallbackModel = "gemini-flash-latest";

        public sealed class VoiceOption
        {
            public string Id { get; set; }
            public string Name { get; set; }
            public string Description { get; set; }
        }

        public static readonly List<VoiceOption> UniversalArchetypes = new List<VoiceOption>
        {
            new VoiceOption { Id = "hero-youth-m", Name = "Hero / Youth (Male)", Description = "Clear bright tenor, thoughtful, observant, earnest, youthful hero" },
            new VoiceOption { Id = "noble-matriarch-f", Name = "Noble Matriarch (Female)", Description = "Soft melodious contralto, composed, serene, poised, quiet penetrating authority" },
            new VoiceOption { Id = "ruler-commander-m", Name = "Ruler / Commander (Male)", Description = "Deep resonant baritone, charismatic, dignified, natural command, emperor/duke" },
            new VoiceOption { Id = "crone-inquisitor-f", Name = "Crone / Inquisitor (Female)", Description = "Elderly raspy dry voice, sharp biting cadences, cold severe authority" },
            new VoiceOption { Id = "veteran-soldier-m", Name = "Veteran Soldier (Male)", Description = "Rough gravelly baritone, battle-scarred warrior, warm poetic cadence" },
            new VoiceOption { Id = "servant-companion-m", Name = "Servant / Companion (Male)", Description = "Earthy grounded baritone, practical, loyal retainer, dry wit" },
            new VoiceOption { Id = "maid-attendant-f", Name = "Maid / Attendant (Female)", Description = "Practical warm alto, bustling, caring yet firm, housekeeper" },
            new VoiceOption { Id = "guard-sentry-m", Name = "Guard / Sentry (Male)", Description = "Gruff blunt tenor/baritone, barking military brevity, vigilant soldier" },
            new VoiceOption { Id = "fierce-warrior-f", Name = "Fierce Warrior (Female)", Description = "Resonant mezzo, young desert warrior, clear, fierce, ringing intensity" },
            new VoiceOption { Id = "arrogant-noble-m", Name = "Arrogant Noble (Male)", Description = "High-strung tenor, petulant, proud, theatrical, vain rival" },
            new VoiceOption { Id = "scheming-courtier-m", Name = "Scheming Courtier (Male)", Description = "Silky smooth oily baritone, hypocritical warmth, polished, sinister vizier" },
            new VoiceOption { Id = "scholar-mentat-m", Name = "Scholar / Mentat (Male)", Description = "Precise elderly intellectual, dry calculating clinical gravelly diction" },
            new VoiceOption { Id = "twisted-minion-m", Name = "Twisted Minion (Male)", Description = "Sibilant tenor, purring whisper, sadistic, gloating, theatrical poisoner" },
            new VoiceOption { Id = "tyrant-overlord-m", Name = "Tyrant / Overlord (Male)", Description = "Deep rumbling bass, heavy, guttural, menacing tyrannical villain" },
            new VoiceOption { Id = "nomad-chieftain-m", Name = "Nomad Chieftain (Male)", Description = "Weathered desert baritone, solemn, sand-blown, reverent, tribal naib" },
            new VoiceOption { Id = "sorrowful-healer-m", Name = "Sorrowful Healer (Male)", Description = "Melancholic gentle tenor, soft-spoken with heavy hesitant weary grief" },
            new VoiceOption { Id = "synthetic-drone-x", Name = "Synthetic Drone (Neutral)", Description = "Crisp synthesized neutral mid-register, hyper-articulate, understated wit" },
            new VoiceOption { Id = "ingenue-ward-f", Name = "Ingenue / Ward (Female)", Description = "Lyrical soprano, sweet, innocent, curious melodic delivery, young princess" },
            new VoiceOption { Id = "alien-emissary-x", Name = "Alien Emissary (Neutral)", Description = "Spacious ethereal echoing resonant cadence, ancient, enigmatic cosmic entity" }
        };

        public sealed class CharacterCast
        {
            public string Key { get; set; }
            public string Name { get; set; }
            public string Voice { get; set; }
            public string Instruction { get; set; }
            public double Strength { get; set; }
            public int Lines { get; set; }
            public string Role { get; set; }
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

        private static string CleanBookTitle(string title)
        {
            if (string.IsNullOrWhiteSpace(title)) return "Book";
            try
            {
                title = Path.GetFileNameWithoutExtension(title);
            }
            catch { }
            title = title.Replace('_', ' ').Trim();
            return string.IsNullOrEmpty(title) ? "Book" : title;
        }

        private static List<VoiceOption> GetConsolidatedVoiceCatalog(List<VoiceOption> availableVoices)
        {
            var result = new List<VoiceOption>();
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            if (availableVoices != null)
            {
                foreach (var v in availableVoices)
                {
                    if (string.IsNullOrEmpty(v.Id)) continue;
                    result.Add(v);
                    ids.Add(v.Id);
                }
            }

            foreach (var arch in UniversalArchetypes)
            {
                if (!ids.Contains(arch.Id))
                {
                    result.Add(arch);
                    ids.Add(arch.Id);
                }
            }
            return result;
        }

        private static string FormatVoiceCatalogForPrompt(List<VoiceOption> catalog)
        {
            var sb = new StringBuilder();
            foreach (var v in catalog)
            {
                if (string.IsNullOrEmpty(v.Id)) continue;
                sb.AppendLine(string.Format("- Voice ID: \"{0}\", Name: \"{1}\", Acoustic traits: \"{2}\"", v.Id, v.Name, v.Description ?? ""));
            }
            return sb.ToString();
        }

        /// <summary>
        /// Phase 1: Discovers the comprehensive novel cast across the entire book (all major, supporting, and recurring characters).
        /// </summary>
        public static List<CharacterCast> DiscoverBookDramatisPersonae(
            string apiKey,
            string bookTitle,
            List<string> sampleExcerpts,
            List<VoiceOption> voiceCatalog,
            ref string modelUsed,
            string preferredModel = DefaultModel)
        {
            var catalogText = FormatVoiceCatalogForPrompt(voiceCatalog);
            var excerptsSb = new StringBuilder();
            if (sampleExcerpts != null)
            {
                int count = Math.Min(sampleExcerpts.Count, 8);
                for (int i = 0; i < count; i++)
                {
                    excerptsSb.AppendLine(string.Format("[Excerpt {0}]: {1}", i + 1, sampleExcerpts[i]));
                }
            }

            string systemPrompt =
@"You are an expert Audio Drama Casting Director and Literary Scholar.
Given a novel's title and sample excerpts, discover and cast the COMPLETE DRAMATIS PERSONAE for the ENTIRE NOVEL (all major, supporting, and key recurring characters: protagonists, antagonists, mentors, rulers, warriors, retainers, and specialists).
Map every single character to the most fitting voice archetype from the provided catalog.

RULES:
1. Comprehensiveness: For recognized literary works, epics, and novels (e.g. Dune, Matter, Pride and Prejudice, etc.), you MUST cast the entire novel's dramatis personae (15-25 characters), NOT just the characters who speak in the opening excerpt.
   Include characters across the entire work (e.g. for Dune: Baron Vladimir Harkonnen, Emperor Shaddam IV, Paul Atreides, Lady Jessica, Duke Leto Atreides, Thufir Hawat, Gurney Halleck, Duncan Idaho, Stilgar, Chani, Dr. Wellington Yueh, Reverend Mother Gaius Helen Mohiam, Feyd-Rautha, Glossu Rabban, Piter De Vries, Princess Irulan, Count Fenring, Alia Atreides, Shadout Mapes, Liet-Kynes).
2. Character Keys: Use clean, lowercase canonical keys (e.g. 'paul', 'jessica', 'leto', 'baron', 'emperor', 'feyd', 'rabban', 'piter', 'stilgar', 'chani', 'gurney', 'idaho', 'hawat', 'yueh', 'mohiam', 'irulan', 'mapes', 'kynes', 'fenring', 'alia').
3. Voice Archetype: Choose the best-fitting Voice ID from the catalog based on gender, vocal register, acoustic traits, and character personality.
4. Acting Instruction: Provide vivid acting delivery instructions (under 60 chars) suitable for TTS emotion prompting.
5. Emotion Strength: Assign a recommended Breeze emotion strength between 1.0 and 10.0 (default 4.0).
6. Dramatic Role: Briefly describe their dramatic function or archetype.

Return ONLY a valid JSON object adhering strictly to this JSON schema:
{
  ""characters"": [
    {
      ""key"": ""canonical_id"",
      ""name"": ""Full Display Name"",
      ""voice"": ""voice-id-from-catalog"",
      ""instruction"": ""acting delivery instruction"",
      ""strength"": 4.0,
      ""role"": ""Dramatic role""
    }
  ]
}";

            string userPrompt = string.Format(
@"BOOK TITLE: {0}

SAMPLE EXCERPTS:
{1}

AVAILABLE VOICE CATALOG:
{2}

Remember to return ONLY the JSON object.",
                bookTitle, excerptsSb.ToString(), catalogText);

            var result = ExecuteWithFallback(apiKey, preferredModel, systemPrompt, userPrompt);
            if (result != null)
            {
                modelUsed = result.ModelUsed;
                return result.Characters;
            }
            return new List<CharacterCast>();
        }

        /// <summary>
        /// Phase 2: Attributes spoken dialogue quotations in a batch of paragraphs to known canonical character keys.
        /// </summary>
        public static GeminiCastResult AttributeDialogueChunk(
            string apiKey,
            List<string> chunkBlocks,
            int startIdx,
            List<CharacterCast> knownCharacters,
            List<VoiceOption> voiceCatalog,
            ref string modelUsed,
            string preferredModel = DefaultModel)
        {
            var textSb = new StringBuilder();
            for (int i = 0; i < chunkBlocks.Count; i++)
            {
                textSb.AppendLine(string.Format("[Paragraph {0}]: {1}", i, chunkBlocks[i]));
            }

            var knownSb = new StringBuilder();
            foreach (var kc in knownCharacters)
            {
                if (string.IsNullOrEmpty(kc.Key)) continue;
                knownSb.AppendLine(string.Format("- {0}: {1}", kc.Key, kc.Name));
            }

            var catalogText = FormatVoiceCatalogForPrompt(voiceCatalog);

            string systemPrompt =
@"You are an expert Audio Drama Dialogue Attributor.
Attribute each spoken dialogue quotation in the provided paragraphs to the TRUE speaker using the provided canonical dramatis personae keys.

RULES:
1. Canonical Speaker Keys: Use the provided character keys whenever possible (e.g. 'paul', 'jessica', 'mohiam', 'hawat', 'leto', 'baron', 'emperor', etc.).
2. Attribution Logic: Resolve pronouns ('he said', 'she whispered'), relational epithets ('his mother', 'the Duke'), and multi-turn banter without speech tags based on surrounding narrative context.
3. Delivery Cues: Extract emotional cues or delivery direction indicated in the surrounding prose (e.g. 'whispering', 'coldly', 'gently', 'furious').
4. Minor / New Characters: If an unlisted minor character speaks (e.g. a guard, soldier, or servant), create a clean lowercase key and assign them a voice archetype in 'newCharacters'.

Return ONLY a valid JSON object adhering strictly to this schema:
{
  ""quotes"": [
    {
      ""para"": 0,
      ""quote"": ""quoted text"",
      ""speaker"": ""canonical_key"",
      ""cue"": ""delivery cue""
    }
  ],
  ""newCharacters"": [
    {
      ""key"": ""canonical_key"",
      ""name"": ""Display Name"",
      ""voice"": ""voice-id-from-catalog"",
      ""instruction"": ""acting instruction"",
      ""strength"": 4.0
    }
  ]
}";

            string userPrompt = string.Format(
@"CANONICAL DRAMATIS PERSONAE:
{0}

AVAILABLE VOICE CATALOG:
{1}

PARAGRAPHS TO ATTRIBUTE:
{2}

Remember to return ONLY the JSON object.",
                knownSb.ToString(), catalogText, textSb.ToString());

            var batchRes = ExecuteWithFallback(apiKey, preferredModel, systemPrompt, userPrompt);
            if (batchRes != null)
            {
                modelUsed = batchRes.ModelUsed;
                foreach (var q in batchRes.Quotes)
                {
                    q.Para += startIdx;
                }
                return batchRes;
            }
            return new GeminiCastResult { ModelUsed = preferredModel };
        }

        public static GeminiCastResult AnalyzeAndCast(
            string bookTitle, 
            List<string> dialogueBlocks, 
            List<VoiceOption> availableVoices, 
            Action<int, int, string> onProgress = null,
            string customApiKey = null, 
            string model = DefaultModel)
        {
            string apiKey = !string.IsNullOrEmpty(customApiKey) ? customApiKey.Trim() : GetApiKey();
            if (string.IsNullOrEmpty(apiKey))
                throw new InvalidOperationException("No Google Gemini API key provided. Please enter your Gemini API key.");

            if (dialogueBlocks == null || dialogueBlocks.Count == 0)
                throw new ArgumentException("No dialogue paragraphs provided to analyze.");

            string cleanTitle = CleanBookTitle(bookTitle);
            var catalog = GetConsolidatedVoiceCatalog(availableVoices);

            const int chunkSize = 25;
            int totalToAnalyze = Math.Min(dialogueBlocks.Count, 75);
            int totalQuoteBatches = (totalToAnalyze + chunkSize - 1) / chunkSize;
            int totalSteps = 1 + totalQuoteBatches;

            string modelUsed = model;
            var charsDict = new Dictionary<string, CharacterCast>(StringComparer.OrdinalIgnoreCase);

            // ================================================================
            // PHASE 1: Discover Full Novel Dramatis Personae & Voice Archetypes
            // ================================================================
            if (onProgress != null)
                onProgress(1, totalSteps, string.Format("Discovering full novel cast for '{0}' (Part 1 of {1})...", cleanTitle, totalSteps));

            var sampleExcerpts = dialogueBlocks.GetRange(0, Math.Min(dialogueBlocks.Count, 8));
            var fullBookCast = DiscoverBookDramatisPersonae(apiKey, cleanTitle, sampleExcerpts, catalog, ref modelUsed, model);

            foreach (var fc in fullBookCast)
            {
                if (!string.IsNullOrEmpty(fc.Key) && !charsDict.ContainsKey(fc.Key))
                {
                    fc.Lines = 0; // reset lines for chapter attribution
                    charsDict[fc.Key] = fc;
                }
            }

            // ================================================================
            // PHASE 2: Attribute Dialogue Quotes in Chapter Excerpts
            // ================================================================
            var aggregatedResult = new GeminiCastResult { ModelUsed = modelUsed };

            for (int b = 0; b < totalQuoteBatches; b++)
            {
                int startIdx = b * chunkSize;
                int count = Math.Min(chunkSize, totalToAnalyze - startIdx);
                var chunkBlocks = dialogueBlocks.GetRange(startIdx, count);

                int stepNumber = b + 2;
                if (onProgress != null)
                    onProgress(stepNumber, totalSteps, string.Format("Attributing chapter dialogue quotes (Part {0} of {1})...", stepNumber, totalSteps));

                var knownList = new List<CharacterCast>(charsDict.Values);
                var chunkResult = AttributeDialogueChunk(apiKey, chunkBlocks, startIdx, knownList, catalog, ref modelUsed, model);

                // Merge quotes and increment lines count for speakers
                foreach (var q in chunkResult.Quotes)
                {
                    aggregatedResult.Quotes.Add(q);
                    if (!string.IsNullOrEmpty(q.Speaker))
                    {
                        CharacterCast existing;
                        if (charsDict.TryGetValue(q.Speaker, out existing))
                        {
                            existing.Lines++;
                        }
                    }
                }

                // Add any new minor characters discovered in dialogue
                foreach (var nc in chunkResult.Characters)
                {
                    if (!string.IsNullOrEmpty(nc.Key) && !charsDict.ContainsKey(nc.Key))
                    {
                        charsDict[nc.Key] = nc;
                    }
                }
            }

            // Separate into characters who speak in this chapter vs remaining book cast
            var speakingInChapter = new List<CharacterCast>();
            var remainingBookCast = new List<CharacterCast>();

            foreach (var c in charsDict.Values)
            {
                if (c.Lines > 0) speakingInChapter.Add(c);
                else remainingBookCast.Add(c);
            }

            // Spoken characters sorted by line count descending
            speakingInChapter.Sort((a, b) => b.Lines.CompareTo(a.Lines));

            // Combined cast: current speakers first, then the entire novel cast!
            aggregatedResult.Characters.AddRange(speakingInChapter);
            aggregatedResult.Characters.AddRange(remainingBookCast);
            aggregatedResult.ModelUsed = modelUsed;

            return aggregatedResult;
        }

        private static GeminiCastResult ExecuteWithFallback(string apiKey, string preferredModel, string systemPrompt, string userPrompt)
        {
            string[] modelsToTry = new string[] { preferredModel, "gemini-3.8-flash", "gemini-flash-latest", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-2.5-pro" };
            Exception lastEx = null;

            foreach (var m in modelsToTry)
            {
                try
                {
                    var res = ExecuteGeminiRequest(apiKey, m, systemPrompt, userPrompt);
                    if (res != null) return res;
                }
                catch (WebException wex)
                {
                    lastEx = wex;
                    if (wex.Response is HttpWebResponse httpResp && ((int)httpResp.StatusCode == 404 || (int)httpResp.StatusCode == 400))
                    {
                        continue;
                    }
                    string respBody = ReadErrorResponse(wex);
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
            request.Headers.Add("x-goog-api-key", apiKey);
            request.KeepAlive = false;
            request.ServicePoint.Expect100Continue = false;
            request.ContentLength = payloadBytes.Length;
            request.Timeout = 120000;
            request.ReadWriteTimeout = 120000;

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
            if (!data.TryGetValue("characters", out charsObj))
                data.TryGetValue("newCharacters", out charsObj);

            if (charsObj is System.Collections.IEnumerable charsEnum)
            {
                foreach (var item in charsEnum)
                {
                    if (item is Dictionary<string, object> c)
                    {
                        string key = Convert.ToString(c.ContainsKey("key") ? c["key"] : "").Trim().ToLowerInvariant();
                        string name = Convert.ToString(c.ContainsKey("name") ? c["name"] : key).Trim();
                        string voice = Convert.ToString(c.ContainsKey("voice") ? c["voice"] : "").Trim();
                        string instr = Convert.ToString(c.ContainsKey("instruction") ? c["instruction"] : "").Trim();
                        string role = Convert.ToString(c.ContainsKey("role") ? c["role"] : "").Trim();
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
                                Lines = lines,
                                Role = role
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
