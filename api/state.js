/**
 * GET  /api/state?rev=1  → {rev}          cheap revision check (polled every 5s)
 * GET  /api/state        → {rev, data}    the whole database
 * POST /api/state        → {rev, notified}  save, then email anything new in the chat
 */
import { readState, readHead, writeState, notifyNewMessages, storageReady, json, cors, tokenOk } from '../lib/desk.js';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (!tokenOk(request)) return json({ error: 'bad token' }, 401);
    if (!storageReady()) {
      return json({ error: 'No Redis store connected. In Vercel: Storage → add a Redis database from the Marketplace, then redeploy.' }, 500);
    }

    try {
      if (request.method === 'GET') {
        const url = new URL(request.url);
        if (url.searchParams.get('rev') === '1') {
          // the 5-second poll: reads one tiny key, never the leads
          const head = await readHead();
          return json({ rev: head?.rev || 0 });
        }
        const stored = await readState();
        return json({ rev: stored?.rev || 0, data: stored?.data || null });
      }

      if (request.method === 'POST') {
        const body = await request.json();
        if (!body || typeof body.data !== 'object' || body.data === null) {
          return json({ error: 'expected {rev, data}' }, 400);
        }
        const { rev, prev } = await writeState(body.rev, body.data);
        let notified = [];
        try {
          notified = await notifyNewMessages(prev?.data || null, body.data);
        } catch (e) {
          notified = [{ error: e.message }];   // a mail failure must never lose the save
        }
        return json({ rev, notified });
      }

      return json({ error: 'method not allowed' }, 405);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
