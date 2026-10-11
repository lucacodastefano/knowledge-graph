import { normalizeName } from './normalize.ts';

/** What kc_edit may change in a node's markdown detail without resending it. */
export interface DetailEdit {
  /** Exact fragment to replace; it must occur exactly once. */
  find?: string;
  /** Replacement for `find` ("" deletes it). */
  replace?: string;
  /** Markdown to add at the end of the detail, or at the end of the section named by `under`. */
  append?: string;
  under?: string;
}

export class DetailEditError extends Error {}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Applies a find/replace, then an append, to a detail; every failure says what to change in the call. */
export function applyDetailEdit(detail: string | null, edit: DetailEdit): string {
  let text = detail ?? '';
  if (edit.find !== undefined) {
    if (edit.replace === undefined) throw new DetailEditError('find needs replace ("" deletes the fragment)');
    if (!edit.find) throw new DetailEditError('find is empty');
    const parts = text.split(edit.find);
    if (parts.length === 1) throw new DetailEditError('find: text not found in the detail (it must match exactly)');
    if (parts.length > 2) throw new DetailEditError(`find: text occurs ${parts.length - 1} times, use a longer fragment that occurs once`);
    text = parts.join(edit.replace);
  } else if (edit.replace !== undefined) {
    throw new DetailEditError('replace needs find');
  }
  if (edit.under !== undefined && edit.append === undefined) throw new DetailEditError('under needs append');
  if (edit.append !== undefined) text = edit.under === undefined ? joinBlock(text, edit.append) : appendUnder(text, edit.under, edit.append);
  return text;
}

const joinBlock = (text: string, add: string) => (text.trim() ? `${text.replace(/\s+$/, '')}\n\n${add.trim()}` : add.trim());

/** Adds a block at the end of the section whose heading is `heading` (up to the next heading of the same or a higher level). */
function appendUnder(text: string, heading: string, add: string): string {
  const wanted = normalizeName(heading.replace(/^#+\s*/, ''));
  const lines = text.split('\n');
  const heads = lines.flatMap((line, i) => {
    const m = HEADING.exec(line);
    return m ? [{ i, level: m[1].length, title: m[2] }] : [];
  });
  const at = heads.findIndex((h) => normalizeName(h.title) === wanted);
  if (at < 0) {
    const known = heads.map((h) => h.title).slice(0, 12).join(', ');
    throw new DetailEditError(`under: heading "${heading}" not found${known ? ` (headings: ${known})` : ' (the detail has no headings)'}`);
  }
  const next = heads.slice(at + 1).find((h) => h.level <= heads[at].level);
  const end = next ? next.i : lines.length;
  const before = lines.slice(0, end).join('\n').replace(/\s+$/, '');
  const after = lines.slice(end).join('\n');
  return `${before}\n\n${add.trim()}${after ? `\n\n${after}` : ''}`;
}
