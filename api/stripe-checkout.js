const Stripe = require('stripe');
const { getClientIp, rateLimit } = require('./_security');

const ALLOWED_DEPTS = ['gironde', 'calvados', 'dordogne', 'lot-et-garonne'];
const ALLOWED_OPTIONS = ['sec', 'chi', 'ins'];
const ALLOWED_DOG_TYPES = ['petit', 'gros'];
const ALLOWED_INS_TYPES = ['cabane', 'palombiere', 'tonne', 'mirador', 'gabion', 'hutte', 'autre'];
const ALLOWED_MATERIAUX = ['bois', 'metal', 'mixte', 'beton', 'autre'];

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

  // Rate limit : 5 tentatives de paiement / 10 min par IP
  const ip = getClientIp(req);
  const rl = rateLimit('checkout', ip, 10 * 60 * 1000, 5);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${rl.retryAfter} secondes.` });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const { department, options, chiens, installation, customer } = req.body || {};

  if (!ALLOWED_DEPTS.includes(department)) {
    return res.status(400).json({ error: 'Département invalide' });
  }

  if (!Array.isArray(options) || options.length === 0 || options.length > 3
      || !options.every((o) => ALLOWED_OPTIONS.includes(o))) {
    return res.status(400).json({ error: 'Options invalides' });
  }

  if (!customer || typeof customer !== 'object' || !isValidEmail(customer.email)) {
    return res.status(400).json({ error: 'Email client invalide' });
  }
  if (typeof customer.nom !== 'string' || customer.nom.length < 1 || customer.nom.length > 100) {
    return res.status(400).json({ error: 'Nom invalide' });
  }
  if (typeof customer.prenom !== 'string' || customer.prenom.length < 1 || customer.prenom.length > 100) {
    return res.status(400).json({ error: 'Prénom invalide' });
  }

  let nbPetit = 0;
  let nbGros = 0;

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
        return res.status(400).json({ error: 'Chien : n° d\'identification invalide (puce ou tatouage obligatoire)' });
      }
      if (typeof c.nom !== 'string' || c.nom.length > 50) {
        return res.status(400).json({ error: 'Chien : nom invalide' });
      }
      if (c.race && (typeof c.race !== 'string' || c.race.length > 100)) {
        return res.status(400).json({ error: 'Chien : race invalide' });
      }
      if (!ALLOWED_DOG_TYPES.includes(c.type)) {
        return res.status(400).json({ error: 'Chien : catégorie invalide (petit ou gros gibier requis)' });
      }
      if (c.type === 'petit') nbPetit += 1;
      else if (c.type === 'gros') nbGros += 1;
    }
  }

  // Validation installation cynégétique
  if (options.includes('ins')) {
    if (!installation || typeof installation !== 'object') {
      return res.status(400).json({ error: 'Données installation manquantes' });
    }
    if (!ALLOWED_INS_TYPES.includes(installation.type)) {
      return res.status(400).json({ error: 'Type d\'installation invalide' });
    }
    if (!ALLOWED_MATERIAUX.includes(installation.materiau)) {
      return res.status(400).json({ error: 'Matériau invalide' });
    }
    const surface = parseFloat(installation.surface);
    if (!Number.isFinite(surface) || surface < 1 || surface > 500) {
      return res.status(400).json({ error: 'Surface invalide (1 à 500 m²)' });
    }
    if (typeof installation.adresse !== 'string' || installation.adresse.length < 3 || installation.adresse.length > 200) {
      return res.status(400).json({ error: 'Adresse d\'installation invalide' });
    }
    const lat = parseFloat(installation.lat);
    const lng = parseFloat(installation.lng);
    if (!Number.isFinite(lat) || lat < 41 || lat > 52 || !Number.isFinite(lng) || lng < -6 || lng > 10) {
      return res.status(400).json({ error: 'Coordonnées GPS invalides (la position doit être en France métropolitaine)' });
    }
  }

  const line_items = [];
  const missingEnv = [];
  if (options.includes('sec')) {
    if (!process.env.STRIPE_PRICE_SECURITE) missingEnv.push('STRIPE_PRICE_SECURITE');
    else line_items.push({ price: process.env.STRIPE_PRICE_SECURITE, quantity: 1 });
  }
  if (options.includes('chi')) {
    if (nbPetit > 0) {
      if (!process.env.STRIPE_PRICE_CHIENS_PETIT) missingEnv.push('STRIPE_PRICE_CHIENS_PETIT');
      else line_items.push({ price: process.env.STRIPE_PRICE_CHIENS_PETIT, quantity: nbPetit });
    }
    if (nbGros > 0) {
      if (!process.env.STRIPE_PRICE_CHIENS_GROS) missingEnv.push('STRIPE_PRICE_CHIENS_GROS');
      else line_items.push({ price: process.env.STRIPE_PRICE_CHIENS_GROS, quantity: nbGros });
    }
  }
  if (options.includes('ins')) {
    if (!process.env.STRIPE_PRICE_INSTALLATION) missingEnv.push('STRIPE_PRICE_INSTALLATION');
    else line_items.push({ price: process.env.STRIPE_PRICE_INSTALLATION, quantity: 1 });
  }

  // Frais admin : 1€ par ligne (1× pour la sécurité, 1× par chien, 1× pour l'installation)
  const adminQty = (options.includes('sec') ? 1 : 0)
    + (options.includes('chi') ? (nbPetit + nbGros) : 0)
    + (options.includes('ins') ? 1 : 0);
  if (adminQty > 0) {
    if (!process.env.STRIPE_PRICE_ADMIN) missingEnv.push('STRIPE_PRICE_ADMIN');
    else line_items.push({ price: process.env.STRIPE_PRICE_ADMIN, quantity: adminQty });
  }

  if (missingEnv.length > 0) {
    console.error('Variables Stripe manquantes:', missingEnv.join(', '));
    return res.status(500).json({ error: `Configuration serveur incomplète (${missingEnv.join(', ')})` });
  }

  const metadata = {
    department,
    options: options.join(','),
    nb_chiens_petit: String(nbPetit),
    nb_chiens_gros: String(nbGros),
    nom: clean(customer.nom, 100),
    prenom: clean(customer.prenom, 100),
    npermis: clean(customer.npermis || '', 50),
    saison: clean(customer.saison || '', 30),
    tel: clean(customer.tel || '', 30),
    ddn: clean(customer.ddn || '', 20),
    adresse_postale: clean(customer.adresse || '', 200),
    chiens_data: chiens ? JSON.stringify(chiens).slice(0, 450) : '',
  };
  if (options.includes('ins') && installation) {
    metadata.ins_type = clean(installation.type, 30);
    metadata.ins_surface = clean(String(installation.surface), 10);
    metadata.ins_materiau = clean(installation.materiau, 20);
    metadata.ins_adresse = clean(installation.adresse, 200);
    metadata.ins_lat = clean(String(installation.lat), 20);
    metadata.ins_lng = clean(String(installation.lng), 20);
  }

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
