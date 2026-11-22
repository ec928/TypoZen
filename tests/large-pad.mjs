/**
 * LARGE DOCUMENTS ARE THE DEFAULT for editing tests (Ed, 2026-11-22). This helper makes any
 * suite that loads a small document run it in the MIDDLE of a long one instead.
 *
 *   import { padPage } from './large-pad.mjs';
 *   await padPage(page);              // before page.goto
 *
 * When a TEST calls loadMarkdownContent(md), the page loads 1,200 one-line paragraphs, then md,
 * then 1,200 more (4,805 blocks: past the 2,000-block windowing threshold, so Preview holds only
 * a window of the file, as it does for any real long document) and shows md's part. When a test
 * calls getMarkdownContent(), it gets md's part back -- and if the padding above or below was
 * changed at all, a 'PADDING ... CHANGED' string instead, which no expectation will match. The
 * app's own calls to these functions are left alone (only a direct call from a puppeteer
 * evaluation is padded). sourceEditor.value, read or set by a test, works the same way.
 *
 * TZ_DOC_SIZE=small turns it off: the quick check of the easy case, after the long file.
 */
export const PADN = 1200;
export const LARGE = process.env.TZ_DOC_SIZE !== 'small';

// opts.above: also pad ABOVE the case (it is then in the middle of the file). Off by default:
// most suites find their lines by model index (data-model-index="0") or as the first block,
// which padding above would move. Padding below alone still makes the file long and windowed;
// the middle-of-the-file position is attacked by keyboard-editing-cases and large-*-browser.
export async function padPage(page, opts = {}) {
    if (!LARGE) return;
    const above = opts.above ? PADN : 0;
    await page.evaluateOnNewDocument((PADN, above) => {
        const A = Array.from({ length: above }, (_, i) => 'Filler paragraph ' + i + ' above the case.').join('\n\n');
        const B = Array.from({ length: PADN * 2 }, (_, i) => 'Filler paragraph ' + i + ' below the case.').join('\n\n');
        const head = above ? A + '\n\n' : '', tail = '\n\n' + B;
        // Called straight from a test's page.evaluate (not from the app's own code)?
        const fromTest = () => {
            const s = String(new Error().stack || '').split('\n');
            return /__puppeteer_evaluation_script__|pptr:/.test(s[3] || '');
        };
        const strip = (text) => {
            const g = String(text == null ? '' : text);
            const end = g.match(/\n*$/)[0];
            const body = g.slice(0, g.length - end.length);
            if (!body.startsWith(head)) return 'PADDING ABOVE THE CASE CHANGED: ' + JSON.stringify(body.slice(Math.max(0, head.length - 60), head.length + 40));
            if (!body.endsWith(tail)) return 'PADDING BELOW THE CASE CHANGED: ' + JSON.stringify(body.slice(Math.max(0, body.length - tail.length - 40), body.length - tail.length + 60));
            return body.slice(head.length, body.length - tail.length) + end;
        };
        let padded = false;
        const install = () => {
            if (padded || typeof window.loadMarkdownContent !== 'function' || typeof window.getMarkdownContent !== 'function') return;
            padded = true;
            const L = window.loadMarkdownContent, G = window.getMarkdownContent;
            window.loadMarkdownContent = function (md, opts) {
                if (typeof md !== 'string' || !fromTest()) return L.apply(this, arguments);
                const r = L.call(this, head + md.replace(/\n+$/, '') + tail, opts);
                try { if (above && window.state && window.state.mode !== 'source') window.goToModelBlock(2 * above); } catch (e) { }
                return r;
            };
            window.getMarkdownContent = function () {
                const out = G.apply(this, arguments);
                return fromTest() ? strip(out) : out;
            };
        };
        window.__tzPad = { head, tail, strip, fromTest };
        document.addEventListener('DOMContentLoaded', install);
        window.addEventListener('load', install);
    }, PADN, above);
    // Source: sourceEditor is a global const (not on window) and the page's CSP forbids eval, so
    // its wrapper goes in from the test side after each navigation: a test reading or setting
    // sourceEditor.value then sees only the case's part.
    const goto = page.goto.bind(page);
    page.goto = async (...args) => {
        const r = await goto(...args);
        await page.evaluate(() => {
            try {
                const P = window.__tzPad, se = sourceEditor;
                const d = Object.getOwnPropertyDescriptor(se, 'value');
                if (!P || !d || !d.get || !d.set) return;
                Object.defineProperty(se, 'value', {
                    configurable: true,
                    get() { const v = d.get.call(this); return P.fromTest() ? P.strip(v) : v; },
                    set(v) { d.set.call(this, P.fromTest() && typeof v === 'string' ? P.head + v.replace(/\n+$/, '') + P.tail : v); }
                });
            } catch (e) { }
        });
        return r;
    };
}
