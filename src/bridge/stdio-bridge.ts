import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { compareVersions, VERSION } from '../version.ts';

/** What /api/health answers. Daemons before 0.1.x versioning answer only `{ ok: true }`. */
interface Health {
  ok: boolean;
  version?: string;
  pid?: number;
}

async function health(base: string): Promise<Health | null> {
  try {
    const res = await fetch(new URL('/api/health', base));
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

async function waitFor(base: string, up: boolean, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await health(base) !== null) === up) return true;
    await sleep(100);
  }
  return false;
}

/** The process listening on a local port, for daemons too old to report their pid. */
async function pidListeningOn(port: string): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)('netstat', ['-ano', '-p', 'TCP']);
      const line = stdout.split('\n').find((l) => l.includes(`:${port} `) && l.includes('LISTENING'));
      return Number(line?.trim().split(/\s+/).at(-1)) || undefined;
    }
    const { stdout } = await promisify(execFile)('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    return Number(stdout.split('\n')[0]) || undefined;
  } catch {
    return undefined;
  }
}

/** Stops an older daemon: graceful shutdown endpoint first, then a signal to its pid. */
async function stopDaemon(base: string, h: Health): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/shutdown', base), { method: 'POST' });
    if (res.ok && (await waitFor(base, false, 50))) return true;
  } catch {
    // Too old to have the endpoint, or already gone.
  }
  const pid = h.pid ?? (await pidListeningOn(new URL(base).port || '80'));
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !(await health(base));
  }
  return waitFor(base, false, 50);
}

function startDaemon(): void {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'serve'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

export interface EnsureDaemonOptions {
  /** Version of this bridge (the installed package). */
  version?: string;
  start?: () => void;
}

/**
 * Makes sure a daemon of this version (or newer) answers at mcpUrl: starts one if none runs, and replaces an
 * older one, e.g. left running by the previous install after an update. A newer daemon is kept as it is.
 */
export async function ensureDaemon(mcpUrl: string, { version = VERSION, start = startDaemon }: EnsureDaemonOptions = {}): Promise<void> {
  const running = await health(mcpUrl);
  if (running) {
    if (running.version && compareVersions(running.version, version) >= 0) return;
    console.error(`knowledge-graph: replacing the daemon ${running.version ?? '(old)'} with ${version}`);
    if (!(await stopDaemon(mcpUrl, running))) {
      console.error('knowledge-graph: could not stop the old daemon, using it; stop it by hand to update');
      return;
    }
  }
  start();
  if (!(await waitFor(mcpUrl, true, 50))) throw new Error(`knowledge-graph daemon did not start at ${mcpUrl}`);
}

/** For MCP clients that only speak stdio: relays every message to the daemon over HTTP. */
export async function runBridge(mcpUrl: string): Promise<void> {
  await ensureDaemon(mcpUrl);
  const local = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL(mcpUrl));

  // Server notifications (e.g. tools/list_changed when the canvas settings change) arrive on the stream the
  // HTTP transport opens after `notifications/initialized`, and are relayed like every other message.
  local.onmessage = (msg) => void remote.send(msg).catch((err) => console.error('bridge send failed:', err));
  remote.onmessage = (msg) => void local.send(msg);
  remote.onerror = (err) => console.error('bridge:', err);
  local.onclose = () => void remote.close();
  remote.onclose = () => void local.close();

  await remote.start();
  await local.start();
}
