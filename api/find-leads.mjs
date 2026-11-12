/* api/find-leads.mjs — Vercel Function for Dan's Prospect Desk: "Add more leads" (Investor Survey 2027)
   ---------------------------------------------------------------------------------------------------------
   Put this file in the dan-client repo as  api/find-leads.mjs  (next to api/state.js and api/notify.js).
   Vercel → Project → Settings → Environment Variables — set ONE of these (in Vercel only; never in chat or code):
     OPENAI_API_KEY      an OpenAI API key (platform.openai.com) — uses the Responses API with web search
     ANTHROPIC_API_KEY   an Anthropic API key (console.anthropic.com) — uses Claude with web search
   Optional:
     LEADS_PROVIDER      'openai' or 'anthropic' — only needed if both keys are set (default: anthropic)
     OPENAI_MODEL        default gpt-5-mini        LEADS_MODEL   Claude model, default claude-sonnet-4-5
     DESK_TOKEN          if already set for api/state, this function checks it too
   Then redeploy. The desk calls POST /api/find-leads {cat, count, exclude:{slugs, names, full}}.

   What it does: asks the AI (OpenAI or Claude), with its web search tool, to find people who fit one segment of the Engagement Team
   Playbook. A lead is returned ONLY if (1) its linkedin.com/in/… profile address appeared in the search results and
   (2) its deal / qualification source URL appeared in the search results. Nothing is invented: anything the search did
   not actually find is dropped. LinkedIn itself is never logged into or scraped; only public search results are used.
   The desk then re-checks duplicates, skip titles and the two-per-firm limit before saving. */

export const maxDuration = 300;

const MODEL = process.env.LEADS_MODEL || 'claude-sonnet-4-5';
const OAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const SEG = {
  PE: 'PRIVATE EQUITY firms that invested in a youth sports business in the past three years (or are actively doing so). Primary titles: Managing Partner, Partner, Managing Director. Backup: Principal, Vice President or Operating Partner on a consumer, franchise, sports or education deal team.',
  VC: 'VENTURE CAPITAL firms that invested in youth sports companies (youth sports software, leagues, clubs, training, events) in the past three years. Primary: General Partner, Managing Partner. Backup: Partner or Principal covering sports tech or consumer.',
  FO: 'FAMILY OFFICES (single or multi-family offices, including sports-owner family investment vehicles) that invested in or bought a youth sports business in the past three years. Primary: Chief Investment Officer, Managing Director. Backup: Director of Direct Investments, Principal.',
  ST: 'STRATEGIC or CORPORATE investors (public or private companies) that acquired or invested in youth sports businesses in the past three years. Primary: Head or VP of Corporate Development, Chief Strategy Officer. Backup: Head of Ventures, CFO.',
  OA: 'DEAL-ACTIVE YOUTH SPORTS OPERATORS AND ACQUIRERS: youth sports companies that in the past three years bought or sold a youth sports business, raised outside capital, or run multiple programs across markets or a franchise system (multi-program operators, roll-ups, franchisors, PE-backed platforms, regional consolidators). Primary: CEO, Founder, President, Owner. Backup: Head/VP of Corporate Development or M&A, CFO, COO.',
  OT: 'ANGELS AND INDEPENDENT SPONSORS who invested in youth sports businesses, and M&A ADVISORS / INVESTMENT BANKERS who worked on youth sports, sports, consumer or franchise deals. Primary: Founder, Managing Partner, Managing Director (consumer, sports or franchise coverage). Backup: Director.'
};
const RULES = `Do NOT include: program directors, coaches, parents, nonprofits, researchers, governing bodies, brands and sponsors, technology vendors with no deal activity, reporters, or single-program owners. Skip analysts, associates, investor relations, marketing, HR, franchise sales / development / recruitment roles, regional or site managers.
Prefer U.S. people and deals. Never more than two people from the same firm.`;
const SKIP = [/\banalyst\b/i, /\bassociate\b/i, /investor relations/i, /\bmarketing\b/i, /\bhuman resources\b|\bHR\b/, /franchise (sales|recruit|development)/i, /\brecruit/i, /\bregional\b|\bsite manager\b/i, /\bcoach\b/i];

