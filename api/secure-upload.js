/**
 * POST /api/secure-upload?filename=<nom>
 * Auth requis. Body = bytes bruts du fichier.
 * Stocke dans Vercel Blob sous "espace-securise/<timestamp>-<nom>".
 * Envoie une notification email à TOUS les utilisateurs autorisés.
 */

const { put } = require('@vercel/blob');
const nodemailer = require('nodemailer');
const { requireAuth, logAccess, getUsers } = require('./_secure-auth');

module.exports.config = {
  api: { bodyParser: false },
};

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.csv', '.docx', '.doc', '.txt', '.zip'];

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_FILE_SIZE) {
        req.destroy();
        reject(new Error('Fichier trop volumineux (max 50 Mo)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sanitizeFilename(name) {
  return String(name || 'fichier')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
}

async function notifyOtherUsers(uploaderEmail, filename, size) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('GMAIL non configuré, pas de notification envoyée');
    return;
  }
  const others = getUsers()
    .map((u) => u.email)
    .filter((e) => e.toLowerCase() !== uploaderEmail.toLowerCase());
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
    html: `
      <p>Bonjour,</p>
      <p>Un nouveau fichier vient d'être déposé sur l'espace privé du Cabinet ADCE par <strong>${uploaderEmail}</strong>.</p>
      <p><strong>Fichier :</strong> ${filename}<br>
      <strong>Taille :</strong> ${sizeMb} Mo<br>
      <strong>Date :</strong> ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</p>
      <p>Connectez-vous à votre espace pour le consulter : <a href="https://www.assurancechasse33.fr/espace-securise">www.assurancechasse33.fr/espace-securise</a></p>
      <p>Cordialement,<br>Cabinet ADC&amp;E Assurances</p>
    `,
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = requireAuth(req, res);
  if (!session) return;

  // Filename via query string
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const rawName = urlObj.searchParams.get('filename') || 'fichier';
  const filename = sanitizeFilename(rawName);
  const ext = '.' + filename.split('.').pop().toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: `Extension non autorisée. Acceptées : ${ALLOWED_EXTENSIONS.join(', ')}` });
  }

  try {
    const body = await getRawBody(req);
    if (body.length === 0) {
      return res.status(400).json({ error: 'Fichier vide' });
    }

    const blobName = `espace-securise/${Date.now()}-${filename}`;
    const blob = await put(blobName, body, {
      access: 'public', // on protège l'URL par obscurité + auth dans /secure-download
      addRandomSuffix: false,
      contentType: req.headers['content-type'] || 'application/octet-stream',
    });

    logAccess('UPLOAD', req, { email: session.email, filename, size: body.length });

    // Notification email (best effort, ne bloque pas la réponse)
    notifyOtherUsers(session.email, filename, body.length).catch((err) => {
      console.error('Notification email échouée', err);
    });

    return res.status(200).json({ ok: true, key: blob.pathname, url: blob.url });
  } catch (err) {
    console.error('Erreur secure-upload', err);
    const msg = err && err.message && err.message.includes('volumineux')
      ? err.message
      : 'Erreur lors du téléversement';
    return res.status(500).json({ error: msg });
  }
};
