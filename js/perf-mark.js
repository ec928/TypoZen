// Start-up timing marks for the perf log. Loaded as <script src data-mark="name"> rather
// than inline, because the page's Content-Security-Policy allows no inline script.
window[document.currentScript.dataset.mark] = Math.round(performance.now());
