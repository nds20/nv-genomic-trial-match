const express = require('express');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const { randomBytes } = require('node:crypto');
const LenhardAIEngine = require('./engine/LenhardEngine');
const TrialRepository = require('./engine/TrialRepository');
const { createAuthService, roles, publicUser } = require('./auth');
const { fail } = require('./auth/errors');
const { sessionCookie, clearSessionCookie, tokenFromRequest } = require('./auth/session');

// --- Doctor auth service (auth/) ------------------------------------------
// The service persists to the JSON file store (default
// `data/auth-store.json`, override with AUTH_STORE_FILE) behind the store
// interface in auth/store.js, so a Cosmos-backed store can replace it
// later without touching the routes below.
//
// SESSION_SECRET handling: when SESSION_SECRET is set to at least 16
// characters it keys the session-token HMAC. When it is missing or too
// short, the server generates a random per-boot secret and logs a loud
// warning instead of refusing to start — acceptable for this prototype,
// but it means every restart invalidates all sessions. Set SESSION_SECRET
// in the environment for any real deployment.
function resolveSessionSecret(secret) {
    if (secret && String(secret).length >= 16) return String(secret);
    const generated = randomBytes(32).toString('hex');
    console.warn('[auth] SESSION_SECRET is not set to at least 16 characters; using a random per-boot session secret. All sessions will be invalidated on restart. Set SESSION_SECRET for stable sessions.');
    return generated;
}

function createDefaultAuthService() {
    return createAuthService({ sessionSecret: resolveSessionSecret(process.env.SESSION_SECRET) });
}

