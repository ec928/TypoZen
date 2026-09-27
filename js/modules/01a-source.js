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
//   2. It behaves like the textarea it replaces, including where that is inconvenient:
//      setting `value` or calling setRangeText does not fire `input`; typing does.
//
// The textarea is kept, hidden, and IS the surface when CodeMirror is unavailable (the
// jsdom test page does not load the bundle) or switched off: `?source=textarea` on the
// page, or localStorage tzSourceEngine = "textarea". Ed's condition (2026-09-27): if
// CodeMirror costs performance, it becomes an option rather than the default -- so the
// textarea path stays whole.

        function createSourceSurface(textarea) {
            let engine = 'codemirror';
            try {
                const q = /[?&]source=(textarea|codemirror)\b/.exec(location.search || '');
                if (q) engine = q[1];
                else if (window.localStorage && localStorage.getItem('tzSourceEngine') === 'textarea') engine = 'textarea';
            } catch (eEng) {}
            const CM = window.TzCM;
            if (!textarea || !CM || engine !== 'codemirror') {
                window.__tzSourceEngine = 'textarea';
                return textarea;
            }
            window.__tzSourceEngine = 'codemirror';

            const host = document.createElement('div');
            host.id = 'source-cm';
            host.style.display = 'none';
            textarea.parentNode.insertBefore(host, textarea.nextSibling);
            textarea.style.display = 'none';
            textarea.setAttribute('aria-hidden', 'true');
            textarea.tabIndex = -1;

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
                    doc: textarea.value || '',
                    extensions: [
                        wrapping.of(wrapExt()),
                        editable.of(CM.EditorView.editable.of(true)),
                        CM.EditorView.contentAttributes.of({
                            spellcheck: 'true',
                            lang: textarea.getAttribute('lang') || 'en',
                            'aria-label': 'Source'
                        }),
                        CM.keymap.of(keys),
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
                    // Hidden Source holds no search marks -- the rule the textarea's mirror
                    // keeps by watching the textarea. Leaving Source could otherwise repaint
                    // them while state.mode still said 'source', and they came back stale
                    // on the next visit (source-highlight-app, "leaving Source").
                    if (prop === 'display' && v === 'none') surface.setSearchMarks([]);
                    return true;
                }
            });

            const surface = {
                isCodeMirror: true,
                view: view,
                tagName: 'CM-SOURCE',
                get value() { return text(); },
                set value(v) {
                    // A textarea stores CRLF and a lone CR as LF, and so does CodeMirror --
                    // normalise first, or every offset below counts characters the
                    // document will not have (source-roundtrip-browser, CRLF case).
                    v = v == null ? '' : String(v).replace(/\r\n?/g, '\n');
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
                    view.dispatch({
                        effects: CM.EditorView.scrollIntoView(clamp(pos), { y: align || 'start', yMargin: margin | 0 }),
                        annotations: programmatic.of(true)
                    });
                },
                /**
                 * The 1-based document line at the top of the visible part: from CodeMirror's
                 * own layout, so a wrapped paragraph counts once however many rows it takes
                 * (the textarea path can only estimate this from the scroll fraction).
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

        /** True for Source's editing surface and anything inside it. */
        function isSourceNode(node) {
            if (!node || typeof sourceEditor === 'undefined' || !sourceEditor) return false;
            if (node === sourceEditor) return true;
            return !!(sourceEditor.contains && sourceEditor.contains(node));
        }

        /** Source is on screen: the textarea, or CodeMirror's host, is not display:none. */
        function isSourceShown() {
            if (typeof sourceEditor === 'undefined' || !sourceEditor) return false;
            const el = sourceEditor.isCodeMirror ? document.getElementById('source-cm') : sourceEditor;
            return !!el && window.getComputedStyle(el).display !== 'none';
        }

        /** Source has the keyboard focus (CodeMirror's focus sits on an element inside it). */
        function isSourceFocused() {
            return isSourceNode(document.activeElement);
        }
