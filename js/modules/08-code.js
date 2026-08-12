/* =============================================================================
 * TypoZen — code documents
 *
 * A code file is a DocumentModel of kind 'code': one block per line, raw is that
 * line byte for byte. Everything downstream — virtualisation, the height map,
 * search, bookmarks, annotations, themes, Pages — already works on blocks and
 * does not care what a raw holds. That is why this file is small.
 *
 * WHY TOKENS ARE REAL ELEMENTS HERE, AND NOT ELSEWHERE
 * ----------------------------------------------------
 * Search matches and bookmark highlights are painted with the CSS Custom Highlight
 * API because a `<mark>` inside a Markdown block round-trips into `data-raw` and
 * becomes part of the user's file. That constraint does NOT apply to a code block,
 * and the difference is worth stating precisely: the danger was never elements as
 * such, it was that Markdown serialisation reads markup back out. A code block's
 * raw is only ever rewritten from `textContent`, which strips markup, so spans
 * cannot corrupt it.
 *
 * The payoff is that ::highlight()'s property ceiling does not apply either. That
 * pseudo honours colour, background, text-decoration and shadow, and ignores
 * font-weight and font-style — so a Highlight-API implementation could not have
 * bold keywords or italic comments. These can.
 *
 * LEXING IS PER LINE, AND THAT IS A CONSTRAINT NOT A SHORTCUT
 * ----------------------------------------------------------
 * One block is one line, so a lexer sees one line at a time and carries a start
 * state into the next (inside a block comment, inside a string). Re-lexing the
 * whole document on a keystroke would wreck a typing path this codebase has tuned
 * hard — Preview virtualises past ~2000 blocks precisely because whole-document
 * work is visible at that size. An edit re-lexes its own line and continues only
 * while the carried state keeps changing.
 * ============================================================================= */
