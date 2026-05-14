/**
 * POST /api/secure-login
 * Body : { email, password }
 * Réponse : { ok: true } + cookie session (HttpOnly)
 *
 * Rate limited : 5 tentatives / 15 min par IP (anti-brute force).
 */

const {
  verifyCredentials,
  signSession,
  setSessionCookie,
  logAccess,
} = require('./_secure-auth');
const { getClientIp, rateLimit } = require('./_security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getClientIp(req);
  const rl = rateLimit('secure-login', ip, 15 * 60 * 1000, 5);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${rl.retryAfter} secondes.` });
  }

  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }
  if (email.length > 254 || password.length > 200) {
    return res.status(400).json({ error: 'Données invalides' });
  }

  try {
    const user = await verifyCredentials(email, password);
    if (!user) {
      logAccess('LOGIN_FAILED', req, { email: email.slice(0, 50) });
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const token = signSession(user);
    setSessionCookie(res, token);
    logAccess('LOGIN_OK', req, { email: user.email });
    return res.status(200).json({ ok: true, email: user.email });
  } catch (err) {
    console.error('Erreur secure-login', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
