import { useState } from 'react';
import axios from 'axios';
axios.defaults.baseURL = import.meta.env.VITE_API_BASE || 'http://localhost:8787';

interface PageItem { url: string; text: string; images?: string[] }
interface RelatedItem { title: string; url: string; images?: string[] }

function SubscribeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [agree, setAgree] = useState(false);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-semibold">Subscribe</h3>
          <button onClick={onClose} className="text-gray-500">✕</button>
        </div>
        <p className="mt-2 text-sm text-gray-600">Always stay informed! Enter your email to subscribe to our monthly Trends and Insights newsletter.</p>
        <input value={email} onChange={e=>setEmail(e.target.value)} className="mt-4 w-full rounded-md border px-3 py-2" placeholder="you@example.com" />
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={agree} onChange={e=>setAgree(e.target.checked)} />
          I have read the privacy statement and agree to the terms of use.
        </label>
        <div className="mt-4 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-md border px-4 py-2">Not now</button>
          <button disabled={!email || !agree} onClick={onClose} className="rounded-md bg-purple-600 px-4 py-2 text-white disabled:opacity-50">Submit</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [siteUrl, setSiteUrl] = useState('https://hcltech.com');
  const [question, setQuestion] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [answer, setAnswer] = useState<string>('');
  const [related, setRelated] = useState<RelatedItem[]>([]);
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [history, setHistory] = useState<Array<{ role: 'user' | 'bot'; content: string }>>([]);

  async function ensureIndexed() {
    // naive cache marker per site
    const key = `indexed:${siteUrl}`;
    if (localStorage.getItem(key)) return;
    setIsLoading(true);
    try {
      const crawl = await axios.post('/api/crawl', { url: siteUrl, maxPages: 40, sameOriginOnly: true });
      const pages: PageItem[] = crawl.data.pages;
      await axios.post('/api/ingest', { url: siteUrl, pages });
      localStorage.setItem(key, 'true');
    } finally {
      setIsLoading(false);
    }
  }

  async function onAsk() {
    setShowSubscribe(true);
    await ensureIndexed();
    setIsLoading(true);
    setAnswer('');
    setRelated([]);
    setHistory(h => [...h, { role: 'user', content: question }]);
    try {
      const res = await axios.post('/api/query', { url: siteUrl, question, k: 5 });
      setAnswer(String(res.data.answer ?? ''));
      setRelated(res.data.related ?? []);
      setHistory(h => [...h, { role: 'bot', content: String(res.data.answer ?? '') }]);
    } catch (e: any) {
      setAnswer(e.message || 'Error');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold text-blue-700">RAGTech</span>
            <input value={siteUrl} onChange={e=>setSiteUrl(e.target.value)} className="w-[380px] rounded-md border px-3 py-2" placeholder="https://example.com" />
          </div>
          <div className="flex items-center gap-3">
            <button className="rounded-md border px-3 py-2" onClick={ensureIndexed}>Fetch & Index</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 pb-24 pt-8">
        {/* initial title like screenshot */}
        <h1 className="mb-4 text-2xl font-semibold">Ask about this website</h1>
        <p className="mb-6 text-gray-600">Type a question to search and get answers with citations and images from the site.</p>

        <div className="sticky top-16 z-0 mb-6 rounded-xl border bg-white p-2 shadow-sm">
          <div className="flex items-center gap-2">
            <input
              value={question}
              onChange={e=>setQuestion(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter') onAsk(); }}
              className="flex-1 rounded-md px-3 py-3 outline-none"
              placeholder="Ask anything about the site..."
            />
            <button onClick={onAsk} className="rounded-md bg-purple-600 px-4 py-2 text-white">Search</button>
          </div>
        </div>

        {isLoading && (
          <div className="my-10 flex flex-col items-center justify-center gap-2">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-purple-300 border-t-purple-700" />
            <p className="text-sm text-gray-600">I'm thinking—please give me a few seconds…</p>
          </div>
        )}

        {answer && (
          <div className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="mb-2 text-xl font-semibold">Answer</h2>
            <div className="prose max-w-none whitespace-pre-wrap">{answer}</div>
          </div>
        )}

        {related.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-3 text-lg font-semibold">Related content</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
              {related.map((r, i) => {
                const img = r.images && r.images.length > 0 ? r.images[0] : undefined;
                return (
                  <a key={i} href={r.url} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-xl border bg-white shadow-sm transition hover:shadow-md">
                    {img ? (
                      <img src={img} alt={r.title} className="h-40 w-full object-cover" />
                    ) : (
                      <div className="flex h-40 w-full items-center justify-center bg-gray-100 text-gray-500">No image</div>
                    )}
                    <div className="p-3">
                      <div className="truncate font-medium group-hover:text-purple-700">{r.title || r.url}</div>
                    </div>
                  </a>
                );
              })}
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="mt-8 space-y-4">
            {history.map((m, idx) => (
              <div key={idx} className={`rounded-lg border p-3 ${m.role==='user' ? 'bg-purple-50' : 'bg-white'}`}>
                <div className="text-xs uppercase text-gray-500">{m.role}</div>
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            ))}
          </div>
        )}
      </main>

      <SubscribeModal open={showSubscribe} onClose={() => setShowSubscribe(false)} />
    </div>
  );
}
