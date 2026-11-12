// يشتغل كل دقيقة وقت التداول: يقارن الأسعار بتنبيهاتك ويرسل إشعار لجوالك
import { store, quotes, push, riyadh, fmt } from '../lib/core.mjs';

const ACT = { buy: '🟢 وقت الشراء؟', sell: '🔴 وقت البيع؟', note: '🔔 تنبيه سعر' };

export async function run(now = Date.now()) {
  const R = riyadh(now);
  if (R.dow > 4 || R.hm < 958 || R.hm > 1520) return { skipped: 'closed' };
  const s = store();
  const { blobs } = await s.list({ prefix: 'u/' });
  const users = [];
  for (const b of blobs) { const d = await s.get(b.key, { type: 'json' }); if (d?.sub) users.push([b.key, d]); }
  if (!users.length) return { users: 0 };

  const codes = new Set();
  for (const [, d] of users) {
    for (const a of d.alerts || []) if (a.on && !a.firedAt) codes.add(a.code);
    if (d.move > 0) for (const h of d.hold || []) codes.add(h.code);
  }
  if (!codes.size) return { users: users.length, codes: 0 };
  const Q = await quotes([...codes]);
  let sent = 0;

  for (const [key, d] of users) {
    let changed = false; const out = [];
    const nm = (c) => d.names?.[c] || d.hold?.find((h) => h.code === c)?.n || c;
    for (const a of d.alerts || []) {
      if (!a.on || a.firedAt) continue;
      const q = Q[a.code]; if (!q?.p) continue;
      // سعر قديم من يوم ثاني ما نعتمد عليه
      if (q.t && riyadh(q.t * 1000).day !== R.day) continue;
      const hit = a.op === '>=' ? q.p >= a.price : q.p <= a.price;
      if (!hit) continue;
      a.firedAt = new Date(now).toISOString(); a.firedP = q.p; changed = true;
      out.push({ title: `${ACT[a.act]} ${nm(a.code)}`,
        body: `السعر وصل ${fmt(q.p)} (${a.op === '>=' ? 'طلع فوق' : 'نزل تحت'} ${fmt(a.price)} اللي حددته).${a.note ? ' ' + a.note : ''}`,
        code: a.code, tag: 'a-' + a.id });
    }
    if (d.move > 0) {
      d.moves = d.moves?.day === R.day ? d.moves : { day: R.day, sent: [] };
      for (const h of d.hold || []) {
        const q = Q[h.code]; if (!q?.p || !q.pc) continue;
        if (q.t && riyadh(q.t * 1000).day !== R.day) continue;
        const ch = (q.p - q.pc) / q.pc * 100; const tag = h.code + (ch > 0 ? ':up' : ':down');
        if (Math.abs(ch) < d.move || d.moves.sent.includes(tag)) continue;
        d.moves.sent.push(tag); changed = true;
        out.push({ title: `${ch > 0 ? '📈' : '📉'} ${nm(h.code)} ${ch > 0 ? 'طالع' : 'نازل'} ${Math.abs(ch).toFixed(1)}٪ اليوم`,
          body: `السعر الحين ${fmt(q.p)} وأمس قفل على ${fmt(q.pc)}. افتح التطبيق وشوف وش الخطة فيه.`, code: h.code, tag: 'm-' + tag });
      }
    }
    for (const p of out) {
      const r = await push(d.sub, p);
      if (r === 'gone') { d.sub = null; changed = true; break; }
      if (r === 'ok') sent++;
      d.log = [...(d.log || []), { t: new Date(now).toISOString(), title: p.title, r }].slice(-30);
    }
    if (changed || out.length) await s.setJSON(key, d);
  }
  return { users: users.length, codes: codes.size, sent };
}

export default async () => { const r = await run(); console.log(JSON.stringify(r)); };
// كل دقيقة من ١٠ الصبح لين ٣:٥٩ العصر بتوقيت الرياض، الأحد إلى الخميس
export const config = { schedule: '* 7-12 * * 0-4' };
