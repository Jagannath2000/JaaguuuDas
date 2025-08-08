import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

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

let openaiClient = null;
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function initOpenAI() {
  if (!process.env.OPENAI_API_KEY) return;
  try {
    const OpenAI = (await import('openai')).default;
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('OpenAI client initialized');
  } catch (err) {
    console.error('Failed to initialize OpenAI client:', err.message);
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
      if (value) {
        system.push({ role: 'system', content: `${key}: ${String(value)}` });
      }
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
  return `You said: "${text}". Connect a model via OPENAI_API_KEY for smarter answers.`;
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

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
    if (openaiClient) {
      const messages = buildMessages(context, history);
      const completion = await openaiClient.chat.completions.create({
        model: openaiModel,
        messages,
        temperature: 0.3
      });
      reply = completion.choices?.[0]?.message?.content?.trim() || '...';
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
  <pre><code>&lt;script src="${req.protocol}://${req.get('host')}/embed.js" data-api-base="${req.protocol}://${req.get('host')}" data-title="Website Assistant" data-primary-color="#0061ff" data-company="Acme Inc"&gt;&lt;/script&gt;</code></pre>
  <script src="/embed.js" data-api-base="${req.protocol}://${req.get('host')}" data-title="Website Assistant" data-primary-color="#0061ff" data-company="Acme Inc"></script>
</body>
</html>`);
});

app.listen(port, () => {
  console.log(`Chatbot server running on http://localhost:${port}`);
  initOpenAI();
});