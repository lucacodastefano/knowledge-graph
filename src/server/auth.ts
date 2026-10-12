import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * `/t/<token>/...` lets clients that can only be given a URL (Claude custom connectors) authenticate:
 * the prefix is stripped and the token moves to the Authorization header.
 */
export function tokenRewriteUrl(token: string | undefined) {
  const prefix = token ? `/t/${token}` : null;
  return (req: { url?: string; headers: Record<string, unknown> }): string => {
    const url = req.url ?? '/';
    if (prefix && (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))) {
      req.headers.authorization = `Bearer ${token}`;
      return url.slice(prefix.length) || '/';
    }
    return url;
  };
}

const cookieOf = (req: FastifyRequest) => /(?:^|;\s*)kg_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];

/** Every route except /api/health needs the token: Bearer header, `kg_token` cookie, or `?token=` (which sets the cookie). */
export function registerAuth(app: FastifyInstance, token: string) {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/api/health') return;
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if ([bearer, cookieOf(req)].some((c) => c && safeEqual(decodeURIComponent(c), token))) return;
    const query = new URL(req.url, 'http://x').searchParams;
    const given = query.get('token');
    if (given && safeEqual(given, token)) {
      query.delete('token');
      const rest = query.toString();
      reply.header('set-cookie', `kg_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`);
      return reply.redirect(path + (rest ? `?${rest}` : ''));
    }
    return reply.code(401).send({ error: 'Unauthorized' });
  });
}
