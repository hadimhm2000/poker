import "server-only";

/**
 * Server-side PDF of a page, printed by headless Chromium (the same print styles as the
 * browser's Print). PDF_CHROMIUM_PATH points at a Chromium binary on the server; without it
 * the feature is off and people use the print view instead.
 */
export const pdfEnabled = () => !!process.env.PDF_CHROMIUM_PATH;

/** Only one render at a time: Chromium is heavy, and exports are rare. */
let queue: Promise<unknown> = Promise.resolve();

export async function renderPdf(url: string, cookie: { name: string; value: string }): Promise<Buffer> {
  const run = async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: process.env.PDF_CHROMIUM_PATH, args: ["--no-sandbox"] });
    try {
      const ctx = await browser.newContext({ javaScriptEnabled: true });
      const u = new URL(url);
      // The request's own session, so the page shows exactly what this user may see.
      await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: u.hostname, path: "/", httpOnly: true, secure: u.protocol === "https:" || cookie.name.startsWith("__") }]);
      const page = await ctx.newPage();
      const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      if (!res || !res.ok()) throw new Error(`page returned ${res?.status()}`);
      await page.evaluate(() => document.fonts.ready);
      return Buffer.from(await page.pdf({ format: "A4", landscape: true, printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } }));
    } finally {
      await browser.close();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
