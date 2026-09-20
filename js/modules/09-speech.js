// Native C# WinRT TTS Bridge

let isPlaying = false;

// The popover's read-aloud control in its two states, drawn to match the toolbar button:
// an "A" with sound waves when idle (it was a media Play triangle), a stop square while
// reading. Inline SVG rather than an icon-font glyph, so it is the same on Windows 10,
// whose icon font has no A-with-waves.
const READ_ALOUD_HTML =
    '<svg class="tts-icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M1.5 13 5 3.5 8.5 13M2.8 9.6h4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M10.4 6.2a2.6 2.6 0 0 1 0 3.6M12.3 4.4a5.2 5.2 0 0 1 0 7.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</svg> Read selection';
const STOP_READING_HTML =
    '<svg class="tts-icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/>' +
    '</svg> Stop';

function showReadAloudState() {
    const b = document.getElementById('selPopRead');
    if (b) b.innerHTML = isPlaying ? STOP_READING_HTML : READ_ALOUD_HTML;
}

function initTTS() {
    const selPopReadBtn = document.getElementById('selPopRead');
    if (selPopReadBtn) {
        selPopReadBtn.addEventListener('click', function(e) {
            e.preventDefault();
            try { hideSelPop(); } catch (ex) {}
            if (isPlaying) {
                stopReading();
            } else {
                speakSelection();
            }
        });
    }

    const selPopReadFromHereBtn = document.getElementById('selPopReadFromHere');
    if (selPopReadFromHereBtn) {
        selPopReadFromHereBtn.addEventListener('click', function(e) {
            e.preventDefault();
            
            if (isPlaying) stopReading();
            
            if (typeof state !== 'undefined' && state.mode === 'source' && typeof sourceEditor !== 'undefined' && sourceEditor) {
                const at = sourceEditor.selectionStart || 0;
                sourceEditor.setSelectionRange(at, at);
            } else {
                const sel = window.getSelection();
                if (sel && sel.rangeCount) {
                    const r = sel.getRangeAt(0);
                    r.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(r);
                }
            }
            
            try { hideSelPop(); } catch (ex) {}
            speakSelection();
        });
    }
}

// Ensure the button text matches state when the popup is shown
document.addEventListener('selectionchange', function() {
    showReadAloudState();
});

/**
 * Where the text cursor is, when nothing is selected: the block it sits in and the text of
 * that block from the start of the word it is in. Null when there is no cursor in the
 * document -- then reading starts where it always did.
 */
