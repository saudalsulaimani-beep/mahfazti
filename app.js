/* محفظتي — منطق التطبيق
   البيانات الشخصية (الكميات، السيولة، المستويات) تنحفظ في جهازك فقط (localStorage).
   الأسعار تجي من data/market.json اللي يتحدث تلقائياً كل ~5 دقائق وقت التداول عبر GitHub Actions. */
(() => {
'use strict';

/* ───────── أدوات ───────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const N = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
const fmt = (n, d = 2) => (n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const sgnRaw = (n, d = 2) => (n == null || !isFinite(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), d));
const sgn = (n, d = 2) => `<bdi class="num">${sgnRaw(n, d)}</bdi>`;
const pct = (n, d = 1) => `<bdi class="num">${n == null || !isFinite(n) ? '—' : sgnRaw(n, d) + '%'}</bdi>`;
const num = (s) => `<bdi class="num">${s}</bdi>`;
const dir = (n) => (n == null || Math.abs(n) < 0.005 ? 'flat' : n > 0 ? 'up' : 'down');
const uid = () => Math.random().toString(36).slice(2, 9);
const COLORS = ['#E2B95E', '#7FD3B4', '#8FB8E8', '#E59A8C', '#C3A6E6', '#B9D77A', '#F0D9A2'];
const KEY = 'mahfazti.v1';

/* ───────── الحالة ───────── */
let S = load();            // {cash, holdings:[{id,code,name,qty,cost,stop,target,manual}], watch:[{id,code,name,buyBelow,note}]}
let M = null;              // market.json
let TICK = [];             // data/tickers.json
let NOTES = {};            // data/notes.json — ملاحظات المحلل المكتوبة
let FUND = {};             // data/fundamentals.json — بيانات مالية يومية
let view = 'steps';
let mktSort = 'best';
let mktQuery = '';
let mktSector = '';
let sheetState = null;
let lastFetch = 0;
let deferredInstall = null;

function planDefaults() { return { approved: null, months: 4, buffer: 0.10, basket: [], basketAt: null, month: null, exits: {}, steps: {}, journal: [] }; }
function blank() { return { cash: 0, holdings: [], watch: [], setAt: null, plan: planDefaults() }; }
function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && Array.isArray(s.holdings)) { const o = Object.assign(blank(), s); o.plan = Object.assign(planDefaults(), s.plan || {}); return o; } } catch {}
  return blank();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast('تعذّر الحفظ على هذا الجهاز'); } }

