// يجلب البيانات المالية الأساسية (تقييم، ربحية، نمو، ديون، توزيعات، أهداف المحللين) من Yahoo Finance
// ويكتب data/fundamentals.json — يشتغل مرة يومياً بعد الإغلاق (ومع كل نشر للكود)
import fs from 'node:fs/promises';

const TICKERS = JSON.parse(await fs.readFile('data/tickers.json', 'utf8'));
const OUT = 'data/fundamentals.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const v = (x) => (x && typeof x === 'object' ? (x.raw ?? null) : (x ?? null));
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);

let previous = { f: {} };
try { previous = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}

// Yahoo يطلب كوكي + crumb لهذا النوع من البيانات
async function session() {
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' }).catch(() => null);
  const cookies = (r1?.headers?.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  for (const host of ['query1', 'query2']) {
    const r2 = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, { headers: { 'User-Agent': UA, Cookie: cookies } }).catch(() => null);
    const crumb = r2 && r2.ok ? (await r2.text()).trim() : '';
    if (crumb && !crumb.includes('<')) return { cookies, crumb };
  }
  return null;
}

async function summary(sym, s) {
  const mods = 'summaryDetail,defaultKeyStatistics,financialData,price';
  for (const host of ['query1', 'query2']) {
    for (let a = 0; a < 3; a++) {
      try {
        const res = await fetch(`https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}&crumb=${encodeURIComponent(s.crumb)}`,
          { headers: { 'User-Agent': UA, Cookie: s.cookies, Accept: 'application/json' } });
        if (res.status === 429 || res.status >= 500) { await sleep(1500 * (a + 1)); continue; }
        if (!res.ok) break;
        const j = await res.json();
        const out = j?.quoteSummary?.result?.[0];
        if (out) return out;
        break;
      } catch { await sleep(700); }
    }
  }
  return null;
}

const s = await session();
if (!s) { console.log('no crumb — keeping previous fundamentals'); await fs.writeFile(OUT, JSON.stringify(previous)); process.exit(0); }

const f = {};
let ok = 0, failed = [];
let idx = 0;
async function worker() {
  while (idx < TICKERS.length) {
    const t = TICKERS[idx++];
    const d = await summary(`${t.code}.SR`, s);
    if (d) {
      const sd = d.summaryDetail || {}, ks = d.defaultKeyStatistics || {}, fd = d.financialData || {}, pr = d.price || {};
      f[t.code] = {
        pe: r3(v(sd.trailingPE)), fpe: r3(v(sd.forwardPE) ?? v(ks.forwardPE)), pb: r3(v(ks.priceToBook)),
        mcap: v(sd.marketCap) ?? v(pr.marketCap), beta: r3(v(sd.beta)),
        payout: r3(v(sd.payoutRatio)), roe: r3(v(fd.returnOnEquity)), margin: r3(v(fd.profitMargins)),
        eg: r3(v(fd.earningsGrowth) ?? v(ks.earningsQuarterlyGrowth)), rg: r3(v(fd.revenueGrowth)),
        de: r3(v(fd.debtToEquity)), cr: r3(v(fd.currentRatio)),
        tgt: r3(v(fd.targetMeanPrice)), tgtHi: r3(v(fd.targetHighPrice)), tgtLo: r3(v(fd.targetLowPrice)),
        rec: fd.recommendationKey && fd.recommendationKey !== 'none' ? fd.recommendationKey : null, nA: v(fd.numberOfAnalystOpinions),
      };
      ok++;
    } else {
      if (previous.f?.[t.code]) f[t.code] = previous.f[t.code];
      failed.push(t.code);
    }
    await sleep(250);
  }
}
await Promise.all(Array.from({ length: 3 }, worker));
await fs.writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), ok, failed, f }));
console.log(`fundamentals ok=${ok} failed=${failed.length}`);
const sample = f['1010'] || f['1120'];
console.log('sample', JSON.stringify(sample));
