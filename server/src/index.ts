import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { z } from 'zod';
import pgvector from 'pgvector/pg';
import cheerio from 'cheerio';
import { setTimeout as delay } from 'timers/promises';
import crypto from 'crypto';
import PQueue from 'p-queue';
import { fetch } from 'undici';
import { OpenAIEmbeddings, ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getClient, ensureSchema } from './db';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const VECTOR_DIM = Number(process.env.VECTOR_DIM || 1536);

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

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

async function fetchHtml(targetUrl: string): Promise<string> {
  const res = await fetch(targetUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (RAG-Bot Crawler)'
    }
  } as any);
  if (!res.ok) throw new Error(`Failed to fetch ${targetUrl}: ${res.status}`);
  return await res.text();
}

async function extractLinksAndText(baseUrl: string, html: string) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const links = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl).toString();
      links.add(normalizeUrl(resolved));
    } catch {}
  });
  // Try to capture main image for the page (og:image)
  let image: string | null = null;
  const og = $('meta[property="og:image"]').attr('content');
  if (og) image = new URL(og, baseUrl).toString();
  return { text, links: Array.from(links), image };
}

// LanceDB removed; we will maintain one table per site (domain) in Postgres
async function embedTexts(texts: string[]): Promise<number[][]> {
  const embedder = new OpenAIEmbeddings({ apiKey: OPENAI_API_KEY });
  return await embedder.embedDocuments(texts);
}

function titleFromUrl(url: string): string {
  const { pathname } = new URL(url);
  return pathname.split('/').filter(Boolean).slice(-1)[0] || '/';
}

app.post('/api/crawl', async (req: Request, res: Response) => {
  try {
    const { url, maxPages, sameOriginOnly } = crawlInputSchema.parse(req.body);
    const origin = new URL(url).origin;
    const visited = new Set<string>();
    const queue = new PQueue({ concurrency: 4, interval: 1000, intervalCap: 8 });

    const pages: Array<{ url: string; text: string; image: string | null }> = [];

    async function visit(target: string) {
      if (visited.size >= maxPages) return;
      if (visited.has(target)) return;
      if (sameOriginOnly && !target.startsWith(origin)) return;
      visited.add(target);
      try {
        const html = await fetchHtml(target);
        const { text, links, image } = await extractLinksAndText(target, html);
        if (text.length > 50) pages.push({ url: target, text, image });
        for (const link of links) {
          if (visited.size + queue.size >= maxPages) break;
          if (!visited.has(link)) queue.add(() => visit(link));
        }
      } catch (e) {
        // ignore fetch errors
      }
      await delay(50);
    }

    await visit(normalizeUrl(url));
    await queue.onIdle();

    res.json({ pagesCount: pages.length, pages });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/ingest', async (req: Request, res: Response) => {
  try {
    const { url, pages } = req.body as { url: string; pages: Array<{ url: string; text: string; image?: string | null }> };
    if (!url || !Array.isArray(pages)) return res.status(400).json({ error: 'Invalid payload' });
    const domain = new URL(url).hostname;
    const tableName = domain.replace(/[^a-zA-Z0-9_]/g, '_');
    const client = await getClient();
    await ensureSchema(client, tableName, VECTOR_DIM);

    const contents = pages.map(p => p.text.slice(0, 4000));
    const embeddings = OPENAI_API_KEY ? await embedTexts(contents) : pages.map(() => [] as number[]);

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const id = crypto.createHash('sha1').update(p.url).digest('hex');
      const title = titleFromUrl(p.url);
      const content = contents[i];
      const image = p.image || '';
      const embedding = embeddings[i];
      await client.query(
        `INSERT INTO ${tableName} (id, url, title, content, image, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, title = EXCLUDED.title, content = EXCLUDED.content, image = EXCLUDED.image, embedding = EXCLUDED.embedding`,
        [id, p.url, title, content, image, pgvector.toSql(embedding)]
      );
    }

    res.json({ ok: true, count: pages.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/query', async (req: Request, res: Response) => {
  try {
    const { url, question, k } = querySchema.parse(req.body);
    const domain = new URL(url).hostname;
    const tableName = domain.replace(/[^a-zA-Z0-9_]/g, '_');
    const client = await getClient();

    const embedder = new OpenAIEmbeddings({ apiKey: OPENAI_API_KEY });
    const queryEmbedding = await embedder.embedQuery(question);

    // Vector search using cosine distance
    const { rows } = await client.query(
      `SELECT id, url, title, content, image
       FROM ${tableName}
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [pgvector.toSql(queryEmbedding as unknown as number[]), k]
    );

    const context = rows.map((r: any, idx: number) => `Snippet ${idx + 1} (url: ${r.url}):\n${r.content}`).join('\n\n');

    const system = new SystemMessage(
      'You are a helpful website RAG assistant. Answer strictly based on the provided context. If unsure, say you are not sure. When relevant, include the page URL and choose one representative image URL to show.'
    );
    const human = new HumanMessage(`Question: ${question}\n\nContext:\n${context}`);

    const llm = new ChatOpenAI({ temperature: 0.2, model: 'gpt-4o-mini', apiKey: OPENAI_API_KEY });
    const answer = OPENAI_API_KEY ? (await llm.call([system, human])).content : 'Set OPENAI_API_KEY to enable answers.';

    const related = rows.map((r: any) => ({ title: r.title, url: r.url, image: r.image })).slice(0, 6);

    res.json({ answer, related });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});