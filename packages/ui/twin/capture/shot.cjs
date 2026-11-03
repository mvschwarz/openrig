// Usage: node twin/capture/shot.cjs <html-path> <png-path> [width=1440]
const path = require("node:path");
const { chromium } = require("playwright");
(async () => {
  const [html, png, w] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: Number(w || 1440), height: 900 } });
  await p.goto("file://" + path.resolve(html));
  await p.waitForTimeout(3500);
  await p.screenshot({ path: png });
  await b.close();
  console.log("wrote " + png);
})().catch((e) => { console.error(e); process.exit(1); });
