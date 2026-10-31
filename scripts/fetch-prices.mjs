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
// أول تحديث في اليوم يجيب سنة كاملة، وبعده كل ٥ دقائق نجيب آخر الأسعار بس ونركّبها على التاريخ
const TODAY = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const QUICK_DAY = previous.fullDay === TODAY;

async function chart(sym, range = '1y') {
  const q = `range=${range}&interval=1d&events=div&includePrePost=false`;
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
  const pc = rows.length > 1 ? (todayBar ? rows[rows.length - 2]?.c : last.c) : (m.previousClose ?? m.chartPreviousClose);
  const closes = rows.map((r) => r.c);
  const highs = rows.map((r) => r.h).filter((x) => x != null);
  const lows = rows.map((r) => r.l).filter((x) => x != null);
  const yearAgo = Date.now() / 1000 - 365 * 86400;
  const divs = Object.values(res.events?.dividends || {})
    .filter((d) => d.date >= yearAgo)
    .sort((a, b) => a.date - b.date)
    .map((d) => ({ a: r2(d.amount), d: ryDay(d.date) }));
  const tail = rows.slice(-250);
  return {
    cl: ryDay(tail[tail.length - 1].t),
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

// تحديث سريع: آخر ٥ أيام فوق التاريخ المحفوظ
function mergeQuick(prev, res) {
  const m = res.meta, ts = res.timestamp || [], qt = res.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) if (qt.close?.[i] != null) rows.push({ t: ts[i], c: qt.close[i] });
  if (!rows.length || !prev?.c || !prev.cl) return null;
  const last = rows[rows.length - 1], lastDay = ryDay(last.t);
  const todayBar = lastDay === ryDay(m.regularMarketTime);
  const pc = rows.length > 1 ? (todayBar ? rows[rows.length - 2].c : last.c) : prev.pc;
  let c = prev.c.slice();
  if (lastDay === prev.cl) c[c.length - 1] = r2(last.c);
  else if (lastDay > prev.cl) { c.push(r2(last.c)); if (c.length > 250) c = c.slice(-250); }
  return { ...prev, p: r2(m.regularMarketPrice), pc: r2(pc), dh: r2(m.regularMarketDayHigh), dl: r2(m.regularMarketDayLow),
    v: m.regularMarketVolume ?? prev.v, t: m.regularMarketTime,
    h52: r2(m.fiftyTwoWeekHigh) ?? prev.h52, l52: r2(m.fiftyTwoWeekLow) ?? prev.l52, c, cl: lastDay > prev.cl ? lastDay : prev.cl, stale: undefined };
}

const quotes = {};
let quickCount = 0;
let ok = 0, kept = 0, failed = [];
const list = [...TICKERS.map((t) => ({ ...t, sym: `${t.code}.SR` })), { code: 'TASI', name: 'مؤشر تاسي', sector: 'مؤشر', sym: '^TASI.SR' }];

const CONC = 4;
let idx = 0;
async function worker() {
  while (idx < list.length) {
    const t = list[idx++];
    const prevQ = previous.quotes?.[t.code];
    if (QUICK_DAY && prevQ?.c?.length >= 200 && prevQ.cl) {
      const rq = await chart(t.sym, '5d');
      const merged = rq ? mergeQuick(prevQ, rq) : null;
      if (merged) { quotes[t.code] = { ...merged, n: t.name, s: t.sector }; ok++; quickCount++; await sleep(80); continue; }
    }
    let res = await chart(t.sym);
    // بعض المؤشرات ترجع شمعة وحدة مع مدى السنة، فنجرب مدى أقصر
    for (const r of ['6mo', '3mo', '1mo']) {
      if (!res || (res.timestamp || []).length >= 20) break;
      const alt = await chart(t.sym, r);
      if (alt && (alt.timestamp || []).length > (res.timestamp || []).length) res = alt;
    }
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
  fullDay: QUICK_DAY ? previous.fullDay : TODAY,
  marketTime: times.length ? Math.max(...times) : previous.marketTime ?? null,
  ok, kept, failed,
  quotes,
};
await fs.writeFile(OUT, JSON.stringify(out));
console.log(`mode=${QUICK_DAY ? 'quick' : 'full'} quick=${quickCount} ok=${ok} kept=${kept} failed=${failed.length} -> ${failed.join(',')}`);
if (ok === 0 && kept === 0) process.exit(1);
