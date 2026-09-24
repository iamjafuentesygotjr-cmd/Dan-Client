/**
 * CrossCore Prospect Desk — shared backend logic
 * ==============================================
 * Used by api/state.js and api/notify.js. Two jobs:
 *
 *   1. Store the desk's database in Redis, so everyone who opens the site reads
 *      and writes the SAME records. Without this the desk falls back to
 *      per-browser storage and the chat cannot cross between two computers.
 *
 *   2. Watch every save for new chat messages and send the email. The server
 *      does the sending, so an alert goes out even if the sender closes their
 *      laptop, and neither person needs anything set up on their own device.
 *
 * SECURITY: recipient addresses come from environment variables here, never
 * from the browser. Someone who found these URLs could not use them to email
 * anyone except the two people configured in the Vercel dashboard.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const LEGACY = 'desk-state-v1';        // whole-document format, read once then migrated
const HEAD = 'desk:v2:head';           // {rev, n, savedAt} — tiny, this is what polling reads
const MAN = 'desk:v2:man';             // {hashes:{…}} — which parts changed last time
const CORE = 'desk:v2:core';           // everything except the leads (about 2 KB)
const CHUNK = (i) => `desk:v2:p:${i}`; // leads, 200 per chunk
const PER_CHUNK = 200;

const META = 'desk-notify-meta-v1';
const QUIET_MS = 60_000;     // at most one alert per person per minute
const ACTIVE_MS = 120_000;   // silent if they had the chat open this recently

/* ---------------- Redis (Upstash REST) ---------------- */
/* The Vercel Marketplace integration injects these under one of two names
   depending on when the store was created, so accept both. */
const redisUrl = () =>
  (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const redisToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export function storageReady() {
  return !!(redisUrl() && redisToken());
}

async function redis(command) {
  const url = redisUrl();
  if (!url) throw new Error('No Redis store connected — add one from the Vercel Marketplace (Storage tab)');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`redis ${res.status}: ${truncate(await res.text(), 120)}`);
  const j = await res.json();
  return j.result;
}

const kvGet = async (k) => {
  const v = await redis(['GET', k]);
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
};
const kvSet = (k, v) => redis(['SET', k, JSON.stringify(v)]);

/* ---------------- state ----------------
   The desk's database is about 1.7 MB, and the naive approach — rewriting all of
   it every time somebody flips one lead's status — burns through a free Redis
   plan's bandwidth for no reason. So it is stored in pieces:

     head    {rev, n}          tiny; this is all a 5-second poll reads
     core    everything except the leads, gzipped (~2 KB)
     p:0..N  the leads, 200 per chunk, gzipped (~14 KB each)

   A save compares each piece's hash against the manifest and writes only the
   pieces that actually changed. One status change costs roughly 17 KB instead
   of 1.7 MB, and a full read costs about 200 KB instead of 1.7 MB. */

const pack = (obj) => gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 6 }).toString('base64');
const unpack = (s) => {
  if (s == null) return null;
  try { return JSON.parse(gunzipSync(Buffer.from(s, 'base64')).toString('utf8')); }
  catch { return null; }
};
const hash = (s) => createHash('sha1').update(s).digest('base64');

function split(data) {
  const prospects = Array.isArray(data.prospects) ? data.prospects : [];
  const core = { ...data };
  delete core.prospects;
  const chunks = [];
  for (let i = 0; i < prospects.length; i += PER_CHUNK) chunks.push(prospects.slice(i, i + PER_CHUNK));
  if (!chunks.length) chunks.push([]);   // always at least one, so n is never 0
  return { core, chunks };
}

export async function readHead() {
  const head = await kvGet(HEAD);
  if (head) return head;
  const legacy = await kvGet(LEGACY);     // first run after the upgrade
  return legacy ? { rev: legacy.rev || 0, n: -1, legacy: true } : null;
}

export async function readState() {
  const head = await readHead();
  if (!head) return null;
  if (head.legacy) return await kvGet(LEGACY);

  const keys = [CORE];
  for (let i = 0; i < head.n; i++) keys.push(CHUNK(i));
  const parts = await redis(['MGET', ...keys]);      // one command, whatever the size
  const core = unpack(parts[0]);
  if (!core) return null;
  const prospects = [];
  for (let i = 1; i < parts.length; i++) {
    const c = unpack(parts[i]);
    if (Array.isArray(c)) prospects.push(...c);
  }
  return { rev: head.rev, savedAt: head.savedAt, data: { ...core, prospects } };
}

/* Only the core is needed to work out which chat messages are new, and the core
   is 2 KB — so a save never has to pull the leads back out of Redis. */
export async function readCore() {
  const head = await readHead();
  if (!head) return null;
  if (head.legacy) {
    const legacy = await kvGet(LEGACY);
    if (!legacy?.data) return null;
    const { prospects, ...core } = legacy.data;
    return core;
  }
  return unpack(await redis(['GET', CORE]));
}

