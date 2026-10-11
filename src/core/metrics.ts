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
/** Past this many days of data the charts group by day instead of by hour. */
const HOURLY_MAX_MS = 2 * 86_400_000;
const MAX_DUPLICATES = 10;
/** Pairwise title comparison is quadratic: above this many concepts only identical word sets count as duplicates. */
const PAIRWISE_MAX = 400;

export interface Metrics {
  /** First moment shown (null = everything) and the bucket size of the time series. */
  from: string | null;
  bucket: 'hour' | 'day';
  tokens: {
    series: { t: string; written: number; read: number; cumWritten: number; cumRead: number }[];
    written: number;
    read: number;
    calls: number;
  };
  growth: { t: string; maps: number; concepts: number; nodes: number; relations: number | null }[];
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
    /** Index = depth (1 = top of a map), value = how many nodes. */
    depth: number[];
  };
}

const bucketKey = (iso: string, bucket: 'hour' | 'day') => (bucket === 'hour' ? `${iso.slice(0, 13)}:00:00.000Z` : iso.slice(0, 10));
const step = (key: string, bucket: 'hour' | 'day') => {
  const d = new Date(bucket === 'hour' ? key : `${key}T00:00:00.000Z`);
  d.setTime(d.getTime() + (bucket === 'hour' ? 3_600_000 : 86_400_000));
  return bucketKey(d.toISOString(), bucket);
};

/** Every bucket from the first to the last key, so quiet periods show as flat stretches. */
function range(first: string, last: string, bucket: 'hour' | 'day'): string[] {
  const out = [first];
  while (out[out.length - 1] < last && out.length < 2000) out.push(step(out[out.length - 1], bucket));
  return out;
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

  const first = [scoped[0]?.at, ...graph.visits.filter((v) => !conv || v.conversationId === conv).map((v) => v.at)]
    .filter((t): t is string => !!t && (!from || t >= from))
    .sort()[0];
  const spanMs = period === 'all' ? now - Date.parse(first ?? new Date(now).toISOString()) : PERIOD_MS[period];
  const bucket = spanMs <= HOURLY_MAX_MS ? 'hour' : 'day';
  const nowKey = bucketKey(new Date(now).toISOString(), bucket);

  // --- tokens over time ---
  const perBucket = new Map<string, { written: number; read: number }>();
  for (const c of scoped) {
    const k = bucketKey(c.at, bucket);
    const b = perBucket.get(k) ?? { written: 0, read: 0 };
    b.written += tokens(c.argChars);
    b.read += tokens(c.resultChars);
    perBucket.set(k, b);
  }
  const keys = perBucket.size ? range([...perBucket.keys()].sort()[0], nowKey, bucket) : [];
  let cw = 0;
  let cr = 0;
  const series = keys.map((t) => {
    const b = perBucket.get(t) ?? { written: 0, read: 0 };
    cw += b.written;
    cr += b.read;
    return { t, ...b, cumWritten: cw, cumRead: cr };
  });

  // --- growth (cumulative; what existed before the period is the starting level) ---
  const visits = graph.visits.filter((v) => !conv || v.conversationId === conv);
  const firstOfConcept = new Map<string, string>();
  for (const v of visits) if (!firstOfConcept.has(v.conceptId) || v.at < firstOfConcept.get(v.conceptId)!) firstOfConcept.set(v.conceptId, v.at);
  const events = {
    maps: conv ? [] : graph.conversations.map((c) => c.at),
    concepts: conv ? [...firstOfConcept.values()] : graph.concepts.map((c) => c.at),
    nodes: visits.map((v) => v.at),
    relations: graph.relationTimes,
  };
  const gKeys = new Set<string>();
  for (const times of Object.values(events)) for (const t of times) if (t && (!from || t >= from)) gKeys.add(bucketKey(t, bucket));
  const growthKeys = gKeys.size ? range([...gKeys].sort()[0], nowKey, bucket) : [];
  const level = (times: string[], key: string) => {
    const end = step(key, bucket);
    const upTo = bucket === 'hour' ? end : `${end}T00:00:00.000Z`;
    return times.filter((t) => t !== '' && t < upTo).length;
  };
  const growth = growthKeys.map((t) => ({
    t,
    maps: level(events.maps, t),
    concepts: level(events.concepts, t),
    nodes: level(events.nodes, t),
    relations: conv ? null : level(events.relations, t),
  }));

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
  for (const v of visits) {
    const d = depthOf(v.id);
    while (depth.length <= d) depth.push(0);
    depth[d]++;
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
    bucket,
    tokens: { series, written: sum(series.map((s) => s.written)), read: sum(series.map((s) => s.read)), calls: scoped.length },
    growth,
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
    },
  };
}
