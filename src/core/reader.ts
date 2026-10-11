import type { Repository } from './repository.ts';
import type { Concept, ConceptMatch, ConceptPage, ConceptSection, GroupSuggestion, TextHit, Visit } from './types.ts';
import { normalizeName } from './normalize.ts';
import { TrackerError } from './tracker.ts';
import { sharesEnough, titleStems } from './similarity.ts';

/** What the user already knows about a concept (RF8). Kept compact: it is sent to the model. */
export interface RecalledConcept {
  id: string;
  name: string;
  /** How many times it was explored, across all conversations. */
  seen: number;
  /** Date (YYYY-MM-DD) of the last time it came up. */
  last: string;
  /** Most recent distinct summaries of what was explained. */
  notes: string[];
  /** True when only a summary exists: no deeper detail and no sub-concepts yet ("superficiale"). */
  thin?: boolean;
  /** Concepts explored right before or after it. */
  near: string[];
  /** Known sources (URLs), newest first; only when there are some. */
  sources?: string[];
  /** The superclass it sits under, when it has one. */
  in?: string;
  /** Free relations, as "name" or "name (label)". */
  rel?: string[];
  /** For a superclass: the concepts it groups. */
  members?: string[];
}

export interface Profile {
  concepts: number;
  /** Most explored concepts, as "name ×visits". */
  top: string[];
  recent: string[];
  /** Superclasses with how many concepts they group. */
  groups: string[];
  /** Topics not under any superclass yet: candidates when the user asks to tidy the graph (kc_relate). */
  ungrouped: string[];
  conversations: { id: string; title: string; last: string; nodes: number }[];
}

const RECALL_LIMIT = 5;
const NOTES_PER_CONCEPT = 3;
const NEAR_PER_CONCEPT = 5;
const NOTE_MAX = 300;
/** Sources returned by kc_recall per concept: enough to reuse, few tokens. */
const RECALL_SOURCES = 3;
const PROFILE_LIMIT = 10;
const PROFILE_GROUPS = 20;
/** Caps of the kc_start memory profile (D19): about 150 tokens. */
const MEMORY_AREAS = 5;
const MEMORY_TOPICS = 6;
const PROFILE_CONVERSATIONS = 5;
const SEARCH_LIMIT = 20;
const TEXT_HITS = 30;
/** Outline nodes shown at once (about 1,000 tokens): a bigger map is shown down to the depth that fits, branches opened on request. */
export const TREE_MAX_NODES = 150;
/** kc_tree shows only the top two levels of a map bigger than this, to orient before drilling down. */
const ORIENT_MIN_NODES = 40;
const SIMILAR_MAPS = 3;

const MEMBERS_SHOWN = 8;
const UNGROUPED_SHOWN = 15;
const SUGGESTION_MAX = 12;
const IGNORED_KEY = 'groupIgnored';

/** Superclass, relations and members of a concept, only the ones that exist (tokens). */
function extras(repo: Repository, id: string): Pick<RecalledConcept, 'in' | 'rel' | 'members'> {
  const up = repo.getSuperclass(id);
  const rel = repo.listRelated(id).map((r) => (r.label ? `${r.name} (${r.label})` : r.name));
  const members = repo.listMembers(id).map((m) => m.name);
  return {
    ...(up ? { in: up.name } : {}),
    ...(rel.length ? { rel } : {}),
    ...(members.length ? { members: members.slice(0, MEMBERS_SHOWN) } : {}),
  };
}

