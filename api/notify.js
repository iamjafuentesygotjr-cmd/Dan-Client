/**
 * POST /api/notify — powers the "Send test" button in the desk.
 * The recipient comes from the environment variables, never from the request.
 */
import { sendMail, json, cors, tokenOk } from '../lib/desk.js';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (!tokenOk(request)) return json({ error: 'bad token' }, 401);

    try {
      const p = await request.json();
      const portal = p?.to?.portal === 'team' ? 'team' : 'client';
      const res = await sendMail(portal, {
        fromName: p?.from?.name || 'Prospect Desk',
        messages: Array.isArray(p?.messages) ? p.messages : [],
        preview: p?.preview || '',
        link: typeof p?.link === 'string' ? p.link : '',
        isTest: p?.event === 'test',
      });
      return res.ok ? json({ ok: true, to: portal, via: res.via }) : json({ ok: false, error: res.error }, 502);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  },
};
