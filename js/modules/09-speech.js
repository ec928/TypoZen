// Native C# WinRT TTS Bridge

let isPlaying = false;

// The popover's read-aloud control in its two states, drawn to match the toolbar button:
const READ_ALOUD_HTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M2 19l6-15 6 15M4 14h6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>' +
    '</svg>';
const STOP_READING_HTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>' +
    '</svg>';

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
let _currentTTSChunkIdx = null;

window.restoreTTSFocus = function() {
    if (!isPlaying || _currentTTSChunkIdx == null) return;
    const editor = document.getElementById('editor');
    if (!editor) return;
    const targetEl = editor.querySelector('[data-model-index="' + _currentTTSChunkIdx + '"]');
    if (targetEl && targetEl !== _currentTTSBlockEl) {
        if (_currentTTSBlockEl) _currentTTSBlockEl.classList.remove('tts-active');
        targetEl.classList.add('tts-active');
        _currentTTSBlockEl = targetEl;
    }
};

function speakSelection() {
    let selText = "";
    if (typeof currentSelectionText === 'function') {
        selText = currentSelectionText().trim();
    } else {
        selText = window.getSelection().toString().trim();
    }

    if (selText) {
        let chunk = { text: selText };
        try {
            const sel = window.getSelection();
            if (sel && sel.anchorNode) {
                const node = sel.anchorNode;
                const el = node.nodeType === 1 ? node : node.parentElement;
                const block = el && el.closest ? el.closest('#editor .block') : null;
                if (block) {
                    let idx = parseInt(block.getAttribute('data-model-index'), 10);
                    if (isFinite(idx)) chunk.idx = idx;
                    else chunk.el = block;
                }
            }
        } catch (e) {}
        startReadingChunks([chunk]);
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

    if (!isPlaying) { stopReading(); return; }
    if (_ttsChunks.length === 0) {
        // Narration renders behind the voice, so an empty queue can mean "the next group
        // is still coming" rather than "the reading is over".
        if (_narrationPending) { setTimeout(playNextChunk, 400); return; }
        stopReading();
        return;
    }
    const chunk = _ttsChunks.shift();
    if (!chunk.text || !chunk.text.trim()) {
        // skip empty blocks
        setTimeout(playNextChunk, 10);
        return;
    }
    _currentTTSChunkIdx = chunk.idx;

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
            // Same rule as the unpaginated branch below: a chunk that already has audio
            // plays it. Missing it here meant narration silently fell back to a Windows
            // voice in Pages, which is the layout most reading happens in.
            if (chunk.audioUrl) playRenderedChunk(chunk.audioUrl);
            else sendTTSPlay(chunk.text);
        });
        return;
    } else {
        if (chunk.idx != null && editor) {
            targetEl = editor.querySelector('[data-model-index="' + chunk.idx + '"]');
            if (!targetEl && typeof ensureModelBlockVisible === 'function') {
                targetEl = ensureModelBlockVisible(chunk.idx, { topPad: 60 });
            }
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
        // Pre-rendered narration arrives as a chunk like any other, with a URL on it.
        // Nothing above this line knows the difference, which is the point: the highlight,
        // the page turning and the stop button are the same code they always were.
        if (chunk.audioUrl) playRenderedChunk(chunk.audioUrl);
        else sendTTSPlay(chunk.text);
    }
}

let _renderedAudio = null;

/** Play one pre-rendered file, then carry on down the queue. */
function playRenderedChunk(url) {
    try {
        window.__lastChunkUrl = url;          // what is actually playing, for tests and debug.log
        if (_renderedAudio) { _renderedAudio.pause(); _renderedAudio = null; }
        const a = new Audio(url);
        _renderedAudio = a;
        a.onplaying = () => { try { (window.__narrLog = window.__narrLog || []).push(['play', performance.now()]); } catch (e) {} };
        a.onended = () => {
            try { (window.__narrLog = window.__narrLog || []).push(['end', performance.now()]); } catch (e) {}
            _renderedAudio = null;
            if (isPlaying) playNextChunk();
        };
        a.onerror = () => {
            _renderedAudio = null;
            showKokoroStatus('Narration audio could not be played.');
            setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 4000);
            if (isPlaying) playNextChunk();
        };
        a.play().catch(() => { if (isPlaying) playNextChunk(); });
    } catch (e) {
        if (isPlaying) playNextChunk();
    }
}

