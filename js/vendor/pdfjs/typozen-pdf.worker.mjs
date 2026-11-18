/**
 * PDF.js decodes each picture into an OffscreenCanvas. A hardware canvas keeps
 * that bitmap in the GPU process, and closing the document does not give it
 * back. willReadFrequently puts it in ordinary worker memory, which close does
 * release. The import below starts the worker; canvases are created later,
 * when a page is drawn, so the hook is in place in time.
 */
import './pdf.worker.min.mjs';

const take = OffscreenCanvas.prototype.getContext;
OffscreenCanvas.prototype.getContext = function (type, attrs) {
    if (type === '2d') attrs = Object.assign({}, attrs || {}, { willReadFrequently: true });
    return take.call(this, type, attrs);
};
