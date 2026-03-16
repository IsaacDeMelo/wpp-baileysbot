const express = require('express');
const puppeteer = require('puppeteer-core');

const PORT = Number(process.env.PORT || 3000);
const JSON_LIMIT = process.env.JSON_LIMIT || '15mb';

const app = express();
app.use(express.json({ limit: JSON_LIMIT }));

let browserPromise;

function resolveExecutablePath() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (envPath) return envPath;
  // Debian/Ubuntu (Dockerfile instala chromium)
  return '/usr/bin/chromium';
}

async function getBrowser() {
  if (!browserPromise) {
    const executablePath = resolveExecutablePath();
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  return browserPromise;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/render', async (req, res) => {
  const { html, width, height, selector } = req.body || {};

  if (typeof html !== 'string' || !html.trim()) {
    return res.status(400).json({ error: 'html obrigatório' });
  }

  const w = Number(width || 720);
  const h = Number(height || 1280);
  const sel = typeof selector === 'string' && selector.trim() ? selector.trim() : '#rg-card';

  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > 2000 || h > 2000) {
    return res.status(400).json({ error: 'width/height inválidos (1..2000)' });
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: Math.floor(w), height: Math.floor(h), deviceScaleFactor: 2 });

    // Ambientes sem internet: evita travar por Google Fonts.
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const url = r.url();
      if (url.startsWith('https://fonts.googleapis.com') || url.startsWith('https://fonts.gstatic.com')) {
        return r.abort();
      }
      return r.continue();
    });

    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Seletor alvo
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
    } catch {
      // cai para screenshot da página toda
    }

    // Pequena espera por fontes/layout final.
    try {
      await Promise.race([
        page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve()),
        new Promise(resolve => setTimeout(resolve, 1500))
      ]);
    } catch {}

    const el = await page.$(sel);
    const buf = el ? await el.screenshot({ type: 'png' }) : await page.screenshot({ type: 'png' });

    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  } catch (err) {
    const msg = String(err?.message || err || 'erro');
    res.status(500).json({ error: 'render_failed', message: msg });
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
  }
});

async function shutdown() {
  try {
    const browser = await browserPromise;
    if (browser) await browser.close();
  } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, () => {
  console.log(`renderer-api ouvindo em :${PORT}`);
});
