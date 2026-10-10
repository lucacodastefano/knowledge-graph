#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteRepository } from '../core/sqlite-repository.ts';
import { Tracker } from '../core/tracker.ts';
import { buildApp } from './app.ts';
import { runBridge } from '../bridge/stdio-bridge.ts';

const port = Number(process.env.KG_PORT ?? 7777);
const dbPath = process.env.KG_DB ?? join(homedir(), '.knowledge-graph', 'graph.db');
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

async function serve() {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tracker = new Tracker(new SqliteRepository(dbPath));
  const app = await buildApp({ tracker, webRoot });
  await app.listen({ host: '127.0.0.1', port });
  console.error(`knowledge-graph: canvas http://localhost:${port}  MCP http://localhost:${port}/mcp  db ${dbPath}`);
}

const command = process.argv[2] ?? 'serve';
if (command === 'serve') await serve();
else if (command === 'stdio') await runBridge(`http://127.0.0.1:${port}/mcp`);
else {
  console.error('Usage: knowledge-graph [serve|stdio]');
  process.exit(1);
}
