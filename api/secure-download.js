/**
 * GET /api/secure-download?key=<pathname>
 * Auth requis. Proxy le contenu du blob avec une vérification d'authentification.
 * On ne renvoie pas l'URL Blob directement → seuls les utilisateurs authentifiés peuvent lire.
 */

const { head } = require('@vercel/blob');
const { requireAuth, logAccess } = require('./_secure-auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = requireAuth(req, res);
  if (!session) return;

  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const key = urlObj.searchParams.get('key');
  if (!key || !key.startsWith('espace-securise/')) {
    return res.status(400).json({ error: 'Clé invalide' });
  }

  try {
    const blob = await head(key);
    if (!blob) return res.status(404).json({ error: 'Fichier introuvable' });

    const upstream = await fetch(blob.url);
    if (!upstream.ok) {
      return res.status(502).json({ error: 'Erreur récupération fichier' });
    }

    const filename = key.replace(/^espace-securise\/\d+-/, '');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    logAccess('DOWNLOAD', req, { email: session.email, key });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('Erreur secure-download', err);
    return res.status(500).json({ error: 'Erreur téléchargement' });
  }
};
