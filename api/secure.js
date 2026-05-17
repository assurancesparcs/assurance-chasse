/**
 * Endpoint unifié pour l'espace privé (Gironde).
 * Toutes les opérations passent par /api/secure?action=<action>
 *
 * Actions :
 *   login    POST  ?action=login        body JSON {email, password}
 *   logout   POST  ?action=logout
 *   list     GET   ?action=list
 *   upload   POST  ?action=upload&filename=...  body = binaire brut
 *   download GET   ?action=download&key=...
 *   delete   POST  ?action=delete       body JSON {key}
 *   cleanup  GET   ?action=cleanup      Header: Authorization: Bearer CRON_SECRET
 *   debug    GET   ?action=debug        (auth requise) — liste env vars sans valeurs
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { put, list, del, head } = require('@vercel/blob');
const nodemailer = require('nodemailer');
const { getClientIp, rateLimit } = require('./_security');

module.exports.config = { api: { bodyParser: false } };

const COOKIE_NAME = 'adce_secure_session';
const SESSION_DURATION_SEC = 60 * 60;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.csv', '.docx', '.doc', '.txt', '.zip'];
const RETENTION_DAYS = 2 * 365;

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

function getRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (maxBytes && total > maxBytes) {
        req.destroy();
        reject(new Error('Payload trop volumineux'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await getRawBody(req, 1024 * 1024); // 1 Mo max pour JSON
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return {}; }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${SESSION_DURATION_SEC}`,
  ].join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
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
  } catch (_) { return null; }
}

function requireAuth(req, res) {
  const session = verifySession(parseCookies(req)[COOKIE_NAME]);
  if (!session) { res.status(401).json({ error: 'Non authentifié' }); return null; }
  return session;
}

function logAccess(action, req, extra) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  console.log('[ESPACE_SECURISE]', new Date().toISOString(), action, { ip, ...extra });
}

function sanitizeFilename(name) {
  return String(name || 'fichier').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

async function notifyOtherUsers(uploaderEmail, filename, size) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
  const others = getUsers().map((u) => u.email).filter((e) => e.toLowerCase() !== uploaderEmail.toLowerCase());
  if (others.length === 0) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const sizeMb = (size / 1024 / 1024).toFixed(2);
  await transporter.sendMail({
    from: `"Espace privé ADC&E" <${process.env.GMAIL_USER}>`,
    to: others.join(', '),
    subject: `[Espace privé] Nouveau fichier déposé : ${filename}`,
    html: `<p>Bonjour,</p>
      <p>Un nouveau fichier vient d'être déposé sur l'espace privé du Cabinet ADCE par <strong>${uploaderEmail}</strong>.</p>
      <p><strong>Fichier :</strong> ${filename}<br><strong>Taille :</strong> ${sizeMb} Mo<br>
      <strong>Date :</strong> ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</p>
      <p>Connectez-vous : <a href="https://www.assurancechasse33.fr/espace-securise">www.assurancechasse33.fr/espace-securise</a></p>
      <p>Cordialement,<br>Cabinet ADC&amp;E Assurances</p>`,
  });
}

// === Actions ===

async function actionLogin(req, res) {
  const ip = getClientIp(req);
  const rl = rateLimit('secure-login', ip, 15 * 60 * 1000, 5);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${rl.retryAfter} secondes.` });
  }
  const body = await readJsonBody(req);
  const { email, password } = body;
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 200) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }
  const normalized = email.trim().toLowerCase();
  const user = getUsers().find((u) => u.email.toLowerCase() === normalized);
  if (!user) {
    await bcrypt.compare(password, '$2a$10$00000000000000000000000000000000000000000000000000000');
    logAccess('LOGIN_FAILED', req, { email: normalized.slice(0, 50) });
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }
  const ok = await bcrypt.compare(password, user.hash);
  if (!ok) {
    logAccess('LOGIN_FAILED', req, { email: user.email });
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }
  setSessionCookie(res, signSession({ email: user.email }));
  logAccess('LOGIN_OK', req, { email: user.email });
  return res.status(200).json({ ok: true, email: user.email });
}

async function actionLogout(req, res) {
  clearSessionCookie(res);
  logAccess('LOGOUT', req, {});
  return res.status(200).json({ ok: true });
}

async function actionList(req, res, session) {
  const result = await list({ prefix: 'espace-securise/' });
  const files = (result.blobs || []).map((b) => ({
    key: b.pathname,
    url: b.url,
    size: b.size,
    uploadedAt: b.uploadedAt,
    displayName: b.pathname.replace(/^espace-securise\//, '').replace(/^\d{13}-/, ''),
  })).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  logAccess('LIST', req, { count: files.length, email: session.email });
  return res.status(200).json({ files, email: session.email });
}

async function actionUpload(req, res, session, urlObj) {
  const rawName = urlObj.searchParams.get('filename') || 'fichier';
  const filename = sanitizeFilename(rawName);
  const ext = '.' + filename.split('.').pop().toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: `Extension non autorisée. Acceptées : ${ALLOWED_EXTENSIONS.join(', ')}` });
  }
  const body = await getRawBody(req, MAX_FILE_SIZE);
  if (body.length === 0) return res.status(400).json({ error: 'Fichier vide' });
  const blobName = `espace-securise/${Date.now()}-${filename}`;
  const blob = await put(blobName, body, {
    access: 'public',
    addRandomSuffix: false,
    contentType: req.headers['content-type'] || 'application/octet-stream',
  });
  logAccess('UPLOAD', req, { email: session.email, filename, size: body.length });
  notifyOtherUsers(session.email, filename, body.length).catch((err) => console.error('Notification email échouée', err));
  return res.status(200).json({ ok: true, key: blob.pathname, url: blob.url });
}

async function actionDownload(req, res, session, urlObj) {
  const key = urlObj.searchParams.get('key');
  if (!key || !key.startsWith('espace-securise/')) return res.status(400).json({ error: 'Clé invalide' });
  const blob = await head(key);
  if (!blob) return res.status(404).json({ error: 'Fichier introuvable' });
  const upstream = await fetch(blob.url);
  if (!upstream.ok) return res.status(502).json({ error: 'Erreur récupération fichier' });
  const filename = key.replace(/^espace-securise\/\d+-/, '');
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  logAccess('DOWNLOAD', req, { email: session.email, key });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  return res.status(200).send(buffer);
}

async function actionDelete(req, res, session) {
  const body = await readJsonBody(req);
  const { key } = body;
  if (typeof key !== 'string' || !key.startsWith('espace-securise/')) return res.status(400).json({ error: 'Clé invalide' });
  const blob = await head(key);
  if (!blob) return res.status(404).json({ error: 'Fichier introuvable' });
  await del(blob.url);
  logAccess('DELETE', req, { email: session.email, key });
  return res.status(200).json({ ok: true });
}

async function actionCleanup(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  const errors = [];
  const result = await list({ prefix: 'espace-securise/' });
  for (const blob of result.blobs || []) {
    if (new Date(blob.uploadedAt).getTime() < cutoff) {
      try { await del(blob.url); deleted += 1; }
      catch (e) { errors.push({ key: blob.pathname, error: e.message }); }
    }
  }
  console.log(`[CLEANUP] ${new Date().toISOString()} — ${deleted} supprimés`);
  return res.status(200).json({ ok: true, deleted, errors });
}

async function actionDebug(req, res) {
  const all = Object.keys(process.env).sort();
  return res.status(200).json({
    blobVarsFound: all.filter((k) => k.includes('BLOB')),
    secureVarsFound: all.filter((k) => k.startsWith('SECURE_') || k === 'JWT_SECRET' || k === 'CRON_SECRET'),
    gmailVarsFound: all.filter((k) => k.startsWith('GMAIL_')),
    totalEnvVarsCount: all.length,
    nodeVersion: process.version,
    vercelRegion: process.env.VERCEL_REGION || 'unknown',
  });
}

// === Dispatcher ===

module.exports = async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const action = urlObj.searchParams.get('action');

    // Actions sans auth
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      return await actionLogin(req, res);
    }
    if (action === 'logout') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      return await actionLogout(req, res);
    }
    if (action === 'cleanup') {
      return await actionCleanup(req, res);
    }

    // Actions avec auth
    const session = requireAuth(req, res);
    if (!session) return;

    if (action === 'list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return await actionList(req, res, session);
    }
    if (action === 'upload') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      return await actionUpload(req, res, session, urlObj);
    }
    if (action === 'download') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return await actionDownload(req, res, session, urlObj);
    }
    if (action === 'delete') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      return await actionDelete(req, res, session);
    }
    if (action === 'debug') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return await actionDebug(req, res);
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (err) {
    console.error('Erreur /api/secure', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
