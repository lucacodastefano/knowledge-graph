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
      const target = path + (rest ? `?${rest}` : '');
      const value = encodeURIComponent(token);
      // Lax, not Strict: Safari drops Strict cookies on a navigation that starts in another app (a tapped link).
      const attrs = 'Path=/; Secure; SameSite=Lax; Max-Age=31536000';
      reply.header('set-cookie', `kg_token=${value}; HttpOnly; ${attrs}`);
      if (req.method !== 'GET' || path.startsWith('/api/') || path === '/ws') return; // authorised, no redirect
      // A 200 page instead of a 302 (browsers differ on cookies set by redirects); it also sets the cookie from JS as a fallback.
      return reply.type('text/html').send(
        `<!doctype html><meta charset="utf-8"><title>Knowledge graph</title><script>document.cookie=${JSON.stringify(`kg_token=${value}; ${attrs}`)};location.replace(${JSON.stringify(target)})</script>`,
      );
    }
    return reply.code(401).send({ error: 'Unauthorized' });
  });
}
