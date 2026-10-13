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
        public const string DefaultModel = "gemini-3.5-flash";
        public const string FallbackModel = "gemini-flash-lite-latest";

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
            public int BookLines { get; set; }
            public List<string> Aliases { get; set; }

            public CharacterCast()
            {
                Aliases = new List<string>();
                Strength = 4.0;
            }
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
            /// <summary>Attribution requests finished, and how many there were to do.</summary>
            public int BatchesDone { get; set; }
            public int BatchesTotal { get; set; }
            /// <summary>Why attribution stopped early ("cancelled", or the error); null when it finished.</summary>
            public string Stopped { get; set; }
        }

        #region API Key Storage (DPAPI)

        /// <summary>
        /// The key and gemini.json live in the install's own profile folder
        /// (TypoZen_Cache&lt;discriminator&gt;\gemini), like the rest of TypoZen's state.
        /// Up to 0.16.25 they were in %LocalAppData%\TypoZen\; the first use moves them.
        /// </summary>
        private static string GeminiDir()
        {
            string profile = Program.ProfileDirOverride() ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Program.CacheFolderName);
            string dir = Path.Combine(profile, "gemini");
            MigrateFromOldFolder(dir);
            return dir;
        }

        private static bool _migrated;

        private static void MigrateFromOldFolder(string dir)
        {
            if (_migrated) return;
            _migrated = true;
            if (Program.ProfileDirOverride() != null) return;   // test harness owns its dir
            try
            {
                string old = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TypoZen");
                foreach (string name in new[] { "gemini.key", "gemini.json" })
                {
                    string src = Path.Combine(old, name);
                    string dst = Path.Combine(dir, name);
                    if (!File.Exists(src)) continue;
                    Directory.CreateDirectory(dir);
                    if (!File.Exists(dst)) File.Move(src, dst);
                }
                if (Directory.Exists(old) && Directory.GetFileSystemEntries(old).Length == 0)
                    Directory.Delete(old);
            }
            catch { }
        }

        private static string KeyFilePath()
        {
            return Path.Combine(GeminiDir(), "gemini.key");
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

        #region Model Configuration (gemini.json)

        public sealed class GeminiConfig
        {
            public string model { get; set; }
            public List<string> fallbackModels { get; set; }
            public string endpoint { get; set; }

            public GeminiConfig()
            {
                model = DefaultModel;
                fallbackModels = new List<string>
                {
                    "gemini-flash-lite-latest",
                    "gemini-3.5-flash-lite",
                    "gemini-3.6-flash",
                    "gemini-3.1-flash-lite",
                    "gemini-3.8-flash"
                };
                endpoint = "https://generativelanguage.googleapis.com/v1beta/models/{0}:generateContent";
            }
        }

        public static string ConfigFilePath()
        {
            return Path.Combine(GeminiDir(), "gemini.json");
        }

        public static string EnsureConfigFileExists()
        {
            string path = ConfigFilePath();
            try
            {
                if (!File.Exists(path))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    string defaultJson =
@"{
  ""model"": ""gemini-3.5-flash"",
  ""fallbackModels"": [
    ""gemini-flash-lite-latest"",
    ""gemini-3.5-flash-lite"",
    ""gemini-3.6-flash"",
    ""gemini-3.1-flash-lite"",
    ""gemini-3.8-flash""
  ],
  ""endpoint"": ""https://generativelanguage.googleapis.com/v1beta/models/{0}:generateContent""
}
";
                    File.WriteAllText(path, defaultJson, Encoding.UTF8);
                }
            }
            catch { }
            return path;
        }

        public static GeminiConfig LoadConfig()
        {
            var cfg = new GeminiConfig();
            try
            {
                string path = ConfigFilePath();
                if (File.Exists(path))
                {
                    string json = File.ReadAllText(path, Encoding.UTF8);
                    var ser = new JavaScriptSerializer();
                    var dict = ser.Deserialize<Dictionary<string, object>>(json);
                    if (dict != null)
                    {
                        foreach (var k in new[] { "model", "Model", "preferredModel", "PreferredModel", "primaryModel" })
                        {
                            object val;
                            if (dict.TryGetValue(k, out val) && val is string s && !string.IsNullOrWhiteSpace(s))
                            {
                                cfg.model = s.Trim();
                                break;
                            }
                        }

                        foreach (var k in new[] { "fallbackModels", "FallbackModels", "fallback_models", "fallbacks", "models" })
                        {
                            object val;
                            if (dict.TryGetValue(k, out val) && val is System.Collections.IList list)
                            {
                                var fbList = new List<string>();
                                foreach (var item in list)
                                {
                                    if (item != null)
                                    {
                                        string mName = item.ToString().Trim();
                                        if (!string.IsNullOrEmpty(mName) && !fbList.Contains(mName))
                                        {
                                            fbList.Add(mName);
                                        }
                                    }
                                }
                                if (fbList.Count > 0)
                                {
                                    cfg.fallbackModels = fbList;
                                }
                                break;
                            }
                        }

                        foreach (var k in new[] { "endpoint", "Endpoint", "apiEndpoint", "url" })
                        {
                            object val;
                            if (dict.TryGetValue(k, out val) && val is string s && !string.IsNullOrWhiteSpace(s))
                            {
                                cfg.endpoint = s.Trim();
                                break;
                            }
                        }
                    }
                }
                else
                {
                    EnsureConfigFileExists();
                }
            }
            catch
            {
                // Fall back safely to default config if parse fails
            }

            // Environment overrides
            string envModel = Environment.GetEnvironmentVariable("GEMINI_MODEL");
            if (!string.IsNullOrWhiteSpace(envModel)) cfg.model = envModel.Trim();

            string envEndpoint = Environment.GetEnvironmentVariable("GEMINI_API_ENDPOINT");
            if (!string.IsNullOrWhiteSpace(envEndpoint)) cfg.endpoint = envEndpoint.Trim();

            return cfg;
        }

        public static void SaveConfig(GeminiConfig config)
        {
            if (config == null) return;
            try
            {
                string path = ConfigFilePath();
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var sb = new StringBuilder();
                sb.AppendLine("{");
                sb.AppendLine(string.Format("  \"model\": \"{0}\",", EscapeJsonString(config.model ?? DefaultModel)));
                sb.AppendLine("  \"fallbackModels\": [");
                var list = config.fallbackModels ?? new List<string>();
                for (int i = 0; i < list.Count; i++)
                {
                    string comma = (i < list.Count - 1) ? "," : "";
                    sb.AppendLine(string.Format("    \"{0}\"{1}", EscapeJsonString(list[i]), comma));
                }
                sb.AppendLine("  ],");
                sb.AppendLine(string.Format("  \"endpoint\": \"{0}\"", EscapeJsonString(string.IsNullOrWhiteSpace(config.endpoint) ? "https://generativelanguage.googleapis.com/v1beta/models/{0}:generateContent" : config.endpoint)));
                sb.AppendLine("}");
                File.WriteAllText(path, sb.ToString(), Encoding.UTF8);
            }
            catch { }
        }

        private static string EscapeJsonString(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
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
            List<string> localSpeakers,
            List<VoiceOption> voiceCatalog,
            ref string modelUsed,
            string preferredModel = DefaultModel)
        {
            var catalogText = FormatVoiceCatalogForPrompt(voiceCatalog);
            var excerptsSb = new StringBuilder();
            if (sampleExcerpts != null)
            {
                int count = Math.Min(sampleExcerpts.Count, 24);
                for (int i = 0; i < count; i++)
                {
                    excerptsSb.AppendLine(string.Format("[Excerpt {0}]: {1}", i + 1, sampleExcerpts[i]));
                }
            }
            var speakersSb = new StringBuilder();
            if (localSpeakers != null)
                foreach (var s in localSpeakers) if (!string.IsNullOrWhiteSpace(s)) speakersSb.AppendLine("- " + s.Trim());
            if (speakersSb.Length == 0) speakersSb.AppendLine("(none found)");

            // No book is named in these prompts: examples from one novel made the model cast
            // that novel's people into others, and "you MUST cast 15-25" made it invent them.
            string systemPrompt =
@"You are an expert Audio Drama Casting Director.
Given a book's title, a list of speakers found in its text by a simple scan, and excerpts spread across its dialogue, cast the characters who speak, mapping each to the most fitting voice from the provided catalog.

RULES:
1. Evidence: Cast a character only if they appear in the speaker list or the excerpts, or if you are certain they are a speaking character of this exact published work. Never invent characters. A short or unfamiliar text may have only a few characters; that is fine. The speaker list comes from a simple scan and can contain non-names (a place, a word that starts a sentence): leave those out.
2. Canonical Keys: Use a clean, lowercase key for each character, normally the name the text uses most (e.g. 'anna', 'tom', 'mrs bennet'). Two characters who share a surname (Mr and Mrs Bennet) are two characters with two keys.
3. Estimated Lines ('bookLines'): Estimate the number of spoken lines this character has in the whole book. Use the speaker list's counts as a guide.
4. Aliases ('aliases'): List the other names, titles, honorifics, nicknames and epithets the text uses for this character (e.g. for a character called Anna Price: ""anna"", ""miss price"", ""the governess""). Do not give one alias to two characters.
5. Voice Archetype: Choose the best-fitting Voice ID from the catalog based on gender, vocal register, acoustic traits, and character personality.
6. Acting Instruction: Provide vivid acting delivery instructions (under 60 chars) suitable for TTS emotion prompting.
7. Emotion Strength: Assign a recommended Breeze emotion strength between 1.0 and 10.0 (default 4.0).
8. Dramatic Role: Briefly describe their dramatic function or archetype.

Return ONLY a valid JSON object adhering strictly to this JSON schema:
{
  ""characters"": [
    {
      ""key"": ""canonical_id"",
      ""name"": ""Full Display Name"",
      ""voice"": ""voice-id-from-catalog"",
      ""instruction"": ""acting delivery instruction"",
      ""strength"": 4.0,
      ""role"": ""Dramatic role"",
      ""bookLines"": 130,
      ""aliases"": [""alias1"", ""alias2""]
    }
  ]
}";

            string userPrompt = string.Format(
@"BOOK TITLE: {0}

SPEAKERS FOUND IN THE TEXT (name, lines):
{1}

SAMPLE EXCERPTS:
{2}

AVAILABLE VOICE CATALOG:
{3}

Remember to return ONLY the JSON object.",
                bookTitle, speakersSb.ToString(), excerptsSb.ToString(), catalogText);

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
                if (kc.Aliases != null && kc.Aliases.Count > 0)
                {
                    knownSb.AppendLine(string.Format("- {0}: {1} (aliases: {2})", kc.Key, kc.Name, string.Join(", ", kc.Aliases)));
                }
                else
                {
                    knownSb.AppendLine(string.Format("- {0}: {1}", kc.Key, kc.Name));
                }
            }

            var catalogText = FormatVoiceCatalogForPrompt(voiceCatalog);

            string systemPrompt =
