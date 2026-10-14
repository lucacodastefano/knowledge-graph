/**
 * Models sometimes send a node's markdown with its line breaks lost, so a table or a list arrives glued onto one line
 * and shows as raw `|` and `|---|`. This rebuilds the ones it can recognise with confidence and leaves everything else
 * (code blocks, tables already on separate lines, ordinary prose) untouched. Idempotent.
 */

const SEP = /\|[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|/;
const cellsOf = (s: string) => s.split('|');

/** `intro | H1 | H2 | |---|---| | a | b | | c | d |` → intro, blank line, header, separator, rows; null when unsure. */
function repairTableLine(line: string): string[] | null {
  const m = SEP.exec(line);
  if (!m || line.trim() === m[0]) return null;
  const cols = m[0].split('|').length - 2;
  const before = line.slice(0, m.index);
  const after = line.slice(m.index + m[0].length);
  const out: string[] = [];
  let header: string[] | null = null;
  if (before.trim()) {
    const parts = cellsOf(before);
    while (parts.length && !parts[parts.length - 1].trim()) parts.pop();
    if (parts.length < cols) return null;
    header = parts.splice(parts.length - cols, cols).map((c) => c.trim());
    const intro = parts.join('|').trim();
    if (intro) out.push(intro, '');
  }
  if (header) out.push(`| ${header.join(' | ')} |`);
  out.push(m[0].replace(/[ \t]+/g, ''));
  const tokens = cellsOf(after.trim().replace(/^\|/, ''));
  if (tokens.length && !tokens[tokens.length - 1].trim()) tokens.pop();
  if (tokens.length === 0) return out;
  // Rows are `cols` cells, with an empty token (the "| |" between two rows) after each but the last.
  for (let i = 0; i < tokens.length; ) {
    const row = tokens.slice(i, i + cols);
    if (row.length < cols) return null;
    out.push(`| ${row.map((c) => c.trim()).join(' | ')} |`);
    i += cols;
    if (i < tokens.length) {
      if (tokens[i].trim()) return null;
      i += 1;
    }
  }
  return out;
}

/** `intro: 1. a 2. b 3. c` and `intro: - a - b - c` → one item per line. Needs at least 2 numbered or 3 bulleted items. */
function repairListLine(line: string): string[] | null {
  if (/^\s*\|/.test(line)) return null;
  const nums = [...line.matchAll(/(?:^|(?<=[\s:.;]))(\d{1,2})\.[ \t]+(?=\S)/g)];
  let n = 1;
  const run: RegExpMatchArray[] = [];
  for (const m of nums) if (Number(m[1]) === n) (run.push(m), n++);
  if (run.length >= 2 && Number(run[0][1]) === 1 && run.length === nums.length) {
    const first = run[0].index!;
    const out = first > 0 && line.slice(0, first).trim() ? [line.slice(0, first).trim()] : [];
    if (out.length === 0 && first === 0 && run.length === 2 && line.length < 30) return null;
    run.forEach((m, i) => out.push(`${m[1]}. ${line.slice(m.index! + m[0].length, run[i + 1]?.index).trim()}`));
    return out;
  }
  const bullets = [...line.matchAll(/(?<=:[ \t]|^)- (?=\S)|(?<=\S[ \t])- (?=\S)/g)];
  const first = bullets[0];
  if (first && bullets.length >= 3 && (first.index === 0 || /:\s$/.test(line.slice(0, first.index)))) {
    const out = first.index! > 0 ? [line.slice(0, first.index).trim()] : [];
    bullets.forEach((m, i) => out.push(`- ${line.slice(m.index! + 2, bullets[i + 1]?.index).trim()}`));
    return out;
  }
  return null;
}

export function repairMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      out.push(line);
      continue;
    }
    const fixed = fence ? null : repairTableLine(line) ?? repairListLine(line);
    if (!fixed) {
      out.push(line);
      continue;
    }
    if (out.length && out[out.length - 1].trim() && fixed[0] !== '') out.push('');
    out.push(...fixed);
  }
  return out.join('\n');
}