/**
 * Narrate from where the reader is, using the Qwen sidecar.
 *
 * The sidecar renders in groups and caches by group, so the first group costs seconds and
 * anything heard before is instant. Blocks are sent with their model index, which is what
 * comes back on each item and what the chunk queue uses to move the highlight.
 */
let _narrationPending = false;
let _narrationReading = 0;
let _narrationBase = '';

/** How much audio is already queued and paid for. */
function queuedSeconds() {
    let n = 0;
    for (const c of _ttsChunks) n += (c.seconds || 0);
    return n;
}

/**
 * Tell the narrator to drop whatever is left of this reading. A group already inside the
 * model runs to its end -- a CUDA call cannot be interrupted safely -- so this saves the
 * groups that have not started, which is nearly all of them.
 */
function cancelNarration() {
    if (!_narrationBase || !_narrationReading) return;
    const reading = _narrationReading;
    _narrationReading++;                       // anything still in flight is now stale
    try {
        fetch(_narrationBase + '/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reading: reading })
        }).catch(() => {});
    } catch (e) {}
}

/** One request to the sidecar; returns chunks ready for the reading queue. */
async function renderNarration(base, group, blocks, reading) {
    const res = await fetch(base + '/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            blocks: group.map(w => ({ id: w.id, text: w.text })),
            reading: reading,
            group_size: group.length
        })
    });
    if (!res.ok) throw new Error('sidecar said ' + res.status);
    const data = await res.json();
    const byId = new Map(blocks.map(w => [w.id, w]));
    const chunks = [];
    for (const item of data.items || []) {
        const w = byId.get(item.id);
        if (!w) continue;
        const idx = parseInt(w.el.getAttribute('data-model-index'), 10);
        chunks.push({
            idx: isFinite(idx) ? idx : null,
            el: w.el,
            text: w.text,
            seconds: item.seconds || 0,
            audioUrl: 'https://localnarration/' + item.file
        });
    }
    return chunks;
}

/**
 * Break the text into pieces for rendering: sentences where possible, never across a
 * paragraph, and short at the start.
 *
 * Measured, and it is the whole design: rendering a batch takes about as long as its LONGEST
 * piece, and hardly longer for more pieces -- eight pieces cost roughly what one does. So
 * what decides how soon the first word is heard is how long the first pieces are, not how
 * many there are. The first eight are kept to a clause or so; the next eight to a sentence;
 * after that a paragraph's worth. Each batch then yields more audio than the next one takes
 * to make, so the reading never waits.
 */
function narrationPieces(blocks) {
    const out = [];
    let id = 0;
    const cap = () => out.length < 8 ? 55 : out.length < 16 ? 130 : 250;
    for (const w of blocks) {
        const sentences = w.text.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g)
            || [w.text];
        let cur = '';
        const flush = () => {
            if (cur.trim()) out.push({ el: w.el, id: id++, text: cur.trim() });
            cur = '';
        };
        for (let sentence of sentences) {
            // A sentence longer than the cap is cut at a clause, failing that at a word.
            while (sentence.length > cap()) {
                const limit = cap();
                flush();
                let at = Math.max(sentence.lastIndexOf(', ', limit), sentence.lastIndexOf('; ', limit),
                                  sentence.lastIndexOf(': ', limit), sentence.lastIndexOf(' — ', limit));
                if (at < limit * 0.4) at = sentence.lastIndexOf(' ', limit);
                if (at <= 0) at = limit;
                out.push({ el: w.el, id: id++, text: sentence.slice(0, at + 1).trim() });
                sentence = sentence.slice(at + 1);
            }
            if (cur && cur.length + sentence.length > cap()) flush();
            cur += sentence;
        }
        flush();
    }
    return out;
}

/**
 * Narrate from where the reader is.
 *
 * Groups grow -- one piece, then two, four, then eight -- and the next is requested the
 * moment the last one lands, so each arrives while the one before is still being heard.
 * One piece renders in a few seconds; eight render at about a third of the time they take
 * to say. The ramp is what gets both a fast start and no gaps.
 */
