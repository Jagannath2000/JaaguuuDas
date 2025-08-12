import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import pgvector from 'pgvector/pg';
import * as cheerio from 'cheerio';
import { setTimeout as delay } from 'timers/promises';
import crypto from 'crypto';
import PQueue from 'p-queue';
import { fetch } from 'undici';
import { OpenAIEmbeddings, ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getClient, ensureSchema } from './db.js';
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
    const $ = cheerio.load(html);
    $('script, style, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    const links = new Set();
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
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
    const og = $('meta[property="og:image"]').attr('content');
    if (og) {
        try {
            images.add(new URL(og, baseUrl).toString());
        }
        catch { }
    }
    $('img[src]').each((_, el) => {
        const src = $(el).attr('src');
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
app.post('/api/crawl', async (req, res) => {
    try {
        const { url, maxPages, sameOriginOnly } = crawlInputSchema.parse(req.body);
        const origin = new URL(url).origin;
        const visited = new Set();
        const queue = new PQueue({ concurrency: 4, interval: 1000, intervalCap: 8 });
        const pages = [];
        async function visit(target) {
            if (visited.size >= maxPages)
                return;
            if (visited.has(target))
                return;
            if (sameOriginOnly && !target.startsWith(origin))
                return;
            visited.add(target);
            try {
                const html = await fetchHtml(target);
                const { text, links, images } = await extractLinksAndText(target, html);
                if (text.length > 50)
                    pages.push({ url: target, text, images });
                for (const link of links) {
                    if (visited.size + queue.size >= maxPages)
                        break;
                    if (!visited.has(link))
                        queue.add(() => visit(link));
                }
            }
            catch (e) {
                // ignore fetch errors
            }
            await delay(50);
        }
        await visit(normalizeUrl(url));
        await queue.onIdle();
        res.json({ pagesCount: pages.length, pages });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
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
        const embeddings = OPENAI_API_KEY ? await embedTexts(contents) : pages.map(() => []);
        for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            const id = crypto.createHash('sha1').update(p.url).digest('hex');
            const title = titleFromUrl(p.url);
            const content = contents[i];
            const images = p.images ?? [];
            const embedding = embeddings[i];
            await client.query(`INSERT INTO ${tableName} (id, url, title, content, images, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, title = EXCLUDED.title, content = EXCLUDED.content, images = EXCLUDED.images, embedding = EXCLUDED.embedding`, [id, p.url, title, content, JSON.stringify(images), pgvector.toSql(embedding)]);
        }
        res.json({ ok: true, count: pages.length });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/query', async (req, res) => {
    try {
        const { url, question, k } = querySchema.parse(req.body);
        const domain = new URL(url).hostname;
        const tableName = domain.replace(/[^a-zA-Z0-9_]/g, '_');
        const client = await getClient();
        const embedder = new OpenAIEmbeddings({ apiKey: OPENAI_API_KEY });
        const queryEmbedding = await embedder.embedQuery(question);
        const { rows } = await client.query(`SELECT id, url, title, content, images
       FROM ${tableName}
       ORDER BY embedding <=> $1
       LIMIT $2`, [pgvector.toSql(queryEmbedding), k]);
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
app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
