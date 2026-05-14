/**
 * POST /api/secure-logout
 * Efface le cookie de session.
 */

const { clearSessionCookie, logAccess } = require('./_secure-auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  clearSessionCookie(res);
  logAccess('LOGOUT', req, {});
  return res.status(200).json({ ok: true });
};
