# Kokoro-TTS (Route A: Zero-Install JS) Implementation Plan

This plan outlines the integration of **Kokoro-TTS** entirely inside TypoZen's frontend using the `kokoro-js` WebGPU/WASM engine.

## 1. Safety & Prototyping
- We are currently on the `kokoro-prototype` git branch. 
- All changes are completely isolated from your master branch.

## 2. The File Menu & Setup
Rather than downloading the model automatically, we have added a dedicated menu in TypoZen:
`File` > `Read Aloud` > `Download and use Kokoro TTS (HD Voices)`
(Note: `Configure Voice...` has also been moved into this submenu).

When you click the `Download and use Kokoro TTS` menu option, the JS engine will:
- Download the ONNX model (`onnx-community/Kokoro-82M-v1.0-ONNX`) in a highly compressed `q8` format (approx 80MB).
- Cache the model in your local WebView2 browser storage so it never has to download again.
- Auto-detect your hardware and use `webgpu` for acceleration (falling back to `wasm` if necessary).

## 3. UI Modifications (`09-speech.js`)
We need a way to select the Kokoro voices. Since we have a dedicated `File` > `Read Aloud` submenu now, we can dynamically add the Kokoro voices to this menu, or show a small inline selector in the popover.

## 4. The Audio Pipeline 
Right now, `09-speech.js` calls `sendTTSPlay(chunk.text)`, which routes to C#.
We will intercept this:
- If a Kokoro voice is selected, JS calls `await tts.generate(chunk.text, { voice: selectedVoice })`.
- We will convert the returned audio object into a Blob and play it using `new Audio(url)`.
- We will listen to the `<audio>.onended` event to instantly call `playNextChunk()`, triggering your `goToPageHoldingBlock()` pagination seamlessly.

## 5. Graceful Fallback
If for any reason Kokoro fails to load (e.g., no internet on first launch), or if you select "System Default" from the voice dropdown, it will instantly route back to your C# `TypoZen_TTS.cs` bridge so you never lose functionality.
