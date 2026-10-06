/**
 * Builds tests/pdf-running-head.pdf: twelve pages of prose with a running header ("The
 * Lantern Keeper") and a page-number footer on every page, and chapters whose first page
 * opens with "CHAPTER n" -- for pdf-reading-order-app, which checks that Read aloud skips
 * the header and footer and still reads the chapter headings.
 *
 *   node tests/make-pdf-running-head.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const words = 'the lamp burned low along the harbour wall while gulls wheeled over grey water and the keeper climbed the stair counting every step as he had done for forty years'.split(' ');
let seed = 7;
const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const sentence = () => {
    const n = 12 + Math.floor(rnd() * 14);
    const w = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]);
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    return w.join(' ') + '.';
};
const para = () => Array.from({ length: 5 }, sentence).join(' ');
let body = '';
for (let c = 1; c <= 4; c++) {
    body += `<h1 style="page-break-before:${c > 1 ? 'always' : 'auto'}">CHAPTER ${c}</h1>`;
    for (let k = 0; k < 9; k++) body += `<p>${para()}</p>`;
}
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 12pt Georgia, serif; line-height: 1.5; }
  h1 { font-size: 18pt; margin: 0 0 18pt; }
  p { margin: 0 0 10pt; text-indent: 1.5em; }
</style></head><body>${body}</body></html>`;

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({
    path: path.join(here, 'pdf-running-head.pdf'),
    format: 'A5',
    margin: { top: '22mm', bottom: '20mm', left: '16mm', right: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div style="font:9pt Georgia,serif;width:100%;text-align:center;">The Lantern Keeper</div>',
    footerTemplate: '<div style="font:9pt Georgia,serif;width:100%;text-align:center;"><span class="pageNumber"></span></div>'
});
await browser.close();
console.log('wrote tests/pdf-running-head.pdf');
