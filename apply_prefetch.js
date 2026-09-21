const fs = require('fs');
let code = fs.readFileSync('js/modules/09-speech.js', 'utf8');

// 1. Add cache initialization
code = code.replace(
    'let _kokoroEngine = null;',
    'let _kokoroEngine = null;\nlet _kokoroPrefetchCache = new Map();'
);

// 2. Clear cache in stopReading
code = code.replace(
    '    if (typeof _generationId !== \'undefined\') {',
    '    if (typeof _kokoroPrefetchCache !== \'undefined\') _kokoroPrefetchCache.clear();\n    if (typeof _generationId !== \'undefined\') {'
);

// 3. Update processGenerationQueue to check cache
const pgqOld =         const sentence = _generationQueue.shift();
        try {
            const audio = await _kokoroEngine.generate(sentence, { voice: voice, speed: 1.0 });;
const pgqNew =         const sentence = _generationQueue.shift();
        try {
            let audio;
            if (_kokoroPrefetchCache.has(sentence)) {
                audio = _kokoroPrefetchCache.get(sentence);
                _kokoroPrefetchCache.delete(sentence);
            } else {
                audio = await _kokoroEngine.generate(sentence, { voice: voice, speed: 1.0 });
            };
code = code.replace(pgqOld, pgqNew);

// 4. Update processPlayQueue to trigger prefetch
const ppqOld =     _isPlayingChunk = true;
    const audio = _playQueue.shift();;
const ppqNew =     _isPlayingChunk = true;
    const audio = _playQueue.shift();
    
    if (_playQueue.length === 0 && _generationQueue.length === 0 && isPlaying) {
        prefetchNextKokoro();
    };
code = code.replace(ppqOld, ppqNew);

// 5. Add prefetchNextKokoro function before processGenerationQueue
const prefetchFunc = 
async function prefetchNextKokoro() {
    if (!_ttsChunks || _ttsChunks.length === 0 || !_kokoroEngine || _isGenerating) return;
    const rawText = _ttsChunks[0].text;
    const text = applyTTSOverrides(rawText);
    const regex = /[^.!?\\n]+[.!?\\n]+(?:["'\\u201d\\u2019)\\]]*)(?:\\s|$)|[^.!?\\n]+$/g;
    let sentences = [];
    if (typeof window.nlp === 'function') {
        try { sentences = window.nlp(text).sentences().out('array'); } catch(e) {}
    }
    if (!sentences || sentences.length === 0) sentences = text.match(regex);
    if (!sentences || sentences.length === 0) return;
    
    let currentGroup = "";
    for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i].trim();
        if (s.length === 0 || !/[a-zA-Z0-9]/.test(s)) continue;
        if (currentGroup.length + s.length > 250 && currentGroup.length > 0) break;
        currentGroup = currentGroup.length > 0 ? currentGroup + " " + s : s;
    }
    
    if (currentGroup.length > 0 && !_kokoroPrefetchCache.has(currentGroup)) {
        try {
            _isGenerating = true; 
            const audio = await _kokoroEngine.generate(currentGroup, { voice: _kokoroVoice, speed: 1.0 });
            _kokoroPrefetchCache.set(currentGroup, audio);
            _isGenerating = false;
            if (isPlaying && typeof _generationQueue !== 'undefined' && _generationQueue.length > 0) processGenerationQueue(_generationId, _kokoroVoice);
        } catch(e) { _isGenerating = false; }
    }
}

async function processGenerationQueue;
code = code.replace('async function processGenerationQueue', prefetchFunc);

fs.writeFileSync('js/modules/09-speech.js', code);
console.log('Patched successfully');
