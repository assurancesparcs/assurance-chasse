/**
 * Vercel serverless function — Réception d'une déclaration de sinistre
 * POST /api/claim-submit
 *
 * Variables d'env requises :
 *   - GMAIL_USER, GMAIL_APP_PASSWORD
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

function validate(claim) {
  if (!claim || typeof claim !== 'object') return 'Payload invalide';
  if (!isValidEmail(claim.email)) return 'Email invalide';
  if (typeof claim.nom !== 'string' || claim.nom.length < 1 || claim.nom.length > 100) return 'Nom invalide';
  if (typeof claim.ref !== 'string' || claim.ref.length < 3 || claim.ref.length > 50) return 'Référence invalide';
  if (typeof claim.desc !== 'string' || claim.desc.length < 5 || claim.desc.length > 5000) return 'Description invalide (5–5000 caractères)';
  if (claim.tel && !/^[+\d\s().-]{6,30}$/.test(claim.tel)) return 'Téléphone invalide';
  if (claim.prenom && (typeof claim.prenom !== 'string' || claim.prenom.length > 100)) return 'Prénom invalide';
  if (claim.tiers && (typeof claim.tiers !== 'string' || claim.tiers.length > 1000)) return 'Champ tiers invalide';
  if (claim.date_sin && (typeof claim.date_sin !== 'string' || claim.date_sin.length > 30)) return 'Date invalide';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const claim = req.body || {};

  // Anti-bot honeypot : retour silencieux.
  if (isHoneypotFilled(claim, 'website')) {
    console.warn('Honeypot rempli sur claim-submit, requête ignorée', { ip: getClientIp(req) });
    return res.status(200).json({ received: true, ref: 'IGNORED' });
  }

  // Rate limit : 2 sinistres max / 10 min par IP
  const ip = getClientIp(req);
  const rl = rateLimit('claim', ip, 10 * 60 * 1000, 2);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `Trop de déclarations envoyées. Réessayez dans ${rl.retryAfter} secondes.` });
  }

  const validationErr = validate(claim);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const fdc = FDC_CODE[claim.department] || '';
  const safeRef = sanitizeHeader(claim.ref);
  const safeNom = sanitizeHeader(claim.nom);
  const safePrenom = sanitizeHeader(claim.prenom || '');

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    // Email interne au cabinet
    await transporter.sendMail({
      from: `"Notifications site ADC&E" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      replyTo: claim.email,
      subject: `[SINISTRE ${fdc}] ${safeRef} — ${safeNom} ${safePrenom}`.trim(),
      html: `
        <h3>Nouvelle déclaration de sinistre</h3>
        <p><strong>Référence dossier :</strong> ${escHtml(claim.ref)}</p>
        <p><strong>Département :</strong> ${escHtml(claim.department || '—')} ${fdc ? `(${fdc})` : ''}</p>
        <hr>
        <p><strong>Déclarant :</strong> ${escHtml(claim.prenom || '')} ${escHtml(claim.nom)}<br>
        <strong>Email :</strong> ${escHtml(claim.email)}<br>
        <strong>Téléphone :</strong> ${escHtml(claim.tel || '—')}</p>
        <hr>
        <p><strong>Date du sinistre :</strong> ${escHtml(claim.date_sin || '—')}</p>
        <p><strong>Description :</strong><br>${escHtml(claim.desc).replace(/\n/g, '<br>')}</p>
        <p><strong>Tiers impliqués :</strong> ${escHtml(claim.tiers || '—')}</p>
      `,
    });

    // Accusé de réception au déclarant
    await transporter.sendMail({
      from: `"Cabinet ADC&E Assurances" <${process.env.GMAIL_USER}>`,
      to: claim.email,
      replyTo: process.env.GMAIL_USER,
      subject: `Accusé de réception — Déclaration de sinistre ${safeRef}`,
      html: `
        <p>Bonjour ${escHtml(claim.prenom || '')},</p>
        <p>Nous accusons bonne réception de votre déclaration de sinistre.</p>
        <p><strong>Numéro de dossier :</strong> ${escHtml(claim.ref)}<br>
        <strong>Date du sinistre :</strong> ${escHtml(claim.date_sin || '—')}</p>
        <p>Un gestionnaire prendra contact avec vous sous <strong>48h ouvrées</strong> pour le suivi de votre dossier.</p>
        <p>Si vous avez des éléments complémentaires (photos, témoignages, certificat médical…), vous pouvez les transmettre directement par retour d'email.</p>
        <p>Cordialement,<br>
        Cabinet ADC&amp;E Assurances<br>
        ☎ 0 800 014 033</p>
      `,
    });

    console.log('Sinistre traité', { ref: claim.ref, fdc });
    return res.status(200).json({ received: true, ref: claim.ref });
  } catch (err) {
    console.error('Erreur envoi emails sinistre', err);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi de la déclaration' });
  }
};
