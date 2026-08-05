/**
 * Just enough ZIP to read an epub, so the suites can use real books.
 *
 * No dependency: epubs only ever use stored (0) or deflate (8), and Node has zlib. Adding a
 * package for this would be more moving parts than the reader itself.
 *
 * Real books are the point. The converter that shipped looks perfectly reasonable against a
 * hand-written fixture; it was only counting images and headings in Blindsight that showed
 * it dropping every one of them.
 */
import fs from 'fs';
import zlib from 'zlib';

/** Read the central directory and return { name -> Buffer } for the whole archive. */
export function readZip(zipPath) {
    const buf = fs.readFileSync(zipPath);

    // End of central directory: scan back from the tail, since it may carry a comment.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip: no end-of-central-directory in ' + zipPath);

    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);

    const out = new Map();
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break;
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOff = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;

        // The local header repeats the name and extra fields, at its own lengths.
        if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataAt = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(dataAt, dataAt + compSize);

        try {
            out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
        } catch (e) {
            // A single unreadable entry must not lose the book.
        }
    }
    return out;
}

/**
 * The spine, in reading order: container.xml -> OPF -> manifest + spine.
 *
 * Returns { opfDir, docs: [{ href, html }], titles }. Deliberately the same shape the host
 * loader will produce, so the tests describe the contract rather than an implementation.
 */
export function readSpine(zipPath) {
    const zip = readZip(zipPath);
    const container = zip.get('META-INF/container.xml');
    if (!container) throw new Error('no META-INF/container.xml');
    const opfPath = (container.toString('utf8').match(/full-path\s*=\s*"([^"]+)"/) || [])[1];
    if (!opfPath) throw new Error('no OPF path in container.xml');

    const opf = zip.get(opfPath);
    if (!opf) throw new Error('OPF missing: ' + opfPath);
    const opfXml = opf.toString('utf8');
    const opfDir = opfPath.indexOf('/') >= 0 ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    const manifest = new Map();
    const itemRe = /<item\b[^>]*>/gi;
    let m;
    while ((m = itemRe.exec(opfXml))) {
        const id = (m[0].match(/\bid\s*=\s*"([^"]*)"/) || [])[1];
        const href = (m[0].match(/\bhref\s*=\s*"([^"]*)"/) || [])[1];
        if (id && href) manifest.set(id, decodeURIComponent(href));
    }

    const docs = [];
    const refRe = /<itemref\b[^>]*>/gi;
    while ((m = refRe.exec(opfXml))) {
        const idref = (m[0].match(/\bidref\s*=\s*"([^"]*)"/) || [])[1];
        if (!idref || !manifest.has(idref)) continue;
        const href = manifest.get(idref);
        const entry = zip.get(opfDir + href) || zip.get(href);
        if (entry) docs.push({ href: href, html: entry.toString('utf8') });
    }

    const title = (opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '';
    const author = (opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || '';
    return { opfDir, docs, title: title.trim(), author: author.trim(), zip };
}

/**
 * Split one spine document into blocks: the top-level children of <body>.
 *
 * One paragraph-ish unit per block, which is the granularity the Markdown model already
 * uses -- so pagination breaks where a reader expects and PageChunks ranges stay meaningful.
 * Written here first because the tests need to agree with the host on what a block is.
 */
export function bodyBlocks(html, dom) {
    const doc = new dom.window.DOMParser().parseFromString(html, 'text/html');
    const out = [];
    const kids = doc.body ? doc.body.children : [];
    for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        // A chapter wrapped in a single container contributes its children, not itself:
        // one block per chapter would defeat pagination entirely.
        if ((el.tagName === 'DIV' || el.tagName === 'SECTION') && el.children.length > 3) {
            for (let j = 0; j < el.children.length; j++) {
                out.push(el.children[j].outerHTML);
            }
            continue;
        }
        out.push(el.outerHTML);
    }
    return out;
}

/**
 * The book's table of contents, as [{ title, level, blockIndex }].
 *
 * Reads EPUB 3 `nav.xhtml` if present, otherwise EPUB 2 `toc.ncx`; real collections contain
 * both vintages. Entries point at a document (and sometimes a fragment inside it), so each
 * is resolved to the index of the first block of that document -- which is where a reader
 * expects "go to chapter 4" to land.
 *
 * This exists because heading detection is not enough: Dune has no <h1>..<h6> at all, its
 * chapters being styled paragraphs, which is what Calibre produces and therefore what a
 * large share of real books look like.
 */
export function readToc(spine, docStartBlock, dom) {
    const zip = spine.zip;
    const norm = (h) => decodeURIComponent(String(h || '').split('#')[0]).replace(/^\.\//, '');
    const at = (href) => {
        const k = norm(href);
        if (docStartBlock.has(k)) return docStartBlock.get(k);
        // hrefs may be written relative to the OPF directory, or not
        const bare = k.slice(k.lastIndexOf('/') + 1);
        for (const [key, idx] of docStartBlock) {
            if (key === bare || key.endsWith('/' + bare)) return idx;
        }
        return -1;
    };

    // EPUB 3 first.
    for (const [name, buf] of zip) {
        if (!/nav\.x?html$/i.test(name)) continue;
        const doc = new dom.window.DOMParser().parseFromString(buf.toString('utf8'), 'text/html');
        const nav = doc.querySelector('nav[epub\:type="toc"], nav#toc, nav');
        if (!nav) continue;
        const out = [];
        nav.querySelectorAll('a[href]').forEach(a => {
            const idx = at(a.getAttribute('href'));
            if (idx < 0) return;
            let level = 1, p = a.parentElement;
            while (p && p !== nav) { if (p.tagName === 'OL' || p.tagName === 'UL') level++; p = p.parentElement; }
            const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (title) out.push({ title, level: Math.max(1, level - 1) || 1, blockIndex: idx });
        });
        if (out.length) return out;
    }

    // EPUB 2 fallback.
    for (const [name, buf] of zip) {
        if (!/\.ncx$/i.test(name)) continue;
        const xml = buf.toString('utf8');
        const doc = new dom.window.DOMParser().parseFromString(xml, 'text/html');
        const out = [];
        doc.querySelectorAll('navpoint').forEach(np => {
            const content = np.querySelector('content');
            const label = np.querySelector('navlabel text') || np.querySelector('text');
            if (!content || !label) return;
            const idx = at(content.getAttribute('src'));
            if (idx < 0) return;
            let level = 1, p = np.parentElement;
            while (p && p.tagName === 'NAVPOINT') { level++; p = p.parentElement; }
            const title = (label.textContent || '').replace(/\s+/g, ' ').trim();
            if (title) out.push({ title, level, blockIndex: idx });
        });
        if (out.length) return out;
    }
    return [];
}

/** Blocks for a whole book, plus where each spine document starts. */
export function bookBlocks(spine, dom) {
    const blocks = [];
    const docStart = new Map();
    for (const d of spine.docs) {
        docStart.set(decodeURIComponent(d.href).replace(/^\.\//, ''), blocks.length);
        for (const b of bodyBlocks(d.html, dom)) blocks.push(b);
    }
    return { blocks, docStart };
}
