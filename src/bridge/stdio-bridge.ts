import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function isUp(base: string): Promise<boolean> {
  try {
    return (await fetch(new URL('/api/health', base))).ok;
  } catch {
    return false;
  }
}

/** Starts the daemon in the background if it is not already running. */
async function ensureDaemon(mcpUrl: string): Promise<void> {
  if (await isUp(mcpUrl)) return;
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'serve'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await isUp(mcpUrl)) return;
  }
  throw new Error(`knowledge-graph daemon did not start at ${mcpUrl}`);
}

/** For MCP clients that only speak stdio: relays every message to the daemon over HTTP. */
export async function runBridge(mcpUrl: string): Promise<void> {
  await ensureDaemon(mcpUrl);
  const local = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL(mcpUrl));

  local.onmessage = (msg) => void remote.send(msg).catch((err) => console.error('bridge send failed:', err));
  remote.onmessage = (msg) => void local.send(msg);
  remote.onerror = (err) => console.error('bridge:', err);
  local.onclose = () => void remote.close();
  remote.onclose = () => void local.close();

  await remote.start();
  await local.start();
}
