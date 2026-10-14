import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { buildApp } from '../src/server/app.ts';

const TOKEN = 'secret-token-123';
const app = await buildApp({ tracker: new Tracker(new SqliteRepository(':memory:')), token: TOKEN });

test('hosted mode rejects requests without the token, except the health probe', async () => {
  assert.equal((await app.inject('/api/conversations')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/conversations', headers: { authorization: 'Bearer nope' } })).statusCode, 401);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
});

test('token accepted as Bearer header, cookie, /t/<token> prefix or ?token= (which sets the cookie)', async () => {
  assert.equal((await app.inject({ url: '/api/conversations', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/conversations', headers: { cookie: `kg_token=${TOKEN}` } })).statusCode, 200);
  assert.equal((await app.inject(`/t/${TOKEN}/api/conversations`)).statusCode, 200);
  assert.equal((await app.inject('/t/wrong/api/conversations')).statusCode, 401);
  const api = await app.inject(`/api/conversations?token=${TOKEN}`);
  assert.equal(api.statusCode, 200);
  assert.match(String(api.headers['set-cookie']), /kg_token=.*HttpOnly.*Secure.*SameSite=Lax/);
  // Opening the canvas link: a 200 page (no redirect) that sets the cookie and moves to the clean URL.
  const page = await app.inject(`/?token=${TOKEN}&x=1`);
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['set-cookie']), /SameSite=Lax/);
  assert.match(page.body, /location\.replace\("\/\?x=1"\)/);
  assert.doesNotMatch(page.body, /replace\("[^"]*token/);
});

test('MCP initialize works through the secret URL', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/t/${TOKEN}/mcp`,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
  });
  assert.equal(res.statusCode, 200);
});

test('same-host origins are allowed in hosted mode, foreign ones are not', async () => {
  const h = { authorization: `Bearer ${TOKEN}`, host: 'kg.example.com' };
  assert.equal((await app.inject({ url: '/api/conversations', headers: { ...h, origin: 'https://kg.example.com' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/conversations', headers: { ...h, origin: 'https://evil.com' } })).statusCode, 403);
});
