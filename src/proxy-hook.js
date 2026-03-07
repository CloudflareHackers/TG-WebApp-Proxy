/**
 * WebSocket Proxy Hook
 * 
 * When proxy is enabled in settings, intercepts all WebSocket connections
 * to Telegram servers and rewrites them to go through our Cloudflare
 * Pages Function at /api/<host>/<path>.
 * 
 * GramJS connects to: wss://venus-1.web.telegram.org/apiws
 * We rewrite to:       wss://<our-domain>/api/venus-1.web.telegram.org/apiws
 * 
 * This must be imported BEFORE GramJS is loaded.
 */

const _OriginalWebSocket = window.WebSocket;

// Match Telegram WS URLs with optional port: wss://pluto.web.telegram.org:443/apiws
const TELEGRAM_WS_PATTERN = /^wss?:\/\/([a-z0-9\-]+\.(?:web\.)?telegram\.org)(?::\d+)?(\/.*)?$/i;

// Log to the app's visible log panel (if it exists)
function proxyLog(type, msg) {
  console.log(`[Proxy] ${msg}`);
  // Try to append to the visible log container
  try {
    const container = document.getElementById('logContainer') || document.getElementById('userLogContainer');
    if (container) {
      const time = new Date().toLocaleTimeString();
      const entry = document.createElement('div');
      entry.className = `log-entry ${type}`;
      entry.textContent = `[${time}] ${msg}`;
      container.appendChild(entry);
      container.scrollTop = container.scrollHeight;
    }
  } catch {}
}

class ProxiedWebSocket extends _OriginalWebSocket {
  constructor(url, protocols) {
    // Check if proxy is enabled (read directly from localStorage to avoid circular imports)
    let proxyEnabled = false;
    try {
      const raw = localStorage.getItem('tgcf_settings');
      if (raw) {
        const settings = JSON.parse(raw);
        proxyEnabled = !!settings.proxyEnabled;
      }
    } catch {}

    if (proxyEnabled && typeof url === 'string') {
      const match = url.match(TELEGRAM_WS_PATTERN);
      if (match) {
        const host = match[1]; // e.g. venus-1.web.telegram.org
        const path = match[2] || ''; // e.g. /apiws

        // Get proxy domain from settings — default is the deployed worker
        let proxyDomain = 'tg-ws-api.hashhackersapi.workers.dev';
        try {
          const raw = localStorage.getItem('tgcf_settings');
          if (raw) {
            const s = JSON.parse(raw);
            proxyDomain = s.proxyDomain || proxyDomain;
          }
        } catch {}

        // Route through CF Worker with Durable Objects
        const proxyUrl = `wss://${proxyDomain}/${host}${path}`;

        // Drop subprotocols — CF Workers WebSocketPair doesn't support protocol negotiation
        proxyLog('info', `🌐 Proxy: ${host}${path} → ${proxyDomain}`);
        super(proxyUrl);
        return;
      }
    }

    // Log direct connections to Telegram (so user can see proxy is NOT active)
    if (typeof url === 'string' && TELEGRAM_WS_PATTERN.test(url)) {
      const match = url.match(TELEGRAM_WS_PATTERN);
      proxyLog('dim', `🔌 Direct: ${match ? match[1] : url} (proxy disabled)`);
    }

    // Not a Telegram URL or proxy disabled — pass through
    super(url, protocols);
  }
}

// Override global WebSocket
window.WebSocket = ProxiedWebSocket;

// Also keep reference for debugging
window._OriginalWebSocket = _OriginalWebSocket;
