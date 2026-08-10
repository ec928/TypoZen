// TypoZen module: 04b-format.js
// Classic script; shares page globals. Load order: js/modules/load-order.json.

        // --- Inline selection → Markdown (bold / italic / code / link) ---
        let _inlineSelCache = null; // { block, start, end, text }
        /** Source textarea selection frozen for toolbar (WPF steals focus → selection collapses). */
        let _sourceFormatSel = null; // { start, end }

        function rememberSourceFormatSelection() {
            if (!sourceEditor || state.mode !== 'source') return;
            try {
                const a = sourceEditor.selectionStart | 0;
                const b = sourceEditor.selectionEnd | 0;
                if (a !== b) _sourceFormatSel = { start: Math.min(a, b), end: Math.max(a, b) };
            } catch (e) {}
        }

        function takeSourceFormatSelection() {
            let start = 0, end = 0;
            try {
                start = sourceEditor.selectionStart | 0;
                end = sourceEditor.selectionEnd | 0;
            } catch (e) {}
            // Toolbar focus-steal often collapses to a caret; prefer last non-empty range
            if (start === end && _sourceFormatSel
                && _sourceFormatSel.start !== _sourceFormatSel.end) {
                start = _sourceFormatSel.start | 0;
                end = _sourceFormatSel.end | 0;
            }
            if (start > end) { const t = start; start = end; end = t; }
            return { start: start, end: end };
        }

        /**
         * setRangeText / setSelectionRange often scrolls the caret into view (≈1–2 lines).
         * Preserve scroll so multi-line bold does not disorient mid-document.
         */
        function withSourceScrollPreserved(fn) {
            if (!sourceEditor) { try { return fn(); } catch (e0) { return; } }
            let st = 0, sl = 0;
            try {
                st = sourceEditor.scrollTop || 0;
                sl = sourceEditor.scrollLeft || 0;
            } catch (e1) {}
            let result;
            try { result = fn(); } catch (e2) { result = undefined; }
            function pin() {
                try {
                    sourceEditor.scrollTop = st;
                    sourceEditor.scrollLeft = sl;
                } catch (e3) {}
            }
            pin();
            try { requestAnimationFrame(pin); } catch (e4) { setTimeout(pin, 0); }
            return result;
        }

        function sourceSetRangeTextPreserveScroll(text, start, end, selectMode) {
            withSourceScrollPreserved(function () {
                sourceEditor.setRangeText(text, start, end, selectMode || 'select');
            });
        }

        /** Map visible plain-text offsets to indices in Markdown raw (skip emphasis/link markers). */
        /**
         * Map visible plain-text offsets [plainStart, plainEnd) → raw markdown slice.
         * Skips emphasis/code/link markers so "hybrid" inside **hybrid** maps to the word only.
         */
        function plainRangeToRawOffsets(raw, plainStart, plainEnd) {
            raw = String(raw || '');
            if (plainStart > plainEnd) {
                const t = plainStart; plainStart = plainEnd; plainEnd = t;
            }
            plainStart = Math.max(0, plainStart | 0);
            plainEnd = Math.max(0, plainEnd | 0);

            let i = 0;
            let plain = 0;
            let rStart = null;
            let rEnd = null;

            function skipMarkersOnly() {
                if (i >= raw.length) return false;
                // Strikethrough before single ~ (GFM ~~)
                if (i + 1 < raw.length && raw[i] === '~' && raw[i + 1] === '~') {
                    i += 2;
                    return true;
                }
                if (i + 1 < raw.length && ((raw[i] === '*' && raw[i + 1] === '*') || (raw[i] === '_' && raw[i + 1] === '_'))) {
                    i += 2;
                    return true;
                }
                if (raw[i] === '*' || raw[i] === '_') {
                    i += 1;
                    return true;
                }
                // Opening ` or [ handled below as structured spans (inner text is plain)
                return false;
            }

            function consumeCodeOrLink() {
                if (i >= raw.length) return false;
                if (raw[i] === '`') {
                    i += 1;
                    while (i < raw.length && raw[i] !== '`') {
                        if (rStart === null && plain === plainStart) rStart = i;
                        if (rEnd === null && plain === plainEnd) rEnd = i;
                        if (rStart !== null && rEnd !== null) return true;
                        i++;
                        plain++;
                        if (rEnd === null && plain === plainEnd) rEnd = i;
                    }
                    if (i < raw.length) i += 1;
                    return true;
                }
                if (raw[i] === '[') {
                    const closeB = raw.indexOf(']', i);
                    const openP = closeB >= 0 ? raw.indexOf('(', closeB) : -1;
                    const closeP = openP === closeB + 1 ? raw.indexOf(')', openP) : -1;
                    if (closeB > i && openP === closeB + 1 && closeP > openP) {
                        i += 1;
                        while (i < closeB) {
                            if (rStart === null && plain === plainStart) rStart = i;
                            if (rEnd === null && plain === plainEnd) rEnd = i;
                            if (rStart !== null && rEnd !== null) return true;
                            i++;
                            plain++;
                            if (rEnd === null && plain === plainEnd) rEnd = i;
                        }
                        i = closeP + 1;
                        return true;
                    }
                }
                return false;
            }

            while (i < raw.length && (rStart === null || rEnd === null)) {
                // Skip pure markers first so rStart never lands on **
                while (skipMarkersOnly()) {}
                if (consumeCodeOrLink()) {
                    if (rStart !== null && rEnd !== null) break;
                    continue;
                }
                if (i >= raw.length) break;

                // i is at a visible character
                if (rStart === null && plain === plainStart) rStart = i;
                if (rEnd === null && plain === plainEnd) rEnd = i;
                if (rStart !== null && rEnd !== null) break;

                i++;
                plain++;
                if (rEnd === null && plain === plainEnd) rEnd = i;
            }

            if (rStart === null) rStart = plainStart <= 0 ? 0 : raw.length;
            if (rEnd === null) rEnd = plainEnd >= plain ? raw.length : rStart;
            return { r0: Math.min(rStart, rEnd), r1: Math.max(rStart, rEnd), plainLength: plain };
        }

        function getPlainOffsetsInBlock(block) {
            if (!block) return null;
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && !sel.isCollapsed
                && block.contains(sel.anchorNode) && block.contains(sel.focusNode)) {
                try {
                    const range = sel.getRangeAt(0);
                    const pre = document.createRange();
                    pre.selectNodeContents(block);
                    pre.setEnd(range.startContainer, range.startOffset);
                    const start = pre.toString().length;
                    const end = start + range.toString().length;
                    return { start: start, end: end, text: range.toString() };
                } catch (e) {}
            }
            if (_inlineSelCache && _inlineSelCache.block === block)
                return { start: _inlineSelCache.start, end: _inlineSelCache.end, text: _inlineSelCache.text };
            return null;
        }

        function cacheInlineSelection() {
            if (state.mode === 'source') return;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || sel.isCollapsed) return;
            if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;
            const block = getAncestorBlock(sel.anchorNode);
            if (!block || !block.contains(sel.focusNode)) return;
            const off = getPlainOffsetsInBlock(block);
            if (off && off.start !== off.end) {
                _inlineSelCache = { block: block, start: off.start, end: off.end, text: off.text };
            }
        }

        /**
         * Parse inline markdown → plain text + per-character mark flags.
         * Uses parseInline HTML so Preview and the toggle model share one truth.
         */
        function plainAndMarksFromMarkdown(body) {
            body = String(body == null ? '' : body);
            const htmlStr = typeof parseInline === 'function' ? parseInline(body) : body;
            const plainChars = [];
            const marks = [];
            try {
                if (typeof document !== 'undefined' && document.createElement) {
                    const div = document.createElement('div');
                    div.innerHTML = htmlStr;
                    function walk(node, st) {
                        if (!node) return;
                        if (node.nodeType === 3) {
                            const t = String(node.nodeValue || '');
                            for (let i = 0; i < t.length; i++) {
                                const ch = t.charAt(i);
                                if (ch === '​') continue;
                                plainChars.push(ch);
                                marks.push({
                                    bold: !!st.bold,
                                    italic: !!st.italic,
                                    strike: !!st.strike
                                });
                            }
                            return;
                        }
                        if (node.nodeType !== 1) return;
                        const tag = (node.tagName || '').toLowerCase();
                        const next = {
                            bold: st.bold || tag === 'strong' || tag === 'b',
                            italic: st.italic || tag === 'em' || tag === 'i',
                            strike: st.strike || tag === 'del' || tag === 's' || tag === 'strike'
                        };
                        const kids = node.childNodes;
                        for (let k = 0; k < kids.length; k++) walk(kids[k], next);
                    }
                    walk(div, { bold: false, italic: false, strike: false });
                    const plainJoined = plainChars.join('');
                    for (let i = 0; i < plainJoined.length; i++) {
                        if (/\s/.test(plainJoined.charAt(i))) {
                            marks[i] = { bold: false, italic: false, strike: false };
                        }
                    }
                    return { plain: plainJoined, marks: marks, html: htmlStr };
                }
            } catch (eDom) {}
            const stripped = String(htmlStr).replace(/<[^>]+>/g, '');
            for (let i = 0; i < stripped.length; i++) {
                plainChars.push(stripped.charAt(i));
                marks.push({ bold: false, italic: false, strike: false });
            }
            return { plain: plainChars.join(''), marks: marks, html: htmlStr };
        }

        /**
         * Emit clean inline markdown from plain text + per-character marks.
         * bold+italic uses **_text_** so adjacent runs do not glue into ***** soup.
         */
        function emitInlineMarkdownFromMarks(plain, marks) {
            plain = String(plain == null ? '' : plain);
            if (!marks || !marks.length) return plain;
            function same(a, b) {
                return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike;
            }
            function wrapRun(text, m) {
                if (!text) return '';
                // parseInline requires markers to hug non-space (\S). Keep leading/trailing
                // spaces outside markers so "hello " / " hi" never produce **hello **.
                if (!/\S/.test(text)) return text;
                const lead = (text.match(/^\s*/) || [''])[0];
                const trail = (text.match(/\s*$/) || [''])[0];
                const core = text.slice(lead.length, text.length - trail.length);
                if (!core) return text;
                let s = core;
                if (m.bold && m.italic) s = '***' + s + '***';
                else if (m.bold) s = '**' + s + '**';
                else if (m.italic) s = '*' + s + '*';
                if (m.strike) s = '~~' + s + '~~';
                return lead + s + trail;
            }
            let out = '';
            let i = 0;
            let prevPiece = '';
            while (i < plain.length) {
                const m = marks[i] || { bold: false, italic: false, strike: false };
                let j = i + 1;
                while (j < plain.length && same(marks[j] || {}, m)) j++;
                let piece = wrapRun(plain.slice(i, j), m);
                // Prevent **aa*****bb*** glue across runs (ZWSP skipped on decode).
                if (prevPiece && /[*~]$/.test(prevPiece) && /^[*~]/.test(piece)) {
                    out += '​';
                }
                out += piece;
                prevPiece = piece;
                i = j;
            }
            return out;
        }

        /**
         * Wrap/toggle inline mark around a plain-text range inside one block's Markdown.
         * Bold/italic/strike: decode → toggle per-character marks → emit clean markdown
         * (no marker-soup surgery). Prefixes (# / > / - / 1.) preserved; offsets are plain.
         */
        function applyInlineFormatToRaw(raw, plainStart, plainEnd, type) {
            raw = String(raw || '');
            if (plainStart > plainEnd) {
                const t = plainStart; plainStart = plainEnd; plainEnd = t;
            }
            const pref = raw.match(/^(#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]?\]\s+)?|\d+\.\s+)/);
            const prefix = pref ? pref[0] : '';
            const body = raw.slice(prefix.length);

            function withPrefix(newBody) { return prefix + newBody; }

            if (type === 'bold' || type === 'italic' || type === 'strike') {
                const pm = plainAndMarksFromMarkdown(body);
                const n = pm.plain.length;
                let a = Math.max(0, plainStart | 0);
                let b = Math.max(0, plainEnd | 0);
                if (a > n) a = n;
                if (b > n) b = n;
                if (a > b) { const t = a; a = b; b = t; }

                if (a === b) {
                    const left = emitInlineMarkdownFromMarks(pm.plain.slice(0, a), pm.marks.slice(0, a));
                    const right = emitInlineMarkdownFromMarks(pm.plain.slice(a), pm.marks.slice(a));
                    const empty = type === 'bold' ? '****' : type === 'italic' ? '**' : '~~~~';
                    return withPrefix(left + empty + right);
                }

                const flag = type;
                // Only non-space characters participate (spaces never carry marks).
                const idxs = [];
                for (let i = a; i < b; i++) {
                    if (i < pm.plain.length && !/\s/.test(pm.plain.charAt(i))) idxs.push(i);
                }
                let allOn = idxs.length > 0;
                for (let i = 0; i < idxs.length; i++) {
                    const ix = idxs[i];
                    if (!pm.marks[ix] || !pm.marks[ix][flag]) { allOn = false; break; }
                }
                for (let i = 0; i < idxs.length; i++) {
                    const ix = idxs[i];
                    if (!pm.marks[ix]) pm.marks[ix] = { bold: false, italic: false, strike: false };
                    pm.marks[ix][flag] = !allOn;
                }
                // Whitespace cannot carry emphasis through parseInline — drop flags on spaces.
                for (let i = 0; i < pm.plain.length; i++) {
                    if (/\s/.test(pm.plain.charAt(i))) {
                        pm.marks[i] = { bold: false, italic: false, strike: false };
                    }
                }
                return withPrefix(emitInlineMarkdownFromMarks(pm.plain, pm.marks));
            }

            const offs = plainRangeToRawOffsets(body, plainStart, plainEnd);
            const r0 = offs.r0, r1 = offs.r1;

            if (type === 'link') {
                let inner = body.slice(r0, r1) || 'Link Text';
                const m = inner.match(/^\[([^\]]*)\]\([^)]*\)$/);
                if (m) return withPrefix(body.slice(0, r0) + m[1] + body.slice(r1));
                return withPrefix(body.slice(0, r0) + '[' + inner + '](https://)' + body.slice(r1));
            }

            if (type === 'code') {
                if (plainStart === plainEnd) {
                    return withPrefix(body.slice(0, r0) + '``' + body.slice(r0));
                }
                let inner = body.slice(r0, r1);
                if (/^`([\s\S]*)`$/.test(inner)) {
                    return withPrefix(body.slice(0, r0) + inner.replace(/^`([\s\S]*)`$/, '$1') + body.slice(r1));
                }
                if (r0 >= 1 && body[r0 - 1] === '`' && body[r1] === '`') {
                    return withPrefix(body.slice(0, r0 - 1) + inner + body.slice(r1 + 1));
                }
                return withPrefix(body.slice(0, r0) + '`' + inner + '`' + body.slice(r1));
            }

            return null;
        }

        function tryApplyInlineFormat(type) {
            if (type !== 'bold' && type !== 'italic' && type !== 'code' && type !== 'link' && type !== 'strike') return false;

            // Source mode
            if (state.mode === 'source') {
                if (!sourceEditor) return false;
                const range = takeSourceFormatSelection();
                let start = range.start;
                let end = range.end;
                const full = sourceEditor.value || '';

                if (start === end && type !== 'link') {
                    const markers = type === 'bold' ? '****' : type === 'italic' ? '**' : type === 'strike' ? '~~~~' : '``';
                    const mid = (type === 'bold' || type === 'strike') ? 2 : 1;
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(markers, start, end, 'end');
                    withSourceScrollPreserved(function () {
                        sourceEditor.setSelectionRange(start + mid, start + mid);
                    });
                    resizeSourceEditor();
                    updateStats();
                    HistoryManager.commitEdit();
                    return true;
                }

                // Multi-line: format each hard line (never wrap the whole span in one **…**).
                // Cross-line **…** splits across blocks and produces marker soup like r**ow 2001*.
                if (full.slice(start, end).indexOf('\n') >= 0
                    && (type === 'bold' || type === 'italic' || type === 'strike' || type === 'code')) {
                    let s = start;
                    let e = end;
                    while (s > 0 && full.charAt(s - 1) !== '\n') s--;
                    while (e < full.length && full.charAt(e) !== '\n') e++;
                    const lines = full.substring(s, e).split('\n');
                    const out = lines.map(function (line) {
                        if (!String(line).trim()) return line;
                        return transformRawForFormat(line, type, {});
                    }).join('\n');
                    HistoryManager.beginEdit();
                    // Keep scroll pin: setRangeText('select') otherwise jumps ~1–2 lines
                    sourceSetRangeTextPreserveScroll(out, s, e, 'select');
                    try { _sourceFormatSel = { start: s, end: s + out.length }; } catch (eF) {}
                    resizeSourceEditor();
                    // resize can also nudge; re-pin once more after layout
                    withSourceScrollPreserved(function () {});
                    updateStats();
                    HistoryManager.commitEdit();
                    return true;
                }

                let open = '', close = '';
                if (type === 'bold') { open = '**'; close = '**'; }
                else if (type === 'italic') { open = '*'; close = '*'; }
                else if (type === 'code') { open = '`'; close = '`'; }
                else if (type === 'strike') { open = '~~'; close = '~~'; }
                else if (type === 'link') {
                    const inner = full.slice(start, end) || 'Link Text';
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll('[' + inner + '](https://)', start, end, 'select');
                    resizeSourceEditor();
                    updateStats();
                    HistoryManager.commitEdit();
                    return true;
                }
                let inner = full.slice(start, end);
                let rep;
                if (type === 'bold' && /^\*\*([\s\S]*)\*\*$/.test(inner))
                    rep = inner.replace(/^\*\*([\s\S]*)\*\*$/, '$1');
                else if (type === 'italic' && /^\*([\s\S]*)\*$/.test(inner) && !/^\*\*/.test(inner))
                    rep = inner.replace(/^\*([\s\S]*)\*$/, '$1');
                else if (type === 'code' && /^`([\s\S]*)`$/.test(inner))
                    rep = inner.replace(/^`([\s\S]*)`$/, '$1');
                else if (type === 'strike' && /^~~([\s\S]*)~~$/.test(inner))
                    rep = inner.replace(/^~~([\s\S]*)~~$/, '$1');
                else if (type === 'bold' && start >= 2 && full.slice(start - 2, start) === '**' && full.slice(end, end + 2) === '**') {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 2, end + 2, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    return true;
                } else if (type === 'strike' && start >= 2 && full.slice(start - 2, start) === '~~' && full.slice(end, end + 2) === '~~') {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 2, end + 2, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    return true;
                } else if (type === 'italic' && start >= 1 && full[start - 1] === '*' && full[end] === '*'
                    && (start < 2 || full[start - 2] !== '*') && full[end + 1] !== '*') {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 1, end + 1, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    return true;
                } else if (type === 'bold' || type === 'italic' || type === 'strike') {
                    // Single-line partial: marks model on that hard line only
                    let lineStart = start;
                    while (lineStart > 0 && full.charAt(lineStart - 1) !== '\n') lineStart--;
                    let lineEnd = start;
                    while (lineEnd < full.length && full.charAt(lineEnd) !== '\n') lineEnd++;
                    const line = full.slice(lineStart, lineEnd);
                    const rawNext = applyInlineFormatToRaw(line, start - lineStart, end - lineStart, type);
                    if (rawNext != null) {
                        HistoryManager.beginEdit();
                        sourceSetRangeTextPreserveScroll(rawNext, lineStart, lineEnd, 'select');
                        resizeSourceEditor();
                        updateStats();
                        HistoryManager.commitEdit();
                        return true;
                    }
                    rep = open + inner + close;
                } else {
                    rep = open + inner + close;
                }
                HistoryManager.beginEdit();
                sourceSetRangeTextPreserveScroll(rep, start, end, 'select');
                resizeSourceEditor();
                updateStats();
                HistoryManager.commitEdit();
                return true;
            }

            // Live Preview: multi-block whole-line inline first
            const multiIdx = getSelectedBlockIndices();
            if (multiIdx.length > 1
                && (type === 'bold' || type === 'italic' || type === 'strike' || type === 'code')) {
                applyFormatInPlaceToSelection(type, false, false);
                return true;
            }

            // Live Preview: single block + partial selection
            let block = null;
            let offsets = null;
            if (_inlineSelCache && _inlineSelCache.block && editor.contains(_inlineSelCache.block)
                && _inlineSelCache.start !== _inlineSelCache.end) {
                block = _inlineSelCache.block;
                offsets = { start: _inlineSelCache.start, end: _inlineSelCache.end, text: _inlineSelCache.text };
            } else {
                const targets = getSelectedBlocks();
                if (targets.length === 1) {
                    block = targets[0];
                    offsets = getPlainOffsetsInBlock(block);
                }
            }
            if (!block || !offsets || offsets.start === offsets.end) return false;

            // Bold / italic / strike: apply on the live DOM first, then serialize → raw.
            // Raw-only applyInlineFormatToRaw fails when the selection sits *inside* a wider
            // ***…*** / **…** span (common after nested toolbar use): Source gains extra **
            // but Preview already looked bold, so nothing appears to change. execCommand
            // toggles the visual marks the user actually sees; tree-walk serialize keeps
            // Source in sync.
            if (type === 'bold' || type === 'italic' || type === 'strike') {
                const prevRaw = block.getAttribute('data-raw') || getBlockRaw(block) || '';
                focusEditorNoScroll();
                selectPlainRangeInBlock(block, offsets.start, offsets.end);
                const cmd = type === 'bold' ? 'bold'
                    : type === 'italic' ? 'italic'
                    : 'strikeThrough';
                let domOk = false;
                try { domOk = document.execCommand(cmd, false, null); } catch (eC) { domOk = false; }

                let next = null;
                try { next = serializeBlockDomToRaw(block); } catch (eS) { next = null; }

                let applied = null;
                if (next != null && next !== prevRaw) {
                    applied = next;
                } else {
                    // execCommand no-op or serialize unchanged → raw marker fallback
                    const rawNext = applyInlineFormatToRaw(prevRaw, offsets.start, offsets.end, type);
                    if (rawNext != null && rawNext !== prevRaw) {
                        applied = rawNext;
                    } else {
                        // Interior of a wider ** / *** / ~~ span: split outer marks
                        const split = splitInteriorInlineFormat(prevRaw, offsets.start, offsets.end, type);
                        if (split != null && split !== prevRaw) applied = split;
                    }
                }
                if (applied == null) {
                    // execCommand may have mutated the DOM without a serializable change —
                    // restore from the pre-click raw so Preview and data-raw stay aligned.
                    try { renderBlockPreview(block, prevRaw); } catch (eR) {}
                    return false;
                }

                HistoryManager.beginEdit();
                writeBlockRaw(block, applied);
                currentActiveBlock = block;
                _selectedFormatBlocks = [block];
                try {
                    block.scrollIntoView({ block: 'nearest' });
                    focusBlock(block, null);
                    selectPlainRangeInBlock(block, offsets.start, offsets.end);
                } catch (e) {}
                updateStats();
                updateOutline();
                HistoryManager.commitEdit();
                return true;
            }

            // code / link: still raw-marker path
            const raw = getBlockRaw(block);
            const next = applyInlineFormatToRaw(raw, offsets.start, offsets.end, type);
            if (next == null || next === raw) return false;

            HistoryManager.beginEdit();
            writeBlockRaw(block, next);
            currentActiveBlock = block;
            _selectedFormatBlocks = [block];
            try {
                block.scrollIntoView({ block: 'nearest' });
                focusBlock(block, null);
                // Reselect the formatted span (plain offsets unchanged for wrap)
                selectPlainRangeInBlock(block, offsets.start, offsets.end);
            } catch (e) {}
            updateStats();
            updateOutline();
            HistoryManager.commitEdit();
            return true;
        }

        /**
         * Match emphasis/strike pairs the same way parseInline does (~~, then ***, **, *),
         * left-to-right nearest close. Used so mid-span toolbar toggles agree with Preview.
         */
        function findInlineMarkPairs(body) {
            body = String(body || '');
            const pairs = [];
            const blocked = new Array(body.length).fill(false);

            function isFree(from, to) {
                for (let i = from; i < to; i++) if (blocked[i]) return false;
                return true;
            }
            function blockRange(from, to) {
                for (let i = from; i < to; i++) blocked[i] = true;
            }

            /** True if body[pos..pos+len) is a standalone marker, not part of a longer *** run. */
            function isStandaloneMarker(pos, marker) {
                const len = marker.length;
                if (pos < 0 || pos + len > body.length) return false;
                if (body.slice(pos, pos + len) !== marker) return false;
                if (marker === '~~') return true;
                // Longest-match: *** wins over ** and *
                if (marker === '**') {
                    if (body.slice(pos, pos + 3) === '***') return false;
                    if (pos > 0 && body.slice(pos - 1, pos + 2) === '***') return false;
                    return true;
                }
                if (marker === '*') {
                    if (body.slice(pos, pos + 2) === '**') return false;
                    if (pos > 0 && body[pos - 1] === '*') return false;
                    return true;
                }
                if (marker === '***') return true;
                return true;
            }

            function matchMarker(marker, kind, blockInterior) {
                const len = marker.length;
                let i = 0;
                while (i <= body.length - len) {
                    if (blocked[i] || !isStandaloneMarker(i, marker)) {
                        i++;
                        continue;
                    }

                    let j = i + len;
                    let found = false;
                    while (j <= body.length - len) {
                        if (blocked[j] || !isStandaloneMarker(j, marker)) {
                            j++;
                            continue;
                        }
                        const inner = body.slice(i + len, j);
                        // Same hug rules as parseInline: non-empty, non-space at ends.
                        // Only delimiters must be free — interior may hold ~~ (parseInline
                        // applies strike first, then *** across the del content).
                        if (inner.length && !/^\s/.test(inner) && !/\s$/.test(inner)
                            && isFree(i, i + len) && isFree(j, j + len)) {
                            pairs.push({
                                kind: kind,
                                marker: marker,
                                open: i,
                                close: j,
                                len: len
                            });
                            blockRange(i, i + len);
                            blockRange(j, j + len);
                            // *** / ** consume their interior for lower-priority * markers
                            // (same as parseInline replacing the span before * runs).
                            if (blockInterior) blockRange(i + len, j);
                            i = j + len;
                            found = true;
                            break;
                        }
                        j++;
                    }
                    if (!found) i++;
                }
            }

            // Order must match parseInline
            matchMarker('~~', 'strike', false);
            matchMarker('***', 'bolditalic', true);
            matchMarker('**', 'bold', true);
            matchMarker('*', 'italic', false);
            return pairs;
        }

        /**
         * Toggle bold/italic/strike when the selection sits inside a wider mark span
         * (markers do not hug the range). Splits the enclosing pair so Preview and Source
         * agree — e.g. ***preBBBsuf*** + unbold BBB → ***pre*** *BBB* ***suf*** (BBB not bold).
         */
        function splitInteriorInlineFormat(raw, plainStart, plainEnd, type) {
            raw = String(raw || '');
            if (plainStart > plainEnd) {
                const t = plainStart; plainStart = plainEnd; plainEnd = t;
            }
            if (plainStart === plainEnd) return null;
            if (type !== 'bold' && type !== 'italic' && type !== 'strike') return null;

            const pref = raw.match(/^(#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]?\]\s+)?|\d+\.\s+)/);
            const prefix = pref ? pref[0] : '';
            const body = raw.slice(prefix.length);
            const off = plainRangeToRawOffsets(body, plainStart, plainEnd);
            const r0 = off.r0, r1 = off.r1;
            if (r0 >= r1) return null;

            const pairs = findInlineMarkPairs(body);
            // Pairs that strictly enclose the selection (content strictly inside markers)
            const covering = pairs.filter(function (p) {
                return p.open + p.len <= r0 && r1 <= p.close;
            });

            function coversType(p) {
                if (type === 'bold') return p.kind === 'bold' || p.kind === 'bolditalic';
                if (type === 'italic') return p.kind === 'italic' || p.kind === 'bolditalic';
                if (type === 'strike') return p.kind === 'strike';
                return false;
            }

            const hit = covering.filter(coversType);
            // Prefer innermost covering pair of this type
            hit.sort(function (a, b) {
                return (b.open - a.open) || (a.close - b.close);
            });

            const mid = body.slice(r0, r1);
            if (!mid.length) return null;

            // --- Toggle OFF: split enclosing pair ---
            if (hit.length) {
                const p = hit[0];
                const pre = body.slice(p.open + p.len, r0);
                const suf = body.slice(r1, p.close);
                const head = body.slice(0, p.open);
                const tail = body.slice(p.close + p.len);

                function hasVisibleText(s) {
                    return String(s || '')
                        .replace(/~~/g, '')
                        .replace(/\*\*\*/g, '')
                        .replace(/\*\*/g, '')
                        .replace(/\*/g, '')
                        .replace(/`/g, '')
                        .replace(/\s+/g, '')
                        .length > 0;
                }
                // Entire visible span (pre/suf empty or markers only) → not a mid-span split
                if (!hasVisibleText(pre) && !hasVisibleText(suf)) {
                    return null;
                }

                function joinSegments(segs) {
                    return segs.filter(function (s) { return s != null && s !== ''; }).join('');
                }

                // Unbold inside ***: keep italic on the middle only
                if (type === 'bold' && p.kind === 'bolditalic') {
                    return prefix + joinSegments([
                        head,
                        pre ? '***' + pre + '***' : '',
                        '*' + mid + '*',
                        suf ? '***' + suf + '***' : '',
                        tail
                    ]);
                }
                // Unitalic inside ***: keep bold on the middle only
                if (type === 'italic' && p.kind === 'bolditalic') {
                    return prefix + joinSegments([
                        head,
                        pre ? '***' + pre + '***' : '',
                        '**' + mid + '**',
                        suf ? '***' + suf + '***' : '',
                        tail
                    ]);
                }
                // Unbold inside **, unitalic inside *, unstrike inside ~~
                const m = p.marker;
                return prefix + joinSegments([
                    head,
                    pre ? m + pre + m : '',
                    mid,
                    suf ? m + suf + m : '',
                    tail
                ]);
            }

            // --- Toggle ON: wrap selection (not already covered by this type) ---
            let open = '', close = '';
            if (type === 'bold') { open = '**'; close = '**'; }
            else if (type === 'italic') { open = '*'; close = '*'; }
            else if (type === 'strike') { open = '~~'; close = '~~'; }
            else return null;
            return prefix + body.slice(0, r0) + open + mid + close + body.slice(r1);
        }

        function selectPlainRangeInBlock(block, plainStart, plainEnd) {
            // Best-effort: walk text nodes in rendered block
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
            let count = 0;
            let startNode = null, startOff = 0, endNode = null, endOff = 0;
            let n;
            while ((n = walker.nextNode())) {
                const len = n.nodeValue.length;
                if (!startNode && count + len >= plainStart) {
                    startNode = n;
                    startOff = plainStart - count;
                }
                if (count + len >= plainEnd) {
                    endNode = n;
                    endOff = plainEnd - count;
                    break;
                }
                count += len;
            }
            if (startNode && endNode) {
                const range = document.createRange();
                range.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
                range.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                cacheInlineSelection();
            }
        }

        function getAncestorBlock(node) {
            while (node && node !== document && node !== editor) {
                if (node.classList && node.classList.contains('block')) return node;
                node = node.parentNode;
            }
            return null;
        }

        let currentActiveBlock = null;
        let _lastCaretLine = 1;

        /** Center active block / source caret line in #main-container (typewriter mode). */
        function applyTypewriterScroll(force) {
            if (!force && !state.typewriterMode) return;
            if (!mainContainer) return;
            try {
                if (state.mode === 'source' && sourceEditor) {
                    const pos = sourceEditor.selectionStart || 0;
                    const before = sourceEditor.value.substring(0, pos);
                    const line = Math.max(1, before.split(/\r?\n/).length);
                    scrollSourceToHardLine(line, false);
                    return;
                }
                const block = currentActiveBlock
                    || (document.activeElement && document.activeElement.classList
                        && document.activeElement.classList.contains('block') ? document.activeElement : null);
                if (!block || !editor.contains(block)) return;
                const cRect = mainContainer.getBoundingClientRect();
                const bRect = block.getBoundingClientRect();
                const delta = (bRect.top + bRect.height / 2) - (cRect.top + cRect.height / 2);
                if (force || Math.abs(delta) > 8) {
                    mainContainer.scrollTop += delta;
                }
            } catch (e) {}
        }

        /** Total document lines (same basis as status "total"). */
        function getTotalLineCount(precomputedContent) {
            const content = precomputedContent != null ? precomputedContent : getMarkdownContent();
            if (!content || content.length === 0) return 1;
            return content.split(/\r?\n/).length;
        }

        /**
         * Lines in one block raw (min 1 for empty blocks so line numbers stay contiguous).
         */
        function linesInBlockRaw(raw) {
            const s = String(raw == null ? '' : raw);
            if (!s.length) return 1;
            let n = 1;
            for (let i = 0; i < s.length; i++) {
                if (s.charCodeAt(i) === 10) n++;
            }
            return n;
        }

        /**
         * 1-based line of the first line of model block `blockIndex` (0-based).
         */
        function modelBlockStartLine(blockIndex) {
            if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks) return 1;
            let line = 1;
            const n = Math.min(blockIndex | 0, DocumentModel.blocks.length);
            // A book's raw is HTML, so counting newlines in it measures the markup rather
            // than the reading position -- and everything that navigates by line then lands
            // somewhere unrelated. Its text is what a line means here.
            const book = DocumentModel.kind === 'epub';
            for (let i = 0; i < n; i++) {
                line += book ? linesInBlockRaw(DocumentModel.blockText(i))
                             : linesInBlockRaw(DocumentModel.blocks[i] ? DocumentModel.blocks[i].raw : '');
            }
            return line;
        }

        /**
         * 1-based caret line in the full document (for status bar). Always 1..total.
         * Under virtualization, only a window of .block nodes is mounted — counting those
         * alone reported "Ln 73/4532" while viewing the last line. Prefer model indices.
         */
        function getCaretLineNumber(precomputedContent) {
            try {
                const total = getTotalLineCount(precomputedContent);
                let caret = 1;

                if (state.mode === 'source' && sourceEditor) {
                    const pos = sourceEditor.selectionStart || 0;
                    caret = sourceEditor.value.substring(0, pos).split(/\r?\n/).length || 1;
                } else {
                    const sel = window.getSelection();
                    const selInEditor = !!(sel && sel.anchorNode && editor
                        && editor.contains(sel.anchorNode));
                    let active = currentActiveBlock;
                    if (selInEditor) {
                        active = getAncestorBlock(sel.anchorNode) || active;
                    }

                    // Virt without a caret in the editor: report the line at viewport center
                    // (first mounted block would read as window-start, e.g. 4474/4532 at bottom).
                    if (state.mode === 'wysiwyg' && !selInEditor && typeof _lastCaretLine !== 'undefined' && _lastCaretLine >= 1) {
                        return Math.min(_lastCaretLine, total);
                    }
                    if (typeof DocumentModel !== 'undefined' && DocumentModel.virtEnabled
                        && DocumentModel.blocks && DocumentModel.blocks.length && !selInEditor) {
                        const idx = modelIndexAtViewportCenter();
                        caret = modelBlockStartLine(idx);
                    } else if (!active || !editor || !editor.contains(active)) {
                        return 1;
                    } else {
                        let within = 0;
                        const rawAttr = active.hasAttribute('data-raw')
                            ? active.getAttribute('data-raw')
                            : (active.innerText || '');
                        const blockLines = linesInBlockRaw(rawAttr);
                        if (selInEditor && sel.rangeCount && active.contains(sel.anchorNode)) {
                            try {
                                const r = document.createRange();
                                r.selectNodeContents(active);
                                r.setEnd(sel.anchorNode, sel.anchorOffset);
                                within = r.toString().split(/\r?\n/).length - 1;
                                if (within < 0) within = 0;
                                if (within >= blockLines) within = blockLines - 1;
                            } catch (e) { within = 0; }
                        }

                        let mi = -1;
                        try {
                            if (typeof DocumentModel !== 'undefined') {
                                mi = DocumentModel.modelIndexOfEl(active);
                            }
                        } catch (eMi) { mi = -1; }

                        if (mi >= 0 && typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                            && DocumentModel.blocks.length) {
                            caret = modelBlockStartLine(mi) + within;
                        } else {
                            const blocks = editor.querySelectorAll('.block');
                            let line = 1;
                            for (let i = 0; i < blocks.length; i++) {
                                const b = blocks[i];
                                const raw = b.hasAttribute('data-raw')
                                    ? b.getAttribute('data-raw') : (b.innerText || '');
                                const bl = linesInBlockRaw(raw);
                                if (b === active) {
                                    caret = line + within;
                                    break;
                                }
                                line += bl;
                            }
                        }
                    }
                }

                if (caret < 1) caret = 1;
                if (caret > total) caret = total;
                return caret;
            } catch (e) {
                return 1;
            }
        }

        /**
         * 1-based hard line from markdown string + char offset (canonical for stickiness).
         */
        function lineFromMarkdownOffset(md, offset) {
            md = String(md == null ? '' : md);
            let off = offset | 0;
            if (off < 0) off = 0;
            if (off > md.length) off = md.length;
            let line = 1;
            for (let i = 0; i < off; i++) {
                if (md.charCodeAt(i) === 10) line++;
            }
            return line;
        }

        /**
         * Map 1-based hard line → model block index and line-within-block (0-based).
         */
        function modelLocationFromDocumentLine(line1Based) {
            const blocks = (typeof DocumentModel !== 'undefined' && DocumentModel.blocks)
                ? DocumentModel.blocks : [];
            if (!blocks.length) return { blockIndex: 0, within: 0 };
            // The inverse of modelBlockStartLine, and it has to measure the same thing: a
            // book's lines are its text. Counting newlines in the markup instead sent every
            // line-based restore to an unrelated block.
            const book = DocumentModel.kind === 'epub';
            const linesOf = function (bi) {
                return linesInBlockRaw(book ? DocumentModel.blockText(bi) : blocks[bi].raw);
            };
            let remaining = Math.max(1, line1Based | 0);
            for (let bi = 0; bi < blocks.length; bi++) {
                const bl = linesOf(bi);
                if (remaining <= bl) {
                    return { blockIndex: bi, within: remaining - 1 };
                }
                remaining -= bl;
            }
            const last = blocks.length - 1;
            return { blockIndex: last, within: Math.max(0, linesOf(last) - 1) };
        }

        /**
         * Last known document line while the user was actually editing.
         * WPF Preview/Source button steals focus BEFORE cmd:toggle_mode runs; the textarea
         * then often reports selectionStart=0 → capture would wrongly return line 1.
         * We freeze the line on every real edit/selection while focused.
         */
        let _stickyLineCache = 1;

        function rememberStickyLine(line) {
            const n = line | 0;
            if (n >= 1) {
                _stickyLineCache = n;
            }
        }

        /**
         * Host Preview/Source buttons often zero selectionStart while focus still
         * reports the textarea. Never let a poisoned "offset 0 → line 1" clobber a
         * higher sticky line the user actually had.
         */
        function isPoisonedSourceLineOne(liveLine, pos) {
            const live = liveLine | 0;
            const cache = _stickyLineCache | 0;
            if (live > 1) return false;
            if (cache <= 1) return false;
            // offset 0 with a higher cached line is the classic focus-steal poison
            if ((pos | 0) === 0) return true;
            return false;
        }

        /** Update cache only while the source textarea still has focus. */
        function rememberStickyFromSourceIfFocused() {
            if (state.mode !== 'source' || !sourceEditor) return;
            try {
                if (document.activeElement !== sourceEditor) return;
                const pos = sourceEditor.selectionStart | 0;
                const live = lineFromMarkdownOffset(sourceEditor.value || '', pos);
                if (isPoisonedSourceLineOne(live, pos)) return; // keep cache
                rememberStickyLine(live);
            } catch (e) {}
        }

        /** Update cache from preview selection/active block while focus is in the editor. */
        function rememberStickyFromPreviewIfFocused() {
            if (state.mode === 'source') return;
            try {
                const sel = window.getSelection();
                const inEd = sel && sel.anchorNode && editor && editor.contains(sel.anchorNode);
                if (!inEd && !(currentActiveBlock && editor && editor.contains(currentActiveBlock))) return;
                const line = captureStickyDocumentLineLive();
                // Do not collapse sticky to 1 when selection was destroyed by chrome
                if ((line | 0) <= 1 && (_stickyLineCache | 0) > 1 && !inEd) return;
                if (line >= 1) rememberStickyLine(line);
            } catch (e) {}
        }

        /**
         * Live read of sticky line (no focus-steal protection). Used while focused.
         */
        function captureStickyDocumentLineLive() {
            if (state.mode === 'source' && sourceEditor) {
                const pos = sourceEditor.selectionStart | 0;
                return lineFromMarkdownOffset(sourceEditor.value || '', pos);
            }
            let mi = -1;
            let within = 0;
            const sel = window.getSelection();
            if (sel && sel.anchorNode && editor && editor.contains(sel.anchorNode)) {
                const b = getAncestorBlock(sel.anchorNode);
                if (b) {
                    mi = (typeof DocumentModel !== 'undefined')
                        ? DocumentModel.modelIndexOfEl(b) : -1;
                    if (mi >= 0 && sel.rangeCount) {
                        try {
                            const raw = b.getAttribute('data-raw') || '';
                            const blockLines = linesInBlockRaw(raw);
                            const r = document.createRange();
                            r.selectNodeContents(b);
                            r.setEnd(sel.anchorNode, sel.anchorOffset);
                            within = r.toString().split(/\r?\n/).length - 1;
                            if (within < 0) within = 0;
                            if (within >= blockLines) within = blockLines - 1;
                        } catch (eW) { within = 0; }
                    }
                }
            }
            if (mi < 0 && currentActiveBlock && editor && editor.contains(currentActiveBlock)) {
                mi = (typeof DocumentModel !== 'undefined')
                    ? DocumentModel.modelIndexOfEl(currentActiveBlock) : -1;
            }
            if (mi < 0) return Math.max(1, _stickyLineCache | 0);
            return modelBlockStartLine(mi) + within;
        }

        /**
         * Document line at the top of the Preview/Reader viewport (what the user is looking
         * at). Source already has hardLineFromSourceScrollTop; without this, scrolling Preview
         * without clicking left sticky at an old caret and mode switch jumped away.
         */
        function hardLineFromPreviewViewport() {
            try {
                if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks
                    || !DocumentModel.blocks.length) return 1;
                let mi = -1;
                if (typeof isPaginatedLayout === 'function' && isPaginatedLayout()
                    && typeof topLeftModelIndexTwoCol === 'function') {
                    mi = topLeftModelIndexTwoCol();
                }
                if (!(mi >= 0) && typeof modelIndexAtViewportCenter === 'function') {
                    mi = modelIndexAtViewportCenter();
                }
                if (!(mi >= 0) && typeof _readingAnchor === 'number' && _readingAnchor >= 0) {
                    mi = _readingAnchor;
                }
                if (!(mi >= 0)) return Math.max(1, _stickyLineCache | 0);
                return modelBlockStartLine(mi);
            } catch (e) {
                return Math.max(1, _stickyLineCache | 0, 1);
            }
        }

        /** Keep sticky cache aligned with the visible page while scrolling Preview. */
        function rememberStickyFromPreviewScroll() {
            if (state.mode === 'source') return;
            try {
                // Do not steal sticky line on scroll if search is open
                const searchPane = document.getElementById('tab-search');
                const showingSearch = searchPane && searchPane.classList.contains('active');
                if (showingSearch && !window.__tzExternalSearchActive) return;

                const line = hardLineFromPreviewViewport();
                if (line >= 1) rememberStickyLine(line);
            } catch (e) {}
        }

        /**
         * Line to restore on mode switch. Prefer frozen sticky cache when live caret
         * looks like focus-steal poison (selectionStart 0 → line 1).
         * Preview also consults the viewport (same idea as Source's scrollTop map).
         */
        function captureStickyDocumentLine() {
            try {
                const frozen = Math.max(1, _stickyLineCache | 0, _lastCaretLine | 0);
                if (state.mode === 'source' && sourceEditor) {
                    if (document.activeElement === sourceEditor) {
                        const pos = sourceEditor.selectionStart | 0;
                        const live = captureStickyDocumentLineLive();
                        if (isPoisonedSourceLineOne(live, pos)) {
                            return frozen;
                        }
                        rememberStickyLine(live);
                        return live;
                    }
                    // Focus already gone (toolbar/mode button) → frozen cache
                    return frozen;
                }
                // Sidebar search has focus — the frozen cache IS the user's position.
                // Do NOT consult viewport center, it's inaccurate.
                const sidebarFocused = document.activeElement && (
                    document.activeElement.id === 'sidebarSearchInput' ||
                    (document.activeElement.closest && document.activeElement.closest('#tab-search'))
                );
                if (sidebarFocused) {
                    return frozen;
                }
                // Preview: prefer what is on screen over a stale caret after scroll.
                if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#sidebar')) {
                    return frozen;
                }
                let viewLine = 1;
                try { viewLine = hardLineFromPreviewViewport(); } catch (eV) { viewLine = frozen; }
                const sel = window.getSelection();
                const inEd = sel && sel.anchorNode && editor && editor.contains(sel.anchorNode);
                if (inEd || (document.activeElement === editor
                    || (editor && editor.contains(document.activeElement)))) {
                    const live = captureStickyDocumentLineLive();
                    // Chrome-destroyed selection often reports block 0 / line 1
                    if ((live | 0) <= 1 && frozen > 1 && !inEd) {
                        return Math.max(frozen, viewLine | 0);
                    }
                    if ((live | 0) <= 1 && frozen > 1) {
                        return Math.max(frozen, viewLine | 0);
                    }
                    // Viewport wins when it disagrees with caret (scrolled without click).
                    const chosen = (Math.abs((viewLine | 0) - (live | 0)) > 12)
                        ? (viewLine | 0) : (live | 0);
                    rememberStickyLine(chosen);
                    return chosen;
                }
                // Mode button stole focus: viewport + frozen
                const chosen = Math.max(frozen, viewLine | 0);
                rememberStickyLine(chosen);
                return chosen;
            } catch (e) {
                return Math.max(1, _stickyLineCache | 0, _lastCaretLine | 0);
            }
        }

        /**
         * Scroll/mount so model block `blockIndex` is VISIBLE in #main-container.
         * Height-map estimates (prefixHeight) often overshoot: status can show Ln N
         * while the block sits above the viewport. After estimate+mount, snap with
         * getBoundingClientRect so the block top lands ~topPad px below the container top.
         * @returns {Element|null} mounted block element if found
         */
        function ensureModelBlockVisible(blockIndex, options) {
            options = options || {};
            const pad = (options.topPad != null) ? (options.topPad | 0) : 48;
            if (!mainContainer || !editor || typeof DocumentModel === 'undefined'
                || !DocumentModel.blocks || !DocumentModel.blocks.length) {
                return null;
            }
            let bi = blockIndex | 0;
            if (bi < 0) bi = 0;
            if (bi >= DocumentModel.blocks.length) bi = DocumentModel.blocks.length - 1;

            function queryEl() {
                return editor.querySelector('.block[data-model-index="' + bi + '"]');
            }

            function seedFromHeightMap() {
                try {
                    const isTwoCol = isPaginatedLayout();
                    if (isTwoCol) {
                        const el = elementForModelIndex(bi);
                        const pageForBlock = twoColPageOfElement(el);
                        if (pageForBlock !== null) {
                            editor.scrollLeft = pageForBlock * twoColPageWidth();
                            currentTwoColPage = pageForBlock;
                            window.showDebugTelemetry('ensureVisible: 2col seed page=' + pageForBlock +
                                ' scrollLeft=' + editor.scrollLeft);
                        }
                        return;
                    }
                    DocumentModel.ensureHeights();
                    const y = Math.max(0, DocumentModel.prefixHeight(bi) - pad);
                    window.showDebugTelemetry('ensureVisible: seeding scroll to ' + y);
                    mainContainer.scrollTop = y;
                } catch (eS) { window.showDebugTelemetry('ensureVisible: seed threw ' + eS.message); }
                if (DocumentModel.virtEnabled) {
                    // Lock pin to target block — do not re-anchor from noisy scrollTop
                    try {
                        window.showDebugTelemetry('ensureVisible: calling mountVirtWindow anchorIndex=' + bi);
                        mountVirtWindow(true, { anchorIndex: bi, anchorOffset: -pad });
                    } catch (eM) {}
                }
            }

            function snapOnce(el) {
                if (!el) return 9999;
                try {
                    if (el.offsetHeight > 12) {
                        DocumentModel.setMeasuredHeight(bi, el.offsetHeight);
                    }
                } catch (eH) {}
                try {
                    const isTwoCol = isPaginatedLayout();
                    if (isTwoCol) {
                        const pg = twoColPageOfElement(el);
                        if (pg === null) return 0;
                        const target = pg * twoColPageWidth();
                        const delta = target - (editor.scrollLeft || 0);
                        editor.scrollLeft = target;
                        currentTwoColPage = pg;
                        return delta;
                    } else {
                        const rect = el.getBoundingClientRect();
                        const cRect = mainContainer.getBoundingClientRect();
                        // Desired: block top just below the visible top (pad)
                        const delta = rect.top - (cRect.top + pad);
                        if (Math.abs(delta) < 3) return 0;
                        mainContainer.scrollTop = Math.max(0, (mainContainer.scrollTop || 0) + delta);
                        if (DocumentModel.virtEnabled) {
                            try {
                                mountVirtWindow(true, { anchorIndex: bi, anchorOffset: -pad });
                            } catch (eV) {}
                        }
                        return delta;
                    }
                } catch (eSnap) {
                    return 9999;
                }
            }

            // 1) Estimate → mount (virt) so the block is hopefully in the window
            seedFromHeightMap();

            // 2) Geometric snap loop: measure, correct scroll, remount if virt
            //    (remount remeasures heights/spacers which can shift layout again)
            let el = queryEl();
            for (let iter = 0; iter < 6; iter++) {
                if (!el) {
                    seedFromHeightMap();
                    el = queryEl();
                    if (!el) break;
                }
                const delta = snapOnce(el);
                el = queryEl();
                if (Math.abs(delta) < 3) break;
            }

            try { clampMainScroll(); } catch (eC) {}
            el = queryEl();

            // 3) Last resort: if still fully off-screen, start-align then re-snap
            //    Skip for 2-col — getBoundingClientRect and scrollIntoView are
            //    broken for CSS overflow columns; the seed+snap above already handled it.
            if (el && !(isPaginatedLayout())) {
                try {
                    const r = el.getBoundingClientRect();
                    const c = mainContainer.getBoundingClientRect();
                    const fullyAbove = r.bottom < c.top + 4;
                    const fullyBelow = r.top > c.bottom - 4;
                    if (fullyAbove || fullyBelow) {
                        try {
                            el.scrollIntoView({ block: 'start', behavior: 'auto' });
                        } catch (eSi) {}
                        // scrollIntoView may use a different scroller — force mainContainer
                        try {
                            const r2 = el.getBoundingClientRect();
                            const c2 = mainContainer.getBoundingClientRect();
                            mainContainer.scrollTop = Math.max(
                                0, (mainContainer.scrollTop || 0) + (r2.top - c2.top - pad));
                        } catch (e2) {}
                        if (DocumentModel.virtEnabled) {
                            try { mountVirtWindow(true); } catch (eM2) {}
                        }
                        el = queryEl();
                        if (el) snapOnce(el);
                        try { clampMainScroll(); } catch (eC2) {}
                        el = queryEl();
                    }
                } catch (eLast) {}
            }
            return el || queryEl();
        }

        /**
         * Put the user on hard line `line1Based` in the CURRENT mode and leave the caret there
         * so the next captureStickyDocumentLine() returns the same number.
         */
        function restoreStickyDocumentLine(line1Based, noFocus) {
            let line = Math.max(1, line1Based | 0);
            if (window.markProgrammaticScroll) window.markProgrammaticScroll(800);
            rememberStickyLine(line);
            try {
                if (state.mode === 'source' && sourceEditor) {
                    const total = countHardLines(sourceEditor.value || '');
                    if (line > total) line = total;
                    rememberStickyLine(line);
                    _contentCache = sourceEditor.value || '';
                    resizeSourceEditor();
                    scrollSourceToHardLine(line, !noFocus);
                    try { updateStatsNow({ forceCaretLine: line }); } catch (eU) {}
                    return;
                }
                if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks
                    || !DocumentModel.blocks.length || !mainContainer) {
                    try { updateStatsNow({ forceCaretLine: line }); } catch (eEarly) {}
                    return;
                }
                const totalLines = (function () {
                    let t = 0;
                    for (let i = 0; i < DocumentModel.blocks.length; i++) {
                        t += linesInBlockRaw(DocumentModel.blocks[i].raw);
                    }
                    return Math.max(1, t);
                })();
                if (line > totalLines) line = totalLines;
                rememberStickyLine(line);
                const loc = modelLocationFromDocumentLine(line);
                const bi = loc.blockIndex;
                window.showDebugTelemetry('restoreSticky: line=' + line + ' maps to blockIndex=' + bi);
                const el = ensureModelBlockVisible(bi, { topPad: 48 });
                if (el) {
                    window.showDebugTelemetry('restoreSticky: ensureModelBlockVisible returned el, setting focus');
                    currentActiveBlock = el;
                    try {
                        if (!noFocus) focusBlock(el, 0);
                    } catch (eF) {}
                    // Focus/caret can nudge scroll in WebView2 — re-snap once
                    try {
                        const r = el.getBoundingClientRect();
                        const c = mainContainer.getBoundingClientRect();
                        if (r.bottom < c.top + 8 || r.top > c.bottom - 8 || r.top < c.top - 2) {
                            ensureModelBlockVisible(bi, { topPad: 48 });
                        }
                    } catch (eRe) {}
                }
                // Force status to sticky line — getCaretLineNumber often returns 1 right
                // after mode switch before selection settles.
                try { updateStatsNow({ forceCaretLine: line }); } catch (eU2) {}
            } catch (e) {}
        }

        function modelIndexAtViewportCenter() {
            if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks || !DocumentModel.blocks.length) {
                return 0;
            }
            try {
                let isTwoCol = isPaginatedLayout();
                
                // --- 2-col: read the block positions the browser produced, rather than
                //     simulating the column breaker. The simulation this replaces walked
                //     offsetHeight to guess which block began the visible left column; it
                //     drifted from the real layout over a long document, which is what made
                //     leaving and re-entering 2-column land pages earlier than it started.
                //     Rects are dependable here: virtualisation is off in 2-column mode, so
                //     every block is mounted and positioned. ---
                if (isTwoCol) {
                    const mi = topLeftModelIndexTwoCol();
                    if (mi >= 0) {
                        window.showDebugTelemetry('modelIndex: 2col topLeft rect mi=' + mi +
                            ' page=' + (currentTwoColPage || 0));
                        return mi;
                    }
                    window.showDebugTelemetry('modelIndex: 2col topLeft rect found nothing');
                }
                
                // --- 1-col: fast probe near the TOP of the viewport (not the center)
                //     so the anchor = first visible line the user sees. ---
                // Measured from the scroll container, not the window. A hardcoded y=60 in
                // window coordinates lands on the toolbar/tab strip rather than inside the
                // document, so elementFromPoint found no block and the fallback below
                // measured distance from a point outside the viewport -- which selected a
                // block already scrolled off the top. Leaving 2-column then returning
                // therefore anchored several blocks early, enough to land a page back.
                const _cRect = mainContainer.getBoundingClientRect();
                let cy = _cRect.top + 8;
                let cx = _cRect.left + (_cRect.width / 2);
                let pts = [];
                for (let ox of [0, 20, 60, -20]) {
                    for (let oy of [0, 20, 40]) {
                        pts.push([cx + ox, cy + oy]);
                    }
                }
                for (let i = 0; i < pts.length; i++) {
                    let el = document.elementFromPoint(pts[i][0], pts[i][1]);
                    if (el) {
                        let block = el.closest('.block');
                        if (block) {
                            let mi = DocumentModel.modelIndexOfEl(block);
                            if (mi >= 0) {
                                window.showDebugTelemetry('modelIndex: topLeft probe mi=' + mi + ' y=' + pts[i][1]);
                                return mi;
                            }
                        }
                    }
                }

                // 2. Robust probe
                let bestBlock = null;
                let bestDist = Infinity;
                let blocks = editor ? editor.querySelectorAll('.block') : [];
                for (let i = 0; i < blocks.length; i++) {
                    let r = blocks[i].getBoundingClientRect();
                    if (r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight) {
                        let dx = 0, dy = 0;
                        if (cx < r.left) dx = r.left - cx;
                        else if (cx > r.right) dx = cx - r.right;
                        if (cy < r.top) dy = r.top - cy;
                        else if (cy > r.bottom) dy = cy - r.bottom;
                        let dist = dx * dx + dy * dy;
                        
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestBlock = blocks[i];
                            if (dist === 0) break;
                        }
                    }
                }
                
                if (bestBlock) {
                    let mi = DocumentModel.modelIndexOfEl(bestBlock);
                    if (mi >= 0) {
                        window.showDebugTelemetry('modelIndex: robust probe found ' + mi);
                        return mi;
                    }
                }
            } catch (e) {
                window.showDebugTelemetry('modelIndex: threw exception ' + e.message);
            }
            
            const active = currentActiveBlock;
            if (active) {
                const mi = DocumentModel.modelIndexOfEl(active);
                if (mi >= 0) {
                    window.showDebugTelemetry('modelIndex: returning currentActiveBlock mi=' + mi);
                    return mi;
                }
            }

            if (DocumentModel.virtEnabled && mainContainer) {
                DocumentModel.ensureHeights();
                const midY = (mainContainer.scrollTop || 0) + (mainContainer.clientHeight || 0) / 2;
                let idx = DocumentModel.indexAtScrollTop(midY);
                if (idx < 0) idx = 0;
                if (idx >= DocumentModel.blocks.length) idx = DocumentModel.blocks.length - 1;
                const max = Math.max(0, mainContainer.scrollHeight - mainContainer.clientHeight);
                if (max > 0 && (mainContainer.scrollTop || 0) >= max - 2) {
                    idx = DocumentModel.blocks.length - 1;
                }
                window.showDebugTelemetry('modelIndex: returning virt midY idx=' + idx);
                return idx;
            }
            window.showDebugTelemetry('modelIndex: returning 0 fallback');
            return 0;
        }

        function updateCaretLineStatus() {
            const line = getCaretLineNumber();
            if (line === _lastCaretLine) return;
            _lastCaretLine = line;
            // Piggy-back on stats so the host updates "Ln X" without a new protocol
            updateStats();
        }

        function updateActiveBlock() {
            if (state.mode === 'source') {
                updateCaretLineStatus();
                if (state.typewriterMode) applyTypewriterScroll(false);
                return;
            }
            const sel = window.getSelection();
            let newActive = null;
            if (sel && sel.anchorNode && editor.contains(sel.anchorNode)) {
                newActive = getAncestorBlock(sel.anchorNode);
            }
            if (!newActive && (document.activeElement === editor || editor.contains(document.activeElement)) && editor.children.length > 0) {
                newActive = currentActiveBlock || editor.lastElementChild;
            }

            if (currentActiveBlock !== newActive) {
                if (currentActiveBlock && currentActiveBlock.classList && editor.contains(currentActiveBlock)) {
                    currentActiveBlock.classList.remove('focused');
                    if (state.revealOnFocus) {
                        const raw = currentActiveBlock.getAttribute('data-raw') || currentActiveBlock.innerText || '';
                        currentActiveBlock.setAttribute('data-raw', raw);
                        renderBlockPreview(currentActiveBlock, raw);
                    }
                }
                currentActiveBlock = newActive;
                if (currentActiveBlock && currentActiveBlock.classList && editor.contains(currentActiveBlock)) {
                    currentActiveBlock.classList.add('focused');
                    if (state.revealOnFocus) {
                        const raw = currentActiveBlock.getAttribute('data-raw') || '';
                        if (currentActiveBlock.innerText !== raw) currentActiveBlock.innerText = raw;
                    }
                    if (state.typewriterMode) applyTypewriterScroll(true);
                }
                updateStats();
                updateOutline();
            } else {
                updateCaretLineStatus();
                if (state.typewriterMode) applyTypewriterScroll(false);
            }
        }

        /**
         * Focus the editor without letting the browser scroll it into view.
         *
         * #editor is the whole contenteditable document, so its top edge is above the
         * viewport whenever you are not at the start. The default focus() behaviour is to
         * scroll the focused element into view -- which scrolls that top edge into view,
         * i.e. jumps to line 1. Every caller here positions the caret itself immediately
         * afterwards, so the browser's idea of where to scroll is always the wrong one.
         *
         * This is what sent undo to the top of the document: _restoreCaret found the right
         * block, then focusBlock scrolled away from it before setting the caret.
         */
        function focusEditorNoScroll() {
            if (!editor || !editor.focus) return;
            try { editor.focus({ preventScroll: true }); }
            catch (e) { try { editor.focus(); } catch (e2) {} }
        }

        function focusBlock(block, offset = null) {
            if (!block) return;
            focusEditorNoScroll();
            if (offset !== null) {
                try { setCaretAtOffset(block, offset); } catch(e) {}
            }
            updateActiveBlock();
        }

        document.addEventListener('selectionchange', () => {
            if (state.mode === 'source' && document.activeElement === sourceEditor) {
                rememberStickyFromSourceIfFocused();
                updateCaretLineStatus();
                // Selection size can change without line change — refresh sel word count
                updateStats(false);
                if (state.typewriterMode) applyTypewriterScroll(false);
                return;
            }
            // If focus left the editor, freeze format indices (toolbar path) — do not
            // overwrite with the destroyed selection WebView reports on blur.
            const sel = window.getSelection();
            const inEditor = sel && sel.anchorNode && editor && editor.contains(sel.anchorNode);
            if (!inEditor && state.mode !== 'source') {
                freezeFormatSelection();
                // Toolbar blur: selection may be gone — refresh sel counts without reserializing
                updateStats(false);
                return;
            }
            if (state.mode !== 'source' && (document.activeElement === editor || editor.contains(document.activeElement) || inEditor)) {
                if (!_formatSelectionFrozen) {
                    cacheSelectedBlocks();
                    cacheInlineSelection();
                }
                // Keep multi-block Delete freeze current while the range is live (Shift+scroll)
                try {
                    if (typeof snapshotMultiBlockSelectionFromLive === 'function')
                        snapshotMultiBlockSelectionFromLive();
                } catch (eMb) {}
                updateActiveBlock();
                rememberStickyFromPreviewIfFocused();
                updateStats(false);
            }
        });
        editor.addEventListener('focus', function () {
            // Do NOT clear freeze here — applyFormatting re-focuses the editor after
            // toolbar clicks; unfreezing early re-enabled live (destroyed) selection.
            updateActiveBlock();
        });
        // Snapshot selection on real user gestures (before toolbar can steal focus)
        editor.addEventListener('mousedown', function () {
            // CRITICAL: capture full document HERE, before drag-select corrupts data-raw.
            // Without this, multi-select → bullet reloads from empty and wipes the doc.
            try { refreshLastGoodDocRaws(); } catch (e) {}
            _formatSelectionFrozen = false;
            _selectedFormatRaws = {};
        }, true);
        editor.addEventListener('mouseup', function () {
            try {
                if (typeof snapshotMultiBlockSelectionFromLive === 'function')
                    snapshotMultiBlockSelectionFromLive();
            } catch (eMu) {}
        }, true);
        // Keyboard multi-select (Shift+Arrow): snapshot while still collapsed / first extend
        editor.addEventListener('keydown', function (e) {
            if (!e.shiftKey) return;
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft'
                && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End'
                && e.key !== 'PageUp' && e.key !== 'PageDown') return;
            try {
                const sel = window.getSelection();
                if (sel && sel.isCollapsed) refreshLastGoodDocRaws();
            } catch (err) {}
        }, true);
        // A link inside a book jumps within the document. The whole book is already open,
        // so following the href would replace the application with one chapter of it -- and
        // an external link should not silently become the reader's window either.
        editor.addEventListener('click', function (e) {
            if (typeof DocumentModel === 'undefined' || DocumentModel.kind !== 'epub') return;
            const a = e.target && e.target.closest ? e.target.closest('a') : null;
            if (!a) return;
            const target = a.getAttribute('data-book-href') || a.getAttribute('href');
            if (!target) return;
            e.preventDefault();
            e.stopPropagation();
            if (/^(https?:|mailto:)/i.test(target)) {
                postMsg('open_external:' + encodeURIComponent(target));
                return;
            }
            if (!bookGoToHref(target, a.innerText || a.textContent || '')) {
                window.showDebugTelemetry('book link went nowhere: ' + target);
            }
        }, true);

        editor.addEventListener('mouseup', function () {
            snapshotFormatSelectionFromEditor();
            cacheInlineSelection();
            updateActiveBlock();
        });
        editor.addEventListener('keyup', function () {
            if (!_formatSelectionFrozen) {
                snapshotFormatSelectionFromEditor();
                cacheInlineSelection();
            }
            updateActiveBlock();
        });
        editor.addEventListener('click', function () {
            if (!_formatSelectionFrozen) {
                snapshotFormatSelectionFromEditor();
                cacheInlineSelection();
            }
            updateActiveBlock();
        });
        editor.addEventListener('focusout', function () {
            // FREEZE ONLY — do not re-snapshot. WebView has often already destroyed the
            // multi-block range; re-reading it overwrote good mouseup indices/raws and
            // multi-select list convert wiped lines (regression).
            freezeFormatSelection();
        });
        if (sourceEditor) {
            sourceEditor.addEventListener('keyup', () => {
                updateCaretLineStatus();
                if (state.typewriterMode) applyTypewriterScroll(false);
            });
            sourceEditor.addEventListener('click', () => {
                updateCaretLineStatus();
                if (state.typewriterMode) applyTypewriterScroll(false);
            });
        }



