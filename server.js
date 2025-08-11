import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { load as loadHtml } from 'cheerio';

dotenv.config();

const app = express();
const port = process.env.PORT || 8787;

app.use(express.json({ limit: '1mb' }));

// CORS for API endpoints
app.use('/api', cors({ origin: true }));

// Static files (serves /embed.js and demo page)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: false }));

// In-memory session store (demo-grade)
const sessions = new Map();

// Provider selection
const aiProvider = (process.env.AI_PROVIDER || '').toLowerCase();
const useOpenAI = aiProvider === 'openai' || (!!process.env.OPENAI_API_KEY && aiProvider !== 'gemini');
const useGemini = aiProvider === 'gemini' || (!!process.env.GEMINI_API_KEY && aiProvider !== 'openai');

let openaiClient = null;
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';

let geminiClient = null;
const geminiModel = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

async function initAIClients() {
  if (useOpenAI && process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = (await import('openai')).default;
      openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      console.log('OpenAI client initialized');
    } catch (err) {
      console.error('Failed to initialize OpenAI client:', err.message);
    }
  }
  if (useGemini && process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      console.log('Gemini client initialized');
    } catch (err) {
      console.error('Failed to initialize Gemini client:', err.message);
    }
  }
}

function cryptoRandomId() {
  return 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function buildMessages(context, history) {
  const system = [
    {
      role: 'system',
      content:
        'You are a helpful website assistant. Be concise and friendly. If appropriate, collect lead info (name, email, company) politely.'
    }
  ];
  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) {
      if (value && key !== 'siteSummary' && key !== 'siteFactsJson') {
        system.push({ role: 'system', content: `${key}: ${String(value)}` });
      }
    }
    if (context.siteFactsJson) {
      system.push({ role: 'system', content: `Website facts (JSON): ${context.siteFactsJson}` });
    }
  }
  const messages = system.concat(history.map(m => ({ role: m.role, content: m.content })));
  return messages;
}

function ruleBasedReply(text) {
  const t = (text || '').toLowerCase();
  if (/(^|\b)(hi|hello|hey)(\b|!|\.)/.test(t)) return 'Hi! How can I help you today?';
  if (/pricing|cost|price/.test(t)) return 'For pricing, please share your email and company, and our team will reach out.';
  if (/contact|sales|demo/.test(t)) return 'I can connect you. Please provide your name, email, and company.';
  return `You said: "${text}". Connect a model via OPENAI_API_KEY or GEMINI_API_KEY for smarter answers.`;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, provider: useOpenAI ? 'openai' : useGemini ? 'gemini' : 'rules' });
});

async function replyWithOpenAI(messages) {
  const completion = await openaiClient.chat.completions.create({
    model: openaiModel,
    messages,
    temperature: 0.3
  });
  return completion.choices?.[0]?.message?.content?.trim() || '...';
}

async function replyWithGemini(messages) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const convo = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  const prompt = `${sys}\n\n${convo}\nAssistant:`;

  const model = geminiClient.getGenerativeModel({ model: geminiModel });
  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || result?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
  return (typeof text === 'function' ? text() : text) || '...';
}

