/**
 * Builds tests/pdf-scanned.pdf for reading text in scanned pages (docs/pdf-and-audit-plan.md,
 * Phase 3): two pages that are pictures of text and hold no text of their own, as a scanner
 * makes them. The words are drawn on a canvas and embedded as images.
 *
 *   node tests/make-pdf-scanned.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  .p { page-break-after: always; }
  .p:last-child { page-break-after: auto; }
  img { display: block; width: 148mm; }
</style></head><body>
  <div class="p"><img id="a"></div>
  <div class="p"><img id="b"></div>
  <script>
    // A5 at 200 DPI, drawn like a clean scan: black type on slightly off-white paper.
    function scan(lines) {
      const c = document.createElement('canvas'); c.width = 1166; c.height = 1654;
      const g = c.getContext('2d');
      g.fillStyle = '#FBFAF7'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#111111'; g.textBaseline = 'alphabetic';
      let y = 180;
      for (const [text, size, gap] of lines) {
        g.font = size + 'px Georgia, serif';
        g.fillText(text, 110, y);
        y += gap;
      }
      return c.toDataURL('image/png');
    }
    document.getElementById('a').src = scan([
      ['Chapter One', 64, 120],
      ['The quick brown fox jumps over', 40, 56],
      ['the lazy dog near the harbour wall.', 40, 110],
      ['A second paragraph follows here,', 40, 56],
      ['set apart from the first by a gap.', 40, 56]
    ]);
    document.getElementById('b').src = scan([
      ['Chapter Two', 64, 120],
      ['Lanterns glowed along the quiet', 40, 56],
      ['quay at dawn.', 40, 56]
    ]);
  </script>
</body></html>`;

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all(Array.from(document.images).map(i => i.decode())));
    await page.pdf({ path: path.join(here, 'pdf-scanned.pdf'), format: 'A5', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    console.log('wrote tests/pdf-scanned.pdf');
} finally { await browser.close(); }
