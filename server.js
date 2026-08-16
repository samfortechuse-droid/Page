import express from 'express';
import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;
const VERSION = '2.6.0';

// Track active CDP proxy connections for diagnostics
const activeConnections = new Map();

/* ============================================================================
   WEBSOCKET PROXY FOR CDP
   Routes: /ws/cdp/:sandboxId/:path
   Proxies to: wss://9223-:sandboxId.:domain/:path
   ============================================================================ */

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  try {
    // Parse URL pattern
    const m = req.url.match(/^\/ws\/cdp\/([^/]+)\/(.+)$/);
    if (!m) {
      console.error(`[${requestId}] WS upgrade failed: malformed URL pattern:`, req.url);
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    
    const [, sbxId, wsPath] = m;
    
    // Validate sandbox ID
    if (!sbxId || sbxId.trim() === '') {
      console.error(`[${requestId}] WS upgrade failed: empty sandbox ID`);
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    
    // Validate WebSocket path
    if (!wsPath || wsPath.trim() === '') {
      console.error(`[${requestId}] WS upgrade failed: empty WebSocket path`);
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    const targetUrl = `wss://9223-${sbxId}.${domain}/${wsPath}`;
    
    console.log(`[${requestId}] CDP WS upgrade request:`, {
      sandboxId: sbxId,
      wsPath: wsPath,
      target: targetUrl
    });
    
    // Create upstream WebSocket with timeout
    const connectTimeout = setTimeout(() => {
      console.error(`[${requestId}] Upstream CDP connection timeout after 15s`);
      try {
        upWs.terminate();
      } catch (e) {}
      socket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      socket.destroy();
    }, 15000);
    
    const upWs = new WebSocket(targetUrl, req.headers['sec-websocket-protocol'] || []);
    
    upWs.on('open', () => {
      clearTimeout(connectTimeout);
      console.log(`[${requestId}] Upstream CDP connected:`, targetUrl);
      
      // Upgrade the downstream connection
      wss.handleUpgrade(req, socket, head, (downWs) => {
        console.log(`[${requestId}] Downstream CDP connected`);
        
        const connectionId = `${requestId}-${sbxId}`;
        activeConnections.set(connectionId, { upWs, downWs, sandboxId: sbxId });
        
        // Track if we've already closed to prevent duplicate closes
        let closed = false;
        
        const cleanup = (code, reason, source) => {
          if (closed) return;
          closed = true;
          
          console.log(`[${requestId}] CDP proxy closed:`, {
            sandboxId: sbxId,
            code,
            reason: reason || '(none)',
            source,
            activeConnections: activeConnections.size - 1
          });
          
          activeConnections.delete(connectionId);
          
          // Close upstream if still open
          if (upWs.readyState === WebSocket.OPEN || upWs.readyState === WebSocket.CONNECTING) {
            try {
              upWs.close(code, reason);
            } catch (e) {
              console.error(`[${requestId}] Error closing upstream:`, e.message);
            }
          }
          
          // Close downstream if still open
          if (downWs.readyState === WebSocket.OPEN || downWs.readyState === WebSocket.CONNECTING) {
            try {
              downWs.close(code, reason);
            } catch (e) {
              console.error(`[${requestId}] Error closing downstream:`, e.message);
            }
          }
          
          // Remove all listeners to prevent memory leaks
          upWs.removeAllListeners();
          downWs.removeAllListeners();
        };
        
        // Forward messages: downstream → upstream
        downWs.on('message', (data) => {
          if (upWs.readyState === WebSocket.OPEN) {
            try {
              upWs.send(data);
            } catch (e) {
              console.error(`[${requestId}] Error forwarding down→up:`, e.message);
              cleanup(1011, 'Forward error', 'downstream');
            }
          }
        });
        
        // Forward messages: upstream → downstream
        upWs.on('message', (data) => {
          if (downWs.readyState === WebSocket.OPEN) {
            try {
              downWs.send(data);
            } catch (e) {
              console.error(`[${requestId}] Error forwarding up→down:`, e.message);
              cleanup(1011, 'Forward error', 'upstream');
            }
          }
        });
        
        // Handle downstream close
        downWs.on('close', (code, reason) => {
          cleanup(code, reason.toString(), 'downstream');
        });
        
        // Handle upstream close
        upWs.on('close', (code, reason) => {
          cleanup(code, reason.toString(), 'upstream');
        });
        
        // Handle downstream errors
        downWs.on('error', (err) => {
          console.error(`[${requestId}] Downstream CDP error:`, err.message);
          cleanup(1011, 'Downstream error', 'downstream');
        });
        
        // Handle upstream errors
        upWs.on('error', (err) => {
          console.error(`[${requestId}] Upstream CDP error:`, err.message);
          cleanup(1011, 'Upstream error', 'upstream');
        });
      });
    });
    
    upWs.on('error', (err) => {
      clearTimeout(connectTimeout);
      console.error(`[${requestId}] Upstream CDP connection failed:`, {
        target: targetUrl,
        error: err.message
      });
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    });
    
  } catch (e) {
    console.error(`[${requestId}] WS upgrade exception:`, e.message);
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
});

/* ============================================================================
   ENVD RAW PROXY (Connect-RPC)
   Routes: POST /api/envd/:port/:sbx/*
   Proxies to: https://:port-:sbx.:domain/*
   ============================================================================ */

app.post('/api/envd/:port/:sbx/*', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  try {
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    const { port, sbx } = req.params;
    const rest = req.path.replace(`/api/envd/${port}/${sbx}`, '');
    const url = `https://${port}-${sbx}.${domain}${rest}`;
    
    console.log(`[${requestId}] envd proxy:`, { port, sandboxId: sbx, path: rest });
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    
    const up = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/connect+json',
        'Connect-Protocol-Version': req.headers['connect-protocol-version'] || '1',
        'Authorization': req.headers['authorization'] || 'Basic dXNlcjo=',
        'User-Agent': 'agent-deck/' + VERSION
      },
      body: req.body,
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const buf = Buffer.from(await up.arrayBuffer());
    console.log(`[${requestId}] envd response:`, { status: up.status, bytes: buf.length });
    
    res.status(up.status)
      .set('Content-Type', up.headers.get('content-type') || 'application/connect+json')
      .send(buf);
      
  } catch (e) {
    console.error(`[${requestId}] envd proxy error:`, e.message);
    
    if (e.name === 'AbortError') {
      res.status(504).json({ error: 'envd request timeout after 120s' });
    } else {
      res.status(502).json({ error: 'envd proxy: ' + e.message });
    }
  }
});