export async function writeState(incomingRev, data) {
  const [head, man] = await Promise.all([readHead(), kvGet(MAN)]);
  const prevCore = await readCore();
  const rev = Math.max(head?.rev || 0, Number(incomingRev) || 0) + 1;
  const savedAt = Date.now();

  const { core, chunks } = split(data);
  const prevHashes = (man && man.hashes) || {};
  const hashes = {};
  const pairs = [];

  const corePacked = pack(core);
  hashes.core = hash(corePacked);
  if (hashes.core !== prevHashes.core) pairs.push(CORE, corePacked);

  chunks.forEach((c, i) => {
    const packed = pack(c);
    const h = hash(packed);
    hashes['p' + i] = h;
    if (h !== prevHashes['p' + i]) pairs.push(CHUNK(i), packed);
  });

  pairs.push(HEAD, JSON.stringify({ rev, n: chunks.length, savedAt }));
  pairs.push(MAN, JSON.stringify({ hashes }));
  await redis(['MSET', ...pairs]);

  // the lead list shrank — clear the chunks that are no longer part of it
  const oldN = head && head.n > 0 ? head.n : 0;
  if (oldN > chunks.length) {
    const stale = [];
    for (let i = chunks.length; i < oldN; i++) stale.push(CHUNK(i));
    await redis(['DEL', ...stale]);
  }

  const written = pairs.length / 2;
  return { rev, prev: prevCore ? { data: prevCore } : null, written };
}

/* ---------------- notification ---------------- */
export async function notifyNewMessages(prevData, data) {
  const msgs = Array.isArray(data?.messages) ? data.messages : [];
  if (!msgs.length) return [];
  const notify = data.notify || {};
  if (notify.enabled === false) return [{ skipped: 'notifications switched off in the desk' }];

  const seen = new Set((Array.isArray(prevData?.messages) ? prevData.messages : []).map((m) => m.id));
  const fresh = msgs.filter((m) => !seen.has(m.id) && !m.deleted && m.text);
  if (!fresh.length) return [];

  const meta = (await kvGet(META)) || {};
  const now = Date.now();
  const out = [];

  for (const portal of ['team', 'client']) {
    const incoming = fresh.filter((m) => m.from !== portal);
    if (!incoming.length) continue;

    const readAt = Number(data.chatRead?.[portal] || 0);
    if (now - readAt < ACTIVE_MS) { out.push({ to: portal, skipped: 'already reading the chat' }); continue; }
    if (now - Number(meta[portal] || 0) < QUIET_MS) { out.push({ to: portal, skipped: 'notified within the last minute' }); continue; }

    // everything they have not read, so one email covers a whole burst
    const unread = msgs
      .filter((m) => m.from !== portal && !m.deleted && m.text && m.ts > readAt)
      .slice(-10)
      .map((m) => ({ from: m.name || fallbackName(m.from), ts: m.ts, text: m.text }));

    const last = incoming[incoming.length - 1];
    const res = await sendMail(portal, {
      fromName: last.name || fallbackName(last.from),
      messages: unread.length ? unread : [{ from: last.name, ts: last.ts, text: last.text }],
      preview: last.text,
      link: buildLink(notify.appUrl, portal),
      isTest: false,
    });
    if (res.ok) { meta[portal] = now; out.push({ to: portal, sent: true }); }
    else out.push({ to: portal, error: res.error });
  }

  if (out.some((o) => o.sent)) await kvSet(META, meta);
  return out;
}

const fallbackName = (p) => (p === 'team' ? 'CrossCore VA' : 'Kallista');

