/**
 * A book's CSS goes through an allowlist (06-render-epub.js applyBookStyles), headless.
 *
 * The page must be the reader's whatever a publisher writes. Found on 2026-09-26: Zones of
 * Thought's `body { margin: 0 1.5em 0 1em }` landed on #editor -- the element that is the
 * page -- and pushed the right column of every spread off the window. It had been possible
 * since the book stylesheet was first scoped, and was found only because that book was
 * opened. This test is the hostile stylesheet no book has shipped yet: every way a rule
 * could move, resize or escape the page, plus the things that must still get through.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const HOSTILE = `
@import url(elsewhere.css);
@page { margin: 1in }
html { width: 3000px; overflow: scroll }
body { margin: 0 1.5em 0 1em; padding: 2em; width: 500px; position: absolute; left: 40px;
       column-count: 3; background-color: #fff; color: #000; font-family: Georgia, serif;
       line-height: 2; text-align: justify; hyphens: auto; transform: rotate(3deg) }
body p { text-indent: 1.5em }
body > p.kid { font-style: italic }
div { margin: 0 20%; padding: 0 }
p.wide { width: 1200px; min-width: 900px; position: fixed; top: 0; left: -500px;
         white-space: nowrap; margin-left: -3em; z-index: 99 }
p.keep { color: rgb(200, 0, 0); margin: 1em 0 0 2em; border-left: 2px solid rgb(0, 0, 200);
         font-size: 0.88em; letter-spacing: 0.05em }
h2.part { page-break-before: always; break-after: page }
p.rem { margin-top: 2rem }
@media screen { body { margin-left: 3em } #chrome-probe, p.media { color: rgb(0, 150, 0) } }
::selection { background: red }
body ::selection { background: red }
@font-face { font-family: BookFace; src: url(fonts/face.ttf) }
`;

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && typeof applyBookStyles === 'function', { timeout: 15000 });

    const r = await page.evaluate((css) => {
        const ed = document.getElementById('editor');
        // Book-shaped content: the app's .block wrappers holding the publisher's elements.
        ed.innerHTML =
            '<div class="block"><p class="kid">kid</p></div>' +
            '<div class="block"><div class="pubdiv">publisher div</div></div>' +
            '<div class="block"><p class="wide">wide wide wide wide wide wide wide wide wide wide wide wide</p></div>' +
            '<div class="block"><p class="keep">keep</p></div>' +
            '<div class="block"><h2 class="part">Part</h2></div>' +
            '<div class="block"><p class="media">media</p></div>';
        const probe = document.createElement('div');
        probe.id = 'chrome-probe'; probe.textContent = 'app chrome';
        document.body.appendChild(probe);
        const blockBefore = getComputedStyle(ed.querySelector('.block')).paddingLeft;
        // The control: the same page and content with no book stylesheet, so the only
        // difference measured afterwards is what the stylesheet did.
        const before = getComputedStyle(ed);
        const was = { ml: before.marginLeft, mr: before.marginRight, pos: before.position,
                      lh: before.lineHeight, cols: before.columnCount, w: ed.getBoundingClientRect().width };

        applyBookStyles([css], 'book/', 0.88);
        const sheet = document.getElementById('book-styles').textContent;

        const cs = getComputedStyle(ed), er = ed.getBoundingClientRect();
        const q = (s) => ed.querySelector(s);
        const wide = q('p.wide'), wideCs = getComputedStyle(wide), wr = wide.getBoundingClientRect();
        const keep = getComputedStyle(q('p.keep'));
        const inline = sanitizeBookHtml('<p style="position:fixed;top:0;margin-left:-5em;color:rgb(200,0,0);font-style:italic;width:3000px">x</p>');
        return {
            sheet, was, blockBefore,
            ed: { ml: cs.marginLeft, mr: cs.marginRight, pl: cs.paddingLeft, pos: cs.position,
                  cols: cs.columnCount, lh: cs.lineHeight, font: cs.fontFamily, tf: cs.transform,
                  bg: cs.backgroundColor, w: er.width, left: er.left },
            blockPad: getComputedStyle(ed.querySelector('.block')).paddingLeft,
            blockMargin: getComputedStyle(ed.querySelector('.block')).marginLeft,
            pubdivMargin: getComputedStyle(q('.pubdiv')).marginLeft,
            kidItalic: getComputedStyle(q('p.kid')).fontStyle,
            kidIndent: getComputedStyle(q('p.kid')).textIndent,
            wide: { pos: wideCs.position, ws: wideCs.whiteSpace, ml: wideCs.marginLeft, minW: wideCs.minWidth,
                    maxW: wideCs.maxWidth, z: wideCs.zIndex, left: wr.left, right: wr.right },
            edRight: er.right, edLeft: er.left,
            keep: { color: keep.color, mt: keep.marginTop, ml: keep.marginLeft, border: keep.borderLeftColor, ls: keep.letterSpacing },
            part: { bb: getComputedStyle(q('h2.part')).breakBefore, ba: getComputedStyle(q('h2.part')).breakAfter },
            media: getComputedStyle(q('p.media')).color,
            chrome: getComputedStyle(probe).color,
            inline
        };
    }, HOSTILE);

    // The page itself: nothing the publisher wrote may size, place or scroll it.
    assert(r.ed.ml === r.was.ml && r.ed.mr === r.was.mr, 'body margins do not reach the page (' + r.ed.ml + ' / ' + r.ed.mr + ')');
    assert(r.ed.pl === '0px', 'body padding does not reach the page (' + r.ed.pl + ')');
    assert(r.ed.pos === r.was.pos && r.ed.tf === 'none', 'body position and transform do not reach the page');
    assert(r.ed.cols === r.was.cols, 'body column-count does not reach the page');
    assert(Math.abs(r.ed.w - r.was.w) < 0.5, 'body/html width does not resize the page (' + r.ed.w + ' vs ' + r.was.w + ')');
    assert(r.ed.lh === r.was.lh, 'the reader\'s leading, not the book\'s');
    assert(!/background/.test((r.sheet.match(/#editor \{[^}]*\}/g) || []).join(' ')), 'the theme\'s paper, not the book\'s');
    assert(/Georgia/.test(r.ed.font), 'but the book\'s typeface on body still applies');
    assert(!/@media[^{]*\{[^}]*#editor \{[^}]*margin/.test(r.sheet), 'including body rules inside @media');

    // The app's own blocks keep their box; the publisher's elements inside them are styled.
    assert(r.blockPad === r.blockBefore && r.blockMargin === '0px', 'a publisher div rule does not restyle the app\'s .block (' + r.blockPad + ')');
    assert(r.pubdivMargin !== '0px', 'while the publisher\'s own div still gets it (' + r.pubdivMargin + ')');
    assert(r.kidItalic === 'italic', '`body > p` still reaches a paragraph inside a block');
    assert(r.kidIndent !== '0px', '`body p` styles paragraphs, not the page (' + r.kidIndent + ')');

    // An element inside the book cannot leave its column.
    assert(r.wide.pos === 'static' && r.wide.z === 'auto', 'position:fixed and z-index are dropped');
    assert(r.wide.ml === '0px' || !/^-/.test(r.wide.ml), 'a negative margin is dropped (' + r.wide.ml + ')');
    assert(r.wide.minW === '0px' || r.wide.minW === 'auto', 'an absolute min-width is dropped (' + r.wide.minW + ')');
    assert(r.wide.maxW === '100%', 'a fixed width is capped at the column (' + r.wide.maxW + ')');
    assert(!/nowrap/.test(r.wide.ws), 'white-space: nowrap is dropped');
    assert(r.wide.left >= r.edLeft - 0.5 && r.wide.right <= r.edRight + 0.5,
        'the hostile paragraph stays inside the page (' + r.wide.left + '..' + r.wide.right + ' within ' + r.edLeft + '..' + r.edRight + ')');

    // What a book legitimately uses still gets through.
    assert(r.keep.color === 'rgb(200, 0, 0)', 'a chosen (non-neutral) colour is kept');
    assert(r.keep.ml !== '0px' && r.keep.mt !== '0px', 'indents and paragraph spacing are kept');
    assert(r.keep.border === 'rgb(0, 0, 200)', 'borders are kept');
    assert(r.keep.ls !== 'normal', 'letter-spacing is kept');
    assert(/font-size: 1em/.test(r.sheet), 'relative sizes are divided through by the reader\'s size (0.88em / 0.88)');
    assert(r.part.bb === 'column' && r.part.ba === 'auto', 'a page break before becomes a column break; after is neutralised');
    assert(!/\drem\b/.test(r.sheet), 'rem becomes em');
    assert(/url\("book\/fonts\/face\.ttf"\)/.test(r.sheet), 'an embedded font is kept, its url rebased on the book');

    // Nothing reaches outside the book.
    assert(r.media === 'rgb(0, 150, 0)', 'a rule inside @media applies to the book');
    assert(r.chrome !== 'rgb(0, 150, 0)', 'and does not reach the application\'s own elements');
    assert(!/selection/.test(r.sheet), '::selection rules are dropped (the theme owns selection)');
    assert(!/@import|@page/.test(r.sheet), '@import and @page are dropped');

    // Inline style="" is the second way in, through the same allowlist.
    assert(!/position|top|margin-left/.test(r.inline), 'inline position, offsets and negative margins are dropped (' + r.inline + ')');
    assert(/max-width: 100%/.test(r.inline), 'an inline fixed width is capped at the column');
    assert(/color/.test(r.inline) && /italic/.test(r.inline), 'inline colour and italic are kept');
} finally {
    await browser.close();
}
console.log('');
console.log('passed=' + passed + ' failed=' + failed);
if (failed) { console.log('BOOK CSS BROWSER FAILED'); process.exit(1); }
console.log('BOOK CSS BROWSER PASSED');
