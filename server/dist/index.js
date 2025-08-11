import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { connect } from '@lancedb/lancedb';
import cheerio from 'cheerio';
import { setTimeout as delay } from 'timers/promises';
import crypto from 'crypto';
import PQueue from 'p-queue';
import { fetch } from 'undici';
import { OpenAIEmbeddings, ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const LANCEDB_PATH = process.env.LANCEDB_PATH || './lancedb';
if (!OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY not set. Set it in .env to enable embeddings and answers.');
}
const app = express();
app.use(cors());
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
    // Try to capture main image for the page (og:image)
    let image = null;
    const og = $('meta[property="og:image"]').attr('content');
    if (og)
        image = new URL(og, baseUrl).toString();
    return { text, links: Array.from(links), image };
}
async function ensureTable(domain) {
    const db = await connect(LANCEDB_PATH);
    const tableName = domain.replace(/[^a-zA-Z0-9_]/g, '_');
    const tables = await db.tableNames();
    if (!tables.includes(tableName)) {
        const table = await db.createTable(tableName, [
            { id: '', url: '', title: '', content: '', image: '', embedding: new Array() }
        ]);
        await table.add([]);
        return table;
    }
    return await db.openTable(tableName);
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
                const { text, links, image } = await extractLinksAndText(target, html);
                if (text.length > 50)
                    pages.push({ url: target, text, image });
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
        const table = await ensureTable(domain);
        const contents = pages.map(p => p.text.slice(0, 4000));
        const embeddings = OPENAI_API_KEY ? await embedTexts(contents) : pages.map(() => []);
        const rows = pages.map((p, i) => ({
            id: crypto.createHash('sha1').update(p.url).digest('hex'),
            url: p.url,
            title: titleFromUrl(p.url),
            content: contents[i],
            image: p.image || '',
            embedding: embeddings[i]
        }));
        // Upsert by id
        await table.add(rows, { mode: 'overwrite' });
        res.json({ ok: true, count: rows.length });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/query', async (req, res) => {
    try {
        const { url, question, k } = querySchema.parse(req.body);
        const domain = new URL(url).hostname;
        const db = await connect(LANCEDB_PATH);
        const tableName = domain.replace(/[^a-zA-Z0-9_]/g, '_');
        const table = await db.openTable(tableName);
        const embedder = new OpenAIEmbeddings({ apiKey: OPENAI_API_KEY });
        const queryEmbedding = await embedder.embedQuery(question);
        // Vector search
        const results = await table.search(queryEmbedding).limit(k).toArray();
        const context = results.map((r, idx) => `Snippet ${idx + 1} (url: ${r.url}):\n${r.content}`).join('\n\n');
        const system = new SystemMessage('You are a helpful website RAG assistant. Answer strictly based on the provided context. If unsure, say you are not sure. When relevant, include the page URL and choose one representative image URL to show.');
        const human = new HumanMessage(`Question: ${question}\n\nContext:\n${context}`);
        const llm = new ChatOpenAI({ temperature: 0.2, model: 'gpt-4o-mini', apiKey: OPENAI_API_KEY });
        const answer = OPENAI_API_KEY ? (await llm.call([system, human])).content : 'Set OPENAI_API_KEY to enable answers.';
        const related = results.map((r) => ({ title: r.title, url: r.url, image: r.image })).slice(0, 6);
        res.json({ answer, related });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
