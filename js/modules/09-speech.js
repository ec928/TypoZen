// Native C# WinRT TTS Bridge

let isPlaying = false;

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
    const selPopReadBtn = document.getElementById('selPopRead');
    if (selPopReadBtn) {
        selPopReadBtn.innerHTML = isPlaying ? '<span aria-hidden="true">&#9209;</span> Stop' : '<span aria-hidden="true">&#9654;</span> Play';
    }
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
    const selPopReadBtn = document.getElementById('selPopRead');
    if (selPopReadBtn) selPopReadBtn.innerHTML = '<span aria-hidden="true">&#9209;</span> Stop';
}

function stopReading() {
    isPlaying = false;
    try { window.chrome.webview.postMessage("host_tts_stop"); } catch(e){}
    const selPopReadBtn = document.getElementById('selPopRead');
    if (selPopReadBtn) selPopReadBtn.innerHTML = '<span aria-hidden="true">&#9654;</span> Play';
}

// Called by 03-shell.js when native TTS finishes reading
function nativeTTSFinished() {
    isPlaying = false;
    const selPopReadBtn = document.getElementById('selPopRead');
    if (selPopReadBtn) selPopReadBtn.innerHTML = '<span aria-hidden="true">&#9654;</span> Play';
}

window.addEventListener('load', function() {
    initTTS();
});
