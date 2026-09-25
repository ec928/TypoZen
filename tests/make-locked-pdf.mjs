/**
 * Builds tests/pdf-locked.pdf: one page, protected by the user password "test", for the
 * PDF reader's password prompt. Written by hand with the PDF standard security handler at
 * its simplest (revision 2, 40-bit RC4) -- every PDF reader supports it and it needs only
 * MD5 and RC4, so no PDF library is required. Not secure; it only has to be locked.
 *
 *   node tests/make-locked-pdf.mjs
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
function rc4(key, data) {
    const s = [...Array(256).keys()];
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
    const out = Buffer.alloc(data.length);
    for (let n = 0, i = 0, j = 0; n < data.length; n++) {
        i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
        out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
    }
    return out;
}
const padded = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

const USER = 'test', OWNER = 'owner-of-the-fixture';
const P = -44;                                        // print and copy allowed
const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
const O = rc4(md5(padded(OWNER)).subarray(0, 5), padded(USER));
const pBytes = Buffer.alloc(4); pBytes.writeInt32LE(P);
const key = md5(padded(USER), O, pBytes, id).subarray(0, 5);
const U = rc4(key, PAD);
const objKey = (num) => md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 10);

const content = Buffer.from('BT /F1 18 Tf 24 120 Td (Locked fixture: the password opened it.) Tj ET', 'latin1');
const stream = rc4(objKey(4), content);

const parts = [];
const offsets = [];
let len = 0;
const add = (b) => { b = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(b); len += b.length; };
const obj = (n, body) => { offsets[n] = len; add(n + ' 0 obj\n'); add(body); add('\nendobj\n'); };

add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 240] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
obj(4, Buffer.concat([Buffer.from('<< /Length ' + stream.length + ' >>\nstream\n', 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]));
obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
obj(6, '<< /Filter /Standard /V 1 /R 2 /O <' + O.toString('hex') + '> /U <' + U.toString('hex') + '> /P ' + P + ' >>');
const xref = len;
add('xref\n0 7\n0000000000 65535 f \n');
for (let n = 1; n <= 6; n++) add(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
add('trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<' + id.toString('hex') + '> <' + id.toString('hex') + '>] >>\n');
add('startxref\n' + xref + '\n%%EOF\n');

fs.writeFileSync(path.join(here, 'pdf-locked.pdf'), Buffer.concat(parts));
console.log('wrote tests/pdf-locked.pdf (user password "test")');
