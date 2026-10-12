import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Returns the config text with mcpServers["knowledge-graph"] set to `entry`. Every other key and server is kept;
 * extra keys of an existing knowledge-graph entry survive. `raw` is null when the file does not exist yet.
 */
export function withServerEntry(raw: string | null, entry: ServerEntry): string {
  const text = raw?.replace(/^﻿/, '').trim();
  let config: Record<string, unknown> = {};
  if (text) {
    try {
      config = JSON.parse(text);
    } catch (err) {
      throw new Error(`claude_desktop_config.json is not valid JSON, left untouched (${(err as Error).message})`);
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('claude_desktop_config.json is not a JSON object, left untouched');
  }
  const servers = (config.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
  servers['knowledge-graph'] = { ...servers['knowledge-graph'], ...entry };
  config.mcpServers = servers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Candidate config files: the standard one, plus the Microsoft Store install of Claude Desktop if present. */
export function claudeConfigPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const appData = env.APPDATA;
  if (!appData) return [];
  const paths = [join(appData, 'Claude', 'claude_desktop_config.json')];
  const packages = env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Packages');
  if (packages && existsSync(packages)) {
    for (const name of readdirSync(packages).filter((n) => n.startsWith('Claude_'))) {
      paths.push(join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    }
  }
  return paths;
}

/**
 * Writes the entry into each existing config file (backup first); creates the standard file when none exists.
 * Returns the files written, with the backup made next to each.
 */
export function configureClaude(paths: string[], entry: ServerEntry, now = new Date()): { file: string; backup?: string }[] {
  const existing = paths.filter((p) => existsSync(p));
  const targets = existing.length ? existing : paths.slice(0, 1);
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const results = targets.map((file) => {
    const next = withServerEntry(existsSync(file) ? readFileSync(file, 'utf8') : null, entry);
    return { file, next };
  });
  return results.map(({ file, next }) => {
    let backup: string | undefined;
    if (existsSync(file)) {
      backup = `${file}.bak-${stamp}`;
      copyFileSync(file, backup);
    } else mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
    return { file, backup };
  });
}
