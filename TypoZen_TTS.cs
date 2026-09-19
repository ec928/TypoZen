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
        private static string _tempWavPath;
        public static Action OnPlaybackFinished;

        static TypoZen_TTS()
        {
            _winrtSynth = new Windows.Media.SpeechSynthesis.SpeechSynthesizer();
            _sapiSynth = new System.Speech.Synthesis.SpeechSynthesizer();
            _player = new System.Windows.Media.MediaPlayer();
            _player.MediaEnded += (s, e) => { OnPlaybackFinished?.Invoke(); };
            _tempWavPath = Path.Combine(Path.GetTempPath(), "typozen_tts_temp.wav");
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

            try
            {
                if (voiceId != null && voiceId.StartsWith("sapi:"))
                {
                    string realName = voiceId.Substring("sapi:".Length);
                    _sapiSynth.SelectVoice(realName);
                    // Speed in SAPI5 is -10 to 10. Default is 0. 
                    // Map 0.5x -> -5, 1.0x -> 0, 2.0x -> 10. (Approximation)
                    int rate = (int)((speed - 1.0) * 10.0);
                    if (rate < -10) rate = -10;
                    if (rate > 10) rate = 10;
                    _sapiSynth.Rate = rate;

                    await Task.Run(() => {
                        _sapiSynth.SetOutputToWaveFile(_tempWavPath);
                        _sapiSynth.Speak(text);
                        _sapiSynth.SetOutputToNull(); // release file lock
                    });
                    
                    _player.Open(new Uri(_tempWavPath));
                    _player.Play(); 
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
                    
                    System.IO.File.WriteAllBytes(_tempWavPath, buffer);
                    
                    _player.Open(new Uri(_tempWavPath));
                    _player.Play(); 
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("TTS Play Error: " + ex.Message);
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
