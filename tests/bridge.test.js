import { test, expect } from 'bun:test';
const { createBridge, newToken, tokenMatches } = require('../src/core/bridge.cjs');

test('a wrong token is refused, and length alone does not pass', () => {
  const token = newToken();
  expect(tokenMatches(token, token)).toBe(true);
  expect(tokenMatches(token, 'a'.repeat(token.length))).toBe(false);
  expect(tokenMatches(token, '')).toBe(false);
});

test('the bridge answers only with the token, and binds to loopback', async () => {
  const token = newToken();
  const bridge = createBridge({
    token: () => token,
    routes: { 'GET /status': async () => ({ body: { ok: true } }) }
  });
  const port = await bridge.listen(0);

  const denied = await fetch(`http://127.0.0.1:${port}/status`);
  expect(denied.status).toBe(401);

  const allowed = await fetch(`http://127.0.0.1:${port}/status`, {
    headers: { authorization: `Bearer ${token}` }
  });
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).ok).toBe(true);

  const unknown = await fetch(`http://127.0.0.1:${port}/nope`, {
    headers: { authorization: `Bearer ${token}` }
  });
  expect(unknown.status).toBe(404);

  await bridge.close();
});
