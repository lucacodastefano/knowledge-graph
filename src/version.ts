import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root: same depth from src/version.ts and from the built dist/version.js. */
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Installed package version; the stdio bridge compares it with the running daemon's. */
export const VERSION: string = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;

/** Numeric comparison of "x.y.z" versions (pre-release tags are ignored): <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => Number(n) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
