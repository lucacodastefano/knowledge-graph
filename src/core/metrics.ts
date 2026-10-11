import type { GraphSnapshot, ToolCall } from './types.ts';
import { sharesEnough, similarityKey } from './similarity.ts';

/** Rough token estimate for the text exchanged with the model. */
export const CHARS_PER_TOKEN = 3.5;
export const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

export type Period = '24h' | '7d' | '30d' | 'all';
export interface MetricsQuery {
  conversation?: string;
  period?: Period;
}

const PERIOD_MS: Record<Exclude<Period, 'all'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const MAX_DUPLICATES = 10;
/** Pairwise title comparison is quadratic: above this many concepts only identical word sets count as duplicates. */
const PAIRWISE_MAX = 400;

export interface Metrics {
  /** First moment shown (null = everything). */
  from: string | null;
  tokens: { written: number; read: number; calls: number };
  /** One point per call, in time order: nodes in the graph (or chosen map) right after it, tokens spent so far, tokens per node it created. */
  size: { nodes: number; cumTokens: number; perNode: number | null }[];
  tools: { tool: string; calls: number; written: number; read: number; errors: number; avgMs: number; maxMs: number }[];
  efficiency: {
    nodesCreated: number;
    tokensPerNode: number | null;
    /** kc_track calls that created nothing: the model re-sent nodes that already existed. */
    rewrites: number;
    /** kc_edit calls: changing only what changed. */
    partialEdits: number;
  };
  memory: { recall: { calls: number; hits: number }; read: { calls: number; hits: number } };
  quality: {
    nodes: number;
    withoutDetail: number;
    withoutSources: number;
    concepts: number;
    withoutSuperclass: number;
    duplicates: [string, string][];
    /** Index = depth - 1 (0 = top of a map), value = how many nodes. */
    depth: number[];
    /** Deepest level and children per node that has children. */
    maxDepth: number;
    avgChildren: number | null;
    /** The trees behind the sunburst: every node with its parent, and the graphs that hold them. */
    graphs: { id: string; title: string }[];
    tree: { id: string; parent: string | null; graph: string; title: string }[];
  };
}

export function periodStart(period: Period, now = Date.now()): string | null {
  return period === 'all' ? null : new Date(now - PERIOD_MS[period]).toISOString();
}

export function buildMetrics(calls: ToolCall[], graph: GraphSnapshot, query: MetricsQuery = {}, now = Date.now()): Metrics {
  const period = query.period ?? 'all';
  const from = periodStart(period, now);
  const conv = query.conversation || null;
  const inScope = (c: ToolCall) => (!from || c.at >= from) && (!conv || c.conversationId === conv);
  const scoped = calls.filter(inScope);

  // --- graph size against tokens, call by call ---
  const visits = graph.visits.filter((v) => !conv || v.conversationId === conv);
  const visitTimes = visits.map((v) => v.at).sort();
  let upTo = 0;
  let cum = 0;
  const size = scoped.map((c) => {
    while (upTo < visitTimes.length && visitTimes[upTo] <= c.at) upTo++;
    const spent = tokens(c.argChars) + tokens(c.resultChars);
    cum += spent;
    return { nodes: upTo, cumTokens: cum, perNode: c.nodesCreated > 0 ? Math.round(spent / c.nodesCreated) : null };
  });

  // --- per tool ---
  const byTool = new Map<string, ToolCall[]>();
  for (const c of scoped) byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), c]);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const tools = [...byTool.entries()]
    .map(([tool, cs]) => ({
      tool,
      calls: cs.length,
      written: tokens(sum(cs.map((c) => c.argChars))),
      read: tokens(sum(cs.map((c) => c.resultChars))),
      errors: cs.filter((c) => !c.ok).length,
      avgMs: Math.round(sum(cs.map((c) => c.durationMs)) / cs.length),
      maxMs: Math.max(...cs.map((c) => c.durationMs)),
    }))
    .sort((a, b) => b.written + b.read - (a.written + a.read));

  // --- efficiency ---
  const nodesCreated = sum(scoped.map((c) => c.nodesCreated));
  const totalTokens = sum(scoped.map((c) => tokens(c.argChars) + tokens(c.resultChars)));
  const efficiency = {
    nodesCreated,
    tokensPerNode: nodesCreated > 0 ? Math.round(totalTokens / nodesCreated) : null,
    rewrites: scoped.filter((c) => c.tool === 'kc_track' && c.ok && c.nodesCreated === 0).length,
    partialEdits: scoped.filter((c) => c.tool === 'kc_edit' && c.ok).length,
  };

  // --- memory reuse ---
  const mem = (tool: string) => {
    const cs = scoped.filter((c) => c.tool === tool);
    return { calls: cs.length, hits: cs.filter((c) => c.hit === true).length };
  };

  // --- quality (a snapshot of now, restricted to the conversation when one is chosen) ---
  const byId = new Map(visits.map((v) => [v.id, v]));
  const depthOf = (id: string) => {
    let d = 1;
    for (let p = byId.get(id)?.parentVisitId; p && byId.has(p) && d < 50; p = byId.get(p)!.parentVisitId) d++;
    return d;
  };
  const depth: number[] = [0];
  const children = new Map<string, number>();
  for (const v of visits) {
    const d = depthOf(v.id);
    while (depth.length <= d) depth.push(0);
    depth[d]++;
    if (v.parentVisitId && byId.has(v.parentVisitId)) children.set(v.parentVisitId, (children.get(v.parentVisitId) ?? 0) + 1);
  }
  const conceptIds = new Set(visits.map((v) => v.conceptId));
  const concepts = graph.concepts.filter((c) => !conv || conceptIds.has(c.id));
  const duplicates: [string, string][] = [];
  const seen = new Map<string, string>();
  const pairwise = concepts.length <= PAIRWISE_MAX;
  for (let i = 0; i < concepts.length && duplicates.length < MAX_DUPLICATES; i++) {
    const key = similarityKey(concepts[i].name);
    const twin = key ? seen.get(key) : undefined;
    if (twin) duplicates.push([twin, concepts[i].name]);
    else if (key) seen.set(key, concepts[i].name);
    if (!twin && pairwise) {
      for (let j = 0; j < i && duplicates.length < MAX_DUPLICATES; j++) {
        if (sharesEnough(concepts[i].name, concepts[j].name)) duplicates.push([concepts[j].name, concepts[i].name]);
      }
    }
  }

  return {
    from,
    tokens: { written: tokens(sum(scoped.map((c) => c.argChars))), read: tokens(sum(scoped.map((c) => c.resultChars))), calls: scoped.length },
    size,
    tools,
    efficiency,
    memory: { recall: mem('kc_recall'), read: mem('kc_read') },
    quality: {
      nodes: visits.length,
      withoutDetail: visits.filter((v) => !v.hasDetail).length,
      withoutSources: visits.filter((v) => v.sourceCount === 0).length,
      concepts: concepts.length,
      withoutSuperclass: concepts.filter((c) => !c.hasSuperclass).length,
      duplicates,
      depth: depth.slice(1),
      maxDepth: depth.length - 1,
      graphs: graph.conversations.filter((c) => !conv || c.id === conv).map((c) => ({ id: c.id, title: c.title })),
      tree: visits.map((v) => ({ id: v.id, parent: v.parentVisitId && byId.has(v.parentVisitId) ? v.parentVisitId : null, graph: v.conversationId, title: v.title })),
      avgChildren: children.size ? Math.round((sum([...children.values()]) / children.size) * 10) / 10 : null,
    },
  };
}
