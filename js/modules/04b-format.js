// TypoZen module: 04b-format.js
// Classic script; shares page globals. Load order: js/modules/load-order.json.

        // --- Inline selection → Markdown (bold / italic / code / link) ---
        let _inlineSelCache = null; // { block, start, end, text }
        /** Source textarea selection frozen for toolbar (WPF steals focus → selection collapses). */
        let _sourceFormatSel = null; // { start, end }

        function rememberSourceFormatSelection() {
            if (!sourceEditor || state.mode !== 'source') return;
            try {
                if (typeof isSourceFocused === 'function' && !isSourceFocused()) return;
                const a = sourceEditor.selectionStart | 0;
                const b = sourceEditor.selectionEnd | 0;
                _sourceFormatSel = (a !== b) ? { start: Math.min(a, b), end: Math.max(a, b) } : null;
            } catch (e) {}
        }

        function takeSourceFormatSelection() {
            let start = 0, end = 0;
            try {
                start = sourceEditor.selectionStart | 0;
                end = sourceEditor.selectionEnd | 0;
            } catch (e) {}
            const srcFocused = (typeof isSourceFocused === 'function') && isSourceFocused();
            if (start === end && srcFocused) {
                _sourceFormatSel = null;
            }
            // Toolbar focus-steal often collapses to a caret; prefer last non-empty range
            // only when Source actually lost focus.
            if (start === end && !srcFocused && _sourceFormatSel
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

        /**
         * Map visible plain-text offsets [plainStart, plainEnd) → raw markdown slice.
         * Mirrors parseInline() delimiter rules so markers/links/images/code spans stay
         * aligned with what Preview actually renders, and returns parsed span bounds.
         */
        function plainRangeToRawOffsets(raw, plainStart, plainEnd) {
            raw = String(raw || '');
            if (plainStart > plainEnd) {
                const t = plainStart; plainStart = plainEnd; plainEnd = t;
            }
            plainStart = Math.max(0, plainStart | 0);
            plainEnd = Math.max(0, plainEnd | 0);

            const n = raw.length;
            const hidden = new Array(n).fill(false);
            const spans = [];

            function isSafeUrlForOffset(dest, allowDataImage) {
                const esc = String(dest).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                if (typeof safeUrl === 'function' && typeof splitLinkTitle === 'function') {
                    return !!safeUrl(splitLinkTitle(esc).url, allowDataImage);
                }
                const parts = esc.match(/^(\S+)(\s+(?:&quot;.*&quot;|&#39;.*&#39;))\s*$/);
                const u = String(parts ? parts[1] : esc).trim();
                if (!u || /&quot;|&#39;|&lt;|&gt;/.test(u)) return false;
                const probe = u.replace(/[\x00-\x20]/g, '').toLowerCase();
                if (allowDataImage && /^data:image\//.test(probe)) return true;
                return !/^(javascript|vbscript|data|about):/.test(probe);
            }

            // 1. Code spans first — literal body, no inner emphasis/links/images.
            let mask = raw.replace(/`([^`]*)`/g, function (m, body, offset) {
                const openStart = offset;
                const openEnd = offset + 1;
                const closeStart = openEnd + body.length;
                const closeEnd = offset + m.length;
                hidden[openStart] = true;
                hidden[closeStart] = true;
                spans.push({
                    kind: 'code',
                    marker: '`',
                    openStart: openStart,
                    openEnd: openEnd,
                    closeStart: closeStart,
                    closeEnd: closeEnd
                });
                return '\uE000'.repeat(m.length);
            });

            // 2. Images before links. Safe images render 0 visible chars; unsafe render alt as link.
            mask = mask.replace(/!\[(.*?)\]\((.*?)\)/g, function (m, alt, dest, offset) {
                const rawDest = raw.slice(offset + 3 + alt.length, offset + m.length - 1);
                if (isSafeUrlForOffset(rawDest, true)) {
                    for (let k = offset; k < offset + m.length; k++) hidden[k] = true;
                    spans.push({
                        kind: 'image',
                        marker: '![',
                        openStart: offset,
                        openEnd: offset,
                        closeStart: offset + m.length,
                        closeEnd: offset + m.length
                    });
                    return '\uE000'.repeat(m.length);
                }
                const openStart = offset;
                const openEnd = offset + 2;
                const closeStart = openEnd + alt.length;
                const closeEnd = offset + m.length;
                for (let k = openStart; k < openEnd; k++) hidden[k] = true;
                for (let k = closeStart; k < closeEnd; k++) hidden[k] = true;
                spans.push({
                    kind: 'image-link',
                    marker: '![',
                    openStart: openStart,
                    openEnd: openEnd,
                    closeStart: closeStart,
                    closeEnd: closeEnd
                });
                return '\uE000\uE000' + alt + '\uE000'.repeat(closeEnd - closeStart);
            });

            // 3. Links — hide [ and ](dest), keep label exposed for emphasis.
            mask = mask.replace(/\[(.*?)\]\((.*?)\)/g, function (m, label, dest, offset) {
                const openStart = offset;
                const openEnd = offset + 1;
                const closeStart = openEnd + label.length;
                const closeEnd = offset + m.length;
                hidden[openStart] = true;
                for (let k = closeStart; k < closeEnd; k++) hidden[k] = true;
                spans.push({
                    kind: 'link',
                    marker: '[',
                    openStart: openStart,
                    openEnd: openEnd,
                    closeStart: closeStart,
                    closeEnd: closeEnd
                });
                return '\uE000' + label + '\uE000'.repeat(closeEnd - closeStart);
            });

            // 4. Strike & emphasis in parseInline's exact order.
            const rules = [
                { kind: 'strike', marker: '~~', re: /~~(?=\S)(.*?\S)~~/g, hasLead: false },
                { kind: 'bolditalic', marker: '***', re: /\*\*\*(?=\S)(.*?\S)\*\*\*/g, hasLead: false },
                { kind: 'bolditalic', marker: '___', re: /(^|[^\w])___(?=\S)(.*?\S)___(?!\w)/g, hasLead: true },
                { kind: 'bold', marker: '**', re: /\*\*(?=\S)(.*?\S)\*\*/g, hasLead: false },
                { kind: 'bold', marker: '__', re: /(^|[^\w])__(?=\S)(.*?\S)__(?!\w)/g, hasLead: true },
                { kind: 'italic', marker: '*', re: /\*(?=\S)(.*?\S)\*/g, hasLead: false },
                { kind: 'italic', marker: '_', re: /(^|[^\w])_(?=\S)(.*?\S)_(?!\w)/g, hasLead: true }
            ];
            for (let ri = 0; ri < rules.length; ri++) {
                const rule = rules[ri];
                mask = mask.replace(rule.re, function () {
                    const offset = arguments[arguments.length - 2];
                    const lead = rule.hasLead ? arguments[1] : '';
                    const inner = rule.hasLead ? arguments[2] : arguments[1];
                    const mLen = rule.marker.length;
                    const openStart = offset + lead.length;
                    const openEnd = openStart + mLen;
                    const closeStart = openEnd + inner.length;
                    const closeEnd = closeStart + mLen;
                    for (let k = openStart; k < openEnd; k++) hidden[k] = true;
                    for (let k = closeStart; k < closeEnd; k++) hidden[k] = true;
                    spans.push({
                        kind: rule.kind,
                        marker: rule.marker,
                        openStart: openStart,
                        openEnd: openEnd,
                        closeStart: closeStart,
                        closeEnd: closeEnd
                    });
                    return lead + '\uE000'.repeat(mLen) + inner + '\uE000'.repeat(mLen);
                });
            }

            const plainToRaw = [];
            for (let k = 0; k < n; k++) {
                if (!hidden[k]) plainToRaw.push(k);
            }
            const plainLength = plainToRaw.length;
            const ps = Math.min(plainLength, plainStart);
            const pe = Math.min(plainLength, plainEnd);
            let r0, r1;
            if (ps === pe) {
                r0 = ps < plainLength ? plainToRaw[ps] : n;
                r1 = r0;
            } else {
                r0 = plainToRaw[ps];
                r1 = plainToRaw[pe - 1] + 1;
            }
            return { r0: r0, r1: r1, plainLength: plainLength, spans: spans, plainToRaw: plainToRaw };
        }

        function getPlainOffsetsInBlock(block) {
            if (!block) return null;
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0
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
            if (!sel || !sel.rangeCount) return;
            if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;
            if (sel.isCollapsed) {
                _inlineSelCache = null;
                return;
            }
            const block = getAncestorBlock(sel.anchorNode);
            if (!block || !block.contains(sel.focusNode)) {
                _inlineSelCache = null;
                return;
            }
            const off = getPlainOffsetsInBlock(block);
            if (off && off.start !== off.end) {
                _inlineSelCache = { block: block, start: off.start, end: off.end, text: off.text };
            } else {
                _inlineSelCache = null;
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
        function applyInlineFormatToRaw(raw, plainStart, plainEnd, type, opts) {
            raw = String(raw || '');
            if (raw.indexOf('\n') >= 0) return null;
            if (plainStart > plainEnd) {
                const t = plainStart; plainStart = plainEnd; plainEnd = t;
            }
            const pref = raw.match(/^(?:#{1,6}\s+|>\s*|[ \t]*(?:[-*+]\s+(?:\[[ xX]\]\s?)?|\d+\.(?!\d)\s*))/);
            const prefix = pref ? pref[0] : '';
            let body = raw.slice(prefix.length);
            let suffix = '';
            if (prefix && /^#/.test(prefix)) {
                const closeM = body.match(/\s+#+\s*$/);
                if (closeM) {
                    suffix = closeM[0];
                    body = body.slice(0, body.length - suffix.length);
                }
            }

            function withPrefix(newBody) { return prefix + newBody + suffix; }

            if (type === 'bold' || type === 'italic' || type === 'strike') {
                // The marks model below holds text and bold/italic/strike, nothing else. Written
                // back, it deleted link addresses, images and code marks from the whole line. So
                // its answer is used only if nothing but those marks changed; otherwise only the
                // selection is touched.
                // Underscores count as text: the model writes __b__ back as **b**.
                const marksOnly = function (s) { return String(s).replace(/[*~​]/g, ''); };
                const modelled = applyMarksModelToBody(body, plainStart, plainEnd, type);
                if (marksOnly(modelled) === marksOnly(body)) return withPrefix(modelled);
                if (opts && opts.refuseIfLossy) return null;
                const m0 = type === 'bold' ? '**' : type === 'italic' ? '*' : '~~';
                const o = plainRangeToRawOffsets(body, plainStart, plainEnd);
                const spans = o.spans || [];
                const plainToRaw = o.plainToRaw || [];
                if (plainStart === plainEnd) {
                    for (let si = 0; si < spans.length; si++) {
                        const s = spans[si];
                        if (s.kind === 'code' && s.openEnd <= o.r0 && o.r0 <= s.closeStart) return null;
                    }
                    return withPrefix(body.slice(0, o.r0) + m0 + m0 + body.slice(o.r0));
                }
                const ps = Math.max(0, Math.min(plainToRaw.length, plainStart | 0));
                const pe = Math.max(ps, Math.min(plainToRaw.length, plainEnd | 0));
                let tps = ps, tpe = pe;
                while (tps < tpe && /\s/.test(body.charAt(plainToRaw[tps]))) tps++;
                while (tpe > tps && /\s/.test(body.charAt(plainToRaw[tpe - 1]))) tpe--;
                if (tps >= tpe) return null;
                let r0 = plainToRaw[tps];
                let r1 = plainToRaw[tpe - 1] + 1;
                for (let si = 0; si < spans.length; si++) {
                    const s = spans[si];
                    if (s.kind === 'code' && s.openEnd <= r0 && r1 <= s.closeStart
                        && (r0 > s.openEnd || r1 < s.closeStart)) {
                        return null;
                    }
                }
                let changed = true;
                while (changed) {
                    changed = false;
                    for (let si = 0; si < spans.length; si++) {
                        const s = spans[si];
                        if (s.kind === 'code' || s.kind === 'image') {
                            if (s.openStart < r1 && s.closeEnd > r0) {
                                const n0 = Math.min(r0, s.openStart);
                                const n1 = Math.max(r1, s.closeEnd);
                                if (n0 !== r0 || n1 !== r1) { r0 = n0; r1 = n1; changed = true; }
                            }
                            continue;
                        }
                        if (s.openEnd <= r0 && r1 <= s.closeStart) continue;
                        if (s.openStart < r0 && s.closeEnd > r0 && s.closeStart < r1) {
                            const betweenOpen = body.slice(s.openEnd, r0);
                            if (s.openEnd <= r0 && !/\S/.test(betweenOpen)) {
                                r0 = s.openStart;
                                changed = true;
                                continue;
                            }
                        }
                        if (s.openStart < r1 && s.closeEnd > r1 && r0 < s.openEnd) {
                            const betweenClose = body.slice(r1, s.closeStart);
                            if (r1 <= s.closeStart && !/\S/.test(betweenClose)) {
                                r1 = s.closeEnd;
                                changed = true;
                                continue;
                            }
                        }
                    }
                }
                const sel = body.slice(r0, r1);
                let around = body.slice(Math.max(0, r0 - m0.length), r0) === m0 && body.slice(r1, r1 + m0.length) === m0;
                if (around && m0 === '*') {
                    const singleStar = (r0 < 2 || body[r0 - 2] !== '*') && body[r1 + 1] !== '*';
                    const tripleStar = r0 >= 3 && body.slice(r0 - 3, r0) === '***' && body.slice(r1, r1 + 3) === '***';
                    around = singleStar || tripleStar;
                } else if (around && m0 === '**') {
                    const exactDouble = (r0 < 3 || body[r0 - 3] !== '*') && body[r1 + 2] !== '*';
                    const tripleStar = r0 >= 3 && body.slice(r0 - 3, r0) === '***' && body.slice(r1, r1 + 3) === '***';
                    around = exactDouble || tripleStar;
                }
                if (around) return withPrefix(body.slice(0, r0 - m0.length) + sel + body.slice(r1 + m0.length));
                const sp = sel.match(/^(\s*)([\s\S]*?)(\s*)$/);
                return withPrefix(body.slice(0, r0) + sp[1] + m0 + sp[2] + m0 + sp[3] + body.slice(r1));
            }
            return applyInlineFormatRest(body, plainStart, plainEnd, type, withPrefix);
        }

        /** The marks model: bold, italic and strike toggled over a plain-text range of a line. */
        function applyMarksModelToBody(body, plainStart, plainEnd, type) {
            const withPrefix = function (x) { return x; };
            {
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
        }

        function applyInlineFormatRest(body, plainStart, plainEnd, type, withPrefix) {
            const offs = plainRangeToRawOffsets(body, plainStart, plainEnd);
            const r0 = offs.r0, r1 = offs.r1;
            const spans = offs.spans || [];
            const plainToRaw = offs.plainToRaw || [];

            function expandSpanBounds(tr0, tr1) {
                let c0 = tr0, c1 = tr1;
                let changed = true;
                while (changed) {
                    changed = false;
                    for (let si = 0; si < spans.length; si++) {
                        const s = spans[si];
                        if (s.kind === 'code' || s.kind === 'image') {
                            if (s.openStart < c1 && s.closeEnd > c0) {
                                const n0 = Math.min(c0, s.openStart);
                                const n1 = Math.max(c1, s.closeEnd);
                                if (n0 !== c0 || n1 !== c1) { c0 = n0; c1 = n1; changed = true; }
                            }
                            continue;
                        }
                        if (s.openEnd <= c0 && c1 <= s.closeStart) continue;
                        if (s.openStart < c0 && s.closeEnd > c0 && s.closeStart < c1) {
                            const betweenOpen = body.slice(s.openEnd, c0);
                            if (s.openEnd <= c0 && !/\S/.test(betweenOpen)) {
                                c0 = s.openStart;
                                changed = true;
                                continue;
                            }
                        }
                        if (s.openStart < c1 && s.closeEnd > c1 && c0 < s.openEnd) {
                            const betweenClose = body.slice(c1, s.closeStart);
                            if (c1 <= s.closeStart && !/\S/.test(betweenClose)) {
                                c1 = s.closeEnd;
                                changed = true;
                                continue;
                            }
                        }
                    }
                }
                return { c0: c0, c1: c1 };
            }

            function splitSpanCrossings(c0, c1, stripLinkMid) {
                let before = body.slice(0, c0);
                let mid = body.slice(c0, c1);
                let after = body.slice(c1);
                const crossStart = [];
                const crossEnd = [];
                for (let si = 0; si < spans.length; si++) {
                    const s = spans[si];
                    if (s.kind === 'code' || s.kind === 'image') continue;
                    if (s.openStart < c0 && c0 < s.closeStart && s.closeStart < c1) {
                        crossStart.push(s);
                    } else if (c0 <= s.openStart && s.openStart < c1 && c1 < s.closeStart) {
                        crossEnd.push(s);
                    }
                }
                crossStart.sort(function (a, b) { return b.openStart - a.openStart; });
                for (let si = 0; si < crossStart.length; si++) {
                    const s = crossStart[si];
                    const openStr = body.slice(s.openStart, s.openEnd);
                    const closeStr = body.slice(s.closeStart, s.closeEnd);
                    const mb = before.match(/^([\s\S]*?)(\s*)$/);
                    before = mb[1] + closeStr + mb[2];
                    if (stripLinkMid && (s.kind === 'link' || s.kind === 'image-link')) {
                        const relClose = s.closeStart - c0;
                        const relEnd = s.closeEnd - c0;
                        if (relClose >= 0 && relEnd <= mid.length) {
                            mid = mid.slice(0, relClose) + mid.slice(relEnd);
                        }
                    } else {
                        const mm = mid.match(/^(\s*)([\s\S]*)$/);
                        mid = mm[1] + openStr + mm[2];
                    }
                }
                crossEnd.sort(function (a, b) { return a.closeStart - b.closeStart; });
                for (let si = 0; si < crossEnd.length; si++) {
                    const s = crossEnd[si];
                    const openStr = body.slice(s.openStart, s.openEnd);
                    const closeStr = body.slice(s.closeStart, s.closeEnd);
                    if (stripLinkMid && (s.kind === 'link' || s.kind === 'image-link')) {
                        const relOpen = s.openStart - c0;
                        const relOpenEnd = s.openEnd - c0;
                        if (relOpen >= 0 && relOpenEnd <= mid.length) {
                            mid = mid.slice(0, relOpen) + mid.slice(relOpenEnd);
                        }
                    } else {
                        const mm = mid.match(/^([\s\S]*?)(\s*)$/);
                        mid = mm[1] + closeStr + mm[2];
                    }
                    const ma = after.match(/^(\s*)([\s\S]*)$/);
                    after = ma[1] + openStr + ma[2];
                }
                return { before: before, mid: mid, after: after };
            }

            if (type === 'link') {
                if (plainStart === plainEnd) {
                    for (let si = 0; si < spans.length; si++) {
                        const s = spans[si];
                        if (s.kind === 'code' && s.openEnd <= r0 && r0 <= s.closeStart) return null;
                    }
                    const lt0 = (_pendingLink && _pendingLink.text) || 'Link Text';
                    const lu0 = (_pendingLink && _pendingLink.url) || 'https://';
                    return withPrefix(body.slice(0, r0) + '[' + lt0 + '](' + lu0 + ')' + body.slice(r0));
                }

                const ps = Math.max(0, Math.min(plainToRaw.length, plainStart | 0));
                const pe = Math.max(ps, Math.min(plainToRaw.length, plainEnd | 0));
                let tps = ps, tpe = pe;
                while (tps < tpe && /\s/.test(body.charAt(plainToRaw[tps]))) tps++;
                while (tpe > tps && /\s/.test(body.charAt(plainToRaw[tpe - 1]))) tpe--;
                if (tps >= tpe) return null;
                const tr0 = plainToRaw[tps];
                const tr1 = plainToRaw[tpe - 1] + 1;

                // Existing link matching or enclosing selection.
                for (let si = 0; si < spans.length; si++) {
                    const s = spans[si];
                    if (s.kind !== 'link' && s.kind !== 'image-link') continue;
                    if ((r0 === s.openEnd && r1 === s.closeStart) || (tr0 === s.openEnd && tr1 === s.closeStart)) {
                        if (!_pendingLink) {
                            return withPrefix(body.slice(0, s.openStart) + body.slice(s.openEnd, s.closeStart) + body.slice(s.closeEnd));
                        }
                        const lt1 = _pendingLink.text || body.slice(s.openEnd, s.closeStart);
                        const lu1 = _pendingLink.url || 'https://';
                        return withPrefix(body.slice(0, s.openStart) + '[' + lt1 + '](' + lu1 + ')' + body.slice(s.closeEnd));
                    }
                    if (s.openEnd <= tr0 && tr1 <= s.closeStart) {
                        const destPart = body.slice(s.closeStart, s.closeEnd);
                        const left = body.slice(s.openEnd, tr0);
                        const midText = body.slice(tr0, tr1);
                        const right = body.slice(tr1, s.closeStart);
                        const lm = left.match(/^([\s\S]*?)(\s*)$/);
                        const rm = right.match(/^(\s*)([\s\S]*)$/);
                        const leftOut = lm[1] ? '[' + lm[1] + destPart + lm[2] : left;
                        const rightOut = rm[2] ? rm[1] + '[' + rm[2] + destPart : right;
                        const lt2 = (_pendingLink && _pendingLink.text) || midText;
                        const lu2 = (_pendingLink && _pendingLink.url) || 'https://';
                        return withPrefix(body.slice(0, s.openStart) + leftOut + '[' + lt2 + '](' + lu2 + ')' + rightOut + body.slice(s.closeEnd));
                    }
                }

                // Existing code span matching or enclosing selection.
                for (let si = 0; si < spans.length; si++) {
                    const s = spans[si];
                    if (s.kind !== 'code') continue;
                    if ((r0 === s.openEnd && r1 === s.closeStart) || (tr0 === s.openEnd && tr1 === s.closeStart)) {
                        const codeRaw = body.slice(s.openStart, s.closeEnd);
                        const lt3 = (_pendingLink && _pendingLink.text) || codeRaw;
                        const lu3 = (_pendingLink && _pendingLink.url) || 'https://';
                        return withPrefix(body.slice(0, s.openStart) + '[' + lt3 + '](' + lu3 + ')' + body.slice(s.closeEnd));
                    }
                    if (s.openEnd <= tr0 && tr1 <= s.closeStart) {
                        const left = body.slice(s.openEnd, tr0);
                        const midText = body.slice(tr0, tr1);
                        const right = body.slice(tr1, s.closeStart);
                        const lm = left.match(/^([\s\S]*?)(\s*)$/);
                        const rm = right.match(/^(\s*)([\s\S]*)$/);
                        const leftOut = lm[1] ? '`' + lm[1] + '`' + lm[2] : left;
                        const rightOut = rm[2] ? rm[1] + '`' + rm[2] + '`' : right;
                        const lt4 = (_pendingLink && _pendingLink.text) || midText;
                        const lu4 = (_pendingLink && _pendingLink.url) || 'https://';
                        return withPrefix(body.slice(0, s.openStart) + leftOut + '[' + lt4 + '](' + lu4 + ')' + rightOut + body.slice(s.closeEnd));
                    }
                }

                const bndL = expandSpanBounds(tr0, tr1);
                const splitL = splitSpanCrossings(bndL.c0, bndL.c1, true);
                const matchL = splitL.mid.match(/^(\s*)([\s\S]*?)(\s*)$/);
                const lt = (_pendingLink && _pendingLink.text) || (matchL && matchL[2]) || 'Link Text';
                const lu = (_pendingLink && _pendingLink.url) || 'https://';
                return withPrefix(splitL.before + matchL[1] + '[' + lt + '](' + lu + ')' + matchL[3] + splitL.after);
            }

            if (type === 'code') {
                if (plainStart === plainEnd) {
                    for (let si = 0; si < spans.length; si++) {
                        const s = spans[si];
                        if (s.kind === 'code' && s.openEnd <= r0 && r0 <= s.closeStart) return null;
                    }
                    return withPrefix(body.slice(0, r0) + '``' + body.slice(r0));
                }

                // Trim outer whitespace in plain coordinates so trailing spaces stay outside backticks.
                const ps = Math.max(0, Math.min(plainToRaw.length, plainStart | 0));
                const pe = Math.max(ps, Math.min(plainToRaw.length, plainEnd | 0));
                let tps = ps, tpe = pe;
                while (tps < tpe && /\s/.test(body.charAt(plainToRaw[tps]))) tps++;
                while (tpe > tps && /\s/.test(body.charAt(plainToRaw[tpe - 1]))) tpe--;
                if (tps >= tpe) return null;
                const tr0 = plainToRaw[tps];
                const tr1 = plainToRaw[tpe - 1] + 1;

                // Toggle OFF when selection matches an existing code span, or split inside one.
                for (let si = 0; si < spans.length; si++) {
                    const s = spans[si];
                    if (s.kind !== 'code') continue;
                    if ((r0 === s.openEnd && r1 === s.closeStart) || (tr0 === s.openEnd && tr1 === s.closeStart)) {
                        return withPrefix(body.slice(0, s.openStart) + body.slice(s.openEnd, s.closeStart) + body.slice(s.closeEnd));
                    }
                    if (s.openEnd <= tr0 && tr1 <= s.closeStart) {
                        const left = body.slice(s.openEnd, tr0);
                        const mid = body.slice(tr0, tr1);
                        const right = body.slice(tr1, s.closeStart);
                        const lm = left.match(/^([\s\S]*?)(\s*)$/);
                        const rm = right.match(/^(\s*)([\s\S]*)$/);
                        const leftOut = lm[1] ? '`' + lm[1] + '`' + lm[2] : left;
                        const rightOut = rm[2] ? rm[1] + '`' + rm[2] + '`' : right;
                        return withPrefix(body.slice(0, s.openStart) + leftOut + mid + rightOut + body.slice(s.closeEnd));
                    }
                }

                const bnd = expandSpanBounds(tr0, tr1);
                const split = splitSpanCrossings(bnd.c0, bnd.c1, false);
                const cleanMid = split.mid.replace(/`/g, '');
                const match = cleanMid.match(/^(\s*)([\s\S]*?)(\s*)$/);
                if (!match || !match[2]) return null;
                return withPrefix(split.before + match[1] + '`' + match[2] + '`' + match[3] + split.after);
            }

            return null;
        }

        function tryApplyInlineFormat(type) {
            if (type !== 'bold' && type !== 'italic' && type !== 'code' && type !== 'link' && type !== 'strike') return false;

            if (type === 'link' && !_pendingLink) {
                if (typeof openLinkModal === 'function') openLinkModal(null);
                return true;
            }

            // Source mode
            if (state.mode === 'source') {
                if (!sourceEditor) return false;
                const range = takeSourceFormatSelection();
                let start = range.start;
                let end = range.end;
                const full = sourceEditor.value || '';
                const stampSrcInlineCaret = function (redoPos, undoPos, isEndOfBlock) {
                    if (typeof HistoryManager !== 'undefined' && typeof HistoryManager.setTopCarets === 'function') {
                        const rc = { mode: 'source', start: redoPos, end: redoPos, exact: true };
                        const uc = { mode: 'source', start: undoPos, end: undoPos, exact: true };
                        if (isEndOfBlock) { rc.endOfBlock = true; uc.endOfBlock = true; }
                        HistoryManager.setTopCarets(rc, uc);
                    }
                    if (sourceEditor && sourceEditor.selectionStart === sourceEditor.selectionEnd) {
                        _sourceFormatSel = null;
                    }
                    if (typeof rememberEditorCaret === 'function') rememberEditorCaret();
                };

                if (start === end && type !== 'link') {
                    let lineStart = start;
                    while (lineStart > 0 && full.charAt(lineStart - 1) !== '\n') lineStart--;
                    let lineEnd = start;
                    while (lineEnd < full.length && full.charAt(lineEnd) !== '\n') lineEnd++;
                    const line = full.slice(lineStart, lineEnd);
                    let inFence = false;
                    full.substring(0, lineStart).split('\n').forEach(function (l) {
                        if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
                    });
                    if (inFence || /^\s*(```|~~~)/.test(line) || !String(line).trim()
                        || (typeof isInlineUnmarkableRaw === 'function' && isInlineUnmarkableRaw(line))) {
                        return true;
                    }
                    const next = transformRawForFormat(line, type, { wholeLines: true });
                    if (next == null || next === line) return true;
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(next, lineStart, lineEnd, 'end');
                    // Turned on: the caret goes inside the closing marker, so what is typed
                    // next is in the new format -- as in Preview, where it was already so.
                    const closeMark = { bold: '**', italic: '*', strike: '~~', code: '`' }[type] || '';
                    let caretAt = lineStart + next.length;
                    if (closeMark && next.length > line.length && next.slice(-closeMark.length) === closeMark) {
                        caretAt -= closeMark.length;
                        try { sourceEditor.setSelectionRange(caretAt, caretAt); } catch (eCa) {}
                    }
                    resizeSourceEditor();
                    updateStats();
                    HistoryManager.commitEdit();
                    stampSrcInlineCaret(caretAt, lineEnd, true);
                    return true;
                }

                // Multi-line: format each hard line (never wrap the whole span in one **…**).
                // Cross-line **…** splits across blocks and produces marker soup like r**ow 2001*.
                if (full.slice(start, end).indexOf('\n') >= 0
                    && (type === 'bold' || type === 'italic' || type === 'strike' || type === 'code'
                        || (type === 'link' && _pendingLink && _pendingLink.url))) {
                    let s = start;
                    let e = end;
                    while (s > 0 && full.charAt(s - 1) !== '\n') s--;
                    while (e < full.length && full.charAt(e) !== '\n') e++;
                    const lines = full.substring(s, e).split('\n');
                    // Code inside a fence is not marked: its lines got "**" written into them.
                    let inFence = false;
                    full.substring(0, s).split('\n').forEach(function (l) { if (/^\s*(```|~~~)/.test(l)) inFence = !inFence; });
                    const focus = {};
                    lines.forEach(function (line, i) {
                        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
                        if (!inFence && String(line).trim()) focus[i] = true;
                    });
                    const keys = Object.keys(focus).map(Number);
                    if (!keys.length) return true;
                    // What is selected, not the whole of the first and last lines (Ed, 2026-11-14),
                    // by Preview's own rule (inlineMarksForSelectedLines), so the two views agree.
                    // The selection's ends go in as the plain text before and after it.
                    const prefRe = /^(?:#{1,6}\s+|>\s*|[ \t]*(?:[-*+]\s+(?:\[[ xX]\]\s?)?|\d+\.(?!\d)\s*))/;
                    const bodyOf = function (raw) {
                        const pre = (raw.match(prefRe) || [''])[0];
                        let body = raw.slice(pre.length);
                        if (pre && /^#/.test(pre)) { const cm = body.match(/\s+#+\s*$/); if (cm) body = body.slice(0, body.length - cm[0].length); }
                        return { pre: pre, body: body };
                    };
                    const plainIndexAt = function (raw, rawOff) {
                        const bo = bodyOf(raw);
                        const p2r = plainRangeToRawOffsets(bo.body, 0, 0).plainToRaw || [];
                        const rel = Math.max(0, rawOff - bo.pre.length);
                        let p = 0;
                        while (p < p2r.length && p2r[p] < rel) p++;
                        return { p: p, plain: plainAndMarksFromMarkdown(bo.body).plain };
                    };
                    const firstK = keys[0], lastK = keys[keys.length - 1];
                    const startCol = start - s;
                    let lastLineStart = 0;
                    for (let i = 0; i < lines.length - 1; i++) lastLineStart += lines[i].length + 1;
                    const endCol = end - (s + lastLineStart);
                    const fp = firstK === 0 ? plainIndexAt(lines[0], startCol) : null;
                    const lp = lastK === lines.length - 1 ? plainIndexAt(lines[lastK], endCol) : null;
                    const savedFz = typeof _mbSelFreeze !== 'undefined' ? _mbSelFreeze : null;
                    let plan = null;
                    try {
                        _mbSelFreeze = {
                            fromIdx: firstK, toIdx: lastK,
                            prefix: fp ? fp.plain.slice(0, fp.p) : '',
                            suffix: lp ? lp.plain.slice(lp.p) : ''
                        };
                        plan = inlineMarksForSelectedLines(lines, focus, type);
                    } finally { _mbSelFreeze = savedFz; }
                    if (!plan || !Object.keys(plan).length) return true;
                    const outLines = lines.map(function (line, i) {
                        return Object.prototype.hasOwnProperty.call(plan, i) ? String(plan[i]) : line;
                    });
                    const out = outLines.join('\n');
                    // The caret goes to the end of what was marked on the last line, inside its
                    // closing marker, as in Preview; nothing is left selected to be typed over.
                    let caret = s + out.length;
                    try {
                        let off = 0;
                        for (let i = 0; i < lastK; i++) off += outLines[i].length + 1;
                        const bo = bodyOf(outLines[lastK]);
                        const p2r = plainRangeToRawOffsets(bo.body, 0, 0).plainToRaw || [];
                        const pEndPlain = lp ? lp.p : p2r.length;
                        let inBody = pEndPlain > 0 && p2r.length >= pEndPlain ? p2r[pEndPlain - 1] + 1 : 0;
                        // After a link, past its address: typing goes on outside it, as in Preview.
                        if (type === 'link') {
                            const close = bo.body.indexOf(')', inBody);
                            if (close >= 0) inBody = close + 1;
                        }
                        caret = s + off + bo.pre.length + inBody;
                    } catch (eCaret) {}
                    HistoryManager.beginEdit();
                    withSourceScrollPreserved(function () {
                        sourceEditor.setRangeText(out, s, e, 'end');
                        sourceEditor.setSelectionRange(caret, caret);
                    });
                    _sourceFormatSel = null;
                    resizeSourceEditor();
                    withSourceScrollPreserved(function () {});
                    updateStats();
                    HistoryManager.commitEdit();
                    stampSrcInlineCaret(caret, end, false);
                    return true;
                }

                let open = '', close = '';
                if (type === 'bold') { open = '**'; close = '**'; }
                else if (type === 'italic') { open = '*'; close = '*'; }
                else if (type === 'code') { open = '`'; close = '`'; }
                else if (type === 'strike') { open = '~~'; close = '~~'; }
                else if (type === 'link') {
                    const inner0 = full.slice(start, end) || 'Link Text';
                    const inner = (_pendingLink && _pendingLink.text) || inner0;
                    const lu = (_pendingLink && _pendingLink.url) || 'https://';
                    const linkRep = '[' + inner + '](' + lu + ')';
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(linkRep, start, end, 'select');
                    // The link's text stays selected, not its brackets and address, as in Preview.
                    try { sourceEditor.setSelectionRange(start + 1, start + 1 + inner.length); } catch (eLs) {}
                    _sourceFormatSel = { start: start + 1, end: start + 1 + inner.length };
                    resizeSourceEditor();
                    updateStats();
                    HistoryManager.commitEdit();
                    stampSrcInlineCaret(start + 1 + inner.length, end, false);
                    return true;
                }
                let inner = full.slice(start, end);
                let rep;
                if (type === 'bold' && /^\*\*([\s\S]*)\*\*$/.test(inner) && inner.slice(2, -2).indexOf('**') < 0)
                    rep = inner.slice(2, -2);
                else if (type === 'italic' && /^\*([\s\S]*)\*$/.test(inner) && !/^\*\*/.test(inner) && !/\*\*$/.test(inner)
                    && inner.slice(1, -1).replace(/\*\*/g, '').indexOf('*') < 0)
                    rep = inner.slice(1, -1);
                else if (type === 'code' && /^`([^`]*)`$/.test(inner))
                    rep = inner.slice(1, -1);
                else if (type === 'strike' && /^~~([\s\S]*)~~$/.test(inner) && inner.slice(2, -2).indexOf('~~') < 0)
                    rep = inner.slice(2, -2);
                else if (type === 'bold' && start >= 2 && full.slice(start - 2, start) === '**' && full.slice(end, end + 2) === '**'
                    && inner.indexOf('**') < 0) {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 2, end + 2, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    stampSrcInlineCaret((start - 2) + inner.length, end + 2, false);
                    return true;
                } else if (type === 'strike' && start >= 2 && full.slice(start - 2, start) === '~~' && full.slice(end, end + 2) === '~~'
                    && inner.indexOf('~~') < 0) {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 2, end + 2, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    stampSrcInlineCaret((start - 2) + inner.length, end + 2, false);
                    return true;
                } else if (type === 'code' && start >= 1 && full[start - 1] === '`' && full[end] === '`'
                    && inner.indexOf('`') < 0) {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 1, end + 1, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    stampSrcInlineCaret((start - 1) + inner.length, end + 1, false);
                    return true;
                } else if (type === 'italic' && start >= 1 && full[start - 1] === '*' && full[end] === '*'
                    && (start < 2 || full[start - 2] !== '*') && full[end + 1] !== '*'
                    && inner.replace(/\*\*/g, '').indexOf('*') < 0) {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 1, end + 1, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    stampSrcInlineCaret((start - 1) + inner.length, end + 1, false);
                    return true;
                } else if (type === 'bold' || type === 'italic' || type === 'strike') {
                    // Single-line partial: marks model on that hard line only
                    let lineStart = start;
                    while (lineStart > 0 && full.charAt(lineStart - 1) !== '\n') lineStart--;
                    let lineEnd = start;
                    while (lineEnd < full.length && full.charAt(lineEnd) !== '\n') lineEnd++;
                    const line = full.slice(lineStart, lineEnd);
                    // These are positions in the raw line, and the model counts visible text:
                    // map raw indices using plainRangeToRawOffsets so literal * / ~ / _ count accurately.
                    const prefMatch = line.match(/^(?:#{1,6}\s+|>\s*|[ \t]*(?:[-*+]\s+(?:\[[ xX]\]\s?)?|\d+\.(?!\d)\s*))/);
                    const prefixLen = prefMatch ? prefMatch[0].length : 0;
                    let lineBody = line.slice(prefixLen);
                    if (prefMatch && /^#/.test(prefMatch[0])) {
                        const closeM = lineBody.match(/\s+#+\s*$/);
                        if (closeM) lineBody = lineBody.slice(0, lineBody.length - closeM[0].length);
                    }
                    const lineOffs = plainRangeToRawOffsets(lineBody, 0, 0);
                    const linePlainToRaw = lineOffs.plainToRaw || [];
                    const plainAt = function (rawAt) {
                        const rel = Math.max(0, rawAt - prefixLen);
                        let p = 0;
                        while (p < linePlainToRaw.length && linePlainToRaw[p] < rel) p++;
                        return p;
                    };
                    const pStart = plainAt(start - lineStart);
                    const pEnd = plainAt(end - lineStart);
                    const rawNext = applyInlineFormatToRaw(line, pStart, pEnd, type, { refuseIfLossy: true });
                    if (rawNext != null) {
                        const np = (rawNext.match(/^(?:#{1,6}\s+|>\s*|[ \t]*(?:[-*+]\s+(?:\[[ xX]\]\s?)?|\d+\.(?!\d)\s*))/) || [''])[0];
                        let nextBody = rawNext.slice(np.length);
                        if (np && /^#/.test(np)) {
                            const cm2 = nextBody.match(/\s+#+\s*$/);
                            if (cm2) nextBody = nextBody.slice(0, nextBody.length - cm2[0].length);
                        }
                        const nextP2r = plainRangeToRawOffsets(nextBody, 0, 0).plainToRaw || [];
                        // The same words stay selected, inside their markers, as in Preview:
                        // typing over them keeps the format, and the key again takes it off.
                        // (Selecting the markers too made typing drop the bold in Source only.)
                        const rawStartInNext = pStart < nextP2r.length ? nextP2r[pStart] : nextBody.length;
                        const rawEndInNext = (pEnd > pStart && (pEnd - 1) < nextP2r.length)
                            ? (nextP2r[pEnd - 1] + 1) : rawStartInNext;
                        const selStart = Math.min(lineStart + rawNext.length, lineStart + np.length + rawStartInNext);
                        const selEnd = Math.max(selStart, Math.min(lineStart + rawNext.length, lineStart + np.length + rawEndInNext));
                        HistoryManager.beginEdit();
                        withSourceScrollPreserved(function () {
                            sourceEditor.setRangeText(rawNext, lineStart, lineEnd, 'end');
                            sourceEditor.setSelectionRange(selStart, selEnd);
                        });
                        resizeSourceEditor();
                        updateStats();
                        HistoryManager.commitEdit();
                        _sourceFormatSel = (selStart !== selEnd) ? { start: selStart, end: selEnd } : null;
                        stampSrcInlineCaret(selEnd, end, false);
                        return true;
                    }
                    rep = open + inner + close;
                } else if (type === 'code') {
                    rep = open + inner.replace(/`/g, '') + close;
                } else {
                    rep = open + inner + close;
                }
                HistoryManager.beginEdit();
                sourceSetRangeTextPreserveScroll(rep, start, end, 'select');
                // Wrapped: the words stay selected inside their markers, as in Preview.
                let repSelEnd = start + rep.length;
                if (open && rep.length > inner.length && rep.slice(0, open.length) === open && rep.slice(-close.length) === close) {
                    repSelEnd = start + rep.length - close.length;
                    try { sourceEditor.setSelectionRange(start + open.length, repSelEnd); } catch (eRs) {}
                    _sourceFormatSel = { start: start + open.length, end: repSelEnd };
                }
                resizeSourceEditor();
                updateStats();
                HistoryManager.commitEdit();
                stampSrcInlineCaret(repSelEnd, end, false);
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
            const liveSel = window.getSelection();
            const liveTargets = getSelectedBlocks();
            if (liveSel && liveSel.rangeCount && !liveSel.isCollapsed
                && liveSel.anchorNode && editor.contains(liveSel.anchorNode)
                && liveTargets.length === 1) {
                const liveBlock = liveTargets[0];
                const liveOff = getPlainOffsetsInBlock(liveBlock);
                if (liveOff && liveOff.start !== liveOff.end) {
                    block = liveBlock;
                    offsets = liveOff;
                }
            }
            if (!block && _inlineSelCache && _inlineSelCache.block && editor.contains(_inlineSelCache.block)) {
                block = _inlineSelCache.block;
                offsets = { start: _inlineSelCache.start, end: _inlineSelCache.end, text: _inlineSelCache.text };
            } else if (!block && liveTargets.length === 1) {
                block = liveTargets[0];
                offsets = getPlainOffsetsInBlock(block);
            }
            if (!block || !offsets || (offsets.start === offsets.end && type !== 'link')) return false;
            if (block.querySelector && (block.querySelector('pre') || block.querySelector('hr') || block.querySelector('.tz-alert'))) return false;
            // Across table cells there is no one run of text to mark; leave the selection
            // alone (rebuilding it from offsets below dropped it, and the caret with it).
            try {
                const sT = window.getSelection();
                if (block.querySelector('table') && sT && sT.rangeCount && typeof rangeCrossesTableCells === 'function'
                    && rangeCrossesTableCells(sT.getRangeAt(0))) return false;
            } catch (eT) {}

            // Bold / italic / strike: apply on the live DOM first, then serialize → raw.
            // Raw-only applyInlineFormatToRaw fails when the selection sits *inside* a wider
            // ***…*** / **…** span (common after nested toolbar use): Source gains extra **
            // but Preview already looked bold, so nothing appears to change. execCommand
            // toggles the visual marks the user actually sees; tree-walk serialize keeps
            // Source in sync.
            if (type === 'bold' || type === 'italic' || type === 'strike') {
                const prevRaw = block.getAttribute('data-raw') || getBlockRaw(block) || '';
                // Looked at before the selection is rebuilt from offsets, which count across
                // a table's cells and may not land back in the same one.
                const wholeDel = function () {
                    if (type !== 'strike') return null;
                    try {
                        const sr = window.getSelection().getRangeAt(0);
                        const n = sr.startContainer.nodeType === 3 ? sr.startContainer.parentElement : sr.startContainer;
                        const del = n && n.closest ? n.closest('del,s,strike') : null;
                        return del && block.contains(del) && del.contains(sr.endContainer) && sr.toString() === del.textContent ? del : null;
                    } catch (eU) { return null; }
                };
                const delBefore = wholeDel();
                focusEditorNoScroll();
                if (!delBefore) selectPlainRangeInBlock(block, offsets.start, offsets.end);
                const cmd = type === 'bold' ? 'bold'
                    : type === 'italic' ? 'italic'
                    : 'strikeThrough';
                let domOk = false;
                // The browser's strikeThrough cannot take off the <del> this app draws, and the
                // no-op sent it to the raw fallback. A selection that is the whole <del> is
                // unwrapped here, which also works in a table cell.
                let unwrappedStrike = false;
                const del = delBefore || wholeDel();
                if (del) {
                    while (del.firstChild) del.parentNode.insertBefore(del.firstChild, del);
                    del.parentNode.removeChild(del);
                    unwrappedStrike = true;
                }
                if (!unwrappedStrike) {
                    try { domOk = document.execCommand(cmd, false, null); } catch (eC) { domOk = false; }
                }

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
                        // Not on a table or fence: it counts offsets through the whole block, and
                        // wrote ~~ into a table's separator row.
                        const split = prevRaw.indexOf('\n') >= 0 ? null : splitInteriorInlineFormat(prevRaw, offsets.start, offsets.end, type);
                        if (split != null && split !== prevRaw) applied = split;
                    }
                }
                if (applied == null) {
                    // execCommand may have mutated the DOM without a serializable change —
                    // restore from the pre-click raw so Preview and data-raw stay aligned.
                    try { renderBlockPreview(block, prevRaw); } catch (eR) {}
                    return false;
                }

                // The mark may change; the words shown may not. A selection that starts inside a
                // link's text and runs past it came back as "[a **b**](u) ****c": stars on the
                // page. If the result does not read as the line did, mark the range the
                // checked way, or leave the line as it was.
                if (prevRaw.indexOf('\n') < 0 && typeof markRangeInLine === 'function') {
                    try {
                        const preRe = /^[ \t]*(#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]?\]\s+)?|\d+\.\s+)/;
                        const words = function (raw) {
                            const p = (String(raw).match(preRe) || [''])[0];
                            return p + '\n' + plainAndMarksFromMarkdown(String(raw).slice(p.length)).plain.replace(/\s+/g, ' ').trim();
                        };
                        if (words(applied) !== words(prevRaw)) {
                            const p0 = (prevRaw.match(preRe) || [''])[0];
                            const body0 = prevRaw.slice(p0.length);
                            const pm0 = plainAndMarksFromMarkdown(body0);
                            let allOn = true, any = false;
                            for (let c = offsets.start; c < offsets.end && c < pm0.plain.length; c++) {
                                if (/\s/.test(pm0.plain.charAt(c))) continue;
                                any = true;
                                if (!(pm0.marks[c] && pm0.marks[c][type])) { allOn = false; break; }
                            }
                            const alt = any ? markRangeInLine(body0, offsets.start, offsets.end, type, !allOn) : null;
                            if (alt == null) {
                                try { renderBlockPreview(block, prevRaw); } catch (eR2) {}
                                return true;
                            }
                            applied = p0 + alt;
                            // Back to the line as it was before the attempt above, so the
                            // change is one undo step from there.
                            try { renderBlockPreview(block, prevRaw); } catch (eR3) {}
                        }
                    } catch (eW) {}
                }

                return commitInlineFormatToBlock(block, applied, offsets);
            }

            // code / link: single-cell table path or normal block raw-marker path
            if (block.querySelector && block.querySelector('table')) {
                if (typeof tableCellMap !== 'function' || typeof parseTableMarkdown !== 'function' || typeof formatTableKeeping !== 'function') return false;
                const rawTable = getBlockRaw(block);
                const model = parseTableMarkdown(rawTable);
                if (!model) return false;
                const cells = tableCellMap(block);
                const hit = cells.find(function (m) {
                    return offsets.start >= m.start && offsets.end <= m.start + m.len;
                });
                if (!hit) return false;
                const cellRaw = hit.row === 0
                    ? (model.header[hit.col] != null ? model.header[hit.col] : '')
                    : (model.rows[hit.row - 1] && model.rows[hit.row - 1][hit.col] != null ? model.rows[hit.row - 1][hit.col] : '');
                const nextCell = applyInlineFormatToRaw(cellRaw, offsets.start - hit.start, offsets.end - hit.start, type);
                if (nextCell == null || nextCell === cellRaw) return false;
                if (hit.row === 0) model.header[hit.col] = nextCell;
                else if (model.rows[hit.row - 1]) model.rows[hit.row - 1][hit.col] = nextCell;
                const nextTable = formatTableKeeping(model, rawTable);
                if (!nextTable || nextTable === rawTable) return false;
                const oldCellPlainLen = plainRangeToRawOffsets(cellRaw, 0, 0).plainLength;
                const newCellPlainLen = plainRangeToRawOffsets(nextCell, 0, 0).plainLength;
                const adjTableOffsets = {
                    start: offsets.start,
                    end: Math.max(offsets.start, offsets.end + (newCellPlainLen - oldCellPlainLen)),
                    text: offsets.text
                };
                return commitInlineFormatToBlock(block, nextTable, adjTableOffsets);
            }
            const raw = getBlockRaw(block);
            const next = applyInlineFormatToRaw(raw, offsets.start, offsets.end, type);
            if (next == null || next === raw) return false;

            const stripInlineAffixes = function (r) {
                const s = String(r || '');
                const pm = s.match(/^(?:#{1,6}\s+|>\s*|[ \t]*(?:[-*+]\s+(?:\[[ xX]\]\s?)?|\d+\.(?!\d)\s*))/);
                const pre = pm ? pm[0] : '';
                let b = s.slice(pre.length);
                if (pre && /^#/.test(pre)) {
                    const cm = b.match(/\s+#+\s*$/);
                    if (cm) b = b.slice(0, b.length - cm[0].length);
                }
                return b;
            };
            const oldPlainLen = plainRangeToRawOffsets(stripInlineAffixes(raw), 0, 0).plainLength;
            const newPlainLen = plainRangeToRawOffsets(stripInlineAffixes(next), 0, 0).plainLength;
            const adjustedOffsets = {
                start: offsets.start,
                end: Math.max(offsets.start, offsets.end + (newPlainLen - oldPlainLen)),
                text: offsets.text
            };
            return commitInlineFormatToBlock(block, next, adjustedOffsets);
        }

        /**
         * Write a formatted raw into one block as a single undo step, then put the caret
         * and selection back on the formatted span (plain offsets are unchanged by a wrap).
         */
        function commitInlineFormatToBlock(block, raw, offsets) {
            HistoryManager.beginEdit();
            writeBlockRaw(block, raw);
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
            try {
                const bi = typeof formatBlockIndex === 'function' ? formatBlockIndex(block) : -1;
                if (bi >= 0 && typeof HistoryManager !== 'undefined' && typeof HistoryManager.setTopCarets === 'function') {
                    const c = { mode: 'wysiwyg', blockIndex: bi, offset: offsets.end, exact: true };
                    HistoryManager.setTopCarets(c, c);
                }
            } catch (eHc) {}
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

            // Code spans first — delimiters inside backticks stay literal.
            body.replace(/`[^`]*`/g, function (m, offset) {
                blockRange(offset, offset + m.length);
                return m;
            });

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

            const pref = raw.match(/^(?:#{1,6}\s+|>\s*|[ \t]*(?:[-*+]\s+(?:\[[ xX]\]\s?)?|\d+\.(?!\d)\s*))/);
            const prefix = pref ? pref[0] : '';
            let body = raw.slice(prefix.length);
            let suffix = '';
            if (prefix && /^#/.test(prefix)) {
                const closeM = body.match(/\s+#+\s*$/);
                if (closeM) {
                    suffix = closeM[0];
                    body = body.slice(0, body.length - suffix.length);
                }
            }
            function withAffix(s) { return prefix + s + suffix; }
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
                    return withAffix(joinSegments([
                        head,
                        pre ? '***' + pre + '***' : '',
                        '*' + mid + '*',
                        suf ? '***' + suf + '***' : '',
                        tail
                    ]));
                }
                // Unitalic inside ***: keep bold on the middle only
                if (type === 'italic' && p.kind === 'bolditalic') {
                    return withAffix(joinSegments([
                        head,
                        pre ? '***' + pre + '***' : '',
                        '**' + mid + '**',
                        suf ? '***' + suf + '***' : '',
                        tail
                    ]));
                }
                // Unbold inside **, unitalic inside *, unstrike inside ~~
                const m = p.marker;
                return withAffix(joinSegments([
                    head,
                    pre ? m + pre + m : '',
                    mid,
                    suf ? m + suf + m : '',
                    tail
                ]));
            }

            // --- Toggle ON: wrap selection (not already covered by this type) ---
            let open = '', close = '';
            if (type === 'bold') { open = '**'; close = '**'; }
            else if (type === 'italic') { open = '*'; close = '*'; }
            else if (type === 'strike') { open = '~~'; close = '~~'; }
            else return null;
            return withAffix(body.slice(0, r0) + open + mid + close + body.slice(r1));
        }

        function selectPlainRangeInBlock(block, plainStart, plainEnd) {
            // Best-effort: walk text nodes in rendered block
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
            let count = 0;
            let startNode = null, startOff = 0, endNode = null, endOff = 0;
            let lastNode = null;
            let n;
            while ((n = walker.nextNode())) {
                lastNode = n;
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
            if (!startNode && lastNode) {
                startNode = lastNode;
                startOff = lastNode.nodeValue.length;
            }
            if (!endNode && lastNode) {
                endNode = lastNode;
                endOff = lastNode.nodeValue.length;
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
                    // Scroll only -- this runs on every caret move, and it used to move the
                    // caret to the start of its line each time (both Source surfaces).
                    sourceEditor.scrollToOffset(pos, 0, 'center');   // the caret's line, centred
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
            // From the model, not by rebuilding the document from the page. The status bar
            // asks on every caret move; getMarkdownContent() re-serialises every laid-out
            // block, measuring each one's visual lines, and in 2-Col every block is laid
            // out. Measured 2026-09-29 on a 200,000-character document: 68 ms of the 120 ms
            // an Enter took in 2-Col, and the lag Ed felt as "useless as an editor". The
            // model holds each block's Markdown already; counting its newlines is the same
            // arithmetic modelBlockStartLine uses for the caret's own line, so the two agree.
            if (precomputedContent == null && state.mode !== 'source'
                && typeof DocumentModel !== 'undefined' && DocumentModel.kind !== 'epub'
                && DocumentModel.blocks && DocumentModel.blocks.length) {
                // Trailing empty blocks are not lines of the text (the serialised document
                // drops them), so they are not counted: Source's total is the reference.
                let n = DocumentModel.blocks.length;
                while (n > 1 && !(DocumentModel.blocks[n - 1] && String(DocumentModel.blocks[n - 1].raw || '').trim())) n--;
                return Math.max(1, modelBlockStartLine(n) - 1);
            }
            // Source: CodeMirror already knows its line count. getMarkdownContent() here
            // rebuilt the whole document model and split the text, on every caret move.
            if (precomputedContent == null && state.mode === 'source'
                && sourceEditor && sourceEditor.view) {
                return sourceEditor.view.state.doc.lines;
            }
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
        function getCaretLineNumber(precomputedContent, knownTotal) {
            try {
                // The stats pass has just counted the lines of this same text; splitting it
                // again here doubled that work on every pass.
                const total = knownTotal >= 1 ? knownTotal : getTotalLineCount(precomputedContent);
                let caret = 1;

                if (state.mode === 'source' && sourceEditor) {
                    const pos = sourceEditor.selectionStart || 0;
                    caret = sourceEditor.view
                        ? sourceEditor.view.state.doc.lineAt(pos).number
                        : (sourceEditor.value.substring(0, pos).split(/\r?\n/).length || 1);
                } else {
                    const sel = window.getSelection();
                    const selInEditor = !!(sel && sel.anchorNode && editor
                        && editor.contains(sel.anchorNode));
                    let active = currentActiveBlock;
                    if (selInEditor) {
                        active = getAncestorBlock(sel.anchorNode) || active;
                    }

                    // No live caret in the editor (typical while paging/reading): report the
                    // line on screen. Returning a stale _lastCaretLine left status at "Ln 1"
                    // forever after load while sticky/content sat mid-document.
                    if (!selInEditor) {
                        try {
                            if (typeof hardLineFromPreviewViewport === 'function') {
                                const view = hardLineFromPreviewViewport() | 0;
                                if (view >= 1) return Math.min(view, total);
                            }
                        } catch (eV) {}
                        if (typeof DocumentModel !== 'undefined' && DocumentModel.virtEnabled
                            && DocumentModel.blocks && DocumentModel.blocks.length) {
                            try {
                                const idx = modelIndexAtViewportCenter();
                                return Math.min(Math.max(1, modelBlockStartLine(idx)), total);
                            } catch (eVirt) {}
                        }
                        const frozen = Math.max(1, _stickyLineCache | 0, _lastCaretLine | 0);
                        return Math.min(frozen, total);
                    }
                    if (!active || !editor || !editor.contains(active)) {
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
                if (!isSourceFocused()) return;
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

        /** Debounce status Ln updates while paging (full stats are not free on large docs). */
        let _stickyStatsTimer = null;

        /** Keep sticky cache aligned with the visible page while scrolling Preview. */
        function rememberStickyFromPreviewScroll() {
            if (state.mode === 'source') return;
            try {
                // Do not steal sticky line on scroll if search is open
                const searchPane = document.getElementById('tab-search');
                const showingSearch = searchPane && searchPane.classList.contains('active');
                if (showingSearch && !window.__tzExternalSearchActive) return;

                const line = hardLineFromPreviewViewport();
                if (line >= 1) {
                    rememberStickyLine(line);
                    // Status Ln used to lag forever at 1 while sticky tracked the page.
                    if ((_lastCaretLine | 0) !== (line | 0)) {
                        _lastCaretLine = line;
                        if (_stickyStatsTimer) {
                            try { clearTimeout(_stickyStatsTimer); } catch (eT) {}
                        }
                        _stickyStatsTimer = setTimeout(function () {
                            _stickyStatsTimer = null;
                            try {
                                const live = (typeof hardLineFromPreviewViewport === 'function')
                                    ? (hardLineFromPreviewViewport() | 0) : (line | 0);
                                if (live >= 1) updateStatsNow({ forceCaretLine: live });
                            } catch (eS) {}
                        }, 280);
                    }
                }
            } catch (e) {}
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
                            // pageForBlock is within the mounted range; the global page adds
                            // the ranges before it.
                            currentTwoColPage = (pageWindowingActive() && PageChunks.mounted >= 0)
                                ? PageChunks.prefixPages(PageChunks.mounted) + pageForBlock
                                : pageForBlock;
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
                        DocumentModel.setMeasuredHeight(bi, blockOuterHeight(el));   // margins too (05-model)
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

        let _inStickyRestore = 0;
        if (typeof window !== 'undefined' && window.__tzCaretGen == null) window.__tzCaretGen = 0;
        if (typeof document !== 'undefined' && !window.__tzCaretGenListeners) {
            window.__tzCaretGenListeners = true;
            const bumpCaretGenOnInput = function (e) {
                try {
                    const t = e && e.target;
                    if (!t) return;
                    if ((editor && (t === editor || editor.contains(t)))
                        || (sourceEditor && (t === sourceEditor || (sourceEditor.contains && sourceEditor.contains(t))))) {
                        window.__tzCaretGen = (window.__tzCaretGen || 0) + 1;
                    }
                } catch (eG) {}
            };
            document.addEventListener('pointerdown', bumpCaretGenOnInput, true);
            document.addEventListener('mousedown', bumpCaretGenOnInput, true);
            document.addEventListener('keydown', bumpCaretGenOnInput, true);
        }

        /**
         * Put the user on hard line `line1Based` in the CURRENT mode and leave the caret there.
         * Source puts the line at the top of the view. Preview leaves `topPad` px above it
         * (default 48, so a search hit has context); a mode switch passes 0, so the line
         * lands at the top as in Source, where the next switch reads it back.
         */
        function restoreStickyDocumentLine(line1Based, noFocus, topPad, exact, caretOffset) {
            _inStickyRestore++;
            try {
            const pad = topPad == null ? 48 : Math.max(0, topPad | 0);
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
                const el = ensureModelBlockVisible(bi, { topPad: pad });
                if (el) {
                    window.showDebugTelemetry('restoreSticky: ensureModelBlockVisible returned el, setting focus');
                    try {
                        // An edit's reload (caretOffset given) already placed the caret -- a
                        // paste over the cut may have moved it lines on. Leave a live caret
                        // where it is; put one at the edit only if the remount lost it.
                        // Live means in a line: a caret on the editor itself is a lost one.
                        let keepLive = false;
                        if (caretOffset != null) {
                            try {
                                const s = window.getSelection();
                                keepLive = !!(s && s.rangeCount && s.anchorNode && s.anchorNode.isConnected
                                    && editor.contains(s.anchorNode) && getAncestorBlock(s.anchorNode));
                            } catch (eK) {}
                        }
                        // The live caret's line is the active one; only a caret placed here
                        // makes this line active.
                        if (!keepLive) currentActiveBlock = el;
                        if (!noFocus && !keepLive) {
                            // A block format's caret, if the remount lost it: where the format
                            // put it, never the start of the line (finishBlockFormatCaret).
                            const placed = caretOffset != null && typeof placePendingFormatCaret === 'function'
                                && placePendingFormatCaret();
                            if (!placed) focusBlock(el, caretOffset != null ? caretOffset : 0);
                        }
                    } catch (eF) {}
                    // Focus/caret can nudge scroll in WebView2 — re-snap once
                    try {
                        const r = el.getBoundingClientRect();
                        const c = mainContainer.getBoundingClientRect();
                        if (r.bottom < c.top + 8 || r.top > c.bottom - 8 || r.top < c.top - 2) {
                            ensureModelBlockVisible(bi, { topPad: pad });
                        }
                    } catch (eRe) {}
                    // exact: an edit putting the line back where it was. ensureModelBlockVisible
                    // lands within ~20 px of the padding (height estimates); close the gap.
                    try {
                        if (exact && !isPaginatedLayout()) {
                            const d = Math.round(el.getBoundingClientRect().top
                                - mainContainer.getBoundingClientRect().top) - pad;
                            if (Math.abs(d) > 1) mainContainer.scrollTop += d;
                        }
                    } catch (eEx) {}
                }
                // Force status to sticky line — getCaretLineNumber often returns 1 right
                // after mode switch before selection settles.
                try { updateStatsNow({ forceCaretLine: line }); } catch (eU2) {}
            } catch (e) {}
            } finally {
                _inStickyRestore--;
            }
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
            // Piggy-back on stats so the host updates "Ln X" without a new protocol.
            // Only the caret moved, so the text is unchanged: keep the content cache.
            // Invalidating it here made scrolling a large document re-join and re-count
            // the whole text every stats pass although nothing had been edited.
            updateStats(false);
        }

        // The line Reveal last drew as its Markdown (updateActiveBlock).
        let _revealedBlock = null;

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
                // The line Reveal drew as Markdown, if some path made another line active
                // without coming through here (a reload sets it directly): draw it as Preview
                // too, or it kept showing "> " while the caret was elsewhere (2026-11-21).
                if (_revealedBlock && _revealedBlock !== newActive && _revealedBlock !== currentActiveBlock
                    && editor.contains(_revealedBlock) && state.revealOnFocus
                    && typeof blockShowsRevealedMarkdown === 'function' && blockShowsRevealedMarkdown(_revealedBlock)) {
                    const rb = _revealedBlock;
                    const raw = rb.getAttribute('data-raw') || rb.innerText || '';
                    rb.setAttribute('data-raw', raw);
                    renderBlockPreview(rb, raw);
                }
                _revealedBlock = null;
                currentActiveBlock = newActive;
                if (currentActiveBlock && currentActiveBlock.classList && editor.contains(currentActiveBlock)) {
                    // setFocusedBlock rather than classList.add: this path knew to unlight
                    // the block it was leaving, but not any block some OTHER path had lit.
                    setFocusedBlock(currentActiveBlock);
                    if (state.revealOnFocus) {
                        const raw = currentActiveBlock.getAttribute('data-raw') || '';
                        if (currentActiveBlock.innerText !== raw) currentActiveBlock.innerText = raw;
                        _revealedBlock = currentActiveBlock;
                    }
                    if (state.typewriterMode) applyTypewriterScroll(true);
                }
                updateStats();
                // Moving between blocks only changes the outline if the block left was a
                // heading that was edited; rebuilding the list on every block change was
                // the bulk of the outline's cost while arrowing through a document.
                updateOutlineIfHeadingsChanged();
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
            if (!_inStickyRestore) window.__tzCaretGen = (window.__tzCaretGen || 0) + 1;
            focusEditorNoScroll();
            if (offset !== null) {
                try { setCaretAtOffset(block, offset); } catch(e) {}
            }
            updateActiveBlock();
        }

        // Where the caret was the last time the editor actually had it.
        //
        // Opening a menu (Alt+F, then S for Save) moves keyboard focus to the WPF menu
        // bar. WebView2 then reports an empty selection, and nothing puts the caret back
        // when the menu closes, so the next key does nothing until a click. The same empty
        // selection is why a paste after that lands nowhere. Remembered here, while the
        // selection is still inside the document, and not updated from the empty one blur
        // reports.
        let _editorCaretMemory = null;

        // The caret's line left the mounted window (scroll, PageDown, page turn): the
        // browser then holds a collapsed selection on the editor itself, in no line. That
        // state, and only that, is a displaced caret; the memory above is where it was.
        // (A sticky flag was tried and outlived carets that code placed afterwards.)
        function caretIsDisplaced() {
            try {
                const s = window.getSelection();
                if (!(s && s.rangeCount && s.isCollapsed && s.anchorNode && editor
                    && editor.contains(s.anchorNode) && !caretIsInMountedLine(s)
                    && _editorCaretMemory && _editorCaretMemory.kind === 'preview')) return false;
                // And its line really has left the window. On a blank line the browser can
                // hold the caret on the editor too; that line is mounted, and the caret is fine.
                const el = (typeof elementForModelIndex === 'function') ? elementForModelIndex(_editorCaretMemory.index) : null;
                return !(el && editor.contains(el));
            } catch (e) { return false; }
        }
        function markCaretDisplaced() {}
        function clearCaretDisplaced() {}

        if (typeof window !== 'undefined' && window.__tzLastUiInput == null) window.__tzLastUiInput = null;
        if (typeof document !== 'undefined' && !window.__tzUiInputTrackers) {
            window.__tzUiInputTrackers = true;
            const trackUiInput = function (e) {
                try {
                    const t = e && e.target;
                    if (!t) return;
                    if ((t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
                        && t !== sourceEditor && (!editor || !editor.contains(t))) {
                        window.__tzLastUiInput = t;
                    } else if (e.type === 'mousedown' || e.type === 'pointerdown'
                        || (editor && (t === editor || editor.contains(t))) || t === sourceEditor) {
                        window.__tzLastUiInput = null;
                    }
                } catch (eU) {}
            };
            document.addEventListener('focusin', trackUiInput, true);
            document.addEventListener('mousedown', trackUiInput, true);
            document.addEventListener('pointerdown', trackUiInput, true);
            document.addEventListener('mouseup', trackUiInput, true);
            document.addEventListener('keyup', trackUiInput, true);
            document.addEventListener('select', trackUiInput, true);
        }

        function rememberEditorCaret() {
            try {
                if (state.mode === 'source' && typeof isSourceFocused === 'function' && isSourceFocused()
                    && typeof sourceEditor !== 'undefined' && sourceEditor) {
                    _editorCaretMemory = {
                        kind: 'source',
                        start: sourceEditor.selectionStart | 0,
                        end: sourceEditor.selectionEnd | 0
                    };
                    return;
                }
                const sel = window.getSelection();
                if (!sel || !sel.rangeCount || !sel.anchorNode || !editor || !editor.contains(sel.anchorNode)) return;
                const block = typeof getAncestorBlock === 'function' ? getAncestorBlock(sel.anchorNode) : null;
                if (!block) return;   // on the editor itself: its line is gone; keep the memory
                let index = -1;
                try {
                    if (typeof DocumentModel !== 'undefined') index = DocumentModel.modelIndexOfEl(block);
                } catch (eMi) {}
                if (!(index >= 0) && typeof formatBlockIndex === 'function') index = formatBlockIndex(block);
                if (!(index >= 0)) return;
                let start = 0, end = 0;
                const off = typeof getPlainOffsetsInBlock === 'function' ? getPlainOffsetsInBlock(block) : null;
                if (off && off.start != null) {
                    start = off.start | 0;
                    end = off.end != null ? (off.end | 0) : start;
                } else if (!sel.isCollapsed && sel.rangeCount) {
                    const r = sel.getRangeAt(0);
                    if (block.contains(r.startContainer) && block.contains(r.endContainer)) {
                        const rS = document.createRange();
                        rS.selectNodeContents(block);
                        rS.setEnd(r.startContainer, r.startOffset);
                        const rE = document.createRange();
                        rE.selectNodeContents(block);
                        rE.setEnd(r.endContainer, r.endOffset);
                        start = rS.toString().length;
                        end = rE.toString().length;
                    } else {
                        return;
                    }
                } else if (sel.isCollapsed) {
                    const pre = document.createRange();
                    pre.selectNodeContents(block);
                    pre.setEnd(sel.anchorNode, sel.anchorOffset);
                    start = end = pre.toString().length;
                } else {
                    return;
                }
                // With the text the offsets count in (Reveal draws the active line as Markdown,
                // and a menu taking the keyboard draws it as Preview again).
                _editorCaretMemory = { kind: 'preview', index: index, start: start, end: end,
                    text: block.textContent || '', at: Date.now() };
                if (typeof window !== 'undefined') window.__tzLastUiInput = null;
            } catch (e) {}
        }
        window.rememberEditorCaret = rememberEditorCaret;

        function pageFocusBelongsElsewhere() {
            const a = document.activeElement;
            if (!a || a === document.body || a === document.documentElement) return false;
            if (editor && (a === editor || editor.contains(a))) return false;
            if (typeof isSourceNode === 'function' && isSourceNode(a)) return false;
            return true;
        }

        function placePreviewCaretMemory(mem) {
            if (!mem || mem.kind !== 'preview' || !editor) return false;
            let block = null;
            try {
                if (typeof elementForModelIndex === 'function') block = elementForModelIndex(mem.index);
            } catch (eEl) {}
            // mem.index is a line of the document. Counting mounted lines gives the same line
            // only when the whole document is mounted; in a long file it picked the 26th line
            // of the window (line 826) and the next key went there. Otherwise bring the line
            // itself into view: turn to its page, or scroll to it.
            let partial = false;
            try {
                partial = (typeof DocumentModel !== 'undefined' && DocumentModel.virtEnabled)
                    || (typeof pageWindowingActive === 'function' && pageWindowingActive());
            } catch (eP) { partial = true; }
            if (!block && !partial && typeof mountedBlockAtFormatIndex === 'function') block = mountedBlockAtFormatIndex(mem.index);
            if (!block && partial && typeof isPaginatedLayout === 'function' && isPaginatedLayout()) {
                // Mount the line's page range now (synchronous), so the key that asked for the
                // caret acts on it; then turn to its page, which settles over a few frames.
                try {
                    if (typeof pageWindowingActive === 'function' && pageWindowingActive()
                        && typeof PageChunks !== 'undefined' && typeof mountPageChunk === 'function') {
                        PageChunks.ensure(DocumentModel.blocks.length);
                        const want = PageChunks.chunkOfBlock(mem.index);
                        if (want !== PageChunks.mounted) mountPageChunk(want);
                    }
                } catch (eMc) {}
                try { block = elementForModelIndex(mem.index); } catch (eEl2) {}
                try { if (typeof goToPageHoldingBlock === 'function') goToPageHoldingBlock(mem.index); } catch (eGo) {}
            }
            if (!block && typeof ensureModelBlockVisible === 'function') {
                try { block = ensureModelBlockVisible(mem.index, { topPad: 48 }); } catch (eVis) {}
            }
            if (!block || !editor.contains(block)) return false;
            const isEditable = editor.isContentEditable;
            if (isEditable) focusEditorNoScroll();
            if (typeof setCaretAtOffset !== 'function') return true;
            if (isEditable) {
                // Make the line the active one before placing the caret in it: with Reveal on,
                // that redraws it as Markdown, which resets a caret placed first (it went to
                // the start of the line after a menu). The offsets were taken in that text.
                // A line marked active without being made so (a reload or an undo sets it
                // directly): not lit, or with Reveal on still drawn as Preview. Make it active.
                if (currentActiveBlock === block && (!block.classList.contains('focused')
                    || (state.revealOnFocus && typeof blockShowsRevealedMarkdown === 'function'
                        && !blockShowsRevealedMarkdown(block)
                        && !(typeof blockWasEdited === 'function' && blockWasEdited(block))))) currentActiveBlock = null;
                if (currentActiveBlock !== block) {
                    try { setCaretAtOffset(block, 0); updateActiveBlock(); } catch (eAct) {}
                }
            }
            let start = mem.start | 0;
            let end = mem.end != null ? (mem.end | 0) : start;
            // Offsets taken in other text than the line shows now (Reveal on, off): the same
            // point in the text it shows (formatCaretMapOffset).
            if (mem.text != null && typeof formatCaretMapOffset === 'function') {
                const now = block.textContent || '';
                if (now !== mem.text) {
                    start = formatCaretMapOffset(mem.text, now, start);
                    end = formatCaretMapOffset(mem.text, now, end);
                }
            }
            if (end > start && typeof locateOffsetInBlock === 'function') {
                const h0 = locateOffsetInBlock(block, start);
                const h1 = locateOffsetInBlock(block, end);
                if (h0 && h1) {
                    try {
                        const sel = window.getSelection();
                        const range = document.createRange();
                        if (h0.before) range.setStartBefore(h0.node); else range.setStart(h0.node, h0.offset);
                        if (h1.before) range.setEndBefore(h1.node); else range.setEnd(h1.node, h1.offset);
                        sel.removeAllRanges();
                        sel.addRange(range);
                        return true;
                    } catch (eR) {}
                }
            }
            if (isEditable) {
                setCaretAtOffset(block, start);
                if (end > start) {
                    const sel = window.getSelection();
                    const aNode = sel.anchorNode, aOff = sel.anchorOffset;
                    setCaretAtOffset(block, end);
                    try {
                        const range = document.createRange();
                        range.setStart(aNode, aOff);
                        range.setEnd(sel.anchorNode, sel.anchorOffset);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    } catch (eR) {
                        setCaretAtOffset(block, end);
                    }
                }
            } else if (typeof locateOffsetInBlock === 'function') {
                const h0 = locateOffsetInBlock(block, start);
                if (h0) {
                    const sel = window.getSelection();
                    const range = document.createRange();
                    if (h0.before) range.setStartBefore(h0.node); else range.setStart(h0.node, h0.offset);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
            return true;
        }

        /**
         * Put the keyboard back in the editor, on the caret the menu (or a blur) took.
         * A control that already has focus — Find, the sidebar, Help — keeps it.
         * A caret the user has already placed again is left where they put it.
         */
        function restoreEditorFocusAfterChrome(opts) {
            if (pageFocusBelongsElsewhere()) return false;
            if (state.mode === 'source') {
                if (typeof isSourceFocused === 'function' && isSourceFocused()) return true;
                const mem = _editorCaretMemory;
                if (typeof sourceEditor !== 'undefined' && sourceEditor) {
                    try { sourceEditor.focus(); } catch (eF) {}
                    if (mem && mem.kind === 'source') {
                        try { sourceEditor.setSelectionRange(mem.start | 0, mem.end | 0); } catch (eS) {}
                    }
                    return true;
                }
                return false;
            }
            const sel = window.getSelection();
            const needRange = !!(opts && opts.needRange);
            if (sel && sel.rangeCount && sel.anchorNode && editor && editor.contains(sel.anchorNode)
                && (!needRange || !sel.isCollapsed)) {
                const a = document.activeElement;
                if (editor.isContentEditable && a !== editor && !(editor && editor.contains(a))) focusEditorNoScroll();
                return true;
            }
            // A selection across lines, newer than the caret remembered: put it back as it
            // was, the same way round (it collapsed to a caret after a menu).
            try {
                const fz = (typeof _mbSelFreeze !== 'undefined') ? _mbSelFreeze : null;
                const mem0 = _editorCaretMemory;
                if (fz && fz.ends && fz.ends.a && fz.ends.f && fz.ends.a.index !== fz.ends.f.index
                    && (!mem0 || (fz.at || 0) >= (mem0.at || 0))
                    && typeof placePreviewFormatPoints === 'function'
                    && placePreviewFormatPoints(fz.ends.a, fz.ends.f)) return true;
            } catch (eMb) {}
            if (_editorCaretMemory && _editorCaretMemory.kind === 'preview')
                return placePreviewCaretMemory(_editorCaretMemory);
            if (editor.isContentEditable) focusEditorNoScroll();
            return false;
        }
        window.restoreEditorFocusAfterChrome = restoreEditorFocusAfterChrome;

        /** Paste with no live caret: go back to the one the menu cleared, then insert there. */
        function recoverCaretForPaste() {
            try {
                if (state.mode === 'source') {
                    if (typeof isSourceFocused === 'function' && isSourceFocused()) return;
                    const mem = _editorCaretMemory;
                    if (!mem || mem.kind !== 'source' || typeof sourceEditor === 'undefined' || !sourceEditor) return;
                    try { sourceEditor.focus(); } catch (eF) {}
                    try { sourceEditor.setSelectionRange(mem.start | 0, mem.end | 0); } catch (eS) {}
                    return;
                }
                const sel = window.getSelection();
                // In a line, or a remembered selection drawn to the window edge: leave it.
                // On the editor itself (its line scrolled out of the window) the caret is lost.
                // A range (Select All included) is pasted over; a caret in a line is used.
                if (sel && sel.rangeCount && sel.anchorNode && editor && editor.contains(sel.anchorNode)
                    && (!sel.isCollapsed || caretIsInMountedLine(sel))) return;
                if (_editorCaretMemory && _editorCaretMemory.kind === 'preview')
                    placePreviewCaretMemory(_editorCaretMemory);
            } catch (e) {}
        }
        window.recoverCaretForPaste = recoverCaretForPaste;

        function caretIsInMountedLine(sel) {
            try {
                if (!sel || !sel.anchorNode || !sel.anchorNode.isConnected) return false;
                const b = getAncestorBlock(sel.anchorNode);
                return !!(b && editor.contains(b));
            } catch (e) { return false; }
        }

        /**
         * A key after the caret's line scrolled out of the window.
         *
         * PageUp/PageDown and the wheel move the view and leave the caret where it was. In
         * a long file that line is then unmounted and the browser drops the selection onto
         * the editor itself, so the next letter, Delete or Enter did nothing at all -- the
         * keystroke was lost (and in 2-Col one Delete took the first letter of the file).
         * The caret is remembered by line; an editing or arrow key puts it back there,
         * bringing the line into view as other editors do, and then acts. PageUp/PageDown
         * keep only scrolling.
         */
        window.addEventListener('keydown', function onKeyAfterCaretScrolledAway(e) {
            try {
                if (state.mode === 'source' || !editor || e.isComposing || e.keyCode === 229) return;
                const ae = document.activeElement;
                if (!ae || !(ae === editor || editor.contains(ae))) return;
                const k = e.key || '';
                const printable = k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
                const editKey = /^(Backspace|Delete|Enter|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End)$/.test(k)
                    && !e.altKey;
                if (!printable && !editKey) return;
                const sel = window.getSelection();
                if (!sel || !sel.rangeCount) return;
                // Only a caret that is in no line. A range (Select All, a remembered
                // selection) is the reader's selection and the key acts on it.
                if (!caretIsDisplaced()) return;
                placePreviewCaretMemory(_editorCaretMemory);
            } catch (eK) {}
        }, true);

        document.addEventListener('selectionchange', () => {
            if (state.mode === 'source' && isSourceFocused()) {
                rememberEditorCaret();
                rememberStickyFromSourceIfFocused();
                rememberSourceFormatSelection();
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
                const keepCollapsedRange = sel && sel.isCollapsed
                    && (!document.hasFocus() || (editor.isContentEditable && document.activeElement !== editor && !editor.contains(document.activeElement)))
                    && _editorCaretMemory && _editorCaretMemory.kind === 'preview'
                    && _editorCaretMemory.end > _editorCaretMemory.start;
                if (!keepCollapsedRange) rememberEditorCaret();
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
        editor.addEventListener('mousedown', function (ev) {
            // CRITICAL: capture full document HERE, before drag-select corrupts data-raw.
            // Without this, multi-select → bullet reloads from empty and wipes the doc.
            try { refreshLastGoodDocRaws(); } catch (e) {}
            // Before the browser extends the selection: is the anchor's line still mounted?
            try { if (typeof noteShiftClickAnchor === 'function') noteShiftClickAnchor(ev); } catch (eSa) {}
            _formatSelectionFrozen = false;
            _selectedFormatRaws = {};
        }, true);
        editor.addEventListener('mouseup', function () {
            try {
                const sel = window.getSelection();
                // A click leaves a caret. The drag's range is over; remember it and a
                // later paste writes the old paragraphs back on top of themselves.
                if (sel && sel.isCollapsed) {
                    _inlineSelCache = null;
                    if (typeof clearMultiBlockSelFreeze === 'function') clearMultiBlockSelFreeze();
                    if (typeof _shiftClickAnchor !== 'undefined') _shiftClickAnchor = null;
                    return;
                }
                // Shift+click whose anchor line was unmounted by scrolling.
                if (typeof applyShiftClickFromAnchor === 'function' && applyShiftClickFromAnchor()) return;
                if (typeof snapshotMultiBlockSelectionFromLive === 'function')
                    snapshotMultiBlockSelectionFromLive();
            } catch (eMu) {}
        }, true);
        editor.addEventListener('keyup', function (e) {
            if (state.mode === 'source') return;
            // Shift+arrows extended a remembered (scrolled-away) selection: move its end.
            if (e.shiftKey || e.key === 'Shift') {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    try { extendShiftPastBlankLine(e.key); } catch (eEx) {}
                }
                _shiftFromEdge = null;
                try { if (typeof refreshRememberedFreezeFromFocus === 'function') refreshRememberedFreezeFromFocus(); } catch (eRf) {}
                // A selection made with the keyboard needs its ends remembered as a drag's
                // are (mouseup): without them Bold over two lines marked the whole of both.
                try { if (typeof snapshotMultiBlockSelectionFromLive === 'function') snapshotMultiBlockSelectionFromLive(); } catch (eSn) {}
                return;
            }
            try {
                const sel = window.getSelection();
                if (sel && sel.isCollapsed && sel.anchorNode && editor.contains(sel.anchorNode)) {
                    _inlineSelCache = null;
                    if (typeof clearMultiBlockSelFreeze === 'function') clearMultiBlockSelFreeze();
                }
            } catch (eKu) {}
        });
        function blockIsVisuallyEmpty(block) {
            if (!block) return false;
            let raw = null;
            try { raw = block.getAttribute('data-raw'); } catch (eR) { raw = null; }
            if (raw == null) raw = block.textContent || '';
            return String(raw).replace(/\u00a0/g, ' ').trim() === '';
        }

        function adjacentContentBlock(block, dir) {
            let n = block;
            while (n) {
                n = dir > 0 ? n.nextElementSibling : n.previousElementSibling;
                if (!n || !n.classList || !n.classList.contains('block')) continue;
                if (!blockIsVisuallyEmpty(n)) return n;
            }
            return null;
        }

        function caretAtBlockEdge(block, atEnd) {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || !sel.isCollapsed || !block) return false;
            const r = sel.getRangeAt(0);
            if (!block.contains(r.startContainer) && r.startContainer !== block) return false;
            try {
                const side = document.createRange();
                side.selectNodeContents(block);
                if (atEnd) side.setStart(r.startContainer, r.startOffset);
                else side.setEnd(r.startContainer, r.startOffset);
                return side.toString().replace(/[\u200B\uFEFF]/g, '') === '';
            } catch (e) { return false; }
        }

        // The blank line under a paragraph is its own block, and it draws as a gap of a
        // few pixels. Shift+Down from the end of the paragraph used to select only that
        // gap. The next paragraph was not in the selection, and the letter typed next
        // was written onto the paragraph above while the gap was deleted.
        let _shiftExtendX = null;
        let _shiftFromEdge = null;
        function extendShiftPastBlankLine(key) {
            const dir = key === 'ArrowDown' ? 1 : (key === 'ArrowUp' ? -1 : 0);
            if (!dir) return;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || sel.isCollapsed || !sel.focusNode || !editor.contains(sel.focusNode)) return;
            const focusBlock = getAncestorBlock(sel.focusNode);
            if (!blockIsVisuallyEmpty(focusBlock)) return;
            const target = adjacentContentBlock(focusBlock, dir);
            if (!target) return;
            const fromEdge = (dir > 0 && _shiftFromEdge === 'end') || (dir < 0 && _shiftFromEdge === 'start');
            let node = null, offset = 0;
            if (!fromEdge) {
                const box = target.getBoundingClientRect();
                if (box && box.height >= 1 && box.width >= 1) {
                    const y = dir > 0 ? Math.min(box.bottom - 2, box.top + 8) : Math.max(box.top + 2, box.bottom - 8);
                    const x = _shiftExtendX == null ? (box.left + 8) : Math.min(Math.max(_shiftExtendX, box.left + 1), box.right - 1);
                    try {
                        const caret = document.caretRangeFromPoint(x, y);
                        if (caret && getAncestorBlock(caret.startContainer) === target) {
                            node = caret.startContainer;
                            offset = caret.startOffset;
                        }
                    } catch (eC) {}
                }
            }
            if (!node) {
                const tw = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
                let first = null, last = null, n;
                while ((n = tw.nextNode())) { if (!first) first = n; last = n; }
                if (!first) return;
                if (dir > 0) { node = last; offset = last.nodeValue.length; }
                else { node = first; offset = 0; }
            }
            try { sel.extend(node, offset); } catch (eE) { return; }
            if (sel.toString().replace(/[\s\u00a0]/g, '') === '') {
                try { sel.modify('extend', dir > 0 ? 'forward' : 'backward', 'character'); } catch (eM) {}
            }
        }

        // Typing over a selection that spans lines is Delete, then the letter -- as in any
        // editor, and so it follows the same rules as Delete: a remembered (scrolled-away)
        // range is deleted whole, a table at either end stays a table, both ends keep their
        // marks. Left to the browser, typing over lines into a table deleted the lines
        // before it and left the table untouched (0.20.9).
        editor.addEventListener('keydown', function (e) {
            if (state.mode === 'source' || e.ctrlKey || e.metaKey || e.altKey) return;
            if (!e.key || e.key.length !== 1 || e.isComposing || e.keyCode === 229) return;
            try {
                let across = typeof rememberedFreezeStandsForSelection === 'function' && rememberedFreezeStandsForSelection();
                if (!across) {
                    const s = window.getSelection();
                    if (s && s.rangeCount && !s.isCollapsed && s.anchorNode && editor.contains(s.anchorNode)) {
                        const r = s.getRangeAt(0);
                        const a = getAncestorBlock(r.startContainer), b = getAncestorBlock(r.endContainer);
                        across = !!(a && b && a !== b);
                    }
                }
                if (!across) return;
                const sOnly = window.getSelection();
                // A selection of only the gap is the blank line. The letter belongs on
                // that line. The cross-block delete wrote it onto the paragraph above.
                if (sOnly && sOnly.rangeCount && !sOnly.isCollapsed
                    && sOnly.toString().replace(/[\s\u00a0\u200B]/g, '') === '') {
                    const r0 = sOnly.getRangeAt(0);
                    const a0 = getAncestorBlock(r0.startContainer), b0 = getAncestorBlock(r0.endContainer);
                    const empty = blockIsVisuallyEmpty(b0) ? b0 : (blockIsVisuallyEmpty(a0) ? a0 : null);
                    if (empty) {
                        e.preventDefault();
                        e.stopPropagation();
                        const all = document.createRange();
                        all.selectNodeContents(empty);
                        sOnly.removeAllRanges();
                        sOnly.addRange(all);
                        const before = (typeof getMarkdownContent === 'function') ? getMarkdownContent(false) : null;
                        try { document.execCommand('insertText', false, e.key); } catch (eI) {}
                        try {
                            if (before != null && typeof HistoryManager !== 'undefined')
                                HistoryManager.recordEditPair(before, getMarkdownContent(false));
                        } catch (eH0) {}
                        return;
                    }
                }
                if (!handleMultiBlockSelectionDelete(e)) return;
                // One undo step for the whole replacement, as in any editor: the delete pushed
                // its "after" state, and the letter would push another, so Ctrl+Z stopped
                // with the selection deleted and only the letter gone. Drop the in-between
                // state; record the state with the letter in.
                try {
                    if (typeof HistoryManager !== 'undefined' && HistoryManager.undoStack.length > 1) HistoryManager.undoStack.pop();
                } catch (eH) {}
                document.execCommand('insertText', false, e.key);
                try { if (typeof HistoryManager !== 'undefined') HistoryManager.commitEdit(); } catch (eC) {}
            } catch (eTy) {}
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
                _shiftExtendX = null;
                _shiftFromEdge = null;
                if (sel && sel.rangeCount && sel.isCollapsed && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    const rects = sel.getRangeAt(0).getClientRects();
                    const rect = rects && rects.length ? rects[rects.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
                    if (rect) _shiftExtendX = rect.left || rect.right;
                    const block = sel.anchorNode ? getAncestorBlock(sel.anchorNode) : null;
                    if (e.key === 'ArrowDown' && caretAtBlockEdge(block, true)) _shiftFromEdge = 'end';
                    if (e.key === 'ArrowUp' && caretAtBlockEdge(block, false)) _shiftFromEdge = 'start';
                }
            } catch (err) {}
            try { if (typeof beginExtendingRemembered === 'function') beginExtendingRemembered(); } catch (eBe) {}
        }, true);
        // Home / End stay in the paragraph. When a visual line ends at an image (it is
        // contenteditable=false), Chromium's End moves the caret into the NEXT block, and
        // what you type next lands in a new paragraph there (link-emphasis-browser caught it
        // once a broken image drew full width). Same move, done here; if it leaves the
        // block, one character back is the paragraph's own end (or start, for Home). Putting
        // the old range back instead lost Chromium's line-end affinity, and the next letter
        // then ate the space after the image.
        editor.addEventListener('keydown', function (e) {
            if (e.key !== 'Home' && e.key !== 'End') return;
            if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
            try {
                const sel = window.getSelection();
                if (!sel || !sel.rangeCount || !sel.isCollapsed || typeof sel.modify !== 'function') return;
                const from = sel.getRangeAt(0).cloneRange();
                const blockOf = function (n) {
                    const el = n && (n.nodeType === 3 ? n.parentElement : n);
                    return el && el.closest ? el.closest('#editor .block') : null;
                };
                const block = blockOf(from.startContainer);
                if (!block) return;
                e.preventDefault();
                sel.modify('move', e.key === 'End' ? 'forward' : 'backward', 'lineboundary');
                if (blockOf(sel.anchorNode) !== block) {
                    sel.modify('move', e.key === 'End' ? 'backward' : 'forward', 'character');
                    if (blockOf(sel.anchorNode) !== block) { sel.removeAllRanges(); sel.addRange(from); }
                }
            } catch (err) {}
        }, true);
        // --- Links: add and edit ----------------------------------------------------
        let _pendingLink = null;

        /** Wrap the current selection as a link with the values the dialog collected. */
        function applyLinkAdd(text, url) {
            _pendingLink = { text: text, url: url };
            try { return applyFormatting('link'); }
            finally { _pendingLink = null; }
        }

        /**
         * Rewrite an existing link.
         *
         * By POSITION among the block's anchors, not by matching text: two links in one
         * paragraph can read the same and point the same way, and the reader means the one
         * they hovered. The nth anchor in the rendered block is the nth [text](url) in its
         * raw, which sidesteps mapping a DOM range back onto markdown offsets -- the step
         * that quietly eats a character when a URL contains a bracket.
         */
        function applyLinkEdit(a, text, url) {
            if (!a) return false;
            const block = a.closest ? a.closest('.block') : null;
            if (!block) return false;
            const anchors = Array.prototype.slice.call(block.querySelectorAll('a'));
            const idx = anchors.indexOf(a);
            if (idx < 0) return false;
            const raw = block.getAttribute('data-raw') || '';
            const re = /\[([^\]]*)\]\(([^)]*)\)/g;
            let m, i = 0, hit = null;
            while ((m = re.exec(raw)) !== null) {
                if (i === idx) { hit = m; break; }
                i++;
            }
            if (!hit) return false;
            const next = raw.slice(0, hit.index) + '[' + text + '](' + url + ')'
                       + raw.slice(hit.index + hit[0].length);
            HistoryManager.beginEdit();
            writeBlockRaw(block, next);
            updateStats();
            updateOutline();
            HistoryManager.commitEdit();
            return true;
        }

        // Following a link.
        //
        // A link inside a book jumps within the document. The whole book is already open,
        // so following the href would replace the application with one chapter of it -- and
        // an external link should not silently become the reader's window either.
        //
        // For Markdown this used to return immediately, so links did nothing at all: a
        // relative one to a file beside the document -- the ordinary way notes point at
        // each other -- was dead, while every other editor opens it.
        //
        // Ctrl / Cmd is required in Preview because Preview is an editing surface: a plain
        // click there has to go on placing the caret, or the text of a link could never be
        // edited. Reader sets contenteditable="false" and has no caret to place, so there a
        // plain click follows -- which is also what the book path has always done.
        editor.addEventListener('click', function (e) {
            const a = e.target && e.target.closest ? e.target.closest('a') : null;
            if (!a) { try { hideLinkPop(); } catch (eH) {} return; }
            const isBook = (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub');

            const target = a.getAttribute('data-book-href') || a.getAttribute('href');
            if (!target) return;

            // An in-document anchor goes to the heading it names, the same way clicking
            // that heading in the outline does.
            if (!isBook && target.charAt(0) === '#') {
                if (editor.isContentEditable && !(e.ctrlKey || e.metaKey)) return;
                e.preventDefault();
                e.stopPropagation();
                try { hideLinkPop(); } catch (eA) {}
                try { goToHeadingAnchor(target); } catch (eB) {}
                return;
            }

            // Plain click keeps the caret: this is an editor, and a click that navigated
            // away from the text you were about to edit is a document-reader's behaviour.
            // The actions live on the hover chip, so nothing is hidden behind a chord.
            if (!isBook && editor.isContentEditable && !(e.ctrlKey || e.metaKey)) return;
            try { hideLinkPop(); } catch (eH2) {}

            e.preventDefault();
            e.stopPropagation();
            if (/^(https?:|mailto:)/i.test(target)) {
                postMsg('open_external:' + encodeURIComponent(target));
                return;
            }
            if (isBook) {
                if (!bookGoToHref(target, a.innerText || a.textContent || '')) {
                    window.showDebugTelemetry('book link went nowhere: ' + target);
                }
                return;
            }
            // Anything else is a path: relative to this document, or absolute. The host
            // resolves it, because only the host knows where the document lives, and opens
            // it the same way File -> Open would rather than handing it to the shell.
            postMsg('open_doc:' + encodeURIComponent(target));
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



