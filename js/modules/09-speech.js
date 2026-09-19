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

function speakSelection() {
    let textToRead = "";
    if (typeof currentSelectionText === 'function') {
        textToRead = currentSelectionText().trim();
    } else {
        textToRead = window.getSelection().toString().trim();
    }
    
    if (!textToRead) {
        const sourceEdit = document.getElementById('source-editor');
        if (sourceEdit && window.getComputedStyle(sourceEdit).display !== 'none') {
            textToRead = sourceEdit.value;
        } else if (typeof isPaginatedLayout === 'function' && isPaginatedLayout()) {
            const editor = document.getElementById('editor');
            if (editor) {
                const host = editor.getBoundingClientRect();
                const blocks = editor.querySelectorAll('.block');
                const visibleText = [];
                for (let i = 0; i < blocks.length; i++) {
                    const rc = blocks[i].getBoundingClientRect();
                    if (rc.right > host.left && rc.left < host.right && rc.bottom > host.top && rc.top < host.bottom) {
                        visibleText.push(blocks[i].innerText);
                    }
                }
                textToRead = visibleText.join('\n\n');
            }
        } else if (typeof DocumentModel !== 'undefined' && typeof DocumentModel.toMarkdown === 'function' && DocumentModel.kind !== 'epub') {
            textToRead = DocumentModel.toMarkdown();
        } else {
            const editor = document.getElementById('editor');
            if (editor) textToRead = editor.innerText;
        }
    }
    
    if (!textToRead) return;
    
    startReading(textToRead);
}

function startReading(text) {
    if (!text) return;
    
    // Send to host for native playback. Host uses its own voice/speed configuration now.
    try { 
        window.chrome.webview.postMessage("host_tts_play:" + JSON.stringify({
            text: text
        })); 
    } catch(e){}
    
    isPlaying = true;
    showReadAloudState();
}

function stopReading() {
    isPlaying = false;
    try { window.chrome.webview.postMessage("host_tts_stop"); } catch(e){}
    showReadAloudState();
}

// Called by 03-shell.js when native TTS finishes reading
function nativeTTSFinished() {
    isPlaying = false;
    showReadAloudState();
}

window.addEventListener('load', function() {
    initTTS();
    showReadAloudState();
});
