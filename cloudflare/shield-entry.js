/*
 * 824 Shield entry point for the precision oncology platform.
 *
 * Wraps the application Worker (./worker.js) with 824 Shield
 * (https://github.com/nds20/824-shield, GPLv3, vendored under
 * ./shield/ by the copyright holder): every request that reaches the
 * Worker is scored for prompt injection, classic cyber exploits,
 * vulnerability probes, bot signals, and floods before the app sees
 * it, and every response gains defensive headers. wrangler.toml's
 * `main` points here; reverting that one line restores the unwrapped
 * Worker exactly as it was.
 */

import appWorker from './worker.js';
import { Shield } from './shield/guard.js';
import { applySecurityHeaders } from './shield/headers.js';

const shield = new Shield({
  // Generous for real app traffic (page loads fan out into many API
  // and asset calls); floods still drain the bucket and block.
  rate: { capacity: 120, refillPerSec: 2 },
  onDecision: (decision) => {
    if (decision.action !== 'allow') console.warn('[824-shield]', JSON.stringify(decision));
  },
});

const appFetch = appWorker.fetch.bind(appWorker);

async function shieldedFetch(request, env, ctx) {
  const contentType = request.headers.get('content-type') || '';
  let bodyText = '';
  // Multipart bodies (matcher file uploads) are never payload-scanned:
  // they are large, partly binary, and handled by dedicated routes.
  if (['POST', 'PUT', 'PATCH'].includes(request.method) && !contentType.includes('multipart/form-data')) {
    try { bodyText = await request.clone().text(); } catch { bodyText = ''; }
  }
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });

  const decision = shield.evaluate({
    ip: request.headers.get('CF-Connecting-IP') || 'unknown',
    method: request.method,
    path: new URL(request.url).pathname,
    headers,
    bodyText,
  });

  if (decision.action === 'block') {
    return new Response(
      JSON.stringify({ error: 'Request blocked by 824 Shield.', reasons: decision.reasons }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const response = await appFetch(request, env, ctx);
  if (decision.action === 'challenge') {
    const flagged = new Response(response.body, response);
    flagged.headers.set('X-824-Shield', 'challenge');
    return applySecurityHeaders(flagged);
  }
  return applySecurityHeaders(response);
}

export default { ...appWorker, fetch: shieldedFetch };
