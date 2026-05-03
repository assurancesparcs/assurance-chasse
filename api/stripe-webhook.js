const Stripe = require('stripe');

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
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
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const metadata = session.metadata || {};

      console.log('Paiement confirmé', {
        session_id: session.id,
        amount: session.amount_total / 100,
        email: session.customer_email,
        department: metadata.department,
        nom: metadata.nom,
        prenom: metadata.prenom,
        npermis: metadata.npermis,
        saison: metadata.saison,
        options: metadata.options,
      });

      // TODO Firebase : enregistrer la souscription
      // TODO Email : envoyer l'attestation
      break;
    }
    case 'checkout.session.expired':
      console.log('Session expirée:', event.data.object.id);
      break;
    default:
      console.log('Event reçu non traité: ' + event.type);
  }

  return res.status(200).json({ received: true });
};
