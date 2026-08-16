
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;
const VERSION = '2.6';

/* ---- WebSocket proxy for CDP (with better error handling) ---- */
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  try {
    const m = req.url.match(/^\/ws\/cdp\/([^/]+)\/(.+)$/);
    if (!m) {
      console.error('WS upgrade failed: bad URL pattern:', req.url);
      socket.destroy();
      return;
    }
    const [, sbx, rest] = m;
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    const target = `wss://9223-${sbx}.${domain}/${rest}`;
    console.log('WS upgrade:', req.url, '→', target);
    
    const up = new WebSocket(target, req.headers['sec-websocket-protocol'] || []);
    up.on('open', () => {
      wss.handleUpgrade(req, socket, head, (down) => {
        console.log('WS connected:', target);
        down.on('message', d => { try { up.send(d); } catch (e) { console.error('down→up error:', e.message); } });
        up.on('message', d => { try { down.send(d); } catch (e) { console.error('up→down error:', e.message); } });
        down.on('close', () => { try { up.close(); } catch (e) {} });
        up.on('close', () => { try { down.close(); } catch (e) {} });
        down.on('error', e => { console.error('down error:', e.message); try { up.close(); } catch (e2) {} });
        up.on('error', e => { console.error('up error:', e.message); try { down.close(); } catch (e2) {} });
      });
    });
    up.on('error', (e) => {
      console.error('WS upstream error:', target, e.message);
      socket.destroy();
    });
    up.on('close', () => console.log('WS upstream closed:', target));
  } catch (e) {
    console.error('WS upgrade exception:', e.message);
    socket.destroy();
  }
});

/* ---- envd raw proxy ---- */
app.post('/api/envd/:port/:sbx/*', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  try {
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    const { port, sbx } = req.params;
    const rest = req.path.replace(`/api/envd/${port}/${sbx}`, '');
    const url = `https://${port}-${sbx}.${domain}${rest}`;
    console.log('envd proxy:', url);
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
    console.log('envd response:', up.status, 'bytes:', buf.length);
    res.status(up.status).set('Content-Type', up.headers.get('content-type') || 'application/connect+json').send(buf);
  } catch (e) {
    console.error('envd proxy error:', e.message);
    res.status(502).json({ error: 'envd proxy: ' + e.message });
  }
});

/* ---- CDP HTTP proxy ---- */
app.all('/api/cdp/:sbx/*', async (req, res) => {
  try {
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    const rest = req.path.replace(`/api/cdp/${req.params.sbx}`, '');
    const url = `https://9223-${req.params.sbx}.${domain}${rest}`;
    console.log('CDP HTTP proxy:', url);
    const up = await fetch(url, { method: req.method === 'PUT' ? 'PUT' : 'GET' });
    const txt = await up.text();
    console.log('CDP response:', up.status, 'len:', txt.length);
    res.status(up.status).set('Content-Type', up.headers.get('content-type') || 'application/json').send(txt);
  } catch (e) {
    console.error('CDP proxy error:', e.message);
    res.status(502).json({ error: 'cdp proxy: ' + e.message });
  }
});

app.use(express.json({ limit: '25mb' }));
app.use(express.static(join(__dirname, 'public'), {
  etag: false, lastModified: false,
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); }
}));

app.get('/api/health', (req, res) => res.json({ ok: true, v: VERSION }));
app.get('/api/version', (req, res) => res.json({ ok: true, v: VERSION }));

app.all('/api/novita/*', async (req, res) => {
  try {
    const apiKey = req.headers['x-novita-key'];
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    if (!apiKey) return res.status(400).json({ error: 'missing X-Novita-Key' });
    const path = req.path.replace('/api/novita', '');
    const qs = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    const url = `https://api.${domain}${path}${qs}`;
    console.log('Novita proxy:', url);
    const up = await fetch(url, {
      method: req.method,
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {})
    });
    const txt = await up.text();
    console.log('Novita response:', up.status);
    res.status(up.status).set('Content-Type', 'application/json').send(txt);
  } catch (e) {
    console.error('Novita proxy error:', e.message);
    res.status(502).json({ error: 'proxy: ' + e.message });
  }
});

app.get('/api/gemini/models', async (req, res) => {
  const key = req.headers['x-gemini-key'];
  if (!key) return res.status(400).json({ error: 'missing key' });
  const up = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { headers: { 'x-goog-api-key': key } });
  res.status(up.status).send(await up.text());
});
app.post('/api/gemini/*', async (req, res) => {
  const key = req.headers['x-gemini-key'];
  if (!key) return res.status(400).json({ error: 'missing key' });
  const path = req.path.replace('/api/gemini/', '');
  const up = await fetch('https://generativelanguage.googleapis.com/v1beta/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(req.body || {})
  });
  res.status(up.status).send(await up.text());
});

app.get('*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log('AGENT//DECK v' + VERSION + ' on ' + PORT));
