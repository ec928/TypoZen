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

/**
 * The blocks reading works over: the document's, or on a PDF its paragraphs (10-pdf.js),
 * which are detached elements carrying their page and text offsets.
 */
function pdfReading() {
    return !!(window.tzPdfActive && typeof window.tzPdfBlocks === 'function');
}
function readingBlocks() {
    if (pdfReading()) return window.tzPdfBlocks();
    const editor = document.getElementById('editor');
    return editor ? Array.from(editor.querySelectorAll('.block')) : [];
}

let _currentTTSBlockEl = null;
let _currentTTSChunkIdx = null;

// True from pointer-down until pointer-up. Reading must not scroll or steal a
// selection the reader is in the middle of making.
window._tzPointerSelecting = false;
document.addEventListener('pointerdown', function () { window._tzPointerSelecting = true; }, true);
document.addEventListener('pointerup', function () { window._tzPointerSelecting = false; }, true);
document.addEventListener('pointercancel', function () { window._tzPointerSelecting = false; }, true);

function readerHoldingSelection() {
    try {
        if (window._tzPointerSelecting) return true;
        const s = window.getSelection();
        return !!(s && !s.isCollapsed);
    } catch (e) { return false; }
}

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

    // With the Qwen narrator chosen, every way of starting to read comes here -- Read Aloud,
    // the popover's Read and Read from here -- and goes to the narrator: the selection alone
    // for Read, otherwise from the cursor or the top of the page. The host makes sure the
    // narrator is running and answers with cmd:narrate. Source mode has no rendered blocks
    // to narrate, so it keeps the Windows voice.
    const sourceShown = (() => {
        return isSourceShown();
    })();
    if (isQwenVoice(_kokoroVoice) && !sourceShown) {
        let el = null;
        try {
            if (pdfReading()) el = window.tzPdfBlockAtSelection();
            else {
                const sel = window.getSelection();
                const node = sel && sel.anchorNode;
                const e = node && (node.nodeType === 1 ? node : node.parentElement);
                el = e && e.closest ? e.closest('#editor .block') : null;
            }
        } catch (e) {}
        _qwenPending = selText && el ? { text: selText, el: el } : null;
        narrLog('read requested: ' + (_qwenPending ? 'the selection, ' + selText.length + ' chars' : 'from here'));
        try { window.chrome.webview.postMessage('host_qwen_narrate'); } catch (e) {}
        return;
    }

    // A PDF: its paragraphs, from the one the cursor is in or the first on screen, each
    // highlighted on the page as it is read.
    if (pdfReading()) {
        const all = readingBlocks();
        if (selText) {
            const el = window.tzPdfBlockAtSelection();
            startReadingChunks([el ? { text: selText, el: el } : { text: selText }]);
            return;
        }
        const at = window.tzPdfReadStart();
        if (at < 0) return;
        // From the cursor's word, not the top of its paragraph (Read from here).
        const fromCaret = typeof window.tzPdfTextFromCaret === 'function' ? window.tzPdfTextFromCaret(all[at]) : null;
        startReadingChunks(all.slice(at).map((el, i) => ({ el: el, text: (i === 0 && fromCaret) ? fromCaret : el.textContent })));
        return;
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
    const sourceEdit = sourceEditor;
    if (sourceEdit && isSourceShown()) {
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
    // With the Qwen narrator chosen, a word is said by the quick voice closest to it -- same
    // country and gender -- which the host picks (PickWordVoice). The narrator itself took
    // about 25 seconds to say one word when it had to start (Ed, 2026-09-26); before that,
    // the last Windows voice picked said it, so a British narrator got an American word.
    if (isQwenVoice(_kokoroVoice)) {
        if (isPlaying) stopReading();
        try { window.chrome.webview.postMessage('host_word_play:' + JSON.stringify({ text: text })); } catch (e) {}
        return;
    }
    startReadingChunks([{ text: text }]);
}

/**
 * One word in a Kokoro voice, the reading voice left as it is (the host's PickWordVoice chose
 * it as closest to the narrator). Kokoro loads its model on first use.
 */
async function speakWordKokoro(voice, text) {
    if (!text) return;
    if (!_isKokoroReady) { try { await setupKokoro(true); } catch (e) {} }
    if (!_isKokoroReady || !isKokoroVoice(voice)) return;
    const keep = _kokoroVoice;
    _kokoroVoice = voice;                  // read once, synchronously, by sendTTSPlay
    try { startReadingChunks([{ text: text }]); }
    finally { _kokoroVoice = keep; }
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
    try { if (typeof window.tzPdfReadClear === 'function') window.tzPdfReadClear(); } catch (e) {}
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
        if (_narrationPending) {
            if (_narrActive && !_narrSilentSince) {
                _narrSilentSince = performance.now();
                narrLog('SILENT: queue empty, waiting for the next batch');
                narrWait('is catching up with the next passage', 0);
            }
            setTimeout(playNextChunk, 400);
            return;
        }
        if (_narrActive) narrLog('queue empty and nothing still rendering: reading ends');
        stopReading();
        return;
    }
    if (_narrSilentSince) {
        narrLog('sound again after ' + ((performance.now() - _narrSilentSince) / 1000).toFixed(1) + 's of silence');
        _narrSilentSince = 0;
        narrWaitEnd();
        narrPhase('reading');
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

    // The caret stays where the reader left it. Moving it onto the paragraph
    // being read is what raised the browser spelling menu (Anna / Anan / Amna)
    // over a selection, and accepting one of those suggestions deleted the
    // paragraphs after the line. The highlight is the reading marker.
    const holdSel = readerHoldingSelection();
    if (!holdSel && chunk.idx != null && typeof goToPageHoldingBlock === 'function' && typeof isPaginatedLayout === 'function' && isPaginatedLayout()) {
        goToPageHoldingBlock(chunk.idx);
        // Wait a frame for DOM to update after page turn
        requestAnimationFrame(() => {
            if (!isPlaying) return;
            if (editor) {
                targetEl = editor.querySelector('[data-model-index="' + chunk.idx + '"]');
                if (targetEl) {
                    targetEl.classList.add('tts-active');
                    _currentTTSBlockEl = targetEl;
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
        if (targetEl && targetEl.dataset && targetEl.dataset.pdfPage != null
            && typeof window.tzPdfReadFocus === 'function') {
            // A PDF paragraph is not in the document: the PDF paints and scrolls to it.
            window.tzPdfReadFocus(targetEl);
            _currentTTSBlockEl = targetEl;
        } else if (targetEl) {
            if (!holdSel && typeof targetEl.scrollIntoView === 'function' && !(typeof isPaginatedLayout === 'function' && isPaginatedLayout())) {
                targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
            targetEl.classList.add('tts-active');
            _currentTTSBlockEl = targetEl;
        }
        // Pre-rendered narration arrives as a chunk like any other, with a URL on it.
        // Nothing above this line knows the difference, which is the point: the highlight,
        // the page turning and the stop button are the same code they always were.
        if (chunk.audioUrl) playRenderedChunk(chunk.audioUrl);
        else sendTTSPlay(chunk.text);
    }
}

let _renderedAudio = null;
let _narrActive = false;        // a Qwen reading is in progress, for the trace
let _narrSilentSince = 0;

/** Play one pre-rendered file, then carry on down the queue. */
function playRenderedChunk(url) {
    const name = String(url).split('/').pop();
    try {
        window.__lastChunkUrl = url;          // what is actually playing, for tests and debug.log
        if (_renderedAudio) { _renderedAudio.pause(); _renderedAudio = null; }
        const a = new Audio(url);
        // The reading speed from Configure Speed. Chromium keeps the pitch while changing
        // the rate, so faster is brisker, not squeakier.
        a.playbackRate = _narrSpeed;
        _renderedAudio = a;
        const began = performance.now();
        a.onplaying = () => {
            try { (window.__narrLog = window.__narrLog || []).push(['play', performance.now()]); } catch (e) {}
            narrLog('play ' + name + ' (' + (isFinite(a.duration) ? a.duration.toFixed(1) + 's' : '?s') +
                    ', ' + _ttsChunks.length + ' more queued, ' + queuedSeconds().toFixed(1) + 's)');
        };
        a.onended = () => {
            try { (window.__narrLog = window.__narrLog || []).push(['end', performance.now()]); } catch (e) {}
            narrLog('ended ' + name + ' after ' + ((performance.now() - began) / 1000).toFixed(1) + 's');
            _renderedAudio = null;
            if (isPlaying) playNextChunk();
        };
        a.onerror = () => {
            narrLog('audio ERROR on ' + name + ': code ' + (a.error ? a.error.code + ' ' + (a.error.message || '') : '?'));
            _renderedAudio = null;
            showKokoroStatus('Narration audio could not be played.');
            setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 4000);
            if (isPlaying) playNextChunk();
        };
        a.play().catch(err => {
            narrLog('play() REFUSED for ' + name + ': ' + (err && (err.name + ' ' + err.message) || err));
            if (isPlaying) playNextChunk();
        });
    } catch (e) {
        narrLog('playRenderedChunk threw on ' + name + ': ' + (e && e.message || e));
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
let _qwenPending = null;        // a selection to narrate once the host says the narrator is up

/**
 * The narrator's settings, from the host (File > Read Aloud > Narrator settings): the
 * narrator's voice, the instruction it reads by -- the whole of it, as the reader sees and edits
 * it -- the wording of an emotion cue, the reading speed, and this book's cast (character key
 * to voice id). Sent before every narration and whenever they change.
 */
let _narrVoice = '';
let _narrVoiceName = '';
let _narrStyle = '';
let _narrInstruction = null;    // null: not sent, and the narrator uses its standing wording
let _narrCue = '';
let _narrSpeed = 1;
let _narrCast = {};
// Optional instruction per cast character (character key to text). Sent with that
// character's lines. Empty means the stock in-character line.
let _narrCastSay = {};
// Emotion cues from speech tags, sent as each piece's direction. The host's settings decide
// (Narrator settings, Emotion cues; on unless the reader turns them off).
let _narrDirect = false;
// Privacy Mode: new audio goes to this session's private folder, served by localnarrationp.
let _narrPrivate = false;
window.setNarratorSettings = function (json) {
    try {
        const s = typeof json === 'string' ? JSON.parse(json) : json;
        const before = JSON.stringify([_narrVoice, _narrStyle, _narrInstruction, _narrCue, _narrCast, _narrCastSay, _narrDirect]);
        _narrVoice = s.voice || '';
        _narrVoiceName = s.voiceName || '';
        _narrStyle = s.style || '';
        _narrInstruction = typeof s.instruction === 'string' ? s.instruction : null;
        _narrCue = s.cue || '';
        _narrDirect = s.direct === true;
        _narrSpeed = Math.max(0.5, Math.min(2, parseFloat(s.speed) || 1));
        _narrCast = s.cast || {};
        _narrCastSay = (s.castSay && typeof s.castSay === 'object') ? s.castSay : {};
        _narrPrivate = !!s.private;
        if (_renderedAudio) _renderedAudio.playbackRate = _narrSpeed;
        // A new voice, style or cast while narrating: start again at the paragraph being read,
        // in the new voice, rather than play out what was already rendered in the old one.
        if (before !== JSON.stringify([_narrVoice, _narrStyle, _narrInstruction, _narrCue, _narrCast, _narrCastSay, _narrDirect]) && _narrActive && isPlaying) {
            narrLog('settings changed while narrating: restarting at the current paragraph');
            _qwenPending = null;
            try { window.chrome.webview.postMessage('host_qwen_narrate'); } catch (e) {}
        }
        narrLog('settings: voice ' + (_narrVoice || 'default') +
                (_narrInstruction !== null ? ', instruction ' + _narrInstruction.length + ' chars'
                                           : ', style ' + (_narrStyle ? _narrStyle.length + ' chars' : 'standard')) +
                ', speed ' + _narrSpeed + ', cast ' + Object.keys(_narrCast).length +
                (_narrDirect ? ', emotion cues' : '') +
                (_narrPrivate ? ', private' : ''));
    } catch (e) { narrLog('settings unreadable: ' + (e && e.message || e)); }
};

/**
 * What the reader is told while the narrator prepares audio: whose voice, what for, and a
 * clock against the estimate, so a minute's wait reads as progress rather than a hang. The
 * status bar is told too (host_narration_phase).
 */
let _narrWaitTimer = 0;
function narrWait(what, estimate) {
    narrWaitEnd();
    const t0 = performance.now();
    const who = _narrVoiceName || 'The narrator';
    const tick = () => {
        const s = Math.round((performance.now() - t0) / 1000);
        let clock = s + 's';
        if (estimate > 0) clock = s <= estimate ? s + 's of about ' + Math.round(estimate) + 's'
                                                : s + 's, longer than the usual ' + Math.round(estimate) + 's';
        showKokoroStatus(who + ' ' + what + ': ' + clock);
    };
    tick();
    _narrWaitTimer = setInterval(tick, 1000);
    narrPhase('preparing');
}
/** Ends the clock and takes its message down. True if one was running. */
function narrWaitEnd() {
    if (!_narrWaitTimer) return false;
    clearInterval(_narrWaitTimer);
    _narrWaitTimer = 0;
    document.getElementById('kokoro-status')?.remove();
    return true;
}
function narrPhase(p) { try { window.chrome.webview.postMessage('host_narration_phase:' + p); } catch (e) {} }

/**
 * Narration's trace: every decision the page makes, sent to the narrator's narration.log so
 * that one file holds the page and the sidecar side by side. Also kept in window.__narrTrace
 * and the telemetry ring. Ids, counts, lengths and timings only -- never the text.
 */
let _narrTraceOut = [];
let _narrTraceTimer = null;
function narrLog(msg) {
    try {
        (window.__narrTrace = window.__narrTrace || []).push(msg);
        if (window.__narrTrace.length > 500) window.__narrTrace.shift();
        if (typeof window.showDebugTelemetry === 'function') window.showDebugTelemetry('narration: ' + msg);
    } catch (e) {}
    // Privacy Mode: nothing reaches narration.log -- kept in memory only, gone with the page.
    if (_narrPrivate) return;
    _narrTraceOut.push(msg);
    if (_narrTraceOut.length > 200) _narrTraceOut.shift();
    // Held until narration has actually reached the narrator. Posting to its port at start-up
    // -- the settings line -- was a request with nothing installed, which TypoZen promises
    // never to make (extensions-app, "nothing left the machine").
    if (_narrTraceTimer || !_narrationBase) return;
    _narrTraceTimer = setTimeout(() => {
        _narrTraceTimer = null;
        const lines = _narrTraceOut;
        _narrTraceOut = [];
        const base = _narrationBase;
        try {
            fetch(base + '/log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lines: lines })
            }).catch(() => {});
        } catch (e) {}
    }, 250);
}

/** "id:chars" for each piece of a batch, for the trace. */
function batchSummary(batch) {
    return batch.map(p => p.id + ':' + p.text.length + 'ch' + (p.speaker ? '{' + p.speaker + '}' : '') +
                          (_narrDirect && p.direction ? '[' + p.direction + ']' : '')).join(' ');
}

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

/**
 * Narrator Settings' "Try it": the reader's own text, read with the settings on screen (saved
 * or not), cut, respelt and cued exactly as narration does it -- speakNumbers, blockPieces,
 * narrationDirection -- so what is heard is what narrating that text would sound like. The
 * dialog's own shortcut used to skip all three, so the emotion cues could never be heard there.
 *
 * `o`: {base, text, voice, instruction, cue, direct, seed}. Each line is a paragraph. Tells the host
 * host_narrator_trial:{kind:'ready', pieces:[{text, cue, instruction, seconds}]} before playing,
 * {kind:'ended'} after, or {kind:'error', message}.
 */
let _trialAudio = null;
let _trialQueue = [];
let _trialRun = 0;
function trialTell(o) { try { window.chrome.webview.postMessage('host_narrator_trial:' + JSON.stringify(o)); } catch (e) {} }
window.narrationTrialStop = function () {
    _trialRun++;
    _trialQueue = [];
    if (_trialAudio) { try { _trialAudio.pause(); } catch (e) {} _trialAudio = null; }
};
window.narrationTrial = async function (json) {
    window.narrationTrialStop();
    const run = _trialRun;
    try {
        const o = typeof json === 'string' ? JSON.parse(json) : json;
        if (isPlaying) stopReading();
        const pieces = [];
        String(o.text || '').split(/\r?\n/).map(l => l.trim()).filter(l => /[A-Za-z0-9]/.test(l)).forEach(line => {
            paragraphPieces(speakNumbers(line), null).forEach(p => pieces.push(p));
        });
        if (!pieces.length) throw new Error('there is no text to read');
        const items = [];
        for (let k = 0; k < pieces.length; k += NARRATION_BATCH) {
            const batch = pieces.slice(k, k + NARRATION_BATCH);
            const res = await fetch(o.base + '/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    voice: o.voice || '', instruction: String(o.instruction || ''), cue: o.cue || '',
                    blocks: batch.map((p, i) => { const told = cueInstruction(p, !!o.direct, o.instruction); return {
                        id: k + i, text: p.text, direction: told.direction, instruction: told.instruction }; }),
                    reading: 900000 + run, group_size: batch.length, private: _narrPrivate,
                    // Another take is another seed; take 1 is narration's own (1234).
                    seed: parseInt(o.seed, 10) || 1234
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || ('the narrator said ' + res.status));
            if (run !== _trialRun) return;
            (data.items || []).forEach(it => items.push(it));
        }
        if (items.length !== pieces.length) throw new Error('the narrator returned ' + items.length + ' of ' + pieces.length + ' pieces');
        trialTell({ kind: 'ready', pieces: pieces.map((p, i) => ({
            text: p.text, cue: o.direct ? p.direction : '', instruction: items[i].instruction || '', seconds: items[i].seconds || 0 })) });
        _trialQueue = items.map(it => (it.private ? 'https://localnarrationp/' : 'https://localnarration/') + it.file);
        const next = () => {
            if (run !== _trialRun) return;
            const url = _trialQueue.shift();
            if (!url) { _trialAudio = null; trialTell({ kind: 'ended' }); return; }
            _trialAudio = new Audio(url);
            _trialAudio.playbackRate = _narrSpeed;
            _trialAudio.onended = next;
            _trialAudio.onerror = () => { if (run === _trialRun) trialTell({ kind: 'error', message: 'could not play ' + url }); };
            _trialAudio.play().catch(err => { if (run === _trialRun) trialTell({ kind: 'error', message: String(err && err.message || err) }); });
        };
        next();
    } catch (err) {
        if (run === _trialRun) trialTell({ kind: 'error', message: String(err && err.message || err) });
    }
};
/** The text selected in the document, for "Use selected text". */
window.narrationTrialSelection = function () {
    let t = '';
    try { t = String(getSelection() || ''); } catch (e) {}
    trialTell({ kind: 'selection', text: t });
};

/** The speech tag's words are added to the standing instruction when cues are on.
 *  A bracket, including [[tag]], still replaces that instruction. "said", "asked"
 *  and "told" are not added. A stock punctuation cue stays a direction, so the
 *  cue wording still wraps it. */
function cueInstruction(p, cuesOn, standing) {
    const own = (p.instruction || '').trim();
    const dir = (p.direction || '').trim();
    const stock = dir === 'thought' || dir === 'emphatic' || dir === 'breaking off';
    const phrase = cuesOn && dir && !stock
        ? dir.replace(/\b(say|says|said|ask|asks|asked|tell|tells|told)\b/ig, ' ')
            .replace(/\s+/g, ' ').replace(/^[\s,:;.]+|[\s,:;.]+$/g, '').trim()
        : '';
    if (p.bracket && own) return { instruction: own, direction: '' };
    if (phrase) {
        const base = p.role === 'dialogue' ? own : (own || String(standing || '').trim());
        return { instruction: base ? base.replace(/[\s,;]+$/, '') + ', ' + phrase : phrase, direction: '' };
    }
    return { instruction: own, direction: cuesOn ? dir : '' };
}

/** One request to the sidecar; returns chunks ready for the reading queue. */
async function renderNarration(base, batch, reading) {
    const sent = performance.now();
    narrLog('request reading ' + reading + ': ' + batchSummary(batch));
    let data;
    try {
        const res = await fetch(base + '/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({
                voice: _narrVoice,
                style: _narrStyle,
                blocks: batch.map(p => { const told = cueInstruction(p, _narrDirect, _narrInstruction); return {
                    id: p.id, text: p.text, direction: told.direction,
                    voice: p.voice || '', role: p.role || 'narration', instruction: told.instruction }; }),
                reading: reading,
                group_size: batch.length,
                private: _narrPrivate
            }, _narrInstruction !== null ? { instruction: _narrInstruction, cue: _narrCue } : {}))
        });
        if (!res.ok) throw new Error('sidecar said ' + res.status);
        data = await res.json();
    } catch (err) {
        narrLog('request reading ' + reading + ' FAILED after ' + Math.round(performance.now() - sent) +
                'ms: ' + (err && err.message || err));
        throw err;
    }
    // Items come back in the order sent, from the cache or not. Matched by position rather
    // than id, so a manifest written by an older build can never pair audio with other text.
    const items = data.items || [];
    narrLog('answer reading ' + reading + ' after ' + Math.round(performance.now() - sent) + 'ms: ' +
            items.length + '/' + batch.length + ' items' + (data.cancelled ? ', CANCELLED' : '') +
            (data.from_cache ? ', ' + data.from_cache + ' from cache' : '') +
            ', audio ' + items.map(i => (i.seconds || 0).toFixed(1) + 's').join(' '));
    if (data.cancelled || items.length !== batch.length) return [];
    if (!data.from_cache) learnRenderRate(batch, (performance.now() - sent) / 1000);
    return batch.map((p, i) => {
        const idx = p.el ? parseInt(p.el.getAttribute('data-model-index'), 10) : NaN;
        return {
            idx: isFinite(idx) ? idx : null,
            id: p.id,
            el: p.el,
            at: p.at,
            text: p.text,
            seconds: items[i].seconds || 0,
            // Per item: a private reading still plays pieces already in the lasting cache.
            audioUrl: (items[i].private ? 'https://localnarrationp/' : 'https://localnarration/') + items[i].file
        };
    });
}

/**
 * How narration is cut up, and why (docs/archive/qwen-tts-plan.md, 3c, 3e and 3g).
 *
 * A paragraph is one piece, so its intonation carries across its sentences. Only a paragraph
 * longer than the cap is split, at sentence ends.
 *
 * Except at the start of a reading. A batch takes as long as its
 * LONGEST piece, whatever else is in it (26 batches measured, 2026-09-24), so one long opening
 * paragraph meant two minutes of silence. The opening batch is therefore cut into sentences,
 * and each later batch may hold pieces only as long as the audio already queued can cover
 * while it renders -- growing back to whole paragraphs within a few batches. See
 * graduatedBatches.
 *
 * (Short pieces were once banned because VoiceDesign invented the speaker afresh for every
 * piece, so each boundary could change the voice. Every piece is now read with the chosen
 * voice-print, so a boundary costs some flow between sentences, not the voice. The faster
 * start was chosen over that flow on 2026-09-24.)
 *
 * Batches start where reading starts. The narrator caches each piece on its own and never
 * renders one it already has, so a restart, a replay or a page rendered ahead reuses what
 * exists whichever batch made it. (Batches used to be fixed groups of eight blocks so that
 * a re-render matched the cache exactly. Starting near the end of a group then rendered the
 * whole group, mostly unheard, and waited for the next: 117s to first sound.)
 */
const NARRATION_BATCH = 8;          // pieces the model renders in one call
const NARRATION_PIECE_CAP = 400;    // characters; only longer paragraphs are split
const NARRATION_OPENING_CAP = 90;   // characters per piece in the opening batch: ~20s to first sound

/** Where a block sits in the document: its model index, or failing that its place on the page. */
function narrationDocIndex(el, i) {
    const idx = parseInt(el.getAttribute('data-model-index'), 10);
    return isFinite(idx) ? idx : i;
}

/**
 * Numbers as words, for the Qwen narrator (British English).
 *
 * The narrator turns digits into sound itself and gets them wrong: "£86,000 - £117,800" came
 * out as "eighty six thousand pounds nine hundred seventeen thousand eight hundred" in one
 * voice and "...minus one hundred seventeen thousand eight hundred twenty" in another (Ed,
 * 2026-09-26), with "Pay Range:" right in front of it. The Windows voices run a normaliser of
 * their own first and read it correctly; this is that step for the narrator. Only what is
 * spoken changes, never the text.
 *
 * Amounts (£ $ €, with k / m / bn), ranges between numbers ("to"), dates and ordinals, times,
 * percentages, decimals, years where the words around them say they are years, and plain
 * numbers. Left alone: anything joined to letters (A4, COVID-19, mp3), numbers with a leading
 * zero (phone numbers, "01"), and dotted versions (0.6.8). One self-contained function so
 * tests/speak-numbers-selftest.mjs can run it as it is.
 */
function speakNumbers(text) {
    if (!text || !/\d/.test(text)) return text;
    const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];
    const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
    const FULL_MONTH = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', Jun: 'June', Jul: 'July',
        Aug: 'August', Sep: 'September', Sept: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
    const month = (m) => FULL_MONTH[m] || m;

    const under100 = (n) => n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
    const under1000 = (n) => {
        const h = Math.floor(n / 100), r = n % 100;
        if (!h) return under100(r);
        return ONES[h] + ' hundred' + (r ? ' and ' + under100(r) : '');
    };
    const cardinal = (n) => {
        if (n === 0) return 'zero';
        const groups = [];
        while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
        const parts = [];
        for (let i = groups.length - 1; i >= 0; i--) {
            const g = groups[i];
            if (!g) continue;
            // British: "one thousand and five" -- a last group under a hundred after a larger one.
            parts.push((i === 0 && g < 100 && groups.length > 1 ? 'and ' : '') + under1000(g) + (SCALES[i] ? ' ' + SCALES[i] : ''));
        }
        return parts.join(' ');
    };
    const ordinal = (n) => {
        const w = cardinal(n);
        const m = w.match(/^(.*?)([a-z]+)$/);
        const IRREG = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
        const last = m[2];
        return m[1] + (IRREG[last] || (/y$/.test(last) ? last.slice(0, -1) + 'ieth' : last + 'th'));
    };
    const year = (n) => {
        if (n === 2000) return 'two thousand';
        if (n > 2000 && n < 2010) return 'two thousand and ' + ONES[n - 2000];
        const hi = Math.floor(n / 100), lo = n % 100;
        if (lo === 0) return under100(hi) + ' hundred';
        return under100(hi) + ' ' + (lo < 10 ? 'oh ' + ONES[lo] : under100(lo));
    };
    const toNumber = (s) => Number(String(s).replace(/,/g, ''));
    // A number as words: integers, and decimals read digit by digit after "point".
    const numberWords = (s) => {
        const [whole, frac] = String(s).replace(/,/g, '').split('.');
        const w = whole.length > 15 ? whole.split('').map(d => ONES[+d]).join(' ') : cardinal(Number(whole));
        return frac ? w + ' point ' + frac.split('').map(d => ONES[+d]).join(' ') : w;
    };
    const NUM = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
    // Not joined to letters, other digits, a dot or a hyphen on either side.
    const START = '(?<![\\w.,\\-–—£$€])(?!0\\d)';
    const END = '(?![\\w]|[.,]\\d|\\s*[-–—]\\s*\\d)';
    let t = text;

    // Times: 12pm, 9:30 am, 12:30.
    t = t.replace(new RegExp(START + '(\\d{1,2})(?::(\\d{2}))?\\s?(am|pm|a\\.m\\.|p\\.m\\.)(?![\\w])', 'gi'), (m, h, mm, ap) => {
        const hh = +h, min = mm ? +mm : 0;
        if (hh > 24 || min > 59) return m;
        const minutes = mm ? (min === 0 ? '' : ' ' + (min < 10 ? 'oh ' + ONES[min] : under100(min))) : '';
        return cardinal(hh) + minutes + (/^a/i.test(ap) ? ' a.m.' : ' p.m.');
    });
    t = t.replace(new RegExp(START + '(\\d{1,2}):(\\d{2})(?![\\w:]|[.,]\\d)', 'g'), (m, h, mm) => {
        const hh = +h, min = +mm;
        if (hh > 24 || min > 59) return m;
        return cardinal(hh) + ' ' + (min === 0 ? "o'clock" : min < 10 ? 'oh ' + ONES[min] : under100(min));
    });

    // Ranges: a dash between two numbers or amounts is "to" -- "£86,000 - £117,800". Not in a
    // chain of three or more (phone numbers), and the currency of the first carries to the second.
    t = t.replace(new RegExp(START + '([£$€]\\s?)?(' + NUM + ')(\\s?(?:k|m|bn)\\b|%)?\\s*[-–—]\\s*([£$€]\\s?)?((?!0\\d)' + NUM + ')(?![\\w]|[.,]\\d|\\s*[-–—]\\s*\\d)', 'g'),
        (m, c1, a, s1, c2, b) => (c1 || '') + a + (s1 || '') + ' to ' + (c2 || c1 || '') + b);

    // Amounts: £86,000, £1.50, $3.99, €20, £2m, £3.5bn, £40k, £2 million.
    const UNIT = { '£': ['pound', 'pounds', 'pence'], '$': ['dollar', 'dollars', 'cents'], '€': ['euro', 'euros', 'cents'] };
    t = t.replace(new RegExp(START + '([£$€])\\s?(' + NUM + ')(?:\\s?(k|m|bn)\\b|\\s(thousand|million|billion)\\b)?', 'g'), (m, c, n, short, word) => {
        const u = UNIT[c];
        const scale = short ? { k: 'thousand', m: 'million', bn: 'billion' }[short.toLowerCase()] : word;
        if (scale) return numberWords(n) + ' ' + scale + ' ' + u[1];
        const [whole, frac] = n.replace(/,/g, '').split('.');
        const main = cardinal(Number(whole)) + ' ' + (Number(whole) === 1 ? u[0] : u[1]);
        if (frac && frac.length === 2 && +frac > 0) return main + ' ' + under100(+frac);
        return frac ? numberWords(n) + ' ' + u[1] : main;
    });

    // Dates: "7th September 2026" -> "the seventh of September, twenty twenty-six";
    // "September 7, 2026" -> "September the seventh, twenty twenty-six".
    t = t.replace(new RegExp(START + '(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + MONTHS + ')\\b\\.?(?:,?\\s+(\\d{4})(?![\\w]))?', 'g'), (m, d, mo, y) => {
        if (+d < 1 || +d > 31) return m;
        return 'the ' + ordinal(+d) + ' of ' + month(mo) + (y ? ', ' + year(+y) : '');
    });
    t = t.replace(new RegExp('\\b(' + MONTHS + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\w:])(?:,?\\s+(\\d{4})(?![\\w]))?', 'g'), (m, mo, d, y) => {
        if (+d < 1 || +d > 31) return m;
        return month(mo) + ' the ' + ordinal(+d) + (y ? ', ' + year(+y) : '');
    });
    t = t.replace(new RegExp('\\b(' + MONTHS + ')\\s+(\\d{4})(?![\\w])', 'g'), (m, mo, y) => month(mo) + ' ' + year(+y));

    // Ordinals: 1st, 22nd, 103rd.
    t = t.replace(new RegExp(START + '(\\d{1,9})(st|nd|rd|th)\\b', 'gi'), (m, n) => ordinal(+n));

    // Percentages.
    t = t.replace(new RegExp(START + '(' + NUM + ')\\s?%', 'g'), (m, n) => numberWords(n) + ' per cent');

    // Years, where the words before say so: "in 1990", "from 1990 to 1995", "(2019)".
    t = t.replace(new RegExp('(\\b(?:in|since|until|till|by|from|to|of|during|year|circa|c\\.|early|late|mid|and)\\s+|\\()(1[0-9]\\d{2}|20\\d{2})(?![\\w]|[.,]\\d)', 'gi'),
        (m, before, y) => before + year(+y));

    // Everything else that is a number on its own.
    t = t.replace(new RegExp(START + '(' + NUM + ')' + END, 'g'), (m, n) => numberWords(n));
    return t;
}

