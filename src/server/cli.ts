#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite still prints an ExperimentalWarning on Node 22: hide it from users, keep every other warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const port = Number(process.env.KG_PORT ?? 7777);
const dbPath = process.env.KG_DB ?? join(homedir(), '.knowledge-graph', 'graph.db');
// Same depth from src/server/cli.ts and from the built dist/server/cli.js.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const webRoot = join(packageRoot, 'web', 'dist');

const usage = `Usage: knowledge-graph [command]

Commands:
  serve          start the daemon: canvas on http://localhost:${port}, MCP on /mcp (default)
  stdio          stdio bridge for MCP clients without HTTP support (starts the daemon if needed)
  install-skill  copy the Claude Code skill into ~/.claude/skills/knowledge-graph
  help, version

Environment: KG_PORT (default 7777), KG_DB (default ~/.knowledge-graph/graph.db)`;

async function serve() {
  // Loaded lazily so the warning filter above is in place before node:sqlite is imported.
  const { SqliteRepository } = await import('../core/sqlite-repository.ts');
  const { Tracker } = await import('../core/tracker.ts');
  const { buildApp } = await import('./app.ts');
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
else if (command === 'stdio') {
  const { runBridge } = await import('../bridge/stdio-bridge.ts');
  await runBridge(`http://127.0.0.1:${port}/mcp`);
} else if (command === 'install-skill') installSkill();
else if (command === 'version' || command === '--version' || command === '-v') {
  console.log(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version);
} else if (command === 'help' || command === '--help' || command === '-h') console.log(usage);
else {
  console.error(usage);
  process.exit(1);
}
