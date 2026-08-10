// Private admin panel: live view of sessions/riders plus kill switches.
//
// Disabled unless config.admin.password is set, so upstream installs and
// anyone who hasn't opted in are unaffected.
//
// Auth is a single shared password compared in constant time, exchanged for an
// HMAC-signed HttpOnly cookie.  No new npm dependencies: the cookie is signed
// and parsed here with node's crypto, and actions are POSTs with their
// arguments in the path so no body parser is involved.

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { logger, validSessId, generateAutomatedSessId } = require('./utils');

const COOKIE_NAME = 'electron_admin';

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

// Constant-time compare that doesn't leak length via early return.
function safeEqual(a, b) {
    return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function parseCookies(req) {
    const out = {};
    const raw = req.headers?.cookie;
    if (!raw) return out;
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) {
            try { out[k] = decodeURIComponent(v); } catch (_e) { out[k] = v; }
        }
    }
    return out;
}

function isHttps(req) {
    return req.secure || req.header('x-forwarded-proto') === 'https';
}

function remoteIp(req) {
    const fwd = req.header('x-forwarded-for');
    if (fwd) return String(fwd).split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

module.exports = function mountAdminPanel(app, electronState, config, hooks = {}) {
    const adminConfig = config.admin || {};
    if (!adminConfig.password) return false;

    if (String(adminConfig.password).length < 16) {
        logger('[] WARNING: admin.password is shorter than 16 characters. The admin panel is reachable from the public internet - use a long random secret.');
    }

    const sessionHours = adminConfig.sessionHours || 12;
    // Derive the signing key from the password unless one is given, so
    // changing the password invalidates every outstanding cookie.
    const signingKey = sha256(adminConfig.cookieSecret || `electron-admin:${adminConfig.password}`);

    function sign(payload) {
        return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
    }

    function issueCookie(res, req) {
        const exp = Date.now() + sessionHours * 3600 * 1000;
        const payload = Buffer.from(JSON.stringify({ exp }), 'utf8').toString('base64url');
        const value = `${payload}.${sign(payload)}`;
        const attrs = [
            `${COOKIE_NAME}=${value}`,
            'HttpOnly',
            'SameSite=Strict',
            'Path=/admin',
            `Max-Age=${sessionHours * 3600}`
        ];
        if (isHttps(req)) attrs.push('Secure');
        res.setHeader('Set-Cookie', attrs.join('; '));
    }

    function clearCookie(res) {
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
    }

    function isAuthed(req) {
        const raw = parseCookies(req)[COOKIE_NAME];
        if (!raw) return false;
        const dot = raw.lastIndexOf('.');
        if (dot < 1) return false;
        const payload = raw.slice(0, dot);
        const sig = raw.slice(dot + 1);

        const expected = sign(payload);
        // Both are base64url of a sha256 HMAC, so lengths always match here.
        if (sig.length !== expected.length) return false;
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

        try {
            const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            return typeof data.exp === 'number' && data.exp > Date.now();
        } catch (_e) {
            return false;
        }
    }

    // Brute-force protection on the login form only.
    const loginLimiter = rateLimit({
        windowMs: adminConfig.loginWindowMs || 15 * 60 * 1000,
        max: adminConfig.loginMaxAttempts || 10,
        message: 'Too many login attempts, please wait.',
        standardHeaders: true,
        legacyHeaders: false
    });

    function requireAuth(req, res, next) {
        if (isAuthed(req)) return next();
        if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'not authenticated' });
        return res.redirect('/admin');
    }

    // Actions must carry this header.  Combined with SameSite=Strict it means a
    // cross-origin form or image tag can't trigger one.
    function requireActionHeader(req, res, next) {
        if (req.header('x-requested-with') !== 'electron-admin') {
            return res.status(403).json({ ok: false, error: 'bad request origin' });
        }
        return next();
    }

    const router = require('express').Router();

    // ---- login / logout ----

    router.get('/', function (req, res) {
        if (!isAuthed(req)) return res.render('admin-login', { error: null });
        return res.render('admin', { version: hooks.version ? hooks.version() : '' });
    });

    router.post('/login', loginLimiter, function (req, res) {
        const supplied = (req.body && req.body.password) || '';
        if (supplied && safeEqual(supplied, adminConfig.password)) {
            logger('[] ADMIN login success from %s', remoteIp(req));
            issueCookie(res, req);
            return res.redirect('/admin');
        }
        logger('[] ADMIN login FAILED from %s', remoteIp(req));
        return res.status(401).render('admin-login', { error: 'Incorrect password.' });
    });

    router.post('/logout', function (req, res) {
        clearCookie(res);
        return res.redirect('/admin');
    });

    // ---- read ----

    router.get('/api/state', requireAuth, function (req, res) {
        res.json(electronState.getAdminSnapshot());
    });

    // ---- actions ----

    router.post('/api/session/:sessId/end', requireAuth, requireActionHeader, function (req, res) {
        const sessId = req.params.sessId;
        if (!validSessId(sessId)) return res.status(400).json({ ok: false, error: 'invalid session id' });
        logger('[] ADMIN %s requested end of session %s', remoteIp(req), sessId);
        const result = electronState.adminEndSession(sessId);
        res.status(result.ok ? 200 : 404).json(result);
    });

    router.post('/api/session/:sessId/stop-driver', requireAuth, requireActionHeader, function (req, res) {
        const sessId = req.params.sessId;
        if (!validSessId(sessId)) return res.status(400).json({ ok: false, error: 'invalid session id' });
        logger('[] ADMIN %s requested driver stop on %s', remoteIp(req), sessId);
        const result = electronState.adminStopDriver(sessId);
        res.status(result.ok ? 200 : 404).json(result);
    });

    router.post('/api/rider/:socketId/kick', requireAuth, requireActionHeader, function (req, res) {
        const socketId = req.params.socketId;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(socketId)) {
            return res.status(400).json({ ok: false, error: 'invalid socket id' });
        }
        logger('[] ADMIN %s requested kick of rider %s', remoteIp(req), socketId);
        const result = electronState.adminKickRider(socketId);
        res.status(result.ok ? 200 : 404).json(result);
    });

    router.post('/api/playlist/start', requireAuth, requireActionHeader, function (req, res) {
        if (config.playlistSession === undefined) {
            return res.status(400).json({ ok: false, error: 'no playlistSession configured' });
        }
        const sessId = config.playlistSession.sessId;
        if (electronState.automatedDrivers[sessId]) {
            return res.status(409).json({ ok: false, error: 'playlist driver already running' });
        }
        logger('[] ADMIN %s restarting playlist driver %s', remoteIp(req), sessId);
        const ok = electronState.startPlaylistDriver(config.playlistSession);
        res.status(ok ? 200 : 500).json({ ok: !!ok, sessId: sessId });
    });

    router.post('/api/automated/start', requireAuth, requireActionHeader, function (req, res) {
        if (!hooks.buildAutomatedConfig) {
            return res.status(500).json({ ok: false, error: 'automated driver not available' });
        }
        const sessId = generateAutomatedSessId();
        const sessionConfig = hooks.buildAutomatedConfig();
        logger('[] ADMIN %s starting automated session %s', remoteIp(req), sessId);
        const ok = electronState.startAutomatedDriver(sessId, sessionConfig);
        res.status(ok ? 200 : 500).json({ ok: !!ok, sessId: sessId });
    });

    app.use('/admin', router);
    logger('[] Admin panel mounted at /admin (session length %dh)', sessionHours);
    return true;
};
