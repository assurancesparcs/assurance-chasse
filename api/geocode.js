/**
 * Proxy de géocodage — Nominatim (OpenStreetMap)
 * Endpoint : GET /api/geocode?q=<adresse>
 *
 * Pourquoi un proxy serveur plutôt qu'un fetch direct depuis le navigateur :
 *  - la CSP du site (connect-src 'self') interdit les appels cross-origin → on reste en 'self'
 *  - la politique d'usage Nominatim impose un User-Agent identifiant l'application
 *    (impossible à définir depuis un navigateur), ce que ce proxy fournit
 *  - permet d'appliquer un rate-limit et de normaliser la réponse
 */
const { getClientIp, rateLimit } = require('./_security');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit : 30 recherches / minute par IP
  try {
    const ip = getClientIp(req);
    const rl = rateLimit('geocode', ip, 60 * 1000, 30);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `Trop de recherches. Réessayez dans ${rl.retryAfter} secondes.` });
    }
  } catch (_) { /* si _security indisponible, on continue sans rate-limit */ }

  const q = (req.query && req.query.q ? String(req.query.q) : '').trim();
  if (q.length < 3 || q.length > 200) {
    return res.status(400).json({ error: 'Requête invalide' });
  }

  const url = 'https://nominatim.openstreetmap.org/search'
    + '?format=json&limit=1&countrycodes=fr&addressdetails=0'
    + '&q=' + encodeURIComponent(q);

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'ADCE-Assurances-Chasse/1.0 (https://www.assurancechasse33.fr; chasse.assurance@gmail.com)',
        'Accept-Language': 'fr',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) {
      return res.status(502).json({ error: 'Service de géocodage indisponible' });
    }
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(200).json({ found: false });
    }
    const best = data[0];
    const lat = parseFloat(best.lat);
    const lng = parseFloat(best.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(200).json({ found: false });
    }
    // Cache court côté CDN pour limiter la charge sur Nominatim
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).json({
      found: true,
      lat,
      lng,
      label: best.display_name || '',
    });
  } catch (err) {
    console.error('Geocode error:', err);
    return res.status(502).json({ error: 'Erreur lors de la recherche' });
  }
};
