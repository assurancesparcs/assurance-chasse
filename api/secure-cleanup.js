/**
 * GET /api/secure-cleanup
 * Endpoint Vercel Cron. Supprime les fichiers de l'espace privé plus vieux que 2 ans.
 * Protégé par CRON_SECRET (Vercel envoie automatiquement Authorization: Bearer $CRON_SECRET).
 */

const { list, del } = require('@vercel/blob');

const RETENTION_DAYS = 2 * 365; // 2 ans

module.exports = async (req, res) => {
  // Vercel Cron envoie le header Authorization avec le CRON_SECRET
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  const errors = [];

  try {
    const result = await list({ prefix: 'espace-securise/' });
    for (const blob of result.blobs || []) {
      const uploaded = new Date(blob.uploadedAt).getTime();
      if (uploaded < cutoff) {
        try {
          await del(blob.url);
          deletedCount += 1;
          console.log('[CLEANUP] supprimé', blob.pathname, 'uploadé le', blob.uploadedAt);
        } catch (e) {
          errors.push({ key: blob.pathname, error: e.message });
        }
      }
    }

    console.log(`[CLEANUP] ${new Date().toISOString()} — ${deletedCount} fichiers supprimés (>2 ans)`);
    return res.status(200).json({ ok: true, deleted: deletedCount, errors });
  } catch (err) {
    console.error('Erreur secure-cleanup', err);
    return res.status(500).json({ error: 'Erreur cleanup' });
  }
};
