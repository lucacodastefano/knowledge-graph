import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Tracker } from '../core/tracker.ts';
import type { McpSessionState } from './mcp.ts';

/** Tools whose result says whether the graph had something to give back (memory reuse metric). */
const HIT_TOOLS = new Set(['kc_recall', 'kc_read']);

const resultText = (r: CallToolResult | undefined) => (r?.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');

/** Whether a kc_recall / kc_read result carried something: a non-empty list, or any text that is not an error. */
function hasContent(tool: string, r: CallToolResult): boolean {
  if (r.isError) return false;
  if (tool !== 'kc_recall') return true;
  try {
    const parsed: unknown = JSON.parse(resultText(r));
    return !Array.isArray(parsed) || parsed.length > 0;
  } catch {
    return true;
  }
}

/**
 * The one place where tool calls are logged: wraps every tool registered on this server, so a new tool is
 * measured without touching its code. Logging never breaks a call.
 */
export function meterTools(server: McpServer, tracker: Tracker, state: McpSessionState): void {
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...a: unknown[]) => unknown) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) =>
    register(name, config, (...args: unknown[]) => {
      const before = safe(() => tracker.repo.counters());
      const started = performance.now();
      const finish = (result: CallToolResult | undefined, thrown?: unknown) => {
        safe(() => {
          const after = tracker.repo.counters();
          const input = (config as { inputSchema?: unknown }).inputSchema ? args[0] : {};
          const ok = !thrown && !result?.isError;
          tracker.repo.recordToolCall({
            at: new Date().toISOString(),
            tool: name,
            conversationId: state.conversationId,
            argChars: JSON.stringify(input ?? {}).length,
            resultChars: resultText(result).length,
            durationMs: Math.round(performance.now() - started),
            ok,
            error: ok ? null : (thrown instanceof Error ? thrown.message : resultText(result)).slice(0, 300),
            nodesCreated: before ? Math.max(0, after.visits - before.visits) : 0,
            nodesChanged: before ? Math.max(0, after.revisions - before.revisions) : 0,
            hit: HIT_TOOLS.has(name) ? !!result && ok && hasContent(name, result) : null,
          });
        });
      };
      try {
        const out = cb(...args);
        if (out instanceof Promise) {
          return out.then(
            (r) => (finish(r as CallToolResult), r),
            (e) => (finish(undefined, e), Promise.reject(e)),
          );
        }
        finish(out as CallToolResult);
        return out;
      } catch (e) {
        finish(undefined, e);
        throw e;
      }
    });
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
