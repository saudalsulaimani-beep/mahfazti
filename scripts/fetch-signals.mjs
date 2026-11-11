// آلة الزمن + مخطط الخروج: يجيب ٥ سنين من أسعار كل سهم (يومي) من Yahoo Finance ويحسب:
//  - متوسط المدى اليومي (ATR) — كم يتحرك السهم عادةً في اليوم
//  - مستويات الدعم والمقاومة من قمم وقيعان آخر سنة
//  - اللي صار فعلاً في ٥ سنين لما تكررت نفس قواعد التطبيق (دخول، خروج منظم)
//  - كم مرة وصل السهم سعر أعلى/أقل بـ ٣٪ و٥٪ و١٠٪ خلال ١٠ و٢٠ و٦٠ جلسة
// ويكتب data/signals.json — مرة وحدة باليوم (الأسعار اليومية ما تتغير إلا بعد الإغلاق)
import fs from 'node:fs/promises';

const TICKERS = JSON.parse(await fs.readFile('data/tickers.json', 'utf8'));
const OUT = 'data/signals.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const ryDay = (sec) => new Date((sec + 3 * 3600) * 1000).toISOString().slice(0, 10);
const FEE = 0.00155 * 1.15;

let previous = { s: {} };
try { previous = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* أول تشغيل */ }
const TODAY = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const hourRy = new Date(Date.now() + 3 * 3600e3).getUTCHours();
// نحسب مرة بعد الإغلاق (أو أول مرة باليوم لو ما فيه نسخة) — إلا لو FORCE_SIGNALS
const fresh = previous.day === TODAY && (previous.after || hourRy < 15);
if (fresh && !process.env.FORCE_SIGNALS) {
  console.log('signals fresh — skip'); await fs.writeFile(OUT, JSON.stringify(previous)); process.exit(0);
}

async function chart(sym) {
  const q = 'range=5y&interval=1d&includePrePost=false';
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
        if (out?.timestamp?.length) return out;
        break;
      } catch { await sleep(600); }
    }
  }
  return null;
}

/* ── نفس قواعد التطبيق (app.js: tick / rnd / levels) — لازم تبقى متطابقة ── */
function tick(p) { return p < 10 ? 0.01 : p < 25 ? 0.02 : p < 50 ? 0.05 : p < 100 ? 0.1 : 0.2; }
function rnd(v, up) { const t = tick(v); return +((up ? Math.ceil(v / t) : Math.floor(v / t)) * t).toFixed(2); }
function smaAt(c, i, n) { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k]; return s / n; }
function minAt(a, i, n) { let m = Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.min(m, a[k]); return m; }
function maxAt(a, i, n) { let m = -Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.max(m, a[k]); return m; }
function levelsAt(B, i) {
  const c = B.c, p = c[i];
  const l20 = minAt(c, i, 20), h20 = maxAt(c, i, 20), m20 = smaAt(c, i, 20), m50 = smaAt(c, i, 50) ?? m20;
  const h52 = maxAt(B.h, i, 250);
  const up = p > m50;
  let entry = up ? Math.min(p, Math.max(m20, l20)) : Math.min(p, l20 * 1.01);
  entry = rnd(entry);
  const stop = rnd(Math.min(l20, entry) * 0.97);
  let target = Math.max(h20, m50);
  if (h52 && target > h52) target = h52;
  if (target < entry * 1.07) target = entry * 1.07;
  target = rnd(target);
  const rr = (target - entry) / Math.max(entry - stop, 0.01);
  return { entry, stop, target, rr, up, near: p <= entry * 1.02, l20, m20, m50 };
}

