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
const { generateAttestation, generatePolicyNumber } = require('./_attestation');

const TARIFS = {
  securite: 25,
  chiensPetit: 45,
  chiensGros: 95,
  installation: 160,
  admin: 1,
};

const FDC_CODE = {
  gironde: 'FDC33',
  calvados: 'FDC14',
  dordogne: 'FDC24',
  'lot-et-garonne': 'FDC47',
};

const OPTION_LABEL = {
  sec: 'Sécurité chasse (assurance corporelle)',
  chi: 'Assurance blessure des chiens de chasse',
  ins: 'Installation cynégétique',
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

function parseEndOfSaison(saison) {
  // ex: "2026 – 2027" -> 30 juin 2027 ; sinon -> 30 juin (année courante + 1)
  const years = (saison || '').match(/\d{4}/g);
  const endYear = years && years.length >= 2 ? parseInt(years[1], 10)
                : years && years.length === 1 ? parseInt(years[0], 10) + 1
                : new Date().getFullYear() + 1;
  return new Date(endYear, 5, 30); // mois index 5 = juin
}

function buildAttestationPayload(session, metadata) {
  const now = new Date();
  const nbPetit = parseInt(metadata.nb_chiens_petit || '0', 10) || 0;
  const nbGros = parseInt(metadata.nb_chiens_gros || '0', 10) || 0;
  const opts = (metadata.options || '').split(',').map((s) => s.trim()).filter(Boolean);

  let chiens = [];
  try { chiens = metadata.chiens_data ? JSON.parse(metadata.chiens_data) : []; } catch (_) {}

  const installation = opts.includes('ins') ? {
    type: metadata.ins_type || '',
    surface: metadata.ins_surface || '',
    materiau: metadata.ins_materiau || '',
    adresse: metadata.ins_adresse || '',
    lat: metadata.ins_lat || '',
    lng: metadata.ins_lng || '',
  } : null;

  const montants = {
    securite: opts.includes('sec') ? TARIFS.securite : 0,
    chiensPetit: nbPetit * TARIFS.chiensPetit,
    chiensGros: nbGros * TARIFS.chiensGros,
    installation: opts.includes('ins') ? TARIFS.installation : 0,
    admin: ((opts.includes('sec') ? 1 : 0) + nbPetit + nbGros + (opts.includes('ins') ? 1 : 0)) * TARIFS.admin,
    total: session.amount_total / 100,
  };

  return {
    policyNumber: generatePolicyNumber(session.id),
    issueDate: now,
    validFrom: now,
    validUntil: parseEndOfSaison(metadata.saison),
    customer: {
      nom: metadata.nom || '',
      prenom: metadata.prenom || '',
      email: session.customer_email || '',
      npermis: metadata.npermis || '',
    },
    department: metadata.department || '',
    saison: metadata.saison || '',
    options: opts,
    chiens,
    installation,
    montants,
  };
}

async function sendEmails(session, metadata, payload, attestationBuffer) {
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
  const policyNumber = payload ? payload.policyNumber : '';
  const attestationFilename = policyNumber ? `attestation-${policyNumber}.pdf` : 'attestation-assurance-chasse.pdf';

  const attachments = attestationBuffer
    ? [{ filename: attestationFilename, content: attestationBuffer, contentType: 'application/pdf' }]
    : [];

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
      <strong>N° de permis :</strong> ${escHtml(metadata.npermis || '—')}${policyNumber ? `<br><strong>N° de police :</strong> ${escHtml(policyNumber)}` : ''}</p>
      ${chiensHtml}
      <p><strong>Votre attestation d'assurance est jointe à ce mail au format PDF.</strong> Conservez-la précieusement et présentez-la en cas de contrôle.</p>
      <p>Pour toute question, vous pouvez nous joindre à <a href="mailto:${escHtml(process.env.GMAIL_USER)}">${escHtml(process.env.GMAIL_USER)}</a>.</p>
      <p>Cordialement,<br>Cabinet ADC&amp;E Assurances</p>
    `,
    attachments,
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
      <strong>Options :</strong> ${optionsLabel}${policyNumber ? `<br><strong>N° de police émis :</strong> ${escHtml(policyNumber)}` : ''}</p>
      <hr>
      <p><strong>Client :</strong> ${escHtml(metadata.prenom || '')} ${escHtml(metadata.nom || '')}<br>
      <strong>Email :</strong> ${escHtml(session.customer_email)}<br>
      <strong>N° permis :</strong> ${escHtml(metadata.npermis || '—')}</p>
      ${chiensHtml}
      <hr>
      <p><strong>Stripe session :</strong> ${escHtml(session.id)}</p>
      <p><em>L'attestation PDF générée est jointe à ce mail.</em></p>
    `,
    attachments,
  });
}

async function logToGoogleSheets(session, metadata, payload, attestationBuffer) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const secret = process.env.GOOGLE_SHEETS_WEBHOOK_SECRET;
  if (!url) return; // pas configuré → on saute silencieusement

  const opts = (metadata.options || '').split(',').map((s) => s.trim()).filter(Boolean);
  const optionsLabel = opts.map((o) => OPTION_LABEL[o] || o).join(' + ');
  const fdc = FDC_CODE[metadata.department] || '';
  const amount = session.amount_total / 100;

  const body = {
    secret: secret || '',
    timestamp: new Date().toISOString(),
    policyNumber: payload ? payload.policyNumber : '',
    sessionId: session.id,
    department: metadata.department || '',
    fdc,
    saison: metadata.saison || '',
    nom: metadata.nom || '',
    prenom: metadata.prenom || '',
    email: session.customer_email || '',
    tel: metadata.tel || '',
    npermis: metadata.npermis || '',
    options: optionsLabel,
    nbChiensPetit: parseInt(metadata.nb_chiens_petit || '0', 10) || 0,
    nbChiensGros: parseInt(metadata.nb_chiens_gros || '0', 10) || 0,
    chiensDetail: metadata.chiens_data || '',
    installationType: metadata.ins_type || '',
    installationSurface: metadata.ins_surface || '',
    installationMateriau: metadata.ins_materiau || '',
    installationAdresse: metadata.ins_adresse || '',
    installationLat: metadata.ins_lat || '',
    installationLng: metadata.ins_lng || '',
    installationGoogleMaps: (metadata.ins_lat && metadata.ins_lng) ? `https://www.google.com/maps?q=${metadata.ins_lat},${metadata.ins_lng}` : '',
    montantTotal: amount,
    pdfBase64: attestationBuffer ? attestationBuffer.toString('base64') : '',
    pdfFilename: payload ? `attestation-${payload.policyNumber}.pdf` : '',
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Google Sheets webhook returned ${response.status}`);
  }
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

      // Génération unique du PDF + payload (partagés par emails et Google Sheets)
      let payload = null;
      let attestationBuffer = null;
      try {
        payload = buildAttestationPayload(session, metadata);
        attestationBuffer = await generateAttestation(payload);
      } catch (err) {
        console.error('Erreur génération attestation PDF', err);
      }

      const tasks = await Promise.allSettled([
        sendEmails(session, metadata, payload, attestationBuffer),
        logToGoogleSheets(session, metadata, payload, attestationBuffer),
      ]);
      tasks.forEach((t, i) => {
        const label = i === 0 ? '✉ Emails' : '📊 Google Sheets';
        if (t.status === 'fulfilled') console.log(label + ' OK');
        else console.error(label + ' KO', t.reason);
      });
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
