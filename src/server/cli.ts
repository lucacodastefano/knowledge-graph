#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteRepository } from '../core/sqlite-repository.ts';
import { Tracker } from '../core/tracker.ts';
import { buildApp } from './app.ts';
import { runBridge } from '../bridge/stdio-bridge.ts';

const port = Number(process.env.KG_PORT ?? 7777);
const dbPath = process.env.KG_DB ?? join(homedir(), '.knowledge-graph', 'graph.db');
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const webRoot = join(packageRoot, 'web', 'dist');

async function serve() {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tracker = new Tracker(new SqliteRepository(dbPath));
  const app = await buildApp({ tracker, webRoot });
  await app.listen({ host: '127.0.0.1', port });
  console.error(`knowledge-graph: canvas http://localhost:${port}  MCP http://localhost:${port}/mcp  db ${dbPath}`);
}

/** Copies the Claude Code skill into the user's skills folder. */
function installSkill() {
  const target = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills', 'knowledge-graph');
  mkdirSync(target, { recursive: true });
  copyFileSync(join(packageRoot, 'skills', 'knowledge-graph', 'SKILL.md'), join(target, 'SKILL.md'));
  console.error(`knowledge-graph: skill installed in ${target}`);
}

const command = process.argv[2] ?? 'serve';
if (command === 'serve') await serve();
else if (command === 'stdio') await runBridge(`http://127.0.0.1:${port}/mcp`);
else if (command === 'install-skill') installSkill();
else {
  console.error('Usage: knowledge-graph [serve|stdio|install-skill]');
  process.exit(1);
}
