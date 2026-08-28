/**
 * A/B: does declaring only the active theme's @font-face save startup time?
 *
 * Hypothesis from the review: skip Merriweather/Literata when the default
 * theme (Gruvbox) asks for Source Sans 3.
 *
 * Counter: font-display:swap, and Chromium fetches a face only when a used
 * element's computed family matches it. Unused @font-face is CSS, not a download.
 *
 * This loads the real template in headless Chrome (same engine as WebView2),
 * applies Gruvbox like the host does, and records which .ttf files actually
 * transferred plus document.fonts.ready.
 *
 *   node tests/fonts-ab.mjs
 *
 * Not a gate. Numbers are machine-local; the verdict is whether A and B differ.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const templatePath = path.join(appDir, 'TypoZen_Template.html');
const html0 = fs.readFileSync(templatePath, 'utf8');

const GRUVBOX = {
    Name: 'Gruvbox',
    FN: "'Source Sans 3', 'Inter', sans-serif",
    FS: 16, Bg: '#282828', Tx: '#EBDBB2', Hi: '#FABD2F'
};
const GRUVBOX_SERIF = {
    Name: 'Gruvbox Serif',
    FN: "'Merriweather', 'Literata', serif",
    FS: 16, Bg: '#282828', Tx: '#EBDBB2', Hi: '#FABD2F'
};

const RUNS = 5;

function keepFamilies(html, families) {
    const re = /(<style id="bundled-fonts">)([\s\S]*?)(<\/style>)/;
    const m = html.match(re);
    if (!m) throw new Error('no bundled-fonts block');
    if (families === null) return html;
    const faces = m[2].split(/@font-face\s*/).slice(1);
    const kept = faces.filter((body) => {
        const fam = (body.match(/font-family:\s*'([^']+)'/) || [])[1];
        return families.has(fam);
    }).map((body) => '@font-face ' + body).join('\n');
    return html.replace(re, m[1] + '\n' + kept + '\n        ' + m[3]);
}

function fileUrl(p) {
    return 'file:///' + p.split(path.sep).join('/');
}

function median(xs) {
    const a = xs.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function fmt(n, digits) {
    return (Math.round(n * (10 ** digits)) / (10 ** digits)).toFixed(digits);
}

async function measure(browser, htmlPath, theme) {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1280, height: 900 });
    const requested = [];
    page.on('request', (req) => {
        const u = req.url();
        if (/\.ttf(\?|$)/i.test(u)) requested.push(u);
    });
    const tNav = Date.now();
    await page.goto(fileUrl(htmlPath), { waitUntil: 'load', timeout: 30000 });
    const navMs = Date.now() - tNav;
    await page.waitForFunction(() => typeof applyTheme === 'function', { timeout: 15000 });

    const afterTheme = await page.evaluate(async (theme) => {
        const t0 = performance.now();
        applyTheme(theme);
        const sample = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.';
        const ed = document.getElementById('editor');
        if (ed) {
            ed.innerHTML = '';
            for (let i = 0; i < 8; i++) {
                const p = document.createElement('p');
                p.textContent = sample;
                p.style.fontFamily = 'var(--font)';
                p.style.fontStyle = (i % 2) ? 'italic' : 'normal';
                p.style.fontWeight = (i >= 6) ? '700' : '400';
                ed.appendChild(p);
            }
        }
        await document.fonts.ready;
        // One more frame so resource timing includes the last face.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const t1 = performance.now();
        const fonts = performance.getEntriesByType('resource')
            .filter((e) => /\.ttf(\?|$)/i.test(e.name))
            .map((e) => ({
                name: decodeURIComponent(e.name.split('/').pop().split('?')[0]),
                ms: Math.round(e.duration),
                bytes: e.transferSize || e.encodedBodySize || 0,
                start: Math.round(e.startTime)
            }));
        const faces = [];
        try {
            document.fonts.forEach((f) => {
                if (f.status === 'loaded') faces.push(f.family + ' ' + f.weight + ' ' + f.style);
            });
        } catch (e) {}
        return {
            themeApplyToFontsReadyMs: t1 - t0,
            resources: fonts,
            loadedFaces: faces.sort()
        };
    }, theme);
    await page.close();
    const reqNames = requested.map((u) => {
        try { return decodeURIComponent(u.split('/').pop().split('?')[0]); }
        catch (e) { return u; }
    });
    const diskBytes = reqNames.reduce((s, name) => {
        const p = path.join(appDir, 'fonts', name);
        try { return s + fs.statSync(p).size; } catch (e) { return s; }
    }, 0);
    const timingBytes = afterTheme.resources.reduce((s, r) => s + r.bytes, 0);
    return {
        navMs,
        themeApplyToFontsReadyMs: afterTheme.themeApplyToFontsReadyMs,
        bytes: diskBytes || timingBytes,
        files: reqNames.length
            ? reqNames.map((n) => n)
            : afterTheme.resources.map((r) => r.name),
        loadedFaces: afterTheme.loadedFaces
    };
}

