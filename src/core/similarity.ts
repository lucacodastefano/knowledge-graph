import { normalizeName } from './normalize.ts';

/** Articles, prepositions and conjunctions that do not change which concept a title names (Italian + English). */
const STOPWORDS = new Set(
  (
    'a ad al all allo alla ai agli alle d da dal dall dallo dalla dai dagli dalle de del dell dello della dei degli delle di e ed ' +
    'fra i il in l la le lo nel nell nello nella nei negli nelle per su sul sull sullo sulla sui sugli sulle tra un una uno ' +
    'an and for in of on the to with'
  ).split(' '),
);

/** Words that turn a title into a wrapper of another one: "Aspetti di X", "Overview of X". */
const WRAPPER_WORDS = new Set(
  (
    'aspetti aspetto panoramica introduzione intro fondamenti basi caratteristiche concetti elementi dettagli ' +
    'generale generali principali chiave cos cosa overview introduction aspects basics fundamentals features ' +
    'concepts elements details key main general what'
  ).split(' '),
);

/** Crude stem that folds singular/plural and gender: "diagrammi" = "diagramma", "systems" = "system". */
function stem(word: string): string {
  if (word.length <= 3) return word;
  const w = word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
  return w.length > 3 ? w.replace(/[aeiou]$/, '') : w;
}

/** The significant words of a title, stemmed. */
export function titleStems(title: string): string[] {
  return normalizeName(title)
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w))
    .map(stem);
}

/** Order-insensitive key: two titles with the same key name the same concept in different words. */
export function similarityKey(title: string): string {
  return [...new Set(titleStems(title))].sort().join(' ');
}

const subset = (a: string[], b: Set<string>) => a.length > 0 && a.every((w) => b.has(w));

/**
 * Whether a child title only restates its parent instead of naming a part of it (the "wrapper" node):
 * the same words ("Integrazione dei sistemi" under "Integrazione di sistemi"), a wrapper word around the parent
 * ("Aspetti dell'integrazione tra sistemi"), or, when `hasOwnChildren`, a part of the parent's own title that
 * takes over the whole branch ("Design Authority" under "Design Authority e governance").
 */
export function restatesParent(child: string, parent: string, hasOwnChildren: boolean): boolean {
  const parentStems = titleStems(parent);
  const p = new Set(parentStems);
  const words = normalizeName(child).split(' ').filter((w) => w && !STOPWORDS.has(w));
  const core = words.filter((w) => !WRAPPER_WORDS.has(w)).map(stem);
  if (core.length === 0) return false;
  if (core.toSorted().join(' ') === parentStems.toSorted().join(' ')) return true;
  if (core.length < words.length) return subset(core, p);
  return hasOwnChildren && subset(core, p);
}
