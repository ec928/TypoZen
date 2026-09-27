// TypoZen module: 01a-source.js
// Source mode's editing surface. Classic script; shares page globals.
// Load order is fixed -- see js/modules/load-order.json and TypoZen_Template.html.
//
// docs/codemirror-source-plan.md, section 5.1. Source is edited in CodeMirror 6
// (js/vendor/codemirror/codemirror.js, window.TzCM). The rest of the engine was written
// against a <textarea>, so createSourceSurface returns an object that behaves like one
// for exactly the members the engine uses -- value, the selection, setRangeText, scroll
// metrics, focus, style, events -- and 01-core.js keeps calling it `sourceEditor`.
//
// Two rules hold it together:
//   1. The text lives in view.state.doc and nowhere else. Nothing reads Source text from
//      CodeMirror's DOM (.cm-content, .cm-line). The parked code editor corrupted files by
//      rebuilding text from a contenteditable's DOM; CodeMirror owns its buffer instead.
//   2. It behaves like the textarea it replaced, including where that is inconvenient:
//      setting `value` or calling setRangeText does not fire `input`; typing does.
//
// There is no textarea any more (removed in Phase 4, Ed 2026-09-27: "no need for a fall
// back if it works" -- CodeMirror measured faster than the textarea in every case). A
// missing bundle is a broken build, and says so at load rather than degrading quietly;
// assets-selftest checks the bundle ships.

        function createSourceSurface(host) {
            const CM = window.TzCM;
            if (!CM) throw new Error('TypoZen: js/vendor/codemirror/codemirror.js did not load -- Source cannot start');
            if (!host) throw new Error('TypoZen: #source-cm is missing from the page');

            // Transactions TypoZen makes itself (value =, setRangeText, selection calls).
            // They must not fire `input`: a textarea does not, and the engine's input
            // handler rebuilds the model and takes an undo snapshot on every one.
            const programmatic = CM.Annotation.define();
            const wrapping = new CM.Compartment();
            const editable = new CM.Compartment();
            const listeners = { input: [], select: [], scroll: [] };
            let cachedDoc = null, cachedText = '';

            const fire = (type, ev) => {
                const list = listeners[type].slice();
                for (let i = 0; i < list.length; i++) {
                    try { list[i].call(surface, ev); }
                    catch (e) { try { window.tzLogException('source ' + type + ' listener', e); } catch (eL) {} }
                }
            };

            // Find and search marks (02-layout.js, paintSourceHighlights): decorations on
            // the real text, so they cannot drift off their words the way the textarea's
            // painted mirror could. Edits move them with the text until the next repaint.
            const setMarks = CM.StateEffect.define();
            const marksField = CM.StateField.define({
                create: () => CM.Decoration.none,
                update(deco, tr) {
                    deco = deco.map(tr.changes);
                    for (const e of tr.effects) if (e.is(setMarks)) deco = e.value;
                    return deco;
                },
                provide: (f) => CM.EditorView.decorations.from(f)
            });
            const hitMark = CM.Decoration.mark({ class: 'tz-src-hit' });
            const curMark = CM.Decoration.mark({ class: 'tz-src-hit cur' });

            // --- Highlighting (plan, section 5.4) -------------------------------------
            // By what the document is, which the host says before each load (doc_ext:,
            // setSourceDocExt): Markdown gets CodeMirror's parser, drawn with classes that
            // typozen.css styles from Preview's own rules -- a heading here is the colour and
            // weight a heading is there. Code -- a file of a code type, or a fenced block in
            // Markdown -- gets 08-code.js's lexers, the ones Preview's code blocks use, with
            // the same tzcode-* colours. Plain text gets nothing.
            const t = CM.tags;
            const mdStyle = CM.HighlightStyle.define([
                { tag: t.heading1, class: 'tzmd-h tzmd-h1' },
                { tag: t.heading2, class: 'tzmd-h tzmd-h2' },
                { tag: t.heading3, class: 'tzmd-h tzmd-h3' },
                { tag: t.heading4, class: 'tzmd-h tzmd-h4' },
                { tag: t.heading5, class: 'tzmd-h tzmd-h5' },
                { tag: t.heading6, class: 'tzmd-h tzmd-h6' },
                { tag: t.strong, class: 'tzmd-strong' },
                { tag: t.emphasis, class: 'tzmd-em' },
                { tag: t.strikethrough, class: 'tzmd-del' },
                { tag: t.monospace, class: 'tzmd-code' },
                { tag: t.link, class: 'tzmd-link' },
                { tag: t.url, class: 'tzmd-url' },
                { tag: t.quote, class: 'tzmd-quote' },
                { tag: [t.processingInstruction, t.contentSeparator], class: 'tzmd-mark' }
            ]);
            const language = new CM.Compartment();
            const kindChanged = CM.StateEffect.define();
            let kind = '', codeLang = null;
            const MARKDOWN_EXT = /^(|md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/;
            const kindForExt = (ext) => {
                ext = String(ext == null ? '' : ext).toLowerCase();
                const code = window.CODE_LANGUAGES ? window.CODE_LANGUAGES[ext] : null;
                if (code) return 'code:' + code;
                return MARKDOWN_EXT.test(ext) ? 'markdown' : 'plain';
            };
            /** Follow the document's type; a no-op unless it changed. */
            const applyKind = () => {
                const k = kindForExt(typeof state !== 'undefined' && state ? state.docExt : '');
                if (k === kind) return;
                kind = k;
                codeLang = k.indexOf('code:') === 0 ? k.slice(5) : null;
                view.dispatch({
                    effects: [language.reconfigure(k === 'markdown'
                        ? [CM.markdownLanguage.extension, CM.syntaxHighlighting(mdStyle)] : []), kindChanged.of(k)],
                    annotations: programmatic.of(true)
                });
            };

            // Code, by 08-code.js's per-line lexers (window.lexCodeLine), over the lines on
            // screen only. A lexer carries a small state from line to line (a block comment
            // spanning lines); it is rebuilt from at most CODE_LOOKBACK lines above the view,
            // which is exact for anything but a comment longer than that.
            const CODE_LOOKBACK = 200;
            const tokenMarks = {};
            const tokenMark = (c) => tokenMarks[c] || (tokenMarks[c] = CM.Decoration.mark({ class: 'tzcode-' + c }));
            const fenceLine = CM.Decoration.line({ class: 'tzmd-fence' });
            const buildCode = (v) => {
                const lex = window.lexCodeLine;
                if (typeof lex !== 'function' || !(codeLang || kind === 'markdown')) return CM.Decoration.none;
                const doc = v.state.doc, b = new CM.RangeSetBuilder();
                const vp = v.viewport;
                // Lex lines [lexFrom, to] carrying state; decorate from `from` on.
                const lexLines = (lang, lexFrom, from, to, fence) => {
                    let st = 0;
                    for (let n = lexFrom; n <= to; n++) {
                        const line = doc.line(n);
                        const r = lang ? lex(line.text, lang, st) : { tokens: [], state: 0 };
                        st = r.state;
                        if (n < from) continue;
                        if (fence) b.add(line.from, line.from, fenceLine);
                        for (const tok of r.tokens) {
                            if (tok.e > tok.s) b.add(line.from + tok.s, line.from + tok.e, tokenMark(tok.t));
                        }
                    }
                };
                const first = doc.lineAt(vp.from).number, last = doc.lineAt(vp.to).number;
                if (codeLang) {
                    lexLines(codeLang, Math.max(1, first - CODE_LOOKBACK), first, last, false);
                    return b.finish();
                }
                CM.syntaxTree(v.state).iterate({
                    from: vp.from, to: vp.to,
                    enter: (node) => {
                        if (node.name !== 'FencedCode') return;
                        const info = node.node.getChild('CodeInfo');
                        const lang = info && typeof window.codeLanguageForFence === 'function'
                            ? window.codeLanguageForFence(doc.sliceString(info.from, info.to)) : null;
                        const open = doc.lineAt(node.from).number, close = doc.lineAt(node.to).number;
                        const closed = close > open && /^\s*(```|~~~)/.test(doc.line(close).text);
                        const vFirst = Math.max(open, first), vLast = Math.min(close, last);
                        // The fence lines themselves: tinted, not lexed.
                        if (vFirst === open) b.add(doc.line(open).from, doc.line(open).from, fenceLine);
                        const bodyFirst = open + 1, bodyLast = closed ? close - 1 : close;
                        const from = Math.max(bodyFirst, vFirst), to = Math.min(bodyLast, vLast);
                        if (to >= from) lexLines(lang, Math.max(bodyFirst, from - CODE_LOOKBACK), from, to, true);
                        if (closed && vLast === close && close > open) b.add(doc.line(close).from, doc.line(close).from, fenceLine);
                        return false;
                    }
                });
                return b.finish();
            };
            
            // --- Spelling --------------------------------------------------------------
            // The Windows spell checker, as in Preview, through the same remembering checker
            // (spellCheckTexts / spellCached in 02-layout.js): the lines on screen are
            // underlined at once from what is already known, and only lines not seen in their
            // current form go to the host. Answers are keyed by a line's exact text, so one
            // can never land on text that has changed since. Drawn as decorations in
            // Preview's typozen-spell style; Chromium's own checker is off here -- inside
            // CodeMirror its squiggles came and went as lines were redrawn.
            const cmSpellEffect = CM.StateEffect.define();
            const cmSpellField = CM.StateField.define({
                create: () => CM.Decoration.none,
                update(deco, tr) {
                    deco = deco.map(tr.changes);
                    for (const e of tr.effects) if (e.is(cmSpellEffect)) deco = e.value;
                    return deco;
                },
                provide: (f) => CM.EditorView.decorations.from(f)
            });
            const spellMark = CM.Decoration.mark({ class: 'typozen-spell' });

            /** The non-blank lines on screen: [{ from, text }]. */
            const visibleLines = (v) => {
                const d = v.state.doc, out = [];
                const last = d.lineAt(v.viewport.to).number;
                for (let n = d.lineAt(v.viewport.from).number; n <= last; n++) {
                    const line = d.line(n);
                    if (line.text.trim()) out.push({ from: line.from, text: line.text });
                }
                return out;
            };
            /** Underline what is known about these lines; unknown ones stay clean until answered. */
            const paintSpelling = (v, lines) => {
                const n = v.state.doc.length, decos = [], words = [];
                for (const l of lines) {
                    const hits = window.spellCached(l.text);
                    if (!hits) continue;
                    for (const h of hits) {
                        const x = l.from + h.start, y = x + h.len;
                        if (x < y && y <= n) { decos.push(spellMark.range(x, y)); words.push(h.word); }
                    }
                }
                window._cmSpellWords = words;                // the popover asks whether a word is underlined
                v.dispatch({ effects: cmSpellEffect.of(CM.Decoration.set(decos, true)), annotations: programmatic.of(true) });
            };

            const cmSpellPlugin = CM.ViewPlugin.fromClass(class {
                constructor(v) { this.timer = null; this.schedule(v); }
                update(u) { if (u.docChanged || u.viewportChanged) this.schedule(u.view); }
                schedule(v) {
                    clearTimeout(this.timer);
                    this.timer = setTimeout(() => this.run(v), 420);
                }
                run(v) {
                    this.timer = null;
                    if (typeof state !== 'undefined' && state && state.mode !== 'source') return;
                    if (typeof window.spellCheckTexts !== 'function') return;
                    const lines = visibleLines(v);
                    paintSpelling(v, lines);                                  // what is known, now
                    const missing = lines.filter(l => window.spellCached(l.text) === undefined).length;
                    if (!missing) return;                                     // nothing new on screen
                    window.spellCheckTexts(lines.map(l => l.text), () => {
                        const now = visibleLines(v);                          // it may have scrolled
                        paintSpelling(v, now);
                        const still = now.filter(l => window.spellCached(l.text) === undefined).length;
                        if (still && still < missing) this.schedule(v);       // a capped answer: the rest
                    });
                }
                destroy() { clearTimeout(this.timer); }
            });

            const codePlugin = CM.ViewPlugin.fromClass(class {
                constructor(v) { this.decorations = buildCode(v); }
                update(u) {
                    if (u.docChanged || u.viewportChanged
                        || CM.syntaxTree(u.startState) !== CM.syntaxTree(u.state)
                        || u.transactions.some(tr => tr.effects.some(e => e.is(kindChanged)))) {
                        this.decorations = buildCode(u.view);
                    }
                }
            }, { decorations: (p) => p.decorations });

            // Lines Preview spaces differently from a paragraph: an empty line is an empty
            // .block (shorter than a line of text), and list lines pack tight
            // (.block.list-block, by Preview's own test, parseListLine in 04-lists.js). Mark
            // the same lines here so both views space them alike. Fenced code is spaced by
            // its own tzmd-fence rule.
            const listLine = CM.Decoration.line({ class: 'tzsp-li' });
            const blankLine = CM.Decoration.line({ class: 'tzsp-blank' });
            const buildLists = (v) => {
                // A code file is one .block per line in Preview too, but never a list.
                const isList = !codeLang && typeof window.parseListLine === 'function' ? window.parseListLine : () => null;
                const d = v.state.doc, b = new CM.RangeSetBuilder();
                const last = d.lineAt(v.viewport.to).number;
                for (let n = d.lineAt(v.viewport.from).number; n <= last; n++) {
                    const line = d.line(n);
                    if (!line.length) b.add(line.from, line.from, blankLine);
                    else if (isList(line.text)) b.add(line.from, line.from, listLine);
                }
                return b.finish();
            };
            const listPlugin = CM.ViewPlugin.fromClass(class {
                constructor(v) { this.decorations = buildLists(v); }
                update(u) {
                    if (u.docChanged || u.viewportChanged
                        || u.transactions.some(tr => tr.effects.some(e => e.is(kindChanged)))) {
                        this.decorations = buildLists(u.view);
                    }
                }
            }, { decorations: (p) => p.decorations });

            const wrapExt = () => document.body && document.body.classList.contains('nowrap')
                ? [] : CM.EditorView.lineWrapping;

            // Keys: CodeMirror's standard caret and selection bindings only. Enter is a
            // plain newline -- TypoZen's own Enter (indent and list continuation, in
            // 03-shell.js) runs first and takes the key when it has something to carry.
            // Nothing that shadows a TypoZen or host shortcut (plan, section 5.2).
            const keys = CM.standardKeymap.filter(b => b.key !== 'Enter' && b.key !== 'Mod-Enter');
            keys.push({ key: 'Enter', run: (v) => {
                const r = v.state.selection.main;
                v.dispatch({ changes: { from: r.from, to: r.to, insert: '\n' },
                    selection: { anchor: r.from + 1 }, scrollIntoView: true, userEvent: 'input' });
                return true;
            } });

            const view = new CM.EditorView({
                parent: host,
                state: CM.EditorState.create({
                    doc: '',
                    extensions: [
                        wrapping.of(wrapExt()),
                        editable.of(CM.EditorView.editable.of(true)),
                        CM.EditorView.contentAttributes.of({
                            spellcheck: 'false',
                            lang: host.getAttribute('lang') || 'en',
                            'aria-label': 'Source'
                        }),
                        CM.keymap.of(keys),
                        language.of([]),
                        codePlugin,
                        listPlugin,
                        cmSpellField,
                        cmSpellPlugin,
                        marksField,
                        CM.EditorView.updateListener.of((u) => {
                            if (u.docChanged) {
                                cachedDoc = null;
                                const typed = u.transactions.some(tr => tr.docChanged && !tr.annotation(programmatic));
                                // After the update has finished: a listener may itself
                                // dispatch, which CodeMirror refuses mid-update. Still
                                // before the next paint, as a textarea's input event is.
                                if (typed) queueMicrotask(() => fire('input', new Event('input')));
                            }
                            if (u.selectionSet && !u.state.selection.main.empty) {
                                queueMicrotask(() => fire('select', new Event('select')));
                            }
                        })
                    ]
                })
            });
            applyKind();
            view.scrollDOM.addEventListener('scroll', (e) => fire('scroll', e), { passive: true });

            // One undo history: HistoryManager's, shared with Preview. Ctrl+Z / Ctrl+Y never
            // get here (05-model.js takes them at the window, in the capture phase); this is
            // Undo and Redo from the right-click menu, which the browser would otherwise
            // apply to CodeMirror's DOM as an edit of its own.
            host.addEventListener('beforeinput', (e) => {
                if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
                e.preventDefault();
                if (typeof HistoryManager === 'undefined') return;
                if (e.inputType === 'historyUndo') HistoryManager.undo(); else HistoryManager.redo();
            }, true);

            // Word wrap follows body.nowrap, as the textarea's CSS did.
            try {
                new MutationObserver(() => {
                    view.dispatch({ effects: wrapping.reconfigure(wrapExt()), annotations: programmatic.of(true) });
                }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
            } catch (eWrap) {}

            const text = () => {
                const d = view.state.doc;
                if (d !== cachedDoc) { cachedText = d.toString(); cachedDoc = d; }
                return cachedText;
            };
            const clamp = (n) => Math.max(0, Math.min(view.state.doc.length, n | 0));
            const selectRange = (a, b, dir) => {
                a = clamp(a); b = clamp(b);
                if (b < a) b = a;
                const sel = dir === 'backward' ? CM.EditorSelection.single(b, a) : CM.EditorSelection.single(a, b);
                view.dispatch({ selection: sel, annotations: programmatic.of(true) });
            };

            // Inline style the engine sets on the textarea, routed to where it means the
            // same thing here: the box on the host, padding on the content (inside the
            // scroller, as a textarea's padding is), scrolling left to CodeMirror.
            const styleTarget = (prop) => {
                if (/^padding/.test(prop)) return view.contentDOM.style;
                if (/^overflow|^boxSizing$|^whiteSpace$/.test(prop)) return null;
                return host.style;
            };
            const style = new Proxy({}, {
                get: (o, prop) => {
                    if (typeof prop !== 'string') return undefined;
                    const t = styleTarget(prop);
                    return t ? t[prop] : '';
                },
                set: (o, prop, v) => {
                    const t = styleTarget(prop);
                    if (t) t[prop] = v;
                    // Hidden Source holds no search marks. Leaving Source could otherwise
                    // repaint them while state.mode still said 'source', and they came back
                    // stale on the next visit (source-highlight-app, "leaving Source").
                    if (prop === 'display' && v === 'none') surface.setSearchMarks([]);
                    return true;
                }
            });

            const surface = {
                view: view,
                tagName: 'CM-SOURCE',
                get value() { return text(); },
                set value(v) {
                    // A textarea stores CRLF and a lone CR as LF, and so does CodeMirror --
                    // normalise first, or every offset below counts characters the
                    // document will not have (source-roundtrip-browser, CRLF case).
                    v = v == null ? '' : String(v).replace(/\r\n?/g, '\n');
                    // Every load puts its text here, after the host has said what kind of
                    // document it is (doc_ext:): pick up the matching highlighting.
                    applyKind();
                    const cur = text();
                    if (v === cur) return;
                    // Replace only the part that changed, so the selection, scroll position
                    // and decorations outside it survive -- a whole-document replace would
                    // throw them all away on every undo step.
                    let a = 0;
                    const max = Math.min(v.length, cur.length);
                    while (a < max && v.charCodeAt(a) === cur.charCodeAt(a)) a++;
                    let b = 0;
                    while (b < max - a && v.charCodeAt(v.length - 1 - b) === cur.charCodeAt(cur.length - 1 - b)) b++;
                    // A textarea puts the caret at the end when its value is set.
                    view.dispatch({
                        changes: { from: a, to: cur.length - b, insert: v.slice(a, v.length - b) },
                        selection: { anchor: v.length },
                        annotations: programmatic.of(true)
                    });
                },
                get selectionStart() { return view.state.selection.main.from; },
                set selectionStart(n) {
                    const r = view.state.selection.main;
                    n = clamp(n);
                    selectRange(n, Math.max(n, r.to));
                },
                get selectionEnd() { return view.state.selection.main.to; },
                set selectionEnd(n) {
                    const r = view.state.selection.main;
                    n = clamp(n);
                    selectRange(Math.min(r.from, n), n);
                },
                get selectionDirection() {
                    const r = view.state.selection.main;
                    return r.head < r.anchor ? 'backward' : 'forward';
                },
                setSelectionRange(a, b, dir) { selectRange(a, b == null ? a : b, dir); },
                select() { selectRange(0, view.state.doc.length); },
                /** The DOM's setRangeText, including its selectMode rules. */
                setRangeText(replacement, start, end, mode) {
                    const r = view.state.selection.main;
                    if (start == null) { start = r.from; end = r.to; }
                    start = clamp(start); end = clamp(end == null ? start : end);
                    if (end < start) end = start;
                    replacement = replacement == null ? '' : String(replacement).replace(/\r\n?/g, '\n');
                    const len = replacement.length, delta = len - (end - start);
                    let a, b;
                    if (mode === 'select') { a = start; b = start + len; }
                    else if (mode === 'start') { a = b = start; }
                    else if (mode === 'end') { a = b = start + len; }
                    else {
                        // 'preserve': the selection stays where it was, shifted by the edit.
                        const shift = (p) => p <= start ? p : (p >= end ? p + delta : start);
                        a = shift(r.from); b = shift(r.to);
                        if (r.from === start && r.to === end) { a = start; b = start + len; }
                    }
                    view.dispatch({
                        changes: { from: start, to: end, insert: replacement },
                        selection: CM.EditorSelection.single(a, b),
                        annotations: programmatic.of(true)
                    });
                },
                get readOnly() { return !view.state.facet(CM.EditorView.editable); },
                set readOnly(v) {
                    view.dispatch({ effects: editable.reconfigure(CM.EditorView.editable.of(!v)), annotations: programmatic.of(true) });
                },
                get scrollTop() { return view.scrollDOM.scrollTop; },
                set scrollTop(v) { view.scrollDOM.scrollTop = v; },
                get scrollLeft() { return view.scrollDOM.scrollLeft; },
                set scrollLeft(v) { view.scrollDOM.scrollLeft = v; },
                get scrollHeight() { return view.scrollDOM.scrollHeight; },
                get clientHeight() { return view.scrollDOM.clientHeight; },
                get clientWidth() { return view.scrollDOM.clientWidth; },
                get offsetWidth() { return host.offsetWidth; },
                get offsetHeight() { return host.offsetHeight; },
                get parentElement() { return host.parentElement; },
                get parentNode() { return host.parentNode; },
                get style() { return style; },
                get classList() { return host.classList; },
                getBoundingClientRect() { return host.getBoundingClientRect(); },
                getAttribute(n) { return host.getAttribute(n); },
                setAttribute(n, v) { host.setAttribute(n, v); },
                focus() { view.focus(); },
                blur() { try { view.contentDOM.blur(); } catch (e) {} },
                /**
                 * Mark these { start, end } ranges (sorted, as findState.matches is); the
                 * one at index `cur` as the current hit. An empty list clears them.
                 */
                setSearchMarks(list, cur) {
                    if (host.style.display === 'none') list = [];   // see style.display above
                    const n = view.state.doc.length, ranges = [];
                    let last = 0;
                    for (let i = 0; i < (list || []).length; i++) {
                        const m = list[i];
                        const a = Math.max(0, Math.min(n, m.start | 0)), b = Math.max(0, Math.min(n, m.end | 0));
                        if (b <= a || a < last) continue;      // empty, or overlapping: keep the first
                        ranges.push((i === cur ? curMark : hitMark).range(a, b));
                        last = b;
                    }
                    view.dispatch({ effects: setMarks.of(CM.Decoration.set(ranges)), annotations: programmatic.of(true) });
                },
                /** Check the lines on screen for spelling again, after the usual pause. */
                recheckSpelling() {
                    const pl = view.plugin(cmSpellPlugin);
                    if (pl) pl.schedule(view);
                },
                /** The marks as drawn: [{ from, to, cur }], in document order. */
                searchMarks() {
                    const out = [];
                    const it = view.state.field(marksField).iter();
                    for (; it.value; it.next()) {
                        out.push({ from: it.from, to: it.to, cur: /\bcur\b/.test(it.value.spec.class || '') });
                    }
                    return out;
                },
                /**
                 * Scroll so `pos` sits `margin` px below the top of the view, or in its
                 * middle with align 'center' (typewriter mode). The caret does not move.
                 */
                scrollToOffset(pos, margin, align) {
                    let m = margin | 0;
                    // CodeMirror puts the character's own box at the margin, which sits below
                    // its line's top by the line's padding and half-leading. Add that gap, read
                    // off a line on screen, so the line's top lands where a block's top does in
                    // Preview -- else a switch from Preview comes out a few pixels low.
                    if (!align) {
                        try {
                            const from = view.viewport.from, c = view.coordsAtPos(from);
                            if (c) m += Math.max(0, Math.round(c.top - view.documentTop - view.lineBlockAt(from).top));
                        } catch (eGap) {}
                    }
                    view.dispatch({
                        effects: CM.EditorView.scrollIntoView(clamp(pos), { y: align || 'start', yMargin: m }),
                        annotations: programmatic.of(true)
                    });
                },
                /**
                 * The 1-based document line at the top of the visible part: from CodeMirror's
                 * own layout, so a wrapped paragraph counts once however many rows it takes
                 * (a textarea could only estimate this from the scroll fraction).
                 */
                topLine() {
                    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop + 1;
                    const block = view.lineBlockAtHeight(Math.max(0, top));
                    return view.state.doc.lineAt(block.from).number;
                },
                /** True for the surface itself and anything inside it (the focus lands inside). */
                contains(node) { return !!node && (node === surface || host.contains(node)); },
                addEventListener(type, fn, opts) {
                    if (listeners[type]) { listeners[type].push(fn); return; }
                    // Key, mouse, clipboard and drag events: on the host, in the capture
                    // phase, so TypoZen's handler runs before CodeMirror's -- and an event it
                    // prevents is one CodeMirror then ignores (eventBelongsToEditor).
                    host.addEventListener(type, fn, typeof opts === 'object' ? Object.assign({}, opts, { capture: true }) : true);
                },
                removeEventListener(type, fn) {
                    if (listeners[type]) { listeners[type] = listeners[type].filter(f => f !== fn); return; }
                    host.removeEventListener(type, fn, true);
                },
                dispatchEvent(ev) {
                    if (ev && listeners[ev.type]) { fire(ev.type, ev); return true; }
                    return host.dispatchEvent(ev);
                }
            };
            return surface;
        }

        /**
         * The type of the document about to load, as its extension ('md', 'css', 'txt', ''
         * for untitled). The host sends it (doc_ext:) before every load; Source picks its
         * highlighting from it when the text arrives.
         */
        function setSourceDocExt(ext) {
            if (typeof state !== 'undefined' && state) state.docExt = String(ext == null ? '' : ext).toLowerCase();
        }

        /** True for Source's editing surface and anything inside it. */
        function isSourceNode(node) {
            if (!node || typeof sourceEditor === 'undefined' || !sourceEditor) return false;
            if (node === sourceEditor) return true;
            return !!(sourceEditor.contains && sourceEditor.contains(node));
        }

        /** Source is on screen: CodeMirror's host is not display:none. */
        function isSourceShown() {
            const el = document.getElementById('source-cm');
            return !!el && window.getComputedStyle(el).display !== 'none';
        }

        /** Source has the keyboard focus (CodeMirror's focus sits on an element inside it). */
        function isSourceFocused() {
            return isSourceNode(document.activeElement);
        }