function summarise(label, rows) {
    const nav = rows.map((r) => r.navMs);
    const ready = rows.map((r) => r.themeApplyToFontsReadyMs);
    const bytes = rows.map((r) => r.bytes);
    const files = rows[rows.length - 1].files;
    const faces = rows[rows.length - 1].loadedFaces;
    console.log('\n=== ' + label + ' ===');
    console.log('  navigation to load (ms):     ' + nav.map((n) => fmt(n, 0)).join(', ')
        + '   median ' + fmt(median(nav), 0));
    console.log('  applyTheme → fonts.ready:    ' + ready.map((n) => fmt(n, 1)).join(', ')
        + '   median ' + fmt(median(ready), 1));
    console.log('  font bytes transferred:      ' + bytes.join(', ')
        + '   median ' + bytes.slice().sort((a, b) => a - b)[Math.floor(bytes.length / 2)]);
    console.log('  ttf fetched (last run):      ' + (files.length ? files.join(' | ') : '(none)'));
    console.log('  document.fonts loaded:       ' + (faces.length ? faces.join(', ') : '(none)'));
    return { nav: median(nav), ready: median(ready), bytes: median(bytes) };
}

async function main() {
    const variants = [
        {
            id: 'A-all-gruvbox',
            html: html0,
            file: path.join(appDir, '_fonts-ab-all.html'),
            theme: GRUVBOX,
            label: 'A  all @font-face, Gruvbox (Source Sans 3)  — current shipping CSS'
        },
        {
            id: 'B-thin-gruvbox',
            html: keepFamilies(html0, new Set(['Source Sans 3', 'Inter'])),
            file: path.join(appDir, '_fonts-ab-thin.html'),
            theme: GRUVBOX,
            label: 'B  only Source Sans 3 + Inter, Gruvbox  — proposed lazy set'
        },
        {
            id: 'C-all-serif',
            html: html0,
            file: path.join(appDir, '_fonts-ab-all-serif.html'),
            theme: GRUVBOX_SERIF,
            label: 'C  all @font-face, Gruvbox Serif (Merriweather)  — heavy theme, current CSS'
        },
        {
            id: 'D-thin-serif',
            html: keepFamilies(html0, new Set(['Merriweather', 'Literata'])),
            file: path.join(appDir, '_fonts-ab-thin-serif.html'),
            theme: GRUVBOX_SERIF,
            label: 'D  only Merriweather + Literata, Gruvbox Serif  — proposed lazy set'
        }
    ];

    for (const v of variants) fs.writeFileSync(v.file, v.html);

    const browser = await puppeteer.launch({ headless: 'new' });
    const results = {};
    try {
        // Discard first launch: Chrome itself, not the fonts.
        await measure(browser, variants[0].file, variants[0].theme);

        for (const v of variants) {
            const rows = [];
            for (let i = 0; i < RUNS; i++) {
                rows.push(await measure(browser, v.file, v.theme));
            }
            results[v.id] = { rows, summary: summarise(v.label, rows) };
        }
    } finally {
        await browser.close();
        for (const v of variants) {
            try { fs.unlinkSync(v.file); } catch (e) {}
        }
    }

    const a = results['A-all-gruvbox'].summary;
    const b = results['B-thin-gruvbox'].summary;
    const c = results['C-all-serif'].summary;
    const d = results['D-thin-serif'].summary;

    console.log('\n=== verdict ===');
    const dNavAB = b.nav - a.nav;
    const dReadyAB = b.ready - a.ready;
    const dNavCD = d.nav - c.nav;
    const dReadyCD = d.ready - c.ready;
    console.log('Gruvbox (sans):    Δ nav ' + fmt(dNavAB, 0) + ' ms,  Δ fonts.ready '
        + fmt(dReadyAB, 1) + ' ms,  Δ bytes ' + (b.bytes - a.bytes));
    console.log('Gruvbox Serif:     Δ nav ' + fmt(dNavCD, 0) + ' ms,  Δ fonts.ready '
        + fmt(dReadyCD, 1) + ' ms,  Δ bytes ' + (d.bytes - c.bytes));
    console.log('(negative Δ means the thin set was faster)');

    const absAB = Math.max(Math.abs(dNavAB), Math.abs(dReadyAB));
    const bytesSameAB = a.bytes === b.bytes;
    if (bytesSameAB && absAB < 40) {
        console.log('\nResult: no meaningful saving on the default theme. Unused @font-face');
        console.log('were not fetched. Lazy-loading the active family is not a startup win.');
    } else if (!bytesSameAB) {
        console.log('\nResult: the thin set transferred fewer font bytes. Check the file lists.');
    } else {
        console.log('\nResult: bytes matched; timing noise is ' + fmt(absAB, 0) + ' ms. Not a win.');
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
