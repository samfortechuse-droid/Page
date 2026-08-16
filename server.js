import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.static(join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Novita proxy — forwards every request to api.<domain>
app.all('/api/novita/*', async (req, res) => {
  try {
    const apiKey = req.headers['x-novita-key'];
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    if (!apiKey) return res.status(400).json({ error: 'missing X-Novita-Key header' });

    const path = req.path.replace('/api/novita', '');
    const url = `https://api.${domain}${path}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;

    const headers = {
      'X-API-KEY': apiKey,
      'Content-Type': req.headers['content-type'] || 'application/json',
      'User-Agent': 'agent-deck/2.0',
      'Accept': 'application/json'
    };

    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      redirect: 'follow'
    });

    const text = await upstream.text();
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: 'proxy error: ' + e.message });
  }
});

// Gemini proxy — forwards to Google (avoid any future CORS surprises)
app.post('/api/gemini/*', async (req, res) => {
  try {
    const apiKey = req.headers['x-gemini-key'];
    if (!apiKey) return res.status(400).json({ error: 'missing X-Gemini-Key header' });

    const path = req.path.replace('/api/gemini/', '');
    const url = `https://generativelanguage.googleapis.com/v1beta/${path}`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(req.body || {})
    });

    const text = await upstream.text();
    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(502).json({ error: 'gemini proxy error: ' + e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`AGENT//DECK listening on ${PORT}`));
