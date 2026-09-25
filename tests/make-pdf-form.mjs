/**
 * Builds tests/pdf-form.pdf: one page with one fillable text field ("name"), for filling in
 * a PDF form and saving it (docs/pdf-and-audit-plan.md, Phase 4). Written by hand -- a
 * minimal AcroForm -- since a browser's print to PDF makes no form fields.
 *
 *   node tests/make-pdf-form.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = 'BT /F1 14 Tf 30 206 Td (Your name:) Tj ET';
const parts = [];
const offsets = [];
let len = 0;
const add = (s) => { const b = Buffer.from(s, 'latin1'); parts.push(b); len += b.length; };
const obj = (n, body) => { offsets[n] = len; add(n + ' 0 obj\n' + body + '\nendobj\n'); };

add('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
obj(1, '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> /NeedAppearances true >> >>');
obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Contents 6 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [4 0 R] >>');
obj(4, '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [130 198 390 222] /F 4 /DA (/Helv 12 Tf 0 g) /MK << /BC [0 0 0] >> /P 3 0 R /V () >>');
obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
obj(6, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
const xref = len;
add('xref\n0 7\n0000000000 65535 f \n');
for (let n = 1; n <= 6; n++) add(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
add('trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
fs.writeFileSync(path.join(here, 'pdf-form.pdf'), Buffer.concat(parts));
console.log('wrote tests/pdf-form.pdf');
