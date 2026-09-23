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
    return batch.map(p => p.id + ':' + p.text.length + 'ch').join(' ');
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
                blocks: batch.map(p => ({ id: p.id, text: p.text })),
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
 * VoiceDesign invents the speaker afresh on every piece it renders, so every piece boundary
 * is a possible change of voice. A paragraph is therefore one piece: one voice for it, and
 * intonation that carries across its sentences. Only a paragraph longer than the cap is
 * split, at sentence ends, never inside a sentence. Cutting pieces short to start sooner is
 * what made the voice change from sentence to sentence; do not bring that back.
 *
 * Batches start where reading starts. The narrator caches each piece on its own and never
 * renders one it already has, so a restart, a replay or a page rendered ahead reuses what
 * exists whichever batch made it. (Batches used to be fixed groups of eight blocks so that
 * a re-render matched the cache exactly. Starting near the end of a group then rendered the
 * whole group, mostly unheard, and waited for the next: 117s to first sound.)
 */
const NARRATION_BATCH = 8;          // pieces the model renders in one call
const NARRATION_PIECE_CAP = 400;    // characters; only longer paragraphs are split

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
 * Up to `maxBatches` batches of pieces, starting with the block all[from]. Each piece carries
 * its block's document index as `at`.
 */
function narrationBatches(all, from, maxBatches) {
    const pieces = [];
    const limit = maxBatches * NARRATION_BATCH;
    for (let i = from; i < all.length && pieces.length < limit; i++) {
        const at = narrationDocIndex(all[i], i);
        const text = applyTTSOverrides((all[i].innerText || '').trim());
        if (!text) continue;
        blockPieces(text).forEach((t, k) => pieces.push({ el: all[i], at: at, id: at * 100 + k, text: t }));
    }
    const batches = [];
    for (let k = 0; k < pieces.length && batches.length < maxBatches; k += NARRATION_BATCH) {
        batches.push(pieces.slice(k, k + NARRATION_BATCH));
    }
    return batches;
}

/**
 * Seconds the narrator will take over a batch. A batch runs as long as its longest piece, at
 * about 2.2s of compute per second of that piece's audio (5.6 steps/s against 12 steps per
 * second of speech, measured 2026-09-23). Audio is estimated at 12 characters a second, the
 * slow end of what Matter measured, so this errs long.
 */
function batchRenderEstimate(batch) {
    const longest = Math.max.apply(null, batch.map(p => p.text.length));
    return 2.3 * longest / 12 + 2;
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
    const batches = narrationBatches(all, at, 15);
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
    showKokoroStatus('Preparing the first passage...');
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
            firstChunks = firstChunks.concat(playable(await renderNarration(base, queue[next], reading)));
            next++;
        }
        document.getElementById('kokoro-status')?.remove();
        if (reading !== _narrationReading) { narrLog('reading ' + reading + ' went stale before its first sound'); return; }
        if (!firstChunks.length) throw new Error('nothing came back');
        narrLog('first sound: ' + firstChunks.length + ' pieces, ' +
                firstChunks.reduce((n, c) => n + c.seconds, 0).toFixed(1) + 's of audio queued');
        startReadingChunks(firstChunks);
    } catch (err) {
        _narrationPending = false;
        narrLog('narration FAILED before first sound: ' + (err && err.message || err));
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
        .map((t, k) => ({ el: sel.el, at: at, id: at * 100 + 50 + k, text: t }));
    const reading = ++_narrationReading;
    _narrationBase = base;
    _narrActive = true;
    _narrSilentSince = 0;
    window.__narrLog = [];
    narrLog('reading ' + reading + ' begins: the selection, ' + pieces.length + ' pieces');
    showKokoroStatus('Preparing the selection...');
    try {
        const chunks = [];
        for (let k = 0; k < pieces.length; k += NARRATION_BATCH) {
            chunks.push(...await renderNarration(base, pieces.slice(k, k + NARRATION_BATCH), reading));
            if (reading !== _narrationReading) return;
        }
        document.getElementById('kokoro-status')?.remove();
        if (!chunks.length) throw new Error('nothing came back');
        startReadingChunks(chunks);
    } catch (err) {
        narrLog('narrating the selection FAILED: ' + (err && err.message || err));
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
    const batches = narrationBatches(all, at, 2);
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

    let displayName = friendlyName || voiceId;
    const isAutoReset = (voiceId === 'windows_voice' && friendlyName === 'Windows voice');

    if (isKokoroVoice(voiceId) && !_isKokoroReady) {
        setupKokoro(false, "Kokoro is ready. Voice set to " + displayName + ".");
    } else if (isQwenVoice(voiceId)) {
        // The host starts the narrator on this choice and reports its progress itself.
        showKokoroStatus("Voice set to the Qwen narrator. Read Aloud, Read and Read from here all use it.");
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



