/**
 * Cloudflare Pages Function — Telegram API Proxy
 * 
 * Routes:  /api/<telegram-dc-host>/<path>
 * Example: /api/pluto.web.telegram.org/apiws
 * 
 * Supports both HTTP and WebSocket proxying.
 * WebSocket: Creates a pair, connects to Telegram, pipes data bidirectionally.
 */

export async function onRequest(context) {
  const { request, params } = context;
  
  const pathSegments = params.path;
  if (!pathSegments || pathSegments.length < 1) {
    return new Response('Missing target host', { status: 400 });
  }

  // First segment is the target Telegram host
  const targetHost = pathSegments[0];
  
  // Validate it's a Telegram domain
  const allowedPattern = /^[a-z0-9\-]+\.(?:web\.)?telegram\.org$/i;
  if (!allowedPattern.test(targetHost)) {
    return new Response('Forbidden: not a Telegram domain', { status: 403 });
  }

  // Remaining path
  const remainingPath = pathSegments.slice(1).join('/');

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  // Handle WebSocket upgrade
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
    return handleWebSocket(targetHost, remainingPath);
  }

  // Regular HTTP proxy
  const targetUrl = `https://${targetHost}/${remainingPath}`;
  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set('Host', targetHost);
  proxyHeaders.delete('cf-connecting-ip');
  proxyHeaders.delete('cf-ipcountry');
  proxyHeaders.delete('cf-ray');
  proxyHeaders.delete('cf-visitor');

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502 });
  }
}

/**
 * Handle WebSocket proxy using Cloudflare's WebSocket API.
 * Creates a client-facing WebSocket pair and connects upstream to Telegram.
 */
async function handleWebSocket(targetHost, path) {
  // Create the WebSocket pair for the client
  const [client, server] = Object.values(new WebSocketPair());

  // Connect to the actual Telegram server
  const targetUrl = `wss://${targetHost}:443/${path}`;
  
  try {
    const upstreamResponse = await fetch(targetUrl, {
      headers: {
        'Upgrade': 'websocket',
      },
    });

    const upstream = upstreamResponse.webSocket;
    if (!upstream) {
      server.accept();
      server.close(1011, 'Failed to establish upstream WebSocket');
      return new Response('WebSocket upgrade failed', { status: 502 });
    }

    upstream.accept();
    server.accept();

    // Pipe upstream → client
    upstream.addEventListener('message', (event) => {
      try {
        server.send(event.data);
      } catch {}
    });

    upstream.addEventListener('close', (event) => {
      try {
        server.close(event.code || 1000, event.reason || 'upstream closed');
      } catch {}
    });

    upstream.addEventListener('error', () => {
      try {
        server.close(1011, 'upstream error');
      } catch {}
    });

    // Pipe client → upstream
    server.addEventListener('message', (event) => {
      try {
        upstream.send(event.data);
      } catch {}
    });

    server.addEventListener('close', (event) => {
      try {
        upstream.close(event.code || 1000, event.reason || 'client closed');
      } catch {}
    });

    server.addEventListener('error', () => {
      try {
        upstream.close(1011, 'client error');
      } catch {}
    });

  } catch (err) {
    server.accept();
    server.close(1011, `Upstream connection failed: ${err.message}`);
  }

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
