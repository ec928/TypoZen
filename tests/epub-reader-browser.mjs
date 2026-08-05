/**
 * A real book, loaded as blocks of its own HTML, behaves like a document.
 *
 * The claim behind the whole design is that only three things need to know a document is a
 * book -- how a block renders, what its text is, and which Markdown assumptions to stop
 * making -- and that everything else keeps working unchanged. This checks both halves of
 * that against an actual novel: the fidelity that conversion was losing, and the features
 * that are supposed to carry on regardless.
 *
 * Uses the books in tests/. A converter looks perfectly reasonable against a hand-written
 * fixture; it was counting images and headings in a real one that showed the old path
 * dropping every image, every link and 16 of 17 headings.
 *
 *   node tests/epub-reader-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { JSDOM } from 'jsdom';
import { readSpine, bookBlocks, readToc } from './epub-zip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const books = fs.readdirSync(path.join(appDir, 'tests'))
    .filter(f => f.toLowerCase().endsWith('.epub'))
    .sort();

if (!books.length) {
    console.log('  --   no .epub in tests/, nothing to verify.');
    console.log('passed=0 failed=0');
    console.log('EPUB READER SKIPPED');
    process.exit(0);
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

        const dom = new JSDOM('');
        // One book in depth, then every other book shallowly: the deep checks need a known
        // shape, the shallow ones catch a book whose markup breaks an assumption.
        const primary = books.find(b => /matter/i.test(b)) || books[0];

        console.log('=== ' + primary + ' ===');
        const spine = readSpine(path.join(appDir, 'tests', primary));
        const { blocks, docStart } = bookBlocks(spine, dom);
        const toc = readToc(spine, docStart, dom);
        info(spine.title + ' / ' + spine.author + ' — ' + spine.docs.length +
            ' documents, ' + blocks.length + ' blocks, ' + toc.length + ' TOC entries');

        const loaded = await page.evaluate((bs, tc) => {
            const n = DocumentModel.fromBookBlocks(bs, tc);
            return { n: n, kind: DocumentModel.kind };
        }, blocks, toc);
        assert(loaded.kind === 'epub', 'the model knows it is holding a book');
        assert(loaded.n === blocks.length,
            'every block of the book is in the model (' + loaded.n + ')');

        console.log('\n--- the fidelity conversion was losing ---');
        const fid = await page.evaluate(() => {
            const raws = DocumentModel.blocks.map(b => b.raw);
            const all = raws.join('');
            const count = (re) => (all.match(re) || []).length;
            // Render a sample through the real block renderer, not by inspecting strings.
            const host = document.createElement('div');
            document.body.appendChild(host);
            let renderedImgs = 0, renderedTags = 0;
            const withImg = raws.filter(r => /<img/i.test(r)).slice(0, 5);
            const withEm = raws.filter(r => /<(i|em)\b/i.test(r)).slice(0, 5);
            for (const r of withImg.concat(withEm)) {
                const el = document.createElement('div');
                el.className = 'block';
                host.appendChild(el);
                renderBlockPreview(el, r);
                renderedImgs += el.querySelectorAll('img').length;
                renderedTags += el.querySelectorAll('i, em, b, strong, span').length;
            }
            host.remove();
            return {
                images: count(/<img/gi), links: count(/<a\b/gi),
                listItems: count(/<li\b/gi), headings: count(/<h[1-6]\b/gi),
                emphasis: count(/<(i|em)\b/gi),
                renderedImgs, renderedTags,
                sampleImgBlocks: withImg.length, sampleEmBlocks: withEm.length
            };
        });
        info('in the book: ' + fid.images + ' images, ' + fid.links + ' links, ' +
            fid.listItems + ' list items, ' + fid.headings + ' headings, ' +
            fid.emphasis + ' emphasis');
        assert(fid.headings > 0, 'the book has headings, so the outline has something to show');
        assert(fid.emphasis > 0, 'the book has italics — novels are full of them');
        assert(fid.renderedTags > 0,
            'inline markup survives rendering (' + fid.renderedTags + ' elements)');
        if (fid.sampleImgBlocks > 0) {
            assert(fid.renderedImgs === fid.sampleImgBlocks,
                'every sampled image block renders an <img> (' + fid.renderedImgs +
                '/' + fid.sampleImgBlocks + ')');
        } else {
            info('this book has no images in its text blocks; skipping the image check');
        }

        console.log('\n--- search reads the book, not its markup ---');
        const hay = await page.evaluate(() => {
            const h = getFindHaystack();
            return {
                kind: h.kind, len: h.haystack.length,
                hasTags: /<\/?(p|div|span|i|em|h[1-6])\b/i.test(h.haystack),
                hasClass: /class\s*=/.test(h.haystack),
                hasHref: /href\s*=/.test(h.haystack),
                sample: h.haystack.slice(2000, 2200)
            };
        });
        info('haystack: ' + hay.len + ' chars, kind ' + hay.kind);
        assert(!hay.hasTags, 'no tags in the search surface');
        assert(!hay.hasClass, 'no class attributes — searching a book must not match styling');
        assert(!hay.hasHref, 'no hrefs either');
        assert(hay.len > 100000, 'and it is the whole book, not one chapter (' + hay.len + ')');

        console.log('\n--- the outline comes from the book’s own headings ---');
        const outline = await page.evaluate(() => {
            updateOutline();
            const items = document.querySelectorAll('#outline-list .outline-item');
            return {
                count: items.length,
                first: Array.prototype.slice.call(items, 0, 5).map(x => x.innerText),
                anyHash: Array.prototype.some.call(items, x => /^#/.test(x.innerText)),
                anyTag: Array.prototype.some.call(items, x => /[<>]/.test(x.innerText))
            };
        });
        info('outline: ' + outline.count + ' entries — ' + JSON.stringify(outline.first));
        assert(outline.count === toc.length,
            'the outline is exactly the book’s TOC (' + outline.count + ' vs ' +
            toc.length + ')');
        assert(!outline.anyHash, 'no stray hashes — these are <h1>..<h6>, not Markdown');
        assert(!outline.anyTag, 'and no markup leaked into the titles');

        console.log('\n--- a book is read-only ---');
        const ro = await page.evaluate(() => {
            setEditorEditable(true);              // the strongest thing a caller can ask for
            const after = editor.getAttribute('contenteditable');
            return { editable: after, readerClass: editor.classList.contains('reader-mode') };
        });
        assert(ro.editable === 'false',
            'asking to make the editor editable is refused for a book (' + ro.editable + ')');
        assert(ro.readerClass, 'and it is left in reader mode');

        const serial = await page.evaluate(() => {
            const t = getMarkdownContent(false);
            return { len: t.length, hasTags: /<\/?(p|div|span)\b/i.test(t) };
        });
        assert(serial.len > 100000 && !serial.hasTags,
            'serialising a book gives its text, never its markup (' + serial.len + ' chars)');

        console.log('\n--- every other book loads without throwing ---');
        for (const b of books.filter(x => x !== primary)) {
            let bs = [], tc = [];
            try {
                const sp = readSpine(path.join(appDir, 'tests', b));
                const bb = bookBlocks(sp, dom);
                bs = bb.blocks;
                tc = readToc(sp, bb.docStart, dom);
            } catch (e) {
                assert(false, b + ': could not be read — ' + e.message);
                continue;
            }
            const r = await page.evaluate((arr, t) => {
                DocumentModel.fromBookBlocks(arr, t);
                updateOutline();
                const h = getFindHaystack();
                return {
                    blocks: DocumentModel.blocks.length,
                    outline: document.querySelectorAll('#outline-list .outline-item').length,
                    hayLen: h.haystack.length,
                    hayTags: /<\/?(p|div|span)\b/i.test(h.haystack)
                };
            }, bs, tc);
            info(b.slice(0, 40) + ' — ' + r.blocks + ' blocks, ' + r.outline +
                ' outline entries, ' + r.hayLen + ' chars of text');
            assert(r.blocks > 100 && r.hayLen > 10000 && !r.hayTags,
                b.slice(0, 40) + ': loads, is searchable as text, and keeps its structure');
            // Dune is the reason this is asserted for every book: it contains no
            // <h1>..<h6> whatsoever, so any outline built by inference is empty.
            assert(r.outline > 1 && r.outline === tc.length,
                b.slice(0, 40) + ': its outline is its own TOC (' + r.outline +
                ' of ' + tc.length + ')');
        }

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) { console.error('\nEPUB READER FAILED'); process.exitCode = 1; return; }
        console.log('\nEPUB READER PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
