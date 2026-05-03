module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const claim = req.body || {};
  if (!claim.email || !claim.nom || !claim.desc || !claim.ref) {
    return res.status(400).json({ error: 'Données manquantes' });
  }
  console.log('Sinistre reçu', { ref: claim.ref, department: claim.department, nom: claim.nom, email: claim.email, date_sin: claim.date_sin });
  // TODO Email via Gmail SMTP (cabinet + AR au déclarant)
  return res.status(200).json({ received: true, ref: claim.ref });
};
