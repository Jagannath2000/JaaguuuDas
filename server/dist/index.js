import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import pgvector from 'pgvector/pg';
import { parse } from 'node-html-parser';
import crypto from 'crypto';
import { fetch } from 'undici';
import { OpenAIEmbeddings, ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getClient, ensureSchema, ensureGlobal } from './db.js';
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const VECTOR_DIM = Number(process.env.VECTOR_DIM || 1536);
if (!OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY not set. Set it in .env to enable embeddings and answers.');
}
const app = express();
app.use(cors({ origin: ['http://localhost:5173'], credentials: true }));
app.use(express.json({ limit: '10mb' }));
const crawlInputSchema = z.object({
    url: z.string().url(),
    maxPages: z.number().int().min(1).max(200).default(50),
    sameOriginOnly: z.boolean().default(true),
});
const querySchema = z.object({
    url: z.string().url(),
    question: z.string().min(2),
    k: z.number().int().min(1).max(20).default(5),
});
function normalizeUrl(url) {
    try {
        const u = new URL(url);
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    }
    catch {
        return url;
    }
}
async function fetchHtml(targetUrl) {
    const res = await fetch(targetUrl, {
        headers: {
            'user-agent': 'Mozilla/5.0 (RAG-Bot Crawler)'
        }
    });
    if (!res.ok)
        throw new Error(`Failed to fetch ${targetUrl}: ${res.status}`);
    return await res.text();
}
async function extractLinksAndText(baseUrl, html) {
    const root = parse(html);
    // remove noisy tags
    root.querySelectorAll('script,style,noscript').forEach(n => n.remove());
    const text = root.text.replace(/\s+/g, ' ').trim();
    const links = new Set();
    root.querySelectorAll('a').forEach(el => {
        const href = el.getAttribute('href');
        if (!href)
            return;
        try {
            const resolved = new URL(href, baseUrl).toString();
            links.add(normalizeUrl(resolved));
        }
        catch { }
    });
    // Collect image URLs (og:image and <img>)
    const images = new Set();
    root.querySelectorAll('meta').forEach(m => {
        const prop = m.getAttribute('property');
        if (prop === 'og:image') {
            const content = m.getAttribute('content');
            if (content) {
                try {
                    images.add(new URL(content, baseUrl).toString());
                }
                catch { }
            }
        }
    });
    root.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src');
        if (!src)
            return;
        try {
            images.add(new URL(src, baseUrl).toString());
        }
        catch { }
    });
    return { text, links: Array.from(links), images: Array.from(images).slice(0, 8) };
}
async function embedTexts(texts) {
    const embedder = new OpenAIEmbeddings({ apiKey: OPENAI_API_KEY });
    return await embedder.embedDocuments(texts);
}
function titleFromUrl(url) {
    const { pathname } = new URL(url);
    return pathname.split('/').filter(Boolean).slice(-1)[0] || '/';
}
function sha1(input) {
    return crypto.createHash('sha1').update(input).digest('hex');
}
app.post('/api/register', async (req, res) => {
    try {
        const { url, refreshMinutes } = req.body;
        if (!url)
            return res.status(400).json({ error: 'Missing url' });
        const domain = new URL(url).hostname;
        const client = await getClient();
        await ensureGlobal(client);
        await client.query(`INSERT INTO sites (domain, base_url, refresh_minutes, last_crawled_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (domain) DO UPDATE SET base_url = EXCLUDED.base_url, refresh_minutes = COALESCE($3, sites.refresh_minutes), last_crawled_at = now()`, [domain, url, refreshMinutes ?? 60]);
        res.json({ ok: true });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/ingest', async (req, res) => {
    try {
        const { url, pages } = req.body;
        if (!url || !Array.isArray(pages))
            return res.status(400).json({ error: 'Invalid payload' });
        const domain = new URL(url).hostname;
        const tableName = domain.replace(/[^a-zA-Z0-9_]/g, '_');
        const client = await getClient();
        await ensureSchema(client, tableName, VECTOR_DIM);
        const contents = pages.map(p => p.text.slice(0, 4000));
        const hasOpenAI = Boolean(OPENAI_API_KEY);
        const embeddings = hasOpenAI ? await embedTexts(contents) : pages.map(() => null);
        const seenIds = new Set();
        for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            const id = sha1(p.url);
            seenIds.add(id);
            const title = titleFromUrl(p.url);
            const content = contents[i];
            const images = p.images ?? [];
            const contentHash = sha1(content);
            const embedding = embeddings[i];
            const embeddingParam = embedding ? pgvector.toSql(embedding) : null;
            await client.query(`INSERT INTO ${tableName} (id, url, title, content, images, content_hash, last_seen_at, deleted_at, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, now(), NULL, $7)
         ON CONFLICT (id) DO UPDATE SET
           url = EXCLUDED.url,
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           images = EXCLUDED.images,
           content_hash = EXCLUDED.content_hash,
           last_seen_at = now(),
           deleted_at = NULL,
           embedding = EXCLUDED.embedding`, [id, p.url, title, content, JSON.stringify(images), contentHash, embeddingParam]);
        }
        // Soft-delete pages not seen in this crawl
        const idsArray = Array.from(seenIds);
        if (idsArray.length > 0) {
            await client.query(`UPDATE ${tableName} SET deleted_at = now()
         WHERE deleted_at IS NULL AND id NOT IN (${idsArray.map((_, i) => `$${i + 1}`).join(',')})`, idsArray);
        }
        res.json({ ok: true, count: pages.length });
    }
    catch (e) {
        console.error('Ingest error:', e);
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/query', async (req, res) => {
    try {
        const { url, question, k } = querySchema.parse(req.body);
        const domain = new URL(url).hostname;
        const tableName = domain.replace(/[^a-zA-Z0-9_]/g, '_');
        const client = await getClient();
        let rows = [];
        try {
            const embedder = new OpenAIEmbeddings({ apiKey: OPENAI_API_KEY });
            const queryEmbedding = await embedder.embedQuery(question);
            const r = await client.query(`SELECT id, url, title, content, images
         FROM ${tableName}
         WHERE deleted_at IS NULL AND embedding IS NOT NULL
         ORDER BY embedding <=> $1
         LIMIT $2`, [pgvector.toSql(queryEmbedding), k]);
            rows = r.rows;
        }
        catch (err) {
            const r = await client.query(`SELECT id, url, title, content, images
         FROM ${tableName}
         WHERE deleted_at IS NULL
         ORDER BY (CASE WHEN content ILIKE '%' || $1 || '%' THEN 0 ELSE 1 END), length(content)
         LIMIT $2`, [question, k]);
            rows = r.rows;
        }
        const context = rows.map((r, idx) => `Snippet ${idx + 1} (url: ${r.url}):\n${r.content}`).join('\n\n');
        const system = new SystemMessage('You are a helpful website RAG assistant. Answer strictly based on the provided context. If unsure, say you are not sure. When relevant, include the page URL and choose one representative image URL to show.');
        const human = new HumanMessage(`Question: ${question}\n\nContext:\n${context}`);
        const llm = new ChatOpenAI({ temperature: 0.2, model: 'gpt-4o-mini', apiKey: OPENAI_API_KEY });
        const answer = OPENAI_API_KEY ? (await llm.call([system, human])).content : 'Set OPENAI_API_KEY to enable answers.';
        const related = rows.map((r) => ({ title: r.title, url: r.url, images: Array.isArray(r.images) ? r.images : (r.images ? JSON.parse(r.images) : []) })).slice(0, 6);
        res.json({ answer, related });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// periodic refresher (every 10 minutes)
setInterval(async () => {
    try {
        const client = await getClient();
        await ensureGlobal(client);
        const { rows } = await client.query(`SELECT domain, base_url, refresh_minutes, COALESCE(last_crawled_at, to_timestamp(0)) as last_crawled_at FROM sites`);
        for (const s of rows) {
            const ageMinutes = (Date.now() - new Date(s.last_crawled_at).getTime()) / 60000;
            if (ageMinutes >= s.refresh_minutes) {
                // trigger a lightweight crawl directly
                try {
                    const crawlRes = await fetch('http://localhost:' + PORT + '/api/crawl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: s.base_url, maxPages: 50, sameOriginOnly: true }) });
                    const crawlJson = await crawlRes.json();
                    await fetch('http://localhost:' + PORT + '/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: s.base_url, pages: crawlJson.pages }) });
                    await client.query('UPDATE sites SET last_crawled_at = now() WHERE domain = $1', [s.domain]);
                }
                catch { }
            }
        }
    }
    catch { }
}, 10 * 60 * 1000);
app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
// Health and root endpoints
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.type('text/plain').send('RAGTech API is running. Endpoints: POST /api/crawl, POST /api/ingest, POST /api/query, GET /api/health'));
