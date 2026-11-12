import { json, preflight } from '../lib/core.mjs';
export default async (req) => (req.method === 'OPTIONS' ? preflight() : json({ ok: true, t: new Date().toISOString() }));
export const config = { path: '/api/ping' };
