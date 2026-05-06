/**
 * Vercel serverless function — Webhook Stripe
 * Endpoint : POST /api/stripe-webhook
 *
 * Variables d'env requises :
 *   - STRIPE_SECRET_KEY
 *   - STRIPE_WEBHOOK_SECRET
 *   - GMAIL_USER, GMAIL_APP_PASSWORD
 */
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const FDC_CODE = {
  gironde: 'FDC33',
  calvados: 'FDC14',
  dordogne: 'FDC24',
  'lot-et-garonne': 'FDC47',
};

const OPTION_LABEL = {
  sec: 'Sécurité chasse (assurance corporelle)',
  chi: 'Chiens de chasse',
};

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeHeader(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t\0]/g, ' ').slice(0, 200).trim();
}

module.exports.config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function formatOptions(optionsCsv) {
  if (!optionsCsv) return '—';
  return optionsCsv
    .split(',')
    .map((o) => OPTION_LABEL[o.trim()] || o.trim())
    .join(', ');
}

function formatChiens(chiensJson) {
  if (!chiensJson) return '';
  try {
    const chiens = JSON.parse(chiensJson);
    if (!Array.isArray(chiens) || chiens.length === 0) return '';
    return (
      '<p><strong>Chiens assurés :</strong></p><ul>' +
      chiens
        .map((c) => {
          const typeLabel = c.type === 'petit' ? 'petit gibier' : (c.type === 'gros' ? 'gros gibier' : '—');
          return `<li>${escHtml(c.nom || '—')} (${escHtml(c.race || '—')}, ${escHtml(c.age || '?')} ans, ${escHtml(typeLabel)}, n° ${escHtml(c.identification || '—')})</li>`;
        })
        .join('') +
      '</ul>'
    );
  } catch (_) {
    return '';
  }
}

async function sendEmails(session, metadata) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const amount = session.amount_total / 100;
  const fdc = FDC_CODE[metadata.department] || '';
  const optionsLabel = formatOptions(metadata.options);
  const chiensHtml = formatChiens(metadata.chiens_data);

  // Email client
  await transporter.sendMail({
    from: `"Cabinet ADC&E Assurances" <${process.env.GMAIL_USER}>`,
    to: session.customer_email,
    replyTo: process.env.GMAIL_USER,
    subject: sanitizeHeader(`Confirmation de votre souscription assurance chasse — saison ${metadata.saison || ''}`),
    html: `
      <p>Bonjour ${escHtml(metadata.prenom || '')},</p>
      <p>Nous confirmons votre souscription d'assurance chasse pour la saison <strong>${escHtml(metadata.saison || '—')}</strong>.</p>
      <p><strong>Montant réglé :</strong> ${amount} €<br>
      <strong>Options souscrites :</strong> ${optionsLabel}<br>
      <strong>N° de permis :</strong> ${escHtml(metadata.npermis || '—')}</p>
      ${chiensHtml}
      <p>Votre attestation officielle vous parviendra par email dans les minutes qui suivent.</p>
      <p>Pour toute question, vous pouvez nous joindre à <a href="mailto:${escHtml(process.env.GMAIL_USER)}">${escHtml(process.env.GMAIL_USER)}</a>.</p>
      <p>Cordialement,<br>Cabinet ADC&amp;E Assurances</p>
    `,
  });

  // Email interne
  await transporter.sendMail({
    from: `"Notifications site ADC&E" <${process.env.GMAIL_USER}>`,
    to: process.env.GMAIL_USER,
    subject: sanitizeHeader(`[PAIEMENT ${fdc}] ${metadata.nom || ''} ${metadata.prenom || ''} — ${amount} €`),
    html: `
      <h3>Nouvelle souscription confirmée</h3>
      <p><strong>Département :</strong> ${escHtml(metadata.department || '—')} ${fdc ? `(${fdc})` : ''}<br>
      <strong>Saison :</strong> ${escHtml(metadata.saison || '—')}<br>
      <strong>Montant :</strong> ${amount} €<br>
      <strong>Options :</strong> ${optionsLabel}</p>
      <hr>
      <p><strong>Client :</strong> ${escHtml(metadata.prenom || '')} ${escHtml(metadata.nom || '')}<br>
      <strong>Email :</strong> ${escHtml(session.customer_email)}<br>
      <strong>N° permis :</strong> ${escHtml(metadata.npermis || '—')}</p>
      ${chiensHtml}
      <hr>
      <p><strong>Stripe session :</strong> ${escHtml(session.id)}</p>
    `,
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature invalide' });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const metadata = session.metadata || {};

      console.log('✓ Paiement confirmé', {
        session_id: session.id,
        amount: session.amount_total / 100,
        department: metadata.department,
        saison: metadata.saison,
      });

      try {
        await sendEmails(session, metadata);
        console.log('✉ Emails de confirmation envoyés');
      } catch (err) {
        console.error('Erreur envoi emails confirmation paiement', err);
      }

      // TODO Firebase (à activer quand Firebase sera configuré)
      break;
    }
    case 'checkout.session.expired':
      console.log('Session expirée:', event.data.object.id);
      break;
    default:
      console.log(`Event reçu non traité: ${event.type}`);
  }

  return res.status(200).json({ received: true });
};