/* يمشي على الأيام بعد i ويشوف وش يصير أول: الهدف ولا الوقف (لو الاثنين بنفس اليوم نحسبه وقف — الأسوأ) */
function walk(B, i, stop, target, horizon) {
  const n = B.c.length;
  for (let k = i + 1; k <= Math.min(i + horizon, n - 1); k++) {
    if (stop != null && B.l[k] <= stop) return { r: 'l', k, px: Math.min(stop, B.o[k] ?? stop) };
    if (target != null && B.h[k] >= target) return { r: 'w', k, px: Math.max(target, B.o[k] ?? target) };
  }
  const k = Math.min(i + horizon, n - 1);
  return { r: 'o', k, px: B.c[k] };
}
function stat(list) {
  if (!list.length) return { n: 0 };
  const n = list.length, cnt = (r) => list.filter((x) => x.r === r).length;
  return { n, w: r1(cnt('w') / n * 100), l: r1(cnt('l') / n * 100), o: r1(cnt('o') / n * 100),
    avg: r2(list.reduce((a, x) => a + x.ret, 0) / n * 100), days: Math.round(list.reduce((a, x) => a + x.days, 0) / n) };
}

/* قاعدة الشراء في التطبيق: «كويس للشراء الحين» = السعر قريب من منطقة الدخول والعائد ١.٢ ضعف المخاطرة أو أكثر */
function buyRule(B) {
  const up = [], dn = [], n = B.c.length;
  for (let i = 60; i < n - 2; i++) {
    const L = levelsAt(B, i); if (!L.near || L.rr < 1.2) continue;
    const p = B.c[i]; const res = walk(B, i, L.stop, L.target, 40);
    if (res.r === 'o' && res.k - i < 40) break; // ما خلصت المدة — نوقف (ما نحسب نتيجة ناقصة)
    const ret = (res.px - p) / p - 2 * FEE;
    (L.up ? up : dn).push({ r: res.r, ret, days: res.k - i });
    i = res.k; // بدون تداخل: الصفقة الجاية بعد ما تقفل اللي قبلها
  }
  return { up: stat(up), dn: stat(dn) };
}
/* قاعدة الخروج المنظم: أمر بيع أعلى من السعر (+٣٪ إلى +٨٪ عند متوسط ٢٠) لمدة ١٠ جلسات، مع حد حماية تحت أدنى ٢٠ جلسة بـ ٣٪ */
function exitRule(B) {
  const out = [], n = B.c.length;
  for (let i = 60; i < n - 10; i += 10) {
    const L = levelsAt(B, i), p = B.c[i];
    const sellAt = rnd(Math.max(p * 1.03, Math.min(L.m20, p * 1.08)), true), floor = rnd(L.l20 * 0.97);
    // حد الحماية يشتغل على سعر الإغلاق (التطبيق يقارن السعر الحالي)، وأمر البيع يتنفذ لو لمس السعر
    let res = null;
    for (let k = i + 1; k <= i + 10; k++) {
      if (B.h[k] >= sellAt) { res = { r: 'w', k, px: sellAt }; break; }
      if (B.c[k] <= floor) { res = { r: 'l', k, px: B.c[k] }; break; }
    }
    if (!res) res = { r: 'o', k: i + 10, px: B.c[i + 10] };
    out.push({ r: res.r, ret: (res.px - p) / p, days: res.k - i });
  }
  return stat(out);
}
/* كم مرة وصل السهم سعر أعلى/أقل بنسبة معينة خلال عدد جلسات (من أي يوم في ٥ سنين) */
const PCTS = [3, 5, 10], HOR = [10, 20, 60];
function reach(B) {
  const n = B.c.length, u = {}, d = {};
  for (const x of PCTS) { u[x] = HOR.map(() => [0, 0]); d[x] = HOR.map(() => [0, 0]); }
  for (let i = 0; i < n - 1; i++) {
    const p = B.c[i]; let hi = -Infinity, lo = Infinity;
    for (let k = 1; k <= 60 && i + k < n; k++) {
      hi = Math.max(hi, B.h[i + k]); lo = Math.min(lo, B.l[i + k]);
      const hIdx = HOR.indexOf(k); if (hIdx < 0) continue;
      for (const x of PCTS) {
        u[x][hIdx][1]++; if (hi >= p * (1 + x / 100)) u[x][hIdx][0]++;
        d[x][hIdx][1]++; if (lo <= p * (1 - x / 100)) d[x][hIdx][0]++;
      }
    }
  }
  const fin = (T) => Object.fromEntries(Object.entries(T).map(([x, arr]) => [x, arr.map(([a, b]) => (b ? Math.round(a / b * 100) : null))]));
  return { u: fin(u), d: fin(d) };
}
/* الدعم والمقاومة: قمم وقيعان واضحة في آخر سنة (أعلى/أقل من ٥ جلسات قبلها وبعدها)، والقريبة من بعض نجمعها */
function supRes(B) {
  const n = B.c.length, from = Math.max(5, n - 250), piv = [];
  for (let i = from; i < n - 5; i++) {
    let isH = true, isL = true;
    for (let k = i - 5; k <= i + 5; k++) { if (k === i) continue; if (B.h[k] > B.h[i]) isH = false; if (B.l[k] < B.l[i]) isL = false; }
    if (isH) piv.push(B.h[i]); if (isL) piv.push(B.l[i]);
  }
  piv.push(maxAt(B.h, n - 1, 250), minAt(B.l, n - 1, 250));
  piv.sort((a, b) => a - b);
  const cl = [];
  for (const v of piv) { const last = cl[cl.length - 1]; if (last && v <= last.lo * 1.015) { last.v.push(v); } else cl.push({ lo: v, v: [v] }); }
  const lv = cl.map((x) => ({ v: r2(x.v.reduce((a, b) => a + b, 0) / x.v.length), n: x.v.length }));
  const p = B.c[n - 1];
  return { s: lv.filter((x) => x.v < p * 0.995).sort((a, b) => b.v - a.v).slice(0, 3), r: lv.filter((x) => x.v > p * 1.005).sort((a, b) => a.v - b.v).slice(0, 3) };
}
function atr(B, n = 14) {
  const N = B.c.length; if (N < n + 1) return null; let s = 0;
  for (let i = N - n; i < N; i++) s += Math.max(B.h[i] - B.l[i], Math.abs(B.h[i] - B.c[i - 1]), Math.abs(B.l[i] - B.c[i - 1]));
  return s / n;
}

