/**
 * POST /api/secure-delete
 * Body : { key }
 * Auth requis. Supprime un fichier du Vercel Blob.
 */

const { del, head } = require('@vercel/blob');
const { requireAuth, logAccess } = require('./_secure-auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = requireAuth(req, res);
  if (!session) return;

  const { key } = req.body || {};
  if (typeof key !== 'string' || !key.startsWith('espace-securise/')) {
    return res.status(400).json({ error: 'Clé invalide' });
  }

  try {
    const blob = await head(key);
    if (!blob) return res.status(404).json({ error: 'Fichier introuvable' });

    await del(blob.url);
    logAccess('DELETE', req, { email: session.email, key });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erreur secure-delete', err);
    return res.status(500).json({ error: 'Erreur suppression' });
  }
};
