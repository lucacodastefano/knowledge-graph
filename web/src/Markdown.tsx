import type { ReactNode } from 'react';

/**
 * Small markdown renderer for the model's detail text (headings, bold, italic, strikethrough, nested lists, tables,
 * quotes as callouts, inline code, code blocks, links, rules). It builds React elements only: raw HTML from the
 * model is shown as text and links are limited to http(s) and mailto.
 */

const safeHref = (url: string) => (/^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : null);

/** Inline markdown: `code`, **bold**, *italic*, ~~strike~~, [text](url); emphasis nests. */
function inline(text: string, keyBase = ''): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}${m.index}`;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={key}>{inline(m[2] ?? m[3], `${key}.`)}</strong>);
    else if (m[4] !== undefined) out.push(<del key={key}>{inline(m[4], `${key}.`)}</del>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={key}>{inline(m[5] ?? m[6], `${key}.`)}</em>);
    else {
      const href = safeHref(m[8]);
      out.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{inline(m[7], `${key}.`)}</a> : m[0]);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isTableSep = (line: string | undefined) => !!line && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const align = (sep: string): 'left' | 'center' | 'right' | undefined => {
  const t = sep.trim();
  if (t.startsWith(':') && t.endsWith(':')) return 'center';
  if (t.endsWith(':')) return 'right';
  return undefined;
};
const listItem = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
const heading = /^(#{1,6})\s+(.*)$/;

interface Item {
  text: string;
  ordered: boolean;
  children: Item[];
}

/** Nested lists by indentation: a deeper item belongs to the item above it. */
function listTree(lines: string[]): Item[] {
  const root: { indent: number; children: Item[] }[] = [{ indent: -1, children: [] }];
  const stack: { indent: number; item: Item | null; children: Item[] }[] = [{ indent: -1, item: null, children: root[0].children }];
  for (const line of lines) {
    const m = line.match(listItem);
    if (!m) {
      const top = stack[stack.length - 1].item;
      if (top) top.text += ` ${line.trim()}`;
      continue;
    }
    const indent = m[1].replace(/\t/g, '    ').length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const item: Item = { text: m[3], ordered: /\d/.test(m[2]), children: [] };
    stack[stack.length - 1].children.push(item);
    stack.push({ indent, item, children: item.children });
  }
  return root[0].children;
}

function ListView({ items }: { items: Item[] }) {
  const L = items[0]?.ordered ? 'ol' : 'ul';
  return (
    <L>
      {items.map((it, i) => (
        <li key={i}>
          {inline(it.text)}
          {it.children.length > 0 && <ListView items={it.children} />}
        </li>
      ))}
    </L>
  );
}

function blocksOf(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = blocks.length;
    if (!line.trim()) {
      i++;
    } else if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>);
    } else if (heading.test(line)) {
      const m = line.match(heading)!;
      const H = (m[1].length <= 2 ? 'h4' : m[1].length === 3 ? 'h5' : 'h6') as 'h4' | 'h5' | 'h6';
      blocks.push(<H key={key}>{inline(m[2].replace(/\s*#+\s*$/, ''))}</H>);
      i++;
    } else if (rule.test(line) && !listItem.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
    } else if (line.includes('|') && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map(align);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push(
        <div className="table-wrap" key={key}>
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j} style={{ textAlign: aligns[j] }}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>{head.map((_, k) => <td key={k} style={{ textAlign: aligns[k] }}>{inline(r[k] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (listItem.test(line)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim() && (listItem.test(lines[i]) || /^\s+\S/.test(lines[i]))) items.push(lines[i++]);
      blocks.push(<ListView key={key} items={listTree(items)} />);
    } else if (line.trimStart().startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key} className="callout">{blocksOf(quote.join('\n'))}</blockquote>);
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|>)/.test(lines[i]) && !heading.test(lines[i]) && !listItem.test(lines[i]) && !rule.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      blocks.push(<p key={key}>{inline(para.join(' '))}</p>);
    }
  }
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{blocksOf(text)}</div>;
}
