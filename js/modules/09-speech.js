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
    '</svg> Read aloud';
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

function speakSelection() {
    let textToRead = "";
    if (typeof currentSelectionText === 'function') {
        textToRead = currentSelectionText().trim();
    } else {
        textToRead = window.getSelection().toString().trim();
    }

    if (!textToRead) {
        // Nothing selected: read from the text cursor when there is one, the way Word and
        // screen readers do, with the same reach as before -- the page on screen, the rest
        // of the document. No cursor in the text: from the top, as it always did.
        const caret = readingCaret();
        const sourceEdit = document.getElementById('source-editor');
        if (sourceEdit && window.getComputedStyle(sourceEdit).display !== 'none') {
            textToRead = sourceEdit.value.substring(sourceEdit.selectionStart || 0);
        } else if (typeof isPaginatedLayout === 'function' && isPaginatedLayout()) {
            const editor = document.getElementById('editor');
            if (editor) {
                const host = editor.getBoundingClientRect();
                const blocks = editor.querySelectorAll('.block');
                const visibleText = [];
                let started = !caret;
                for (let i = 0; i < blocks.length; i++) {
                    const rc = blocks[i].getBoundingClientRect();
                    if (rc.right > host.left && rc.left < host.right && rc.bottom > host.top && rc.top < host.bottom) {
                        if (!started && blocks[i] === caret.block) { started = true; visibleText.push(caret.text); continue; }
                        if (started) visibleText.push(blocks[i].innerText);
                    }
                }
                textToRead = visibleText.join('\n\n');
            }
        } else if (typeof DocumentModel !== 'undefined' && typeof DocumentModel.toMarkdown === 'function' && DocumentModel.kind !== 'epub') {
            const idx = caret ? parseInt(caret.block.getAttribute('data-model-index'), 10) : NaN;
            if (caret && isFinite(idx) && DocumentModel.blocks && DocumentModel.blocks[idx]) {
                // Rest of the document from the model, not the page: only the part on
                // screen is built, and reading continues well past it.
                const rest = DocumentModel.blocks.slice(idx + 1).map(b => b.raw || '').filter(Boolean);
                textToRead = [caret.text].concat(rest).join('\n\n');
            } else {
                textToRead = DocumentModel.toMarkdown();
            }
        } else {
            const editor = document.getElementById('editor');
            if (editor) {
                if (caret) {
                    const blocks = Array.from(editor.querySelectorAll('.block'));
                    const at = blocks.indexOf(caret.block);
                    textToRead = [caret.text].concat(blocks.slice(at + 1).map(b => b.innerText)).join('\n\n');
                } else {
                    textToRead = editor.innerText;
                }
            }
        }
    }
    
    if (!textToRead) return;
    
    startReading(textToRead);
}

function startReading(text) {
    if (!text) return;
    
    // SAPI and WinRT both fail or silently truncate if text is too large.
    // Chunking in JS allows unlimited playback lengths.
    const blocks = text.split(/\n{2,}/);
    _ttsChunks = [];
    let currentChunk = "";
    for (let i = 0; i < blocks.length; i++) {
        if (currentChunk.length + blocks[i].length > 30000) {
            if (currentChunk) _ttsChunks.push(currentChunk);
            currentChunk = blocks[i];
        } else {
            currentChunk += (currentChunk ? "\n\n" : "") + blocks[i];
        }
    }
    if (currentChunk) _ttsChunks.push(currentChunk);

    if (_ttsChunks.length > 0) {
        isPlaying = true;
        showReadAloudState();
        playNextChunk();
    }
}

function playNextChunk() {
    if (!isPlaying || _ttsChunks.length === 0) {
        stopReading();
        return;
    }
    const text = _ttsChunks.shift();
    try { 
        window.chrome.webview.postMessage("host_tts_play:" + JSON.stringify({
            text: text
        })); 
    } catch(e){}
}

function stopReading() {
    _ttsChunks = [];
    try { window.chrome.webview.postMessage("host_tts_stop"); } catch(e){}
    isPlaying = false;
    showReadAloudState();
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