// Simple website fetch + extract + cache + optional summary
const siteCache = new Map(); // url -> { summary, title, fetchedAt }
const SITE_TTL_MS = 10 * 60 * 1000;

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractTextFromHtml(html) {
  const $ = loadHtml(html);
  $('script, style, noscript, svg, iframe, canvas').remove();
  const title = ($('title').first().text() || '').trim();
  const main = $('main').text() || $('article').text() || $('body').text();
  const text = (main || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
  return { title, text, $ };
}

async function summarizeContent(rawText, title) {
  const input = `${title ? `Title: ${title}\n\n` : ''}${rawText}`.slice(0, 24000);
  const messages = [
    { role: 'system', content: 'Summarize the following webpage into concise bullet points with key offerings, services, industries, differentiators, locations, and contact/CTA info. Keep it under 1200 words. Preserve factual details. Use neutral tone.' },
    { role: 'user', content: input }
  ];
  try {
    if (openaiClient) return await replyWithOpenAI(messages);
    if (geminiClient) return await replyWithGemini(messages);
  } catch (e) {
    console.error('Summary generation failed:', e.message);
  }
  return input.slice(0, 2000);
}

async function getSiteSummary(url) {
  try {
    const now = Date.now();
    const cached = siteCache.get(url);
    if (cached && now - cached.fetchedAt < SITE_TTL_MS) return cached;

    const html = await fetchHtml(url);
    const { title, text } = extractTextFromHtml(html);
    const summary = await summarizeContent(text, title);
    const value = { summary, title, fetchedAt: now };
    siteCache.set(url, value);
    return value;
  } catch (e) {
    console.error('getSiteSummary error:', e.message);
    return null;
  }
}

// ----- Crawler and entity extraction -----
const knowledgeCache = new Map(); // origin -> { people, emails, links, images, crawledAt }
const KNOW_TTL_MS = 60 * 60 * 1000;

function toOrigin(u) {
  try { return new URL(u).origin; } catch { return ''; }
}
function sameOrigin(a, b) {
  return toOrigin(a) && toOrigin(a) === toOrigin(b);
}
function normalizeUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function extractEntities($, pageUrl) {
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const emails = new Set();
  const links = new Set();
  const images = new Set();
  const people = [];

  // Emails from mailto and text
  $('a[href^="mailto:"]').each((_, el) => {
    const email = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0];
    if (email) emails.add(email);
  });
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  for (const m of text.match(emailRegex) || []) emails.add(m);

  // Links and LinkedIn
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    try { links.add(new URL(href, pageUrl).toString()); } catch {}
  });

  // Images
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    try { images.add(new URL(src, pageUrl).toString()); } catch {}
  });

  // Heuristic: leadership/team sections
  const candidateSections = [];
  $('section, div, ul, article').each((_, el) => {
    const s = $(el);
    const heading = s.find('h1,h2,h3,h4').first().text().toLowerCase();
    if (/team|leadership|management|about/i.test(heading)) candidateSections.push(s);
  });
  const scopes = candidateSections.length ? candidateSections : [$("body")];

  scopes.forEach(scope => {
    scope.find('li, .card, .member, .person, article, div').each((_, el) => {
      const block = $(el);
      const blockText = block.text().replace(/\s+/g, ' ').trim();
      if (!/(ceo|chief executive|founder|co[- ]founder|cto|cfo|coo|director|head)/i.test(blockText)) return;

      // Name guess: from headings or strong tags
      const name = block.find('h1,h2,h3,h4,strong,b').first().text().trim() || (blockText.split(/[\.,\n]/)[0] || '').trim();
      if (!name || name.length < 2 || name.length > 80) return;

      // Role guess
      let role = '';
      const roleMatch = blockText.match(/(chief [a-z ]+ officer|ceo|cto|cfo|coo|founder|co[- ]founder|director|head of [^\.,]+)/i);
      if (roleMatch) role = roleMatch[0];

      // Links
      let linkedin = '';
      block.find('a[href*="linkedin.com"]').each((_, a) => {
        if (!linkedin) linkedin = new URL($(a).attr('href'), pageUrl).toString();
      });

      // Image near person
      let image = '';
      const img = block.find('img[src]').first();
      if (img && img.attr('src')) {
        try { image = new URL(img.attr('src'), pageUrl).toString(); } catch {}
      }

      // Email in block
      let email = '';
      block.find('a[href^="mailto:"]').each((_, a) => { if (!email) email = ($(a).attr('href') || '').replace(/^mailto:/i, '').split('?')[0]; });

      // Profile URL (self link)
      let profileUrl = '';
      const selfLink = block.find('a[href]').first();
      if (selfLink && selfLink.attr('href')) {
        try { profileUrl = new URL(selfLink.attr('href'), pageUrl).toString(); } catch {}
      }

      const person = { name, role, email, linkedin, image, profileUrl };
      // De-dup by name+role
      if (!people.some(p => p.name.toLowerCase() === name.toLowerCase() && (!p.role || p.role === role))) {
        people.push(person);
      }
    });
  });

  return {
    people,
    emails: Array.from(emails),
    links: Array.from(links),
    images: Array.from(images)
  };
}

async function crawlSite(startUrl, opts = {}) {
  const { maxPages = 10, maxDepth = 2 } = opts;
  const origin = toOrigin(startUrl);
  const queue = [{ url: startUrl, depth: 0 }];
  const visited = new Set();
  const aggregate = { people: [], emails: new Set(), links: new Set(), images: new Set() };

  while (queue.length && visited.size < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url) || depth > maxDepth) continue;
    visited.add(url);

    try {
      const html = await fetchHtml(url);
      const { $, text } = extractTextFromHtml(html);
      const ent = extractEntities($, url);
      ent.people.forEach(p => aggregate.people.push(p));
      ent.emails.forEach(e => aggregate.emails.add(e));
      ent.links.forEach(l => aggregate.links.add(l));
      ent.images.forEach(i => aggregate.images.add(i));

      // Enqueue same-origin links that look like pages we care about
      $('a[href]').each((_, a) => {
        const next = normalizeUrl(url, $(a).attr('href'));
        if (!next || !sameOrigin(startUrl, next)) return;
        if (/[#?]$/.test(next)) return;
        if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|rar|7z|mp4|mp3|avi)$/i.test(next)) return;
        if (/\b(career|blog|terms|privacy)\b/i.test(next)) return;
        if (!visited.has(next)) queue.push({ url: next, depth: depth + 1 });
      });
    } catch (e) {
      // ignore page errors
    }
  }

  // Deduplicate people by name
  const uniquePeople = [];
  for (const p of aggregate.people) {
    if (!uniquePeople.some(q => q.name.toLowerCase() === p.name.toLowerCase())) uniquePeople.push(p);
  }

  const knowledge = {
    people: uniquePeople,
    emails: Array.from(aggregate.emails),
    links: Array.from(aggregate.links),
    images: Array.from(aggregate.images),
    crawledAt: Date.now(),
    origin
  };
  knowledgeCache.set(origin, knowledge);
  return knowledge;
}