async function startQwenNarration(base) {
    const editor = document.getElementById('editor');
    if (!editor) return;
    // Starting somewhere new stops what was playing and cancels what was still rendering.
    if (isPlaying) stopReading();

    const all = Array.from(editor.querySelectorAll('.block'));
    if (!all.length) return;

    const caret = readingCaret();
    let at = caret ? all.indexOf(caret.block) : -1;
    if (at < 0) {
        const host = editor.getBoundingClientRect();
        // Both axes, exactly as speakSelection has it. Testing only the vertical one let the
        // pages already turned in Pages -- which sit to the left of the view -- count as on
        // screen, and narration started at the table of contents.
        at = all.findIndex(b => {
            const r = b.getBoundingClientRect();
            return r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom
                && r.bottom > 0 && r.top < window.innerHeight;
        });
    }
    if (at < 0) at = 0;

    const blocks = [];
    for (let i = at; i < all.length && blocks.length < 120; i++) {
        let text = (i === at && caret) ? caret.text : (all[i].innerText || '');
        text = text.trim();
        if (!text) continue;
        blocks.push({ el: all[i], text: applyTTSOverrides(text) });
    }
    const pieces = narrationPieces(blocks);
    if (!pieces.length) return;

    const reading = ++_narrationReading;
    _narrationBase = base;
    window.__narrLog = [];
    showKokoroStatus('Preparing the first passage...');
    _narrationPending = true;
    try {
        const first = await renderNarration(base, pieces.slice(0, 8), pieces, reading);
        document.getElementById('kokoro-status')?.remove();
        if (reading !== _narrationReading) return;          // stopped or restarted meanwhile
        if (!first.length) throw new Error('nothing came back');
        startReadingChunks(first);
    } catch (err) {
        _narrationPending = false;
        showKokoroStatus('Narration failed: ' + (err && err.message || err));
        setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 6000);
        return;
    }

    (async () => {
        try {
            let next = 8;
            while (next < pieces.length) {
                // About ninety seconds ahead is plenty; beyond that is work nobody may hear.
                while (isPlaying && reading === _narrationReading && queuedSeconds() > 90) {
                    await new Promise(r => setTimeout(r, 500));
                }
                if (!isPlaying || reading !== _narrationReading) break;
                const group = pieces.slice(next, next + 8);
                next += 8;
                const chunks = await renderNarration(base, group, pieces, reading);
                if (!isPlaying || reading !== _narrationReading) break;
                for (const c of chunks) _ttsChunks.push(c);
            }
        } catch (err) {
            try { if (typeof window.showDebugTelemetry === 'function') window.showDebugTelemetry('narration: ' + err.message); } catch (e) {}
        } finally {
            if (reading === _narrationReading) _narrationPending = false;
        }
    })();
}

window.startQwenNarration = startQwenNarration;

function applyTTSOverrides(text) {
    if (!text) return text;
    let t = text;

    // 1. Regex overrides for common Dune terms
    t = t.replace(/\bBene Gesserit\b/g, 'Benny Jesserit');
    t = t.replace(/\bKwisatz Haderach\b/g, 'Kwee-satz Hader-ack');
    t = t.replace(/\bHarkonnen\b/g, 'Har-ko-nen');
    t = t.replace(/\bChani\b/g, 'Chah-nee');
    t = t.replace(/\bTleilaxu\b/g, 'Tlay-lak-soo');
    t = t.replace(/\bSardaukar\b/g, 'Sar-dow-kar');
    t = t.replace(/\bGhola\b/g, 'Go-lah');

    // 2. POS Tagger for homographs
    if (typeof window.nlp === 'function') {
        try {
            let doc = window.nlp(t);
            
            // "lives" (verb vs noun)
            doc.match('lives').forEach(m => {
                if (m.has('#Verb')) {
                    let prev = m.lookBehind('.$').text().toLowerCase().trim();
                    if (['nine', 'past', 'other', 'many', 'their', 'our', 'your', 'my', 'his', 'her', 'previous', 'future'].includes(prev)) return;
                    m.replaceWith('livz');
                }
            });

            // "read" (past tense)
            doc.match('read').forEach(m => {
                if (m.has('#PastTense')) {
                    m.replaceWith('red');
                }
            });

            t = doc.text();
        } catch(e) { }
    }
    
    return t;
}

