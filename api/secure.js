/**
 * Endpoint unifié pour l'espace privé (Gironde) — stockage Vercel Blob.
 *
 * Actions :
 *   login    POST  ?action=login        body JSON {email, password}
 *   logout   POST  ?action=logout
 *   list     GET   ?action=list
 *   upload   POST  ?action=upload&filename=...  body = binaire brut
 *   download GET   ?action=download&key=...
 *   delete   POST  ?action=delete       body JSON {key}
 *   cleanup  GET   ?action=cleanup      Header: Authorization: Bearer CRON_SECRET
 *   debug    GET   ?action=debug        (auth requise)
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { put, list, del, head } = require('@vercel/blob');
const nodemailer = require('nodemailer');
const { getClientIp, rateLimit } = require('./_security');

/**
 * Normalisation de l'identifiant de store pour le SDK @vercel/blob.
 *
 * Vercel a 2 modes de connexion d'un Blob store à un projet :
 *  - CLASSIQUE : injecte la variable BLOB_READ_WRITE_TOKEN. Le SDK l'utilise seul.
 *  - OIDC (2025+) : injecte au RUNTIME VERCEL_OIDC_TOKEN (un JWT court, NON visible
 *    dans la liste des Environment Variables de l'UI) + l'ID du store sous le nom
 *    BLOB_READ_WRITE_TOKEN_STORE_ID. Le SDK, lui, cherche l'ID sous BLOB_STORE_ID.
 *
 * On aliase donc BLOB_STORE_ID dès le chargement du module : ainsi le SDK détecte
 * le store et lit automatiquement VERCEL_OIDC_TOKEN pour s'authentifier en OIDC.
 */
if (!process.env.BLOB_STORE_ID && process.env.BLOB_READ_WRITE_TOKEN_STORE_ID) {
  process.env.BLOB_STORE_ID = process.env.BLOB_READ_WRITE_TOKEN_STORE_ID;
}

/**
 * Options d'auth Blob passées explicitement à chaque appel SDK.
 *  - Mode classique (token présent) → {} : le SDK gère seul.
 *  - Mode OIDC → { storeId, oidcToken } EXPLICITES (oidcToken, PAS token : le JWT OIDC
 *    ne doit jamais être passé sous "token" qui attend un vercel_blob_rw_...).
 */
function blobOpts() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return {};
  const opts = {};
  const storeId = process.env.BLOB_STORE_ID
    || process.env.BLOB_READ_WRITE_TOKEN_STORE_ID
    || '';
  if (storeId) opts.storeId = storeId;
  if (process.env.VERCEL_OIDC_TOKEN) opts.oidcToken = process.env.VERCEL_OIDC_TOKEN;
  return opts;
}

module.exports.config = { api: { bodyParser: false } };

const COOKIE_NAME = 'adce_secure_session';
const SESSION_DURATION_SEC = 60 * 60;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.csv', '.docx', '.doc', '.txt', '.zip'];
const RETENTION_DAYS = 2 * 365;
const BLOB_PREFIX = 'espace-securise/';

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
  const buf = await getRawBody(req, 1024 * 1024);
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
    'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict',
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
  const result = await list({ prefix: BLOB_PREFIX, ...blobOpts() });
  const files = (result.blobs || []).map((b) => ({
    key: b.pathname,
    url: b.url,
    size: b.size,
    uploadedAt: b.uploadedAt,
    displayName: b.pathname.replace(new RegExp('^' + BLOB_PREFIX), '').replace(/^\d{13}-/, ''),
  })).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  logAccess('LIST', req, { count: files.length, email: session.email });
  return res.status(200).json({ files, email: session.email, isAdmin: isAdminSession(session) });
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
  const blobName = `${BLOB_PREFIX}${Date.now()}-${filename}`;
  const blob = await put(blobName, body, {
    access: 'public',
    addRandomSuffix: false,
    contentType: req.headers['content-type'] || 'application/octet-stream',
    ...blobOpts(),
  });
  logAccess('UPLOAD', req, { email: session.email, filename, size: body.length });
  notifyOtherUsers(session.email, filename, body.length).catch((err) => console.error('Notification email échouée', err));
  return res.status(200).json({ ok: true, key: blob.pathname, url: blob.url });
}

