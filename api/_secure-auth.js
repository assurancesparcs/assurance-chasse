/**
 * Helpers d'authentification pour la zone privée Gironde.
 *
 * Variables d'env requises (sur le projet Vercel Gironde uniquement) :
 *  - SECURE_USER1_EMAIL, SECURE_USER1_HASH  (bcrypt hash)
 *  - SECURE_USER2_EMAIL, SECURE_USER2_HASH  (bcrypt hash)
 *  - JWT_SECRET                              (32+ caractères aléatoires)
 *  - BLOB_READ_WRITE_TOKEN                   (auto-généré par Vercel Blob)
 *  - CRON_SECRET                             (random, vérifié dans le cron)
 *  - GMAIL_USER, GMAIL_APP_PASSWORD          (déjà existants)
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'adce_secure_session';
const SESSION_DURATION_SEC = 60 * 60; // 1h

function getUsers() {
  const users = [];
  if (process.env.SECURE_USER1_EMAIL && process.env.SECURE_USER1_HASH) {
    users.push({ email: process.env.SECURE_USER1_EMAIL, hash: process.env.SECURE_USER1_HASH });
  }
  if (process.env.SECURE_USER2_EMAIL && process.env.SECURE_USER2_HASH) {
    users.push({ email: process.env.SECURE_USER2_EMAIL, hash: process.env.SECURE_USER2_HASH });
  }
  return users;
}

async function verifyCredentials(email, password) {
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  const user = getUsers().find((u) => u.email.toLowerCase() === normalized);
  if (!user) {
    // Compare anyway against a dummy hash pour éviter le timing leak (user existe ou pas)
    await bcrypt.compare(password, '$2a$10$00000000000000000000000000000000000000000000000000000');
    return null;
  }
  const ok = await bcrypt.compare(password, user.hash);
  return ok ? { email: user.email } : null;
}

function signSession(user) {
  return jwt.sign({ email: user.email }, process.env.JWT_SECRET, {
    expiresIn: SESSION_DURATION_SEC,
    audience: 'adce-espace-securise',
    issuer: 'assurancechasse33.fr',
  });
}

function verifySession(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET, {
      audience: 'adce-espace-securise',
      issuer: 'assurancechasse33.fr',
    });
  } catch (_) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

function setSessionCookie(res, token) {
  const cookie = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${SESSION_DURATION_SEC}`,
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
  );
}

function requireAuth(req, res) {
  const cookies = parseCookies(req);
  const session = verifySession(cookies[COOKIE_NAME]);
  if (!session) {
    res.status(401).json({ error: 'Non authentifié' });
    return null;
  }
  return session;
}

function logAccess(action, req, extra) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ua = (req.headers['user-agent'] || '').slice(0, 120);
  console.log('[ESPACE_SECURISE]', new Date().toISOString(), action, { ip, ua, ...extra });
}

module.exports = {
  COOKIE_NAME,
  SESSION_DURATION_SEC,
  verifyCredentials,
  signSession,
  verifySession,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  logAccess,
  getUsers,
};
