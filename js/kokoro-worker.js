// A simple polyfill for window if the library expects it
self.window = self;

let _kokoroEngine = null;

self.onmessage = async function(e) {
    const data = e.data;
    
    if (data.type === 'init') {
        try {
            const ext = data.ext;
            
            // Import the engine module
            const module = await import(ext.base + 'engine.js');
            const KokoroTTS = module.KokoroTTS || module.default?.KokoroTTS || self.KokoroTTS;
            
            // Set ONNX WASM path
            if (module.env) {
                try { module.env.wasmPaths = ext.base; } catch (err) {}
            }
            
            _kokoroEngine = await KokoroTTS.from_pretrained(ext.model, {
                dtype: ext.dtype,
                device: "webgpu"
            });
            
            self.postMessage({ type: 'init_done' });
        } catch (err) {
            self.postMessage({ type: 'init_error', error: err.message || err.toString() });
        }
    } else if (data.type === 'generate') {
        if (!_kokoroEngine) {
            self.postMessage({ type: 'generate_error', id: data.id, error: "Kokoro engine not initialized in worker." });
            return;
        }
        
        try {
            const audio = await _kokoroEngine.generate(data.text, { voice: data.voice, speed: data.speed });
            if (audio && audio.audio) {
                // Transfer the Float32Array buffer back to the main thread for performance
                self.postMessage({ 
                    type: 'generate_done', 
                    id: data.id, 
                    audio: audio.audio, 
                    sampling_rate: audio.sampling_rate 
                }, [audio.audio.buffer]);
            } else {
                throw new Error("Invalid audio response from engine.");
            }
        } catch (err) {
            self.postMessage({ type: 'generate_error', id: data.id, error: err.message || err.toString() });
        }
    }
};
