/* =============================================================================
 * TypoZen — code lexers, and highlighting for fenced code
 *
 * WHAT THIS IS FOR
 * ----------------
 * A ```lang fence inside a Markdown document, painted with the CSS Custom
 * Highlight API. Nothing else. There is no code document kind and no fourth
 * editing surface here.
 *
 * WHY IT PAINTS INSTEAD OF WRAPPING
 * ---------------------------------
 * A .block is a projection of one model row and its content round-trips into
 * data-raw on every edit, so anything injected as an element becomes part of the
 * user's file. That is not a theory: wrapping tokens in spans was tried for a
 * whole-file code kind and Markdown's own DOM repair -- expandAllFragmentedBlocks,
 * which undoes soft breaks left by editing -- split those spans into separate
 * lines. One keystroke turned a 9-line XAML into 17 lines. See
 * docs/developer-editor-analysis.md.
 *
 * Highlight ranges are not DOM. They cannot be serialised, repaired, trimmed or
 * split, so none of that can happen here. The cost is the API's property ceiling:
 * colour, background, text-decoration and shadow only -- no bold keywords, no
 * italic comments. For a fence that is the right trade.
 *
 * LEXING IS PER LINE
 * ------------------
 * Each lexer takes (line, state) and returns { tokens, state }, carrying a start
 * state into the next line for constructs that span lines. A fence is lexed from
 * its own first line, so it needs no document-wide cache.
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

        /**
         * The lexer for a fence's info string: the ```json / ```cs after the ticks.
         *
         * Same table as file extensions, because ```cs and Program.cs mean the same
         * thing and two tables would be two things deciding one answer.
         */
        function codeLanguageForFence(info) {
            const w = String(info == null ? '' : info).trim().toLowerCase().split(/[\s,{]/)[0];
            if (!w) return null;
            return CODE_LANGUAGES[w] || null;
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

        /** Token classes we register highlights for. One CSS.highlights entry each. */
        const CODE_TOKEN_CLASSES =
            ['keyword', 'string', 'comment', 'number', 'type', 'fn', 'tag', 'attr'];

        /**
         * Paint every fenced code block on screen.
         *
         * Ranges, never elements. A fence renders as <pre><code class="lang-x">TEXT</code>,
         * one text node, so a token's line offsets map straight onto it -- and nothing is
         * added to the DOM, so nothing can be serialised back into the document. That is
         * the whole reason this is safe where wrapping tokens in spans was not.
         *
         * Cheap enough to run from the editor's mutation observer: it only walks fences
         * that are actually mounted, and a document with none returns immediately.
         */
        function paintCodeFences() {
            const editorEl = document.getElementById('editor');
            if (!editorEl || !window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return 0;

            const byClass = {};
            for (const c of CODE_TOKEN_CLASSES) byClass[c] = [];

            const codes = editorEl.querySelectorAll('.block pre > code[class*="lang-"]');
            let painted = 0;
            for (let i = 0; i < codes.length; i++) {
                const el = codes[i];
                const m = /lang-([A-Za-z0-9_+#.-]+)/.exec(el.className || '');
                const lang = codeLanguageForFence(m ? m[1] : '');
                if (!lang) continue;                       // unknown fence: leave it plain
                const node = el.firstChild;
                if (!node || node.nodeType !== 3) continue; // not a single text node: skip
                const text = node.nodeValue || '';

                let at = 0, state = 0;
                const lines = text.split('\n');
                for (let li = 0; li < lines.length; li++) {
                    const r = lexCodeLine(lines[li], lang, state);
                    state = r.state;
                    for (let t = 0; t < r.tokens.length; t++) {
                        const tok = r.tokens[t];
                        const list = byClass[tok.t];
                        if (!list) continue;
                        try {
                            const range = document.createRange();
                            range.setStart(node, at + tok.s);
                            range.setEnd(node, at + tok.e);
                            list.push(range);
                        } catch (eR) {}
                    }
                    at += lines[li].length + 1;            // + the newline
                }
                painted++;
            }

            for (const c of CODE_TOKEN_CLASSES) {
                const name = 'tzcode-' + c;
                if (byClass[c].length) CSS.highlights.set(name, new Highlight(...byClass[c]));
                else CSS.highlights.delete(name);
            }
            return painted;
        }

        window.paintCodeFences = paintCodeFences;
        window.codeLanguageForPath = codeLanguageForPath;
        window.codeLanguageForFence = codeLanguageForFence;
        window.lexCodeLine = lexCodeLine;
        window.CODE_LANGUAGES = CODE_LANGUAGES;
})();