/** A paragraph's text as the narrator should hear it: numbers as words (speakNumbers). */
function narrationText(el) {
    return speakNumbers((el && el.innerText || '').trim());
}

/** A paragraph as one piece, or several at sentence ends when it is over the cap. */
function blockPieces(text) {
    if (text.length <= NARRATION_PIECE_CAP) return [text];
    const sentences = text.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g) || [text];
    const out = [];
    let cur = '';
    for (const s of sentences) {
        if (cur && cur.length + s.length > NARRATION_PIECE_CAP) { out.push(cur.trim()); cur = ''; }
        cur += s;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/**
 * Brackets stay in the spoken text. CustomVoice and VoiceDesign perform these as the
 * line is said; rewriting one into an instruction and deleting it is what made them
 * stop. A span tag at the front of a piece is repeated on later pieces of the same
 * split, because each piece is a separate generation. A point event is left where it
 * was written.
 */
const SPAN_TAG = /^(?:excited|sad|angry|amazed|serious|sarcastic|curious|mischievously|crying|panicked|tired|asmr|singing|whispers|very slowly|very fast|like dracula|deep and loud shouting)$/i;

/** [[tag]] is an instruction, never spoken. The first one in a stretch of text wins. */
function doubleTag(text) {
    const m = /\[\[([^\]\n]+)\]\]/.exec(String(text || ''));
    return m && m[1].trim() ? m[1].trim() : '';
}
function stripDoubles(text) {
    return String(text || '').replace(/\[\[[^\]\n]*\]\]/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,:.!?])/g, '$1');
}
/** True when this single-bracket match is the inside of a [[tag]]. */
function partOfDouble(text, abs, raw) {
    const t = String(text || '');
    return t.slice(abs, abs + 2) === '[['
        || (abs > 0 && t[abs - 1] === '[')
        || t[abs + raw.length] === ']';
}
/** One space either side of a bracket that was glued to a word. Existing spaces stay. */
function padBracketTags(text) {
    return String(text || '')
        .replace(/(\S)(\[[^\]\n]+\])/g, '$1 $2')
        .replace(/(\[[^\]\n]+\])(\S)/g, '$1 $2');
}
/** A bracket with nothing but whitespace between it and the quotation at quoteStart. */
function leadingBracket(text, quoteStart) {
    const head = String(text || '').slice(0, quoteStart);
    const m = head.match(/\[[^\]\n]+\]\s*$/);
    if (!m) return null;
    const raw = m[0].replace(/\s+$/, '');
    if (partOfDouble(head, m.index, raw)) return null;
    return { at: m.index, raw: raw };
}
/** Later pieces of one split keep a span tag that opened the first piece. */
function carrySpan(pieces) {
    if (!pieces.length) return pieces;
    const m = /^\s*\[([^\]\n]+)\]/.exec(pieces[0]);
    if (!m || !SPAN_TAG.test(m[1].trim())) return pieces;
    const tag = '[' + m[1].trim() + ']';
    return pieces.map(function (p, i) {
        if (i === 0 || /^\s*\[/.test(p)) return p;
        return tag + ' ' + p;
    });
}
/**
 * One paragraph as the narrator hears it. Brackets are part of the words. A guessed
 * cue, from "she snapped" and the like, stays with the piece it was found in.
 */
