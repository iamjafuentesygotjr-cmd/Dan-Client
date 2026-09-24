/**
 * GET /api/health — says which pieces are configured, so a failure is never silent.
 * Reports presence only: no keys, no passwords, no addresses.
 */
import { storageReady, readHead, json, cors, tokenOk } from '../lib/desk.js';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (!tokenOk(request)) return json({ error: 'bad token' }, 401);

    const has = (n) => !!(process.env[n] || '').trim();

    const provider = has('GMAIL_APP_PASSWORD') && has('GMAIL_USER') ? 'gmail'
      : has('RESEND_API_KEY') ? 'resend'
      : has('BREVO_API_KEY') ? 'brevo'
      : null;

    const missing = [];
    if (!storageReady()) missing.push('a Redis store (Storage tab)');
    if (!provider) missing.push('GMAIL_USER + GMAIL_APP_PASSWORD (or RESEND_API_KEY / BREVO_API_KEY)');
    if (provider !== 'gmail' && !has('MAIL_FROM')) missing.push('MAIL_FROM');
    if (!has('EMAIL_TEAM')) missing.push('EMAIL_TEAM');
    if (!has('EMAIL_CLIENT')) missing.push('EMAIL_CLIENT');

    let rev = null, storageError = null;
    try { rev = (await readHead())?.rev ?? 0; }
    catch (e) { storageError = e.message; }

    return json({
      ready: missing.length === 0 && !storageError,
      storage: { connected: storageReady(), rev, error: storageError },
      mail: {
        provider,
        gmailUser: has('GMAIL_USER'),
        gmailAppPassword: has('GMAIL_APP_PASSWORD'),
        resendKey: has('RESEND_API_KEY'),
        brevoKey: has('BREVO_API_KEY'),
        mailFrom: has('MAIL_FROM'),
        emailTeam: has('EMAIL_TEAM'),
        emailClient: has('EMAIL_CLIENT'),
      },
      missing,
      note: 'Presence only — no keys or addresses are shown here.',
    });
  },
};
