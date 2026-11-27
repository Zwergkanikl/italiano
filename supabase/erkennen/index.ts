// Supabase Edge Function "erkennen"
// Bekommt das Foto einer Buchseite (JPEG, base64) und liefert den Text der Seite
// und die Vokabeln (italienisch → deutsch) zurück. Die Erkennung macht Claude (Anthropic).
// Braucht das Secret ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).
import Anthropic from 'npm:@anthropic-ai/sdk';

const SB = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Nur angemeldete Nutzer der App dürfen erkennen lassen (kostet Geld)
async function userFromToken(req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: req.headers.get('apikey') || ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return (await r.json()).id as string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    titel: { type: 'string', description: 'Überschrift oder Thema der Seite, leer wenn keine' },
    text: { type: 'string', description: 'Der vollständige Text der Seite, Zeile für Zeile, Absätze mit Leerzeile getrennt' },
    vokabeln: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          it: { type: 'string', description: 'Italienisches Wort oder Ausdruck, Nomen mit Artikel' },
          de: { type: 'string', description: 'Deutsche Bedeutung; mehrere Bedeutungen mit ; trennen' },
          notiz: { type: 'string', description: 'Kurze Zusatzinfo wie Plural oder unregelmäßig, sonst leer' }
        },
        required: ['it', 'de', 'notiz'],
        additionalProperties: false
      }
    }
  },
  required: ['titel', 'text', 'vokabeln'],
  additionalProperties: false
};

const PROMPT = `Das ist ein Foto einer Seite aus einem Italienisch-Lehrbuch für deutschsprachige Schüler.

1. Schreib den Text der Seite ab (Feld "text"), so wie er dasteht. Lass Seitenzahlen, Kopfzeilen und Bildunterschriften ohne Inhalt weg. Übungen mit Lücken übernimmst du mit "___" für die Lücke.
2. Sammle die Vokabeln der Seite (Feld "vokabeln"):
   - Steht auf der Seite eine Vokabelliste (italienisch – deutsch), übernimm genau diese Einträge.
   - Gibt es keine Liste, nimm die wichtigen neuen Wörter und Ausdrücke aus dem Text und übersetze sie selbst ins Deutsche.
   - Nomen immer mit bestimmtem Artikel (il libro, la casa, l'amico). Verben im Infinitiv.
3. Ist auf dem Foto kein Lehrbuchtext zu erkennen, gib leere Felder zurück.`;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Nur POST' }, 405);
  try {
    if (!Deno.env.get('ANTHROPIC_API_KEY')) return json({ error: 'ANTHROPIC_API_KEY fehlt in den Supabase-Secrets.' }, 500);
    if (!await userFromToken(req)) return json({ error: 'Nicht angemeldet' }, 401);
    const { image } = await req.json();
    if (typeof image !== 'string' || image.length < 100) return json({ error: 'Kein Bild bekommen' }, 400);
    if (image.length > 7_000_000) return json({ error: 'Bild zu groß' }, 413);

    const client = new Anthropic(); // liest ANTHROPIC_API_KEY
    const msg = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: PROMPT }
        ]
      }]
    } as any);

    if (msg.stop_reason === 'refusal') return json({ error: 'Die Seite konnte nicht ausgewertet werden.' }, 422);
    if (msg.stop_reason === 'max_tokens') return json({ error: 'Die Seite hat zu viel Text.' }, 422);
    const txt = (msg.content as any[]).filter(b => b.type === 'text').map(b => b.text).join('');
    const data = JSON.parse(txt);
    return json({ titel: data.titel || '', text: data.text || '', vokabeln: data.vokabeln || [] });
  } catch (e) {
    const status = (e as any)?.status;
    if (status === 401) return json({ error: 'Der Anthropic-API-Schlüssel stimmt nicht.' }, 500);
    if (status === 429) return json({ error: 'Gerade zu viele Anfragen, versuch es gleich nochmal.' }, 429);
    if (status === 400 && /credit/i.test(String((e as any)?.message))) return json({ error: 'Kein Guthaben mehr beim Anthropic-Konto.' }, 402);
    return json({ error: 'Erkennung fehlgeschlagen: ' + ((e as Error)?.message || e) }, 500);
  }
});
