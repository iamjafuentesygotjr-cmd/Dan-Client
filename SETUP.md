# Prospect Desk — setup on GitHub + Vercel

**This replaces the Cloudflare instructions. You don't need Cloudflare at all.**

The backend now ships *inside your repo* as two Vercel Functions, so it runs on the
same address as the desk. That means there is no URL to paste into the HTML — the
step that used to involve editing code is gone.

About 10 minutes, and most of it is waiting for a deploy.

---

## What goes in the repo

```
index.html          ← the desk (replaces your current one)
package.json        ← tells Vercel these files are ES modules
api/state.js        ← shared database + sends the emails
api/notify.js       ← powers the "Send test" button
lib/desk.js         ← the logic both functions share
```

Keep the folder names exactly as they are. Vercel turns anything in `/api` into a
function automatically; `/lib` is ordinary shared code.

---

## Step 1 — Commit the files · ~2 min

Copy the five files above into your repo, replacing your existing `index.html`.

```bash
git add index.html package.json api lib
git commit -m "Add shared database and chat notifications"
git push
```

Vercel deploys on push as usual. It will succeed, but the desk will still show the
red "saving to this browser only" banner until step 2 — that's expected.

## Step 2 — Add the database · ~3 min

The desk needs somewhere to keep its records so both of you read the same ones.

1. In your Vercel project → **Storage** tab → **Create Database** →
   pick a **Redis** provider from the Marketplace (Upstash's free tier is ample —
   this desk stores one document of about 1.6 MB).
2. Connect it to this project when prompted.

Vercel injects the connection details as environment variables automatically. You
don't copy anything by hand. (Vercel KV no longer exists — Redis comes from the
Marketplace now.)

## Step 3 — Choose how email is sent · ~5 min

Pick **one**. If you can add DNS records to a domain you own, Resend is better;
if you can't, Brevo works with no domain at all.

**Option A — Resend** (best deliverability, needs a domain)

1. Sign up at **resend.com**, go to **Domains → Add Domain**, and enter a domain
   you control — ideally a subdomain such as `mail.lunapark.com`. Add the DNS
   records it shows you, then **Verify**.
   Note: without a verified domain Resend only lets you email *your own signup
   address*, so mail to Kallista would fail.
2. **API Keys → Create API Key** (Sending access). Copy it — shown once.
3. You'll set `RESEND_API_KEY`, and `MAIL_FROM` must use that domain.

**Option B — Brevo** (no domain, no DNS)

1. Sign up at **brevo.com** (free: 300 emails a day).
2. **Senders → Add a sender** using an address you can open, e.g.
   `ja.crosscore@gmail.com`. Click the link Brevo emails you to verify it.
3. **SMTP & API → API Keys → Generate**. Copy it.
4. You'll set `BREVO_API_KEY`, and `MAIL_FROM` must be that verified address.

## Step 4 — Environment variables · ~2 min

Vercel project → **Settings → Environment Variables**. Add these to
**Production** (and Preview if you use it):

| Name | Value |
|---|---|
| `MAIL_FROM` | `Prospect Desk <desk@mail.lunapark.com>` (Resend) or `Prospect Desk <ja.crosscore@gmail.com>` (Brevo) |
| `EMAIL_TEAM` | `ja.crosscore@gmail.com` |
| `EMAIL_CLIENT` | `kc7@signaturelocker.com` |
| `RESEND_API_KEY` **or** `BREVO_API_KEY` | whichever you chose in step 3 |

Optional: `DESK_TOKEN` — any random string. If you set it, put the same string in
`RELAY_TOKEN` near the top of `index.html`. It stops strangers reading or writing
your database. Leave both empty to skip it.

Then **Deployments → the latest one → Redeploy**. Environment variables only take
effect on a new deployment.

## Step 5 — Check it worked · ~1 min

Open the site and look at the bottom-left of the sidebar:

- **"Shared database · live"** in green — working.
- **Red banner across the top** — the backend isn't answering. The banner now
  prints the actual error, which is almost always "no Redis store connected"
  (step 2 incomplete) or a failed deployment.

Then go to **LinkedIn sync → Chat notifications**, set **Address of this app** to
your live URL (e.g. `https://prospects.lunapark.com/`) and Save. That is what puts
the "Open the conversation" button in the emails. Click **Send test** — it goes to
whichever side you are *not* signed in as, so from the VA portal it lands in
Kallista's inbox.

Final check: have Kallista open the site on her own computer and send you a
message. It should appear in your chat within about five seconds, and an email
should arrive.

---

## How notifications behave

- **The server sends them, not your browser.** An alert goes out even if the sender
  shuts their laptop immediately, and neither of you configures anything locally.
- **Email only — no SMS.** Nothing is sent to a phone number.
  Kallista messages you → `ja.crosscore@gmail.com`.
  You message Kallista → `kc7@signaturelocker.com`.
- **Silent when they're already looking.** No email if the recipient had the chat
  open in the last 2 minutes.
- **One per burst.** At most one email per person per minute, carrying every message
  they haven't read — five quick messages arrive as one email, not five.

## Security

The two recipient addresses live in Vercel's environment variables, not in the HTML.
The functions ignore any address sent by a browser, so nobody can use them to email
anyone but you and Kallista.

## If something doesn't work

| What you see | Cause |
|---|---|
| Red banner: "no Redis store connected" | Step 2 not finished, or you haven't redeployed since connecting it |
| Red banner: "relay read 404" | The `/api` folder didn't deploy — check `api/state.js` is committed at the repo root, not nested inside another folder |
| Red banner: "relay read 401" | `DESK_TOKEN` is set in Vercel but `RELAY_TOKEN` in `index.html` doesn't match |
| Chat syncs but no email | Check the function logs in Vercel → Observability. Usually `MAIL_FROM` isn't the verified domain/sender |
| "Send test" says no mail provider | Neither `RESEND_API_KEY` nor `BREVO_API_KEY` is set, or you haven't redeployed |
| Chat syncs, test works, real messages don't notify | Expected if the recipient had the chat open, or one was sent in the last minute |
