/**
 * Builds tests/pdf-smask-size.pdf: one page, one picture -- a 2x2 RGB image whose soft mask
 * (transparency) is 40x40. PdfPig reports the picture at 2x2; PDF.js decodes it at the
 * mask's 40x40. The fast Save All Images path hands such a picture to the viewer by size,
 * and the sizes do not match, which used to drop it silently (pdf-pictures-direct-app).
 *
 *   node tests/make-pdf-smask-size.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);      // 2x2 pixels
const mask = Buffer.alloc(40 * 40);
for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) mask[y * 40 + x] = (x + y) % 2 ? 255 : 128;
const content = Buffer.from('q 200 0 0 200 50 50 cm /Im1 Do Q\n', 'latin1');

const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>', 'latin1'),
    Buffer.concat([Buffer.from('<< /Length ' + content.length + ' >>\nstream\n', 'latin1'), content, Buffer.from('\nendstream', 'latin1')]),
    Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 6 0 R /Length ' + rgb.length + ' >>\nstream\n', 'latin1'), rgb, Buffer.from('\nendstream', 'latin1')]),
    Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ' + mask.length + ' >>\nstream\n', 'latin1'), mask, Buffer.from('\nendstream', 'latin1')])
];
const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
const offsets = [];
let at = parts[0].length;
objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from((i + 1) + ' 0 obj\n', 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(at); parts.push(b); at += b.length;
});
let xref = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
xref += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + at + '\n%%EOF\n';
parts.push(Buffer.from(xref, 'latin1'));
fs.writeFileSync(path.join(here, 'pdf-smask-size.pdf'), Buffer.concat(parts));
console.log('wrote tests/pdf-smask-size.pdf');
