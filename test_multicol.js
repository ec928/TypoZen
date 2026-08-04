const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setContent(`
        <div id='container' style='columns: 2; column-gap: 60px; height: 600px; overflow-x: auto; overflow-y: hidden; width: 800px; padding: 48px;'>
            <div id='b1' style='height: 400px; background: red; margin-bottom: 20px;'>Block 1</div>
            <div id='b2' style='height: 400px; background: blue; margin-bottom: 20px;'>Block 2</div>
            <div id='b3' style='height: 400px; background: green; margin-bottom: 20px;'>Block 3</div>
            <div id='b4' style='height: 400px; background: yellow; margin-bottom: 20px;'>Block 4</div>
            <div id='b5' style='height: 400px; background: purple; margin-bottom: 20px;'>Block 5</div>
        </div>
    `);
    const rects = await page.evaluate(() => {
        const container = document.getElementById('container');
        container.scrollLeft = 800; // Scroll past the first column
        const toObj = (r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height });
        return {
            b1: toObj(document.getElementById('b1').getBoundingClientRect()),
            b2: toObj(document.getElementById('b2').getBoundingClientRect()),
            b3: toObj(document.getElementById('b3').getBoundingClientRect()),
            b4: toObj(document.getElementById('b4').getBoundingClientRect()),
            b5: toObj(document.getElementById('b5').getBoundingClientRect()),
            scrollLeft: container.scrollLeft
        };
    });
    console.log(rects);
    await browser.close();
})();