function sendTTSPlay(text) {
    if (_isKokoroReady && _kokoroEngine) {
        if (isKokoroVoice(_kokoroVoice)) {
            playKokoroChunk(text, _kokoroVoice, _currentTTSChunkIdx);
            return;
        }
    }

    text = applyTTSOverrides(text);

    if (text.length > 30000) text = text.substring(0, 30000);
    try { 
        window.chrome.webview.postMessage("host_tts_play:" + JSON.stringify({
            text: text
        })); 
    } catch(e){}
}

function stopReading() {
    _ttsChunks = [];
    _currentTTSChunkIdx = null;
    // Stop means stop: the queue stops waiting, and the narrator drops the rest.
    _narrationPending = false;
    cancelNarration();
    clearTTSFocus();
    const editor = document.getElementById('editor');
    if (editor) editor.classList.remove('tts-reading-mode');
    
    if (_kokoroAudioSource) {
        try { _kokoroAudioSource.stop(); } catch(e){}
        _kokoroAudioSource = null;
    }
    if (_renderedAudio) {
        try { _renderedAudio.pause(); } catch(e){}
        _renderedAudio = null;
    }
    
    // Invalidate Kokoro generation loop and prefetch instantly
    _prefetchedAudio = null;
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
    } else if (isKokoroVoice(_kokoroVoice) && !_isKokoroReady && !_isKokoroInitializing) {
        // The user's saved voice is a Kokoro voice — silently start loading the engine
        // so it's ready by the time they hit Play.
        setupKokoro(true);
    }
};

let _isKokoroInitializing = false;
async function setupKokoro(silent = false, successMsg = "Kokoro is ready. Pick a voice from File > Read Aloud.") {
    if (_isKokoroReady) {
        if (!silent) {
            showKokoroStatus("Kokoro is ready.");
            setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 2000);
        }
        return;
    }
    if (_isKokoroInitializing) {
        if (!silent) showKokoroStatus("Starting the Kokoro engine...");
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

    _isKokoroInitializing = true;
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
        _isKokoroInitializing = false;
        console.error(err);
        try { if (typeof window.showDebugTelemetry === 'function') window.showDebugTelemetry("Kokoro init failed: " + err.message); } catch(e){}
        showKokoroStatus("Kokoro could not start: " + err.message + ". Using the Windows voices.");
        setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 6000);
        try { window.setKokoroVoice('windows_voice', 'Windows voice'); } catch (e) {}
    }
}

function isKokoroVoice(id) { return /^(af|am|bf|bm)_/.test(id || ''); }

let _kokoroVoice = localStorage.getItem('kokoro_voice') || 'af_heart';
let _kokoroVoiceFriendly = '';
try { window.chrome.webview.postMessage("host_kokoro_voice_restored:" + _kokoroVoice); } catch(e){}

