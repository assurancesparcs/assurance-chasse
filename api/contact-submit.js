module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const msg = req.body || {};
  if (!msg.email || !msg.nom || !msg.message || !msg.objet) {
    return res.status(400).json({ error: 'Données manquantes' });
  }
  console.log('Contact reçu', { department: msg.department, nom: msg.nom, email: msg.email, objet: msg.objet });
  // TODO Email via Gmail SMTP (nodemailer)
  return res.status(200).json({ received: true });
};