function readingCaret() {
    const editor = document.getElementById('editor');
    const sel = window.getSelection();
    if (!editor || !sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || !editor.contains(node)) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const block = el && el.closest ? el.closest('#editor .block') : null;
    if (!block) return null;
    // Only a cursor on the page being looked at. A book just opened, or a cursor left
    // behind on a page since turned or scrolled away from, means "from the top of what
    // is on screen", as before.
    // Inside the editor's box (the page, in Pages) and inside the window (in scroll, where
    // the editor is as tall as everything laid out).
    const host = editor.getBoundingClientRect();
    const rc = block.getBoundingClientRect();
    if (!(rc.right > host.left && rc.left < host.right && rc.bottom > host.top && rc.top < host.bottom)) return null;
    if (!(rc.bottom > 0 && rc.top < window.innerHeight && rc.right > 0 && rc.left < window.innerWidth)) return null;
    try {
        const before = document.createRange();
        before.setStart(block, 0);
        before.setEnd(sel.anchorNode, sel.anchorOffset);
        const all = document.createRange();
        all.selectNodeContents(block);
        const full = all.toString();
        let at = before.toString().length;
        // Back to the start of the word, so a click mid-word reads the whole word.
        while (at > 0 && /[\wÀ-ɏ'’-]/.test(full[at - 1])) at--;
        return { block: block, text: full.slice(at) };
    } catch (e) { return null; }
}

let _currentTTSBlockEl = null;

function speakSelection() {
    let selText = "";
    if (typeof currentSelectionText === 'function') {
        selText = currentSelectionText().trim();
    } else {
        selText = window.getSelection().toString().trim();
    }

    if (selText) {
        startReadingChunks([{ text: selText }]);
        return;
    }

    const caret = readingCaret();
    const sourceEdit = document.getElementById('source-editor');
    if (sourceEdit && window.getComputedStyle(sourceEdit).display !== 'none') {
        let text = sourceEdit.value.substring(sourceEdit.selectionStart || 0);
        startReadingChunks([{ text: text }]);
        return;
    }

    let chunks = [];

    if (typeof DocumentModel !== 'undefined' && typeof DocumentModel.toMarkdown === 'function' && DocumentModel.kind !== 'epub') {
        // Full DocumentModel available
        const idx = caret ? parseInt(caret.block.getAttribute('data-model-index'), 10) : 0;
        if (isFinite(idx) && DocumentModel.blocks && DocumentModel.blocks[idx]) {
            if (caret && caret.text !== DocumentModel.blocks[idx].raw) {
                chunks.push({ idx: idx, text: caret.text });
                for (let i = idx + 1; i < DocumentModel.blocks.length; i++) {
                    if (DocumentModel.blocks[i].raw) chunks.push({ idx: i, text: DocumentModel.blocks[i].raw });
                }
            } else {
                for (let i = idx; i < DocumentModel.blocks.length; i++) {
                    if (DocumentModel.blocks[i].raw) chunks.push({ idx: i, text: DocumentModel.blocks[i].raw });
                }
            }
        } else {
            chunks.push({ text: DocumentModel.toMarkdown() });
        }
    } else {
        // EPUB or simple DOM fallback
        const editor = document.getElementById('editor');
        if (editor) {
            // In EPUB, blocks might only exist for the current chapter/page. 
            // We gather what's in the DOM. For true continuous EPUB playback across chapters,
            // deeper integration with epub.js is needed, but this handles the loaded section.
            const blocks = Array.from(editor.querySelectorAll('.block'));
            let at = caret ? blocks.indexOf(caret.block) : -1;
            if (at < 0) {
                // No cursor on screen: the top of the page being looked at, not the top of
                // the whole loaded chapter -- which, after turning a page, would go back.
                const host = editor.getBoundingClientRect();
                at = blocks.findIndex(b => {
                    const r = b.getBoundingClientRect();
                    return r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom
                        && r.bottom > 0 && r.top < window.innerHeight;
                });
                if (at < 0) at = 0;
            }
            
            for (let i = at; i < blocks.length; i++) {
                let text = (i === at && caret) ? caret.text : blocks[i].innerText;
                let bIdx = blocks[i].getAttribute('data-model-index');
                if (bIdx != null) {
                    chunks.push({ idx: parseInt(bIdx, 10), text: text });
                } else {
                    chunks.push({ el: blocks[i], text: text });
                }
            }
        }
    }

    if (chunks.length > 0) {
        startReadingChunks(chunks);
    }
}

/**
 * Speak one piece of text: the entry point for anything outside this module -- the
 * dictionary's pronounce button, and tests. It disappeared when reading was split into
 * chunks, and with it the speaker beside the word in Look up (`02-layout.js` only draws
 * that button when this function exists).
 */
function startReading(text) {
    if (!text) return;
    startReadingChunks([{ text: text }]);
}

function startReadingChunks(chunks) {
    if (!chunks || chunks.length === 0) return;
    
    _ttsChunks = chunks;
    isPlaying = true;
    showReadAloudState();
    
    const editor = document.getElementById('editor');
    if (editor && chunks.some(c => c.idx != null || c.el)) {
        editor.classList.add('tts-reading-mode');
    }
    
    try { window.chrome.webview.postMessage("host_tts_start"); } catch(e){}

    playNextChunk();
}

function clearTTSFocus() {
    if (_currentTTSBlockEl) {
        _currentTTSBlockEl.classList.remove('tts-active');
        _currentTTSBlockEl = null;
    }
}

function playNextChunk() {
    clearTTSFocus();

    if (!isPlaying || _ttsChunks.length === 0) {
        stopReading();
        return;
    }
    const chunk = _ttsChunks.shift();
    if (!chunk.text || !chunk.text.trim()) {
        // skip empty blocks
        setTimeout(playNextChunk, 10);
        return;
    }

    const editor = document.getElementById('editor');
    let targetEl = chunk.el;

    if (chunk.idx != null && typeof goToPageHoldingBlock === 'function' && typeof isPaginatedLayout === 'function' && isPaginatedLayout()) {
        goToPageHoldingBlock(chunk.idx);
        // Wait a frame for DOM to update after page turn
        requestAnimationFrame(() => {
            if (!isPlaying) return;
            if (editor) {
                targetEl = editor.querySelector('[data-model-index="' + chunk.idx + '"]');
                if (targetEl) {
                    targetEl.classList.add('tts-active');
                    _currentTTSBlockEl = targetEl;
                    
                    try {
                        const sel = window.getSelection();
                        const range = document.createRange();
                        range.selectNodeContents(targetEl);
                        range.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(range);
                        if (typeof updateStats === 'function') updateStats();
                    } catch (e) {}
                }
            }
            sendTTSPlay(chunk.text);
        });
        return;
    } else {
        if (chunk.idx != null && editor) {
            targetEl = editor.querySelector('[data-model-index="' + chunk.idx + '"]');
        }
        if (targetEl) {
            if (typeof targetEl.scrollIntoView === 'function' && !(typeof isPaginatedLayout === 'function' && isPaginatedLayout())) {
                targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
            targetEl.classList.add('tts-active');
            _currentTTSBlockEl = targetEl;
            
            try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(targetEl);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                if (typeof updateStats === 'function') updateStats();
            } catch (e) {}
        }
        sendTTSPlay(chunk.text);
    }
}

function sendTTSPlay(text) {
    if (_isKokoroReady && _kokoroEngine) {
        if (isKokoroVoice(_kokoroVoice)) {
            playKokoroChunk(text, _kokoroVoice);
            return;
        }
    }

    if (text.length > 30000) text = text.substring(0, 30000);
    try { 
        window.chrome.webview.postMessage("host_tts_play:" + JSON.stringify({
            text: text
        })); 
    } catch(e){}
}

function stopReading() {
    _ttsChunks = [];
    clearTTSFocus();
    const editor = document.getElementById('editor');
    if (editor) editor.classList.remove('tts-reading-mode');
    
    if (_kokoroAudioSource) {
        try { _kokoroAudioSource.stop(); } catch(e){}
        _kokoroAudioSource = null;
    }
    
    // Invalidate Kokoro generation loop instantly
    if (typeof _generationId !== 'undefined') {
        _generationId++;
        _generationQueue = [];
        _playQueue = [];
    }
    
    try { window.chrome.webview.postMessage("host_tts_stop"); } catch(e){}
    isPlaying = false;
    showReadAloudState();
}

// --- Kokoro TTS Integration ---
let _kokoroEngine = null;
let _isKokoroReady = false;
let _kokoroAudioSource = null;
let _audioCtx = null;

function showKokoroStatus(text) {
    let div = document.getElementById('kokoro-status');
    if (!div) {
        div = document.createElement('div');
        div.id = 'kokoro-status';
        div.style.cssText = "position:fixed; bottom:20px; right:20px; background:#111; color:#fff; padding:15px 25px; border-radius:8px; z-index:99999; font-family:sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.5);";
        document.body.appendChild(div);
    }
    div.innerText = text;
}

// Where the installed engine lives. Null until the host says an extension is there, and
// nothing below runs before it does -- this is what keeps an uninstalled TypoZen from
// loading a speech engine, or touching the network, at launch.
let _kokoroExt = null;

window.setKokoroExtension = function (payload) {
    if (!payload || payload === 'none') {
        _kokoroExt = null;
        _kokoroEngine = null;
        _isKokoroReady = false;
        return;
    }
    const parts = payload.split('|');
    _kokoroExt = { base: parts[0], model: parts[1], dtype: parts[2] || 'fp16' };
    if (_kokoroVoice === 'system_default') {
        try { window.setKokoroVoice('af_heart', 'Heart'); } catch (e) {}
    }
};

async function setupKokoro(silent = false, successMsg = "Kokoro is ready. Pick a voice from File > Read Aloud.") {
    if (_isKokoroReady) {
        if (!silent) {
            showKokoroStatus("Kokoro is ready.");
            setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 2000);
        }
        return;
    }
    if (!_kokoroExt) {
        if (!silent) showKokoroStatus("The Kokoro voices are not installed. File > Extensions installs them.");
        return;
    }
    // The model runs on the GPU. On the CPU it generates about twice as slowly as the
    // speech plays, so there is no fallback worth offering -- the Windows voices are it.
    if (!navigator.gpu) {
        showKokoroStatus("Kokoro needs a graphics card with WebGPU. Using the Windows voices instead.");
        setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 5000);
        try { window.setKokoroVoice('windows_voice', 'Windows voice'); } catch (e) {}
        return;
    }

    if (!silent) showKokoroStatus("Starting the Kokoro engine...");

    try {
        const module = await import(_kokoroExt.base + 'engine.js');
        window._KokoroTTS = module.KokoroTTS;
        // The ONNX runtime fetches its own .wasm; without this it would go to a CDN.
        try { module.env.wasmPaths = _kokoroExt.base; } catch (e) {}

        if (!silent) showKokoroStatus("Loading the voice model...");
        _kokoroEngine = await window._KokoroTTS.from_pretrained(_kokoroExt.model, {
            dtype: _kokoroExt.dtype,
            device: "webgpu"
        });

        _isKokoroReady = true;
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        try { window.chrome.webview.postMessage("cmd:kokoro_ready"); } catch(e){}

        if (!silent) {
            showKokoroStatus(successMsg);
            setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 4000);
        }

    } catch (err) {
        console.error(err);
        try { if (typeof window.showDebugTelemetry === 'function') window.showDebugTelemetry("Kokoro init failed: " + err.message); } catch(e){}
        showKokoroStatus("Kokoro could not start: " + err.message + ". Using the Windows voices.");
        setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 6000);
        try { window.setKokoroVoice('windows_voice', 'Windows voice'); } catch (e) {}
    }
}

