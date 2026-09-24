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

    // With the Qwen narrator chosen, every way of starting to read comes here -- Read Aloud,
    // the popover's Read and Read from here -- and goes to the narrator: the selection alone
    // for Read, otherwise from the cursor or the top of the page. The host makes sure the
    // narrator is running and answers with cmd:narrate. Source mode has no rendered blocks
    // to narrate, so it keeps the Windows voice.
    const sourceShown = (() => {
        const s = document.getElementById('source-editor');
        return !!(s && window.getComputedStyle(s).display !== 'none');
    })();
    if (isQwenVoice(_kokoroVoice) && !sourceShown) {
        let el = null;
        try {
            const sel = window.getSelection();
            const node = sel && sel.anchorNode;
            const e = node && (node.nodeType === 1 ? node : node.parentElement);
            el = e && e.closest ? e.closest('#editor .block') : null;
        } catch (e) {}
        _qwenPending = selText && el ? { text: selText, el: el } : null;
        narrLog('read requested: ' + (_qwenPending ? 'the selection, ' + selText.length + ' chars' : 'from here'));
        try { window.chrome.webview.postMessage('host_qwen_narrate'); } catch (e) {}
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
 * narrator's voice, the reader's own style words, the reading speed, and this book's cast --
 * character key to voice id. Sent before every narration and whenever they change.
 */
let _narrVoice = '';
let _narrVoiceName = '';
let _narrStyle = '';
let _narrSpeed = 1;
let _narrCast = {};
window.setNarratorSettings = function (json) {
    try {
        const s = typeof json === 'string' ? JSON.parse(json) : json;
        const before = JSON.stringify([_narrVoice, _narrStyle, _narrCast]);
        _narrVoice = s.voice || '';
        _narrVoiceName = s.voiceName || '';
        _narrStyle = s.style || '';
        _narrSpeed = Math.max(0.5, Math.min(2, parseFloat(s.speed) || 1));
        _narrCast = s.cast || {};
        if (_renderedAudio) _renderedAudio.playbackRate = _narrSpeed;
        // A new voice, style or cast while narrating: start again at the paragraph being read,
        // in the new voice, rather than play out what was already rendered in the old one.
        if (before !== JSON.stringify([_narrVoice, _narrStyle, _narrCast]) && _narrActive && isPlaying) {
            narrLog('settings changed while narrating: restarting at the current paragraph');
            _qwenPending = null;
            try { window.chrome.webview.postMessage('host_qwen_narrate'); } catch (e) {}
        }
        narrLog('settings: voice ' + (_narrVoice || 'default') + ', style ' + (_narrStyle ? _narrStyle.length + ' chars' : 'standard') +
                ', speed ' + _narrSpeed + ', cast ' + Object.keys(_narrCast).length);
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
    _narrTraceOut.push(msg);
    if (_narrTraceTimer) return;
    _narrTraceTimer = setTimeout(() => {
        _narrTraceTimer = null;
        const lines = _narrTraceOut;
        _narrTraceOut = [];
        const base = _narrationBase || 'http://127.0.0.1:8765';
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
                          (p.direction ? '[' + p.direction + ']' : '')).join(' ');
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

/** One request to the sidecar; returns chunks ready for the reading queue. */
async function renderNarration(base, batch, reading) {
    const sent = performance.now();
    narrLog('request reading ' + reading + ': ' + batchSummary(batch));
    let data;
    try {
        const res = await fetch(base + '/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                voice: _narrVoice,
                style: _narrStyle,
                blocks: batch.map(p => ({ id: p.id, text: p.text, direction: p.direction || '',
                                          voice: p.voice || '', role: p.role || 'narration' })),
                reading: reading,
                group_size: batch.length
            })
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
    return batch.map((p, i) => {
        const idx = parseInt(p.el.getAttribute('data-model-index'), 10);
        return {
            idx: isFinite(idx) ? idx : null,
            id: p.id,
            el: p.el,
            at: p.at,
            text: p.text,
            seconds: items[i].seconds || 0,
            audioUrl: 'https://localnarration/' + items[i].file
        };
    });
}

/**
 * How narration is cut up, and why (docs/qwen-tts-plan.md, 3c, 3e and 3g).
 *
 * A paragraph is one piece, so its intonation carries across its sentences. Only a paragraph
 * longer than the cap is split, at sentence ends.
 *
 * Except at the start of a reading. A batch takes about NARRATION_RENDER_FACTOR seconds per second of audio of its
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
 * Direction (docs/qwen-tts-plan.md 4, slice 3): how the spoken lines in a piece should sound,
 * read from the text around them. '' is plain narration, the narrator's standing style.
 *
 * Per paragraph rather than per utterance. Fiction gives each speaker their own paragraph --
 * the line, the "she snapped", the gesture -- so the paragraph is the unit a direction belongs
 * to, and keeping it whole keeps the intonation that runs across its sentences. Cutting out
 * "he said." to voice it apart would lose that and leave fragments too short to sound right.
 *
 * Heuristics first, as the plan says; a language model reading the scene is the upgrade if
 * these prove the ceiling. The verb or adverb that tags a line decides; failing those, the
 * line's own punctuation. Only outside the quotes, so a character saying "whispered" is not a
 * whisper.
 */
const DIRECTION_VERBS = [
    [/\b(shout|shouted|shouting|yell|yelled|roar|roared|bellow|bellowed|scream|screamed|cried out)\b/i, 'shouted, loud and forceful'],
    [/\b(whisper|whispered|whispering|murmur|murmured)\b/i, 'whispered, hushed'],
    [/\b(snap|snapped|bark|barked|spat|growl|growled|hiss|hissed|snarl|snarled)\b/i, 'sharp and angry'],
    [/\b(mutter|muttered|grumble|grumbled)\b/i, 'muttered, low and grudging'],
    [/\b(laugh|laughed|laughing|chuckle|chuckled|giggle|giggled)\b/i, 'amused, with a smile in the voice'],
    [/\b(sob|sobbed|sobbing|wept)\b/i, 'tearful, the voice breaking'],
    [/\b(sigh|sighed)\b/i, 'weary, with a sigh'],
    [/\b(plead|pleaded|beg|begged|implored)\b/i, 'pleading, earnest'],
    [/\b(gasp|gasped)\b/i, 'breathless, shocked'],
    [/\b(demand|demanded|insisted)\b/i, 'insistent'],
    [/\b(stammer|stammered|stuttered)\b/i, 'hesitant, stumbling']
];
const DIRECTION_ADVERBS = [
    [/\b(quietly|softly|gently)\b/i, 'quiet and soft'],
    [/\b(angrily|furiously|savagely)\b/i, 'angry'],
    [/\b(coldly|icily|flatly)\b/i, 'cold and clipped'],
    [/\b(dryly|drily|wryly)\b/i, 'dry and understated'],
    [/\b(sadly|mournfully|miserably)\b/i, 'sad'],
    [/\b(nervously|anxiously|uneasily)\b/i, 'nervous'],
    [/\b(excitedly|eagerly)\b/i, 'excited'],
    [/\b(wearily|tiredly)\b/i, 'weary'],
    [/\b(sarcastically|mockingly)\b/i, 'sarcastic'],
    [/\b(urgently|hurriedly)\b/i, 'urgent']
];

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
    const SPEECH = /^\s*(\S+\s+){0,3}?(said|asked|replied|protested|continued|began|added|told|cried|called|answered|admitted|agreed|whispered|murmured|muttered|shouted|yelled|snapped|hissed|laughed|sighed|gasped|wept|sobbed|pleaded|begged|demanded|insisted|stammered|growled|barked|roared|screamed)\b/i;
    const tags = [];
    const re = /[“"][^”"]+[”"]/g;
    let m;
    while ((m = re.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 60), m.index).split(/[.!?…”"]\s/).pop();
        if (/[,:]\s*$/.test(before)) tags.push(before);
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60).split(/[.!?…“"]/)[0];
        if (/^\s*[a-z]/.test(after) || SPEECH.test(after)) tags.push(after);
    }
    const outside = tags.join(' | ');
    const found = [];
    for (const [re2, words] of DIRECTION_VERBS) { if (re2.test(outside)) { found.push(words); break; } }
    for (const [re2, words] of DIRECTION_ADVERBS) { if (re2.test(outside)) { found.push(words); break; } }
    if (!found.length) {
        const spoken = quotes.join(' ');
        if (/!/.test(spoken)) found.push('emphatic');
        else if (/(—|–|\.\.\.|…)\s*[”"]/.test(spoken)) found.push('breaking off');
    }
    return found.join(', ');
}

/**
 * Cast (slice 4): who speaks each quotation, from its tag -- '"...," Ferbin protested',
 * 'said the drone', '"..." he said' -- so that a character given a voice of their own in this
 * book's cast speaks their lines while the narrator reads everything else.
 *
 * A character is keyed by the last word of their name, lower case: "tyl Loesp" and "Loesp"
 * are one person, "the King" is "king". A pronoun only resolves when the paragraph names
 * exactly one known speaker; otherwise the line stays with the narrator, which never sounds
 * wrong, where a line in the wrong character's voice would. An untagged line in an unbroken
 * run of dialogue goes to whoever spoke two paragraphs before.
 */
const SPEECH_VERB = 'said|says|asked|replied|protested|continued|began|added|told|cried|called|answered|admitted|agreed|' +
    'whispered|murmured|muttered|shouted|yelled|snapped|hissed|laughed|sighed|gasped|wept|sobbed|pleaded|begged|' +
    'demanded|insisted|stammered|growled|barked|roared|screamed|announced|explained|observed|remarked|suggested|' +
    'warned|retorted|exclaimed|responded|conceded|repeated|interrupted|breathed';
const SPEAKER = "(?:the\\s+)?(?:[a-z]{2,4}\\s+)?[A-Z][\\w’'-]+(?:\\s+[A-Z][\\w’'-]+)?|the\\s+[a-z]+";
const TAG_SPEAKER_VERB = new RegExp('^[\\s,]*(' + SPEAKER + '|he|she|it|they|I)\\s+(?:[a-z]+ly\\s+)?(?:' + SPEECH_VERB + ')\\b');
const TAG_VERB_SPEAKER = new RegExp('^[\\s,]*(?:' + SPEECH_VERB + ')\\s+(' + SPEAKER + ')\\b');
const TAG_BEFORE_QUOTE = new RegExp('(' + SPEAKER + ')\\s+(?:[a-z]+ly\\s+)?(?:' + SPEECH_VERB + ')[^.!?]*[,:]\\s*$');

function speakerKey(who) {
    if (!who || /^(he|she|it|they|i)$/i.test(who)) return '';
    return who.replace(/^the\s+/i, '').trim().split(/\s+/).pop().replace(/[’']s$/, '').toLowerCase();
}

/** The quotations in a paragraph, each with its tag and the speaker the tag names, if any. */
function narrationQuotes(text) {
    const out = [];
    const re = /[“"]([^”"]+)[”"]/g;
    let m;
    while ((m = re.exec(text))) {
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
        const before = text.slice(Math.max(0, m.index - 80), m.index);
        let who = null, tag = '', t;
        if ((t = TAG_SPEAKER_VERB.exec(after) || TAG_VERB_SPEAKER.exec(after))) {
            who = t[1]; tag = after.split(/[.!?…“"]/)[0];
        } else if ((t = TAG_BEFORE_QUOTE.exec(before))) {
            who = t[1]; tag = before.split(/[.!?…”"]\s/).pop();
        }
        out.push({ start: m.index, end: m.index + m[0].length, inner: m[1], who: who, tag: tag, key: speakerKey(who) });
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

/** Speaker keys named outright (not by pronoun) anywhere in the loaded book. */
function knownSpeakers(all) {
    const known = new Set();
    for (const el of all) {
        const t = el.innerText || '';
        if (!/[“"]/.test(t)) continue;
        for (const q of narrationQuotes(t)) if (q.key) known.add(q.key);
    }
    return known;
}

/**
 * The characters in the loaded book with how many lines each speaks, for the cast list in
 * Narrator settings. Sent to the host as host_narrator_cast.
 */
window.narrationCastScan = function () {
    const all = Array.from(document.querySelectorAll('#editor .block'));
    const known = knownSpeakers(all);
    const texts = all.map(el => (el.innerText || '').trim());
    const counts = {}, names = {};
    attributeParagraphs(texts, known).forEach(qs => qs.forEach(q => {
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
    narrLog('cast scan: ' + list.length + ' characters over ' + all.length + ' blocks');
    try { window.chrome.webview.postMessage('host_narrator_cast:' + JSON.stringify(list)); } catch (e) {}
    return list;
};

/** A cast line's own direction: its tag's verb or adverb, else its punctuation. */
function quoteDirection(q) {
    const found = [];
    for (const [re, words] of DIRECTION_VERBS) { if (re.test(q.tag || '')) { found.push(words); break; } }
    for (const [re, words] of DIRECTION_ADVERBS) { if (re.test(q.tag || '')) { found.push(words); break; } }
    if (!found.length) {
        if (/!/.test(q.inner)) found.push('emphatic');
        else if (/(—|–|\.\.\.|…)\s*$/.test(q.inner)) found.push('breaking off');
    }
    return found.join(', ');
}

/**
 * A paragraph cut between voices: each line of a cast character in their voice, and the
 * narration around them -- including lines by characters with no voice of their own -- in
 * the narrator's.
 */
function castPieces(text, quotes) {
    const out = [];
    let cursor = 0, narr = '';
    const flush = () => {
        const t = narr.trim();
        if (/[A-Za-z0-9]/.test(t)) blockPieces(t).forEach(p => out.push({ role: 'narration', text: p, direction: narrationDirection(p, null) }));
        narr = '';
    };
    for (const q of quotes) {
        const voice = q.key && _narrCast[q.key];
        if (!voice) continue;
        narr += text.slice(cursor, q.start);
        flush();
        blockPieces(q.inner.trim()).forEach(p => out.push({ role: 'dialogue', text: p, voice: voice, direction: quoteDirection(q), speaker: q.key }));
        cursor = q.end;
    }
    narr += text.slice(cursor);
    flush();
    return out;
}

/**
 * Up to `maxBatches` batches of pieces, starting with the block all[from]. Each piece carries
 * its block's document index as `at`, and its direction; with a cast, a paragraph where a
 * cast character speaks is cut between their voice and the narrator's.
 */
function narrationBatches(all, from, maxBatches, graduated) {
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
            .map(el => applyTTSOverrides((el.innerText || '').trim()));
        speakers = attributeParagraphs(texts, known);
    }
    for (let i = from; i < all.length && pieces.length < limit; i++) {
        const at = narrationDocIndex(all[i], i);
        const text = applyTTSOverrides((all[i].innerText || '').trim());
        if (!text) continue;
        const quotes = speakers && speakers[i - first];
        if (quotes && quotes.some(q => q.key && _narrCast[q.key])) {
            castPieces(text, quotes).forEach((p, k) => pieces.push(Object.assign({ el: all[i], at: at, id: at * 100 + k }, p)));
            continue;
        }
        blockPieces(text).forEach((t, k) => pieces.push({
            el: all[i], at: at, id: at * 100 + k, text: t, direction: narrationDirection(t, all[i])
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
            : Math.max(NARRATION_OPENING_CAP, Math.min(NARRATION_PIECE_CAP, Math.floor((slack - 2) / NARRATION_RENDER_FACTOR * 12)));
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
 * Seconds of rendering per second of audio in a batch's LONGEST piece. It was 2.2 (measured
 * over 26 batches, 2026-09-23); with the code predictor as a CUDA graph it is 1.04-1.15
 * (2026-09-24), so 1.3 errs safe.
 */
const NARRATION_RENDER_FACTOR = 1.3;

/**
 * Seconds the narrator will take over a batch: as long as its longest piece takes. Audio is
 * estimated at 12 characters a second, the slow end of what Matter measured, so this errs long.
 */
function batchRenderEstimate(batch) {
    const longest = Math.max.apply(null, batch.map(p => p.text.length));
    return NARRATION_RENDER_FACTOR * longest / 12 + 2;
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

    const all = Array.from(editor.querySelectorAll('.block'));
    if (!all.length) return;

    const caret = readingCaret();
    let at = caret ? all.indexOf(caret.block) : -1;
    let why = 'cursor';
    if (at < 0) { at = firstVisibleBlock(all, editor); why = 'first on screen'; }
    if (at < 0) { at = 0; why = 'nothing on screen, top'; }

    const startAt = narrationDocIndex(all[at], at);
    const batches = narrationBatches(all, at, 15, true);
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
    // A batch takes as long as its longest paragraph (NARRATION_RENDER_FACTOR per second of its audio);
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
    const all = Array.from(document.querySelectorAll('#editor .block'));
    const i = all.indexOf(sel.el);
    const at = narrationDocIndex(sel.el, i < 0 ? 0 : i);
    const pieces = blockPieces(applyTTSOverrides(sel.text))
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
    const all = Array.from(editor.querySelectorAll('.block'));
    const at = all.length ? firstVisibleBlock(all, editor) : -1;
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



