// Supabase Edge Function "mitteilungen"
// - ?action=key   → öffentlicher VAPID-Schlüssel (wird beim ersten Aufruf erzeugt und in push_config gespeichert)
// - ?action=test  → schickt dem angemeldeten Nutzer sofort eine Test-Mitteilung (braucht Login-Token)
// - ?action=cron  → wird stündlich von pg_cron aufgerufen: 7:00 Tageserinnerung, 20:00 Streak-Warnung (Ortszeit)
// Web Push (VAPID + aes128gcm, RFC 8291/8292) ist hier ohne Zusatzbibliothek mit WebCrypto umgesetzt.

const SB = Deno.env.get('SUPABASE_URL')!;
// Server-Schlüssel: alter "service_role"-Key oder neuer "sb_secret_..."-Key (beide automatisch von Supabase gesetzt)
const SK: string = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || (() => {
  try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); return k.default || Object.values(k)[0] || ''; } catch { return ''; }
})();
// Neue sb_-Keys sind kein JWT → nur als apikey schicken
const serverHeaders = (): Record<string, string> => SK.startsWith('sb_') ? { apikey: SK } : { apikey: SK, Authorization: `Bearer ${SK}` };
const SUBJECT = 'https://zwergkanikl.github.io/italiano/';
const DAILY_HOUR = 7;
const STREAK_HOUR = 20;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- Hilfen ----------
const te = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s: string) => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { ...serverHeaders(), 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

// ---------- VAPID-Schlüssel ----------
let cached: { publicKey: string; key: CryptoKey } | null = null;
async function vapid() {
  if (cached) return cached;
  let rows = await db('push_config?id=eq.1&select=public_key,private_jwk');
  if (!rows.length) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
    await db('push_config', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ id: 1, public_key: pub, private_jwk: jwk })
    });
    rows = await db('push_config?id=eq.1&select=public_key,private_jwk');
  }
  const jwk = rows[0].private_jwk;
  const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cached = { publicKey: rows[0].public_key, key };
  return cached;
}