/* ============================================================================
   CDP HTTP PROXY
   Routes: /api/cdp/:sbx/*
   Proxies to: https://9223-:sbx.:domain/*
   ============================================================================ */

app.all('/api/cdp/:sbx/*', async (req, res) => {
  const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  try {
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    const rest = req.path.replace(`/api/cdp/${req.params.sbx}`, '');
    const url = `https://9223-${req.params.sbx}.${domain}${rest}`;
    
    console.log(`[${requestId}] CDP HTTP proxy:`, {
      sandboxId: req.params.sbx,
      method: req.method,
      path: rest
    });
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const up = await fetch(url, {
      method: req.method === 'PUT' ? 'PUT' : 'GET',
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const txt = await up.text();
    console.log(`[${requestId}] CDP HTTP response:`, {
      status: up.status,
      length: txt.length
    });
    
    res.status(up.status)
      .set('Content-Type', up.headers.get('content-type') || 'application/json')
      .send(txt);
      
  } catch (e) {
    console.error(`[${requestId}] CDP proxy error:`, e.message);
    
    if (e.name === 'AbortError') {
      res.status(504).json({ error: 'CDP request timeout after 10s' });
    } else {
      res.status(502).json({ error: 'cdp proxy: ' + e.message });
    }
  }
});

/* ============================================================================
   MIDDLEWARE & STATIC FILES
   ============================================================================ */

app.use(express.json({ limit: '25mb' }));
app.use(express.static(join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

/* ============================================================================
   HEALTH & VERSION ENDPOINTS
   ============================================================================ */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    v: VERSION,
    websocketProxy: true,
    activeCDPConnections: activeConnections.size,
    uptime: process.uptime()
  });
});

app.get('/api/version', (req, res) => {
  res.json({
    ok: true,
    v: VERSION,
    node: process.version
  });
});

/* ============================================================================
   NOVITA API PROXY
   Routes: /api/novita/*
   Proxies to: https://api.:domain/*
   ============================================================================ */

app.all('/api/novita/*', async (req, res) => {
  const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  try {
    const apiKey = req.headers['x-novita-key'];
    const domain = req.headers['x-novita-domain'] || 'us-phx-1.sandbox.novita.ai';
    
    if (!apiKey) {
      console.error(`[${requestId}] Novita proxy: missing API key`);
      return res.status(400).json({ error: 'missing X-Novita-Key header' });
    }
    
    const path = req.path.replace('/api/novita', '');
    const qs = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    const url = `https://api.${domain}${path}${qs}`;
    
    console.log(`[${requestId}] Novita proxy:`, {
      method: req.method,
      path: path,
      domain: domain
    });
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    const up = await fetch(url, {
      method: req.method,
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const txt = await up.text();
    console.log(`[${requestId}] Novita response:`, { status: up.status });
    
    res.status(up.status)
      .set('Content-Type', 'application/json')
      .send(txt);
      
  } catch (e) {
    console.error(`[${requestId}] Novita proxy error:`, e.message);
    
    if (e.name === 'AbortError') {
      res.status(504).json({ error: 'Novita request timeout after 30s' });
    } else {
      res.status(502).json({ error: 'proxy: ' + e.message });
    }
  }
});

/* ============================================================================
   GEMINI API PROXY
   Routes: GET /api/gemini/models
           POST /api/gemini/*
   Proxies to: https://generativelanguage.googleapis.com/v1beta/*
   ============================================================================ */

app.get('/api/gemini/models', async (req, res) => {
  const key = req.headers['x-gemini-key'];
  if (!key) {
    return res.status(400).json({ error: 'missing X-Gemini-Key header' });
  }
  
  try {
    const up = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
      headers: { 'x-goog-api-key': key }
    });
    res.status(up.status).send(await up.text());
  } catch (e) {
    res.status(502).json({ error: 'gemini proxy: ' + e.message });
  }
});

app.post('/api/gemini/*', async (req, res) => {
  const key = req.headers['x-gemini-key'];
  if (!key) {
    return res.status(400).json({ error: 'missing X-Gemini-Key header' });
  }
  
  try {
    const path = req.path.replace('/api/gemini/', '');
    const up = await fetch('https://generativelanguage.googleapis.com/v1beta/' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify(req.body || {})
    });
    res.status(up.status).send(await up.text());
  } catch (e) {
    res.status(502).json({ error: 'gemini proxy: ' + e.message });
  }
});

/* ============================================================================
   SPA FALLBACK
   ============================================================================ */

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

/* ============================================================================
   SERVER STARTUP
   ============================================================================ */

server.listen(PORT, () => {
  console.log('===========================================');
  console.log('AGENT//DECK v' + VERSION + ' started');
  console.log('Port:', PORT);
  console.log('Node:', process.version);
  console.log('WebSocket proxy: enabled');
  console.log('===========================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
