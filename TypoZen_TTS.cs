using System;
using System.IO;
using System.Linq;
using System.Media;
using System.Threading.Tasks;
using System.Collections.Generic;
using Windows.Media.SpeechSynthesis;

namespace TypoZen
{
    public class VoiceInfo
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public bool IsSapi { get; set; }

        /// <summary>
        /// What kind of engine speaks it: "local" for a neural voice running on this
        /// computer, "cloud" for one that sends the text to a web service, "" for the
        /// classic voices Windows has always had and for third-party ones.
        ///
        /// Read from the voice's own NaturalVoiceType attribute rather than from its
        /// name: an adapter that registers Narrator's natural voices reports
        /// "Narrator;Local", and the online ones "Edge;Cloud". Names vary per machine,
        /// this does not.
        /// </summary>
        public string Kind { get; set; }
    }

    public static class TypoZen_TTS
    {
        private static Windows.Media.SpeechSynthesis.SpeechSynthesizer _winrtSynth;
        private static System.Speech.Synthesis.SpeechSynthesizer _sapiSynth;
        private static System.Windows.Media.MediaPlayer _player;
        public static Action OnPlaybackFinished;
        /// <summary>One line per step, for debug.log. Never passed the text being read.</summary>
        public static Action<string> Log;

        // Every play used to share one typozen_tts_temp.wav, rewritten while the player
        // might still hold the previous one; and any failure -- synthesis, a file the
        // player could not open -- was swallowed without OnPlaybackFinished, so the page
        // sat on "Stop" for ever with nothing playing. Now each play has its own file,
        // every failure ends the play, and a newer play retires an older one.
        private static int _generation;
        private static string _currentWav;

        // SAPI voices speak straight to the audio device, from the first audio they have.
        // They used to be synthesised whole into a wav and only then played: fine for IVONA
        // (866 chars in 982 ms), but the natural voices through NaturalVoiceSAPIAdapter took
        // 17,421 ms for the same 866 chars (debug.log, 2026-09-19) -- 17 s of nothing.
        private static System.Speech.Synthesis.Prompt _sapiPrompt;   // the one speaking now
        private static System.Diagnostics.Stopwatch _sapiClock;
        private static int _sapiGen;
        private static bool _sapiHeard;

        // HDMI (and some USB / Bluetooth) outputs sleep after a few seconds of silence and
        // drop the first second or so of the next sound while they re-lock. Measured on
        // 2026-09-19: plays 32 s apart were silent though TypoZen played every sample
        // (debug.log: opened, 716 ms of audio, ended). So a play starts with a second of
        // silence for the output to wake up in.
        //
        // Every play, not only after a quiet spell. An 8 s threshold was tried first: a
        // dictionary pronunciation 3.9 s after the last sound was not padded and not heard,
        // while a 4 s gap earlier had been -- the output's sleep time varies, and a second
        // of delay is the cheaper mistake.
        private const int WakeSilenceMs = 1000;
        private static readonly TimeSpan QuietAfter = TimeSpan.FromMilliseconds(500);
        private static DateTime _lastSound = DateTime.MinValue;
        private static bool _sounding;

        private static void SoundStopped()
        {
            if (_sounding) _lastSound = DateTime.UtcNow;
            _sounding = false;
        }

        /// <summary>
        /// Put `ms` of silence in front of a PCM wav, in place. False (file untouched) for
        /// anything that is not plain PCM -- silence there is not a run of zero bytes.
        /// </summary>
        private static bool PadLeadingSilence(string path, int ms)
        {
            byte[] b = File.ReadAllBytes(path);
            if (b.Length < 44 || b[0] != 'R' || b[1] != 'I' || b[2] != 'F' || b[3] != 'F') return false;
            int pos = 12, fmtAt = -1, dataAt = -1;
            while (pos + 8 <= b.Length)
            {
                string id = System.Text.Encoding.ASCII.GetString(b, pos, 4);
                int size = BitConverter.ToInt32(b, pos + 4);
                if (id == "fmt ") fmtAt = pos + 8;
                if (id == "data") { dataAt = pos; break; }
                pos += 8 + size + (size & 1);
            }
            if (fmtAt < 0 || dataAt < 0) return false;
            short format = BitConverter.ToInt16(b, fmtAt);
            int rate = BitConverter.ToInt32(b, fmtAt + 4);
            short align = BitConverter.ToInt16(b, fmtAt + 12);
            short bits = BitConverter.ToInt16(b, fmtAt + 14);
            if (format != 1 || rate <= 0 || align <= 0) return false;
            int pad = (int)((long)rate * ms / 1000) * align;
            byte fill = bits == 8 ? (byte)0x80 : (byte)0;   // 8-bit PCM is unsigned
            int payload = dataAt + 8;
            var outBytes = new byte[b.Length + pad];
            Buffer.BlockCopy(b, 0, outBytes, 0, payload);
            for (int i = 0; i < pad; i++) outBytes[payload + i] = fill;
            Buffer.BlockCopy(b, payload, outBytes, payload + pad, b.Length - payload);
            BitConverter.GetBytes(BitConverter.ToInt32(b, dataAt + 4) + pad).CopyTo(outBytes, dataAt + 4);
            BitConverter.GetBytes(outBytes.Length - 8).CopyTo(outBytes, 4);
            File.WriteAllBytes(path, outBytes);
            return true;
        }

        static TypoZen_TTS()
        {
            _winrtSynth = new Windows.Media.SpeechSynthesis.SpeechSynthesizer();
            _sapiSynth = new System.Speech.Synthesis.SpeechSynthesizer();
            _player = new System.Windows.Media.MediaPlayer();
            _player.MediaOpened += (s, e) => { _sounding = true; Note("opened, " + DurationText() + ", playing"); };
            _player.MediaEnded += (s, e) => { SoundStopped(); Note("ended"); Finish(); };
            _player.MediaFailed += (s, e) =>
            {
                SoundStopped();
                Note("player failed: " + (e.ErrorException != null ? e.ErrorException.Message : "unknown"));
                Finish();
            };

            _sapiSynth.SetOutputToDefaultAudioDevice();
            // Not SpeakProgress: System.Speech throws inside its own dispatch of that event
            // ("Length cannot be less than zero") for a prompt that opens with a break, and
            // the exception took the whole app down. SpeakStarted is when audio begins.
            _sapiSynth.SpeakStarted += (s, e) =>
            {
                if (e.Prompt != _sapiPrompt || _sapiHeard) return;
                _sapiHeard = true;
                Note("play #" + _sapiGen + " audio started after " + _sapiClock.ElapsedMilliseconds
                    + " ms, then " + WakeSilenceMs + " ms of wake-up silence before the first word");
            };
            _sapiSynth.SpeakCompleted += (s, e) =>
            {
                // Completions of prompts already replaced or stopped are not this play's end.
                if (e.Prompt != _sapiPrompt) return;
                _sapiPrompt = null;
                SoundStopped();
                if (e.Cancelled) { Note("play #" + _sapiGen + " cancelled"); return; }
                Note("play #" + _sapiGen + (e.Error != null ? " failed: " + e.Error.Message : " ended")
                    + " after " + _sapiClock.ElapsedMilliseconds + " ms");
                Finish();
            };
        }

        private static void Note(string what)
        {
            try { var l = Log; if (l != null) l("tts " + what); } catch { }
        }

        private static string DurationText()
        {
            try
            {
                return _player.NaturalDuration.HasTimeSpan
                    ? _player.NaturalDuration.TimeSpan.TotalMilliseconds.ToString("0") + " ms of audio"
                    : "length unknown";
            }
            catch { return "length unknown"; }
        }

        private static void Finish()
        {
            try { OnPlaybackFinished?.Invoke(); } catch { }
        }

        /// <summary>This play's own wav; earlier ones are deleted once nothing holds them.</summary>
        private static string NewWavPath(int gen)
        {
            string dir = Path.GetTempPath();
            try
            {
                foreach (string old in Directory.GetFiles(dir, "typozen_tts_*.wav"))
                {
                    if (string.Equals(old, _currentWav, StringComparison.OrdinalIgnoreCase)) continue;
                    try { File.Delete(old); } catch { }
                }
            }
            catch { }
            return Path.Combine(dir, "typozen_tts_" + System.Diagnostics.Process.GetCurrentProcess().Id + "_" + gen + ".wav");
        }

        public static List<VoiceInfo> GetVoices()
        {
            var voices = new List<VoiceInfo>();
            
            // 1. WinRT (OneCore) Voices
            voices.AddRange(Windows.Media.SpeechSynthesis.SpeechSynthesizer.AllVoices
                .Select(v => new VoiceInfo { Id = "winrt:" + v.Id, Name = v.DisplayName, IsSapi = false, Kind = "" }));
                
            // 2. SAPI5 (Desktop / IVONA / 3rd Party) Voices
            try 
            {
                voices.AddRange(_sapiSynth.GetInstalledVoices()
                    .Where(v => v.Enabled)
                    .Select(v => new VoiceInfo
                    {
                        Id = "sapi:" + v.VoiceInfo.Name,
                        Name = v.VoiceInfo.Name,
                        IsSapi = true,
                        Kind = KindOf(v.VoiceInfo)
                    }));
            } catch {}

            // 3. Remove redundant online voices if a local version exists
            var localNames = voices.Where(v => v.Kind == "local").Select(v => v.Name).ToList();
            voices.RemoveAll(v => v.Kind == "cloud" && localNames.Contains(v.Name.Replace("Online ", "")));

            return voices;
        }

        /// <summary>
        /// "local", "cloud" or "" -- see VoiceInfo.Kind. A voice that says nothing about
        /// itself is classic, which is the safe reading: it claims neither to be neural
        /// nor to need the network.
        /// </summary>
        private static string KindOf(System.Speech.Synthesis.VoiceInfo info)
        {
            try
            {
                string type;
                if (!info.AdditionalInfo.TryGetValue("NaturalVoiceType", out type) || type == null) return "";
                if (type.IndexOf("Cloud", StringComparison.OrdinalIgnoreCase) >= 0) return "cloud";
                if (type.IndexOf("Local", StringComparison.OrdinalIgnoreCase) >= 0) return "local";
            }
            catch { }
            return "";
        }

        public static async Task PlayAsync(string text, string voiceId, double speed)
        {
            Stop();
            int gen = ++_generation;
            string wav = NewWavPath(gen);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            Note("play #" + gen + ": " + (text ?? "").Length + " chars, voice " + (voiceId ?? "(default)"));

            try
            {
                if (voiceId != null && voiceId.StartsWith("sapi:"))
                {
                    string realName = voiceId.Substring("sapi:".Length);
                    // Speed in SAPI5 is -10 to 10. Default is 0.
                    // Map 0.5x -> -5, 1.0x -> 0, 2.0x -> 10. (Approximation)
                    int rate = (int)((speed - 1.0) * 10.0);
                    if (rate < -10) rate = -10;
                    if (rate > 10) rate = 10;

                    // Straight to the audio device, on this (UI) thread's synthesizer:
                    // SpeakAsync returns at once and sound starts with the first audio the
                    // voice produces. Stop() has already cancelled whatever was speaking.
                    _sapiSynth.SelectVoice(realName);
                    _sapiSynth.Rate = rate;
                    // The prompt's culture is the voice's own: a prompt in another culture
                    // lets SAPI switch to a voice that matches it instead.
                    var pb = new System.Speech.Synthesis.PromptBuilder(_sapiSynth.Voice.Culture);
                    pb.AppendBreak(TimeSpan.FromMilliseconds(WakeSilenceMs));   // HDMI wake-up
                    pb.AppendText(text ?? "");
                    _sapiGen = gen;
                    _sapiHeard = false;
                    _sapiClock = System.Diagnostics.Stopwatch.StartNew();
                    _sounding = true;
                    _sapiPrompt = _sapiSynth.SpeakAsync(pb);
                    Note("play #" + gen + " speaking directly, voice ready after " + sw.ElapsedMilliseconds + " ms");
                    return;
                }
                else
                {
                    string realId = voiceId?.StartsWith("winrt:") == true ? voiceId.Substring("winrt:".Length) : voiceId;
                    if (!string.IsNullOrEmpty(realId))
                    {
                        var voice = Windows.Media.SpeechSynthesis.SpeechSynthesizer.AllVoices.FirstOrDefault(v => v.Id == realId);
                        if (voice != null) _winrtSynth.Voice = voice;
                    }

                    _winrtSynth.Options.SpeakingRate = speed;

                    var stream = await _winrtSynth.SynthesizeTextToStreamAsync(text);

                    var reader = new Windows.Storage.Streams.DataReader(stream.GetInputStreamAt(0));
                    await reader.LoadAsync((uint)stream.Size);
                    byte[] buffer = new byte[(uint)stream.Size];
                    reader.ReadBytes(buffer);

                    if (gen == _generation) System.IO.File.WriteAllBytes(wav, buffer);
                }

                if (gen != _generation)
                {
                    // A newer play (or Stop) took over while this one was synthesising.
                    Note("play #" + gen + " superseded");
                    return;
                }
                long bytes = File.Exists(wav) ? new FileInfo(wav).Length : 0;
                Note("play #" + gen + " synthesised in " + sw.ElapsedMilliseconds + " ms, " + bytes + " bytes");
                if (bytes <= 44)
                {
                    // A wav header and no sound: nothing to play, so say so and end.
                    Note("play #" + gen + " produced no audio");
                    Finish();
                    return;
                }
                if (DateTime.UtcNow - _lastSound >= QuietAfter)
                {
                    bool padded = false;
                    try { padded = PadLeadingSilence(wav, WakeSilenceMs); } catch { }
                    Note("play #" + gen + (padded
                        ? ": " + WakeSilenceMs + " ms of silence first, for the output to wake"
                        : ": not plain PCM, played without the wake-up silence"));
                }
                _currentWav = wav;
                _player.Open(new Uri(wav));
                _player.Play();
            }
            catch (Exception ex)
            {
                Note("play #" + gen + " failed: " + ex.GetType().Name + ": " + ex.Message);
                if (gen == _generation) Finish();
            }
        }

        public static void Pause()
        {
            if (_sapiPrompt != null) { try { _sapiSynth.Pause(); } catch { } return; }
            _player.Pause();
        }

        public static void Resume()
        {
            if (_sapiPrompt != null) { try { _sapiSynth.Resume(); } catch { } return; }
            _player.Play();
        }

        public static void Stop()
        {
            // Also retires a play still synthesising, so it cannot start after Stop.
            _generation++;
            SoundStopped();
            if (_sapiPrompt != null)
            {
                // Its SpeakCompleted arrives later as cancelled, and is not reported as an end.
                _sapiPrompt = null;
                try { _sapiSynth.Resume(); } catch { }   // a paused synthesizer will not cancel
                try { _sapiSynth.SpeakAsyncCancelAll(); } catch { }
            }
            _player.Stop();
            _player.Close();
        }
    }

    public static class AsyncExtensions
    {
        public static System.Runtime.CompilerServices.TaskAwaiter<T> GetAwaiter<T>(this Windows.Foundation.IAsyncOperation<T> operation)
        {
            var tcs = new TaskCompletionSource<T>();
            operation.Completed = (info, status) => {
                if (status == Windows.Foundation.AsyncStatus.Completed) tcs.SetResult(info.GetResults());
                else if (status == Windows.Foundation.AsyncStatus.Error) tcs.SetException(info.ErrorCode);
                else if (status == Windows.Foundation.AsyncStatus.Canceled) tcs.SetCanceled();
            };
            return tcs.Task.GetAwaiter();
        }
    }
}