const canon = u => String(u || '').toLowerCase().trim().replace(/^https?:\/\/([a-z]{2,3}\.)?(www\.)?/, '').split(/[?#]/)[0].replace(/\/+$/, '');
const slugOf = u => { const m = String(u || '').match(/linkedin\.com\/in\/([^\/?#\s"'<>)]+)/i); if (!m) return ''; try { return decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, ''); } catch (e) { return m[1].toLowerCase(); } };
const nameKey = (n, c) => String(n || '').toLowerCase().replace(/[^a-z]/g, '') + '|' + String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function collectUrls(blocks, found) {
  for (const b of blocks || []) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r && r.url) found.add(r.url);
    if (b.type === 'text' && Array.isArray(b.citations)) for (const c of b.citations) if (c && c.url) found.add(c.url);
  }
}

async function callOpenAI(key, body) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'authorization': 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('OpenAI API ' + r.status));
  return j;
}
async function runOpenAI(key, prompt, count) {
  const body = { model: OAI_MODEL, input: prompt, tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'], max_output_tokens: 16000 };
  if (/^(gpt-5|o\d)/i.test(OAI_MODEL)) body.reasoning = { effort: 'low' };
  const j = await callOpenAI(key, body);
  const found = new Set(); let searches = 0; let text = '';
  for (const it of j.output || []) {
    if (it.type === 'web_search_call') { searches++; for (const src of (it.action && it.action.sources) || []) if (src && src.url) found.add(src.url); }
    if (it.type === 'message') for (const c of it.content || []) { if (c.type === 'output_text') { text += c.text + '\n'; for (const a of c.annotations || []) if (a && a.url) found.add(a.url); } }
  }
  if (!text && j.output_text) text = j.output_text;
  return { text, found, searches, model: OAI_MODEL, provider: 'openai' };
}
async function runClaude(key, prompt, count) {
  const found = new Set();
  const messages = [{ role: 'user', content: prompt }];
  let final = null, searches = 0;
  for (let turn = 0; turn < 4; turn++) {
    const j = await callClaude(key, { model: MODEL, max_tokens: 8000, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(30, 6 + count * 2) }] });
    collectUrls(j.content, found);
    searches += (j.usage && j.usage.server_tool_use && j.usage.server_tool_use.web_search_requests) || 0;
    if (j.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: j.content }); continue; }
    final = j; break;
  }
  if (!final) { const e = new Error('The lead search took too long. Try a smaller number.'); e.code = 504; throw e; }
  const text = (final.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { text, found, searches, model: MODEL, provider: 'anthropic' };
}