// Builds the Express app. `authService` is injectable so integration tests
// can supply a service backed by a temporary store with a stubbed NPPES
// lookup; production uses createDefaultAuthService().
function createApp(authService = createDefaultAuthService()) {
    const auth = authService;
    const app = express();
    const engine = new LenhardAIEngine();
    const trialRepository = new TrialRepository();
    if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
    app.use(helmet());
    app.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    app.use(express.json());

    const uploadLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Upload limit reached. Try again later.' }
    });

    // Credential endpoints (register / login / MFA) get their own, more
    // generous limiter: enough for legitimate sign-in retries, low enough
    // to blunt password guessing.
    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 50,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many authentication attempts. Try again later.' }
    });

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 5 * 1024 * 1024, files: 1 },
        fileFilter: (req, file, cb) => {
            const ok = /\.(txt|csv|json|tsv)$/i.test(file.originalname);
            const error = Object.assign(
                new Error('Unsupported file type. Use .txt, .csv, .tsv or .json.'),
                { status: 415 }
            );
            cb(ok ? null : error, ok);
        }
    });

    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', trialStore: trialRepository.container ? 'cosmos' : 'demo' });
    });

    app.get('/api/trials', async (req, res, next) => {
        try {
            res.json(await trialRepository.getTrials());
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/upload', uploadLimiter, upload.single('research'), async (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'Choose a research file to upload.' });
            const trials = await trialRepository.getTrials();
            res.json(engine.analyzeResearchFile(req.file, trials));
        } catch (error) {
            next(error);
        }
    });

    // --- Doctor auth + research submissions (auth/README.md) --------------
    // Thin HTTP adapter over the auth service layer. All rules (invites,
    // NPI verification, MFA gating, review queue, versioning, audit) live
    // in auth/; these handlers only translate HTTP <-> service calls and
    // let AuthError bubble to the error middleware, which maps
    // AuthError.status/code onto the response.
    const resolveSessionUser = (req) => auth.resolveSessionUser(req);
    // Requires an active account (signed in, MFA-confirmed, approved).
    const requireSession = roles.authenticate(resolveSessionUser);
    // Requires only a signed-in user, so pending accounts can still read
    // their own status (GET /api/auth/me) and sign out.
    const requireKnownSession = roles.authenticate(resolveSessionUser, { active: false });

    // MFA enrollment happens before an account can hold a session (login
    // itself requires a confirmed TOTP code), so enroll/confirm identify
    // the caller by email + password instead of a session cookie.
    async function userFromCredentials(body) {
        const user = await auth.users.verifyCredentials(body?.email, body?.password);
        if (!user) fail('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
        if (user.status === 'suspended') {
            fail('ACCOUNT_SUSPENDED', 'This account has been suspended. Contact an administrator.', 403);
        }
        return user;
    }

    app.post('/api/auth/invites', requireSession, roles.authorize('admin'), async (req, res, next) => {
        try {
            const { email, role } = req.body || {};
            if (role !== undefined && !roles.isValidRole(role)) {
                fail('INVALID_ROLE', `Unknown role: ${role}`);
            }
            const { invite, token } = await auth.invites.createInvite({
                createdBy: req.user.id,
                email: email || null,
                role: role || 'doctor',
            });
            // The raw token is returned exactly once, here; only its hash
            // is stored. The admin shares the registration path out of band.
            res.status(201).json({
                inviteId: invite.id,
                email: invite.email,
                role: invite.role,
                expiresAt: invite.expiresAt,
                token,
                registrationPath: `/register?invite=${token}`,
            });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/auth/invites', requireSession, roles.authorize('admin'), async (req, res, next) => {
        try {
            res.json(await auth.invites.listInvites());
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/register', authLimiter, async (req, res, next) => {
        try {
            const { inviteToken, name, email, password, npi, licenseNumber, licenseState } = req.body || {};
            // Deliberately does NOT forward a caller-supplied role: the
            // account's role comes from the invite an admin issued.
            const user = await auth.users.register({
                inviteToken, name, email, password, npi, licenseNumber, licenseState,
            });
            res.status(201).json(user);
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/mfa/enroll', authLimiter, async (req, res, next) => {
        try {
            const user = await userFromCredentials(req.body);
            if (user.mfaConfirmedAt) {
                fail('MFA_ALREADY_ENROLLED', 'MFA is already confirmed for this account. Ask an administrator for help resetting it.', 409);
            }
            res.json(await auth.users.beginMfaEnrollment(user.id));
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/mfa/confirm', authLimiter, async (req, res, next) => {
        try {
            const user = await userFromCredentials(req.body);
            res.json(await auth.users.confirmMfa(user.id, req.body?.code));
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/login', authLimiter, async (req, res, next) => {
        try {
            const { email, password, totpCode } = req.body || {};
            const { token, user } = await auth.login(email, password, totpCode);
            res.set('Set-Cookie', sessionCookie(token));
            res.json({ user });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/logout', requireKnownSession, async (req, res, next) => {
        try {
            const session = await auth.sessions.verifySessionToken(tokenFromRequest(req));
            if (session) await auth.logout(session.id);
            res.set('Set-Cookie', clearSessionCookie());
            res.json({ ok: true });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/auth/me', requireKnownSession, (req, res) => {
        res.json({ user: publicUser(req.user) });
    });

    app.get('/api/auth/users', requireSession, roles.authorize('admin'), async (req, res, next) => {
        try {
            const users = await auth.store.all('users');
            res.json(users.map(publicUser));
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/users/:id/approve', requireSession, roles.authorize('admin'), async (req, res, next) => {
        try {
            res.json(await auth.users.approveUser(req.user, req.params.id));
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/users/:id/suspend', requireSession, roles.authorize('admin'), async (req, res, next) => {
        try {
            res.json(await auth.users.suspendUser(req.user, req.params.id));
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/submissions', requireSession, async (req, res, next) => {
        try {
            // The service always lands new submissions as pending_review.
            res.status(201).json(await auth.submissions.createSubmission(req.user, req.body || {}));
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/submissions', requireSession, async (req, res, next) => {
        try {
            res.json(await auth.submissions.listMine(req.user));
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/submissions/:id', requireSession, async (req, res, next) => {
        try {
            res.json(await auth.submissions.getSubmission(req.user, req.params.id));
        } catch (error) {
            next(error);
        }
    });

    app.patch('/api/submissions/:id', requireSession, async (req, res, next) => {
        try {
            res.json(await auth.submissions.editSubmission(req.user, req.params.id, req.body || {}));
        } catch (error) {
            next(error);
        }
    });

    app.delete('/api/submissions/:id', requireSession, async (req, res, next) => {
        try {
            res.json(await auth.submissions.deleteSubmission(req.user, req.params.id));
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/review-queue', requireSession, roles.authorize('reviewer', 'admin'), async (req, res, next) => {
        try {
            res.json(await auth.submissions.listPendingReview(req.user));
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/review-queue/:id/approve', requireSession, roles.authorize('reviewer', 'admin'), async (req, res, next) => {
        try {
            res.json(await auth.submissions.approveSubmission(req.user, req.params.id, { note: req.body?.note }));
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/review-queue/:id/reject', requireSession, roles.authorize('reviewer', 'admin'), async (req, res, next) => {
        try {
            res.json(await auth.submissions.rejectSubmission(req.user, req.params.id, { note: req.body?.note }));
        } catch (error) {
            next(error);
        }
    });

    app.use((err, req, res, next) => {
        // AuthError carries its own HTTP status and a stable machine
        // -readable code; surface both consistently for the auth API.
        if (err && err.name === 'AuthError') {
            return res.status(err.status || 400).json({ error: err.message, code: err.code });
        }
        const status = err.status || (err instanceof multer.MulterError
            ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
            : 500);
        if (status === 500) console.error('[API] Request failed:', err);
        res.status(status).json({ error: status === 500 ? 'The request could not be completed.' : err.message });
    });

    return app;
}

const auth = createDefaultAuthService();
const app = createApp(auth);

const port = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}

module.exports = { app, createApp, auth };
