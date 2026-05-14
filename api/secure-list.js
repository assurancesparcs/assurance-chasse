/**
 * GET /api/secure-list
 * Auth requis. Retourne la liste des fichiers du dossier privé (préfixe "espace-securise/").
 */

const { list } = require('@vercel/blob');
const { requireAuth, logAccess } = require('./_secure-auth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = requireAuth(req, res);
  if (!session) return;

  try {
    const result = await list({ prefix: 'espace-securise/' });
    const files = (result.blobs || [])
      .map((b) => ({
        key: b.pathname,
        url: b.url,
        size: b.size,
        uploadedAt: b.uploadedAt,
        displayName: b.pathname.replace(/^espace-securise\//, '').replace(/^\d{13}-/, ''),
      }))
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    logAccess('LIST', req, { count: files.length, email: session.email });
    return res.status(200).json({ files, email: session.email });
  } catch (err) {
    console.error('Erreur secure-list', err);
    return res.status(500).json({ error: 'Erreur lecture des fichiers' });
  }
};