async function vapidHeader(endpoint: string) {
  const { publicKey, key } = await vapid();
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SUBJECT
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

// ---------- Verschlüsselung (aes128gcm) ----------
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

async function encrypt(payload: string, p256dh: string, authSecret: string) {
  const uaPublic = fromB64u(p256dh);
  const auth = fromB64u(authSecret);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(te.encode(payload), new Uint8Array([2])); // 0x02 = letzter Datensatz
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

type Sub = { endpoint: string; user_id: string; p256dh: string; auth: string; tz: string; daily: boolean; streak: boolean; last_daily: string | null; last_streak: string | null; last_exam: string | null };

async function send(sub: Sub, msg: { title: string; body: string; tag: string }) {
  const body = await encrypt(JSON.stringify({ ...msg, url: './' }), sub.p256dh, sub.auth);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(6 * 3600),
      Urgency: 'normal'
    },
    body
  });
  if (r.status === 404 || r.status === 410) {
    // Abo existiert nicht mehr (z. B. App gelöscht) → aufräumen
    await db(`push_abos?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' });
    return { ok: false, status: r.status, removed: true };
  }
  return { ok: r.ok, status: r.status, text: r.ok ? '' : (await r.text()).slice(0, 200) };
}

// ---------- Inhalte ----------
function localNow(tz: string) {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).map(p => [p.type, p.value]));
  } catch { return localNow('Europe/Berlin'); }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
const prevDay = (date: string, n = 1) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

// deno-lint-ignore no-explicit-any
function dailyMessage(data: any) {
  const cards = data?.cards || {}, prog = data?.progress || {}, now = Date.now();
  let due = 0, fresh = 0;
  // deno-lint-ignore no-explicit-any
  for (const c of Object.values<any>(cards)) {
    if (c.deleted) continue;
    for (const dir of ['de-it', 'it-de']) {
      const p = prog[`${c.id}|${dir}`];
      if (p && p.seen && p.due <= now) due++;
      else if (dir === 'de-it' && (!p || !p.seen)) fresh++;
    }
  }
  // Grammatik (ab v1.9): Übungen aus Paketen + fällige Konjugationen
  let gram = 0;
  const topics = data?.gtopics || {};
  // deno-lint-ignore no-explicit-any
  for (const i of Object.values<any>(data?.gitems || {})) {
    if (i.deleted || !topics[i.topicId] || topics[i.topicId].deleted) continue;
    const p = prog[`g:${i.id}|de-it`];
    if (!p || !p.seen || p.due <= now) gram++;
  }
  // deno-lint-ignore no-explicit-any
  for (const [k, p] of Object.entries<any>(prog)) {
    if (!k.startsWith('c:') || !p.seen || p.due > now) continue;
    const cid = k.split(':')[1];
    if (cards[cid] && !cards[cid].deleted) gram++;
  }
  if (!due && !fresh && !gram) return null;
  const parts: string[] = [];
  if (due) parts.push(`${due} ${due === 1 ? 'Vokabel' : 'Vokabeln'} fällig${fresh ? ` + ${fresh} neue` : ''}`);
  else if (fresh) parts.push(`${fresh} neue ${fresh === 1 ? 'Vokabel' : 'Vokabeln'}`);
  if (gram) parts.push(`${gram} ${gram === 1 ? 'Grammatik-Übung' : 'Grammatik-Übungen'}`);
  const body = `${parts.join(' · ')}. Avanti! 💪`;
  return { title: 'Buongiorno! 🇮🇹', body, tag: 'italiano-daily' };
}

// deno-lint-ignore no-explicit-any
function streakMessage(data: any, today: string) {
  const days = data?.days || {};
  if (days[today]?.reviews > 0) return null; // heute schon gelernt
  let n = 0, d = prevDay(today);
  while (days[d]?.reviews > 0) { n++; d = prevDay(d); }
  if (n < 1) return null;
  return { title: `🔥 ${n} ${n === 1 ? 'Tag' : 'Tage'} Streak in Gefahr`, body: 'Heute hast du noch nicht gelernt. Ein paar Minuten reichen, um deinen Streak zu retten!', tag: 'italiano-streak' };
}

// Lernplan-Erinnerung für Termine (planCounts berechnet die App beim Sync)
// deno-lint-ignore no-explicit-any
function examMessage(data: any, today: string) {
  // deno-lint-ignore no-explicit-any
  const exams = Object.values<any>(data?.exams || {}).filter(e => !e.deleted && e.notify !== false && e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!exams.length) return null;
  const left = (d: string) => Math.round((Date.parse(d + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
  const line = (e: { title: string; date: string; planCounts?: Record<string, number> }) => {
    const n = left(e.date), c = e.planCounts?.[today];
    if (n === 0) return `🎯 Heute: ${e.title} – viel Erfolg! 🍀`;
    const when = n === 1 ? 'morgen' : `in ${n} Tagen`;
    return `${e.title} (${when}): ${c ? `heute ${c} ${c === 1 ? 'Abfrage' : 'Abfragen'}` : 'schau in deinen Lernplan'}${n === 1 ? ' – Generalprobe!' : ''}`;
  };
  return {
    title: exams.length === 1 ? `📅 ${exams[0].title}` : '📅 Dein Lernplan für heute',
    body: exams.slice(0, 3).map(line).join('\n'),
    tag: 'italiano-exam'
  };
}

async function dataFor(userIds: string[]) {
  if (!userIds.length) return {};
  const rows = await db(`lernstand?select=user_id,data&user_id=in.(${userIds.join(',')})`);
  // deno-lint-ignore no-explicit-any
  return Object.fromEntries(rows.map((r: any) => [r.user_id, r.data]));
}

async function runCron() {
  const subs: Sub[] = await db('push_abos?select=*');
  const data = await dataFor([...new Set(subs.map(s => s.user_id))]);
  const log: unknown[] = [];
  for (const s of subs) {
    const { date, hour } = localNow(s.tz);
    const upd: Record<string, string> = {};
    if (s.daily && hour === DAILY_HOUR && s.last_daily !== date) {
      upd.last_daily = date;
      const m = dailyMessage(data[s.user_id]);
      if (m) log.push({ type: 'daily', ...(await send(s, m)) });
    }
    if (hour === DAILY_HOUR && s.last_exam !== date) {
      upd.last_exam = date;
      const m = examMessage(data[s.user_id], date);
      if (m) log.push({ type: 'exam', ...(await send(s, m)) });
    }
    if (s.streak && hour === STREAK_HOUR && s.last_streak !== date) {
      upd.last_streak = date;
      const m = streakMessage(data[s.user_id], date);
      if (m) log.push({ type: 'streak', ...(await send(s, m)) });
    }
    if (Object.keys(upd).length) {
      await db(`push_abos?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'PATCH', body: JSON.stringify(upd) }).catch(() => {});
    }
  }
  return { checked: subs.length, log };
}

async function userFromToken(req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SK, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return (await r.json()).id as string;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const action = new URL(req.url).searchParams.get('action');
  try {
    if (!SK) return json({ error: 'Server-Schlüssel fehlt' }, 500);
    if (action === 'key') return json({ publicKey: (await vapid()).publicKey });
    if (action === 'cron') return json(await runCron());
    if (action === 'test') {
      const uid = await userFromToken(req);
      if (!uid) return json({ error: 'Nicht angemeldet' }, 401);
      const subs: Sub[] = await db(`push_abos?select=*&user_id=eq.${uid}`);
      const data = (await dataFor([uid]))[uid];
      const m = dailyMessage(data) || { title: 'Avanti 🇮🇹', body: 'Test: Mitteilungen funktionieren!', tag: 'italiano-test' };
      const results = [];
      for (const s of subs) results.push(await send(s, { ...m, title: m.title + ' (Test)' }));
      const em = examMessage(data, localNow(subs[0]?.tz || 'Europe/Berlin').date);
      if (em) for (const s of subs) results.push(await send(s, { ...em, title: em.title + ' (Test)' }));
      return json({ sent: results.filter(r => r.ok).length, results });
    }
    return json({ error: 'Unbekannte Aktion' }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