function isKokoroVoice(id) { return /^(af|am|bf|bm)_/.test(id || ''); }

let _kokoroVoice = localStorage.getItem('kokoro_voice') || 'af_heart';
try { window.chrome.webview.postMessage("host_kokoro_voice_restored:" + _kokoroVoice); } catch(e){}

// Add a hook so C# can change the voice on the fly
window.setKokoroVoice = function(voiceId, friendlyName) {
    // The host resets this to the Windows voices whenever the extension is missing, which
    // happens on every launch without it: saying so each time would be noise.
    const unchanged = (voiceId === _kokoroVoice);
    _kokoroVoice = voiceId;
    localStorage.setItem('kokoro_voice', voiceId);
    if (unchanged) return;

    let displayName = friendlyName || voiceId;
    const isAutoReset = (voiceId === 'windows_voice' && friendlyName === 'Windows voice');

    if (isKokoroVoice(voiceId) && !_isKokoroReady) {
        setupKokoro(false, "Kokoro is ready. Voice set to " + displayName + ".");
    } else if (!isAutoReset || _isKokoroReady) {
        showKokoroStatus("Voice set to " + displayName);
        setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 2000);
    }
};

let _generationQueue = [];
let _playQueue = [];
let _isGenerating = false;
let _isPlayingChunk = false;
let _generationId = 0; // Used to instantly cancel stale generations on Stop

