/**
 * Vercel serverless function — Réception d'un message de contact
 * POST /api/contact-submit
 */

const nodemailer = require('nodemailer');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const msg = req.body || {};
  if (!msg.email || !msg.nom || !msg.message || !msg.objet) {
    return res.status(400).json({ error: 'Données manquantes' });
  }

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
      subject: `[CONTACT ${msg.department || ''}] ${msg.objet} — ${msg.nom} ${msg.prenom || ''}`,
      html: `
        <h3>Nouveau message de contact</h3>
        <p><strong>De :</strong> ${msg.prenom || ''} ${msg.nom} &lt;${msg.email}&gt;</p>
        <p><strong>Téléphone :</strong> ${msg.tel || '—'}</p>
        <p><strong>Département :</strong> ${msg.department || '—'}</p>
        <p><strong>Objet :</strong> ${msg.objet}</p>
        <hr>
        <p><strong>Message :</strong></p>
        <p>${String(msg.message).replace(/\n/g, '<br>')}</p>
      `,
    });

    console.log('Contact email envoyé', { from: msg.email, objet: msg.objet });
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erreur envoi email contact', err);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi du message' });
  }
};