async function actionDownload(req, res, session, urlObj) {
  const key = urlObj.searchParams.get('key');
  if (!key || !key.startsWith(BLOB_PREFIX)) return res.status(400).json({ error: 'Clé invalide' });
  const blob = await head(key, blobOpts());
  if (!blob) return res.status(404).json({ error: 'Fichier introuvable' });
  const upstream = await fetch(blob.url);
  if (!upstream.ok) return res.status(502).json({ error: 'Erreur récupération fichier' });
  const filename = key.replace(new RegExp('^' + BLOB_PREFIX + '\\d+-'), '');
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
  if (typeof key !== 'string' || !key.startsWith(BLOB_PREFIX)) return res.status(400).json({ error: 'Clé invalide' });
  const blob = await head(key, blobOpts());
  if (!blob) return res.status(404).json({ error: 'Fichier introuvable' });
  await del(blob.url, blobOpts());
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
  const result = await list({ prefix: BLOB_PREFIX, ...blobOpts() });
  for (const blob of result.blobs || []) {
    if (new Date(blob.uploadedAt).getTime() < cutoff) {
      try { await del(blob.url, blobOpts()); deleted += 1; }
      catch (e) { errors.push({ key: blob.pathname, error: e.message }); }
    }
  }
  console.log(`[CLEANUP] ${new Date().toISOString()} — ${deleted} supprimés`);
  return res.status(200).json({ ok: true, deleted, errors });
}

// === EXPORT CSV des souscriptions (archivées dans Blob par le webhook Stripe) ===

const SOUSCRIPTIONS_PREFIX = 'souscriptions/';
const ATTESTATIONS_PREFIX = 'attestations/';

/**
 * Vérifie que la session courante est User1 (admin) — seul autorisé à voir les souscriptions.
 * User2 n'a accès qu'aux fichiers déposés / téléchargements.
 */
