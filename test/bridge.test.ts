import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { buildApp } from '../src/server/app.ts';
import { ensureDaemon } from '../src/bridge/stdio-bridge.ts';
import { compareVersions, VERSION } from '../src/version.ts';

/** A daemon on the given port (0 = any); `shutdowns` counts calls to POST /api/shutdown. */
async function daemon(port = 0) {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const counter = { shutdowns: 0 };
  let app: FastifyInstance;
  app = await buildApp({
    tracker,
    onShutdown: () => {
      counter.shutdowns++;
      void app.close();
    },
  });
  const base = await app.listen({ host: '127.0.0.1', port });
  return { app, tracker, base, port: Number(new URL(base).port), counter };
}

test('health reports version and pid; versions compare numerically', async () => {
  const d = await daemon();
  try {
    assert.deepEqual(await (await fetch(new URL('/api/health', d.base))).json(), { ok: true, version: VERSION, pid: process.pid });
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
    assert.equal(compareVersions('1.2.0', '1.2'), 0);
    // Cross-site pages cannot stop the daemon.
    const evil = await fetch(new URL('/api/shutdown', d.base), { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(d.counter.shutdowns, 0);
  } finally {
    await d.app.close();
  }
});

test('the bridge keeps a daemon of its version or newer, and replaces an older one', async () => {
  const old = await daemon();
  const url = `${old.base}/mcp`;
  let started = 0;
  let replacement: ReturnType<typeof daemon> | undefined;
  const start = () => {
    started++;
    replacement = daemon(old.port);
  };
  try {
    await ensureDaemon(url, { version: VERSION, start });
    await ensureDaemon(url, { version: '0.0.1', start });
    assert.equal(started, 0);
    assert.equal(old.counter.shutdowns, 0);

    await ensureDaemon(url, { version: '99.0.0', start });
    assert.equal(old.counter.shutdowns, 1);
    assert.equal(started, 1);
    assert.ok(await replacement);
    assert.equal((await (await fetch(new URL('/api/health', old.base))).json()).ok, true);
  } finally {
    await old.app.close();
    await (await replacement)?.app.close();
  }
});

test('the stdio bridge relays tools/list_changed when the canvas toggles detail', async () => {
  const d = await daemon();
  const root = fileURLToPath(new URL('..', import.meta.url));
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const changed = new Promise<void>((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', 'src/server/cli.ts', 'stdio'],
        cwd: root,
        env: { ...process.env, KG_PORT: String(d.port) } as Record<string, string>,
        stderr: 'ignore',
      }),
    );
    const tools = async () => JSON.stringify((await client.listTools()).tools.find((t) => t.name === 'kc_track')!.inputSchema);
    assert.ok(!(await tools()).includes('detail'));
    await new Promise((r) => setTimeout(r, 200)); // the daemon's notification stream opens after initialization
    d.tracker.updateSettings({ detail: true });
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('no tools/list_changed')), 3000))]);
    assert.ok((await tools()).includes('detail'));
  } finally {
    await client.close();
    await d.app.close();
  }
});