function getCachedKnowledge(url) {
  const origin = toOrigin(url);
  const k = knowledgeCache.get(origin);
  if (k && Date.now() - k.crawledAt < KNOW_TTL_MS) return k;
  return null;
}

app.get('/api/crawl', async (req, res) => {
  const url = req.query.url;
  const maxPages = Math.min(parseInt(req.query.maxPages || '10', 10) || 10, 30);
  const maxDepth = Math.min(parseInt(req.query.maxDepth || '2', 10) || 2, 5);
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });
  try {
    const knowledge = await crawlSite(url, { maxPages, maxDepth });
    res.json(knowledge);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to crawl' });
  }
});

function likelyInfoQuery(text) {
  const t = (text || '').toLowerCase();
  return /(ceo|founder|lead(er|ership)|team|contact|email|linkedin|profile|head|director)/i.test(t);
}

app.post('/api/message', async (req, res) => {
  const { sessionId, message, user, context } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing "message" string' });
  }

  const sid = sessionId || cryptoRandomId();
  const history = sessions.get(sid) || [];
  history.push({ role: 'user', content: message, ts: Date.now(), user });

  let reply = '';
  try {
    let siteFactsJson = '';
    const siteUrl = context?.siteUrl || context?.url;
    if (siteUrl && /^https?:\/\//i.test(siteUrl) && likelyInfoQuery(message)) {
      const cached = getCachedKnowledge(siteUrl);
      const knowledge = cached || (await crawlSite(siteUrl, { maxPages: 12, maxDepth: 2 }));
      siteFactsJson = JSON.stringify({
        topPeople: knowledge.people.slice(0, 8),
        emails: knowledge.emails.slice(0, 20),
        social: knowledge.links.filter(l => /linkedin\.com\//i.test(l)).slice(0, 20),
        images: knowledge.images.slice(0, 20)
      });
    }

    const ctx = Object.assign({}, context || {}, siteFactsJson ? { siteFactsJson } : {});
    let messages = buildMessages(ctx, history);

    // Include summarized website context too if provided
    const maybeSummary = await (async () => {
      if (ctx.siteUrl && /^https?:\/\//i.test(ctx.siteUrl)) {
        const site = await getSiteSummary(ctx.siteUrl);
        return site?.summary ? `Website context from ${ctx.siteUrl} (title: ${site.title || 'n/a'}):\n${site.summary}` : '';
      }
      return '';
    })();
    if (maybeSummary) messages.unshift({ role: 'system', content: maybeSummary });

    if (openaiClient) {
      reply = await replyWithOpenAI(messages);
    } else if (geminiClient) {
      reply = await replyWithGemini(messages);
    } else {
      reply = ruleBasedReply(message, context);
    }
  } catch (err) {
    console.error('Chat error:', err);
    reply = 'Sorry, I ran into an error. Please try again.';
  }

  history.push({ role: 'assistant', content: reply, ts: Date.now() });
  sessions.set(sid, history.slice(-30));

  res.json({ reply, sessionId: sid });
});

// Simple demo page route (optional)
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Embeddable Chatbot Demo</title>
</head>
<body>
  <h1>Embeddable Chatbot Demo</h1>
  <p>Open this page and use the floating chat widget, or embed from another site using the script below.</p>
  <pre><code>&lt;script src="${req.protocol}://${req.get('host')}/embed.js" data-api-base="${req.protocol}://${req.get('host')}" data-title="Website Assistant" data-primary-color="#0061ff" data-company="Acme Inc" data-site-url="https://hutechsolutions.com/"&gt;&lt;/script&gt;</code></pre>
  <script src="/embed.js" data-api-base="${req.protocol}://${req.get('host')}" data-title="Website Assistant" data-primary-color="#0061ff" data-company="Acme Inc" data-site-url="https://hutechsolutions.com/"></script>
</body>
</html>`);
});

app.listen(port, () => {
  console.log(`Chatbot server running on http://localhost:${port}`);
  initAIClients();
});