/**
 * Helpers de sécurité partagés par les endpoints API.
 * - getClientIp(req) : extrait l'IP du client (Vercel passe x-forwarded-for)
 * - rateLimit(key, ip, windowMs, max) : limiteur en mémoire (réinitialisé à chaque cold start)
 *   Imparfait mais suffisant pour bloquer les bursts. Pour du long terme, brancher Upstash.
 * - isHoneypotFilled(body, fieldName) : détection simple anti-bot
 */

const buckets = new Map();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  const first = xff.split(',')[0].trim();
  return first || req.headers['x-real-ip'] || 'unknown';
}

function rateLimit(key, ip, windowMs, max) {
  const now = Date.now();
  const bucketKey = `${key}:${ip}`;
  let bucket = buckets.get(bucketKey);
  if (!bucket || bucket.expiresAt < now) {
    bucket = { count: 0, expiresAt: now + windowMs };
  }
  bucket.count += 1;
  buckets.set(bucketKey, bucket);

  // Nettoyage occasionnel des entrées expirées (1% des appels)
  if (Math.random() < 0.01) {
    for (const [k, v] of buckets.entries()) {
      if (v.expiresAt < now) buckets.delete(k);
    }
  }

  if (bucket.count > max) {
    const retryAfter = Math.ceil((bucket.expiresAt - now) / 1000);
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

function isHoneypotFilled(body, fieldName) {
  if (!body || typeof body !== 'object') return false;
  const v = body[fieldName];
  return typeof v === 'string' && v.length > 0;
}

module.exports = { getClientIp, rateLimit, isHoneypotFilled };