const day = (iso: string) => iso.slice(0, 10);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Read side of the domain (D5): lets the model ask what the user already explored. Never writes. */
export class Reader {
  readonly repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  recall(query: string): RecalledConcept[] {
    const q = query.trim();
    if (!q) throw new TrackerError('Empty query');
    const found = new Map<string, Concept>();
    const exact = this.repo.findConceptByNorm(normalizeName(q));
    if (exact) found.set(exact.id, exact);
    for (const c of this.repo.searchConcepts(q, RECALL_LIMIT)) found.set(c.id, c);

    return [...found.values()].slice(0, RECALL_LIMIT).map((c) => {
      const detail = this.repo.getConceptDetail(c.id)!;
      const notes = [...new Set(detail.visits.map((v) => v.summary).filter(Boolean))]
        .slice(0, NOTES_PER_CONCEPT)
        .map((s) => clip(s, NOTE_MAX));
      const sources = this.repo.listConceptSources(c.id).slice(0, RECALL_SOURCES).map((s) => s.url);
      return {
        id: c.id,
        name: c.name,
        seen: c.visitCount,
        last: day(c.lastSeenAt),
        notes,
        near: this.repo.neighbourConcepts(c.id, NEAR_PER_CONCEPT).map((n) => n.name),
        ...(this.isThin(detail.visits) ? { thin: true } : {}),
        ...(sources.length > 0 ? { sources } : {}),
        ...extras(this.repo, c.id),
      };
    });
  }

  private isThin(visits: { id: string; conversationId: string; detail: string | null }[]): boolean {
    if (visits.some((v) => v.detail)) return false;
    const parents = new Set<string>();
    for (const cid of new Set(visits.map((v) => v.conversationId))) {
      for (const v of this.repo.getTree(cid)?.visits ?? []) if (v.parentVisitId) parents.add(v.parentVisitId);
    }
    return !visits.some((v) => parents.has(v.id));
  }

