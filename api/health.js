/**
 * GET /api/health — says which pieces are configured, so a failure is never silent.
 * Reports presence only: no keys, no passwords, no addresses.
 */
import { storageReady, readHead, readNotifyLog, verifyMail, sendMail, json, cors, tokenOk } from '../lib/desk.js';

// One-off diagnostic trigger. Only ever mails the two configured addresses.
// Remove this constant once notifications are confirmed working.
const CHECK_TOKEN = 'chk_6f6816c7262f1c6e';

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

    const url = new URL(request.url);
    // ?smtp=1 tries to log in to the mail account. It never sends an email.
    const smtp = url.searchParams.get('smtp') === '1' ? await verifyMail() : undefined;
    // ?log=1 returns what happened to the last few chat messages.
    let recent;
    if (url.searchParams.get('log') === '1') { try { recent = (await readNotifyLog()) || []; } catch { recent = null; } }

    // ?send=<token>&to=team|client actually sends one test email and reports the result
    let sendResult;
    if (url.searchParams.get('send') === CHECK_TOKEN) {
      const portal = url.searchParams.get('to') === 'client' ? 'client' : 'team';
      const started = Date.now();
      const r = await sendMail(portal, {
        fromName: 'Prospect Desk',
        messages: [{ from: 'Prospect Desk', ts: Date.now(),
          text: 'This is a delivery test for the CrossCore Prospect Desk. If you are reading it, chat notifications can reach this address.' }],
        preview: 'Delivery test',
        link: 'https://dan-client.vercel.app?portal=' + portal + '&chat=1',
        isTest: true,
      });
      sendResult = { to: portal, ms: Date.now() - started, ...r };
    }

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
      smtp,
      recent,
      sendResult,
      note: 'Presence only — no keys or addresses are shown here.',
    });
  },
};
