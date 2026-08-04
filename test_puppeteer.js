const puppeteer = require('puppeteer');
const fs = require('fs');

async function run() {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    
    // Set a typical viewport size
    await page.setViewport({ width: 1200, height: 800 });

    // Enable console log capture
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));

    // Load the HTML template directly.
    let htmlPath = 'file:///' + __dirname.replace(/\\/g, '/') + '/TypoZen_Template.html';
    await page.goto(htmlPath);

    // Inject CSS and JS manually since the C# host usually does this
    let css = fs.readFileSync('css/typozen.css', 'utf8');
    let js = fs.readFileSync('js/typozen.js', 'utf8');
    
    await page.evaluate((css, js) => {
        let style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        
        let script = document.createElement('script');
        script.textContent = js;
        document.head.appendChild(script);
    }, css, js);

    // Wait for the app to initialize
    await page.evaluate(() => {
        return new Promise(resolve => {
            if (window.editor) resolve();
            else {
                window.addEventListener('message', function listener(e) {
                    if (e.data === 'ready' || e.data.startsWith('perf:')) { // C# receives this
                        window.removeEventListener('message', listener);
                        resolve();
                    }
                });
                setTimeout(resolve, 1000); // fallback
            }
        });
    });

    // Load the test markdown content
    let md = fs.readFileSync('tests/large-scroll-mixed.md', 'utf8');
    await page.evaluate((content) => {
        if (typeof loadMarkdown === 'function') {
            loadMarkdown(content);
        } else {
            console.log("loadMarkdown not found!");
        }
    }, md);

    await new Promise(r => setTimeout(r, 500));

    // Switch to 2-col mode
    console.log("Switching to 2-col mode...");
    await page.evaluate(() => {
        window.postMessage("set_column_mode:2", "*");
    });
    
    await new Promise(r => setTimeout(r, 500));

    // Scroll to simulate user action (Page 4 is approx 3000px)
    console.log("Scrolling editor to 3000px horizontally...");
    await page.evaluate(() => {
        let isTwoCol = editor && editor.classList.contains('two-col-layout');
        let scrollEl = isTwoCol ? editor : mainContainer;
        console.log("block count:", editor.querySelectorAll('.block').length);
        console.log("editor dimensions:", editor.clientWidth, editor.scrollWidth, editor.clientHeight, editor.scrollHeight);
        console.log("mainContainer dimensions:", mainContainer.clientWidth, mainContainer.scrollWidth, mainContainer.clientHeight, mainContainer.scrollHeight);
        scrollEl.scrollBy({ left: 3000 });
        if (scrollEl.scrollLeft === 0) {
            mainContainer.scrollBy({ left: 3000 });
            console.log("editor couldn't scroll horizontally, tried mainContainer");
        }
    });
    
    await new Promise(r => setTimeout(r, 500));
    
    // Verify scrolling happened
    let scrollPos = await page.evaluate(() => {
        let isTwoCol = editor && editor.classList.contains('two-col-layout');
        let scrollEl = isTwoCol ? editor : mainContainer;
        return { left: scrollEl.scrollLeft, top: scrollEl.scrollTop };
    });
    console.log("Scroll position after scroll:", scrollPos);

    // Switch to 1-col mode (triggering the bug)
    console.log("Switching to 1-col mode...");
    await page.evaluate(() => {
        window.postMessage("set_column_mode:1", "*");
    });
    
    await new Promise(r => setTimeout(r, 1000));

    // Check where we ended up
    let finalState = await page.evaluate(() => {
        let st = typeof lastStatusCaret !== 'undefined' ? lastStatusCaret() : null;
        return {
            mode: state.mode,
            scrollTop: mainContainer.scrollTop,
            caret: st ? st.caret : null,
            activeBlock: currentActiveBlock ? currentActiveBlock.getAttribute('data-model-index') : null,
            editorHeight: editor.style.height,
            isTwoCol: editor.classList.contains('two-col-layout'),
            telemetry: window.__tzTelemetry || []
        };
    });

    console.log("Final state:");
    console.dir(finalState, { depth: null });

    await browser.close();
}

run().catch(console.error);
