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
        private static readonly object _sapiGate = new object();

        static TypoZen_TTS()
        {
            _winrtSynth = new Windows.Media.SpeechSynthesis.SpeechSynthesizer();
            _sapiSynth = new System.Speech.Synthesis.SpeechSynthesizer();
            _player = new System.Windows.Media.MediaPlayer();
            _player.MediaOpened += (s, e) => Note("opened, " + DurationText() + ", playing");
            _player.MediaEnded += (s, e) => { Note("ended"); Finish(); };
            _player.MediaFailed += (s, e) =>
            {
                Note("player failed: " + (e.ErrorException != null ? e.ErrorException.Message : "unknown"));
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
                .Select(v => new VoiceInfo { Id = "winrt:" + v.Id, Name = v.DisplayName, IsSapi = false }));
                
            // 2. SAPI5 (Desktop / IVONA / 3rd Party) Voices
            try 
            {
                voices.AddRange(_sapiSynth.GetInstalledVoices()
                    .Where(v => v.Enabled)
                    .Select(v => new VoiceInfo { Id = "sapi:" + v.VoiceInfo.Name, Name = v.VoiceInfo.Name, IsSapi = true }));
            } catch {}

            return voices;
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

                    // One SAPI synthesizer, so one play at a time on it: two quick presses
                    // used to configure and speak on it from two threads at once.
                    await Task.Run(() => {
                        lock (_sapiGate)
                        {
                            if (gen != _generation) return;           // already replaced
                            _sapiSynth.SelectVoice(realName);
                            _sapiSynth.Rate = rate;
                            _sapiSynth.SetOutputToWaveFile(wav);
                            try { _sapiSynth.Speak(text); }
                            finally { _sapiSynth.SetOutputToNull(); } // release the file
                        }
                    });
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
            _player.Pause();
        }

        public static void Resume()
        {
            _player.Play();
        }

        public static void Stop()
        {
            // Also retires a play still synthesising, so it cannot start after Stop.
            _generation++;
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
