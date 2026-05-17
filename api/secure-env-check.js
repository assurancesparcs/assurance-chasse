/**
 * GET /api/secure-env-check
 * Debug : liste les noms de variables Blob/secrets vues par la function (PAS les valeurs).
 * Auth requis pour éviter le leak public.
 */

const { requireAuth } = require('./_secure-auth');

module.exports = async (req, res) => {
  const session = requireAuth(req, res);
  if (!session) return;

  const allKeys = Object.keys(process.env).sort();
  const blobKeys = allKeys.filter((k) => k.includes('BLOB'));
  const secureKeys = allKeys.filter((k) => k.startsWith('SECURE_') || k === 'JWT_SECRET' || k === 'CRON_SECRET');
  const gmailKeys = allKeys.filter((k) => k.startsWith('GMAIL_'));

  return res.status(200).json({
    blobVarsFound: blobKeys,
    secureVarsFound: secureKeys.map((k) => k.replace(/_HASH$/, '_HASH (présente)')),
    gmailVarsFound: gmailKeys,
    totalEnvVarsCount: allKeys.length,
    nodeVersion: process.version,
    vercelRegion: process.env.VERCEL_REGION || 'unknown',
  });
};
