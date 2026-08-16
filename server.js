import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '2.3';

/* ---- RAW routes MUST be registered before express.json() ---- */

// envd proxy (connect-rpc + any port of the sandbox) — raw bytes both ways
app.post('/api/envd/:port/:sbx/*', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  try {
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    const { port, sbx } = req.params;
    const rest = req.path.replace(`/api/envd/${port}/${sbx}`, '');
    const url = `https://${port}-${sbx}.${domain}${rest}`;
    const up = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/connect+json',
        'Connect-Protocol-Version': req.headers['connect-protocol-version'] || '1',
        'Authorization': req.headers['authorization'] || 'Basic dXNlcjo=',
        'User-Agent': 'agent-deck/' + VERSION
      },
      body: req.body
    });
    const buf = Buffer.from(await up.arrayBuffer());
    res.status(up.status).set('Content-Type', up.headers.get('content-type') || 'application/connect+json').send(buf);
  } catch (e) { res.status(502).json({ error: 'envd proxy: ' + e.message }); }
});

// CDP http endpoints (/json, /json/new) proxied server-side (no CORS on Chrome debug port)
app.all('/api/cdp/:sbx/*', async (req, res) => {
  try {
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    const rest = req.path.replace(`/api/cdp/${req.params.sbx}`, '');
    const url = `https://9223-${req.params.sbx}.${domain}${rest}`;
    const up = await fetch(url, { method: req.method === 'PUT' ? 'PUT' : 'GET' });
    res.status(up.status).set('Content-Type', up.headers.get('content-type') || 'application/json').send(await up.text());
  } catch (e) { res.status(502).json({ error: 'cdp proxy: ' + e.message }); }
});

app.use(express.json({ limit: '25mb' }));

app.use(express.static(join(__dirname, 'public'), {
  etag: false, lastModified: false,
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); }
}));

app.get('/api/health', (req, res) => res.json({ ok: true, v: VERSION }));
app.get('/api/version', (req, res) => res.json({ ok: true, v: VERSION }));

// Novita control-plane proxy
app.all('/api/novita/*', async (req, res) => {
  try {
    const apiKey = req.headers['x-novita-key'];
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    if (!apiKey) return res.status(400).json({ error: 'missing X-Novita-Key header' });
    const path = req.path.replace('/api/novita', '');
    const qs = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    const up = await fetch(`https://api.${domain}${path}${qs}`, {
      method: req.method,
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'agent-deck/' + VERSION },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {})
    });
    res.status(up.status).set('Content-Type', 'application/json').send(await up.text());
  } catch (e) { res.status(502).json({ error: 'proxy error: ' + e.message }); }
});

// Gemini proxies
app.get('/api/gemini/models', async (req, res) => {
  try {
    const key = req.headers['x-gemini-key'];
    if (!key) return res.status(400).json({ error: 'missing X-Gemini-Key header' });
    const up = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { headers: { 'x-goog-api-key': key } });
    res.status(up.status).send(await up.text());
  } catch (e) { res.status(502).json({ error: 'gemini proxy: ' + e.message }); }
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
  } catch (e) { res.status(502).json({ error: 'gemini proxy: ' + e.message }); }
});

app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log('AGENT//DECK v' + VERSION + ' on ' + PORT));
