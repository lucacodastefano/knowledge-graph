import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeConfigPaths, configureClaude, withServerEntry } from '../src/server/claude-config.ts';

const entry = { command: 'C:\\kg\\runtime\\node.exe', args: ['C:\\kg\\app\\dist\\server\\cli.js', 'stdio'], env: { KG_DB: 'C:\\kg\\data\\graph.db' } };

test('creates the config when missing', () => {
  const out = JSON.parse(withServerEntry(null, entry));
  assert.deepEqual(out.mcpServers['knowledge-graph'], entry);
});

test('keeps other keys and servers, updates our entry, tolerates a BOM', () => {
  const raw = `\uFEFF${JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' }, 'knowledge-graph': { command: 'npx', args: ['-y'], custom: 1 } } })}`;
  const out = JSON.parse(withServerEntry(raw, entry));
  assert.equal(out.theme, 'dark');
  assert.deepEqual(out.mcpServers.other, { command: 'x' });
  assert.deepEqual(out.mcpServers['knowledge-graph'], { ...entry, custom: 1 });
});

test('refuses invalid JSON without touching the file', () => {
  assert.throws(() => withServerEntry('{ nope', entry), /not valid JSON/);
  assert.throws(() => withServerEntry('[]', entry), /not a JSON object/);
});

test('configureClaude backs up the existing file and writes only existing targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-cfg-'));
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');
  writeFileSync(a, '{"mcpServers":{"other":{"command":"x"}}}');
  const done = configureClaude([a, b], entry, new Date('2026-10-12T07:00:00Z'));
  assert.equal(done.length, 1);
  assert.equal(readFileSync(done[0].backup!, 'utf8'), '{"mcpServers":{"other":{"command":"x"}}}');
  assert.ok(JSON.parse(readFileSync(a, 'utf8')).mcpServers.other);
  assert.equal(readdirSync(dir).length, 2);
});

test('configureClaude creates the first path when none exists; invalid file aborts before any write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-cfg-'));
  const a = join(dir, 'sub', 'a.json');
  assert.equal(configureClaude([a], entry).length, 1);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, 'oops');
  assert.throws(() => configureClaude([a, bad], entry));
  assert.equal(readdirSync(dir).filter((f) => f.includes('bak')).length, 0);
});

test('claudeConfigPaths needs APPDATA and adds Store installs', () => {
  assert.deepEqual(claudeConfigPaths({}), []);
  const local = mkdtempSync(join(tmpdir(), 'kg-local-'));
  assert.equal(claudeConfigPaths({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming', LOCALAPPDATA: local }).length, 1);
});