async function processGenerationQueue(genId, voice) {
    if (_isGenerating) return;
    _isGenerating = true;
    while (_generationQueue.length > 0 && isPlaying && genId === _generationId) {
        const sentence = _generationQueue.shift();
        try {
            const audio = await _kokoroEngine.generate(sentence, { voice: voice, speed: 1.0 });
            if (!isPlaying || genId !== _generationId) break;
            _playQueue.push(audio);
            processPlayQueue(genId);
        } catch (e) {
            console.error("Generate error:", e);
        }
    }
    _isGenerating = false;
}

async function processPlayQueue(genId) {
    if (_isPlayingChunk || !isPlaying || genId !== _generationId) return;
    
    if (_playQueue.length === 0) {
        if (_generationQueue.length === 0) {
             playNextChunk(); // Entire block is done
        }
        return;
    }
    
    _isPlayingChunk = true;
    const audio = _playQueue.shift();
    
    try {
        if (_audioCtx.state === 'suspended') await _audioCtx.resume();
        const buffer = _audioCtx.createBuffer(1, audio.audio.length, audio.sampling_rate);
        buffer.getChannelData(0).set(audio.audio);
        
        await new Promise(resolve => {
            _kokoroAudioSource = _audioCtx.createBufferSource();
            _kokoroAudioSource.buffer = buffer;
            _kokoroAudioSource.connect(_audioCtx.destination);
            _kokoroAudioSource.onended = resolve;
            _kokoroAudioSource.start();
        });
    } catch (e) {
        console.error("Playback error:", e);
    }
    
    _kokoroAudioSource = null;
    _isPlayingChunk = false;
    
    if (isPlaying && genId === _generationId) {
        processPlayQueue(genId);
    }
}

async function playKokoroChunk(text, voice) {
    if (!isPlaying) return;
    
    _generationId++; 
    const currentGenId = _generationId;
    _generationQueue = [];
    _playQueue = [];
    _isGenerating = false;
    _isPlayingChunk = false;
    
    const regex = /[^.!?\n]+[.!?\n]+(?:\s|$)|[^.!?\n]+$/g;
    const sentences = text.match(regex);
    if (!sentences || sentences.length === 0) return;
    
    for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i].trim();
        if (s.length > 0) _generationQueue.push(s);
    }
    
    processGenerationQueue(currentGenId, voice);
}

// Called by 03-shell.js when native TTS finishes reading
function nativeTTSFinished() {
    if (_ttsChunks && _ttsChunks.length > 0) {
        playNextChunk();
    } else {
        stopReading();
    }
}

window.addEventListener('load', function() {
    initTTS();
    showReadAloudState();
});