function bars(res) {
  const ts = res.timestamp || [], qt = res.indicators?.quote?.[0] || {};
  const B = { d: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < ts.length; i++) {
    const c = qt.close?.[i], h = qt.high?.[i], l = qt.low?.[i], o = qt.open?.[i];
    if (c == null || h == null || l == null || !(c > 0)) continue;
    const day = ryDay(ts[i]);
    if (B.d.length && B.d[B.d.length - 1] === day) { B.o.pop(); B.h.pop(); B.l.pop(); B.c.pop(); B.d.pop(); }
    B.d.push(day); B.o.push(o ?? c); B.h.push(Math.max(h, c)); B.l.push(Math.min(l, c)); B.c.push(c);
  }
  return B;
}

const s = {};
let ok = 0, kept = 0; const failed = [];
let idx = 0;
async function worker() {
  while (idx < TICKERS.length) {
    const t = TICKERS[idx++];
    const res = await chart(`${t.code}.SR`);
    const B = res ? bars(res) : null;
    if (B && B.c.length >= 120) {
      const A = atr(B);
      s[t.code] = { d: B.d[B.d.length - 1], p: r2(B.c[B.c.length - 1]), yrs: r1(B.c.length / 250),
        atr: r2(A), sr: supRes(B), buy: buyRule(B), ex: exitRule(B), reach: reach(B) };
      ok++;
    } else if (previous.s?.[t.code]) { s[t.code] = { ...previous.s[t.code], stale: true }; kept++; failed.push(t.code); }
    else failed.push(t.code);
    await sleep(200);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
if (!ok && previous.s && Object.keys(previous.s).length) {
  console.log('signals: كل الطلبات فشلت — نحتفظ بالنسخة السابقة'); await fs.writeFile(OUT, JSON.stringify(previous)); process.exit(0);
}
await fs.writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), day: TODAY, after: hourRy >= 15, ok, kept, failed, s }));
console.log(`signals ok=${ok} kept=${kept} failed=${failed.length} -> ${failed.join(',')}`);
const sm = s['2222'] || s['1120']; if (sm) console.log('sample', JSON.stringify(sm));
