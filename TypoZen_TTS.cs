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

        // HDMI (and some USB / Bluetooth) outputs sleep after a few seconds of silence and
        // drop the first second or so of the next sound while they re-lock. Measured on
        // 2026-09-19: plays 32 s apart were silent though TypoZen played every sample
        // (debug.log: opened, 716 ms of audio, ended), plays 3-5 s apart were heard. So a
        // play that follows a quiet spell starts with a second of silence for the output to
        // wake up in; plays close together get none and start at once.
        private const int WakeSilenceMs = 1000;
        private static readonly TimeSpan QuietAfter = TimeSpan.FromSeconds(8);
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
                if (DateTime.UtcNow - _lastSound > QuietAfter)
                {
                    bool padded = false;
                    try { padded = PadLeadingSilence(wav, WakeSilenceMs); } catch { }
                    Note("play #" + gen + (padded
                        ? " after a quiet spell: " + WakeSilenceMs + " ms of silence first, for the output to wake"
                        : " after a quiet spell, but not plain PCM: played as is"));
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
            SoundStopped();
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