(function () {
        'use strict';

        /** Extension → lexer name. The host decides a file is code; this decides how. */
        const CODE_LANGUAGES = {
            json: 'json', jsonc: 'json',
            xml: 'xml', xaml: 'xml', axaml: 'xml', csproj: 'xml', props: 'xml',
            targets: 'xml', config: 'xml', resx: 'xml', svg: 'xml', xsd: 'xml', plist: 'xml',
            cs: 'clike', js: 'clike', mjs: 'clike', cjs: 'clike', ts: 'clike', tsx: 'clike',
            jsx: 'clike', java: 'clike', c: 'clike', h: 'clike', cpp: 'clike', hpp: 'clike',
            cc: 'clike', go: 'clike', rs: 'clike', swift: 'clike', kt: 'clike', php: 'clike'
        };

        /** True when this path should open as a code document. */
        function codeLanguageForPath(path) {
            const s = String(path == null ? '' : path);
            const dot = s.lastIndexOf('.');
            if (dot < 0) return null;
            const ext = s.slice(dot + 1).toLowerCase();
            return CODE_LANGUAGES[ext] || null;
        }

        // --- Lexers ---------------------------------------------------------------
        //
        // Each takes (line, state) and returns { tokens, state }. A token is
        // { s, e, t }: start offset, end offset, class name. Offsets are into the line,
        // so a caller can map them onto anything -- spans here, ranges elsewhere.
        //
        // State is a small integer, and it is what makes a line-at-a-time lexer able to
        // handle constructs that span lines. 0 is "ordinary".

        const ST_NONE = 0;
        const ST_BLOCK_COMMENT = 1;
        const ST_XML_COMMENT = 2;

        const CLIKE_KEYWORDS = new Set([
            'abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'byte', 'case',
            'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default',
            'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extends',
            'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'from',
            'func', 'function', 'get', 'goto', 'if', 'impl', 'implements', 'implicit',
            'import', 'in', 'int', 'interface', 'internal', 'is', 'let', 'lock', 'long',
            'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'package',
            'params', 'private', 'protected', 'public', 'readonly', 'record', 'ref',
            'return', 'sbyte', 'sealed', 'set', 'short', 'sizeof', 'stackalloc', 'static',
            'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint',
            'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'var', 'virtual', 'void',
            'volatile', 'when', 'where', 'while', 'yield'
        ]);

        /**
         * C-family: C#, JS/TS, Java, Go, Rust and near enough others.
         *
         * Deliberately NOT a C# parser. C# done properly means verbatim strings,
         * interpolated strings with nested braces and nested quotes, and raw string
         * literals -- a project of its own. This handles the shapes that carry most of
         * the visual information (comments, strings, numbers, keywords) and is honest
         * about the rest by leaving it unstyled rather than guessing.
         */
        function lexClike(line, state) {
            const tokens = [];
            const n = line.length;
            let i = 0;
            let st = state | 0;

            if (st === ST_BLOCK_COMMENT) {
                const end = line.indexOf('*/');
                if (end < 0) {
                    if (n) tokens.push({ s: 0, e: n, t: 'comment' });
                    return { tokens: tokens, state: ST_BLOCK_COMMENT };
                }
                tokens.push({ s: 0, e: end + 2, t: 'comment' });
                i = end + 2;
                st = ST_NONE;
            }

            while (i < n) {
                const c = line.charAt(i);

                if (c === '/' && line.charAt(i + 1) === '/') {
                    tokens.push({ s: i, e: n, t: 'comment' });
                    break;
                }
                if (c === '/' && line.charAt(i + 1) === '*') {
                    const end = line.indexOf('*/', i + 2);
                    if (end < 0) {
                        tokens.push({ s: i, e: n, t: 'comment' });
                        return { tokens: tokens, state: ST_BLOCK_COMMENT };
                    }
                    tokens.push({ s: i, e: end + 2, t: 'comment' });
                    i = end + 2;
                    continue;
                }
                if (c === '"' || c === '\'' || c === '`') {
                    let j = i + 1;
                    while (j < n) {
                        if (line.charAt(j) === '\\') { j += 2; continue; }
                        if (line.charAt(j) === c) { j++; break; }
                        j++;
                    }
                    tokens.push({ s: i, e: Math.min(j, n), t: 'string' });
                    i = Math.min(j, n);
                    continue;
                }
                if (c >= '0' && c <= '9') {
                    let j = i;
                    while (j < n && /[0-9a-fA-FxXbBoO._]/.test(line.charAt(j))) j++;
                    tokens.push({ s: i, e: j, t: 'number' });
                    i = j;
                    continue;
                }
                if (/[A-Za-z_$@]/.test(c)) {
                    let j = i;
                    while (j < n && /[A-Za-z0-9_$]/.test(line.charAt(j))) j++;
                    const word = line.slice(i, j);
                    if (CLIKE_KEYWORDS.has(word)) {
                        tokens.push({ s: i, e: j, t: 'keyword' });
                    } else if (line.charAt(j) === '(') {
                        tokens.push({ s: i, e: j, t: 'fn' });
                    } else if (/^[A-Z]/.test(word)) {
                        tokens.push({ s: i, e: j, t: 'type' });
                    }
                    i = j;
                    continue;
                }
                i++;
            }
            return { tokens: tokens, state: st };
        }

        /** XML / XAML. Small grammar, so this one is close to complete. */
        function lexXml(line, state) {
            const tokens = [];
            const n = line.length;
            let i = 0;
            let st = state | 0;

            if (st === ST_XML_COMMENT) {
                const end = line.indexOf('-->');
                if (end < 0) {
                    if (n) tokens.push({ s: 0, e: n, t: 'comment' });
                    return { tokens: tokens, state: ST_XML_COMMENT };
                }
                tokens.push({ s: 0, e: end + 3, t: 'comment' });
                i = end + 3;
                st = ST_NONE;
            }

            while (i < n) {
                if (line.startsWith('<!--', i)) {
                    const end = line.indexOf('-->', i + 4);
                    if (end < 0) {
                        tokens.push({ s: i, e: n, t: 'comment' });
                        return { tokens: tokens, state: ST_XML_COMMENT };
                    }
                    tokens.push({ s: i, e: end + 3, t: 'comment' });
                    i = end + 3;
                    continue;
                }
                if (line.charAt(i) === '<') {
                    let j = i + 1;
                    if (line.charAt(j) === '/' || line.charAt(j) === '?' || line.charAt(j) === '!') j++;
                    const nameStart = j;
                    while (j < n && /[A-Za-z0-9_:.\-]/.test(line.charAt(j))) j++;
                    if (j > nameStart) tokens.push({ s: nameStart, e: j, t: 'tag' });
                    // Attributes up to the closing '>'.
                    while (j < n && line.charAt(j) !== '>') {
                        if (/[A-Za-z_:]/.test(line.charAt(j))) {
                            const aStart = j;
                            while (j < n && /[A-Za-z0-9_:.\-]/.test(line.charAt(j))) j++;
                            tokens.push({ s: aStart, e: j, t: 'attr' });
                            continue;
                        }
                        if (line.charAt(j) === '"' || line.charAt(j) === '\'') {
                            const q = line.charAt(j);
                            let k = j + 1;
                            while (k < n && line.charAt(k) !== q) k++;
                            tokens.push({ s: j, e: Math.min(k + 1, n), t: 'string' });
                            j = Math.min(k + 1, n);
                            continue;
                        }
                        j++;
                    }
                    i = Math.min(j + 1, n);
                    continue;
                }
                i++;
            }
            return { tokens: tokens, state: st };
        }

        /**
         * JSON. Keys and values are both strings, so they are told apart by what
         * follows: a string with a ':' after it is a key. That distinction is most of
         * what makes JSON readable at a glance.
         */
        function lexJson(line) {
            const tokens = [];
            const n = line.length;
            let i = 0;
            while (i < n) {
                const c = line.charAt(i);
                if (c === '"') {
                    let j = i + 1;
                    while (j < n) {
                        if (line.charAt(j) === '\\') { j += 2; continue; }
                        if (line.charAt(j) === '"') { j++; break; }
                        j++;
                    }
                    const end = Math.min(j, n);
                    let k = end;
                    while (k < n && /\s/.test(line.charAt(k))) k++;
                    tokens.push({ s: i, e: end, t: line.charAt(k) === ':' ? 'attr' : 'string' });
                    i = end;
                    continue;
                }
                if (c === '-' || (c >= '0' && c <= '9')) {
                    let j = i;
                    while (j < n && /[0-9eE+\-.]/.test(line.charAt(j))) j++;
                    tokens.push({ s: i, e: j, t: 'number' });
                    i = j;
                    continue;
                }
                if (/[a-z]/.test(c)) {
                    let j = i;
                    while (j < n && /[a-z]/.test(line.charAt(j))) j++;
                    const w = line.slice(i, j);
                    if (w === 'true' || w === 'false' || w === 'null') {
                        tokens.push({ s: i, e: j, t: 'keyword' });
                    }
                    i = j;
                    continue;
                }
                i++;
            }
            return { tokens: tokens, state: ST_NONE };
        }

        const LEXERS = { clike: lexClike, xml: lexXml, json: lexJson };

        /** Lex one line. Unknown languages produce no tokens rather than a guess. */
        function lexCodeLine(line, language, state) {
            const fn = LEXERS[language];
            if (!fn) return { tokens: [], state: ST_NONE };
            try { return fn(String(line == null ? '' : line), state | 0); }
            catch (e) { return { tokens: [], state: ST_NONE }; }
        }

        /**
         * The carried lexer state at the start of each line, cached.
         *
         * Rebuilt from the first dirty line onward and stopped as soon as the carried
         * state matches what was already recorded -- past that point nothing downstream
         * can have changed, so re-lexing it would be work with no output. A file with no
         * block comments converges after one line.
         */
        const CodeStates = {
            _states: null,
            invalidate: function () { this._states = null; },

            stateAt: function (index) {
                this._ensure(index);
                return (this._states && this._states[index] != null) ? this._states[index] : ST_NONE;
            },

            _ensure: function (upTo) {
                if (typeof DocumentModel === 'undefined' || DocumentModel.kind !== 'code') return;
                const blocks = DocumentModel.blocks || [];
                if (!this._states) this._states = [ST_NONE];
                const lang = DocumentModel.language;
                for (let i = this._states.length - 1; i < upTo && i < blocks.length; i++) {
                    const r = lexCodeLine(blocks[i].raw, lang, this._states[i] || ST_NONE);
                    this._states[i + 1] = r.state;
                }
            },

            /** An edited line may change what every line after it means. Re-lex until it does not. */
            reflowFrom: function (index) {
                if (typeof DocumentModel === 'undefined' || DocumentModel.kind !== 'code') return 0;
                const blocks = DocumentModel.blocks || [];
                if (!this._states) { this._ensure(index + 1); return 0; }
                const lang = DocumentModel.language;
                let changed = 0;
                for (let i = index; i < blocks.length; i++) {
                    const before = this._states[i + 1];
                    const r = lexCodeLine(blocks[i].raw, lang, this._states[i] || ST_NONE);
                    this._states[i + 1] = r.state;
                    changed++;
                    if (before === r.state && i > index) break;
                }
                return changed;
            }
        };

        /** Escape for innerHTML. Tokens are spliced into markup, so this is not optional. */
        function escCode(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        /**
         * One line of code as HTML: the line, with token spans over it.
         *
         * Gaps between tokens are emitted verbatim, so every character of the line is
         * present exactly once and textContent reconstructs the raw byte for byte. That
         * property is what lets the edit path rewrite data-raw from textContent without
         * the spans ever entering the document.
         */
        function renderCodeLine(raw, language, state) {
            const line = String(raw == null ? '' : raw);
            if (!line) return '';
            const r = lexCodeLine(line, language, state);
            const toks = r.tokens;
            if (!toks.length) return escCode(line);
            let out = '';
            let at = 0;
            for (let i = 0; i < toks.length; i++) {
                const t = toks[i];
                if (t.s < at || t.e <= t.s) continue;      // overlapping or empty: skip
                if (t.s > at) out += escCode(line.slice(at, t.s));
                out += '<span class="tzc-' + t.t + '">' + escCode(line.slice(t.s, t.e)) + '</span>';
                at = t.e;
            }
            if (at < line.length) out += escCode(line.slice(at));
            return out;
        }

        window.codeLanguageForPath = codeLanguageForPath;
        window.lexCodeLine = lexCodeLine;
        window.renderCodeLine = renderCodeLine;
        window.CodeStates = CodeStates;
        window.CODE_LANGUAGES = CODE_LANGUAGES;
})();