  /**
   * D19: a few lines appended to kc_start so the model knows what the graph holds (areas, most explored, recent)
   * without a call. Hard-capped; empty for an empty graph (zero tokens).
   */
  memoryProfile(): string {
    const total = this.repo.countConcepts();
    if (total === 0) return '';
    const areas = this.repo
      .listSuperclasses()
      .map((g) => ({ name: g.name, n: this.repo.listMembers(g.id).length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, MEMORY_AREAS)
      .map((g) => `${g.name} (${g.n})`);
    // Counts of 1 say nothing: only concepts seen at least twice are "most explored".
    const top = this.repo.rankConcepts('visits', MEMORY_TOPICS).filter((c) => c.visitCount >= 2);
    const seen = new Set(top.map((c) => c.id));
    const recent = this.repo.rankConcepts('recent', MEMORY_TOPICS).filter((c) => !seen.has(c.id)).slice(0, MEMORY_TOPICS);
    return [
      `User's graph (${total} concepts).`,
      ...(areas.length ? [`Areas: ${areas.join(', ')}`] : []),
      ...(top.length ? [`Most explored: ${top.map((c) => `${c.name} ×${c.visitCount}`).join(', ')}`] : []),
      ...(recent.length ? [`Recent: ${recent.map((c) => c.name).join(', ')}`] : []),
    ].join('\n');
  }

  /** "Approfondisci": every occurrence of a concept with its parent and its sub-concepts as sections (D16, D17). */
  conceptPage(conceptId: string): ConceptPage | undefined {
    const detail = this.repo.getConceptDetail(conceptId);
    if (!detail) return undefined;
    const trees = new Map<string, Visit[]>();
    const visitsOf = (conversationId: string) => {
      if (!trees.has(conversationId)) trees.set(conversationId, this.repo.getTree(conversationId)?.visits ?? []);
      return trees.get(conversationId)!;
    };
    return {
      ...detail,
      // Sources of this node and of the other visits of the same concept, each once.
      sources: this.repo.listConceptSources(conceptId),
      related: this.repo.listRelated(conceptId),
      superclass: this.repo.getSuperclass(conceptId) ?? null,
      members: this.repo.listMembers(conceptId),
      visits: detail.visits.map((v) => {
        const all = visitsOf(v.conversationId);
        // Every descendant is a section, however deep: a parent never has to repeat its children's text.
        const sections = (parentId: string): ConceptSection[] =>
          all
            .filter((c) => c.parentVisitId === parentId)
            .map((c) => ({ id: c.id, title: c.title, summary: c.summary, detail: c.detail, children: sections(c.id) }));
        const parentTitle = all.find((p) => p.id === v.parentVisitId)?.title ?? null;
        return {
          ...v,
          // Same name as the conversation: "X · sotto «X»" says nothing.
          parentTitle: parentTitle !== null && normalizeName(parentTitle) === normalizeName(v.conversationTitle) ? null : parentTitle,
          sections: sections(v.id),
        };
      }),
    };
  }

  /**
   * Indented outline of a conversation (RF9), titles only (the tools accept them); an id only where two nodes share
   * a title. `touched` narrows it to the branches leading to those nodes (the kc_track result); otherwise the free
   * relations (the dashed lines of the canvas) close the outline. Defaults to the most recent conversation.
   */
  tree(conversationId: string | null, withSummaries: boolean, compact = false, touched?: Set<string>, open?: { root?: string; depth?: number; relations?: boolean; orient?: boolean }): string {
    const id = conversationId ?? this.repo.listConversations()[0]?.id;
    if (!id) return 'No conversations yet.';
    const tree = this.repo.getTree(id);
    if (!tree) throw new TrackerError(`Conversation ${id} not found`);

    const { conversation, visits } = tree;
    if (compact && visits.length === 0) return 'Tree: empty';
    const byId = new Map(visits.map((v) => [v.id, v]));
    const children = new Map<string | null, Visit[]>();
    for (const v of visits) {
      const parent = v.parentVisitId && byId.has(v.parentVisitId) ? v.parentVisitId : null;
      children.set(parent, [...(children.get(parent) ?? []), v]);
    }
    const shown = new Set<string>();
    for (const t of touched ?? []) for (let v = byId.get(t); v && !shown.has(v.id); v = byId.get(v.parentVisitId ?? '')) shown.add(v.id);
    const titles = new Map<string, number>();
    for (const v of visits) titles.set(normalizeName(v.title), (titles.get(normalizeName(v.title)) ?? 0) + 1);

    const lines = compact ? ['Tree:'] : [`${conversation.title} [${conversation.id}] ${day(conversation.lastActivityAt)}, ${visits.length} nodes`];
    // A big outline is cut at the depth that fits TREE_MAX_NODES; a branch (open.root) is outlined from its own root.
    let top: string | null = null;
    if (open?.root) {
      const ref = open.root.trim();
      const norm = normalizeName(ref);
      const root = byId.get(ref) ?? visits.findLast((v) => normalizeName(v.title) === norm);
      if (!root) throw new TrackerError(`Node "${ref}" not found in this conversation`);
      top = root.id;
    }
    const subtree = (parent: string | null, depth: number, into: number[]) => {
      for (const v of children.get(parent) ?? []) {
        if (touched && !shown.has(v.id)) continue;
        into[depth] = (into[depth] ?? 0) + 1;
        subtree(v.id, depth + 1, into);
      }
    };
    const perDepth: number[] = [];
    if (top) ((perDepth[0] = 1), subtree(top, 1, perDepth));
    else subtree(null, 0, perDepth);
    const total = perDepth.reduce((a, b) => a + b, 0);
    // Deepest level that keeps the outline within TREE_MAX_NODES; the caller's depth (or, to orient, 2 levels on a
    // big map) can only make it shallower.
    let fit = 0;
    for (let d = 0, acc = 0; d < perDepth.length; d++) {
      acc += perDepth[d];
      if (acc > TREE_MAX_NODES && d > 0) break;
      fit = d;
    }
    const wanted = open?.depth !== undefined ? open.depth - 1 : open?.orient && total > ORIENT_MIN_NODES ? 1 : Infinity;
    const maxDepth = touched ? perDepth.length : Math.min(wanted, fit);
    let listed = 0;
    const hidden = (id: string): number => (children.get(id) ?? []).reduce((n, c) => n + 1 + hidden(c.id), 0);
    const walk = (parent: string | null, depth: number) => {
      for (const v of children.get(parent) ?? []) {
        if (touched && !shown.has(v.id)) continue;
        listed++;
        const dup = (titles.get(normalizeName(v.title)) ?? 0) > 1 ? ` [${v.id}]` : '';
        const current = !compact && v.id === conversation.currentVisitId ? ' *current' : '';
        const summary = withSummaries && v.summary ? `: ${v.summary}` : '';
        const more = depth >= maxDepth && !touched ? hidden(v.id) : 0;
        lines.push(`${'  '.repeat(depth)}- ${v.title}${dup}${current}${more ? ` (+${more})` : ''}${summary}`);
        if (depth < maxDepth || touched) walk(v.id, depth + 1);
      }
    };
    if (top) {
      const root = byId.get(top)!;
      listed++;
      lines.push(`- ${root.title}${withSummaries && root.summary ? `: ${root.summary}` : ''}`);
      walk(top, 1);
    } else {
      walk(null, 0);
    }
    if (listed < total) lines.push(`Showing ${listed} of ${total} nodes; (+n) = hidden below. kc_tree(root: "<title>", depth) opens a branch, kc_read gives one node's text.`);

    if (!compact && open?.relations) {
      const titleOf = new Map(visits.map((v) => [v.conceptId, v.title]));
      const rels = tree.relations.filter((r) => titleOf.has(r.from) && titleOf.has(r.to));
      if (rels.length) {
        lines.push('Relations:');
        for (const r of rels) lines.push(`- ${titleOf.get(r.from)} → ${titleOf.get(r.to)}${r.label ? ` (${r.label})` : ''}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * kc_read: the full text of one node of this conversation, or of a concept from the user's graph (latest visit that
   * has text), with the titles of its children.
   */
  read(conversationId: string | null, ref: string): string {
    const q = ref.trim();
    const visits = conversationId ? (this.repo.getTree(conversationId)?.visits ?? []) : [];
    const norm = normalizeName(q);
    let visit = visits.find((v) => v.id === q) ?? visits.findLast((v) => normalizeName(v.title) === norm);
    if (!visit) {
      const concept = this.repo.findConceptByNorm(norm);
      if (!concept) throw new TrackerError(`"${q}" not found in this conversation or in the user's graph`);
      const all = this.repo.getConceptDetail(concept.id)?.visits ?? [];
      visit = all.find((v) => v.detail) ?? all[0];
      if (!visit) throw new TrackerError(`"${q}" has no text yet`);
    }
    const kids = (this.repo.getTree(visit.conversationId)?.visits ?? []).filter((v) => v.parentVisitId === visit.id).map((v) => v.title);
    const urls = this.repo.listConceptSources(visit.conceptId).filter((s) => s.visitIds.includes(visit.id)).map((s) => s.url);
    return [`# ${visit.title}`, visit.summary, visit.detail ?? '', kids.length ? `Children: ${kids.join(', ')}` : '', urls.length ? `Sources: ${urls.join(' ')}` : '']
      .filter(Boolean)
      .join('\n\n');
  }

  /** Superclasses with their sizes, the biggest first; a long list is cut so kc_profile stays small. */
  private profileGroups(): string[] {
    const all = this.repo
      .listSuperclasses()
      .map((g) => ({ name: g.name, n: this.repo.listMembers(g.id).length }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const shown = all.slice(0, PROFILE_GROUPS).map((g) => `${g.name} (${g.n})`);
    return all.length > PROFILE_GROUPS ? [...shown, `…and ${all.length - PROFILE_GROUPS} more groups`] : shown;
  }

  /**
   * Maps the user already has on a similar topic (kc_start): titles sharing words with the new one, or holding a concept
   * that matches it. Most recent first.
   */
  similarMaps(title: string): { id: string; title: string; last: string; nodes: number }[] {
    const byConcept = new Set<string>();
    for (const c of this.repo.searchConcepts(title, 5)) {
      for (const v of this.repo.getConceptDetail(c.id)?.visits ?? []) byConcept.add(v.conversationId);
    }
    return this.repo
      .listConversations()
      .filter((c) => sharesEnough(title, c.title) || byConcept.has(c.id))
      .slice(0, SIMILAR_MAPS)
      .map((c) => ({ id: c.id, title: c.title, last: day(c.lastActivityAt), nodes: this.repo.getTree(c.id)!.visits.length }))
      .filter((c) => c.nodes > 0);
  }

  /** Most explored and most recent themes, plus the last conversations (RF10). */
  profile(): Profile {
    return {
      concepts: this.repo.countConcepts(),
      top: this.repo.rankConcepts('visits', PROFILE_LIMIT).map((c) => `${c.name} ×${c.visitCount}`),
      recent: this.repo.rankConcepts('recent', PROFILE_LIMIT).map((c) => c.name),
      groups: this.profileGroups(),
      ungrouped: this.repo.listRootConcepts().slice(0, UNGROUPED_SHOWN).map((c) => c.name),
      conversations: this.repo
        .listConversations()
        .map((c) => ({ id: c.id, title: c.title, last: day(c.lastActivityAt), nodes: this.repo.getTree(c.id)!.visits.length }))
        .filter((c) => c.nodes > 0)
        .slice(0, PROFILE_CONVERSATIONS),
    };
  }

  /**
   * Probable groupings of the topics not under a superclass yet (SC2), from words their names share: no model needed.
   * A concept goes to its smallest group; a word that an existing superclass already uses proposes joining it.
   */
  suggestions(): GroupSuggestion[] {
    let ignored: string[] = [];
    try {
      ignored = JSON.parse(this.repo.getSetting(IGNORED_KEY) ?? '[]') as string[];
    } catch {
      // A broken setting just means nothing was ignored.
    }
    const stemsOf = (name: string) => [...new Set(titleStems(name).filter((s) => s.length >= 4))];
    const roots = this.repo.listRootConcepts().map((c) => ({ c, stems: stemsOf(c.name) }));
    const out: GroupSuggestion[] = [];
    // 1. Joining an existing superclass: a root shares a word with its name or its members' names.
    const claimed = new Set<string>();
    for (const sup of this.repo.listSuperclasses()) {
      const words = new Set([sup.name, ...this.repo.listMembers(sup.id).map((m) => m.name)].flatMap(stemsOf));
      const hits = roots.filter((r) => r.c.id !== sup.id && r.stems.some((s) => words.has(s)) && !ignored.includes(`${sup.id}:${r.c.id}`));
      if (hits.length === 0) continue;
      hits.forEach((h) => claimed.add(h.c.id));
      out.push({ key: `${sup.id}:${hits.map((h) => h.c.id).join(',')}`, name: sup.name, concepts: hits.map((h) => h.c), into: sup });
    }
    // 2. New groups: roots sharing a word, each in its smallest group.
    const byStem = new Map<string, ConceptMatch[]>();
    for (const r of roots) if (!claimed.has(r.c.id)) for (const s of r.stems) byStem.set(s, [...(byStem.get(s) ?? []), r.c]);
    const groups = [...byStem.entries()]
      .filter(([s, list]) => list.length >= 2 && list.length <= SUGGESTION_MAX && !ignored.includes(s))
      .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));
    const used = new Set<string>();
    for (const [stem, list] of groups) {
      const free = list.filter((c) => !used.has(c.id));
      if (free.length < 2) continue;
      free.forEach((c) => used.add(c.id));
      const word = free[0].name.split(/\s+/).find((w) => titleStems(w).includes(stem)) ?? stem;
      out.push({ key: stem, name: word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(), concepts: free });
    }
    return out;
  }

  /** Node search for the canvas (RF17): exact name, then names containing the text, then what was said. */
  search(query: string): Concept[] {
    const q = query.trim();
    if (!q) return [];
    const found = new Map<string, Concept>();
    const exact = this.repo.findConceptByNorm(normalizeName(q));
    if (exact) found.set(exact.id, exact);
    for (const c of this.repo.findConceptsByName(q, SEARCH_LIMIT)) found.set(c.id, c);
    for (const c of this.repo.searchConcepts(q, SEARCH_LIMIT)) found.set(c.id, c);
    return [...found.values()].slice(0, SEARCH_LIMIT);
  }

  /** Text search for the canvas: nodes of every map whose title, summary or full text has the words; each opens in its map. */
  searchText(query: string): TextHit[] {
    return this.repo.searchText(query, TEXT_HITS);
  }
}