async function callClaude(key, body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('Anthropic API ' + r.status));
  return j;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST.' }); return; }
  if (process.env.DESK_TOKEN && req.headers['x-desk-token'] !== process.env.DESK_TOKEN) { res.status(401).json({ error: 'Not authorised.' }); return; }
  const aKey = process.env.ANTHROPIC_API_KEY, oKey = process.env.OPENAI_API_KEY;
  const want = String(process.env.LEADS_PROVIDER || '').toLowerCase();
  const provider = oKey && (want === 'openai' || !aKey) ? 'openai' : aKey ? 'anthropic' : '';
  if (!provider) { res.status(501).json({ error: 'The lead search is not set up yet: add OPENAI_API_KEY (or ANTHROPIC_API_KEY) in Vercel → Settings → Environment Variables, then redeploy.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const cat = String(body.cat || '');
  if (!SEG[cat]) { res.status(400).json({ error: 'Unknown segment.' }); return; }
  const count = Math.min(15, Math.max(1, parseInt(body.count, 10) || 10));
  const ex = body.exclude || {};
  const exSlugs = new Set((ex.slugs || []).map(s => String(s).toLowerCase()));
  const exNames = new Set((ex.names || []).map(s => { const [n, c] = String(s).split(' | '); return nameKey(n, c); }));
  const fullFirms = (ex.full || []).map(String);
  const fullSet = new Set(fullFirms.map(f => f.toLowerCase()));

  const prompt = `You are researching invitees for the "Youth Sports Market Outlook 2027" investor survey (Signature Athletics / Signature Media).
Find ${count} NEW people for this segment:
${SEG[cat]}
${RULES}

Already on the list (do not return them): ${(ex.names || []).slice(0, 400).join('; ') || 'none'}.
Firms already at the two-person limit (do not return anyone from them): ${fullFirms.join('; ') || 'none'}.

Method: use web search to find recent (2023-2026) youth sports deals, investments or acquisitions and the senior people behind them, then search for each person's public LinkedIn profile (e.g. "First Last Company linkedin"). Only include a person if a search result showed their linkedin.com/in/ profile address AND a search result showed the deal or fact that qualifies them. Use the exact URLs from the search results. Confirm the current title from the results.

Answer with ONLY this JSON inside <leads></leads> tags (no other text after it):
<leads>[{"name":"","title":"","company":"","location":"","industry":"","url":"https://www.linkedin.com/in/...","evidence":"https://... (the deal or qualification source)","reason":"one sentence: the youth sports deal and why they fit","type":"e.g. Private equity fund","basis":"primary or backup title, and anything to confirm"}]</leads>
If you cannot verify ${count}, return fewer. Never invent a person, title or URL.`;

  let out;
  try { out = provider === 'openai' ? await runOpenAI(oKey, prompt, count) : await runClaude(aKey, prompt, count); }
  catch (e) { res.status(e.code || 502).json({ error: (e.code ? '' : 'Lead search failed: ') + e.message }); return; }
  const { text, found, searches } = out;
  const m = text.match(/<leads>([\s\S]*?)<\/leads>/i);
  let raw = [];
  try { raw = JSON.parse(m ? m[1] : (text.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch (e) { raw = []; }
  if (!Array.isArray(raw)) raw = [];

  const foundSlugs = new Set([...found].map(slugOf).filter(Boolean));
  const foundCanon = new Set([...found].map(canon));
  const leads = [], rejected = [], seen = new Set(), firmN = {};
  for (const L of raw) {
    const name = String(L && L.name || '').trim(), title = String(L && L.title || '').trim(), company = String(L && L.company || '').trim();
    const sl = slugOf(L && L.url), ev = String(L && L.evidence || '').trim();
    const why = !name || !title || !company ? 'missing name, title or firm'
      : !sl ? 'no linkedin.com/in/ profile'
      : !foundSlugs.has(sl) ? 'LinkedIn profile not seen in the search results'
      : !ev || !foundCanon.has(canon(ev)) ? 'qualification source not seen in the search results'
      : exSlugs.has(sl) || exNames.has(nameKey(name, company)) || seen.has(sl) ? 'already on the list'
      : SKIP.some(rx => rx.test(title)) ? 'title on the playbook skip list'
      : fullSet.has(company.toLowerCase()) || (firmN[company.toLowerCase()] || 0) >= 2 ? 'firm already has two people' : '';
    if (why) { rejected.push({ name: name || '(no name)', why }); continue; }
    seen.add(sl); firmN[company.toLowerCase()] = (firmN[company.toLowerCase()] || 0) + 1;
    leads.push({ name, title, company, location: String(L.location || '').trim(), industry: String(L.industry || '').trim(), url: 'https://www.linkedin.com/in/' + sl,
      evidence: ev, reason: String(L.reason || '').trim().slice(0, 400), type: String(L.type || '').trim().slice(0, 80), basis: String(L.basis || '').trim().slice(0, 300) });
    if (leads.length >= count) break;
  }
  res.status(200).json({ cat, leads, rejected, searches, model: out.model, provider: out.provider });
}
