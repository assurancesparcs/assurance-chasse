const Stripe = require('stripe');

const ALLOWED_DEPTS = ['gironde', 'calvados', 'dordogne', 'lot-et-garonne'];
const ALLOWED_OPTIONS = ['sec', 'chi'];

function isValidEmail(s) {
  return typeof s === 'string'
    && s.length <= 254
    && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(s);
}

function clean(s, max) {
  return String(s == null ? '' : s).slice(0, max).replace(/[\r\n\t\0]/g, ' ');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const { department, options, chiens, customer } = req.body || {};

  // Validation département
  if (!ALLOWED_DEPTS.includes(department)) {
    return res.status(400).json({ error: 'Département invalide' });
  }

  // Validation options
  if (!Array.isArray(options) || options.length === 0 || options.length > 3
      || !options.every((o) => ALLOWED_OPTIONS.includes(o))) {
    return res.status(400).json({ error: 'Options invalides' });
  }

  // Validation customer
  if (!customer || typeof customer !== 'object' || !isValidEmail(customer.email)) {
    return res.status(400).json({ error: 'Email client invalide' });
  }
  if (typeof customer.nom !== 'string' || customer.nom.length < 1 || customer.nom.length > 100) {
    return res.status(400).json({ error: 'Nom invalide' });
  }
  if (typeof customer.prenom !== 'string' || customer.prenom.length < 1 || customer.prenom.length > 100) {
    return res.status(400).json({ error: 'Prénom invalide' });
  }

  // Validation chiens
  if (options.includes('chi')) {
    if (!Array.isArray(chiens) || chiens.length === 0 || chiens.length > 3) {
      return res.status(400).json({ error: 'Nombre de chiens invalide (1 à 3)' });
    }
    for (const c of chiens) {
      const age = parseInt(c.age, 10);
      if (!Number.isFinite(age) || age < 0 || age > 11) {
        return res.status(400).json({ error: 'Chien : âge invalide (0 à 11 ans)' });
      }
      if (typeof c.identification !== 'string' || c.identification.length < 3 || c.identification.length > 50) {
        return res.status(400).json({ error: 'Chien : n° d\'identification invalide' });
      }
      if (typeof c.nom !== 'string' || c.nom.length > 50) {
        return res.status(400).json({ error: 'Chien : nom invalide' });
      }
      if (c.race && (typeof c.race !== 'string' || c.race.length > 100)) {
        return res.status(400).json({ error: 'Chien : race invalide' });
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
    nom: clean(customer.nom, 100),
    prenom: clean(customer.prenom, 100),
    npermis: clean(customer.npermis || '', 50),
    saison: clean(customer.saison || '', 30),
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
    return res.status(500).json({ error: 'Erreur lors de la création de la session de paiement' });
  }
};