/* ───────── بيانات السوق ───────── */
const Q = (code) => M?.quotes?.[code] || null;
const nameOf = (x) => Q(x.code)?.n || x.name || x.code || '—';
function priceOf(h) { return Q(h.code)?.p ?? h.manual ?? h.cost ?? null; }
function dayChg(q) { return q && q.p != null && q.pc ? { abs: q.p - q.pc, pct: (q.p - q.pc) / q.pc * 100 } : null; }
function perf(q, bars) { if (!q?.c || q.c.length <= bars) return null; const a = q.c[q.c.length - 1 - bars]; return (q.p - a) / a * 100; }
function rsi(c, p = 14) {
  if (!c || c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  if (l === 0) return 100; return 100 - 100 / (1 + (g / p) / (l / p));
}
function sma(c, p) { if (!c || c.length < p) return null; return c.slice(-p).reduce((a, b) => a + b, 0) / p; }

async function fetchMarket(manual) {
  const btn = $('#refreshBtn'); btn.classList.add('spinning');
  try {
    const r = await fetch('data/market.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    M = await r.json(); lastFetch = Date.now();
    buildMarketTrend();
    if (manual) toast('الأسعار محدّثة');
  } catch {
    if (manual) toast('ما قدرت أجيب الأسعار. تأكد من النت');
  } finally { btn.classList.remove('spinning'); render(); }
}

/* Yahoo ما يعطي تاريخ تاسي، فنرسم اتجاه السوق من متوسط حركة كل الأسهم (وزن متساوي) ونطابقه مع آخر قيمة لتاسي */
function buildMarketTrend() {
  const t = M?.quotes?.TASI; if (!t || (t.c && t.c.length >= 20)) return;
  const series = Object.entries(M.quotes).filter(([k, q]) => k !== 'TASI' && q.c && q.c.length >= 60).map(([, q]) => q.c);
  if (series.length < 10) return;
  const n = Math.min(130, ...series.map((c) => c.length));
  const idx = [];
  for (let i = 0; i < n; i++) {
    let sum = 0; for (const c of series) { const a = c.slice(-n); sum += a[i] / a[n - 1]; }
    idx.push(sum / series.length);
  }
  const scale = t.p / idx[n - 1];
  t.c = idx.map((v) => +(v * scale).toFixed(2)); t.synthetic = true;
}

/* سجل قيمة المحفظة يومياً (على جهازك) */
const HKEY = 'mahfazti.hist';
function histLoad() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch { return []; } }
function histRecord(c) {
  if (!M?.marketTime || !S.holdings.length) return;
  const d = new Date((M.marketTime + 3 * 3600) * 1000).toISOString().slice(0, 10);
  const H = histLoad(); const last = H[H.length - 1];
  const rec = { d, v: +c.total.toFixed(2), s: +c.stocks.toFixed(2), k: +c.cost.toFixed(2) };
  if (last && last.d === d) H[H.length - 1] = rec; else H.push(rec);
  try { localStorage.setItem(HKEY, JSON.stringify(H.slice(-400))); } catch {}
}
function histCard() {
  const H = histLoad();
  if (H.length < 2) return `<div class="note">📈 من اليوم يبدأ التطبيق يسجل قيمة محفظتك كل يوم تداول، وبعد كم يوم يطلع لك رسم أدائك هنا.</div>`;
  const vals = H.map((h) => h.v); const first = vals[0], last = vals[vals.length - 1];
  const ch = (last - first) / first * 100;
  return `<section class="card"><div class="sec-h"><h2>أداء محفظتك</h2><span class="meta">من ${num(H[0].d)}</span></div>
    ${spark(vals, 600, 60, last >= first ? 'var(--gain)' : 'var(--loss)').replace('<svg', '<svg class="spark-lg"')}
    <div class="whyline">من ${num(fmt(first))} إلى ${num(fmt(last))} ريال (${pct(ch)}). يشمل السيولة، فأي إيداع أو سحب يبان في الرسم.</div></section>`;
}

/* ───────── وقت السوق (الرياض) ───────── */
function riyadhNow() { const d = new Date(Date.now() + 3 * 3600e3); return { day: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
function marketOpen() { const { day, min } = riyadhNow(); return day <= 4 && min >= 600 && min < 910; }
function ago(sec) {
  if (!sec) return '—';
  const m = Math.round((Date.now() / 1000 - sec) / 60);
  if (m < 1) return 'الحين'; if (m < 60) return `قبل ${num(m)} دقيقة`;
  const h = Math.round(m / 60); if (h < 24) return `قبل ${num(h)} ساعة`;
  return `قبل ${num(Math.round(h / 24))} يوم`;
}
function renderStatus() {
  const el = $('#mktStatus'); const open = marketOpen();
  el.className = 'mkt' + (open ? ' open' : '');
  const t = M?.marketTime;
  el.innerHTML = `<span class="led"></span><span>${open ? 'السوق مفتوح' : 'السوق مغلق'} · آخر سعر ${ago(t)}</span>`;
}

/* ───────── رسومات ───────── */
function spark(c, w = 72, h = 28, color) {
  if (!c || c.length < 2) return `<svg viewBox="0 0 ${w} ${h}"></svg>`;
  const pts = c.slice(-60), lo = Math.min(...pts), hi = Math.max(...pts), rg = hi - lo || 1;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * w, h - 3 - ((v - lo) / rg) * (h - 6)]);
  const col = color || (pts[pts.length - 1] >= pts[0] ? 'var(--gain)' : 'var(--loss)');
  const d = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const last = xy[xy.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><circle cx="${last[0]}" cy="${last[1]}" r="2" fill="${col}"/></svg>`;
}

function bigChart(q, bars, levels = []) {
  const all = q.c || []; const c = all.slice(-bars);
  if (c.length < 2) return '<div class="explain">ما فيه بيانات كافية للرسم.</div>';
  const W = 600, H = 220, padT = 16, padB = 24, padR = 8;
  const padL = Math.max(46, fmt(Math.max(...all)).length * 7 + 12);
  const ma = all.map((_, i) => (i >= 49 ? all.slice(i - 49, i + 1).reduce((a, b) => a + b, 0) / 50 : null)).slice(-bars);
  const vals = [...c, ...ma.filter((x) => x != null), ...levels.map((l) => l.v)];
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  // مثل تطبيقات الوسطاء: الأقدم يسار والأحدث يمين
  const Xr = (i) => padL + (i / (c.length - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const up = c[c.length - 1] >= c[0]; const col = up ? 'var(--gain)' : 'var(--loss)';
  const line = c.map((v, i) => (i ? 'L' : 'M') + Xr(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join('');
  const area = line + `L${Xr(c.length - 1).toFixed(1)} ${H - padB}L${Xr(0).toFixed(1)} ${H - padB}Z`;
  let maPath = ''; let started = false;
  ma.forEach((v, i) => { if (v == null) return; maPath += (started ? 'L' : 'M') + Xr(i).toFixed(1) + ' ' + Y(v).toFixed(1); started = true; });
  const ticks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15].filter((t) => levels.every((l) => Math.abs(Y(t) - Y(l.v)) > 14));
  const gid = 'g' + uid();
  const lv = levels.map((l) => `<line x1="${padL}" x2="${W - padR}" y1="${Y(l.v)}" y2="${Y(l.v)}" stroke="${l.col}" stroke-dasharray="4 4" stroke-width="1.2"/><text x="${padL - 4}" y="${Y(l.v) + 4}" text-anchor="end" style="fill:${l.col}">${fmt(l.v)}</text>`).join('');
  const lx = Xr(c.length - 1), ly = Y(c[c.length - 1]);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="رسم السعر" direction="ltr">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)" stroke-width="1"/><text x="${padL - 6}" y="${Y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('')}
    <path d="${area}" fill="url(#${gid})"/>
    ${maPath ? `<path d="${maPath}" fill="none" stroke="var(--gold)" stroke-width="1.4" stroke-dasharray="5 4"/>` : ''}
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>
    ${lv}
    <circle cx="${lx}" cy="${ly}" r="4" fill="${col}" stroke="var(--surface)" stroke-width="2"/>
    <text x="${padL}" y="${H - 6}" text-anchor="end" direction="rtl">قبل ${c.length} جلسة</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="start" direction="rtl">اليوم</text>
  </svg>`;
}

/* ───────── الحسابات ───────── */
function calc() {
  const H = S.holdings.map((h) => {
    const q = Q(h.code); const p = priceOf(h);
    const value = (p ?? 0) * (h.qty || 0), costV = (h.cost || 0) * (h.qty || 0);
    const dc = dayChg(q);
    return { ...h, q, p, value, costV, pnl: value - costV, pnlPct: costV ? (value - costV) / costV * 100 : null,
      day: dc ? dc.abs * (h.qty || 0) : 0, dayPct: dc?.pct ?? null, income: (q?.div || 0) * (h.qty || 0) };
  });
  const stocks = H.reduce((a, h) => a + h.value, 0), cost = H.reduce((a, h) => a + h.costV, 0);
  const total = stocks + (S.cash || 0), day = H.reduce((a, h) => a + h.day, 0);
  H.forEach((h) => (h.weight = total ? h.value / total * 100 : 0));
  return { H, stocks, cost, total, day, dayPct: stocks - day ? day / (stocks - day) * 100 : null,
    pnl: stocks - cost, pnlPct: cost ? (stocks - cost) / cost * 100 : null, income: H.reduce((a, h) => a + h.income, 0) };
}

function alerts(c) {
  const out = [];
  for (const h of c.H) {
    const p = h.p, nm = esc(nameOf(h)); if (p == null) continue;
    if (h.stop != null && p <= h.stop) out.push({ t: 'loss', i: '!', tag: 'خطتك تقول بيع', code: h.code,
      title: `${nm} نزل تحت وقف الخسارة ${num(fmt(h.stop))}`,
      why: `السعر ${num(fmt(p))}. أنت حددت هذا المستوى وأنت هادي، والالتزام فيه هو فايدته.` });
    else if (h.stop != null && p <= h.stop * 1.03) out.push({ t: 'warn', i: '↓', tag: 'قريب من الوقف', code: h.code,
      title: `${nm} يبعد ${num(((p - h.stop) / p * 100).toFixed(1) + '%')} عن وقف الخسارة`,
      why: `السعر ${num(fmt(p))} والوقف ${num(fmt(h.stop))}. جهّز قرارك من الحين.` });
    if (h.target != null && p >= h.target) out.push({ t: 'gain', i: '✓', tag: 'وصل هدفك', code: h.code,
      title: `${nm} وصل الهدف ${num(fmt(h.target))}`,
      why: `رابح ${num(pct(h.pnlPct))}. الخيارات المعتادة: تبيع، أو تبيع جزء وترفع الوقف عشان تحمي الربح.` });
    if (h.dayPct != null && Math.abs(h.dayPct) >= 5) out.push({ t: 'info', i: h.dayPct > 0 ? '↑' : '↓', tag: 'حركة قوية اليوم', code: h.code,
      title: `${nm} ${h.dayPct > 0 ? 'طالع' : 'نازل'} ${num(pct(h.dayPct))} اليوم`,
      why: `الحركات الكبيرة غالباً وراها خبر. شوف إعلانات الشركة في موقع تداول قبل أي قرار.` });
    if (h.pnlPct != null && h.pnlPct <= -30) out.push({ t: 'warn', i: '?', tag: 'راجع السبب', code: h.code,
      title: `${nm} خسران ${num(pct(h.pnlPct))}`,
      why: `اسأل نفسك: لو ما كنت أملكه، أشتريه اليوم بهذا السعر؟ سعر شرائك ما يهم السوق.` });
    if (h.weight > 40 && c.H.length > 1) out.push({ t: 'warn', i: '%', tag: 'تركيز', code: h.code,
      title: `${nm} صار ${num(h.weight.toFixed(0) + '%')} من محفظتك`,
      why: `أي خبر سيء عن الشركة يضرب جزء كبير من فلوسك مرة وحدة.` });
    if (h.stop == null) out.push({ t: 'info', i: '+', tag: 'ناقص', code: h.code, edit: true,
      title: `ما حددت وقف خسارة لـ ${nm}`, why: `اضغط هنا وحدد: لو نزل لكم أطلع؟` });
    if (!h.q) out.push({ t: 'info', i: 'i', tag: 'سعر يدوي', code: h.code, edit: true,
      title: `${nm} مو ضمن الأسهم المتابعة تلقائياً`, why: `سعره يدوي. قل لـ Claude يضيف رمزه ${num(esc(h.code || ''))} للقائمة.` });
  }
  for (const w of S.watch) {
    const q = Q(w.code); if (!q || w.buyBelow == null) continue;
    if (q.p <= w.buyBelow) {
      const can = Math.floor((S.cash || 0) / q.p);
      out.push({ t: 'gain', i: '★', tag: 'وصل سعرك', code: w.code,
        title: `${esc(nameOf(w))} عند ${num(fmt(q.p))}، تحت سعرك ${num(fmt(w.buyBelow))}`,
        why: `سيولتك تشتري ${num(can)} سهم${q.div ? `، توزيعاتها ~${num(fmt(can * q.div, 0))} ريال بالسنة` : ''}. تأكد من آخر نتائج الشركة قبل الشراء.` });
    }
  }
  if (M && marketOpen() && M.marketTime && Date.now() / 1000 - M.marketTime > 3600) {
    out.unshift({ t: 'info', i: '⏱', tag: 'تأخير', title: 'الأسعار متأخرة أكثر من ساعة', why: 'التحديث التلقائي ممكن يكون متعطل. اسحب للتحديث أو جرّب بعد شوي.' });
  }
  const order = { loss: 0, gain: 1, warn: 2, info: 3 };
  return out.sort((a, b) => order[a.t] - order[b.t]);
}

/* ───────── قائمة فحص المحلل ─────────
   ٧ فحوصات ثابتة لكل سهم، نفس المعيار للكل */
const isBank = (code) => TICK.find((t) => t.code === code)?.sector === 'بنوك ومالية';
let _secPE = null;
function sectorPE(code) {
  if (!_secPE || _secPE.k !== FUND.updatedAt) {
    const by = {};
    TICK.forEach((t) => { const pe = FUND.f?.[t.code]?.pe; if (pe > 0 && pe < 80) (by[t.sector] ||= []).push(pe); });
    const med = {}; Object.entries(by).forEach(([k, a]) => { a.sort((x, y) => x - y); med[k] = a[Math.floor(a.length / 2)]; });
    _secPE = { k: FUND.updatedAt, med };
  }
  return _secPE.med[TICK.find((t) => t.code === code)?.sector] ?? null;
}
function checklist(code) {
  const q = Q(code), f = FUND.f?.[code]; if (!q || code === 'TASI') return null;
  const C = []; const pc = (x) => (x * 100).toFixed(1) + '%';
  const add = (k, ok, val, why) => C.push({ k, ok, val, why });
  // ١. التقييم
  const med = sectorPE(code);
  if (f?.pe > 0) add('التقييم (مكرر الربحية)', med ? (f.pe <= med ? 1 : f.pe > med * 1.3 ? -1 : 0) : 0, `${f.pe.toFixed(1)}${med ? ` · قطاعه ${med.toFixed(1)}` : ''}`, 'كم ريال تدفع مقابل كل ريال ربح، مقارنة بشركات قطاعه.');
  else if (f && f.margin != null && f.margin < 0) add('التقييم (مكرر الربحية)', -1, 'خسرانة', 'الشركة ما تربح، فما لها مكرر.');
  else add('التقييم (مكرر الربحية)', null, '—', 'ما فيه بيانات.');
  // ٢. الربحية
  const roe = f?.roe ?? (f?.pb && f?.pe > 0 ? f.pb / f.pe : null);
  add('الربحية (العائد على حقوق المساهمين)', roe == null ? null : roe >= 0.12 ? 1 : roe < 0.05 ? -1 : 0, roe == null ? '—' : pc(roe), 'كم تربح الشركة من كل ريال يملكه المساهمين. فوق ١٢٪ ممتاز.');
  // ٣. نمو الأرباح
  add('نمو الأرباح (آخر ربع)', f?.eg == null ? null : f.eg > 0.05 ? 1 : f.eg < -0.1 ? -1 : 0, f?.eg == null ? '—' : (f.eg > 0 ? '+' : '') + pc(f.eg), 'مقارنة بنفس الربع من السنة اللي قبل.' + (f?.eg != null && Math.abs(f.eg) > 1 ? ' نسبة كبيرة جداً، غالباً بسبب ربع ضعيف السنة الماضية أو بند استثنائي، فلا تبني عليها لحالها.' : ''));
  // ٤. الديون
  if (isBank(code)) add('الديون', null, 'بنك', 'البنوك ديونها جزء من شغلها، فما تنقاس بنفس الطريقة.');
  else add('الديون (دين ÷ حقوق ملكية)', f?.de == null ? null : f.de < 100 ? 1 : f.de > 200 ? -1 : 0, f?.de == null ? '—' : (f.de / 100).toFixed(2) + ' مرة', 'أقل من مرة وحدة مريح. فوق مرتين خطر لو ضعفت الأرباح.');
  // ٥. التوزيعات
  const yl = q.div && q.p ? q.div / q.p : 0;
  add('التوزيعات واستدامتها', !yl ? -1 : (yl >= 0.03 && (f?.payout == null || f.payout <= 0.8)) ? 1 : (f?.payout > 1 ? -1 : 0), yl ? `${pc(yl)}${f?.payout ? ` · توزع ${(f.payout * 100).toFixed(0)}% من أرباحها` : ''}` : 'ما توزع', 'عائد جيد ونسبة توزيع أقل من ٨٠٪ من الأرباح = توزيع قابل يستمر.');
  // ٦. الاتجاه الطويل
  const m200 = sma(q.c, 200);
  add('الاتجاه الطويل (متوسط ٢٠٠ يوم)', m200 == null ? null : q.p > m200 ? 1 : -1, m200 == null ? '—' : `${q.p > m200 ? 'فوق' : 'تحت'} ${fmt(m200)}`, 'أشهر خط عند المحترفين: فوق متوسط ٢٠٠ يوم = الاتجاه الكبير صاعد.');
  // ٧. المحللين
  const up = f?.tgt && f.nA >= 3 ? (f.tgt - q.p) / q.p : null;
  add('أهداف المحللين', up == null ? null : up >= 0.1 ? 1 : up < 0 ? -1 : 0, up == null ? '—' : `${fmt(f.tgt)} (${up >= 0 ? '+' : ''}${pc(up)}) من ${f.nA} محلل`, 'متوسط السعر اللي يتوقعه المحللين خلال سنة. يخطون كثير، بس يعطيك صورة.');
  const pass = C.filter((c) => c.ok === 1).length, fail = C.filter((c) => c.ok === -1).length, known = C.filter((c) => c.ok != null).length;
  return { C, pass, fail, known, net: pass - fail, f, up };
}

/* ───────── المحلل ─────────
   يجمع: الأرباح (من ملاحظات مكتوبة بتاريخها) + الاتجاه + التوزيعات + خطتك أنت.
   كل عامل ظاهر بسببه، والخلاصة ميزان مو توقع. */
function analyze(code) {
  const q = Q(code); if (!q || code === 'TASI') return null;
  const own = S.holdings.find((h) => h.code === code);
  const note = NOTES.notes?.[code];
  const F = [];
  if (note) {
    const sc = { 'إيجابي': 2, 'سلبي': -2, 'مختلط': 0 }[note.fund] ?? 0;
    F.push({ k: 'الأرباح والأخبار', s: sc, t: note.fund === 'إيجابي' ? 'أرباح تنمو' : note.fund === 'سلبي' ? 'أرباح نازلة أو خسائر' : 'صورة مختلطة' });
  } else {
    const eg = FUND.f?.[code]?.eg;
    if (eg != null) F.push({ k: 'الأرباح', s: eg > 0.05 ? 2 : eg < -0.1 ? -2 : 0, t: Math.abs(eg) > 1 ? (eg > 0 ? 'أرباح آخر ربع تضاعفت' : 'أرباح آخر ربع انهارت') : `أرباح آخر ربع ${eg > 0 ? '+' : ''}${(eg * 100).toFixed(0)}%` });
    else F.push({ k: 'الأرباح والأخبار', s: 0, t: 'ما فيه بيانات أرباح', na: true });
  }
  const CL = checklist(code);
  if (CL) {
    const val = CL.C[0], an = CL.C[6], lt = CL.C[5];
    if (val.ok != null) F.push({ k: 'التقييم', s: val.ok, t: `مكرر ${val.val}` });
    if (an.ok != null) F.push({ k: 'المحللين', s: an.ok, t: `هدفهم ${an.val}` });
    if (lt.ok != null) F.push({ k: 'الاتجاه الطويل', s: lt.ok, t: `${lt.ok > 0 ? 'فوق' : 'تحت'} متوسط ٢٠٠ يوم` });
  }
  const m50 = sma(q.c, 50), p3 = perf(q, 63);
  if (m50 && p3 != null) {
    const s = q.p > m50 && p3 > 0 ? 1 : q.p < m50 && p3 < 0 ? -1 : 0;
    F.push({ k: 'الاتجاه', s, t: s > 0 ? `صاعد: فوق متوسط ٥٠ يوم و${pct(p3)} بثلاث أشهر` : s < 0 ? `هابط: تحت متوسط ٥٠ يوم و${pct(p3)} بثلاث أشهر` : `متذبذب: ${pct(p3)} بثلاث أشهر` });
  }
  const yl = q.div && q.p ? q.div / q.p * 100 : 0;
  F.push({ k: 'التوزيعات', s: yl >= 4.5 ? 1 : yl === 0 ? -1 : 0, t: yl ? `عائد ${num(yl.toFixed(1) + '%')} بالسنة` : 'ما توزع أرباح' });
  const pos = q.h52 > q.l52 ? (q.p - q.l52) / (q.h52 - q.l52) * 100 : null;
  if (pos != null) F.push({ k: 'السعر من مدى السنة', s: 0, t: pos < 15 ? `قريب من أدنى سعر بالسنة (${num(pos.toFixed(0) + '%')}): رخيص نسبياً، أو فيه سبب للنزول` : pos > 85 ? `قريب من أعلى سعر بالسنة (${num(pos.toFixed(0) + '%')})` : `في نص المدى (${num(pos.toFixed(0) + '%')})` });
  const score = F.reduce((a, f) => a + f.s, 0);
  // عتبات الحكم بعد ما صارت العوامل أكثر
  const HI = 3, LO = -3;
  let v, tone, why;
  const p = q.p;
  const hh = own ? calc().H.find((x) => x.id === own.id) : null;
  const nearLow = pos != null && pos < 15;
  if (own && own.stop != null && p <= own.stop) { v = 'خطتك تقول بيع'; tone = 'loss'; why = `السعر ${num(fmt(p))} كسر الوقف اللي حددته ${num(fmt(own.stop))}. الوقف قرار اتخذته وأنت هادي. إذا قررت تحتفظ، غيّر الوقف بقرار واعي بدل ما تتجاهله.`; }
  else if (own) {
    if (score >= HI) { v = 'احتفاظ'; tone = 'gain'; why = 'الأرقام تدعم السهم. احتفظ وخل وقف خسارة يحمي ربحك.'; }
    else if (score <= LO && nearLow) { v = 'احتفظ بدون تعزيز'; tone = 'warn'; why = `الأرقام ضعيفة، بس السعر قريب من أدنى سعر بالسنة، والبيع هنا يثبّت الخسارة عند أسوأ نقطة. لا تزيد فيه، وخل قاع السنة (${num(fmt(q.l52))}) خط الخروج.`; }
    else if (score <= LO) { v = 'الميزان يميل للتخفيف'; tone = 'loss'; why = 'أغلب العوامل سلبية. خيار وسط: بيع جزء وخل الباقي بوقف، بدل كل شي أو لا شي.'; }
    else { v = 'احتفاظ بحذر'; tone = 'warn'; why = 'الصورة مختلطة. حدد وقف خسارة وراقب النتائج الجاية.'; }
    if (own.stop == null && tone !== 'gain') why += ' ما حددت وقف خسارة لهذا السهم.';
  } else {
    if (score >= HI) { v = 'مرشح للشراء'; tone = 'gain'; why = 'الأرقام قوية. حدد سعر دخول في المراقبة وادخل بجزء من السيولة مو كلها.'; }
    else if (score <= LO) { v = 'ابتعد حالياً'; tone = 'loss'; why = 'أغلب العوامل سلبية في الوقت الحالي.'; }
    else { v = 'راقب'; tone = 'warn'; why = 'مو واضح. انتظر نتائج أو إشارة أوضح.'; }
  }
  if (hh && hh.weight < 5) why += ` مركزه صغير (${num(hh.weight.toFixed(0) + '%')} من محفظتك)، فتأثير أي قرار فيه محدود.`;
  const nz = F.filter((f) => f.s !== 0);
  const agree = nz.length >= 2 && (nz.every((f) => f.s > 0) || nz.every((f) => f.s < 0));
  const conf = (note || (CL && CL.known >= 5)) && agree ? 'متوسطة' : 'منخفضة';
  const r = rsi(q.c);
  const bull = [...(note?.bull || [])], bear = [...(note?.bear || [])];
  if (!note?.bull) {
    if (nearLow) bull.push('قريب من أدنى سعر بالسنة');
    if (yl >= 4.5) bull.push(`توزيعات ${yl.toFixed(1)}% بالسنة تدفع لك وأنت منتظر`);
    if (m50 && q.p > m50) bull.push('فوق متوسط ٥٠ يوم (اتجاه صاعد)');
    if (r != null && r < 30) bull.push('نزل بسرعة مؤخراً، وهذا أحياناً يجيب ارتداد');
  }
  if (!note?.bear) {
    if (m50 && q.p < m50) bear.push('تحت متوسط ٥٠ يوم (اتجاه هابط)');
    if (!yl) bear.push('ما يوزع أرباح');
    if (r != null && r > 70) bear.push('صعد بسرعة مؤخراً، وممكن يصحح');
    if (pos != null && pos > 85) bear.push('قريب من أعلى سعر بالسنة');
  }
  if (CL?.up != null && CL.up >= 0.15 && !note?.bull) bull.push(`المحللين يتوقعون ${(CL.up * 100).toFixed(0)}% صعود خلال سنة`);
  if (CL?.f?.pe > 0 && sectorPE(code) && CL.f.pe < sectorPE(code) * 0.8 && !note?.bull) bull.push('أرخص من قطاعه بمكرر الربحية');
  if (CL?.f?.eg != null && CL.f.eg < -0.1 && !note?.bear) bear.push(`أرباح آخر ربع نزلت ${Math.abs(CL.f.eg * 100).toFixed(0)}%`);
  if (CL?.f?.de > 200 && !isBank(code) && !note?.bear) bear.push('ديونها عالية مقارنة بحقوق المساهمين');
  return { F, score, v, tone, why, note, pos, code, conf, bull, bear, own: hh, CL };
}
/* مستويات الشراء: منطقة دخول، وقف، هدف — كلها من حركة السعر الفعلية
   صاعد (فوق متوسط ٥٠): الدخول عند الرجوع لمتوسط ٢٠ يوم
   هابط: الدخول قرب أدنى سعر بآخر ٢٠ جلسة (دعم) — ولا تلحق السهم */
function tick(p) { return p < 10 ? 0.01 : p < 25 ? 0.02 : p < 50 ? 0.05 : p < 100 ? 0.1 : 0.2; }
function rnd(v, up) { const t = tick(v); return +((up ? Math.ceil(v / t) : Math.floor(v / t)) * t).toFixed(2); }
function levels(q) {
  const c = q?.c; if (!c || c.length < 25 || !q.p) return null;
  const p = q.p, l20 = Math.min(...c.slice(-20)), h20 = Math.max(...c.slice(-20)), m20 = sma(c, 20), m50 = sma(c, 50) ?? m20;
  const up = p > m50;
  let entry = up ? Math.min(p, Math.max(m20, l20)) : Math.min(p, l20 * 1.01);
  entry = rnd(entry);
  const stop = rnd(Math.min(l20, entry) * 0.97);
  let target = Math.max(h20, m50);
  if (q.h52 && target > q.h52) target = q.h52;
  if (target < entry * 1.07) target = entry * 1.07;
  target = rnd(target);
  const rr = (target - entry) / Math.max(entry - stop, 0.01);
  return { entry, stop, target, rr, up, near: p <= entry * 1.02, l20, m20, m50 };
}
function buyView(code) {
  const q = Q(code); const a = analyze(code); if (!a) return null;
  const own = S.holdings.find((h) => h.code === code);
  const L = levels(q);
  if (own) return { a, L, label: a.v, tone: a.tone, why: a.why, own: true };
  const plus = a.F.filter((f) => f.s > 0).map((f) => f.t.replace(/<[^>]+>/g, '').split(':')[0]);
  const minus = a.F.filter((f) => f.s < 0).map((f) => f.t.replace(/<[^>]+>/g, '').split(':')[0]);
  let label, tone, why;
  const m150 = sma(q.c, 150);
  if (a.v === 'مرشح للشراء' && m150 && q.p < m150) {
    tone = 'warn'; label = 'راقب';
    why = 'الأرقام كويسة بس الاتجاه الطويل هابط (تحت متوسط ١٥٠ يوم). اختبرت هالقاعدة على سنة كاملة: الشراء والسهم هابط خسر.';
  } else if (a.v === 'مرشح للشراء' && L && L.rr >= 1.2) {
    tone = 'gain';
    label = L.near ? 'كويس للشراء الحين' : 'كويس للشراء عند ' + fmt(L.entry);
    why = `ليش: ${plus.join(' + ')}. ` + (L.near ? `السعر قريب من منطقة الدخول ${num(fmt(L.entry))}.` : `انتظر يرجع لـ ${num(fmt(L.entry))} بدل ما تلحقه.`);
  } else if (a.v === 'ابتعد حالياً') {
    tone = 'loss'; label = 'مو كويس حالياً'; why = `ليش: ${minus.join(' + ') || 'أغلب العوامل سلبية'}.`;
  } else {
    tone = 'warn'; label = 'راقب'; 
    why = (a.v === 'مرشح للشراء' && L) ? 'الأرقام جيدة بس المكسب المتوقع قليل مقابل المخاطرة من السعر الحالي.' :
      `${plus.length ? 'له: ' + plus.join(' + ') + '. ' : ''}${minus.length ? 'عليه: ' + minus.join(' + ') + '.' : ''}${a.F[0].na ? ' ما راجعت نتائجه.' : ''}`;
  }
  return { a, L, label, tone, why };
}
function lvlLine(L) {
  if (!L) return '';
  return `دخول ${num(fmt(L.entry))} · وقف ${num(fmt(L.stop))} · هدف ${num(fmt(L.target))}`;
}
function ownerBox(a) {
  const h = a.own; const q = Q(a.code); const L = levels(q); if (!h || !q) return '';
  const stop = h.stop ?? L?.stop, target = h.target ?? L?.target;
  let out = `<div class="lv-box"><b>لو صار كذا، وش يصير بفلوسك؟</b><div class="kv">
    ${target ? `<div class="cell"><div class="k">لو طلع لـ ${fmt(target)}</div><div class="v up-t">${sgn((target - h.p) * h.qty)} ريال</div></div>` : ''}
    ${stop ? `<div class="cell"><div class="k">لو نزل لـ ${fmt(stop)}</div><div class="v down-t">${sgn((stop - h.p) * h.qty)} ريال</div></div>` : ''}
  </div>`;
  if (h.pnl < 0) {
    const pick = bestPicks(1)[0]; const myDiv = (q.div || 0) * h.qty; const pq = pick ? Q(pick.a.code) : null;
    out += `<div class="whyline"><b>عن الخسارة:</b> خسارتك ${num(fmt(Math.abs(h.pnl)))} ريال صارت، والبيع ما يزيدها ولا يرجعها. السؤال الوحيد: وين الـ ${num(fmt(h.value))} ريال تشتغل أحسن من اليوم وطالع؟</div>`;
    if (pick && pq) out += `<div class="whyline">للمقارنة: نفس المبلغ في ${esc(pq.n)} (أقوى فرصة اليوم) يعطي توزيعات ~${num(fmt(h.value / pq.p * (pq.div || 0), 0))} ريال بالسنة، مقابل ${num(fmt(myDiv, 0))} هنا. التوزيعات وحدها ما تحسم، بس تعطيك صورة.</div>`;
  }
  return out + '</div>';
}
function verdictChip(a) { return a ? `<span class="vchip ${a.tone}">${a.v}</span>` : ''; }
function analysisBlock(a) {
  if (!a) return '';
  return `<section class="analyst ${a.tone}">
    <div class="an-h"><span class="an-l">رأي المحلل</span>${verdictChip(a)}</div>
    <div class="an-why">${a.why}</div>
    <div class="conf">ثقة التحليل: <b>${a.conf}</b> <span>· ${a.conf === 'متوسطة' ? 'العوامل متفقة والأخبار مراجعة' : 'العوامل مختلفة أو الأخبار ناقصة'}. ما فيه تحليل يضمن الحركة الجاية.</span></div>
    <div class="bb">
      <div class="bb-col up"><b>↑ ليش ممكن يطلع</b><ul>${a.bull.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>ما فيه سبب واضح حالياً</li>'}</ul></div>
      <div class="bb-col down"><b>↓ ليش ممكن ينزل</b><ul>${a.bear.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>ما فيه سبب واضح حالياً</li>'}</ul></div>
    </div>
    ${a.CL ? `<details class="cl"><summary>قائمة فحص المحلل: <b>${num(a.CL.pass)} ✓</b> · <b>${num(a.CL.fail)} ✗</b> من ${num(a.CL.known)} <span class="explain">(اضغط للتفاصيل)</span></summary>
      <div class="cl-list">${a.CL.C.map((c) => `<div class="cl-row"><span class="ck ${c.ok === 1 ? 'up' : c.ok === -1 ? 'down' : 'flat'}">${c.ok === 1 ? '✓' : c.ok === -1 ? '✗' : '–'}</span><div class="cl-main"><div class="cl-top"><b>${c.k}</b><bdi class="clv">${esc(c.val)}</bdi></div><div class="whyline">${c.why}</div></div></div>`).join('')}</div>
      <div class="an-date" style="margin-top:6px">بيانات مالية من Yahoo Finance · ${num((FUND.updatedAt || '').slice(0, 10))}</div></details>` : ''}
    ${a.note?.watch ? `<div class="watchbox"><b>وش يحسم:</b> ${esc(a.note.watch)}</div>` : ''}
    ${a.own ? ownerBox(a) : ''}
    <ul class="factors">${a.F.map((f) => `<li><span class="fs ${f.s > 0 ? 'up' : f.s < 0 ? 'down' : 'flat'}">${f.s > 0 ? '+' : f.s < 0 ? '−' : '•'}</span><b>${f.k}:</b> ${f.t}</li>`).join('')}</ul>
    ${(() => { const b = buyView(a.code); const L = b?.L; if (!L) return '';
      return b.own ? `<div class="lv-box"><b>وقف خسارة مقترح:</b> ${num(fmt(L.stop))} <span class="explain">(تحت أدنى سعر بآخر ٢٠ جلسة بـ ٣٪)</span></div>`
        : `<div class="lv-box"><div><span class="vchip ${b.tone}">${b.label}</span></div>
          <div class="lv-grid"><div><span>ادخل عند</span><b>${num(fmt(L.entry))}</b></div><div><span>وقف خسارة</span><b class="down-t">${num(fmt(L.stop))}</b></div><div><span>هدف أول</span><b class="up-t">${num(fmt(L.target))}</b></div></div>
          <div class="explain">${b.why} المكسب المتوقع ${num(((L.target - L.entry) / L.entry * 100).toFixed(1) + '%')} مقابل مخاطرة ${num(((L.entry - L.stop) / L.entry * 100).toFixed(1) + '%')}.</div></div>`; })()}
    ${a.note ? `<div class="an-note">${esc(a.note.text)}<div class="an-date">ملاحظة مكتوبة بتاريخ ${num(NOTES.updated || '')}</div></div>` : ''}
    <div class="an-date">تحليل آلي من الأرقام، مو توصية مرخصة. القرار لك.</div>
  </section>`;
}

/* ───────── الصفحات ───────── */
function render() {
  renderStatus();
  const v = $('#view');
  if (!M && !TICK.length) return;
  v.innerHTML = ({ steps: vSteps, home: vHome, holdings: vHoldings, market: vMarket, watch: vWatch, learn: vLearn }[view] || vSteps)();
  document.querySelectorAll('#tabbar button').forEach((b) => { if (b.dataset.v === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (sheetState) renderSheet();
}

function vHome() {
  const c = calc(); const A = alerts(c);
  const tasi = Q('TASI'); const td = dayChg(tasi);
  if (!S.holdings.length && !S.watch.length) {
    return `${heroEmpty()}${tasiCard(tasi, td)}
${vaultCard()}
      <div class="empty"><b>أو ابدأ من الصفر</b>من تبويب «أسهمي» أضف كل سهم تملكه بالكمية ومتوسط سعرك.</div>
      <button class="btn block" data-act="add-holding">أضف أول سهم</button>${foot()}`;
  }
  histRecord(c);
  const segs = c.H.filter((h) => h.value > 0).sort((a, b) => b.value - a.value);
  return `
  <section class="hero">
    <div class="lbl">إجمالي المحفظة</div>
    <div class="total">${fmt(c.total)} <span class="cur">ريال</span></div>
    <div class="hero-row">
      <span class="hchip ${dir(c.day)}">اليوم ${num(sgn(c.day))} · ${num(pct(c.dayPct, 2))}</span>
      ${c.cost ? `<span class="hchip ${dir(c.pnl)}">الإجمالي ${num(sgn(c.pnl))} · ${num(pct(c.pnlPct))}</span>` : ''}
    </div>
    <div class="alloc">${segs.map((h, i) => `<span style="width:${h.weight}%;background:${COLORS[i % COLORS.length]}"></span>`).join('')}<span style="flex:1;background:rgba(255,255,255,.28)"></span></div>
    <div class="alloc-lg">${segs.map((h, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(nameOf(h))} ${num(h.weight.toFixed(0) + '%')}</span>`).join('')}<span><i style="background:rgba(255,255,255,.4)"></i>نقد ${num((c.total ? S.cash / c.total * 100 : 0).toFixed(0) + '%')}</span></div>
  </section>
  <div class="stats">
    <div class="stat"><div class="k">السيولة</div><button class="v num" data-act="settings">${fmt(S.cash, 0)}</button></div>
    <div class="stat"><div class="k">توزيعات/سنة</div><div class="v num">${fmt(c.income, 0)}</div></div>
    <div class="stat"><div class="k">قيمة الأسهم</div><div class="v num">${fmt(c.stocks, 0)}</div></div>
  </div>
  ${S.plan?.approved ? (() => { syncPlan(); const n = planSteps(c).filter((x) => x.kind !== 'wait').length; return `<button class="steps-banner ${n ? 'on' : ''}" data-v="steps"><b>${n ? `عندك ${num(n)} ${n === 1 ? 'خطوة' : 'خطوات'} لجلسة ${session().label}` : 'ما عليك شي الجلسة الجاية ✓'}</b><span>افتح «خطواتي» ←</span></button>`; })()
    : `<button class="steps-banner on" data-v="steps"><b>ودك تنفّذ بس بدون تفكير؟</b><span>افتح «خطواتي» ←</span></button>`}
  ${dailyPlan(c)}
  ${histCard()}
  ${tasiCard(tasi, td)}
  <section class="sec">
    <div class="sec-h"><h2>يحتاج انتباهك</h2><span class="meta">${num(A.length)} تنبيه</span></div>
    ${A.length ? A.map((a) => `<div class="alert ${a.t}" ${a.code ? `data-act="${a.edit ? 'edit-holding-code' : 'detail'}" data-code="${esc(a.code)}" role="button" tabindex="0"` : ''}>
        <span class="ic">${a.i}</span><div><b>${a.title}<span class="tg">${a.tag}</span></b><div class="why">${a.why}</div></div></div>`).join('')
      : `<div class="calm">ما فيه شي يحتاج قرار. لا إشارة = لا حركة.</div>`}
  </section>
  <section class="sec">
    <div class="sec-h"><h2>أسهمك اليوم</h2><span class="meta">اضغط على السهم للتفاصيل</span></div>
    <div class="list">${c.H.map((h) => row(h.code, nameOf(h), h.q, h.p)).join('')}</div>
  </section>
  ${foot()}`;
}
function veteranRules(c, weak) {
  const R = [];
  const losers = c.H.filter((h) => h.pnlPct < -15 && (analyze(h.code)?.score ?? 0) < 0);
  if (losers.length) R.push(`لا تعدّل متوسطك (تشتري زيادة) في ${losers.map((h) => esc(nameOf(h))).join(' و')}. التعديل يصلح بس لسهم أرقامه قوية نزل مع السوق، مو لسهم أرباحه نازلة.`);
  const cashPct = c.total ? S.cash / c.total * 100 : 0;
  if (cashPct > 50) R.push(`سيولتك ${num(cashPct.toFixed(0) + '%')} من محفظتك. هذي قوة مو ضعف. ادخل على ٣ دفعات على أسابيع، بدل ما تحطها كلها مرة وحدة.`);
  if (weak) R.push('في السوق النازل، الصبر ربح. لا تحاول تصيد القاع بالضبط، ادخل لما يثبت السعر فوق منطقة الدخول.');
  const big = c.H.find((h) => h.weight > 25); if (big) R.push(`${esc(nameOf(big))} صار ${num(big.weight.toFixed(0) + '%')} من محفظتك. المحترفين نادراً يخلون سهم واحد فوق ٢٠-٢٥٪.`);
  R.push('كل صفقة تبدأ بسؤالين: وين أطلع لو غلطت (الوقف)؟ وكم أقصى خسارة أتحملها بالريال؟');
  return `<ul class="rules">${R.map((r) => `<li>${r}</li>`).join('')}</ul>`;
}
function bestPicks(n) {
  const pool = [...new Set([...S.watch.map((w) => w.code), ...TICK.map((t) => t.code)])].filter((code) => !S.holdings.some((h) => h.code === code));
  return pool.map((code) => buyView(code)).filter((b) => b && b.tone === 'gain')
    .sort((x, y) => (y.a.score - x.a.score) || ((y.L?.near ? 1 : 0) - (x.L?.near ? 1 : 0)) || ((y.L?.rr || 0) - (x.L?.rr || 0))).slice(0, n);
}
/* خطة اليوم: تنبني من جديد مع كل تحديث للأسعار */
function dailyPlan(c) {
  const all = TICK.map((t) => Q(t.code)).filter(Boolean);
  const ups = all.filter((q) => (dayChg(q)?.pct ?? 0) > 0).length, downs = all.filter((q) => (dayChg(q)?.pct ?? 0) < 0).length;
  const avg = all.length ? all.reduce((a, q) => a + (dayChg(q)?.pct ?? 0), 0) / all.length : 0;
  const tasi = Q('TASI'); const td = dayChg(tasi);
  const weak = downs > ups * 1.5, strong = ups > downs * 1.5;
  const mood = weak ? { t: 'loss', s: 'السوق ضعيف', d: 'أغلب الأسهم نازلة. لا تستعجل الشراء، ادخل بالتدريج وخل جزء كبير من سيولتك كاش.' }
    : strong ? { t: 'gain', s: 'السوق قوي', d: 'أغلب الأسهم طالعة. لا تلحق الأسهم اللي طارت، اشتر عند مناطق الدخول.' }
    : { t: 'warn', s: 'السوق متوازن', d: 'ما فيه اتجاه واضح. اشتغل على الأسهم اللي أرقامها قوية بس.' };
  const today = new Date(Date.now() + 3 * 3600e3);
  const dayName = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'][today.getUTCDay()];
  const own = c.H.map((h) => {
    const a = analyze(h.code); const L = levels(h.q); if (!a) return '';
    let act;
    if (a.v === 'خطتك تقول بيع') act = `السعر ${num(fmt(h.p))} تحت وقفك ${num(fmt(h.stop))}. قرر اليوم: تبيع، أو تنقل الوقف بوعي${L ? ` (المقترح من آخر ٢٠ جلسة: ${num(fmt(L.stop))})` : ''}.`;
    else if (a.v === 'احتفظ بدون تعزيز') act = `لا تزيد فيه. اخرج لو كسر ${num(fmt(Q(h.code)?.l52))}.`;
    else if (a.tone === 'loss') act = `فكّر تبيع جزء. وقف للباقي عند ${num(fmt(h.stop ?? L?.stop))}.`;
    else act = `احتفظ. وقف عند ${num(fmt(h.stop ?? L?.stop))}${h.target ? ` وهدف ${num(fmt(h.target))}` : L ? ` وهدف ${num(fmt(L.target))}` : ''}.`;
    return `<button class="pl-row" data-act="detail" data-code="${esc(h.code)}"><span class="vchip ${a.tone}">${a.v}</span><div><b>${esc(nameOf(h))}</b><div class="whyline">${act}</div></div></button>`;
  }).join('');
  const picks = bestPicks(4);
  const budget = Math.min(S.cash * (weak ? 0.25 : 0.34), (c.total || S.cash) * 0.25);
  const buys = picks.map((b) => { const n = Math.floor(budget / b.L.entry);
    return `<button class="pl-row" data-act="detail" data-code="${esc(b.a.code)}"><span class="vchip gain">${b.L.near ? 'اشتر الحين' : 'اشتر عند ' + fmt(b.L.entry)}</span><div><b>${esc(Q(b.a.code)?.n || b.a.code)}</b><div class="whyline">${lvlLine(b.L)}${n ? ` · حوالي ${num(n)} سهم` : ''}</div><div class="whyline">${b.why}</div></div></button>`; }).join('');
  return `<section class="plan">
    <div class="pl-h"><h2>خطة اليوم</h2><span class="meta">${dayName} · تتحدث مع كل سعر جديد</span></div>
    <div class="pl-mood ${mood.t}"><b>${mood.s}</b> · تاسي ${pct(td?.pct, 2)} · ${num(ups)} سهم طالع و${num(downs)} نازل<div class="whyline">${mood.d}</div></div>
    ${NOTES.market ? `<div class="an-note">${esc(NOTES.market)}<div class="an-date">أخبار السوق · ${num(NOTES.updated || '')}</div></div>` : ''}
    <h3 class="pl-sub">١. أسهمك</h3>${own || '<div class="whyline">ما عندك أسهم.</div>'}
    <h3 class="pl-sub">٢. فرص الشراء</h3>${S.plan?.approved ? '<div class="whyline">خطتك شغالة: الشراء من سلة الجودة بس، وتلقاه في «خطواتي». الفرص في تبويب «السوق» للتعلّم، مو جزء من خطتك.</div>' : (buys || '<div class="whyline">ما فيه فرصة قوية اليوم. خلك كاش، وهذا قرار بحد ذاته.</div>')}
    <h3 class="pl-sub">قواعد المحلل لليوم</h3>${veteranRules(c, weak)}
    <h3 class="pl-sub">٣. السيولة</h3><div class="whyline">عندك ${num(fmt(S.cash, 0))} ريال. القاعدة: لا تحط أكثر من ${num(fmt(budget, 0))} ريال في سهم واحد${weak ? '، وخل نصف سيولتك على الأقل كاش لين يهدأ السوق' : ''}.</div>
    <div class="an-date">مبنية آلياً من الأرقام وملاحظات الأخبار، مو توصية مرخصة. القرار لك.</div>
  </section>`;
}
/* ═════════ خطة الطيار الآلي ═════════
   ١) سلة جودة: ٥ شركات كبيرة هادئة توزع أرباح، تختارها قواعد ثابتة
   ٢) شراء شهري منتظم (السيولة تنقسم على عدد أشهر)
   ٣) الأسهم برا السلة تطلع خلال أسبوعين على ارتداد، مع حد حماية
   ٤) وقفك اللي حددته ينفّذ بدون نقاش
   كل يوم تنحسب خطوات الجلسة الجاية من آخر الأسعار */
const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const rDate = (d) => d.toISOString().slice(0, 10);
function session() {
  const now = new Date(Date.now() + 3 * 3600e3); const w = now.getUTCDay(), min = now.getUTCHours() * 60 + now.getUTCMinutes();
  let d = now, live = false;
  if (w <= 4 && min < 910) live = min >= 600; else { do { d = new Date(d.getTime() + 864e5); } while (d.getUTCDay() > 4); }
  return { date: rDate(d), key: rDate(d).slice(0, 7), live, label: `${AR_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${AR_MONTHS[d.getUTCMonth()]}`, monthName: AR_MONTHS[d.getUTCMonth()] };
}
function monthsBetween(a, b) { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); }
function sessionsBetween(a, b) { let n = 0, d = new Date(a + 'T12:00:00Z'); const e = new Date(b + 'T12:00:00Z'); while (d < e) { d = new Date(d.getTime() + 864e5); if (d.getUTCDay() <= 4) n++; } return n; }
function annVol(c) { const n = Math.min(c.length - 1, 250); let s1 = 0, s2 = 0; for (let i = c.length - n; i < c.length; i++) { const r = Math.log(c[i] / c[i - 1]); s1 += r; s2 += r * r; } const m = s1 / n; return Math.sqrt(Math.max(s2 / n - m * m, 0)) * Math.sqrt(250); }

function coreScreen() {
  const out = [];
  for (const t of TICK) {
    const q = Q(t.code), f = FUND.f?.[t.code]; if (!q || !f || !q.c || q.c.length < 60) continue;
    const p = q.p, yl = (q.div || 0) / p, pe = f.pe, roe = f.roe ?? (f.pb && pe > 0 ? f.pb / pe : null), mcap = (f.mcap || 0) / 1e9, bank = t.sector === 'بنوك ومالية';
    const vol = annVol(q.c); const fails = [];
    if (NOTES.notes?.[t.code]?.fund === 'سلبي') fails.push('أرباحها أو أخبارها سلبية');
    else if (f.eg != null && f.eg < -0.15) fails.push('أرباحها نازلة بقوة');
    if (!(pe > 0)) fails.push('ما تربح');
    else if (pe > 25) fails.push('غالية (مكرر فوق ٢٥)');
    if (yl < 0.03) fails.push(yl ? 'توزيعاتها أقل من ٣٪' : 'ما توزع أرباح');
    if (f.payout != null && f.payout > 0.9) fails.push('توزع أكثر من أرباحها');
    if (roe == null || roe < 0.10) fails.push('ربحيتها ضعيفة');
    if (!bank && f.de != null && f.de > 150) fails.push('ديونها عالية');
    if (mcap < 20) fails.push('شركة صغيرة');
    if (vol > 0.25) fails.push('متقلبة');
    const up = f.tgt && f.nA >= 3 ? (f.tgt - p) / p : 0;
    out.push({ code: t.code, name: t.name, sector: t.sector, p, yl, roe, vol, up, fails,
      sc: yl * 100 + Math.min(roe || 0, 0.3) * 20 + Math.min(Math.max(up, 0), 0.4) * 10 - vol * 10 });
  }
  return out.sort((a, b) => b.sc - a.sc);
}
function pickBasket(scr, keep = []) {
  const ok = scr.filter((x) => !x.fails.length); const B = [], cnt = {};
  for (const code of keep) { const x = ok.find((o) => o.code === code); if (x && B.length < 5) { B.push(x.code); cnt[x.sector] = (cnt[x.sector] || 0) + 1; } }
  for (const x of ok) { if (B.length >= 5) break; if (B.includes(x.code) || (cnt[x.sector] || 0) >= 2) continue; B.push(x.code); cnt[x.sector] = (cnt[x.sector] || 0) + 1; }
  return B;
}
function failsOf(code) { return coreScreen().find((x) => x.code === code)?.fails || ['ما فيه بيانات كافية']; }

/* يتزامن مع آخر الأسعار: السلة، خطة الشهر، خطط الخروج — بدون ما يغيّر شي اتفقنا عليه */
function syncPlan() {
  const P = S.plan; if (!P?.approved || !M || !FUND.f) return;
  const ses = session(); let changed = false;
  if (!P.basket.length || P.basketAt !== ses.key) {
    const scr = coreScreen();
    const keep = P.basket.filter((code) => { const x = scr.find((o) => o.code === code); return x && !x.fails.length; });
    const nb = pickBasket(scr, keep);
    if (nb.length) { P.basket = nb; P.basketAt = ses.key; changed = true; }
  }
  if (!P.month || P.month.key !== ses.key) {
    const c = calc();
    const elapsed = Math.max(0, monthsBetween(P.approved.slice(0, 7), ses.key));
    const left = Math.max(1, P.months - elapsed);
    const deploy = Math.max(0, S.cash - P.buffer * c.total);
    const amount = deploy / left;
    const held = (code) => c.H.find((h) => h.code === code)?.value || 0;
    const order = [...P.basket].sort((a, b) => held(a) - held(b));
    const n = amount >= 900 ? 2 : amount >= 250 ? 1 : 0;
    P.month = { key: ses.key, amount: Math.round(amount), left, picks: order.slice(0, n).map((code) => ({ code, budget: Math.round(amount / n), done: false })) };
    changed = true;
  }
  for (const h of S.holdings) {
    if (P.basket.includes(h.code) || h.keep) { if (P.exits[h.code]) { delete P.exits[h.code]; changed = true; } continue; }
    if (!P.exits[h.code]) {
      const q = Q(h.code), L = levels(q); if (!q || !L) continue;
      P.exits[h.code] = { start: ses.date, sellAt: rnd(Math.max(q.p * 1.03, Math.min(L.m20, q.p * 1.08)), true), floor: rnd(L.l20 * 0.97) };
      changed = true;
    }
  }
  Object.keys(P.exits).forEach((code) => { if (!S.holdings.find((h) => h.code === code)) { delete P.exits[code]; changed = true; } });
  if (changed) save();
}

function planSteps(c) {
  const P = S.plan, ses = session(), out = [];
  const st = (id) => P.steps[id];
  const hidden = (id) => st(id)?.s === 'done' || st(id + '#skip')?.d === ses.date;
  const nm = (code) => Q(code)?.n || S.holdings.find((h) => h.code === code)?.name || code;
  let dirty = false;
  const px = (id, v) => { const k = id + '#px', r = P.steps[k]; if (r && r.d === ses.date) return r.v; P.steps[k] = { d: ses.date, v }; dirty = true; return v; };
  if (!st('check-orders')) out.push({ id: 'check-orders', kind: 'check', tone: 'warn', title: 'افتح «الأوامر» في الأهلي تداول وتأكد ما فيه أوامر قديمة معلقة',
    why: 'أي سهم كميته «معلقة» ما تقدر تبيعه لين تلغي أمره القديم. إذا لقيت أمر ما تعرفه أو ما تبيه، ألغه. هذي خطوة مرة وحدة بس.' });
  // ١. الوقف المكسور
  for (const h of c.H) {
    if (h.stop == null || h.p == null || h.p > h.stop) continue;
    const id = `stop-${h.code}-${h.stop}`; if (hidden(id)) continue;
    const price = px(id, rnd(h.p * 0.995));
    out.push({ id, kind: 'order', side: 'sell', code: h.code, qty: h.qty, price, tone: 'loss',
      title: `بيع كل أسهمك في ${esc(nm(h.code))}: ${num(h.qty)} سهم`,
      why: `السعر ${num(fmt(h.p))} تحت وقف الخسارة اللي حددته ${num(fmt(h.stop))}. القاعدة: الوقف ينفّذ بدون نقاش.`,
      result: `يرجع لك تقريباً ${num(fmt(h.qty * price * (1 - FEE), 0))} ريال (${h.pnl >= 0 ? 'ربح' : 'خسارة'} ${num(fmt(Math.abs(h.pnl), 0))} ريال).` });
  }
  // ٢. الخروج المنظم للأسهم برا السلة
  for (const h of c.H) {
    const E = P.exits[h.code]; if (!E || h.p == null || (h.stop != null && h.p <= h.stop)) continue;
    const id = `exit-${h.code}`; const placed = st(id)?.s === 'placed';
    const days = sessionsBetween(E.start, ses.date), left = Math.max(0, 10 - days);
    const reason = failsOf(h.code).slice(0, 2).join('، ');
    if (h.p <= E.floor || days >= 10) {
      if (hidden(id + '-now')) continue;
      const price = px(id + '-now', rnd(h.p * 0.99));
      out.push({ id: id + '-now', kind: 'order', side: 'sell', code: h.code, qty: h.qty, price, tone: 'loss', exit: true,
        title: `بيع ${num(h.qty)} سهم من ${esc(nm(h.code))} اليوم`,
        why: (h.p <= E.floor ? `نزل تحت حد الحماية ${num(fmt(E.floor))}، فنطلع قبل ما يزيد النزول.` : 'خلصت مهلة الأسبوعين بدون ما يوصل سعر البيع، فنطلع ونحوّل الفلوس للسلة.') + (placed ? ' ألغِ أمر البيع القديم أول.' : ''),
        result: `يرجع لك تقريباً ${num(fmt(h.qty * price * (1 - FEE), 0))} ريال.` });
    } else if (placed && h.p >= E.sellAt) {
      if (hidden(id)) continue;
      out.push({ id, kind: 'confirm', side: 'sell', code: h.code, qty: h.qty, price: E.sellAt, tone: 'gain',
        title: `غالباً أمر بيع ${esc(nm(h.code))} تنفّذ عند ${num(fmt(E.sellAt))}`, why: 'السعر وصل سعر البيع اللي حطيناه. افتح محفظتك في الأهلي تداول وتأكد.' });
    } else if (placed) {
      out.push({ id: id + '-wait', kind: 'wait', tone: 'info', title: `أمر بيع ${esc(nm(h.code))} قائم عند ${num(fmt(E.sellAt))}`,
        why: `ما عليك شي اليوم. باقي ${num(left)} جلسات من المهلة. إذا الأهلي تداول ألغى الأمر آخر اليوم، حطه من جديد بنفس السعر. ولو نزل تحت ${num(fmt(E.floor))} بقول لك تطلع.` });
    } else {
      out.push({ id, kind: 'order', resting: true, side: 'sell', code: h.code, qty: h.qty, price: E.sellAt, tone: 'warn', exit: true,
        title: `حط أمر بيع ${num(h.qty)} سهم من ${esc(nm(h.code))} بسعر ${num(fmt(E.sellAt))}`,
        why: `السهم برا سلة الجودة (${reason}). ما نبيعه عند القاع: نحط أمر بيع أعلى من سعره الحالي ${num(fmt(h.p))} ونعطيه أسبوعين يرتد. وإذا نزل تحت ${num(fmt(E.floor))} نطلع فوراً.`,
        result: `لو تنفّذ: يرجع لك تقريباً ${num(fmt(h.qty * E.sellAt * (1 - FEE), 0))} ريال.` });
    }
  }
  // ٣. شراء الشهر
  const mo = P.month;
  if (mo && mo.key === ses.key) {
    mo.picks.forEach((pk, i) => {
      if (pk.done) return; const q = Q(pk.code); if (!q) return;
      const id = `buy-${mo.key}-${pk.code}`; if (hidden(id)) return;
      const price = px(id, rnd(q.p * 1.01, true)), qty = Math.floor(pk.budget / price); if (qty < 1) return;
      const x = coreScreen().find((o) => o.code === pk.code);
      out.push({ id, kind: 'order', side: 'buy', code: pk.code, qty, price, tone: 'gain', pick: i,
        title: `اشتر ${num(qty)} سهم من ${esc(nm(pk.code))}`,
        why: `شراء ${ses.monthName} من سلة الجودة (${num(fmt(mo.amount, 0))} ريال هالشهر). ${esc(nm(pk.code))}: توزيعات ${num(((x?.yl || 0) * 100).toFixed(1) + '%')} وربحية ${num((((x?.roe) || 0) * 100).toFixed(0) + '%')}، ومن أهدى الأسهم حركة. نشتري كل شهر بانتظام بدون ما نحاول نصيد القاع.`,
        result: `المبلغ تقريباً ${num(fmt(qty * price * (1 + FEE), 0))} ريال كحد أعلى.` });
    });
  }
  if (dirty) save();
  return out;
}

function howTo(s) {
  const side = s.side === 'buy' ? 'شراء' : 'بيع';
  return `<details class="how"><summary>كيف أنفذها في الأهلي تداول؟</summary><ol>
    <li>افتح الأهلي تداول ← «منصة التداول»، ونزّل لنموذج الأمر تحت.</li>
    <li>اختر <b>«${side}»</b>.</li>
    <li>«اسم الشركة»: اكتب <b>${num(s.code)}</b> واختر <b>${esc(Q(s.code)?.n || s.code)}</b>.</li>
    <li>«نوع الأمر»: <b>«سعر محدد»</b>.</li>
    <li>«الكمية»: <b>${num(s.qty)}</b> — «السعر»: <b>${num(fmt(s.price))}</b>.</li>
    <li>«شرط التنفيذ»: خله على الافتراضي.${s.resting ? ' وإذا لقيت في «خيارات إضافية» صلاحية للأمر، خلها لأبعد تاريخ خلال أسبوعين.' : ''}</li>
    <li>اضغط «إرسال»، راجع الملخص وأكّد.</li>
    <li>${s.resting ? 'ارجع هنا واضغط «حطيت الأمر». ولما يتنفّذ اضغط «تنفّذ».' : 'لما يتنفّذ ويطلع في محفظتك، ارجع هنا واضغط «تنفّذ»: أحدّث أسهمك وسيولتك لحالي.'}</li>
  </ol><div class="whyline">${s.side === 'buy' ? 'السعر هذا أعلى سعر تقبله: الأمر يتنفذ بأرخص سعر متاح تحته.' : 'السعر هذا أقل سعر تقبله: الأمر يتنفذ بأعلى سعر متاح فوقه.'} الأفضل تحط الأمر بعد ١٠:١٥ الصبح، لأن أول ربع ساعة الأسعار تتقلب.</div></details>`;
}
function stepCard(s, i) {
  const badge = { order: s.side === 'buy' ? 'شراء' : 'بيع', confirm: 'تأكد', check: 'قبل كل شي', wait: 'انتظر' }[s.kind];
  const btns = s.kind === 'check' ? `<button class="btn pri" data-act="step-ok" data-id="${s.id}">تم</button>`
    : s.kind === 'wait' ? ''
    : s.kind === 'confirm' ? `<button class="btn pri" data-act="step-fill" data-id="${s.id}">✓ تنفّذ</button><button class="btn" data-act="step-skip" data-id="${s.id}">ما تنفّذ</button>`
    : s.resting ? `<button class="btn pri" data-act="step-placed" data-id="${s.id}">✓ حطيت الأمر</button><button class="btn" data-act="step-fill" data-id="${s.id}">تنفّذ على طول</button>`
    : `<button class="btn pri" data-act="step-fill" data-id="${s.id}">✓ تنفّذ</button><button class="btn" data-act="step-skip" data-id="${s.id}">ما تنفّذ اليوم</button>`;
  return `<article class="step ${s.tone}">
    <div class="step-h"><span class="step-n">${num(i + 1)}</span><span class="vchip ${s.tone === 'info' ? 'warn' : s.tone}">${badge}</span></div>
    <h3>${s.title}</h3>
    ${s.kind === 'order' || s.kind === 'confirm' ? `<div class="step-order"><div><span>الكمية</span><b>${num(s.qty)}</b></div><div><span>${s.side === 'buy' ? 'أعلى سعر' : 'أقل سعر'}</span><b>${num(fmt(s.price))}</b></div><div><span>القيمة</span><b>${num(fmt(s.qty * s.price, 0))}</b></div></div>` : ''}
    <div class="whyline"><b>ليش:</b> ${s.why}</div>
    ${s.result ? `<div class="whyline">${s.result}</div>` : ''}
    ${s.kind === 'order' ? howTo(s) : ''}
    ${btns ? `<div class="actions">${btns}</div>` : ''}
    ${s.exit ? `<button class="linkbtn" data-act="keep-holding" data-code="${s.code}">ما أبي أبيعه، طلّعه من الخطة</button>` : ''}
  </article>`;
}

function rulesCard(c) {
  const scr = coreScreen(); const B = pickBasket(scr);
  const deploy = Math.max(0, S.cash - 0.10 * c.total);
  const outs = c.H.filter((h) => !B.includes(h.code));
  return `<section class="card rules-card">
    <h2>خطتك: تفكر مرة وحدة، وبعدها تنفّذ بس</h2>
    <div class="whyline">اقرأ القواعد مرة. إذا وافقت، التطبيق يعطيك كل جلسة خطوات مرقّمة بالكمية والسعر وكيف تنفذها.</div>
    <ol class="rules-list">
      <li><b>سلة الجودة:</b> ٥ شركات كبيرة وهادئة الحركة، رابحة، توزع ٣٪ وأكثر، وأرباحها ما تنهار، وبحد أقصى شركتين من نفس القطاع. القواعد هي اللي تختار مو المزاج. حالياً:
        <div class="basket">${B.map((code) => { const x = scr.find((o) => o.code === code); return `<span class="bchip">${esc(x.name)} <small>${num((x.yl * 100).toFixed(1) + '%')}</small></span>`; }).join('')}</div></li>
      <li><b>الشراء:</b> مرة كل شهر من السلة، بمبلغ ثابت. سيولتك (بعد ما نخلي ١٠٪ احتياط) تنقسم على ٤ أشهر: حوالي <b>${num(fmt(deploy / 4, 0))} ريال</b> بالشهر. ما نحاول نصيد القاع.</li>
      <li><b>أسهم السلة ما تنباع عشان نزلت.</b> تطلع بس إذا الشركة فشلت في الفحص (خسارة، أو أرباح تنهار، أو توزيعات توقف).</li>
      <li><b>أسهمك الحالية برا السلة</b> (${outs.map((h) => esc(nameOf(h))).join('، ') || 'ما فيه'}): تطلع خلال أسبوعين على ارتداد، مو عند القاع، مع حد حماية. وتقدر تستثني أي سهم.</li>
      <li><b>وقف الخسارة اللي تحدده ينفّذ بدون نقاش.</b></li>
      <li><b>قواعد البيت:</b> ١٠٪ من المحفظة كاش دايم. لا تداول بالهامش أبداً. لا تحط فلوس تحتاجها خلال سنة.</li>
    </ol>
    <div class="note"><b>بصراحة:</b> اختبرت قواعد البيع والشراء السريع على سنة كاملة من أسعار ١٣٢ سهم، ونتائجها ما كانت ثابتة: ربحت في نص السنة وخسرت في النص الثاني. عشان كذا الخطة مبنية على الشراء الشهري المنتظم في شركات قوية، مو على توقيت السوق. فيه شهور بتشوف محفظتك نازلة، وهذا طبيعي. هذي خطة سنين مو أسابيع، وما فيه شي مضمون.</div>
    <button class="btn pri block" data-act="approve-plan">موافق، ابدأ الخطة</button>
    <div class="an-date">مو توصية مرخصة. القواعد قواعدك، وتقدر توقف الخطة أو تعدّلها من الإعدادات.</div>
  </section>`;
}

function vSteps() {
  const c = calc(), P = S.plan, ses = session();
  if (!S.holdings.length && !S.cash) return `${vaultCard()}${foot()}`;
  if (!P.approved) return rulesCard(c) + foot();
  syncPlan();
  const steps = planSteps(c);
  const actionable = steps.filter((x) => x.kind !== 'wait').length;
  const mo = P.month; const scr = coreScreen();
  const J = P.journal || []; const realized = J.reduce((a, j) => a + (j.pnl || 0), 0);
  const stale = M?.marketTime && Date.now() / 1000 - M.marketTime > 4 * 86400;
  return `${stale ? '<div class="alert loss"><span class="ic">!</span><div><b>الأسعار قديمة</b><div class="why">آخر سعر عندي من أكثر من ٤ أيام. لا تنفّذ أي خطوة لين تتحدث الأسعار (اضغط ↻ فوق).</div></div></div>' : ''}
  <section class="steps-head">
      <div class="lbl">${ses.live ? 'جلسة اليوم' : 'خطوات الجلسة الجاية'}</div>
      <h2>${ses.label}</h2>
      <div class="whyline">${actionable ? `عندك ${num(actionable)} ${actionable === 1 ? 'خطوة' : 'خطوات'}. نفّذها بالترتيب.` : 'ما عليك شي. لا خطوة = لا حركة، وهذا قرار بحد ذاته.'}</div>
      <div class="an-date">الخطة تنحسب من جديد مع كل سعر · آخر سعر ${ago(M?.marketTime)}${NOTES.updated ? ` · تحليل الأخبار ${num(NOTES.updated)}` : ''}${ses.live ? ' · الأسعار تتحدث كل ٥ دقائق' : ''}</div>
    </section>
    ${steps.map(stepCard).join('') || '<div class="calm">✓ كل شي تمام. افتح التطبيق الجلسة الجاية.</div>'}
    <section class="card">
      <div class="sec-h"><h2>سلة الجودة</h2><span class="meta">شهر ${num(Math.min(P.months, Math.max(0, monthsBetween(P.approved.slice(0, 7), ses.key)) + 1))} من ${num(P.months)}</span></div>
      <div class="list">${P.basket.map((code) => { const x = scr.find((o) => o.code === code); const h = c.H.find((y) => y.code === code); const q = Q(code);
        return `<button class="row arow" data-act="detail" data-code="${code}"><div style="min-width:0"><div class="nm">${esc(q?.n || code)}</div><div class="sub">${h ? `تملك ${num(h.qty)} سهم · ${num(fmt(h.value, 0))} ريال` : 'ما اشتريته للحين'}${x ? ` · توزيعات ${num((x.yl * 100).toFixed(1) + '%')}` : ''}</div></div><span class="vchip ${h ? 'gain' : 'warn'}">${h ? 'في محفظتك' : 'بالدور'}</span></button>`; }).join('')}</div>
      ${mo ? `<div class="whyline">مبلغ ${ses.monthName}: ${num(fmt(mo.amount, 0))} ريال${mo.picks.length ? ` على ${mo.picks.map((pk) => esc(Q(pk.code)?.n || pk.code) + (pk.done ? ' ✓' : '')).join(' و')}` : ' (السيولة ما تكفي هالشهر)'}. الشراء الجاي: أول جلسة في الشهر الجاي.</div>` : ''}
    </section>
    <section class="card">
      <div class="sec-h"><h2>سجل صفقاتك</h2><span class="meta">${J.length ? `ربح/خسارة محققة ${sgn(realized)} ريال` : ''}</span></div>
      ${J.length ? `<div class="journal">${J.slice().reverse().slice(0, 20).map((j) => `<div class="jrow"><span class="vchip ${j.side === 'buy' ? 'gain' : 'loss'}">${j.side === 'buy' ? 'شراء' : 'بيع'}</span><div><b>${esc(Q(j.code)?.n || j.code)}</b> · ${num(j.qty)} × ${num(fmt(j.price))}<div class="whyline">${num(j.d)}${j.pnl != null ? ` · ${j.pnl >= 0 ? 'ربح' : 'خسارة'} ${num(fmt(Math.abs(j.pnl)))}` : ''}</div></div></div>`).join('')}</div>` : '<div class="whyline">لما تضغط «تنفّذ» على أي خطوة، تنسجل هنا.</div>'}
    </section>
    ${foot()}`;
}

function applyFill(stp, qty, price) {
  const P = S.plan, ses = session();
  const gross = qty * price, fee = gross * FEE;
  let h = S.holdings.find((x) => x.code === stp.code);
  const rec = { d: ses.date, code: stp.code, side: stp.side, qty, price };
  if (stp.side === 'buy') {
    S.cash = +(S.cash - gross - fee).toFixed(2);
    if (h) { h.cost = +((h.qty * h.cost + gross + fee) / (h.qty + qty)).toFixed(4); h.qty += qty; }
    else S.holdings.push({ id: uid(), code: stp.code, qty, cost: +((gross + fee) / qty).toFixed(4) });
    if (stp.pick != null && P.month?.picks?.[stp.pick]) P.month.picks[stp.pick].done = true;
  } else if (h) {
    const q = Math.min(qty, h.qty);
    S.cash = +(S.cash + q * price - q * price * FEE).toFixed(2);
    rec.pnl = +((price - h.cost) * q - q * price * FEE).toFixed(2);
    h.qty -= q; if (h.qty <= 0) S.holdings = S.holdings.filter((x) => x !== h);
    delete P.exits[stp.code];
  }
  P.journal = (P.journal || []).concat(rec);
  P.steps[stp.id] = { s: 'done', d: ses.date };
  save();
}

function shFill(st) {
  const s = st.step;
  return `<div class="sh-h"><h2>${s.side === 'buy' ? 'تم الشراء' : 'تم البيع'}: ${esc(Q(s.code)?.n || s.code)}</h2><button class="btn ghost" data-act="close">إغلاق</button></div>
  <div class="whyline">اكتب الكمية والسعر اللي تنفّذ فيه فعلاً (تلقاه في «الأوامر» أو «موجودات المحفظة»). إذا ما تدري، خله مثل ما هو.</div>
  <form class="form" id="fillForm" autocomplete="off">
    <div class="two"><label class="field">الكمية<input id="fl-qty" class="n" inputmode="numeric" value="${s.qty}"></label>
    <label class="field">سعر التنفيذ<input id="fl-price" class="n" inputmode="decimal" value="${s.price}"></label></div>
    <button class="btn pri block" type="submit">حدّث محفظتي</button>
  </form>`;
}

function vaultCard() {
  return `<form class="card form" id="vaultForm" autocomplete="off">
    <h2 style="font-size:1.05rem">عندك رمز محفظة؟</h2>
    <label class="field">اكتب الرمز وتنحمّل أسهمك وسيولتك<input id="f-vault" class="n" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="الرمز"></label>
    <button class="btn pri block" type="submit">تحميل محفظتي</button>
  </form>`;
}
function heroEmpty() {
  return `<section class="hero"><div class="lbl">إجمالي المحفظة</div><div class="total">${fmt(S.cash)} <span class="cur">ريال</span></div>
    <div class="hero-row"><span class="hchip">نقد فقط</span></div></section>`;
}
function tasiCard(t, td) {
  if (!t) return '';
  return `<button class="index" data-act="detail" data-code="TASI">
    <div><div class="nm">تاسي</div><div class="code">${t.synthetic ? 'الاتجاه تقريبي' : 'المؤشر العام'}</div></div>
    ${spark(t.c, 160, 36)}
    <div style="text-align:left"><div class="px">${num(fmt(t.p))}</div><span class="chg ${dir(td?.pct)}">${pct(td?.pct, 2)}</span></div>
  </button>`;
}
function row(code, name, q, p, extra = '') {
  const d = dayChg(q);
  return `<button class="row" data-act="detail" data-code="${esc(code)}">
    <div style="min-width:0"><div class="nm">${esc(name)}</div><div class="sub"><span class="code">${esc(code)}</span>${q?.stale ? '<span class="stale">قديم</span>' : ''}</div>${extra}</div>
    ${spark(q?.c)}
    <div style="text-align:left"><div class="px">${fmt(p ?? q?.p)}</div><span class="chg ${dir(d?.pct)}">${pct(d?.pct, 2)}</span></div>
  </button>`;
}

function levelBar(h) {
  const pts = [h.stop, h.cost, h.p, h.target].filter((x) => x != null);
  if (pts.length < 2) return '';
  const lo = Math.min(...pts) * 0.97, hi = Math.max(...pts) * 1.03, X = (v) => ((v - lo) / (hi - lo)) * 100;
  const a = h.stop ?? lo, b = h.target ?? hi;
  const mk = (v, col) => (v == null ? '' : `<span class="m" style="left:${X(v)}%;background:${col}"></span>`);
  return `<div><div class="lvl" dir="ltr"><span class="zone" style="left:${X(a)}%;width:${X(b) - X(a)}%"></span>${mk(h.stop, 'var(--loss)')}${mk(h.cost, 'var(--faint)')}${mk(h.target, 'var(--gain)')}${mk(h.p, 'var(--fg)')}</div>
    <div class="lvl-lg"><span>${h.stop != null ? `<span class="down-t">●</span> وقف ${num(fmt(h.stop))}` : 'بدون وقف'}</span><span>● متوسطك ${num(fmt(h.cost))}</span><span>${h.target != null ? `<span class="up-t">●</span> هدف ${num(fmt(h.target))}` : 'بدون هدف'}</span></div></div>`;
}

function vHoldings() {
  const c = calc();
  return `<div class="sec-h"><h2>أسهمي</h2><span class="meta">${num(c.H.length)} سهم · ${num(fmt(c.stocks, 0))} ريال</span></div>
  ${c.H.length ? '' : `${vaultCard()}<div class="empty"><b>أو أضفها بنفسك</b>أضف السهم بالكمية ومتوسط سعرك من تطبيق وسيطك.</div>`}
  ${c.H.sort((a, b) => b.value - a.value).map((h) => `
  <article class="card">
    <div class="card-h">
      <div><button class="nm" data-act="detail" data-code="${esc(h.code)}">${esc(nameOf(h))}</button>
        <div class="sub"><span class="code">${esc(h.code)}</span> · ${num(h.qty)} سهم · ${num(h.weight.toFixed(0) + '%')} من المحفظة</div>
        <div style="margin-top:6px">${verdictChip(analyze(h.code))}</div></div>
      <div class="px"><div class="p">${fmt(h.p)}</div><span class="chg ${dir(h.dayPct)}">${pct(h.dayPct, 2)}</span></div>
    </div>
    ${h.q ? `<div data-act="detail" data-code="${esc(h.code)}">${spark(h.q.c, 600, 54).replace('<svg', '<svg class="spark-lg"')}</div>` : ''}
    <div class="grid4">
      <div class="cell"><div class="k">القيمة</div><div class="v">${fmt(h.value)}</div></div>
      <div class="cell"><div class="k">الربح/الخسارة</div><div class="v ${dir(h.pnl)}-t">${sgn(h.pnl)}</div></div>
      <div class="cell"><div class="k">النسبة</div><div class="v ${dir(h.pnl)}-t">${pct(h.pnlPct)}</div></div>
      <div class="cell"><div class="k">ربح/خسارة اليوم</div><div class="v ${dir(h.day)}-t">${sgn(h.day)}</div></div>
    </div>
    ${levelBar(h)}
    <div class="actions"><button class="btn" data-act="edit-holding" data-id="${h.id}">تعديل</button></div>
  </article>`).join('')}
  <button class="add-fab" data-act="add-holding">+ أضف سهم تملكه</button>${foot()}`;
}

function vMarket() {
  const sectors = [...new Set(TICK.map((t) => t.sector))];
  let L = TICK.map((t) => ({ ...t, q: Q(t.code) })).filter((t) => t.q);
  if (mktSector) L = L.filter((t) => t.sector === mktSector);
  if (mktQuery) { const s = mktQuery.trim(); L = L.filter((t) => t.name.includes(s) || t.code.startsWith(s)); }
  const BV = {}; L.forEach((t) => (BV[t.code] = buyView(t.code)));
  const rank = (t) => { const b = BV[t.code]; if (!b) return 99; return ({ gain: 0, warn: 1, loss: 2 }[b.tone] ?? 1) * 10 - (b.a.score || 0) - (b.L?.near ? 0.5 : 0); };
  const key = { best: rank, up: (t) => -(dayChg(t.q)?.pct ?? -999), down: (t) => (dayChg(t.q)?.pct ?? 999), yld: (t) => -((t.q.div || 0) / t.q.p),
    low: (t) => (t.q.l52 ? (t.q.p - t.q.l52) / t.q.l52 : 9), m3: (t) => -(perf(t.q, 63) ?? -999), az: null }[mktSort];
  if (key) L.sort((a, b) => key(a) - key(b)); else L.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  const extra = (t) => mktSort === 'yld' ? `<span class="code">عائد ${num(((t.q.div || 0) / t.q.p * 100).toFixed(1) + '%')}</span>`
    : mktSort === 'low' ? `<span class="code">فوق قاع السنة ${num(pct((t.q.p - t.q.l52) / t.q.l52 * 100))}</span>`
    : mktSort === 'm3' ? `<span class="code">٣ أشهر ${num(pct(perf(t.q, 63)))}</span>` : '';
  const chips = [['best', 'الأفضل للشراء'], ['up', 'الأكثر ارتفاعاً'], ['down', 'الأكثر انخفاضاً'], ['yld', 'أعلى توزيعات'], ['low', 'قرب قاع السنة'], ['m3', 'الأقوى ٣ أشهر'], ['az', 'أ-ي']];
  const secStats = sectors.map((sec) => { const qs = TICK.filter((t) => t.sector === sec).map((t) => Q(t.code)).filter(Boolean);
    const ch = qs.length ? qs.reduce((a, q) => a + (dayChg(q)?.pct ?? 0), 0) / qs.length : 0; return { sec, ch, n: qs.length }; });
  const heat = (ch) => { const a = Math.min(Math.abs(ch) / 3, 1) * 0.85 + 0.15; return ch >= 0 ? `background:color-mix(in srgb,var(--gain) ${Math.round(a * 60)}%,var(--surface))` : `background:color-mix(in srgb,var(--loss) ${Math.round(a * 60)}%,var(--surface))`; };
  return `<div class="sec-h"><h2>السوق</h2><span class="meta">${num(L.length)} سهم · ${ago(M?.marketTime)}</span></div>
  <div class="heat">${secStats.map((x) => `<button class="tile" data-act="sector" data-k="${esc(x.sec)}" style="${heat(x.ch)}" aria-pressed="${mktSector === x.sec}"><span>${esc(x.sec)}</span><b>${pct(x.ch, 2)}</b><small>${num(x.n)} سهم</small></button>`).join('')}</div>
  <label class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
    <input id="mktSearch" type="search" placeholder="ابحث باسم الشركة أو الرمز" value="${esc(mktQuery)}" autocomplete="off"></label>
  <div class="chips">${chips.map(([k, l]) => `<button class="chip" data-act="sort" data-k="${k}" aria-pressed="${mktSort === k}">${l}</button>`).join('')}</div>
  <div class="chips"><button class="chip" data-act="sector" data-k="" aria-pressed="${!mktSector}">كل القطاعات</button>${sectors.map((s) => `<button class="chip" data-act="sector" data-k="${esc(s)}" aria-pressed="${mktSector === s}">${esc(s)}</button>`).join('')}</div>
  <div class="list">${L.slice(0, 150).map((t) => { const b = BV[t.code];
    const line = b ? `<div class="buyline"><span class="vchip ${b.tone}">${b.own ? 'تملكه: ' + b.label : b.label}</span>${!b.own && b.L && b.tone !== 'loss' ? `<span class="code">${lvlLine(b.L)}</span>` : ''}</div><div class="whyline">${b.why}</div>` : '';
    return row(t.code, t.name, t.q, null, line).replace('</div></div>', `${extra(t)}</div></div>`); }).join('') || '<div class="calm">ما فيه نتائج</div>'}</div>
  <div class="note">"قرب قاع السنة" و"أعلى توزيعات" فرز بالأرقام بس، مو توصية. السهم ممكن يكون رخيص لأن الشركة فيها مشكلة حقيقية، فاقرأ عنها قبل أي قرار.</div>${foot()}`;
}

function vWatch() {
  const W = S.watch.map((w) => ({ ...w, q: Q(w.code) })).map((w) => ({ ...w, gap: w.q && w.buyBelow != null ? (w.q.p - w.buyBelow) / w.buyBelow * 100 : null }))
    .sort((a, b) => (a.gap ?? 999) - (b.gap ?? 999));
  return `<div class="sec-h"><h2>المراقبة</h2><span class="meta">مرتبة: الأقرب لسعرك فوق</span></div>
  ${W.length ? '' : `${S.holdings.length ? '' : vaultCard()}<div class="empty"><b>قائمتك فاضية</b>أضف سهم تفكر فيه، وحدد السعر اللي يناسبك تشتري عنده.</div>`}
  ${W.map((w) => {
    const q = w.q; const d = dayChg(q); const yl = q?.div && q.p ? q.div / q.p * 100 : null; const can = q?.p ? Math.floor((S.cash || 0) / q.p) : null;
    return `<article class="card">
      <div class="card-h">
        <div><button class="nm" data-act="detail" data-code="${esc(w.code)}">${esc(nameOf(w))}</button>
          <div class="sub"><span class="code">${esc(w.code)}</span>${w.note ? ' · ' + esc(w.note) : ''}</div>
</div>
        <div class="px"><div class="p">${fmt(q?.p)}</div><span class="chg ${dir(d?.pct)}">${pct(d?.pct, 2)}</span></div>
      </div>
      ${(() => { const b = buyView(w.code); if (!b) return ''; const L = b.L; const n = L ? Math.floor(Math.min(S.cash * 0.34, (calc().total || S.cash) * 0.25) / L.entry) : null;
        return `<div class="buybox ${b.tone}"><div class="buyline"><span class="vchip ${b.tone}">${b.label}</span></div><div class="whyline">${b.why}</div>
        ${L ? `<div class="grid4">
          <div class="cell"><div class="k">ادخل عند</div><div class="v">${fmt(L.entry)}</div></div>
          <div class="cell"><div class="k">وقف خسارة</div><div class="v down-t">${fmt(L.stop)}</div></div>
          <div class="cell"><div class="k">هدف أول</div><div class="v up-t">${fmt(L.target)}</div></div>
          <div class="cell"><div class="k">عائد التوزيعات</div><div class="v">${yl != null ? yl.toFixed(1) + '%' : '—'}</div></div>
        </div>
        ${b.tone !== 'loss' && n ? `<div class="explain">لو دخلت: حوالي ${num(n)} سهم (${num(fmt(n * L.entry, 0))} ريال، ثلث سيولتك كحد أعلى). ${w.buyBelow != null ? `سعرك أنت: ${num(fmt(w.buyBelow))}${w.gap <= 0 ? ' ✓ وصل' : ''}` : ''}</div>` : ''}` : ''}</div>`; })()}
      <div class="actions"><button class="btn" data-act="edit-watch" data-id="${w.id}">تعديل</button></div>
    </article>`; }).join('')}
  <button class="add-fab" data-act="add-watch">+ أضف سهم للمراقبة</button>${foot()}`;
}

const LESSONS = [
  ['ليش سعر السهم لحاله ما يعني إنه غالي أو رخيص؟', 'سعر السهم مجرد قيمة الشركة مقسومة على عدد أسهمها. سهم بـ ١٢٠ ريال ممكن يكون أرخص فعلياً من سهم بـ ٥ ريالات. اللي يحدد الرخص: كم تدفع مقابل كل ريال ربح.', 'مكرر الربحية (P/E) = سعر السهم ÷ ربح السهم في السنة. مكرر ١٠ يعني تدفع ١٠ ريالات مقابل كل ريال ربح.'],
  ['وش هو عائد التوزيعات؟', 'بعض الشركات توزع جزء من أرباحها نقداً على المساهمين. العائد = مجموع توزيعات آخر سنة ÷ سعر السهم. التطبيق يحسبه لك من التوزيعات الفعلية في آخر ١٢ شهر.', 'سهم بـ ٢٠ ريال وزّع ريال واحد بالسنة: العائد ٥٪. لو عندك ١٠٠ سهم، يدخل حسابك ١٠٠ ريال بالسنة بدون ما تبيع.'],
  ['ليش السهم ينزل بعد تاريخ الأحقية؟', 'يوم الأحقية آخر يوم لازم تملك فيه السهم عشان تاخذ التوزيع. بعده السعر ينزل تقريباً بقيمة التوزيع، لأن الفلوس طلعت من الشركة.', 'الشراء قبل التوزيع بيوم عشان التوزيع بس ما يعطيك ربح سهل، لأن النزول بعده ياكله.'],
  ['وقف الخسارة: ليش تحدده من قبل؟', 'تقرره وأنت هادي: لو نزل السهم له، تطلع. يمنعك تقرر وأنت خايف أو متعلق بالسهم.', 'اشتريت بـ ٢٠ وما تقبل تخسر أكثر من ١٠٪: وقفك ١٨. ولو صعد لـ ٢٦، ارفع الوقف لـ ٢٣ عشان تحمي جزء من الربح.'],
  ['ليش ما أحط فلوسي في سهم واحد؟', 'الخبر السيء يجي فجأة. لو سهم واحد نص محفظتك، الضربة تجي على نص فلوسك.', 'توزيعها على ٤ أو ٥ شركات في قطاعات مختلفة (بنوك، أغذية، طاقة، اتصالات) يخفف أثر أي خبر.'],
  ['"متى يرجع لسعري؟" سؤال غلط', 'السوق ما يدري بكم اشتريت، والسهم الخسران ما عليه يرجع لسعرك.', 'السؤال الصحيح: لو معي قيمته كاش اليوم، بشتريه؟ إذا لا، فكّر وين الفلوس تشتغل أحسن.'],
  ['وش هو الخط الذهبي المتقطع في الرسم؟', 'متوسط سعر آخر ٥٠ جلسة. لما السعر فوقه، الاتجاه العام صاعد. لما يكون تحته، هابط.', 'يعطيك صورة عامة بس. ما يعرف الأخبار ولا نتائج الشركة، وأي تطبيق يعطيك "ثقة ٨٠٪" منه يعطيك رقم مخترع.'],
  ['كيف التطبيق يحسب "ادخل عند" والوقف والهدف؟', 'إذا السهم صاعد (فوق متوسط ٥٠ يوم): سعر الدخول عند رجوعه لمتوسط آخر ٢٠ يوم، بدل ما تلحقه وهو طاير. إذا هابط: الدخول قرب أدنى سعر بآخر ٢٠ جلسة (الدعم). الوقف تحت أدنى سعر بآخر ٢٠ جلسة بـ ٣٪. الهدف أعلى سعر بآخر ٢٠ جلسة أو متوسط ٥٠ يوم، وأقل شي ٧٪ فوق سعر الدخول.', '"كويس للشراء" يطلع بس لما الأرباح والاتجاه والتوزيعات إيجابية، والمكسب المتوقع أكبر من المخاطرة بـ ١.٢ مرة على الأقل.'],
  ['قائمة فحص المحلل: وش الـ ٧ فحوصات؟', 'كل سهم ينفحص بنفس القائمة: ١) مكرر الربحية مقارنة بقطاعه، ٢) العائد على حقوق المساهمين (فوق ١٢٪ ممتاز)، ٣) نمو أرباح آخر ربع، ٤) الديون، ٥) التوزيعات واستمراريتها، ٦) السعر فوق أو تحت متوسط ٢٠٠ يوم، ٧) متوسط أهداف المحللين.', 'السهم اللي ينجح في أغلبها ومع اتجاه صاعد هو اللي يطلع "كويس للشراء". ولا سهم ينجح في الكل، والقائمة تمنعك تشتري سهم بس لأنه نزل.'],
  ['أهداف المحللين: أصدقها؟', 'هي متوسط توقعات بنوك الاستثمار لسعر السهم بعد سنة. مفيدة كصورة عامة، بس المحللين عادة متفائلين ويعدلون أهدافهم بعد ما يتحرك السعر.', 'استخدمها كعامل واحد من سبعة، مو كوعد.'],
  ['ليش الخطة تشتري كل شهر بدل ما تنتظر القاع؟', 'لأن ما أحد يعرف وين القاع. لما تشتري بمبلغ ثابت كل شهر، تشتري أسهم أكثر لما السعر نازل وأقل لما يكون غالي، فمتوسط سعرك يطلع معقول بدون ما تحتاج تخمّن.', 'هذي الطريقة اسمها الشراء الدوري (Dollar-cost averaging)، وهي من أبسط الطرق اللي تشيل عنك ضغط التوقيت.'],
  ['اختبار قواعد التداول السريع على سنة كاملة', 'اختبرت قاعدة «اشتر قرب أدنى سعر بآخر ٢٠ جلسة، ووقف تحته بـ ٣٪، وهدف ضعف المخاطرة» على ١٣٢ سهم لسنة كاملة. بدون فلتر للاتجاه: ١,٢٧١ صفقة، ٣٣٪ منها رابحة، ومتوسط الصفقة ‎-١.١٪. مع شرط إن السهم فوق متوسط ١٠٠ يوم: ١٨٢ صفقة، ومتوسط الصفقة +٠.٧٪. بس النتيجة ما كانت ثابتة: +٢.٦٪ في النص الأول من السنة و‎-١.٥٪ في النص الثاني.', 'الخلاصة: التوقيت صعب حتى بالقواعد. عشان كذا خطتك مبنية على الشراء الشهري في شركات قوية، والتطبيق ما يقول «كويس للشراء» لسهم اتجاهه الطويل هابط.'],
  ['RSI وش يعني؟', 'مقياس من ٠ إلى ١٠٠ لسرعة حركة السعر في آخر ١٤ جلسة. فوق ٧٠: صعد بسرعة كبيرة. تحت ٣٠: نزل بسرعة كبيرة.', 'مو إشارة شراء أو بيع لحاله. سهم ممكن يظل فوق ٧٠ أسابيع وهو يصعد.'],
];
function vLearn() {
  return `<div class="sec-h"><h2>تعلّم</h2></div>
  ${LESSONS.map((l, i) => `<details ${i === 0 ? 'open' : ''}><summary>${l[0]}</summary><p>${l[1]}</p><div class="eg">${l[2]}</div></details>`).join('')}
  <details><summary>من وين تجي الأسعار؟</summary><p>من Yahoo Finance. تتحدث تلقائياً كل ٥ دقائق تقريباً وقت التداول (الأحد إلى الخميس، ١٠ الصبح إلى ٣ العصر)، وفيها تأخير حوالي ١٥ دقيقة عن السوق.</p><div class="eg">للتنفيذ الفعلي اعتمد دايماً على السعر في تطبيق وسيطك.</div></details>
  ${foot()}`;
}
function foot() { return `<div class="foot">أداة متابعة وتعلّم شخصية، مو توصية استثمارية. بياناتك محفوظة على جهازك بس.<br>الأسعار من Yahoo Finance بتأخير ~١٥ دقيقة.</div>`; }

/* ───────── الورقة السفلية ───────── */
function openSheet(st) { sheetState = st; $('#scrim').hidden = false; $('#sheet').hidden = false; document.body.style.overflow = 'hidden'; renderSheet(); }
function closeSheet() { sheetState = null; $('#scrim').hidden = true; $('#sheet').hidden = true; document.body.style.overflow = ''; }

function renderSheet() {
  const st = sheetState; const b = $('#sheetBody');
  if (st.type === 'detail') b.innerHTML = shDetail(st);
  else if (st.type === 'holding' || st.type === 'watch') b.innerHTML = shForm(st);
  else if (st.type === 'settings') b.innerHTML = shSettings(st);
  else if (st.type === 'import') b.innerHTML = shImport(st);
  else if (st.type === 'fill') b.innerHTML = shFill(st);
}

function shDetail(st) {
  const code = st.code; const q = Q(code); const isIdx = code === 'TASI';
  const owned = S.holdings.find((h) => h.code === code); const watched = S.watch.find((w) => w.code === code);
  const name = q?.n || owned?.name || code;
  if (!q) return `<div class="sh-h"><h2>${esc(name)}</h2></div><div class="note">هذا السهم مو ضمن الأسهم اللي تتحدث تلقائياً.</div>
    ${owned ? `<button class="btn pri block" data-act="edit-holding" data-id="${owned.id}">تعديل</button>` : ''}`;
  const d = dayChg(q); const bars = st.bars || 130;
  const levels = []; if (owned?.stop != null) levels.push({ v: owned.stop, col: 'var(--loss)' }); if (owned?.target != null) levels.push({ v: owned.target, col: 'var(--gain)' });
  if (owned?.cost != null) levels.push({ v: owned.cost, col: 'var(--faint)' }); if (watched?.buyBelow != null) levels.push({ v: watched.buyBelow, col: 'var(--info)' });
  const r = rsi(q.c); const m50 = sma(q.c, 50); const yl = q.div && q.p ? q.div / q.p * 100 : null;
  const pos = q.h52 && q.l52 ? (q.p - q.l52) / (q.h52 - q.l52) * 100 : null;
  const lastDiv = q.divs?.length ? q.divs[q.divs.length - 1] : null;
  return `
  <div class="sh-h">
    <div><h2>${esc(name)}</h2><div class="code">${isIdx ? 'المؤشر العام للسوق السعودي' : esc(code) + ' · ' + esc(q.s || '')}</div></div>
    <div><div class="p">${fmt(q.p)}</div><span class="chg ${dir(d?.pct)}">${num(sgn(d?.abs))} · ${pct(d?.pct, 2)}</span></div>
  </div>
  ${analysisBlock(analyze(code))}
  <div class="chart">${bigChart(q, bars, levels)}
    <div class="ranges">${[[22, 'شهر'], [65, '٣ أشهر'], [130, '٦ أشهر']].map(([n, l]) => `<button class="chip" data-act="bars" data-n="${n}" aria-pressed="${bars === n}">${l}</button>`).join('')}</div>
  </div>
  ${levels.length ? `<div class="explain">${owned?.stop != null ? '<span class="down-t">┅</span> وقف خسارتك ' : ''}${owned?.target != null ? '<span class="up-t">┅</span> هدفك ' : ''}${owned ? '┅ متوسطك ' : ''}${watched?.buyBelow != null ? '<span style="color:var(--info)">┅</span> سعر الشراء اللي حددته ' : ''}<span style="color:var(--gold)">┅</span> متوسط ٥٠ جلسة</div>` : `<div class="explain"><span style="color:var(--gold)">┅</span> الخط الذهبي: متوسط سعر آخر ٥٠ جلسة</div>`}
  <div class="kv">
    <div class="cell"><div class="k">أعلى ٥٢ أسبوع</div><div class="v">${fmt(q.h52)}</div></div>
    <div class="cell"><div class="k">أدنى ٥٢ أسبوع</div><div class="v">${fmt(q.l52)}</div></div>
    <div class="cell"><div class="k">أداء شهر / ٣ أشهر</div><div class="v"><span class="${dir(perf(q, 21))}-t">${pct(perf(q, 21))}</span> / <span class="${dir(perf(q, 63))}-t">${pct(perf(q, 63))}</span></div></div>
    <div class="cell"><div class="k">مدى اليوم</div><div class="v">${fmt(q.dl)} – ${fmt(q.dh)}</div></div>
    ${isIdx ? '' : `<div class="cell"><div class="k">توزيعات آخر سنة</div><div class="v">${q.div ? fmt(q.div) + ' ريال' : 'ما وزّع'}</div></div>
    <div class="cell"><div class="k">عائد التوزيعات</div><div class="v">${yl != null ? yl.toFixed(1) + '%' : '—'}</div></div>`}
  </div>
  <div class="note">
    ${pos != null ? `• السعر عند ${num(pos.toFixed(0) + '%')} من مدى السنة (٠٪ = أدنى سعر، ١٠٠٪ = أعلى سعر).<br>` : ''}
    ${m50 ? `• السعر ${q.p >= m50 ? 'فوق' : 'تحت'} متوسط ٥٠ جلسة (${num(fmt(m50))})، يعني الاتجاه العام ${q.p >= m50 ? 'صاعد' : 'هابط'} حالياً.<br>` : ''}
    ${r != null ? `• RSI = ${num(r.toFixed(0))}: ${r >= 70 ? 'صعد بسرعة كبيرة مؤخراً.' : r <= 30 ? 'نزل بسرعة كبيرة مؤخراً.' : 'حركة عادية.'} هذا وصف للي صار، مو توقع.<br>` : ''}
    ${lastDiv ? `• آخر توزيع: ${num(fmt(lastDiv.a))} ريال بتاريخ ${num(lastDiv.d)}.` : ''}
    ${q.stale ? '<br><span class="stale">• تعذّر تحديث هذا السهم في آخر دورة، والسعر من تحديث سابق.</span>' : ''}
    ${q.synthetic ? '<br>• رسم تاسي تقريبي: محسوب من متوسط حركة ١٣٣ سهم، لأن مصدر الأسعار ما يعطي تاريخ المؤشر. القيمة الأخيرة والتغير اليومي حقيقية.' : ''}
  </div>
  ${owned ? (() => { const h = calc().H.find((x) => x.id === owned.id); return `<div class="kv">
      <div class="cell"><div class="k">تملك</div><div class="v">${num(owned.qty)} سهم بمتوسط ${fmt(owned.cost)}</div></div>
      <div class="cell"><div class="k">ربحك/خسارتك</div><div class="v ${dir(h.pnl)}-t">${sgn(h.pnl)} (${pct(h.pnlPct)})</div></div></div>`; })() : ''}
  ${isIdx ? '' : calcBox(q, owned)}
  ${isIdx ? '' : `<div class="two">
    ${owned ? `<button class="btn pri" data-act="edit-holding" data-id="${owned.id}">تعديل في أسهمي</button>` : `<button class="btn pri" data-act="add-holding" data-code="${esc(code)}">أضفه لأسهمي</button>`}
    ${watched ? `<button class="btn" data-act="edit-watch" data-id="${watched.id}">تعديل المراقبة</button>` : `<button class="btn" data-act="add-watch" data-code="${esc(code)}">راقبه</button>`}
  </div>`}
  <a class="btn ghost block" style="text-align:center;text-decoration:none" href="https://www.saudiexchange.sa/wps/portal/saudiexchange/hidden/company-profile-main/?companySymbol=${encodeURIComponent(code)}" target="_blank" rel="noopener">صفحة الشركة في موقع تداول ↗</a>`;
}

/* حاسبة الشراء: العمولة تقريبية (٠.١٥٥٪ + ضريبة ١٥٪ عليها) */
const FEE = 0.00155 * 1.15;
function calcBox(q, owned) {
  const L = levels(q); const price = L?.near || !L ? q.p : L.entry;
  const def = L ? Math.max(1, Math.floor(Math.min(S.cash * 0.34, (calc().total || S.cash) * 0.25) / price)) : 10;
  return `<section class="card calc" data-price="${price}" data-stop="${L?.stop ?? ''}" data-target="${L?.target ?? ''}" data-div="${q.div || 0}">
    <div class="sec-h"><h2>حاسبة الشراء</h2><span class="meta">بسعر ${num(fmt(price))}</span></div>
    <label class="field">كم سهم؟<input id="calcQty" class="n" inputmode="numeric" value="${def}"></label>
    <div id="calcOut">${calcOut(def, price, L, q.div || 0)}</div>
  </section>`;
}
function calcOut(n, price, L, div) {
  if (!n || n <= 0) return '';
  const cost = n * price, fee = cost * FEE, total = cost + fee;
  const left = (S.cash || 0) - total;
  return `<div class="kv">
    <div class="cell"><div class="k">المبلغ مع العمولة</div><div class="v">${fmt(total)}</div></div>
    <div class="cell"><div class="k">العمولة تقريباً</div><div class="v">${fmt(fee)}</div></div>
    ${L ? `<div class="cell"><div class="k">لو ضرب الوقف ${fmt(L.stop)}</div><div class="v down-t">${sgn(n * L.stop * (1 - FEE) - total)}</div></div>
    <div class="cell"><div class="k">لو وصل الهدف ${fmt(L.target)}</div><div class="v up-t">${sgn(n * L.target * (1 - FEE) - total)}</div></div>` : ''}
    <div class="cell"><div class="k">توزيعات بالسنة</div><div class="v">${fmt(n * div)}</div></div>
    <div class="cell"><div class="k">يبقى من سيولتك</div><div class="v ${left < 0 ? 'down-t' : ''}">${fmt(left)}</div></div>
  </div>${left < 0 ? '<div class="whyline down-t">المبلغ أكبر من سيولتك.</div>' : ''}`;
}
function shForm(st) {
  const H = st.type === 'holding';
  const rec = st.id ? (H ? S.holdings : S.watch).find((x) => x.id === st.id) : null;
  const code = st.code ?? rec?.code ?? '';
  const q = Q(code); const nm = q?.n || rec?.name || '';
  const v = (k) => (rec && rec[k] != null ? esc(rec[k]) : '');
  const picker = !code || st.picking;
  const res = picker ? TICK.filter((t) => !st.q || t.name.includes(st.q) || t.code.startsWith(st.q)).slice(0, 40) : [];
  return `<div class="sh-h"><h2>${rec ? 'تعديل' : H ? 'إضافة سهم تملكه' : 'إضافة للمراقبة'}</h2>
    <button class="btn ghost" data-act="close">إغلاق</button></div>
  <form class="form" id="recForm" autocomplete="off">
    ${picker ? `<label class="field">اختر السهم<input id="pickQ" type="search" placeholder="اكتب اسم الشركة أو الرمز" value="${esc(st.q || '')}"></label>
      <div class="picker">${res.map((t) => `<button type="button" data-act="pick" data-code="${t.code}"><span>${esc(t.name)}</span><span class="code">${t.code}</span></button>`).join('')}
      ${st.q && /^\d{4}$/.test(st.q) && !TICK.find((t) => t.code === st.q) ? `<button type="button" data-act="pick" data-code="${esc(st.q)}"><span>رمز ${esc(st.q)} (سعر يدوي)</span><span class="code">غير متابع</span></button>` : ''}</div>`
    : `<div class="picked"><span>${esc(nm || 'رمز ' + code)} <span class="code">${esc(code)}</span></span>${rec ? '' : `<button type="button" class="btn ghost" data-act="repick">تغيير</button>`}</div>
      ${q ? `<div class="explain">السعر الحالي ${num(fmt(q.p))}${q.div ? ` · توزيعات آخر سنة ${num(fmt(q.div))} ريال` : ''}</div>` : ''}
      ${!q ? `<label class="field">اسم الشركة<input id="f-name" value="${v('name')}" required></label>` : ''}
      ${H ? `<div class="two"><label class="field">الكمية<input id="f-qty" class="n" inputmode="decimal" required value="${v('qty')}"></label>
        <label class="field">متوسط سعر الشراء<input id="f-cost" class="n" inputmode="decimal" required value="${v('cost')}"></label></div>
        <div class="two"><label class="field">وقف الخسارة <small>اختياري</small><input id="f-stop" class="n" inputmode="decimal" value="${v('stop')}"></label>
        <label class="field">الهدف <small>اختياري</small><input id="f-target" class="n" inputmode="decimal" value="${v('target')}"></label></div>
        ${!q ? `<label class="field">السعر الحالي (يدوي)<input id="f-manual" class="n" inputmode="decimal" value="${v('manual')}"></label>` : ''}
        ${(() => { const L = levels(q); return L ? `<button type="button" class="btn block" data-act="use-levels" data-stop="${L.stop}" data-target="${L.target}">استخدم المقترح: وقف ${num(fmt(L.stop))} وهدف ${num(fmt(L.target))}</button>` : ''; })()}
        <div class="explain">وقف الخسارة: السعر اللي لو نزل له السهم تطلع منه. الهدف: السعر اللي لو وصله تفكر تبيع.</div>`
      : `<label class="field">أشتري إذا نزل تحت<input id="f-buy" class="n" inputmode="decimal" value="${v('buyBelow')}"></label>
        <label class="field">ملاحظتك <small>ليش تراقبه؟</small><input id="f-note" value="${v('note')}"></label>`}
      <button class="btn pri block" type="submit">حفظ</button>
      ${rec ? `<button class="btn ${st.confirmDel ? 'danger' : 'ghost'} block" type="button" data-act="del">${st.confirmDel ? 'اضغط مرة ثانية للتأكيد' : 'حذف'}</button>` : ''}`}
  </form>`;
}

function shSettings(st) {
  const json = JSON.stringify(S);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `<div class="sh-h"><h2>الإعدادات</h2><button class="btn ghost" data-act="close">إغلاق</button></div>
  <form class="form" id="cashForm"><label class="field">السيولة النقدية (ريال)<input id="f-cash" class="n" inputmode="decimal" value="${S.cash ?? ''}"></label>
    <button class="btn pri block" type="submit">حفظ السيولة</button></form>
  ${S.plan?.approved ? `<form class="form" id="planForm"><b>إعدادات الخطة</b>
    <div class="two"><label class="field">تقسيم السيولة على كم شهر<input id="pl-months" class="n" inputmode="numeric" value="${S.plan.months}"></label>
    <label class="field">الاحتياط الكاش (%)<input id="pl-buffer" class="n" inputmode="decimal" value="${Math.round(S.plan.buffer * 100)}"></label></div>
    <button class="btn block" type="submit">حفظ إعدادات الخطة</button></form>
  <button class="btn ${st.confirmStop ? 'danger' : 'ghost'} block" data-act="stop-plan">${st.confirmStop ? 'متأكد؟ اضغط مرة ثانية' : 'إيقاف الخطة'}</button>` : ''}
  <div class="note"><b>إضافة التطبيق للشاشة الرئيسية</b><br>${ios ? 'في Safari: زر المشاركة (المربع والسهم) ← «إضافة إلى الشاشة الرئيسية».' : 'في Chrome: القائمة ⋮ ← «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».'}</div>
  <form class="form" id="vaultForm" autocomplete="off"><label class="field">تحميل محفظة برمز<input id="f-vault" class="n" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="الرمز"></label>
    <button class="btn block" type="submit">تحميل (يستبدل بياناتك الحالية)</button></form>
  <div class="note"><b>نسخة احتياطية</b><br>بياناتك محفوظة في هذا الجهاز بس. انسخ النص وخزّنه في الملاحظات، أو استخدمه تنقل بياناتك لجهاز ثاني.</div>
  <label class="field">بياناتك<textarea id="f-backup" rows="3" readonly class="num" style="text-align:left">${esc(json)}</textarea></label>
  <button class="btn block" data-act="copy">نسخ</button>
  <label class="field">استرجاع من نسخة<textarea id="f-restore" rows="3" class="num" style="text-align:left" placeholder="الصق النسخة هنا"></textarea></label>
  <button class="btn block" data-act="restore">استرجاع</button>
  <button class="btn ${st.confirmWipe ? 'danger' : 'ghost'} block" data-act="wipe">${st.confirmWipe ? 'متأكد؟ اضغط مرة ثانية' : 'مسح كل بياناتي'}</button>`;
}

function shImport(st) {
  return `<div class="sh-h"><h2>استيراد محفظة</h2></div>
  <div class="note">الرابط فيه محفظة: ${num(st.data.holdings?.length || 0)} سهم مملوك، ${num(st.data.watch?.length || 0)} للمراقبة، وسيولة ${num(fmt(st.data.cash))} ريال.${S.holdings.length || S.watch.length ? '<br><b>تنبيه:</b> بتنستبدل بياناتك الحالية في هذا الجهاز.' : ''}</div>
  <button class="btn pri block" data-act="do-import">استيراد</button><button class="btn ghost block" data-act="close">إلغاء</button>`;
}

/* ───────── الأحداث ───────── */
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2200); }
function go(v) { view = v; render(); window.scrollTo({ top: 0 }); try { history.replaceState(null, '', '#' + v); } catch {} }

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act],[data-v]'); if (!t) return;
  if (t.dataset.v) return go(t.dataset.v);
  const a = t.dataset.act, st = sheetState;
  switch (a) {
    case 'detail': openSheet({ type: 'detail', code: t.dataset.code }); break;
    case 'bars': st.bars = +t.dataset.n; renderSheet(); break;
    case 'use-levels': { const a = $('#f-stop'), b = $('#f-target'); if (a) a.value = t.dataset.stop; if (b) b.value = t.dataset.target; toast('حطيت المستويات المقترحة، اضغط حفظ'); break; }
    case 'close': closeSheet(); break;
    case 'settings': openSheet({ type: 'settings' }); break;
    case 'add-holding': openSheet({ type: 'holding', code: t.dataset.code || null }); break;
    case 'add-watch': openSheet({ type: 'watch', code: t.dataset.code || null }); break;
    case 'edit-holding': openSheet({ type: 'holding', id: t.dataset.id }); break;
    case 'edit-watch': openSheet({ type: 'watch', id: t.dataset.id }); break;
    case 'edit-holding-code': { const h = S.holdings.find((x) => x.code === t.dataset.code); if (h) openSheet({ type: 'holding', id: h.id }); break; }
    case 'pick': st.code = t.dataset.code; st.picking = false; renderSheet(); break;
    case 'repick': st.picking = true; st.code = null; renderSheet(); break;
    case 'del': {
      if (!st.confirmDel) { st.confirmDel = true; renderSheet(); setTimeout(() => { if (sheetState === st) { st.confirmDel = false; renderSheet(); } }, 4000); break; }
      const k = st.type === 'holding' ? 'holdings' : 'watch'; S[k] = S[k].filter((x) => x.id !== st.id); save(); closeSheet(); render(); toast('انحذف'); break;
    }
    case 'approve-plan': {
      S.plan = Object.assign(planDefaults(), { approved: session().date }); save(); syncPlan(); render(); window.scrollTo({ top: 0 }); toast('بدأت الخطة'); break;
    }
    case 'step-ok': S.plan.steps[t.dataset.id] = { s: 'done', d: session().date }; save(); render(); break;
    case 'step-skip': S.plan.steps[t.dataset.id + '#skip'] = { s: 'skip', d: session().date }; save(); render(); toast('تمام، بنرجع لها الجلسة الجاية'); break;
    case 'step-placed': S.plan.steps[t.dataset.id] = { s: 'placed', d: session().date }; save(); render(); toast('ممتاز. بتابعه لك كل يوم'); break;
    case 'step-fill': { const stp = planSteps(calc()).find((x) => x.id === t.dataset.id); if (stp) openSheet({ type: 'fill', step: stp }); break; }
    case 'keep-holding': { const h = S.holdings.find((x) => x.code === t.dataset.code); if (h) { h.keep = true; delete S.plan.exits[h.code]; save(); render(); toast('طلّعته من الخطة، ما راح أطلب منك تبيعه'); } break; }
    case 'stop-plan': if (!st.confirmStop) { st.confirmStop = true; renderSheet(); break; } S.plan = planDefaults(); save(); closeSheet(); render(); toast('وقفت الخطة'); break;
    case 'sort': mktSort = t.dataset.k; render(); break;
    case 'sector': mktSector = mktSector === t.dataset.k && t.classList.contains('tile') ? '' : t.dataset.k; render(); break;
    case 'copy': { const ta = $('#f-backup'); try { await navigator.clipboard.writeText(ta.value); toast('انسخت'); } catch { ta.select(); toast('حدد النص وانسخه'); } break; }
    case 'restore': {
      try { const d = JSON.parse($('#f-restore').value); if (!Array.isArray(d.holdings)) throw 0; S = Object.assign(blank(), d); save(); closeSheet(); render(); toast('تم الاسترجاع'); }
      catch { toast('النص مو نسخة صحيحة'); } break;
    }
    case 'wipe': if (!st.confirmWipe) { st.confirmWipe = true; renderSheet(); break; } S = blank(); save(); closeSheet(); render(); toast('انمسحت البيانات'); break;
    case 'do-import': S = Object.assign(blank(), st.data); save(); closeSheet(); render(); toast('تم استيراد محفظتك'); break;
    case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; $('#installBar').hidden = true; } break;
    case 'hide-install': $('#installBar').hidden = true; try { localStorage.setItem('mahfazti.noinstall', '1'); } catch {} break;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetState) closeSheet();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.alert[role=button]')) { e.preventDefault(); e.target.click(); }
});
$('#scrim').addEventListener('click', closeSheet);
$('#settingsBtn').addEventListener('click', () => openSheet({ type: 'settings' }));
$('#refreshBtn').addEventListener('click', () => fetchMarket(true));

document.addEventListener('input', (e) => {
  if (e.target.id === 'calcQty') {
    const box = e.target.closest('.calc'); const n = parseInt(e.target.value, 10);
    const L = box.dataset.stop ? { stop: +box.dataset.stop, target: +box.dataset.target } : null;
    $('#calcOut').innerHTML = calcOut(n, +box.dataset.price, L, +box.dataset.div); return;
  }
  if (e.target.id === 'mktSearch') {
    mktQuery = e.target.value; const pos = e.target.selectionStart; render();
    const el = $('#mktSearch'); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
  }
  if (e.target.id === 'pickQ') {
    sheetState.q = e.target.value.trim(); const pos = e.target.selectionStart; renderSheet();
    const el = $('#pickQ'); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
  }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const g = (id) => { const el = $('#' + id); return el ? el.value.trim() : ''; };
  if (e.target.id === 'vaultForm') { openVault(g('f-vault')); return; }
  if (e.target.id === 'fillForm') {
    const qty = parseInt(g('fl-qty'), 10), price = N(g('fl-price'));
    if (!qty || !price) return toast('اكتب الكمية والسعر');
    applyFill(sheetState.step, qty, price); closeSheet(); render(); toast('حدّثت أسهمك وسيولتك'); return;
  }
  if (e.target.id === 'planForm') {
    const m = parseInt(g('pl-months'), 10), b = N(g('pl-buffer'));
    if (m >= 1 && m <= 24) S.plan.months = m; if (b != null && b >= 0 && b <= 50) S.plan.buffer = b / 100;
    S.plan.month = null; save(); syncPlan(); render(); toast('انحفظت إعدادات الخطة'); return;
  }
  if (e.target.id === 'cashForm') { const v = N(g('f-cash')); if (v != null) { S.cash = v; save(); render(); toast('انحفظت السيولة'); } return; }
  if (e.target.id !== 'recForm') return;
  const st = sheetState; const H = st.type === 'holding'; const list = H ? S.holdings : S.watch;
  const rec = st.id ? list.find((x) => x.id === st.id) : { id: uid() };
  rec.code = st.code ?? rec.code;
  if (!Q(rec.code)) rec.name = g('f-name') || rec.name || rec.code; else delete rec.name;
  if (H) {
    rec.qty = N(g('f-qty')); rec.cost = N(g('f-cost')); rec.stop = N(g('f-stop')); rec.target = N(g('f-target'));
    if (!Q(rec.code)) rec.manual = N(g('f-manual'));
    if (!rec.qty || rec.cost == null) return toast('اكتب الكمية ومتوسط السعر');
  } else { rec.buyBelow = N(g('f-buy')); rec.note = g('f-note'); }
  if (!st.id) list.push(rec);
  save(); closeSheet(); render(); toast('انحفظ');
});

async function openVault(code) {
  if (!code) return toast('اكتب الرمز');
  try {
    const v = await (await fetch('data/vault.json?t=' + Date.now())).json();
    const b = (x) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code.trim()), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b(v.salt), iterations: v.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(v.iv) }, key, b(v.ct));
    const d = JSON.parse(new TextDecoder().decode(pt));
    S = Object.assign(blank(), d); save(); render(); toast('انحمّلت محفظتك');
  } catch { toast('الرمز غلط'); }
}

/* ───────── التثبيت ───────── */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredInstall = e;
  try { if (localStorage.getItem('mahfazti.noinstall')) return; } catch {}
  const b = $('#installBar'); b.hidden = false;
  b.innerHTML = `<span>ثبّت <b>محفظتي 1</b> على شاشتك الرئيسية</span><button class="btn pri" data-act="install">تثبيت</button><button class="x" data-act="hide-install" aria-label="إخفاء">×</button>`;
});
function iosHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || !/iphone|ipad|ipod/i.test(navigator.userAgent)) return;
  try { if (localStorage.getItem('mahfazti.noinstall')) return; } catch {}
  const b = $('#installBar'); b.hidden = false;
  b.innerHTML = `<span>لإضافة <b>محفظتي 1</b> للشاشة: زر المشاركة <span aria-hidden="true">⬆︎</span> ← «إضافة إلى الشاشة الرئيسية»</span><button class="x" data-act="hide-install" aria-label="إخفاء">×</button>`;
}

/* ───────── استيراد من الرابط ───────── */
function readImportHash() {
  const m = location.hash.match(/^#import=([A-Za-z0-9_-]+)/); if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    history.replaceState(null, '', location.pathname);
    return Array.isArray(data.holdings) ? data : null;
  } catch { return null; }
}

/* ───────── التشغيل ───────── */
async function boot() {
  const h = location.hash.slice(1); if (['steps', 'home', 'holdings', 'market', 'watch', 'learn'].includes(h)) view = h;
  const imp = readImportHash();
  try { TICK = await (await fetch('data/tickers.json')).json(); } catch { TICK = []; }
  try { NOTES = await (await fetch('data/notes.json?t=' + Date.now())).json(); } catch { NOTES = {}; }
  try { FUND = await (await fetch('data/fundamentals.json?t=' + Date.now())).json(); } catch { FUND = {}; }
  await fetchMarket(false);
  syncPlan(); render();
  if (imp) openSheet({ type: 'import', data: imp });
  iosHint();
  setInterval(() => { if (document.visibilityState === 'visible' && marketOpen()) fetchMarket(false); }, 60000);
  setInterval(renderStatus, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastFetch > 60000) fetchMarket(false); });
  if ('serviceWorker' in navigator) {
    // لما ينزل تحديث للتطبيق، يعيد التحميل مرة وحدة عشان تشوف النسخة الجديدة فوراً
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
  }
}
boot();
})();