@"You are an expert Audio Drama Dialogue Attributor.
Attribute each spoken dialogue quotation in the provided paragraphs to the TRUE speaker using the provided canonical dramatis personae keys.

RULES:
1. Canonical Speaker Keys: Attribute each quote strictly to the provided character keys, using the aliases to resolve titles and epithets to the right key. Do NOT create a new key for a character who already has one under another name.
2. Attribution Logic: Resolve pronouns ('he said', 'she whispered'), relational epithets ('his mother', 'the captain'), and multi-turn banter without speech tags based on surrounding narrative context. If you cannot tell who speaks a quote, leave it out rather than guess.
3. Delivery Cues: Extract emotional cues or delivery direction indicated in the surrounding prose (e.g. 'whispering', 'coldly', 'gently', 'furious').
4. Minor / New Characters: Only if an unlisted new character speaks (e.g. an unlisted guard or servant), create a clean lowercase key and assign them a voice archetype in 'newCharacters'.

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

        #region Canonical Speaker Resolution

        private static string NormalizeToken(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return "";
            text = text.Trim().ToLowerInvariant();
            if (text.StartsWith("the ")) text = text.Substring(4).Trim();
            var sb = new StringBuilder();
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (char.IsLetterOrDigit(c) || char.IsWhiteSpace(c)) sb.Append(c);
            }
            return sb.ToString().Trim();
        }

        /// <summary>
        /// Every name a character answers to, matched whole -- never as part of another word.
        /// The rule is the local attribution's: when it is unclear who speaks, the narrator
        /// reads the line, never the wrong character. So a name two characters share (an alias
        /// given to both, "Atreides" in two full names) belongs to neither, and a part of a
        /// full name counts only when one character has it. The old resolver also matched any
        /// substring ("ed" took "fred"), and a shared name went to whoever was listed first.
        /// </summary>
        public sealed class AliasIndex
        {
            private readonly Dictionary<string, CharacterCast> _full = new Dictionary<string, CharacterCast>(StringComparer.OrdinalIgnoreCase);
            private readonly HashSet<string> _fullShared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            private readonly Dictionary<string, CharacterCast> _part = new Dictionary<string, CharacterCast>(StringComparer.OrdinalIgnoreCase);
            private readonly HashSet<string> _partShared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            private static void Put(Dictionary<string, CharacterCast> map, HashSet<string> shared, string name, CharacterCast c)
            {
                foreach (string form in new[] { (name ?? "").Trim().ToLowerInvariant(), NormalizeToken(name) })
                {
                    if (string.IsNullOrEmpty(form) || shared.Contains(form)) continue;
                    CharacterCast had;
                    if (map.TryGetValue(form, out had))
                    {
                        if (had != c) { map.Remove(form); shared.Add(form); }
                    }
                    else map[form] = c;
                }
            }

            public void Add(CharacterCast c)
            {
                if (c == null) return;
                Put(_full, _fullShared, c.Key, c);
                Put(_full, _fullShared, c.Name, c);
                if (c.Aliases != null) foreach (var a in c.Aliases) Put(_full, _fullShared, a, c);
                if (!string.IsNullOrEmpty(c.Name))
                {
                    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var p in c.Name.Split(new[] { ' ', '-', '_' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        string low = p.Trim().ToLowerInvariant();
                        if (low.Length >= 3 && low != "the" && seen.Add(low)) Put(_part, _partShared, low, c);
                    }
                }
            }

            public CharacterCast Resolve(string raw)
            {
                if (string.IsNullOrWhiteSpace(raw)) return null;
                CharacterCast c;
                foreach (string form in new[] { raw.Trim().ToLowerInvariant(), NormalizeToken(raw) })
                {
                    if (string.IsNullOrEmpty(form)) continue;
                    if (_full.TryGetValue(form, out c)) return c;
                    if (_fullShared.Contains(form)) return null;      // two characters' name: neither
                }
                foreach (string form in new[] { raw.Trim().ToLowerInvariant(), NormalizeToken(raw) })
                {
                    if (string.IsNullOrEmpty(form)) continue;
                    if (_part.TryGetValue(form, out c)) return c;
                }
                return null;
            }
        }

        public static AliasIndex BuildAliasIndex(IEnumerable<CharacterCast> characters)
        {
            var index = new AliasIndex();
            foreach (var c in characters) index.Add(c);
            return index;
        }

        #endregion

        /// <param name="dialogueBlocks">Up to 500 dialogue paragraphs, attributed 25 to a request.</param>
        /// <param name="blockIndex">Each block's paragraph index in the page's texts; quotes are keyed by it.</param>
        /// <param name="samples">Excerpts spread across the text, for casting; null uses the first 8 blocks.</param>
        /// <param name="localSpeakers">Find characters' list ("Name (12 lines)"), for casting.</param>
        /// <param name="cancelled">Checked before each request; true stops and keeps what is done.</param>
        public static GeminiCastResult AnalyzeAndCast(
            string bookTitle,
            List<string> dialogueBlocks,
            List<int> blockIndex,
            List<string> samples,
            List<string> localSpeakers,
            List<VoiceOption> availableVoices,
            Action<int, int, string> onProgress = null,
            Func<bool> cancelled = null,
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

            var config = LoadConfig();
            if (string.IsNullOrEmpty(model) || model == DefaultModel)
            {
                model = !string.IsNullOrEmpty(config.model) ? config.model : DefaultModel;
            }

            const int chunkSize = 25;
            int totalToAnalyze = dialogueBlocks.Count;
            int totalQuoteBatches = (totalToAnalyze + chunkSize - 1) / chunkSize;
            int totalSteps = 1 + totalQuoteBatches;

            string modelUsed = model;
            var charsDict = new Dictionary<string, CharacterCast>(StringComparer.OrdinalIgnoreCase);

            // ================================================================
            // PHASE 1: Cast the characters, from the scan's speakers and spread excerpts
            // ================================================================
            if (onProgress != null)
                onProgress(1, totalSteps, string.Format("Casting characters for '{0}' (part 1 of {1})...", cleanTitle, totalSteps));

            var sampleExcerpts = samples != null && samples.Count > 0
                ? samples
                : dialogueBlocks.GetRange(0, Math.Min(dialogueBlocks.Count, 8));
            var fullBookCast = DiscoverBookDramatisPersonae(apiKey, cleanTitle, sampleExcerpts, localSpeakers, catalog, ref modelUsed, model);

            foreach (var fc in fullBookCast)
            {
                if (!string.IsNullOrEmpty(fc.Key) && !charsDict.ContainsKey(fc.Key))
                {
                    fc.Lines = 0; // counted from the attribution below
                    charsDict[fc.Key] = fc;
                }
            }

            var aliases = BuildAliasIndex(charsDict.Values);

            // ================================================================
            // PHASE 2: Attribute every dialogue block, 25 to a request
            // ================================================================
            var aggregatedResult = new GeminiCastResult { ModelUsed = modelUsed, BatchesTotal = totalQuoteBatches };

            for (int b = 0; b < totalQuoteBatches; b++)
            {
                if (cancelled != null && cancelled())
                {
                    aggregatedResult.Stopped = "cancelled";
                    break;
                }
                int startIdx = b * chunkSize;
                int count = Math.Min(chunkSize, totalToAnalyze - startIdx);
                var chunkBlocks = dialogueBlocks.GetRange(startIdx, count);

                int stepNumber = b + 2;
                if (onProgress != null)
                    onProgress(stepNumber, totalSteps, string.Format("Attributing dialogue (part {0} of {1})...", stepNumber, totalSteps));

                GeminiCastResult chunkResult;
                try
                {
                    var knownList = new List<CharacterCast>(charsDict.Values);
                    chunkResult = AttributeDialogueChunk(apiKey, chunkBlocks, 0, knownList, catalog, ref modelUsed, model);
                }
                catch (Exception ex)
                {
                    // A quota or network failure part way keeps the parts already done.
                    aggregatedResult.Stopped = ex.Message;
                    break;
                }

                // New minor characters first, so this request's quotes can name them; only when no existing one answers to their name
                foreach (var nc in chunkResult.Characters)
                {
                    if (string.IsNullOrEmpty(nc.Key)) continue;
                    var matched = aliases.Resolve(nc.Key) ?? aliases.Resolve(nc.Name);
                    if (matched == null && !charsDict.ContainsKey(nc.Key))
                    {
                        charsDict[nc.Key] = nc;
                        aliases.Add(nc);
                    }
                }
                foreach (var q in chunkResult.Quotes)
                {
                    // The model numbers paragraphs within its request; map to the page's index.
                    // A number outside the request cannot be placed, so the quote is keyed by its
                    // text alone (Para -1).
                    int local = q.Para;
                    int pos = startIdx + local;
                    q.Para = (local >= 0 && local < count)
                        ? (blockIndex != null && pos < blockIndex.Count ? blockIndex[pos] : pos)
                        : -1;

                    if (string.IsNullOrEmpty(q.Speaker)) continue;
                    var canonical = aliases.Resolve(q.Speaker);
                    if (canonical == null) continue;          // unknown or shared name: the narrator reads it
                    q.Speaker = canonical.Key;
                    canonical.Lines++;
                    aggregatedResult.Quotes.Add(q);
                }

                aggregatedResult.BatchesDone = b + 1;
            }

            var speakingInChapter = new List<CharacterCast>();
            var remainingBookCast = new List<CharacterCast>();

            foreach (var c in charsDict.Values)
            {
                if (c.Lines > 0) speakingInChapter.Add(c);
                else remainingBookCast.Add(c);
            }

            speakingInChapter.Sort((a, b) => b.Lines.CompareTo(a.Lines));
            remainingBookCast.Sort((a, b) => b.BookLines.CompareTo(a.BookLines));

            aggregatedResult.Characters.AddRange(speakingInChapter);
            aggregatedResult.Characters.AddRange(remainingBookCast);
            aggregatedResult.ModelUsed = modelUsed;

            return aggregatedResult;
        }

        private static GeminiCastResult ExecuteWithFallback(string apiKey, string preferredModel, string systemPrompt, string userPrompt)
        {
            var config = LoadConfig();
            var modelsToTry = new List<string>();
            if (!string.IsNullOrEmpty(preferredModel) && preferredModel != DefaultModel)
            {
                modelsToTry.Add(preferredModel);
            }
            if (!string.IsNullOrEmpty(config.model) && !modelsToTry.Contains(config.model))
            {
                modelsToTry.Add(config.model);
            }
            if (!string.IsNullOrEmpty(preferredModel) && !modelsToTry.Contains(preferredModel))
            {
                modelsToTry.Add(preferredModel);
            }
            if (config.fallbackModels != null)
            {
                foreach (var m in config.fallbackModels)
                {
                    if (!string.IsNullOrEmpty(m) && !modelsToTry.Contains(m)) modelsToTry.Add(m);
                }
            }
            foreach (var m in new[] { "gemini-3.5-flash", "gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.1-flash-lite", "gemini-3.8-flash" })
            {
                if (!modelsToTry.Contains(m)) modelsToTry.Add(m);
            }

            Exception lastEx = null;
            bool anyRateLimit = false;

            foreach (var m in modelsToTry)
            {
                try
                {
                    var res = ExecuteGeminiRequest(apiKey, m, systemPrompt, userPrompt, config.endpoint);
                    if (res != null) return res;
                }
                catch (WebException wex)
                {
                    lastEx = wex;
                    if (wex.Response is HttpWebResponse httpResp)
                    {
                        int status = (int)httpResp.StatusCode;
                        if (status == 429) anyRateLimit = true;
                        // A bad key is the same for every model: say so at once. Google answers
                        // one with 400 INVALID_ARGUMENT, reason API_KEY_INVALID (checked
                        // 2026-10-13); 401/403 is a key without access (or one Google disabled).
                        if (status == 400 || status == 401 || status == 403)
                        {
                            string body = ReadErrorResponse(wex);
                            if (status != 400 || body.IndexOf("API_KEY_INVALID", StringComparison.Ordinal) >= 0)
                                throw new InvalidOperationException(
                                    "Google rejected the Gemini API key (" + GoogleMessage(body, status) + "). Check it under API Key... in Narrator Manager.", wex);
                        }
                        // 404: model deprecated / not found
                        // 400: bad request / unsupported parameters
                        // 429: quota exhausted for this model on free tier - try next model!
                        // 503: server overloaded / unavailable - try next model!
                        if (status == 404 || status == 400 || status == 429 || status == 503)
                        {
                            continue;
                        }
                    }
                    string respBody = ReadErrorResponse(wex);
                    throw new InvalidOperationException("Gemini API error (" + wex.Message + "): " + respBody, wex);
                }
                catch (Exception ex)
                {
                    lastEx = ex;
                }
            }

            if (anyRateLimit)
            {
                throw new InvalidOperationException(
                    "Gemini API daily quota exceeded across all available models. Please retry in 24 hours, or enable Pay-As-You-Go billing in Google AI Studio (aistudio.google.com) to remove the free tier rate limits.");
            }

            throw new InvalidOperationException("Could not complete Gemini request: " + (lastEx != null ? lastEx.Message : "unknown error"), lastEx);
        }

        private static GeminiCastResult ExecuteGeminiRequest(string apiKey, string model, string systemPrompt, string userPrompt, string endpointTemplate = null)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            if (string.IsNullOrWhiteSpace(endpointTemplate))
            {
                endpointTemplate = "https://generativelanguage.googleapis.com/v1beta/models/{0}:generateContent";
            }

            string url;
            if (endpointTemplate.Contains("{1}"))
            {
                url = string.Format(endpointTemplate, model, apiKey);
            }
            else if (endpointTemplate.Contains("{0}"))
            {
                string formatted = string.Format(endpointTemplate, model);
                string sep = formatted.Contains("?") ? "&" : "?";
                url = formatted + sep + "key=" + Uri.EscapeDataString(apiKey);
            }
            else
            {
                string sep = endpointTemplate.Contains("?") ? "&" : "?";
                url = endpointTemplate.TrimEnd('/') + "/" + model + ":generateContent" + sep + "key=" + Uri.EscapeDataString(apiKey);
            }

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

        /// <summary>The "message" in Google's error JSON, or the HTTP status if there is none.</summary>
        private static string GoogleMessage(string body, int status)
        {
            try
            {
                var root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                object err, msg;
                if (root != null && root.TryGetValue("error", out err) && err is Dictionary<string, object> e
                    && e.TryGetValue("message", out msg) && msg is string s && s.Trim().Length > 0)
                    return s.Trim();
            }
            catch { }
            return "HTTP " + status;
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
                        int bookLines = 0;
                        if (c.ContainsKey("bookLines") && c["bookLines"] != null)
                        {
                            try { bookLines = Convert.ToInt32(c["bookLines"]); } catch { }
                        }
                        else if (c.ContainsKey("book_lines") && c["book_lines"] != null)
                        {
                            try { bookLines = Convert.ToInt32(c["book_lines"]); } catch { }
                        }
                        else if (c.ContainsKey("estimatedLines") && c["estimatedLines"] != null)
                        {
                            try { bookLines = Convert.ToInt32(c["estimatedLines"]); } catch { }
                        }

                        var aliases = new List<string>();
                        object aliasesObj = null;
                        if (c.ContainsKey("aliases")) aliasesObj = c["aliases"];
                        else if (c.ContainsKey("alias")) aliasesObj = c["alias"];

                        if (aliasesObj is System.Collections.IEnumerable aEnum)
                        {
                            foreach (var a in aEnum)
                            {
                                if (a == null) continue;
                                string astr = Convert.ToString(a).Trim();
                                if (!string.IsNullOrEmpty(astr) && !aliases.Contains(astr))
                                    aliases.Add(astr);
                            }
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
                                BookLines = bookLines,
                                Aliases = aliases,
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
