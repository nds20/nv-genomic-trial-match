import { CloudflarePlatform } from './src/service.js';
import { fail } from './src/errors.js';
import { publicUser } from './src/user-view.js';

const DEFAULT_COOKIE_NAME = 'bsr_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function errorResponse(error) {
  if (error && error.name === 'AuthError') {
    return json({ error: error.message, code: error.code }, error.status || 400);
  }
  if (error && Number.isInteger(error.status)) {
    return json({ error: error.message }, error.status);
  }
  console.error('[Cloudflare API] Request failed:', error);
  return json({ error: 'The request could not be completed.' }, 500);
}

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { fail('INVALID_JSON', 'Request body must be valid JSON.'); }
}

function cookieName(env) { return env.SESSION_COOKIE_NAME || DEFAULT_COOKIE_NAME; }

function tokenFromRequest(request, env) {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === cookieName(env)) return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

function sessionCookie(request, env, token) {
  const parts = [
    `${cookieName(env)}=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (new URL(request.url).protocol === 'https:') parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(env) {
  return `${cookieName(env)}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleApi(request, env) {
  const platform = new CloudflarePlatform(env.DB, env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method.toUpperCase();

  const resolveUser = async () => {
    const session = await platform.verifySessionToken(tokenFromRequest(request, env));
    if (!session) return null;
    return platform.getUserById(session.userId);
  };
  const knownUser = async () => platform.requireAuthenticated(await resolveUser());
  const activeUser = async () => platform.requireActiveAccount(await resolveUser());
  const roleUser = async (...roles) => {
    const user = await activeUser();
    platform.requireRole(user, ...roles);
    return user;
  };
  const userFromCredentials = async (body) => {
    const user = await platform.verifyCredentials(body?.email, body?.password);
    if (!user) fail('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
    if (user.status === 'suspended') fail('ACCOUNT_SUSPENDED', 'This account has been suspended. Contact an administrator.', 403);
    return user;
  };

  try {
    if (path === '/api/health' && method === 'GET') {
      await platform.getTrials();
      return json({ status: 'ok', trialStore: 'd1' });
    }
    if (path === '/api/trials' && method === 'GET') return json(await platform.getTrials());
    if (path === '/api/match' && method === 'POST') {
      const body = await readJson(request);
      return json({ biomarkers: body.biomarkers, results: await platform.match(body.biomarkers) });
    }
    if (path === '/api/upload' && method === 'POST') {
      const form = await request.formData();
      const file = form.get('research');
      if (!file || typeof file === 'string') fail('UPLOAD_REQUIRED', 'Choose a research file to upload.');
      const buffer = new Uint8Array(await file.arrayBuffer());
      return json(await platform.analyzeFile({ originalname: file.name, buffer }));
    }

    // Doctor auth ---------------------------------------------------------
    if (path === '/api/auth/invites' && method === 'POST') {
      const admin = await roleUser('admin');
      const body = await readJson(request);
      if (body.role !== undefined && !['doctor', 'reviewer', 'admin'].includes(body.role)) fail('INVALID_ROLE', `Unknown role: ${body.role}`);
      const { invite, token } = await platform.createInvite({ createdBy: admin.id, email: body.email || null, role: body.role || 'doctor' });
      return json({ inviteId: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, token, registrationPath: `/register?invite=${token}` }, 201);
    }
    if (path === '/api/auth/invites' && method === 'GET') {
      await roleUser('admin');
      return json(await platform.listInvites());
    }
    if (path === '/api/auth/register' && method === 'POST') {
      return json(await platform.register(await readJson(request)), 201);
    }
    if (path === '/api/auth/mfa/enroll' && method === 'POST') {
      const body = await readJson(request);
      const user = await userFromCredentials(body);
      if (user.mfaConfirmedAt) fail('MFA_ALREADY_ENROLLED', 'MFA is already confirmed for this account. Ask an administrator for help resetting it.', 409);
      return json(await platform.beginMfaEnrollment(user.id));
    }
    if (path === '/api/auth/mfa/confirm' && method === 'POST') {
      const body = await readJson(request);
      const user = await userFromCredentials(body);
      return json(await platform.confirmMfa(user.id, body?.code));
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readJson(request);
      const { token, user } = await platform.login(body?.email, body?.password, body?.totpCode);
      return json({ user }, 200, { 'Set-Cookie': sessionCookie(request, env, token) });
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      await knownUser();
      const session = await platform.verifySessionToken(tokenFromRequest(request, env));
      if (session) await platform.logout(session.id);
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(env) });
    }
    if (path === '/api/auth/me' && method === 'GET') {
      return json({ user: publicUser(await knownUser()) });
    }
    if (path === '/api/auth/users' && method === 'GET') {
      await roleUser('admin');
      return json(await platform.listUsers());
    }
    const userAction = path.match(/^\/api\/auth\/users\/([^/]+)\/(approve|suspend)$/);
    if (userAction && method === 'POST') {
      const admin = await roleUser('admin');
      return json(userAction[2] === 'approve'
        ? await platform.approveUser(admin, decodeURIComponent(userAction[1]))
        : await platform.suspendUser(admin, decodeURIComponent(userAction[1])));
    }

    // Submissions and review queue -----------------------------------------
    if (path === '/api/submissions' && method === 'POST') {
      return json(await platform.createSubmission(await activeUser(), await readJson(request)), 201);
    }
    if (path === '/api/submissions' && method === 'GET') {
      return json(await platform.listMine(await activeUser()));
    }
    const submissionPath = path.match(/^\/api\/submissions\/([^/]+)$/);
    if (submissionPath && method === 'GET') return json(await platform.getSubmission(await activeUser(), decodeURIComponent(submissionPath[1])));
    if (submissionPath && method === 'PATCH') return json(await platform.editSubmission(await activeUser(), decodeURIComponent(submissionPath[1]), await readJson(request)));
    if (submissionPath && method === 'DELETE') return json(await platform.deleteSubmission(await activeUser(), decodeURIComponent(submissionPath[1])));
    if (path === '/api/review-queue' && method === 'GET') {
      return json(await platform.listPendingReview(await roleUser('reviewer', 'admin')));
    }
    const reviewPath = path.match(/^\/api\/review-queue\/([^/]+)\/(approve|reject)$/);
    if (reviewPath && method === 'POST') {
      const reviewer = await roleUser('reviewer', 'admin');
      const body = await readJson(request);
      return json(await platform.reviewSubmission(reviewer, decodeURIComponent(reviewPath[1]), body?.note, reviewPath[2] === 'approve' ? 'approved' : 'rejected'));
    }

    // Clinician matcher cases --------------------------------------------------
    if (path === '/api/cases' && method === 'GET') {
      return json(await platform.listCases(await activeUser(), { limit: url.searchParams.get('limit') || 50 }));
    }
    if (path === '/api/cases' && method === 'POST') {
      return json(await platform.createCase(await activeUser(), await readJson(request)), 201);
    }
    const casePath = path.match(/^\/api\/cases\/(\d+)$/);
    if (casePath && method === 'DELETE') return json(await platform.deleteCase(await activeUser(), Number(casePath[1])));
    const detailPath = path.match(/^\/api\/cases\/(\d+)\/detail$/);
    if (detailPath && method === 'GET') return json(await platform.getCaseDetail(await activeUser(), Number(detailPath[1])));
    const caseUploadPath = path.match(/^\/api\/cases\/(\d+)\/uploads$/);
    if (caseUploadPath && method === 'POST') {
      const form = await request.formData();
      const file = form.get('research');
      if (!file || typeof file === 'string') fail('UPLOAD_REQUIRED', 'Choose a research file to upload.');
      return json(await platform.uploadCaseFile(await activeUser(), Number(caseUploadPath[1]), file), 201);
    }
    const runPath = path.match(/^\/api\/cases\/(\d+)\/run-match$/);
    if (runPath && method === 'POST') return json(await platform.runCaseMatch(await activeUser(), Number(runPath[1])));
    const uploadPath = path.match(/^\/api\/uploads\/(\d+)$/);
    if (uploadPath && method === 'DELETE') return json(await platform.deleteUpload(await activeUser(), Number(uploadPath[1])));

    return json({ error: 'API route not found.' }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return withSecurityHeaders(await handleApi(request, env));
    if (!env.ASSETS) return withSecurityHeaders(new Response('Static assets are not configured.', { status: 503 }));

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return withSecurityHeaders(assetResponse);

    // SPA fallback for client-side paths such as /register?invite=...
    const lastSegment = url.pathname.split('/').pop() || '';
    if (request.method === 'GET' && !lastSegment.includes('.')) {
      const indexRequest = new Request(new URL('/index.html', url.origin), request);
      const indexResponse = await env.ASSETS.fetch(indexRequest);
      if (indexResponse.status !== 404) return withSecurityHeaders(indexResponse);
    }
    return withSecurityHeaders(assetResponse);
  },
};
