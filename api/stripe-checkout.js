const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const { department, options, chiens, customer } = req.body || {};

  if (!department || !options || !Array.isArray(options) || options.length === 0 || !customer || !customer.email) {
    return res.status(400).json({ error: 'Données manquantes' });
  }

  if (options.includes('chi')) {
    if (!Array.isArray(chiens) || chiens.length === 0 || chiens.length > 3) {
      return res.status(400).json({ error: 'Nombre de chiens invalide (1 à 3)' });
    }
    for (const c of chiens) {
      if (!c.age || parseInt(c.age) > 11) {
        return res.status(400).json({ error: `Le chien ${c.nom || ''} doit avoir 11 ans maximum` });
      }
      if (!c.identification) {
        return res.status(400).json({ error: `N° d'identification manquant pour ${c.nom || 'un chien'}` });
      }
    }
  }

  const line_items = [];

  if (options.includes('sec')) {
    line_items.push({ price: process.env.STRIPE_PRICE_SECURITE, quantity: 1 });
  }
  if (options.includes('chi')) {
    line_items.push({ price: process.env.STRIPE_PRICE_CHIENS, quantity: chiens.length });
  }
  line_items.push({ price: process.env.STRIPE_PRICE_ADMIN, quantity: options.length });

  const metadata = {
    department,
    options: options.join(','),
    nb_chiens: String(chiens ? chiens.length : 0),
    nom: customer.nom || '',
    prenom: customer.prenom || '',
    npermis: customer.npermis || '',
    saison: customer.saison || '',
    chiens_data: chiens ? JSON.stringify(chiens).slice(0, 450) : '',
  };

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';
  const baseUrl = `${proto}://${host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      customer_email: customer.email,
      metadata,
      success_url: `${baseUrl}/confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/options-chasse.html`,
      locale: 'fr',
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message });
  }
};
