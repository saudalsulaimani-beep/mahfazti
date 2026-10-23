// يجلب أسعار أسهم تداول من Yahoo Finance ويكتب data/market.json
// يشتغل داخل GitHub Actions (Node 20). إذا فشل سهم، يحتفظ بآخر سعر معروف له من النسخة السابقة.
import fs from 'node:fs/promises';

const TICKERS = JSON.parse(await fs.readFile('data/tickers.json', 'utf8'));
const OUT = 'data/market.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const ryDay = (sec) => new Date((sec + 3 * 3600) * 1000).toISOString().slice(0, 10); // تاريخ الرياض

let previous = { quotes: {} };
try { previous = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* أول تشغيل */ }

async function chart(sym) {
  const q = `range=1y&interval=1d&events=div&includePrePost=false`;
  for (const host of ['query1', 'query2']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?${q}`, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (res.status === 429 || res.status >= 500) { await sleep(1200 * (attempt + 1)); continue; }
        if (!res.ok) break;
        const j = await res.json();
        const out = j?.chart?.result?.[0];
        if (out?.meta?.regularMarketPrice) return out;
        break;
      } catch { await sleep(600); }
    }
  }
  return null;
}

function parse(res) {
  const m = res.meta;
  const ts = res.timestamp || [];
  const qt = res.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (qt.close?.[i] != null) rows.push({ t: ts[i], c: qt.close[i], h: qt.high?.[i], l: qt.low?.[i] });
  }
  if (!rows.length) return null;
  const p = m.regularMarketPrice;
  const last = rows[rows.length - 1];
  // إذا شمعة اليوم موجودة، الإغلاق السابق هو اللي قبلها
  const todayBar = ryDay(last.t) === ryDay(m.regularMarketTime);
  const pc = todayBar ? rows[rows.length - 2]?.c : last.c;
  const closes = rows.map((r) => r.c);
  const highs = rows.map((r) => r.h).filter((x) => x != null);
  const lows = rows.map((r) => r.l).filter((x) => x != null);
  const yearAgo = Date.now() / 1000 - 365 * 86400;
  const divs = Object.values(res.events?.dividends || {})
    .filter((d) => d.date >= yearAgo)
    .sort((a, b) => a.date - b.date)
    .map((d) => ({ a: r2(d.amount), d: ryDay(d.date) }));
  const tail = rows.slice(-130);
  return {
    p: r2(p),
    pc: r2(pc),
    h52: r2(m.fiftyTwoWeekHigh ?? Math.max(...highs)),
    l52: r2(m.fiftyTwoWeekLow ?? Math.min(...lows)),
    dh: r2(m.regularMarketDayHigh),
    dl: r2(m.regularMarketDayLow),
    v: m.regularMarketVolume ?? null,
    t: m.regularMarketTime,
    div: r2(divs.reduce((a, d) => a + d.a, 0)),
    divs,
    c: tail.map((r) => r2(r.c)),
    c0: ryDay(tail[0].t),
  };
}

const quotes = {};
let ok = 0, kept = 0, failed = [];
const list = [...TICKERS.map((t) => ({ ...t, sym: `${t.code}.SR` })), { code: 'TASI', name: 'مؤشر تاسي', sector: 'مؤشر', sym: '^TASI.SR' }];

const CONC = 4;
let idx = 0;
async function worker() {
  while (idx < list.length) {
    const t = list[idx++];
    const res = await chart(t.sym);
    const parsed = res ? parse(res) : null;
    if (parsed) { quotes[t.code] = { n: t.name, s: t.sector, ...parsed }; ok++; }
    else if (previous.quotes?.[t.code]) { quotes[t.code] = { ...previous.quotes[t.code], n: t.name, s: t.sector, stale: true }; kept++; failed.push(t.code); }
    else failed.push(t.code);
    await sleep(150);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const times = Object.values(quotes).filter((q) => !q.stale).map((q) => q.t || 0);
const out = {
  updatedAt: new Date().toISOString(),
  marketTime: times.length ? Math.max(...times) : previous.marketTime ?? null,
  ok, kept, failed,
  quotes,
};
await fs.writeFile(OUT, JSON.stringify(out));
console.log(`ok=${ok} kept=${kept} failed=${failed.length} -> ${failed.join(',')}`);
if (ok === 0 && kept === 0) process.exit(1);
