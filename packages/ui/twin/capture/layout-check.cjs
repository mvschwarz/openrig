// Usage: node twin/capture/layout-check.cjs <html-path> [width=1440]
// Prints JSON boxes for sidebar/explorer/content; exits 1 on overlap or gap.
const path = require("node:path");
const { chromium } = require("playwright");
(async () => {
  const html = process.argv[2];
  const width = Number(process.argv[3] || 1440);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width, height: 900 } });
  await p.goto("file://" + path.resolve(html));
  await p.waitForTimeout(3000);
  const box = async (sel) => {
    const el = await p.$(sel);
    if (!el) return null;
    const bb = await el.boundingBox();
    return bb && bb.width > 0 ? { left: Math.round(bb.x), right: Math.round(bb.x + bb.width), width: Math.round(bb.width) } : null;
  };
  const rail = await box("[data-testid='app-rail']");
  const explorer = await box("[data-testid='explorer']");
  const content = await box("[data-testid='content-area'] > div");
  const mode = await p.getAttribute("[data-testid='content-area']", "data-explorer-mode").catch(() => null);
  const out = { width, mode, rail, explorer, content, errors: [] };
  if (!rail) out.errors.push("app-rail not visible");
  if (!content) out.errors.push("content-area not visible");
  if (rail && explorer && Math.abs(explorer.left - rail.right) > 1) out.errors.push(`explorer.left ${explorer.left} != rail.right ${rail.right}`);
  if (mode === "opaque" && explorer && content && content.left < explorer.right) out.errors.push(`content.left ${content.left} < explorer.right ${explorer.right}`);
  if (rail && content && content.left < rail.right) out.errors.push(`content.left ${content.left} < rail.right ${rail.right}`);
  console.log(JSON.stringify(out));
  await b.close();
  process.exit(out.errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
