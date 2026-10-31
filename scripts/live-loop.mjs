// حلقة الأسعار الحية: كل دقيقة وقت التداول تجيب أسعار كل الأسهم بثلاث طلبات مجمّعة،
// وتنشرها في ملف live.json على فرع live (التطبيق يقراه كل ~٧٠ ثانية).
// وكل ٥ دقائق تطلق تحديث الموقع الكامل (prices.yml).
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';

const TICKERS = JSON.parse(await fs.readFile('data/tickers.json', 'utf8'));
const MAP = Object.fromEntries([...TICKERS.map((t) => [`${t.code}.SR`, t.code]), ['^TASI.SR', 'TASI']]);
const SYMS = Object.keys(MAP);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REPO = process.env.REPO, TOKEN = process.env.GH_TOKEN;
const END = Number(process.env.END_HM || 1525);          // آخر وقت (الرياض) للحلقة
const TEST_ITERS = Number(process.env.TEST_ITERS || 0);  // للاختبار خارج وقت التداول
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const riy = () => { const d = new Date(Date.now() + 3 * 3600e3); return { dow: d.getUTCDay(), hm: d.getUTCHours() * 100 + d.getUTCMinutes() }; };
const sh = (cmd) => execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });

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

async function quotes(s) {
  const out = {}; let fail = null;
  for (let i = 0; i < SYMS.length; i += 50) {
    const batch = SYMS.slice(i, i + 50);
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(','))}&crumb=${encodeURIComponent(s.crumb)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookies, Accept: 'application/json' } }).catch(() => null);
    if (!res || !res.ok) { fail = res?.status || 'net'; continue; }
    const j = await res.json().catch(() => null);
    for (const r of j?.quoteResponse?.result || []) {
      const code = MAP[r.symbol]; if (!code || r.regularMarketPrice == null) continue;
      // [السعر، الإغلاق السابق، أعلى اليوم، أدنى اليوم، الكمية، وقت آخر صفقة]
      out[code] = [r.regularMarketPrice, r.regularMarketPreviousClose ?? null, r.regularMarketDayHigh ?? null,
        r.regularMarketDayLow ?? null, r.regularMarketVolume ?? null, r.regularMarketTime ?? null];
    }
    await sleep(300);
  }
  return { out, fail };
}

const DIR = '/tmp/livepub';
sh(`rm -rf ${DIR} && mkdir -p ${DIR} && cd ${DIR} && git init -q && git checkout -q --orphan live && git config user.name mahfazti-bot && git config user.email "41898282+github-actions[bot]@users.noreply.github.com" && git remote add origin "https://x-access-token:${TOKEN}@github.com/${REPO}.git"`);

let s = await session(), n = 0, first = true, okRuns = 0;
while (true) {
  const { dow, hm } = riy();
  if (TEST_ITERS ? n >= TEST_ITERS : (dow > 4 || hm > END)) break;
  const t0 = Date.now();
  if (!s) s = await session();
  if (s) {
    const { out, fail } = await quotes(s);
    if (fail === 401 || fail === 403) s = null; // انتهت صلاحية الـ crumb — نجدده الدورة الجاية
    const cnt = Object.keys(out).length;
    if (cnt > 20) {
      await fs.writeFile(`${DIR}/live.json`, JSON.stringify({ t: new Date().toISOString(), n: cnt, q: out }));
      try { sh(`cd ${DIR} && git add live.json && git commit -q ${first ? '' : '--amend'} -m live && git push -q -f origin live`); first = false; okRuns++; }
      catch (e) { console.log('push failed', e.message); }
    }
    console.log(new Date().toISOString(), 'quotes', cnt, fail ? `fail=${fail}` : '');
  } else console.log(new Date().toISOString(), 'no crumb');
  n++;
  if (!TEST_ITERS && n % 5 === 0) { try { sh('gh workflow run prices.yml --ref main'); } catch { /* نكمل */ } }
  const wait = 60000 - (Date.now() - t0); if (wait > 0) await sleep(wait);
}
console.log(`loop done: ${n} iterations, ${okRuns} published`);