// Add a hook so C# can change the voice on the fly
window.setKokoroVoice = function(voiceId, friendlyName) {
    // The host resets this to the Windows voices whenever the extension is missing, which
    // happens on every launch without it: saying so each time would be noise.
    const unchanged = (voiceId === _kokoroVoice && friendlyName === _kokoroVoiceFriendly);
    _kokoroVoice = voiceId;
    _kokoroVoiceFriendly = friendlyName;
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

let _kokoroSampleId = 0;

window.playKokoroSample = async function(text, voice, speed = 1.0) {
    text = applyTTSOverrides(text);
    _kokoroSampleId++;
    const currentId = _kokoroSampleId;

    if (!_isKokoroReady) {
        if (typeof setupKokoro === 'function') {
            setupKokoro(false, "Kokoro is ready for testing.");
        }
        let waited = 0;
        while (!_isKokoroReady && waited < 15000) {
            await new Promise(r => setTimeout(r, 250));
            waited += 250;
            if (currentId !== _kokoroSampleId) return; // Superseded while waiting
        }
    }
    if (currentId !== _kokoroSampleId) return; // Superseded
    if (!_isKokoroReady || !_kokoroEngine) return;
    try {
        try { window.chrome.webview.postMessage("host_kokoro_sample_playing:" + voice); } catch(e){}
        if (_kokoroAudioSource) { try { _kokoroAudioSource.stop(); } catch(e){} }
        const audio = await _kokoroEngine.generate(text, { voice: voice, speed: speed });
        if (currentId !== _kokoroSampleId) return; // Superseded during generation
        if (_audioCtx.state === 'suspended') await _audioCtx.resume();
        const buffer = _audioCtx.createBuffer(1, audio.audio.length, audio.sampling_rate);
        buffer.getChannelData(0).set(audio.audio);
        _kokoroAudioSource = _audioCtx.createBufferSource();
        _kokoroAudioSource.buffer = buffer;
        _kokoroAudioSource.connect(_audioCtx.destination);
        _kokoroAudioSource.start();
    } catch (e) {
        console.error("Kokoro sample playback error:", e);
    }
};

let _generationQueue = [];
let _playQueue = [];
let _isGenerating = false;
let _isPlayingChunk = false;
let _generationId = 0; // Used to instantly cancel stale generations on Stop
let _prefetchedAudio = null; // { idx, voice, buffers[] } for the next paragraph

// Pre-generate all audio for the next paragraph while current one is still playing.
async function prefetchNextKokoro(genId) {
    if (!_ttsChunks || _ttsChunks.length === 0 || !_kokoroEngine) return;
    if (!isPlaying || genId !== _generationId) return;

    const nextChunk = _ttsChunks[0];
    if (!nextChunk || !nextChunk.text || !nextChunk.text.trim()) return;

    const voice = _kokoroVoice;
    const text = applyTTSOverrides(nextChunk.text);
    const groups = buildSentenceGroups(text);
    if (groups.length === 0) return;

    const buffers = [];
    for (const group of groups) {
        if (!isPlaying || genId !== _generationId) return; // cancelled
        try {
            const audio = await _kokoroEngine.generate(group, { voice: voice, speed: 1.0 });
            buffers.push(audio);
        } catch (e) { return; }
    }

    // Only store if nothing has changed while we were generating
    if (isPlaying && genId === _generationId) {
        _prefetchedAudio = { idx: nextChunk.idx, voice: voice, buffers: buffers };
    }
}

// Shared sentence grouping logic used by both playKokoroChunk and prefetchNextKokoro.
function buildSentenceGroups(text) {
    const regex = /[^.!?\n]+[.!?\n]+(?:["'\u201d\u2019)\]]*)(?:\s|$)|[^.!?\n]+$/g;
    let sentences = [];
    if (typeof window.nlp === 'function') {
        try { sentences = window.nlp(text).sentences().out('array'); } catch(e) {}
    }
    if (!sentences || sentences.length === 0) sentences = text.match(regex);
    if (!sentences || sentences.length === 0) return [];

    const groups = [];
    let currentGroup = "";
    for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i].trim();
        if (s.length === 0 || !/[a-zA-Z0-9]/.test(s)) continue;
        // Group sentences together up to ~250 chars (approx 40-50 words) to give the AI context,
        // while staying safely below the 125-word hard limit and keeping generation latency low.
        if (currentGroup.length + s.length > 250) {
            if (currentGroup.length > 0) groups.push(currentGroup);
            currentGroup = s;
        } else {
            currentGroup = currentGroup.length > 0 ? currentGroup + " " + s : s;
        }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);
    return groups;
}

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

    // Current paragraph is fully generated — start prefetching the next one
    if (isPlaying && genId === _generationId) {
        prefetchNextKokoro(genId);
    }
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

async function playKokoroChunk(text, voice, chunkIdx) {
    if (!isPlaying) return;
    
    _generationId++; 
    const currentGenId = _generationId;
    _generationQueue = [];
    _playQueue = [];
    _isGenerating = false;
    _isPlayingChunk = false;

    // Check if we already pre-generated audio for this chunk
    if (_prefetchedAudio && _prefetchedAudio.idx === chunkIdx && _prefetchedAudio.voice === voice) {
        const buffers = _prefetchedAudio.buffers;
        _prefetchedAudio = null;
        _playQueue = buffers;
        processPlayQueue(currentGenId);
        // Start prefetching the NEXT paragraph immediately
        prefetchNextKokoro(currentGenId);
        return;
    }
    _prefetchedAudio = null;

    text = applyTTSOverrides(text);
    const groups = buildSentenceGroups(text);
    if (groups.length === 0) return;
    
    _generationQueue = groups;
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



