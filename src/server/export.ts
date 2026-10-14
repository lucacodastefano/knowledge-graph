import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MapSnapshot } from '../core/reader.ts';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** File name for a map: ASCII letters, digits and dashes. */
export function exportFileName(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'grafo'}.html`;
}

/**
 * The built canvas (web/dist/index.html) as ONE file: script and stylesheet inlined, the snapshot of the map embedded
 * for the canvas to read instead of calling the daemon (D23). Replacements use functions so `$` in the code is literal.
 */
export function renderExport(webRoot: string, snapshot: MapSnapshot): string {
  const indexPath = join(webRoot, 'index.html');
  if (!existsSync(indexPath)) throw new Error('The canvas is not built: run "npm run build:web"');
  const read = (src: string) => readFileSync(join(webRoot, src.replace(/^\/+/, '')), 'utf8');
  // `<` is escaped so neither "</script" nor "<!--" can end or confuse the embedded JSON.
  const data = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  return readFileSync(indexPath, 'utf8')
    .replace(/<title>.*?<\/title>/, () => `<title>${escapeHtml(snapshot.tree.conversation.title)}</title>`)
    .replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/, (_, src: string) => `<script type="module">${read(src).replace(/<\/script/gi, '<\\/script')}</script>`)
    .replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/, (_, href: string) => `<style>${read(href).replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<div id="root">', () => `<script type="application/json" id="kg-snapshot">${data}</script>\n    <div id="root">`);
}