function isAdminSession(session) {
  const adminEmail = (process.env.SECURE_USER1_EMAIL || '').trim().toLowerCase();
  return session && adminEmail && session.email && session.email.toLowerCase() === adminEmail;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",;\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function actionExportSouscriptionsCsv(req, res, session) {
  if (!isAdminSession(session)) {
    logAccess('EXPORT_CSV_FORBIDDEN', req, { email: session.email });
    return res.status(403).json({ error: 'Accès réservé à l\'administrateur du cabinet.' });
  }
  const result = await list({ prefix: SOUSCRIPTIONS_PREFIX, ...blobOpts() });
  const blobs = (result.blobs || []).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  // Téléchargement parallèle des JSON
  const records = await Promise.all(blobs.map(async (b) => {
    try {
      const r = await fetch(b.url);
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }));

  const cols = [
    'Date paiement', 'N° Police', 'Département', 'FDC', 'Saison',
    'Nom', 'Prénom', 'Email', 'Téléphone', 'Date naissance', 'Adresse postale', 'N° Permis',
    'Options', 'Nb petits', 'Nb gros', 'Détail chiens',
    'Type installation', 'Surface m²', 'Matériau', 'Adresse installation',
    'Latitude', 'Longitude', 'Google Maps',
    'Montant €', 'Stripe Session ID',
  ];

  const lines = [cols.join(';')];
  for (const rec of records) {
    if (!rec) continue;
    const opts = (rec.options || []).join(' + ');
    const chiensDetail = (rec.chiens || []).map((c) =>
      `${c.nom || ''} (${c.race || ''}, ${c.age || ''} ans, ${c.type || ''}, ${c.identification || ''})`
    ).join(' | ');
    const ins = rec.installation || {};
    const nbPetit = (rec.chiens || []).filter((c) => c.type === 'petit').length;
    const nbGros = (rec.chiens || []).filter((c) => c.type === 'gros').length;
    const cust = rec.customer || {};
    lines.push([
      rec.dateFr || '',
      rec.policyNumber || '',
      rec.department || '',
      rec.fdc || '',
      rec.saison || '',
      cust.nom || '',
      cust.prenom || '',
      cust.email || '',
      cust.tel || '',
      cust.ddn || '',
      cust.adressePostale || '',
      cust.npermis || '',
      opts,
      nbPetit,
      nbGros,
      chiensDetail,
      ins.type || '',
      ins.surface || '',
      ins.materiau || '',
      ins.adresse || '',
      ins.lat || '',
      ins.lng || '',
      ins.googleMaps || '',
      rec.montantTotal || 0,
      rec.stripeSessionId || '',
    ].map(csvEscape).join(';'));
  }

  // BOM UTF-8 pour qu'Excel ouvre les accents correctement
  const csv = '﻿' + lines.join('\r\n');
  const filename = `souscriptions-adce-${new Date().toISOString().slice(0, 10)}.csv`;
  logAccess('EXPORT_CSV', req, { email: session.email, count: records.filter(Boolean).length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  return res.status(200).send(csv);
}

async function actionListAttestations(req, res, session) {
  if (!isAdminSession(session)) {
    return res.status(403).json({ error: 'Accès réservé à l\'administrateur du cabinet.' });
  }
  const [souscriptions, attestations] = await Promise.all([
    list({ prefix: SOUSCRIPTIONS_PREFIX, ...blobOpts() }),
    list({ prefix: ATTESTATIONS_PREFIX, ...blobOpts() }),
  ]);
  const attestMap = new Map();
  for (const b of attestations.blobs || []) {
    const name = b.pathname.replace(ATTESTATIONS_PREFIX, '').replace(/\.pdf$/, '');
    attestMap.set(name, { url: b.url, size: b.size });
  }
  const items = [];
  for (const b of souscriptions.blobs || []) {
    try {
      const r = await fetch(b.url);
      if (!r.ok) continue;
      const rec = await r.json();
      const key = b.pathname.replace(SOUSCRIPTIONS_PREFIX, '').replace(/\.json$/, '');
      const att = attestMap.get(key);
      items.push({
        policyNumber: rec.policyNumber || '',
        dateFr: rec.dateFr || '',
        department: rec.department || '',
        nom: (rec.customer || {}).nom || '',
        prenom: (rec.customer || {}).prenom || '',
        email: (rec.customer || {}).email || '',
        montant: rec.montantTotal || 0,
        options: (rec.options || []).join(' + '),
        attestationUrl: att ? att.url : null,
        attestationSize: att ? att.size : null,
      });
    } catch (_) {}
  }
  items.sort((a, b) => (b.dateFr || '').localeCompare(a.dateFr || ''));
  logAccess('LIST_ATTESTATIONS', req, { email: session.email, count: items.length });
  return res.status(200).json({ items, email: session.email });
}

async function actionDebug(req, res) {
  const all = Object.keys(process.env).sort();
  const tokenVar = process.env.BLOB_READ_WRITE_TOKEN || '';
  const tokenLen = tokenVar.length;
  const tokenPrefix = tokenLen > 0 ? tokenVar.slice(0, 30) + '...' : '(absent)';

  // Tente une op simple sur Blob pour capturer l'erreur exacte
  let blobTest = { ok: false, error: null };
  try {
    const r = await list({ prefix: BLOB_PREFIX, limit: 1, ...blobOpts() });
    blobTest = { ok: true, foundCount: (r.blobs || []).length, cursor: r.cursor || null };
  } catch (e) {
    blobTest = { ok: false, error: e.message, name: e.name, status: e.status || null };
  }

  const resolved = blobOpts();
  return res.status(200).json({
    blobVarsFound: all.filter((k) => k.includes('BLOB')),
    blobTokenLength: tokenLen,
    blobTokenPrefix: tokenPrefix,
    oidcTokenPresent: !!process.env.VERCEL_OIDC_TOKEN,
    oidcTokenLength: (process.env.VERCEL_OIDC_TOKEN || '').length,
    storeIdResolved: process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN_STORE_ID || '(absent)',
    blobOptsUsed: {
      mode: process.env.BLOB_READ_WRITE_TOKEN ? 'classique (token statique)'
            : (resolved.oidcToken ? 'OIDC (oidcToken+storeId)' : 'AUCUN credential disponible'),
      hasStoreId: !!resolved.storeId,
      hasOidcToken: !!resolved.oidcToken,
    },
    blobOperation: blobTest,
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
    if (action === 'export-souscriptions-csv') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return await actionExportSouscriptionsCsv(req, res, session);
    }
    if (action === 'list-attestations') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return await actionListAttestations(req, res, session);
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (err) {
    console.error('Erreur /api/secure', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
};