function paragraphPieces(text, el) {
    const hard = doubleTag(text);
    const spoken = padBracketTags(stripDoubles(text)).trim();
    if (!/[A-Za-z0-9]/.test(spoken)) return [];
    return carrySpan(blockPieces(spoken)).map(function (t) {
        return { text: t, direction: narrationDirection(t, el || null),
                 instruction: hard, bracket: !!hard };
    });
}

/**
 * Direction (docs/archive/qwen-tts-plan.md 4, slice 3): how the spoken lines in a piece should sound,
 * read from the text around them. '' is plain narration, the narrator's standing style.
 *
 * Per paragraph rather than per utterance. Fiction gives each speaker their own paragraph --
 * the line, the "she snapped", the gesture -- so the paragraph is the unit a direction belongs
 * to, and keeping it whole keeps the intonation that runs across its sentences. Cutting out
 * "he said." to voice it apart would lose that and leave fragments too short to sound right.
 *
 * The speech tag's own words are the cue. "Anna shouts, speaks loudly, forcefully, fast"
 * is that clause with the name left out, not a stock phrase. "Said", "asked" and "told"
 * add nothing. Failing a tag, the line's own punctuation. Only outside the quotes, so a
 * character saying "whispered" is not a whisper.
 */
function cuePhrase(clause, who) {
    let s = String(clause || '').replace(/\[\[[^\]\n]*\]\]/g, ' ').replace(/\[[^\]\n]*\]/g, ' ');
    const words = s.split(/\s+/).map(function (w) {
        return w.replace(/^[^A-Za-z0-9'’]+|[^A-Za-z0-9'’]+$/g, '');
    }).filter(Boolean);
    const drop = [];
    if (who) String(who).split(/\s+/).forEach(function (w) { if (w) drop.push(w); });
    if (words.length && (looksLikeName(words[0]) || isPronoun(words[0]))) drop.push(words[0]);
    if (words.length > 1 && (looksLikeName(words[words.length - 1]) || isPronoun(words[words.length - 1]))) drop.push(words[words.length - 1]);
    drop.forEach(function (w) {
        s = s.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'ig'), ' ');
    });
    s = s.replace(/\s+/g, ' ').replace(/^[\s,:;.]+|[\s,:;.]+$/g, '').trim();
    const left = s.split(/[^A-Za-z'’]+/).filter(function (w) {
        return w && !/^(say|says|said|ask|asks|asked|tell|tells|told)$/i.test(w);
    });
    return left.length ? s : '';
}

