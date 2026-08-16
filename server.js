import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '2.2';

app.use(express.json({ limit: '25mb' }));

// Never cache the HTML (fixes "stuck on old broken build")
app.use(express.static(join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); }
}));

app.get('/api/health', (req, res) => res.json({ ok: true, v: VERSION }));
app.get('/api/version', (req, res) => res.json({ ok: true, v: VERSION }));

// ---- Novita proxy ----
app.all('/api/novita/*', async (req, res) => {
  try {
    const apiKey = req.headers['x-novita-key'];
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    if (!apiKey) return res.status(400).json({ error: 'missing X-Novita-Key header' });
    const path = req.path.replace('/api/novita', '');
    const qs = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    const url = `https://api.${domain}${path}${qs}`;
    const upstream = await fetch(url, {
      method: req.method,
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'agent-deck/' + VERSION },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {})
    });
    const text = await upstream.text();
    res.status(upstream.status).set('Content-Type', 'application/json').send(text);
  } catch (e) { res.status(502).json({ error: 'proxy error: ' + e.message }); }
});

// ---- Gemini proxies ----
app.get('/api/gemini/models', async (req, res) => {
  try {
    const key = req.headers['x-gemini-key'];
    if (!key) return res.status(400).json({ error: 'missing X-Gemini-Key header' });
    const up = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { headers: { 'x-goog-api-key': key } });
    res.status(up.status).send(await up.text());
  } catch (e) { res.status(502).json({ error: 'gemini proxy error: ' + e.message }); }
});

app.post('/api/gemini/*', async (req, res) => {
  try {
    const key = req.headers['x-gemini-key'];
    if (!key) return res.status(400).json({ error: 'missing X-Gemini-Key header' });
    const path = req.path.replace('/api/gemini/', '');
    const up = await fetch('https://generativelanguage.googleapis.com/v1beta/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(req.body || {})
    });
    res.status(up.status).send(await up.text());
  } catch (e) { res.status(502).json({ error: 'gemini proxy error: ' + e.message }); }
});

app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log('AGENT//DECK v' + VERSION + ' on ' + PORT));
