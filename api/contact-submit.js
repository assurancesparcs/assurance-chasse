/**
 * Vercel serverless function — Réception d'un message de contact
 * POST /api/contact-submit
 */

const nodemailer = require('nodemailer');
const { getClientIp, rateLimit, isHoneypotFilled } = require('./_security');

const FDC_CODE = {
  gironde: 'FDC33',
  calvados: 'FDC14',
  dordogne: 'FDC24',
  'lot-et-garonne': 'FDC47',
};

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeHeader(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t\0]/g, ' ').slice(0, 200).trim();
}

function isValidEmail(s) {
  return typeof s === 'string'
    && s.length <= 254
    && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(s);
}

function validate(msg) {
  if (!msg || typeof msg !== 'object') return 'Payload invalide';
  if (!isValidEmail(msg.email)) return 'Email invalide';
  if (typeof msg.nom !== 'string' || msg.nom.length < 1 || msg.nom.length > 100) return 'Nom invalide';
  if (typeof msg.objet !== 'string' || msg.objet.length < 2 || msg.objet.length > 200) return 'Objet invalide';
  if (typeof msg.message !== 'string' || msg.message.length < 5 || msg.message.length > 5000) return 'Message invalide (5–5000 caractères)';
  if (msg.tel && !/^[+\d\s().-]{6,30}$/.test(msg.tel)) return 'Téléphone invalide';
  if (msg.prenom && (typeof msg.prenom !== 'string' || msg.prenom.length > 100)) return 'Prénom invalide';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const msg = req.body || {};

  // Anti-bot honeypot : on retourne 200 silencieusement pour ne pas tipper le bot.
  if (isHoneypotFilled(msg, 'website')) {
    console.warn('Honeypot rempli sur contact-submit, requête ignorée', { ip: getClientIp(req) });
    return res.status(200).json({ received: true });
  }

  // Rate limit : 3 envois max / 5 min par IP
  const ip = getClientIp(req);
  const rl = rateLimit('contact', ip, 5 * 60 * 1000, 3);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `Trop de messages envoyés. Réessayez dans ${rl.retryAfter} secondes.` });
  }

  const validationErr = validate(msg);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const fdc = FDC_CODE[msg.department] || '';
  const subject = sanitizeHeader(
    `[Formulaire de contact] ${msg.objet} — ${msg.nom} ${msg.prenom || ''} ${fdc}`
  );

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"Site ADC&E Chasse" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      replyTo: msg.email,
      subject,
      html: `
        <h3>Nouveau message via formulaire de contact</h3>
        <p><strong>De :</strong> ${escHtml(msg.prenom || '')} ${escHtml(msg.nom)} &lt;${escHtml(msg.email)}&gt;</p>
        <p><strong>Téléphone :</strong> ${escHtml(msg.tel || '—')}</p>
        <p><strong>Département :</strong> ${escHtml(msg.department || '—')} ${fdc ? `(${fdc})` : ''}</p>
        <p><strong>Objet :</strong> ${escHtml(msg.objet)}</p>
        <hr>
        <p><strong>Message :</strong></p>
        <p>${escHtml(msg.message).replace(/\n/g, '<br>')}</p>
      `,
    });

    console.log('Contact email envoyé', { objet: msg.objet, fdc });
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erreur envoi email contact', err);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi du message' });
  }
};