// A speech tag after a quote: "Anna snapped", "she whispered". Not the next sentence.
const SPEECH_TAG = /^\s*(\S+\s+){0,3}?(said|asked|replied|protested|continued|began|added|told|cried|called|answered|admitted|agreed|whispered|murmured|muttered|shouted|yelled|snapped|hissed|laughed|sighed|gasped|wept|sobbed|pleaded|begged|demanded|insisted|stammered|growled|barked|roared|screamed)\b/i;

/**
 * The words around one quotation that can colour it. The lead-in is the same sentence only,
 * back to the previous full stop. What follows counts only when it is still that sentence:
 * "she whispered", or "Anna snapped". "Anna was quietly snoring" is the next sentence.
 */
function quoteCueTag(text, index, length) {
    const before = text.slice(Math.max(0, index - 80), index).split(/[.!?…”"]\s/).pop() || '';
    const after = text.slice(index + length, index + length + 80).split(/[.!?…“"]/)[0] || '';
    const parts = [before];
    if (/^\s*[a-z]/.test(after) || SPEECH_TAG.test(after)) parts.push(after);
    return parts.join(' ');
}

function narrationDirection(text, el) {
    const quotes = text.match(/[“"][^”"]+[”"]/g) || [];
    if (!quotes.length) {
        // Mostly italic and no dialogue: a character's thought, in most novels.
        try {
            let italic = 0;
            if (el) el.querySelectorAll('em, i').forEach(n => { italic += (n.textContent || '').length; });
            if (italic > 0 && italic >= 0.7 * text.length) return 'thought';
        } catch (e) {}
        return '';
    }
    // Only the tag touching each quotation -- '"...," the drone muttered' -- back to the last
    // sentence end before it and on to the next after it. Searching the whole paragraph made
    // "quietly snoring" a soft line, and a king who screams later in the paragraph turned his
    // captor's calm words into a shout.
    // A tag is part of the quotation's sentence: after it, lowercase ('" the drone muttered')
    // or a name then a speech verb ('" Ferbin protested angrily'); before it, a clause that
    // leads in with a comma or colon. The next sentence is not a tag -- '"Hmm." She relaxed
    // and was quietly snoring' is not a soft line.
    const tags = [];
    const re = /[“"][^”"]+[”"]/g;
    let m;
    while ((m = re.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 60), m.index).split(/[.!?…”"]\s/).pop();
        if (/[,:]\s*$/.test(before)) tags.push(before);
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60).split(/[.!?…“"]/)[0];
        if (/^\s*[a-z]/.test(after) || SPEECH_TAG.test(after)) tags.push(after);
    }
    const phrases = [];
    tags.forEach(function (tag) {
        const phrase = cuePhrase(tag, '');
        if (phrase && phrases.indexOf(phrase) < 0) phrases.push(phrase);
    });
    if (phrases.length) return phrases.join(', ');
    const spoken = quotes.join(' ');
    if (/!/.test(spoken)) return 'emphatic';
    if (/(—|–|\.\.\.|…)\s*[”"]/.test(spoken)) return 'breaking off';
    return '';
}

/**
 * Cast (slice 4): who speaks each quotation. A capitalised name within eight words of the
 * quotation, outside it, is the speaker. A speech verb in those words changes which name:
 * the name before the verb speaks ("Jill told Paul" is Jill; Paul was spoken to), and
 * "... said Jill" still counts because nobody is named before the verb. With no verb, the
 * nearer name wins. Commas and colons are not required.
 *
 * A character is keyed by the last word of their name, lower case: "tyl Loesp" and "Loesp"
 * are one person, "the King" is "king". A pronoun only resolves when the paragraph names
 * exactly one known speaker; otherwise the line stays with the narrator, which never sounds
 * wrong, where a line in the wrong character's voice would. An untagged line in an unbroken
 * run of dialogue goes to whoever spoke two paragraphs before.
 */
// Sentence words that are capitalised and are not people. Without this, "After" would be
// a character whenever it was the only capital word near a quotation.
const NOT_A_NAME = /^(After|Then|But|And|When|While|Before|Once|Suddenly|However|Meanwhile|Later|Soon|Still|There|Here|Yes|No|Oh|Well|Now|So|Yet|Thus|Therefore|Perhaps|Maybe|He|She|It|They|We|You|I)$/;
// Dialogue tags only. "talked" is not one: "Bob talked, then Jill said" is Jill.
const SPEECH_VERB = /^(say|says|said|ask|asks|asked|reply|replies|replied|protested|continued|began|added|tell|tells|told|cried|call|calls|called|answered|admitted|agreed|whispered|murmured|muttered|shouted|yelled|snapped|hissed|laughed|sighed|gasped|wept|sobbed|pleaded|begged|demanded|insisted|stammered|growled|barked|roared|screamed|announced|explained|observed|remarked|suggested|warned|retorted|exclaimed|responded|conceded|repeated|interrupted|breathed)$/i;

function quoteWords(text) {
    // A line instruction sits in brackets beside the name. Its words are not part of
    // the eight-word window, or a long instruction would hide the speaker.
    return String(text || '').replace(/\[\[[^\]\n]*\]\]/g, ' ').replace(/\[[^\]\n]*\]/g, ' ').split(/\s+/).map(function (w) {
        return w.replace(/^[^A-Za-z0-9'’]+|[^A-Za-z0-9'’]+$/g, '');
    }).filter(Boolean);
}

function looksLikeName(word) {
    return /^[A-Z][A-Za-z'’-]{1,}$/.test(word) && !NOT_A_NAME.test(word);
}

function isPronoun(word) {
    return /^(he|she|it|they|we|you|i)$/i.test(word);
}

function nameSpan(words, idx) {
    let a = idx, b = idx;
    while (a > 0 && looksLikeName(words[a - 1])) a--;
    while (b + 1 < words.length && looksLikeName(words[b + 1])) b++;
    return words.slice(a, b + 1).join(' ');
}

/**
 * Speaker on one side of a quotation. words are in reading order; nearEnd means the
 * quotation follows them. Only the eight words beside the quotation count.
 */
function speakerBeside(words, nearEnd) {
    const n = words.length;
    if (!n) return null;
    const inWindow = i => nearEnd ? (n - 1 - i) < 8 : i < 8;
    const distOf = i => nearEnd ? (n - i) : (i + 1);
    let verbAt = -1;
    if (nearEnd) {
        for (let i = n - 1; i >= 0 && inWindow(i); i--) {
            if (SPEECH_VERB.test(words[i])) { verbAt = i; break; }
        }
    } else {
        for (let i = 0; i < n && inWindow(i); i++) {
            if (SPEECH_VERB.test(words[i])) { verbAt = i; break; }
        }
    }
    if (verbAt >= 0) {
        // The subject stands before the verb. The name after it was spoken to.
        for (let i = verbAt - 1; i >= 0 && inWindow(i); i--) {
            if (isPronoun(words[i])) return { who: words[i], dist: distOf(verbAt), verb: true };
            if (looksLikeName(words[i])) return { who: nameSpan(words, i), dist: distOf(verbAt), verb: true };
        }
        for (let i = verbAt + 1; i < n && inWindow(i); i++) {
            if (isPronoun(words[i])) return { who: words[i], dist: distOf(verbAt), verb: true };
            if (looksLikeName(words[i])) return { who: nameSpan(words, i), dist: distOf(verbAt), verb: true };
        }
        return null;
    }
    for (let i = nearEnd ? n - 1 : 0; inWindow(i) && i >= 0 && i < n; i += nearEnd ? -1 : 1) {
        if (!looksLikeName(words[i])) continue;
        return { who: nameSpan(words, i), dist: distOf(i), verb: false };
    }
    return null;
}

function speakerKey(who) {
    if (!who || /^(he|she|it|they|i)$/i.test(who)) return '';
    return who.replace(/^the\s+/i, '').trim().split(/\s+/).pop().replace(/[’']s$/, '').toLowerCase();
}

/** Where `who` last stands in `zone`, so a bracket can be read from there to the right. */
function nameAt(zone, who) {
    if (!who) return -1;
    const escaped = String(who).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|[^A-Za-z\'’])(' + escaped + ')(?![A-Za-z\'’])', 'gi');
    let at = -1, m;
    while ((m = re.exec(zone))) at = m.index + m[0].length - m[1].length;
    return at;
}

function zoneBefore(text, index) {
    const before = text.slice(0, index);
    const parts = before.split(/[.!?…]["'”’)\]]*\s/);
    const last = parts[parts.length - 1] || '';
    return { at: before.length - last.length, text: last };
}

function zoneAfter(text, index) {
    const after = text.slice(index);
    const m = /^([\s\S]*?)(?=[.!?…]|$)/.exec(after);
    return { at: index, text: m ? m[1] : after };
}

/** The first single bracket at or after `from` in the zone. [[tag]] is not one of these. */
function firstBracket(zoneText, zoneAt, from) {
    let pos = from;
    while (pos < zoneText.length) {
        const m = /\[[^\]\n]+\]/.exec(zoneText.slice(pos));
        if (!m) return null;
        const abs = pos + m.index;
        const raw = m[0];
        if (raw.slice(0, 2) === '[[' || (abs > 0 && zoneText[abs - 1] === '[')) {
            pos = abs + raw.length;
            continue;
        }
        const inner = raw.slice(1, -1).trim();
        if (!inner) { pos = abs + raw.length; continue; }
        const start = zoneAt + abs;
        return { instruct: inner, hideStart: start, hideEnd: start + raw.length };
    }
    return null;
}

/**
 * The line's own instruction, if one was written for it. To the right of a detected
 * character (`Anna [whispers softly], "…"` or `"…," Anna [whispers softly].`) it replaces
 * that character's cast instruction. With no character, a bracket beside the quotation
 * replaces the narrator's instruction for that quotation. A bracket inside the quotation
 * is not this: it stays in the spoken text.
 */
function lineInstruction(text, start, end, who) {
    if (who) {
        const left = zoneBefore(text, start);
        const atLeft = nameAt(left.text, who);
        if (atLeft >= 0) return firstBracket(left.text, left.at, atLeft + who.length);
        const right = zoneAfter(text, end);
        const atRight = nameAt(right.text, who);
        if (atRight >= 0) return firstBracket(right.text, right.at, atRight + who.length);
        return null;
    }
    const left = zoneBefore(text, start);
    const lead = left.text.match(/\[[^\]\n]+\]\s*[,:]?\s*$/);
    if (lead) {
        const raw = lead[0].match(/\[[^\]\n]+\]/)[0];
        const at = left.at + lead.index + lead[0].indexOf(raw);
        const inner = raw.slice(1, -1).trim();
        if (inner && !partOfDouble(text, at, raw)) {
            return { instruct: inner, hideStart: at, hideEnd: at + raw.length };
        }
    }
    const right = zoneAfter(text, end);
    const tail = right.text.match(/^\s*[,:]?\s*\[[^\]\n]+\]/);
    if (tail) {
        const raw = tail[0].match(/\[[^\]\n]+\]/)[0];
        const at = right.at + tail.index + tail[0].indexOf(raw);
        const inner = raw.slice(1, -1).trim();
        if (inner && !partOfDouble(text, at, raw)) {
            return { instruct: inner, hideStart: at, hideEnd: at + raw.length };
        }
    }
    return null;
}

/** The quotations in a paragraph, each with the name within eight words of it, if any. */
function narrationQuotes(text) {
    const out = [];
    const re = /[“"]([^”"]+)[”"]/g;
    let m;
    while ((m = re.exec(text))) {
        const before = quoteWords(text.slice(0, m.index));
        const after = quoteWords(text.slice(m.index + m[0].length));
        const left = speakerBeside(before, true);
        const right = speakerBeside(after, false);
        // A speech verb beats a bare name. Two verbs: the closer one. Otherwise the nearer name.
        let pick = null;
        if (left && right) {
            if (left.verb !== right.verb) pick = left.verb ? left : right;
            else pick = left.dist <= right.dist ? left : right;
        } else pick = left || right;
        const who = pick ? pick.who : null;
        const q = {
            start: m.index, end: m.index + m[0].length, inner: m[1], who: who,
            tag: quoteCueTag(text, m.index, m[0].length),
            key: speakerKey(who)
        };
        const line = lineInstruction(text, q.start, q.end, who);
        if (line) {
            q.instruct = line.instruct;
            q.hideStart = line.hideStart;
            q.hideEnd = line.hideEnd;
            const raw = text.slice(line.hideStart, line.hideEnd);
            q.tag = q.tag.split(raw).join(' ');
        }
        // [[tag]] anywhere in this quotation's sentence wins over the cast box, the
        // narrator box, a speech tag, and a single bracket. It is removed from the speech.
        const beforeZone = zoneBefore(text, q.start);
        const afterZone = zoneAfter(text, q.end);
        const hard = doubleTag(text.slice(beforeZone.at, afterZone.at + afterZone.text.length));
        if (hard) q.instruct = hard;
        out.push(q);
    }
    return out;
}

/**
 * Speakers for a run of paragraph texts: an array (one per text) of its quotations with `key`
 * resolved as far as the rules allow. `known` is the set of speaker keys named explicitly
 * anywhere in the book as loaded, which is what a pronoun may resolve to.
 */
function attributeParagraphs(texts, known) {
    const result = [];
    const recent = [];                          // speakers of the dialogue paragraphs just before
    for (const text of texts) {
        const qs = narrationQuotes(text);
        if (!qs.length) { result.push(qs); recent.length = 0; continue; }
        const outside = text.replace(/[“"][^”"]+[”"]/g, ' ');
        const named = new Set((outside.match(/[A-Z][\w’'-]+/g) || []).map(w => speakerKey(w)).filter(k => known.has(k)));
        const explicit = new Set(qs.filter(q => q.key).map(q => q.key));
        for (const q of qs) {
            if (q.key) continue;
            if (q.who && named.size === 1) q.key = [...named][0];              // "he said", one candidate
            else if (explicit.size === 1) q.key = [...explicit][0];           // one speaker per paragraph
        }
        if (!qs.some(q => q.key) && !qs.some(q => q.who) && recent.length >= 2 &&
            recent[recent.length - 1] !== recent[recent.length - 2]) {
            const k = recent[recent.length - 2];                              // A, B, A, B...
            qs.forEach(q => { q.key = k; });
        }
        const speaker = (qs.find(q => q.key) || {}).key;
        if (speaker) recent.push(speaker); else recent.length = 0;
        result.push(qs);
    }
    return result;
}

function blockPlain(el) {
    if (el == null) return '';
    if (typeof el === 'string') return el;
    return el.innerText || '';
}

/** Speaker keys named outright (not by pronoun) anywhere in the loaded book. */
function knownSpeakers(all) {
    const known = new Set();
    for (const el of all) {
        const t = blockPlain(el);
        if (!/[“"]/.test(t)) continue;
        for (const q of narrationQuotes(t)) if (q.key) known.add(q.key);
    }
    return known;
}

/**
 * Paragraph texts Find characters reads. A markdown or text file keeps the whole book
 * in DocumentModel; the preview only mounts a window of it, so a scan of the blocks on
 * screen missed anyone further on. An epub's model is not that window's plain text, so
 * the scan stays on the chapter that is loaded.
 */
function castScanTexts() {
    if (typeof DocumentModel !== 'undefined' && DocumentModel && DocumentModel.kind !== 'epub'
        && Array.isArray(DocumentModel.blocks) && DocumentModel.blocks.length) {
        return {
            whole: true,
            texts: DocumentModel.blocks.map(b => String(b && b.raw || '').trim())
        };
    }
    const all = (typeof document !== 'undefined' && document.querySelectorAll)
        ? Array.from(document.querySelectorAll('#editor .block')) : [];
    return { whole: false, texts: all.map(el => (el.innerText || '').trim()) };
}

/**
 * The characters with how many lines each speaks, for the cast list in Narrator settings.
 * Sent to the host as host_narrator_cast. `whole` says whether this was the full book.
 */
window.narrationCastScan = function () {
    const src = castScanTexts();
    const known = knownSpeakers(src.texts);
    const counts = {}, names = {};
    attributeParagraphs(src.texts, known).forEach(qs => qs.forEach(q => {
        if (!q.key) return;
        counts[q.key] = (counts[q.key] || 0) + 1;
        if (q.who && !/^(he|she|it|they|i)$/i.test(q.who)) {
            const n = names[q.key] = names[q.key] || {};
            n[q.who] = (n[q.who] || 0) + 1;
        }
    }));
    const list = Object.keys(counts).filter(k => counts[k] >= 2).map(k => {
        const forms = names[k] || {};
        const name = Object.keys(forms).sort((a, b) => forms[b] - forms[a])[0] || k;
        return { key: k, name: name, lines: counts[k] };
    }).sort((a, b) => b.lines - a.lines);
    narrLog('cast scan: ' + list.length + ' characters over ' + src.texts.length + ' blocks'
        + (src.whole ? ', whole book' : ', loaded part'));
    try {
        window.chrome.webview.postMessage('host_narrator_cast:' + JSON.stringify({ whole: src.whole, characters: list }));
    } catch (e) {}
    return list;
};

/** A cast line's own direction: the speech tag's words, else its punctuation. */
function quoteDirection(q) {
    const phrase = cuePhrase(q.tag || '', q.who);
    if (phrase) return phrase;
    if (/!/.test(q.inner)) return 'emphatic';
    if (/(—|–|\.\.\.|…)\s*$/.test(q.inner)) return 'breaking off';
    return '';
}

/**
 * A paragraph cut between voices: each line of a cast character in their voice, and the
 * narration around them -- including lines by characters with no voice of their own -- in
 * the narrator's.
 */
function castSay(key) {
    const s = _narrCastSay && _narrCastSay[key];
    return typeof s === 'string' ? s.trim() : '';
}
/** Drop line-instruction brackets out of a slice. They are told, not spoken. */
function excise(slice, at, quotes) {
    let s = slice;
    const cuts = (quotes || []).filter(q => q.hideEnd > at && q.hideStart < at + s.length)
        .sort((a, b) => b.hideStart - a.hideStart);
    for (const q of cuts) {
        const a = Math.max(0, q.hideStart - at);
        const b = Math.min(s.length, q.hideEnd - at);
        s = s.slice(0, a) + s.slice(b);
    }
    return s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,:.!?])/g, '$1');
}

function castPieces(text, quotes, from) {
    const out = [];
    // from: Read from here started inside this paragraph; nothing before it is voiced, and
    // a quotation it lands in is voiced from there.
    from = from > 0 ? from : 0;
    let cursor = from, narr = '';
    const talk = (spoken, voice, dir, key, instruction, bracket) => {
        carrySpan(blockPieces(spoken)).forEach(p => out.push({
            role: 'dialogue', text: p, voice: voice, direction: dir, speaker: key,
            instruction: instruction || '', bracket: !!bracket
        }));
    };
    const tellNarrator = (spoken, dir, instruction) => {
        carrySpan(blockPieces(spoken)).forEach(p => out.push({
            role: 'narration', text: p, direction: dir, instruction: instruction || '', bracket: !!instruction
        }));
    };
    // quoteTook: the [[tag]] already given to the quotation this lead-in belongs to.
    // That clip is told the tag. The lead-in keeps the narrator's own instruction,
    // and the tag is still not spoken. A tag in an earlier sentence stays here.
    const flush = (quoteTook) => {
        const raw = narr;
        narr = '';
        const found = doubleTag(raw);
        const hard = quoteTook && found === quoteTook ? '' : found;
        const spoken = padBracketTags(stripDoubles(raw)).trim();
        if (!/[A-Za-z0-9]/.test(spoken)) return;
        carrySpan(blockPieces(spoken)).forEach(p => out.push({
            role: 'narration', text: p, direction: narrationDirection(p, null),
            instruction: hard, bracket: !!hard
        }));
    };
    for (const q of quotes) {
        const voice = q.key && _narrCast[q.key];
        const override = (q.instruct || '').trim();
        // No voice and no line instruction: the quotation stays in the narration.
        if (!voice && !override) continue;
        if (q.end <= from) continue;
        if (q.start < from) {
            const rest = text.slice(from, q.end).replace(/["'“”‘’]+\s*$/, '').trim();
            const spoken = padBracketTags(stripDoubles(rest)).trim();
            if (/[A-Za-z0-9]/.test(spoken)) {
                if (voice) talk(spoken, voice, quoteDirection(q), q.key, override || castSay(q.key), !!override);
                else tellNarrator(spoken, quoteDirection(q), override);
            }
            cursor = q.end;
            continue;
        }
        // A bracket sitting against the quotation is spoken by that character, unless it
        // is the line instruction, which is told and not spoken.
        const lead = leadingBracket(text, q.start);
        const consumed = lead && q.hideStart != null && q.hideStart <= lead.at
            && q.hideEnd >= lead.at + lead.raw.length;
        const peel = lead && !consumed && lead.at >= cursor;
        narr += excise(text.slice(cursor, peel ? lead.at : q.start), cursor, quotes);
        // The quote was the rest of this sentence. A comma left on the lead-in
        // ("Anna whispered,") is an unfinished sentence, and the model keeps talking.
        narr = narr.replace(/,\s*$/, '.');
        const beforeZone = zoneBefore(text, q.start);
        const afterZone = zoneAfter(text, q.end);
        flush(doubleTag(text.slice(beforeZone.at, afterZone.at + afterZone.text.length)));
        if (voice) {
            const spoken = padBracketTags(stripDoubles((peel ? lead.raw + ' ' : '') + q.inner.trim())).trim();
            if (/[A-Za-z0-9]/.test(spoken)) talk(spoken, voice, quoteDirection(q), q.key, override || castSay(q.key), !!override);
        } else {
            const spoken = stripDoubles(text.slice(q.start, q.end)).trim();
            if (/[A-Za-z0-9]/.test(spoken)) tellNarrator(spoken, quoteDirection(q), override);
        }
        cursor = q.end;
    }
    narr += excise(text.slice(cursor), cursor, quotes);
    flush();
    return out;
}

/**
 * Up to `maxBatches` batches of pieces, starting with the block all[from]. Each piece carries
 * its block's document index as `at`, and its direction; with a cast, a paragraph where a
 * cast character speaks is cut between their voice and the narrator's.
 */
/**
 * Where `part` begins in `full` when it is full's tail, ignoring whitespace (the cursor's
 * text comes from a DOM range, the narrator's from innerText, and they space differently);
 * -1 when it is not the tail, so the caller reads the whole paragraph rather than guess.
 */
function narrationTailStart(full, part) {
    const strip = s => String(s || '').replace(/\s+/g, '');
    const p = strip(part), f = strip(full);
    if (!p || p.length >= f.length || !f.endsWith(p)) return -1;
    let need = p.length, i = full.length;
    while (i > 0 && need > 0) { i--; if (!/\s/.test(full[i])) need--; }
    return i;
}

/**
 * firstText: for Read from here, the starting paragraph's text from the cursor's word on
 * (readingCaret / tzPdfTextFromCaret). Without it the narrator read the whole paragraph,
 * as if the cursor had been at its start.
 */
function narrationBatches(all, from, maxBatches, graduated, firstText) {
    const pieces = [];
    const limit = maxBatches * NARRATION_BATCH;
    // Speakers, only when this book has a cast. Attributed from a few paragraphs before the
    // start, so an exchange already under way is recognised.
    let speakers = null, first = from;
    if (Object.keys(_narrCast).length) {
        first = Math.max(0, from - 4);
        const known = knownSpeakers(all);
        Object.keys(_narrCast).forEach(k => known.add(k));
        const texts = all.slice(first, Math.min(all.length, from + limit + 40))
            .map(el => narrationText(el));
        speakers = attributeParagraphs(texts, known);
    }
    for (let i = from; i < all.length && pieces.length < limit; i++) {
        const at = narrationDocIndex(all[i], i);
        // The text as written, not applyTTSOverrides': those respellings ("livz", "Benny
        // Jesserit") help the Windows and Kokoro voices, but Qwen reads words from their
        // context, and by ear it did better without them -- the respelled name came out
        // distorted (2026-09-24).
        let text = narrationText(all[i]);
        if (!text) continue;
        // Read from here: the starting paragraph from the cursor's word, not its top.
        const cut = (i === from && firstText) ? narrationTailStart(text, speakNumbers(String(firstText).trim())) : -1;
        let quotes = speakers && speakers[i - first];
        // No cast on this book, or this paragraph was outside the attributed window.
        // A bracket beside a quotation is still the narrator's instruction for it.
        if (!quotes) {
            const found = narrationQuotes(text);
            if (found.some(q => (q.instruct || '').trim())) quotes = found;
        }
        if (quotes && quotes.some(q => (q.key && _narrCast[q.key]) || (q.instruct || '').trim())) {
            castPieces(text, quotes, cut > 0 ? cut : 0).forEach((p, k) => pieces.push(Object.assign({ el: all[i], at: at, id: at * 100 + k }, p)));
            continue;
        }
        if (cut > 0) text = text.slice(cut).trim();
        paragraphPieces(text, all[i]).forEach((p, k) => pieces.push({
            el: all[i], at: at, id: at * 100 + k, role: 'narration',
            text: p.text, direction: p.direction,
            instruction: p.instruction || '', bracket: !!p.bracket
        }));
    }
    if (graduated) return graduatedBatches(pieces, maxBatches);
    const batches = [];
    for (let k = 0; k < pieces.length && batches.length < maxBatches; k += NARRATION_BATCH) {
        batches.push(pieces.slice(k, k + NARRATION_BATCH));
    }
    return batches;
}

/**
 * Text cut into parts of at most `cap` characters: whole sentences joined while they fit, and
 * a sentence longer than the cap cut at its clause breaks (, ; : and dashes). A clause still
 * longer than the cap stays whole -- nothing is cut mid-phrase.
 */
function splitToCap(text, cap) {
    if (text.length <= cap) return [text];
    const units = [];
    for (const s of text.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g) || [text]) {
        if (s.length <= cap) { units.push(s); continue; }
        units.push(...(s.match(/[^,;:—–]+[,;:—–]+\s*|[^,;:—–]+$/g) || [s]));
    }
    const out = [];
    let cur = '';
    for (const u of units) {
        if (cur && cur.length + u.length > cap) { out.push(cur.trim()); cur = ''; }
        cur += u;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(t => /[A-Za-z0-9]/.test(t));
}

/**
 * Batches for the start of a reading, sized so that it starts soon and never stalls.
 *
 * The opening batch holds pieces of at most NARRATION_OPENING_CAP characters, so the first
 * sound waits on a short piece rather than a long paragraph. Each later batch is rendered
 * while the audio before it plays, so its pieces may be only as long as that audio covers:
 * the cap grows with the audio queued ahead of it (`slack`), back up to whole paragraphs.
 * A piece over its batch's cap goes in as its first part; the rest waits for the next batch,
 * whose cap is larger. Estimates err safe: audio at 15 characters a second (Matter runs
 * 12-15), render time as batchRenderEstimate.
 */
function graduatedBatches(pieces, maxBatches) {
    const queue = pieces.slice();
    const batches = [];
    let slack = 0;     // seconds of audio queued ahead of the batch being planned
    while (queue.length && batches.length < maxBatches) {
        const cap = batches.length === 0 ? NARRATION_OPENING_CAP
            : Math.max(NARRATION_OPENING_CAP, Math.min(NARRATION_PIECE_CAP, renderableChars(slack)));
        const batch = [];
        while (queue.length && batch.length < NARRATION_BATCH) {
            const p = queue.shift();
            if (p.text.length <= cap) { batch.push(p); continue; }
            const parts = splitToCap(p.text, cap);
            if (parts.length < 2) { batch.push(p); continue; }
            // Ids are labels for the logs: a paragraph's parts are 20101, 20101.1, 20101.2...
            const base = p.base || p.id, n = p.part || 0;
            batch.push(Object.assign({}, p, { text: parts[0], id: n ? base + '.' + n : base }));
            queue.unshift(Object.assign({}, p, { text: parts.slice(1).join(' '), base: base, part: n + 1, id: base + '.' + (n + 1) }));
        }
        if (batches.length) slack -= batchRenderEstimate(batch);
        slack += batch.reduce((s, p) => s + p.text.length / 15, 0);
        batches.push(batch);
    }
    return batches;
}

/**
 * Seconds of rendering per character of a batch's LONGEST piece -- a batch takes as long as
 * that piece does -- learned from the batches this narrator actually renders and remembered
 * between sessions. A fixed factor went stale twice: 2.2s per second of audio before the CUDA
 * graphs, then half that, and a reader saw "about 14s" for a first passage that took 6.
 * Starts at what this RTX 4070 Ti measured with both graphs: 0.043-0.046 (2026-09-24).
 */
const NARRATION_RATE_KEY = 'narr_render_rate';
let _narrRenderRate = (() => {
    try {
        const v = parseFloat(localStorage.getItem(NARRATION_RATE_KEY));
        if (v > 0.005 && v < 0.5) return v;
    } catch (e) {}
    return 0.045;
})();
const NARRATION_RENDER_MARGIN = 1.15;    // estimates err long by this much; waiting a little beats a gap

/** Seconds the narrator will take over a batch, with the margin: its longest piece decides. */
function batchRenderEstimate(batch) {
    const longest = Math.max.apply(null, batch.map(p => p.text.length));
    return NARRATION_RENDER_MARGIN * _narrRenderRate * longest + 1;
}

/** The longest piece a batch may hold if it must render within `seconds`. */
function renderableChars(seconds) {
    return Math.floor((seconds - 1) / (NARRATION_RENDER_MARGIN * _narrRenderRate));
}

/**
 * Learn from a batch the narrator rendered in full (none of it from the cache, whose answers
 * are instant). Short pieces say little about the rate, so only batches whose longest piece is
 * 40 characters or more count; half the weight goes to the newest, so a change of card or
 * build shows within a batch or two.
 */
function learnRenderRate(batch, seconds) {
    const longest = Math.max.apply(null, batch.map(p => p.text.length));
    if (longest < 40 || !(seconds > 0)) return;
    const seen = Math.min(0.5, Math.max(0.005, (seconds - 1) / longest));
    _narrRenderRate = 0.5 * _narrRenderRate + 0.5 * seen;
    try { localStorage.setItem(NARRATION_RATE_KEY, String(_narrRenderRate)); } catch (e) {}
    narrLog('render rate: this batch ' + seen.toFixed(3) + 's per character of its longest piece; now using ' +
            _narrRenderRate.toFixed(3));
}

/** The first block on screen: both axes, or the pages already turned in Pages count. */
function firstVisibleBlock(all, editor) {
    const host = editor.getBoundingClientRect();
    return all.findIndex(b => {
        const r = b.getBoundingClientRect();
        return r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom
            && r.bottom > 0 && r.top < window.innerHeight;
    });
}

/**
 * Narrate from where the reader is: the start of the paragraph holding the cursor, or the
 * first paragraph on screen. Whole paragraphs, so a cursor mid-paragraph starts at its top.
 *
 * The batch holding that paragraph is requested first and the rest follow in document
 * order, each while the one before is being heard. Anything already rendered -- heard
 * before, or rendered ahead while reading -- comes straight from the cache.
 */
async function startQwenNarration(base) {
    const editor = document.getElementById('editor');
    if (!editor) return;
    // Starting somewhere new stops what was playing and cancels what was still rendering.
    if (isPlaying) stopReading();
    cancelNarrationPrefetch();
    const pending = _qwenPending;
    _qwenPending = null;
    if (pending) { narrateSelection(base, pending); return; }

    const all = readingBlocks();
    if (!all.length) return;

    let at, why, fromCaret = null;
    if (pdfReading()) {
        at = window.tzPdfReadStart();
        why = 'PDF: cursor or first on screen';
        if (at >= 0 && typeof window.tzPdfTextFromCaret === 'function') fromCaret = window.tzPdfTextFromCaret(all[at]);
    } else {
        const caret = readingCaret();
        at = caret ? all.indexOf(caret.block) : -1;
        why = 'cursor';
        if (at >= 0) fromCaret = caret.text;
        if (at < 0) { at = firstVisibleBlock(all, editor); why = 'first on screen'; }
    }
    if (at < 0) { at = 0; why = 'nothing on screen, top'; }

    const startAt = narrationDocIndex(all[at], at);
    const batches = narrationBatches(all, at, 15, true, fromCaret);
    const first = batches.findIndex(b => b.some(p => p.at >= startAt));
    narrLog('---- narrate: start block ' + startAt + ' (' + why + ', DOM position ' + at + ' of ' + all.length +
            '; DOM holds blocks ' + narrationDocIndex(all[0], 0) + '..' + narrationDocIndex(all[all.length - 1], all.length - 1) +
            ', layout ' + (typeof isPaginatedLayout === 'function' && isPaginatedLayout() ? 'pages' : 'scroll') + ')');
    narrLog('batches: ' + batches.length + ', playing from batch ' + first + '; ' +
            batches.map((b, i) => '#' + i + '[' + b[0].at + '..' + b[b.length - 1].at + ', ' + b.length + 'p, max ' +
                Math.max.apply(null, b.map(p => p.text.length)) + 'ch]').join(' '));
    if (first < 0) { narrLog('nothing to narrate from here'); return; }
    const queue = batches.slice(first);
    // Batches begin at the starting block, so this passes everything; it stays so that
    // nothing from before where the reader asked to start can ever be played.
    const playable = chunks => chunks.filter(c => c.at >= startAt);

    const reading = ++_narrationReading;
    _narrationBase = base;
    _narrActive = true;
    _narrSilentSince = 0;
    window.__narrLog = [];
    narrLog('reading ' + reading + ' begins');
    // A batch takes as long as its longest paragraph (see batchRenderEstimate);
    // anything already rendered comes from the cache and the clock just vanishes sooner.
    narrWait('is preparing the first passage', batchRenderEstimate(queue[0]));
    _narrationPending = true;
    const secondsOf = chunks => chunks.reduce((n, c) => n + c.seconds, 0);
    let next = 1;
    try {
        let firstChunks = playable(await renderNarration(base, queue[0], reading));
        // Starting near the end of a group can leave a few seconds to play -- a heading, one
        // short line -- and then a minute of silence while the next group renders: the "one
        // word and it stopped" of the first live test. If what is queued will not last until
        // the next batch is ready, wait for that batch too. One wait before the first word
        // beats a stop after it.
        while (next < queue.length && reading === _narrationReading &&
               secondsOf(firstChunks) < batchRenderEstimate(queue[next])) {
            narrLog('only ' + secondsOf(firstChunks).toFixed(1) + 's to play, batch ' + next + ' needs ~' +
                    batchRenderEstimate(queue[next]).toFixed(0) + 's: waiting for it before the first word');
            if (reading === _narrationReading)
                narrWait('has ' + Math.round(secondsOf(firstChunks)) + 's ready and is preparing the next passage too, so the reading will not stop partway',
                         batchRenderEstimate(queue[next]));
            firstChunks = firstChunks.concat(playable(await renderNarration(base, queue[next], reading)));
            next++;
        }
        if (reading !== _narrationReading) { narrLog('reading ' + reading + ' went stale before its first sound'); return; }
        narrWaitEnd();
        if (!firstChunks.length) throw new Error('nothing came back');
        narrPhase('reading');
        narrLog('first sound: ' + firstChunks.length + ' pieces, ' +
                firstChunks.reduce((n, c) => n + c.seconds, 0).toFixed(1) + 's of audio queued');
        startReadingChunks(firstChunks);
    } catch (err) {
        _narrationPending = false;
        narrLog('narration FAILED before first sound: ' + (err && err.message || err));
        narrWaitEnd();
        narrPhase('');
        showKokoroStatus('Narration failed: ' + (err && err.message || err));
        setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 6000);
        return;
    }

    (async () => {
        try {
            let n = next;
            for (; n < queue.length; n++) {
                // About ninety seconds ahead is plenty; beyond that is work nobody may hear.
                // Except before a batch that will take longer than that to render -- one long
                // paragraph is enough -- which is asked for early enough to arrive in time.
                const ahead = Math.max(90, 1.5 * batchRenderEstimate(queue[n]));
                while (isPlaying && reading === _narrationReading && queuedSeconds() > ahead) {
                    await new Promise(r => setTimeout(r, 500));
                }
                if (!isPlaying || reading !== _narrationReading) {
                    narrLog('render-behind stops before batch ' + n + ': ' + (!isPlaying ? 'not playing' : 'reading ' + reading + ' is stale'));
                    break;
                }
                narrLog('batch ' + n + '/' + (queue.length - 1) + ' requested with ' + queuedSeconds().toFixed(1) + 's queued');
                const chunks = playable(await renderNarration(base, queue[n], reading));
                if (!isPlaying || reading !== _narrationReading) {
                    narrLog('batch ' + n + ' arrived but ' + (!isPlaying ? 'playback had stopped' : 'reading ' + reading + ' is stale'));
                    break;
                }
                for (const c of chunks) _ttsChunks.push(c);
            }
            if (n >= queue.length) narrLog('render-behind finished: all ' + (queue.length - 1) + ' later batches requested');
        } catch (err) {
            narrLog('render-behind FAILED: ' + (err && err.message || err));
        } finally {
            if (reading === _narrationReading) _narrationPending = false;
        }
    })();
}

window.startQwenNarration = startQwenNarration;

/**
 * Read -- the selection and nothing else -- in the narrator's voice. Its pieces are cached
 * like any others, so reading the same passage again is instant.
 */
async function narrateSelection(base, sel) {
    const all = readingBlocks();
    const i = sel.el ? all.indexOf(sel.el) : -1;
    // A word from Look up has no paragraph of its own (startReading).
    const at = sel.el ? narrationDocIndex(sel.el, i < 0 ? 0 : i) : 0;
    const pieces = blockPieces(speakNumbers(sel.text))    // as written but for numbers: see narrationBatches
        .map((t, k) => ({ el: sel.el, at: at, id: at * 100 + 50 + k, text: t, direction: narrationDirection(t, null) }));
    const reading = ++_narrationReading;
    _narrationBase = base;
    _narrActive = true;
    _narrSilentSince = 0;
    window.__narrLog = [];
    narrLog('reading ' + reading + ' begins: the selection, ' + pieces.length + ' pieces');
    let estimate = 0;
    for (let k = 0; k < pieces.length; k += NARRATION_BATCH) estimate += batchRenderEstimate(pieces.slice(k, k + NARRATION_BATCH));
    narrWait('is preparing the selection', estimate);
    try {
        const chunks = [];
        for (let k = 0; k < pieces.length; k += NARRATION_BATCH) {
            chunks.push(...await renderNarration(base, pieces.slice(k, k + NARRATION_BATCH), reading));
            if (reading !== _narrationReading) return;
        }
        narrWaitEnd();
        if (!chunks.length) throw new Error('nothing came back');
        narrPhase('reading');
        startReadingChunks(chunks);
    } catch (err) {
        narrLog('narrating the selection FAILED: ' + (err && err.message || err));
        narrWaitEnd();
        narrPhase('');
        showKokoroStatus('Narration failed: ' + (err && err.message || err));
        setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 6000);
    }
}

/**
 * Render ahead of the reader.
 *
 * Once narration has been used this session the narrator is resident. While the reader
 * turns pages with narration stopped, the group on screen and the one after it are rendered
 * into the cache, so pressing Narrate there starts at once. Bounded on purpose: two groups
 * per settled view, a view change drops whatever has not started, and nothing runs while
 * narration is playing -- that renders ahead by itself. If the narrator has gone (it shuts
 * down after 15 idle minutes) this stops until Narrate is used again, and never starts it.
 */
const PREFETCH_READING_BASE = 1000000000;   // prefetch reading ids never meet play ones
let _prefetchCount = 0;
let _prefetchReading = 0;                    // the prefetch in flight, 0 when none
let _prefetchTimer = null;

function cancelNarrationPrefetch() {
    clearTimeout(_prefetchTimer);
    const reading = _prefetchReading;
    _prefetchReading = 0;
    if (!reading || !_narrationBase) return;
    narrLog('render-ahead ' + reading + ' cancelled');
    try {
        fetch(_narrationBase + '/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reading: reading })
        }).catch(() => {});
    } catch (e) {}
}

async function prefetchNarration() {
    if (!_narrationBase || isPlaying || _narrationPending) return;
    const editor = document.getElementById('editor');
    if (!editor) return;
    const all = readingBlocks();
    const at = !all.length ? -1 : pdfReading() ? window.tzPdfReadStart(true) : firstVisibleBlock(all, editor);
    if (at < 0) return;
    const startAt = narrationDocIndex(all[at], at);
    // Cut exactly as Narrate cuts from here, so starting here finds it all in the cache.
    const batches = narrationBatches(all, at, 2, true);
    const first = batches.findIndex(b => b.some(p => p.at >= startAt));
    if (first < 0) return;

    cancelNarrationPrefetch();
    const reading = _prefetchReading = PREFETCH_READING_BASE + (++_prefetchCount);
    const base = _narrationBase;
    const todo = batches.slice(first);
    narrLog('render-ahead ' + reading + ': view starts at block ' + startAt + ', ' + todo.length + ' batches (blocks ' +
            todo[0][0].at + '..' + todo[todo.length - 1].slice(-1)[0].at + ')');
    for (const batch of todo) {
        if (_prefetchReading !== reading || isPlaying) {
            narrLog('render-ahead ' + reading + ' stops: ' + (isPlaying ? 'narration is playing' : 'the view moved'));
            return;
        }
        try {
            await renderNarration(base, batch, reading);
        } catch (e) {
            narrLog('render-ahead ' + reading + ' lost the narrator; off until Narrate is used again');
            if (_narrationBase === base) _narrationBase = '';
            return;
        }
    }
    narrLog('render-ahead ' + reading + ' done');
    if (_prefetchReading === reading) _prefetchReading = 0;
}

/**
 * Warm-up (the host's WarmNarrator): a book is open with a Qwen voice reading and the narrator
 * is now up, before anyone pressed Read Aloud. Render the passage on screen -- cut exactly as
 * Read Aloud from there will cut it -- so pressing it plays from the cache. From here on,
 * turning pages renders ahead as it does after a first narration. A short delay lets a book
 * that has only just opened settle at its remembered position first.
 */
window.warmNarration = function (base) {
    if (!isQwenVoice(_kokoroVoice) || !base) return;
    _narrationBase = base;
    narrLog('warm-up: narrator is up; rendering the passage on screen ahead of Read Aloud');
    clearTimeout(_prefetchTimer);
    _prefetchTimer = setTimeout(prefetchNarration, 1500);
};

// Scroll does not bubble, so this listens in the capture phase: a page turn in Pages
// scrolls #editor, and the scroll layout scrolls its container. Either way, wait for the
// view to settle before rendering what is on it.
document.addEventListener('scroll', function () {
    if (!_narrationBase || isPlaying) return;
    clearTimeout(_prefetchTimer);
    _prefetchTimer = setTimeout(prefetchNarration, 1200);
}, { capture: true, passive: true });

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

/**
 * The host is about to stop the narrator and delete its audio (Clear Stored Data): end any
 * reading, and stop rendering ahead on page turns until the narrator is started again.
 */
window.stopNarration = function () {
    if (isPlaying) stopReading();
    clearTimeout(_prefetchTimer);
    _narrationBase = '';
};

function stopReading() {
    if (_narrActive) {
        // Who stopped it: the Stop button, a new reading, or the queue running dry.
        let from = '';
        try { from = (new Error().stack || '').split('\n').slice(2, 4).map(s => s.trim().replace(/\(.*\//, '(')).join(' < '); } catch (e) {}
        narrLog('stopReading, ' + _ttsChunks.length + ' chunks dropped; called from ' + from);
        _narrActive = false;
        _narrSilentSince = 0;
        narrWaitEnd();
        narrPhase('');
    }
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

/** Run `fn` once the page is idle after startup, so it never delays the first paint. */
function tzWhenIdleAfterStartup(fn) {
    const later = function () {
        if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 5000 });
        else setTimeout(fn, 2000);
    };
    if (document.readyState === 'complete') setTimeout(later, 1500);
    else window.addEventListener('load', function () { setTimeout(later, 1500); }, { once: true });
}

// The NLP library (compromise, ~350 KB) only splits sentences for read aloud, yet it was a
// <script> in the template and cost an 88 ms frame on every launch (perf log, 2026-09-29).
// Loaded in idle time after startup instead, so it is in place before anyone presses
// Read aloud; until it is, both call sites fall back (typeof window.nlp checks).
tzWhenIdleAfterStartup(function loadNlp() {
    if (typeof window.nlp === 'function' || document.getElementById('tz-nlp')) return;
    const own = document.querySelector('script[src*="09-speech.js"]');
    const query = (own && own.src.indexOf('?') >= 0) ? own.src.slice(own.src.indexOf('?')) : '';
    const s = document.createElement('script');
    s.id = 'tz-nlp';
    s.async = true;
    s.src = 'js/modules/08b-compromise.js' + query;   // same ?v= stamp as the modules
    document.head.appendChild(s);
});

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
        // so it's ready by the time they hit Play. In idle time after startup, not during
        // it: the engine's import cost a 33 ms frame at launch (perf log, 2026-09-29).
        tzWhenIdleAfterStartup(function () {
            if (_kokoroExt && !_isKokoroReady && !_isKokoroInitializing) setupKokoro(true);
        });
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
        if (!silent) showKokoroStatus("Loading the voice model...");
        
        const worker = new Worker('js/kokoro-worker.js', { type: 'module' });
        let pendingGenerate = {};
        let generateIdCounter = 0;

        _kokoroEngine = {
            generate: function(text, options) {
                return new Promise((resolve, reject) => {
                    const id = generateIdCounter++;
                    pendingGenerate[id] = { resolve, reject };
                    worker.postMessage({ type: 'generate', id: id, text: text, voice: options.voice, speed: options.speed });
                });
            }
        };

        await new Promise((resolve, reject) => {
            worker.onmessage = function(e) {
                const data = e.data;
                if (data.type === 'init_done') {
                    resolve();
                } else if (data.type === 'init_error') {
                    reject(new Error(data.error));
                } else if (data.type === 'generate_done') {
                    const p = pendingGenerate[data.id];
                    if (p) {
                        p.resolve({ audio: data.audio, sampling_rate: data.sampling_rate });
                        delete pendingGenerate[data.id];
                    }
                } else if (data.type === 'generate_error') {
                    const p = pendingGenerate[data.id];
                    if (p) {
                        p.reject(new Error(data.error));
                        delete pendingGenerate[data.id];
                    }
                }
            };
            worker.onerror = function(err) {
                reject(err);
            };
            worker.postMessage({ type: 'init', ext: _kokoroExt });
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
/** The Qwen narrator, chosen in File > Read Aloud like any other voice. */
function isQwenVoice(id) { return id === 'qwen_narrator'; }

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
    // The page decides which engine reads, so the host's copy -- the menu ticks and the
    // status bar -- is told of every change, whoever made it.
    try { window.chrome.webview.postMessage("host_kokoro_voice_restored:" + voiceId); } catch (e) {}

    let displayName = friendlyName || voiceId;
    const isAutoReset = (voiceId === 'windows_voice' && friendlyName === 'Windows voice');

    if (isKokoroVoice(voiceId) && !_isKokoroReady) {
        setupKokoro(false, "Kokoro is ready. Voice set to " + displayName + ".");
    } else if (isQwenVoice(voiceId)) {
        // The host starts the narrator on this choice and reports its progress itself.
        showKokoroStatus("Voice set to " + (friendlyName ? friendlyName + ", a Qwen narrator voice" : "the Qwen narrator") +
                         ". Read Aloud, Read and Read from here all use it.");
        setTimeout(() => { document.getElementById('kokoro-status')?.remove(); }, 3000);
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



