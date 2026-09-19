'use strict';

// The door the agent knocks on. The WhatsApp session can only exist once — it is
// a real browser holding a real linked device — so the session lives in the
// Electron process and everything else (the CLI, the MCP server, anything else
// written later) talks to it over this tiny HTTP server.
//
// It binds to 127.0.0.1 only and demands a bearer token that lives in a 0600
// file inside the app's own data directory. That is the whole authentication
// story, and it is enough: anything able to read that file is already running as
// the owner.

const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_PORT = 8799;

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function readBody(request, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

// Constant-time compare so a wrong token cannot be found one character at a time.
function tokenMatches(expected, given) {
  const a = Buffer.from(String(expected ?? ''));
  const b = Buffer.from(String(given ?? ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerOf(request) {
  const header = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : request.headers['x-herald-token'] || '';
}

function createBridge({ token, routes, onError }) {
  const server = http.createServer(async (request, response) => {
    const send = (status, payload) => {
      const body = JSON.stringify(payload ?? {});
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store'
      });
      response.end(body);
    };

    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const route = routes[`${request.method} ${url.pathname}`];
      if (!route) return send(404, { error: 'unknown_route', path: url.pathname });
      if (!tokenMatches(token(), bearerOf(request))) {
        return send(401, { error: 'bad_token' });
      }

      const query = Object.fromEntries(url.searchParams.entries());
      const body = request.method === 'POST' ? await readBody(request) : {};
      const result = await route({ ...query, ...body });
      send(result?.status || 200, result?.body ?? result ?? {});
    } catch (error) {
      if (onError) onError(error);
      // A route that threw because the session is not up is not a server fault;
      // the agent needs to hear "not connected", not "something broke".
      const offline = /not connected/i.test(error.message);
      send(offline ? 409 : 500, {
        error: offline ? 'not_connected' : 'failed',
        message: error.message
      });
    }
  });

  return {
    server,
    listen(port = DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createBridge, newToken, tokenMatches, DEFAULT_PORT };