function buildLink(appUrl, portal) {
  const base = String(appUrl || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return '';
  return `${base}?portal=${portal}&chat=1`;
}

/* ---------------- mail ----------------
   Three ways to send, so you are never blocked on owning a domain. Whichever
   is configured gets used, in this order:

     GMAIL_APP_PASSWORD → your own Gmail sends the mail over SMTP. Free, and
                          properly authenticated, so it reaches the inbox
                          rather than the spam folder. No domain needed.
     RESEND_API_KEY     → Resend. Best deliverability, but needs a domain you
                          can add DNS records to.
     BREVO_API_KEY      → Brevo. Verify one address by email; no DNS. Mail from
                          a gmail.com sender often lands in spam, so this is
                          the last resort.  */
export async function sendMail(portal, o) {
  const to = portal === 'team' ? process.env.EMAIL_TEAM : process.env.EMAIL_CLIENT;
  if (!to) return { ok: false, error: `no address configured for ${portal} (set EMAIL_${portal.toUpperCase()})` };

  const gmailUser = (process.env.GMAIL_USER || '').trim();
  const gmailPass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''); // Google shows it in groups of four

  // Gmail only lets you send as the account you signed in with, so build the
  // From line from GMAIL_USER and borrow just the display name from MAIL_FROM.
  const displayName = (() => {
    const m = /^\s*(.*?)\s*<[^>]+>\s*$/.exec(process.env.MAIL_FROM || '');
    return (m && m[1]) || 'Prospect Desk';
  })();
  const from = gmailUser && gmailPass ? `${displayName} <${gmailUser}>` : process.env.MAIL_FROM;
  if (!from) return { ok: false, error: 'MAIL_FROM is not set' };

  const subject = o.isTest ? 'Prospect Desk — test notification' : `${o.fromName}: ${truncate(o.preview, 60)}`;
  const html = htmlBody(o);
  const text = textBody(o);

  try {
    if (gmailUser && gmailPass) {
      const { default: nodemailer } = await import('nodemailer');
      // SMTP_HOST/SMTP_PORT let this point at another provider; Gmail by default
      const port = Number(process.env.SMTP_PORT || 465);
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port,
        secure: port === 465,
        auth: { user: gmailUser, pass: gmailPass },
        tls: process.env.SMTP_INSECURE === '1' ? { rejectUnauthorized: false } : undefined,
      });
      await transport.sendMail({ from, to, subject, text, html });
      return { ok: true, via: 'gmail' };
    }

    if (process.env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      if (!res.ok) return { ok: false, error: `resend ${res.status}: ${truncate(await res.text(), 200)}` };
      return { ok: true, via: 'resend' };
    }

    if (process.env.BREVO_API_KEY) {
      const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(from);
      const sender = m ? { name: m[1] || 'Prospect Desk', email: m[2] } : { name: 'Prospect Desk', email: from.trim() };
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
      });
      if (!res.ok) return { ok: false, error: `brevo ${res.status}: ${truncate(await res.text(), 200)}` };
      return { ok: true, via: 'brevo' };
    }

    return { ok: false, error: 'No mail provider configured — set GMAIL_USER + GMAIL_APP_PASSWORD, or RESEND_API_KEY, or BREVO_API_KEY' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------------- helpers ---------------- */
export const cors = () => ({
  'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Desk-Token',
  'Access-Control-Max-Age': '86400',
});
export const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors(), 'Content-Type': 'application/json' } });
export function tokenOk(request) {
  const want = process.env.DESK_TOKEN;
  return !want || request.headers.get('X-Desk-Token') === want;
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (ts) => {
  try {
    return new Date(ts).toLocaleString('en-US', {
      timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
};

function textBody(o) {
  const lines = o.messages.length
    ? o.messages.map((m) => `${m.from || o.fromName} (${when(m.ts)}):\n${m.text}`).join('\n\n')
    : o.preview;
  return `New message in the CrossCore Prospect Desk\n\n${lines}\n\n${o.link ? `Open the conversation: ${o.link}\n` : ''}`;
}

function htmlBody(o) {
  const bubbles = (o.messages.length ? o.messages : [{ from: o.fromName, ts: Date.now(), text: o.preview }])
    .map((m) => `
      <tr><td style="padding:0 0 14px">
        <div style="font:600 12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#8B8374;padding-bottom:5px">
          ${esc(m.from || o.fromName)} &middot; ${esc(when(m.ts))}</div>
        <div style="background:#FBF3DA;border:1px solid #EBD79A;border-radius:12px;padding:12px 14px;
          font:400 15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#161310;white-space:pre-wrap"
          >${esc(m.text)}</div>
      </td></tr>`).join('');

  return `<!doctype html><html><body style="margin:0;padding:0;background:#F8F6F0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8F6F0;padding:28px 14px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="max-width:540px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 14px rgba(22,19,16,.08)">
        <tr><td style="height:5px;background:linear-gradient(90deg,#DE9200,#F2B90D 60%,#FFD75E);font-size:0">&nbsp;</td></tr>
        <tr><td style="padding:24px 26px 6px">
          <div style="font:800 12px/1 Archivo,Arial,sans-serif;letter-spacing:.16em;color:#161310">CROSS CORE OPC</div>
          <div style="font:600 10.5px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.2em;color:#8B8374">PROSPECT DESK</div>
          <h1 style="margin:16px 0 4px;font:700 20px/1.3 Archivo,Arial,sans-serif;color:#161310">
            ${o.isTest ? 'Test notification' : `New message from ${esc(o.fromName)}`}</h1>
          ${o.isTest ? '<p style="margin:0 0 6px;font:400 14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#3D3830">If this reached you, notifications are wired up correctly.</p>' : ''}
        </td></tr>
        <tr><td style="padding:14px 26px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bubbles}</table></td></tr>
        ${o.link ? `<tr><td style="padding:6px 26px 26px">
          <a href="${esc(o.link)}" style="display:inline-block;background:#F2B90D;color:#161310;text-decoration:none;
            font:700 14px/1 Archivo,Arial,sans-serif;padding:13px 22px;border-radius:10px">Open the conversation &rarr;</a>
          <div style="font:400 11.5px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#8B8374;padding-top:10px">
            Opens the chat in the Prospect Desk so you can reply straight away.</div></td></tr>` : ''}
        <tr><td style="padding:0 26px 22px">
          <div style="border-top:1px solid #F0EBDF;padding-top:14px;
            font:400 11.5px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#8B8374">
            Sent automatically by the CrossCore Prospect Desk.</div></td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}
