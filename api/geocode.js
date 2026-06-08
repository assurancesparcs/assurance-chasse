/**
 * Proxy de géocodage — Nominatim (OpenStreetMap)
 * Endpoints :
 *   GET /api/geocode?q=<adresse>         → géocodage direct  (adresse → lat/lng)
 *   GET /api/geocode?lat=<x>&lng=<y>     → géocodage inverse (lat/lng → adresse)
 *
 * Pourquoi un proxy serveur plutôt qu'un fetch direct depuis le navigateur :
 *  - la CSP du site (connect-src 'self') interdit les appels cross-origin → on reste en 'self'
 *  - la politique d'usage Nominatim impose un User-Agent identifiant l'application
 *    (impossible à définir depuis un navigateur), ce que ce proxy fournit
 *  - permet d'appliquer un rate-limit et de normaliser la réponse
 */
const { getClientIp, rateLimit } = require('./_security');

const UA = 'ADCE-Assurances-Chasse/1.0 (https://www.assurancechasse33.fr; chasse.assurance@gmail.com)';
const NOMINATIM_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'fr',
  'Accept': 'application/json',
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit : 40 requêtes / minute par IP (direct + inverse confondus)
  try {
    const ip = getClientIp(req);
    const rl = rateLimit('geocode', ip, 60 * 1000, 40);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: `Trop de recherches. Réessayez dans ${rl.retryAfter} secondes.` });
    }
  } catch (_) { /* si _security indisponible, on continue sans rate-limit */ }

  const query = req.query || {};
  const hasLatLng = query.lat != null && query.lng != null;

  // ===== Géocodage INVERSE (lat/lng → adresse) =====
  if (hasLatLng) {
    const lat = parseFloat(query.lat);
    const lng = parseFloat(query.lng);
    if (!Number.isFinite(lat) || lat < 41 || lat > 52 || !Number.isFinite(lng) || lng < -6 || lng > 10) {
      return res.status(400).json({ error: 'Coordonnées invalides' });
    }
    const url = 'https://nominatim.openstreetmap.org/reverse'
      + '?format=json&zoom=18&addressdetails=1'
      + '&lat=' + encodeURIComponent(lat)
      + '&lon=' + encodeURIComponent(lng);
    try {
      const r = await fetch(url, { headers: NOMINATIM_HEADERS });
      if (!r.ok) return res.status(502).json({ error: 'Service de géocodage indisponible' });
      const data = await r.json();
      if (!data || data.error || !data.display_name) {
        return res.status(200).json({ found: false });
      }
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).json({ found: true, label: data.display_name });
    } catch (err) {
      console.error('Reverse geocode error:', err);
      return res.status(502).json({ error: 'Erreur lors de la recherche' });
    }
  }

  // ===== Géocodage DIRECT (adresse → lat/lng) =====
  const q = (query.q ? String(query.q) : '').trim();
  if (q.length < 3 || q.length > 200) {
    return res.status(400).json({ error: 'Requête invalide' });
  }
  const url = 'https://nominatim.openstreetmap.org/search'
    + '?format=json&limit=1&countrycodes=fr&addressdetails=0'
    + '&q=' + encodeURIComponent(q);
  try {
    const r = await fetch(url, { headers: NOMINATIM_HEADERS });
    if (!r.ok) return res.status(502).json({ error: 'Service de géocodage indisponible' });
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
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).json({ found: true, lat, lng, label: best.display_name || '' });
  } catch (err) {
    console.error('Geocode error:', err);
    return res.status(502).json({ error: 'Erreur lors de la recherche' });
  }
};
