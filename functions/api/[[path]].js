/**
 * Cloudflare Pages Function — Telegram API Proxy
 * 
 * Routes:  /api/<telegram-dc-host>/<path>
 * Example: /api/pluto.web.telegram.org/apiws
 * 
 * Supports both HTTP and WebSocket proxying.
 */

export async function onRequest(context) {
  const { request, params } = context;
  
  const pathSegments = params.path;
  if (!pathSegments || pathSegments.length < 1) {
    return new Response('Missing target host', { status: 400 });
  }

  const targetHost = pathSegments[0];
  
  // Validate Telegram domain
  const allowedPattern = /^[a-z0-9\-]+\.(?:web\.)?telegram\.org$/i;
  if (!allowedPattern.test(targetHost)) {
    return new Response('Forbidden: not a Telegram domain', { status: 403 });
  }

  const remainingPath = pathSegments.slice(1).join('/');
  const targetUrl = `https://${targetHost}/${remainingPath}`;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  // WebSocket upgrade
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
    try {
      // Create upstream fetch with WebSocket upgrade
      const upstreamResp = await fetch(`https://${targetHost}/${remainingPath}`, {
        headers: {
          'Upgrade': 'websocket',
        },
      });

      // Check if upstream supports WebSocket
      if (upstreamResp.webSocket) {
        // Bridge: create a pair for the client, pipe to upstream
        const upstream = upstreamResp.webSocket;
        const pair = new WebSocketPair();
        const [clientWs, serverWs] = Object.values(pair);

        upstream.accept();
        serverWs.accept();

        // Bidirectional data pipe
        upstream.addEventListener('message', e => {
          try { serverWs.send(e.data); } catch {}
        });
        serverWs.addEventListener('message', e => {
          try { upstream.send(e.data); } catch {}
        });

        // Bidirectional close pipe
        upstream.addEventListener('close', e => {
          try { serverWs.close(e.code || 1000, e.reason || ''); } catch {}
        });
        serverWs.addEventListener('close', e => {
          try { upstream.close(e.code || 1000, e.reason || ''); } catch {}
        });

        // Error handling
        upstream.addEventListener('error', () => {
          try { serverWs.close(1011, 'upstream error'); } catch {}
        });
        serverWs.addEventListener('error', () => {
          try { upstream.close(1011, 'client error'); } catch {}
        });

        return new Response(null, { status: 101, webSocket: clientWs });
      }

      // If no webSocket in response, return error info for debugging
      const body = await upstreamResp.text();
      return new Response(`WS upgrade failed. Status: ${upstreamResp.status}. Body: ${body.substring(0, 200)}`, { 
        status: 502,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });

    } catch (err) {
      return new Response(`WS Proxy error: ${err.message}\nStack: ${err.stack}`, { 
        status: 502,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  // Regular HTTP proxy
  try {
    const proxyHeaders = new Headers();
    proxyHeaders.set('Host', targetHost);
    // Copy relevant headers from original request
    for (const [key, val] of request.headers.entries()) {
      if (!key.startsWith('cf-') && key !== 'host') {
        proxyHeaders.set(key, val);
      }
    }
    proxyHeaders.set('Host', targetHost);

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502 });
  }
}
