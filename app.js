'use strict';
(() => {
  const CFG = window.APP_CONFIG || {};
  const STORE_KEY = 'italiano.v1';
  const AUTH_KEY = 'italiano.auth';
  const DAY = 86400000;
  // Lernsystem mit 5 Fächern (0–4):
  // richtig in Fach X → ein Fach hoch, nächste Abfrage in X+1 Tagen (Fach 4 bleibt Fach 4, 5 Tage)
  // falsch → ein Fach runter, kommt morgen wieder und ans Ende der laufenden Runde;
  // dort richtig → Fach bleibt, wieder falsch → Fach 1
  const MAX_BOX = 4;
  const MASTER_BOX = 4; // im obersten Fach gilt eine Vokabel als "sicher"
  const DIR_LABEL = { 'de-it': 'Deutsch → Italienisch', 'it-de': 'Italienisch → Deutsch' };

  // ================= Hilfsfunktionen =================
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const dateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = () => dateKey(new Date());
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ================= Daten =================
  const emptyState = () => ({
    cards: {},      // id -> {id, it, de, lesson, note, created, updated, deleted}
    progress: {},   // "id|dir" -> {box, due, seen, right, wrong, updated}
    days: {},       // "JJJJ-MM-TT" -> {reviews, correct, new}
    settings: { sessionSize: 20, lessons: [], dir: 'de-it', mode: 'mix' },
    exams: {},      // id -> {id, title, date, lessons, cardIds, dir, notify, target, reps, planCounts, created, updated, deleted}
    pages: {},      // id -> {id, lesson, order, created, updated, deleted}  (Buchseiten; die Bilder liegen in IndexedDB / Supabase Storage)
    seeded: false
  });

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.cards) {
        const base = emptyState();
        return { ...base, ...s, settings: { ...base.settings, ...(s.settings || {}) } };
      }
    } catch (e) { /* kaputte Daten ignorieren */ }
    return emptyState();
  }
  let state = load();
  // v1.3: altes System hatte 8 Fächer → alles über Fach 4 wird Fach 4
  for (const p of Object.values(state.progress)) if (p.box > MAX_BOX) p.box = MAX_BOX;

  function persist() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  function save() { persist(); Sync.schedule(); }

  function seed() {
    if (state.seeded) return;
    (window.STARTER_VOCAB || []).forEach((v, i) => {
      const id = 'start-' + i; // feste IDs, damit es geräteübergreifend keine Doppelten gibt
      if (!state.cards[id]) state.cards[id] = { id, it: v[0], de: v[1], lesson: v[2], note: v[3] || '', created: i, updated: 1 };
    });
    state.seeded = true;
    persist();
  }

  const activeCards = () => Object.values(state.cards).filter(c => !c.deleted);
  const pkey = (id, dir) => id + '|' + dir;
  const prog = (id, dir) => state.progress[pkey(id, dir)];

  function lessonMap() {
    const m = new Map();
    for (const c of activeCards()) {
      if (!m.has(c.lesson)) m.set(c.lesson, []);
      m.get(c.lesson).push(c);
    }
    return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de', { numeric: true })));
  }

  // Buchseiten
  const activePages = () => Object.values(state.pages || {}).filter(p => !p.deleted);
  const lessonPages = l => activePages().filter(p => p.lesson === l).sort((a, b) => (a.order - b.order) || (a.created - b.created));
  // Alle Lektionen: mit Vokabeln und/oder Buchseiten
  function allLessons() {
    const s = new Set([...lessonMap().keys(), ...activePages().map(p => p.lesson)]);
    return [...s].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
  }

  function dayStats(key = today()) {
    if (!state.days[key]) state.days[key] = { reviews: 0, correct: 0, new: 0 };
    return state.days[key];
  }

  function streak() {
    let n = 0;
    const d = new Date();
    if (!(state.days[dateKey(d)]?.reviews > 0)) d.setDate(d.getDate() - 1); // heute noch nicht gelernt → ab gestern zählen
    while (state.days[dateKey(d)]?.reviews > 0) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  const dirsFor = dir => dir === 'both' ? ['de-it', 'it-de'] : [dir];

  // Fällige und neue Abfragen für eine Auswahl von Lektionen
  function pool(lessons, dir) {
    const t = now(), due = [], fresh = [];
    const want = lessons && lessons.length ? new Set(lessons) : null;
    for (const c of activeCards()) {
      if (want && !want.has(c.lesson)) continue;
      for (const d of dirsFor(dir)) {
        const p = prog(c.id, d);
        if (!p || !p.seen) fresh.push({ card: c, dir: d });
        else if (p.due <= t) due.push({ card: c, dir: d, due: p.due });
      }
    }
    due.sort((a, b) => a.due - b.due);
    return { due, fresh };
  }


  function grade(card, dir, correct) {
    const k = pkey(card.id, dir);
    const p = state.progress[k] || { box: 0, seen: 0, right: 0, wrong: 0 };
    const ds = dayStats();
    if (!p.seen) ds.new++;
    ds.reviews++;
    if (correct) {
      ds.correct++;
      p.right++;
      const from = Math.min(p.box, MAX_BOX);
      p.due = startOfToday() + (from + 1) * DAY;
      p.box = Math.min(from + 1, MAX_BOX);
    } else {
      p.wrong++;
      p.box = Math.max(Math.min(p.box, MAX_BOX) - 1, 0);
      p.due = startOfToday() + DAY;
    }
    p.seen++;
    p.updated = now();
    state.progress[k] = p;
    ds.updated = now();
  }

  function masteredShare(cards) {
    let total = 0, ok = 0;
    for (const c of cards) for (const d of ['de-it', 'it-de']) {
      total++;
      const p = prog(c.id, d);
      if (p && p.box >= 2) ok++;
    }
    return total ? ok / total : 0;
  }

  const newer = (a, b) => !a ? b : !b ? a : ((b.updated || 0) > (a.updated || 0) ? b : a);
  function mergeStates(local, remote) {
    const out = { ...local, cards: { ...local.cards }, progress: { ...local.progress }, days: { ...local.days } };
    for (const [k, v] of Object.entries(remote.cards || {})) out.cards[k] = newer(out.cards[k], v);
    for (const [k, v] of Object.entries(remote.progress || {})) out.progress[k] = newer(out.progress[k], v);
    for (const [k, v] of Object.entries(remote.days || {})) {
      const l = out.days[k] || {};
      out.days[k] = {
        reviews: Math.max(l.reviews || 0, v.reviews || 0),
        correct: Math.max(l.correct || 0, v.correct || 0),
        new: Math.max(l.new || 0, v.new || 0),
        updated: Math.max(l.updated || 0, v.updated || 0)
      };
    }
    out.exams = { ...(local.exams || {}) };
    for (const [k, v] of Object.entries(remote.exams || {})) out.exams[k] = newer(out.exams[k], v);
    out.pages = { ...(local.pages || {}) };
    for (const [k, v] of Object.entries(remote.pages || {})) out.pages[k] = newer(out.pages[k], v);
    out.seeded = local.seeded || remote.seeded;
    return out;
  }

  // ================= Antwort prüfen =================
  const norm = s => String(s || '').toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[.!?¡¿"„“”…]/g, '')
    .replace(/\s+/g, ' ').trim();
  const noAccent = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const variants = a => String(a).split(/\s*;\s*/).map(norm).filter(Boolean);
  const IT_ART = /^(?:(?:il|lo|la|i|gli|le|un|uno|una)\s+|l'\s*|un'\s*)/;
  const DE_ART = /^(?:der|die|das|den|dem|des|ein|eine|einen|einem)\s+/;

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  }

  // Ergebnis: {ok, hint}
  function checkAnswer(input, answer, lang) {
    const inp = norm(input);
    if (!inp) return { ok: false };
    const art = lang === 'it' ? IT_ART : DE_ART;
    for (const v of variants(answer)) {
      if (inp === v) return { ok: true };
      const vBare = v.replace(art, ''), iBare = inp.replace(art, '');
      const inpHasArt = iBare !== inp;
      // Artikel weggelassen
      if (iBare === vBare && (!inpHasArt || lang === 'de')) {
        return { ok: true, hint: lang === 'it' && vBare !== v ? `Merk dir den Artikel: ${v}` : '' };
      }
      // nur Akzent falsch
      if (noAccent(inp) === noAccent(v) || (noAccent(iBare) === noAccent(vBare) && !inpHasArt)) {
        return { ok: true, hint: `${lang === 'it' ? 'Achte auf den Akzent' : 'Achte auf die Schreibweise'}: ${v}` };
      }
    }
    for (const v of variants(answer)) {
      if (v.length >= 4 && lev(noAccent(inp), noAccent(v)) === 1) return { ok: false, close: true };
    }
    return { ok: false };
  }

  // ================= Sprachausgabe =================
  function speak(text) {
    if (!('speechSynthesis' in window)) return toast('Sprachausgabe nicht verfügbar');
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/;/g, ', ').replace(/…/g, ''));
    u.lang = 'it-IT';
    u.rate = 0.9;
    const v = speechSynthesis.getVoices().find(v => v.lang && v.lang.toLowerCase().startsWith('it'));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  // ================= Sync (Supabase) =================
  const Sync = (() => {
    const url = (CFG.supabaseUrl || '').replace(/\/+$/, '');
    const key = CFG.supabaseKey || '';
    const configured = !!(url && key);
    let auth = null;
    try { auth = JSON.parse(localStorage.getItem(AUTH_KEY)); } catch (e) { auth = null; }
    let status = configured ? (auth ? 'idle' : 'off') : 'off';
    let error = '', lastSync = +localStorage.getItem('italiano.lastSync') || 0;
    let running = false, again = false, timer = null;

    const errText = d => {
      const m = d?.error_description || d?.msg || d?.message || d?.error || 'Unbekannter Fehler';
      if (/invalid login/i.test(m)) return 'E-Mail oder Passwort falsch.';
      if (/not confirmed/i.test(m)) return 'E-Mail noch nicht bestätigt. Schau in dein Postfach.';
      if (/already registered/i.test(m)) return 'Für diese E-Mail gibt es schon ein Konto. Melde dich an.';
      if (/password should be/i.test(m)) return 'Passwort zu kurz (mind. 6 Zeichen).';
      return m;
    };

    function setAuth(d) {
      auth = {
        access_token: d.access_token, refresh_token: d.refresh_token,
        expires_at: now() + (d.expires_in || 3600) * 1000,
        user: { id: d.user.id, email: d.user.email }
      };
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    }

    async function authCall(path, body) {
      const r = await fetch(url + '/auth/v1/' + path, {
        method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(errText(d));
      return d;
    }

    async function token() {
      if (!auth) return null;
      if (now() > auth.expires_at - 60000) {
        try { setAuth(await authCall('token?grant_type=refresh_token', { refresh_token: auth.refresh_token })); }
        catch (e) { signOut(); throw new Error('Anmeldung abgelaufen. Bitte neu anmelden.'); }
      }
      return auth.access_token;
    }

    async function signIn(email, password) {
      setAuth(await authCall('token?grant_type=password', { email, password }));
      status = 'idle'; error = '';
      await run();
    }

    async function signUp(email, password) {
      const d = await authCall('signup', { email, password });
      if (d.access_token) { setAuth(d); status = 'idle'; await run(); return 'Konto erstellt und angemeldet.'; }
      return 'Konto erstellt. Bestätige den Link in deiner E-Mail und melde dich dann hier an.';
    }

    function signOut() {
      auth = null;
      localStorage.removeItem(AUTH_KEY);
      status = 'off';
      paint();
    }

    function merge(local, remote) { return mergeStates(local, remote); }

    async function run() {
      if (!configured || !auth) return;
      if (!navigator.onLine) { status = 'offline'; paint(); return; }
      if (running) { again = true; return; }
      running = true; status = 'busy'; paint();
      try {
        const t = await token();
        const headers = { apikey: key, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
        const r = await fetch(url + '/rest/v1/lernstand?select=data', { headers });
        if (!r.ok) throw new Error(errText(await r.json().catch(() => ({}))));
        const rows = await r.json();
        if (rows[0]?.data) {
          state = merge(state, rows[0].data);
          persist();
        }
        for (const e of Exams.upcoming()) e.planCounts = Exams.planCounts(e); // für die Termin-Mitteilung am Server
        const body = { user_id: auth.user.id, data: { ...state, settings: undefined }, updated_at: new Date().toISOString() };
        const w = await fetch(url + '/rest/v1/lernstand', {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(body)
        });
        if (!w.ok) throw new Error(errText(await w.json().catch(() => ({}))));
        lastSync = now();
        localStorage.setItem('italiano.lastSync', lastSync);
        status = 'ok'; error = '';
        Pages.syncFiles(); // Fotos im Hintergrund hoch-/runterladen
        if (!Session.active() && (route === 'home' || route === 'learn')) render(); // neue Daten anzeigen, aber keine Abfrage unterbrechen
      } catch (e) {
        status = auth ? 'err' : 'off';
        error = e.message || String(e);
      } finally {
        running = false;
        paint();
        if (again) { again = false; schedule(500); }
      }
    }

    function schedule(ms = 2500) {
      if (!configured || !auth) return;
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    }

    function paint() {
      const dot = $('#syncDot');
      if (!dot) return;
      dot.className = 'sync-dot ' + ({ ok: 'ok', idle: 'ok', busy: 'busy', err: 'err' }[status] || '');
      dot.title = info().text;
      if (route === 'more') { const el = $('#syncInfo'); if (el) el.innerHTML = esc(info().text); }
    }

    function info() {
      if (!configured) return { text: 'Sync ist noch nicht eingerichtet.' };
      if (!auth) return { text: 'Nicht angemeldet: Fortschritt bleibt nur auf diesem Gerät.' };
      if (status === 'busy') return { text: 'Synchronisiere …' };
      if (status === 'err') return { text: 'Fehler: ' + error };
      if (status === 'offline') return { text: 'Offline: wird synchronisiert, sobald du wieder online bist.' };
      return { text: lastSync ? 'Synchronisiert ' + new Date(lastSync).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'Angemeldet.' };
    }

    return { configured, run, schedule, signIn, signUp, signOut, paint, info, token, url, key, user: () => auth?.user };
  })();


  // ================= Buchseiten (Fotos) =================
  // Bilder liegen lokal in IndexedDB (offline) und, wenn angemeldet, im privaten Supabase-Bucket "seiten".
  // Die Liste der Seiten (Lektion, Reihenfolge) steckt im normalen Lernstand und wird mit ihm synchronisiert.
  const Pages = (() => {
    const BUCKET = 'seiten';
    const UP_KEY = 'italiano.pagesUp';
    let dbp = null;
    const urls = new Map(); // id+kind -> objectURL
    let uploaded = new Set();
    try { uploaded = new Set(JSON.parse(localStorage.getItem(UP_KEY) || '[]')); } catch (e) { /* egal */ }
    const saveUp = () => localStorage.setItem(UP_KEY, JSON.stringify([...uploaded]));
    let busy = false, again = false, lastError = '';

    function db() {
      if (!dbp) dbp = new Promise((res, rej) => {
        const r = indexedDB.open('italiano-seiten', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('img');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    async function tx(mode, fn) {
      const d = await db();
      return new Promise((res, rej) => {
        const t = d.transaction('img', mode);
        const req = fn(t.objectStore('img'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('Speichern abgebrochen (Speicher voll?)'));
      });
    }
    const getLocal = id => tx('readonly', s => s.get(id));
    const putLocal = (id, v) => tx('readwrite', s => s.put(v, id));
    const delLocal = id => tx('readwrite', s => s.delete(id));

    function loadImg(file) {
      return new Promise((res, rej) => {
        const u = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(u); res(img); };
        img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Bild konnte nicht gelesen werden')); };
        img.src = u;
      });
    }
    function scaled(img, max, q) {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      return new Promise(res => c.toBlob(res, 'image/jpeg', q));
    }
    // Foto verkleinern: groß genug zum Lesen, klein genug zum Speichern (~300–500 KB)
    async function compress(file) {
      const img = await loadImg(file);
      return { full: await scaled(img, 2000, 0.8), thumb: await scaled(img, 420, 0.7) };
    }

    async function add(files, lesson) {
      let order = Math.max(0, ...lessonPages(lesson).map(p => p.order || 0));
      let n = 0;
      const ids = [];
      for (const f of files) {
        if (!f.type.startsWith('image/') && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) continue;
        const id = uid(), t = now();
        await putLocal(id, await compress(f));
        state.pages[id] = { id, lesson, order: ++order, created: t + n, updated: t };
        ids.push(id);
        n++;
      }
      save();
      recognizeLater(ids);
      return n;
    }

    function remove(id) {
      const p = state.pages[id];
      if (!p) return;
      p.deleted = true; p.updated = now();
      save();
    }

    // Bild-URL für die Anzeige (lokal, sonst aus Supabase laden)
    async function url(id, kind = 'thumb') {
      const k = id + '|' + kind;
      if (urls.has(k)) return urls.get(k);
      let v = await getLocal(id).catch(() => null);
      if (!v) v = await download(id);
      if (!v) return null;
      const u = URL.createObjectURL(v[kind] || v.full);
      urls.set(k, u);
      return u;
    }

    const objUrl = id => `${Sync.url}/storage/v1/object/${BUCKET}/${Sync.user().id}/${id}.jpg`;
    async function headers() { return { apikey: Sync.key, Authorization: 'Bearer ' + await Sync.token() }; }

    const loading = new Map();
    function download(id) {
      if (!Sync.user() || !navigator.onLine) return Promise.resolve(null);
      if (loading.has(id)) return loading.get(id);
      const pr = (async () => {
        try {
          const r = await fetch(`${Sync.url}/storage/v1/object/authenticated/${BUCKET}/${Sync.user().id}/${id}.jpg`, { headers: await headers() });
          if (!r.ok) return null;
          const img = await loadImg(await r.blob());
          const v = { full: await scaled(img, 2000, 0.85), thumb: await scaled(img, 420, 0.7) };
          await putLocal(id, v);
          uploaded.add(id); saveUp();
          return v;
        } catch (e) { return null; } finally { loading.delete(id); }
      })();
      loading.set(id, pr);
      return pr;
    }

    // Abgleich mit Supabase Storage: neue Fotos hoch, gelöschte entfernen
    async function syncFiles() {
      if (!Sync.user() || !navigator.onLine) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        for (const p of Object.values(state.pages || {})) {
          if (p.deleted) {
            if (uploaded.has(p.id)) {
              const r = await fetch(objUrl(p.id), { method: 'DELETE', headers: await headers() });
              if (r.ok || r.status === 404 || r.status === 400) { uploaded.delete(p.id); saveUp(); }
            }
            const k = await getLocal(p.id).catch(() => null);
            if (k) await delLocal(p.id);
            continue;
          }
          if (uploaded.has(p.id)) continue;
          const v = await getLocal(p.id).catch(() => null);
          if (!v) continue; // liegt auf einem anderen Gerät, wird beim Anschauen geladen
          const r = await fetch(objUrl(p.id), { method: 'POST', headers: { ...await headers(), 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, body: v.full });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(/bucket not found/i.test(d.message || d.error || '') ? 'Foto-Speicher fehlt in Supabase (seiten-setup.sql ausführen).' : (d.message || d.error || 'Foto-Upload fehlgeschlagen'));
          }
          uploaded.add(p.id); saveUp();
        }
        lastError = '';
      } catch (e) {
        lastError = e.message || String(e);
      } finally {
        busy = false;
        if (route === 'pages' || route === 'more') { const el = $('#pagesInfo'); if (el) el.textContent = info(); }
        if (again) { again = false; syncFiles(); }
      }
    }

    // Text und Vokabeln erkennen lassen (Supabase-Funktion "erkennen" → Claude)
    const recognizing = new Set();
    const toB64 = blob => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
    async function recognize(id) {
      const p = state.pages[id];
      if (!p || recognizing.has(id)) return;
      if (!Sync.user()) throw new Error('Zum Erkennen musst du in den Einstellungen angemeldet sein.');
      recognizing.add(id);
      refreshPage(id);
      try {
        let v = await getLocal(id).catch(() => null);
        if (!v) v = await download(id);
        if (!v) throw new Error('Foto nicht gefunden');
        const r = await fetch(Sync.url + '/functions/v1/erkennen', {
          method: 'POST',
          headers: { ...await headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: await toB64(v.full) })
        });
        const d = await r.json().catch(() => ({}));
        if (r.status === 404) throw new Error('Die Erkennung ist in Supabase noch nicht eingerichtet (Funktion „erkennen“).');
        if (!r.ok) throw new Error(d.error || d.message || 'Erkennung fehlgeschlagen');
        p.ocr = { titel: d.titel || '', text: d.text || '', vokabeln: d.vokabeln || [], at: now() };
        delete p.ocrError;
        p.updated = now();
        save();
      } catch (e) {
        p.ocrError = e.message || String(e);
        throw e;
      } finally {
        recognizing.delete(id);
        refreshPage(id);
      }
    }
    // Neu fotografierte Seiten nacheinander im Hintergrund erkennen
    let queue = Promise.resolve();
    function recognizeLater(ids) {
      if (!Sync.user()) return;
      for (const id of ids) queue = queue.then(() => recognize(id).catch(e => toast(e.message)));
    }
    function refreshPage(id) { if ((route === 'page' && ui.pageId === id) || route === 'pages') render(); }

    function info() {
      const list = activePages();
      if (!list.length) return '';
      if (!Sync.user()) return 'Nicht angemeldet: Fotos sind nur auf diesem Gerät.';
      if (lastError) return 'Fotos: ' + lastError;
      const open = list.filter(p => !uploaded.has(p.id)).length;
      return open ? `${plural(open, 'Foto wird', 'Fotos werden')} noch hochgeladen …` : 'Alle Fotos sind gesichert.';
    }

    return { add, remove, url, syncFiles, info, recognize, recognizeLater, isRecognizing: id => recognizing.has(id) };
  })();

  // Bilder in <img data-page="id" data-kind="thumb|full"> nachladen
  function fillImages(root = document) {
    for (const img of $$('img[data-page]', root)) {
      if (img.src) continue;
      Pages.url(img.dataset.page, img.dataset.kind || 'thumb').then(u => {
        if (u) img.src = u; else img.closest('.page-thumb, .page-view')?.classList.add('missing');
      });
    }
  }

  // ================= Mitteilungen (Web Push) =================
  const Push = (() => {
    const PREF_KEY = 'italiano.push';
    const fn = () => Sync.url + '/functions/v1/mitteilungen';
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const prefs = () => ({ daily: true, streak: true, ...(JSON.parse(localStorage.getItem(PREF_KEY) || '{}')) });
    const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'; } catch (e) { return 'Europe/Berlin'; } };
    const toBytes = s => { const p = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(p + '='.repeat((4 - p.length % 4) % 4)), c => c.charCodeAt(0)); };

    async function current() {
      if (!supported) return null;
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? reg.pushManager.getSubscription() : null;
    }

    async function rest(path, init = {}) {
      const t = await Sync.token();
      const r = await fetch(Sync.url + '/rest/v1/' + path, {
        ...init, headers: { apikey: Sync.key, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(init.headers || {}) }
      });
      if (!r.ok) throw new Error('Speichern fehlgeschlagen (' + r.status + ')');
    }

    async function save(sub) {
      const j = sub.toJSON(), p = prefs();
      await rest('push_abos', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, tz: tz(), daily: p.daily, streak: p.streak, user_id: Sync.user().id })
      });
    }

    async function enable() {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Mitteilungen wurden nicht erlaubt.');
      const r = await fetch(fn() + '?action=key', { headers: { apikey: Sync.key, Authorization: 'Bearer ' + (await Sync.token()) } });
      const { publicKey, error } = await r.json();
      if (!publicKey) throw new Error(error || 'Server nicht erreichbar.');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
      await save(sub);
    }

    async function disable() {
      const sub = await current();
      if (!sub) return;
      await rest('push_abos?endpoint=eq.' + encodeURIComponent(sub.endpoint), { method: 'DELETE' }).catch(() => {});
      await sub.unsubscribe();
    }

    async function setPref(k, v) {
      localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), [k]: v }));
      const sub = await current();
      if (sub) await save(sub);
    }

    async function test() {
      const t = await Sync.token();
      const r = await fetch(fn() + '?action=test', { method: 'POST', headers: { apikey: Sync.key, Authorization: 'Bearer ' + t } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Fehler ' + r.status);
      return d.sent;
    }

    // Beim Start: Abo still auffrischen (Zeitzone, neuer Endpoint)
    async function refresh() {
      try { if (Sync.user() && supported && Notification.permission === 'granted') { const s = await current(); if (s) await save(s); } } catch (e) { /* egal */ }
    }

    async function paint() {
      const box = $('#pushBox');
      if (!box) return;
      const p = prefs();
      let html;
      if (!Sync.configured || !Sync.user()) {
        html = `<p class="small muted" style="margin:0">Melde dich oben an, dann kannst du Mitteilungen einschalten.</p>`;
      } else if (!supported) {
        html = isIOS && !standalone
          ? `<p class="small" style="margin:0">Auf iPhone und iPad gehen Mitteilungen nur in der <b>installierten App</b>: In Safari → Teilen → „Zum Home-Bildschirm“, dann die App vom Home-Bildschirm öffnen und hier einschalten.</p>`
          : `<p class="small muted" style="margin:0">Dieser Browser kann keine Mitteilungen empfangen.</p>`;
      } else if (Notification.permission === 'denied') {
        html = `<p class="small" style="margin:0">Mitteilungen sind blockiert. Erlaube sie in den Einstellungen deines Geräts bzw. Browsers für Avanti.</p>`;
      } else if (!(await current())) {
        html = `<p class="small muted" style="margin-top:0">Erinnerung um 7:00 Uhr, wenn Vokabeln fällig sind, und um 20:00 Uhr, wenn dein Streak in Gefahr ist.</p>
          <button class="btn primary block" data-action="push-on">🔔 Mitteilungen einschalten</button>`;
      } else {
        html = `
          <label class="check"><input type="checkbox" data-pref="daily" ${p.daily ? 'checked' : ''}><span><b>Tägliche Erinnerung</b><br><span class="small muted">um 7:00 Uhr, wenn Vokabeln fällig sind</span></span></label>
          <label class="check"><input type="checkbox" data-pref="streak" ${p.streak ? 'checked' : ''}><span><b>Streak-Warnung</b><br><span class="small muted">um 20:00 Uhr, wenn du heute noch nicht gelernt hast</span></span></label>
          <div class="row" style="margin-top:12px"><button class="btn spacer" data-action="push-test">Test senden</button><button class="btn" data-action="push-off">Ausschalten</button></div>`;
      }
      box.innerHTML = html;
      $$('[data-pref]', box).forEach(cb => cb.addEventListener('change', async () => {
        try { await setPref(cb.dataset.pref, cb.checked); toast('Gespeichert'); } catch (e) { toast(e.message); }
      }));
    }

    return { enable, disable, test, refresh, paint };
  })();

  // ================= Abfrage-Session =================
  const Session = (() => {
    let S = null;

    function start(items, opts = {}) {
      if (!items.length) { toast('Gerade nichts zu lernen 🎉'); return; }
      S = {
        queue: items.map(it => ({ ...it, mode: pickMode(it, opts.mode) })),
        total: items.length,
        done: new Set(),
        results: [],
        phase: 'ask',
        cur: null,
        practice: !!opts.practice,
        exam: opts.exam || null,
        random: !!opts.random,
        mode: opts.mode
      };
      document.body.classList.add('in-session');
      next();
    }

    function pickMode(it, mode) {
      if (mode === 'mix') {
        const p = prog(it.card.id, it.dir);
        return (!p || p.box < 2) ? 'choice' : 'type';
      }
      return mode;
    }

    function next() {
      if (!S.queue.length) { S.phase = 'end'; draw(); return; }
      const it = S.queue[0];
      S.cur = { ...it, answered: false, ok: null, input: '', hint: '', close: false };
      if (it.mode === 'choice') {
        S.cur.options = buildOptions(it);
        if (!S.cur.options) S.cur.mode = 'type';
      }
      S.phase = 'ask';
      draw();
    }

    const answerOf = it => it.dir === 'de-it' ? it.card.it : it.card.de;
    const promptOf = it => it.dir === 'de-it' ? it.card.de : it.card.it;

    function buildOptions(it) {
      const right = answerOf(it);
      const seen = new Set([norm(right)]);
      const pick = list => {
        const out = [];
        for (const c of shuffle(list.slice())) {
          const a = it.dir === 'de-it' ? c.it : c.de;
          if (seen.has(norm(a))) continue;
          seen.add(norm(a)); out.push(a);
          if (out.length === 3) break;
        }
        return out;
      };
      const all = activeCards().filter(c => c.id !== it.card.id);
      let opts = pick(all.filter(c => c.lesson === it.card.lesson));
      if (opts.length < 3) opts = opts.concat(pick(all)).slice(0, 3);
      if (opts.length < 2) return null;
      return shuffle([right, ...opts]);
    }

    function answer(ok, extra = {}) {
      Object.assign(S.cur, { answered: true, ok }, extra);
      S.phase = 'answered';
      draw();
    }

    function commitAndNext() {
      const it = S.queue.shift();
      const k = pkey(it.card.id, it.dir);
      if (!S.done.has(k)) {
        S.done.add(k);
        const p = prog(it.card.id, it.dir);
        if (S.random && p && p.seen) {
          // Zufällig üben: richtig → nichts ändert sich, falsch → Fach 1, morgen wieder
          const ds = dayStats(); ds.reviews++; ds.updated = now();
          if (S.cur.ok) ds.correct++;
          else { p.box = 1; p.due = startOfToday() + DAY; p.wrong++; p.seen++; p.updated = now(); }
        }
        else if (S.practice && S.cur.ok && p && p.seen && p.due > now()) { const ds = dayStats(); ds.reviews++; ds.correct++; ds.updated = now(); }
        else grade(it.card, it.dir, S.cur.ok);
        S.results.push({ card: it.card, dir: it.dir, ok: S.cur.ok });
        if (S.exam && state.exams[S.exam]) Exams.record(state.exams[S.exam], it.card.id, S.cur.ok);
        save();
      } else if (!S.cur.ok) {
        // Wiederholung am Rundenende wieder falsch → Fach 1 (richtig bei der Wiederholung → Fach bleibt)
        const p = state.progress[k];
        if (p) { p.box = 1; p.due = startOfToday() + DAY; p.updated = now(); save(); }
      }
      if (!S.cur.ok) {
        // Falsche Vokabel kommt ganz ans Ende der Runde, bis sie sitzt
        S.queue.push({ ...it });
      }
      next();
    }

    function stop() {
      const exam = S && S.exam;
      S = null;
      document.body.classList.remove('in-session');
      if (exam && state.exams[exam]) go('exam', { examId: exam }); else go('home');
    }

    function draw() {
      setTitle(S.phase === 'end' ? 'Geschafft!' : 'Abfrage');
      const v = $('#view');
      if (S.phase === 'end') return drawEnd(v);
      const it = S.cur;
      const pct = Math.round(S.done.size / S.total * 100);
      const ansLang = it.dir === 'de-it' ? 'it' : 'de';
      const isNew = !prog(it.card.id, it.dir)?.seen;
      const promptIsIt = it.dir === 'it-de';
      let body = '';

      if (it.mode === 'flip') {
        body = it.answered ? '' : `<button class="btn primary block big" data-action="s-reveal">Aufdecken</button>`;
      } else if (it.mode === 'type') {
        body = `
          <input class="answer-input" id="answer" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
            lang="${ansLang}" placeholder="${ansLang === 'it' ? 'auf Italienisch …' : 'auf Deutsch …'}" value="${esc(it.input)}" ${it.answered ? 'readonly' : ''}>
          ${ansLang === 'it' && !it.answered ? `<div class="accents">${['à', 'è', 'é', 'ì', 'ò', 'ù'].map(a => `<button data-action="s-accent" data-ch="${a}">${a}</button>`).join('')}</div>` : ''}
          ${it.answered ? '' : `<div class="row" style="margin-top:12px"><button class="btn" data-action="s-skip">Weiß ich nicht</button><button class="btn primary spacer" data-action="s-check">Prüfen</button></div>`}`;
      } else if (it.mode === 'choice') {
        const right = answerOf(it);
        body = `<div class="choices">${it.options.map((o, i) => {
          let cls = '';
          if (it.answered) { if (o === right) cls = 'right'; else if (o === it.input) cls = 'wrong'; }
          return `<button class="choice ${cls}" data-action="s-choose" data-i="${i}" ${it.answered ? 'disabled' : ''}>${esc(o)}</button>`;
        }).join('')}</div>`;
      }

      let fb = '';
      if (it.answered && it.mode !== 'flip') {
        const sol = answerOf(it);
        fb = it.ok
          ? `<div class="feedback ok"><div class="title">Richtig!</div>${it.hint ? `<div>${esc(it.hint)}</div>` : ''}${it.mode !== 'choice' && norm(it.input) !== norm(sol) ? `<div class="small muted">Lösung: ${esc(sol)}</div>` : ''}</div>`
          : `<div class="feedback bad"><div class="title">${it.close ? 'Fast! Kleiner Fehler.' : 'Leider falsch'}</div><div class="solution">${esc(sol)}</div>
              ${it.mode === 'type' && it.input ? `<button class="btn small" style="margin-top:8px" data-action="s-override">Ich hatte recht</button>` : ''}</div>`;
      }

      let actions = '';
      if (it.answered) {
        actions = it.mode === 'flip'
          ? `<div class="grade-row"><button class="btn bad big" data-action="s-grade" data-ok="0">Nicht gewusst</button><button class="btn good big" data-action="s-grade" data-ok="1">Gewusst</button></div>`
          : `<button class="btn primary block big" data-action="s-next" id="nextBtn">Weiter</button>`;
      }

      v.innerHTML = `
        <div class="session-top">
          <button class="icon-btn" data-action="s-stop" aria-label="Beenden">✕</button>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <span class="small muted">${S.done.size}/${S.total}</span>
        </div>
        <div class="card prompt-card">
          <div class="prompt-label">${DIR_LABEL[it.dir]}${isNew ? '<span class="new-badge">NEU</span>' : ''}</div>
          <div class="prompt">${esc(promptOf(it))}</div>
          ${it.card.note && (it.answered || it.dir === 'de-it') ? `<div class="prompt-note">${esc(it.card.note)}</div>` : ''}
          ${promptIsIt ? `<button class="speak" data-action="speak" data-text="${esc(it.card.it)}" aria-label="Vorlesen">🔊</button>` : ''}
          ${it.mode === 'flip' && it.answered ? `<div class="reveal">${esc(answerOf(it))}
            ${!promptIsIt ? `<div><button class="speak" data-action="speak" data-text="${esc(it.card.it)}">🔊</button></div>` : ''}</div>` : ''}
        </div>
        ${body}
        ${fb}
        ${it.answered && it.mode !== 'flip' && !promptIsIt ? `<div style="text-align:center;margin-bottom:12px"><button class="btn small" data-action="speak" data-text="${esc(it.card.it)}">🔊 Anhören</button></div>` : ''}
        ${actions}`;

      const inp = $('#answer');
      if (inp && !it.answered) {
        inp.focus();
        inp.addEventListener('input', () => { S.cur.input = inp.value; });
      } else if ($('#nextBtn')) {
        $('#nextBtn').focus({ preventScroll: true });
      }
    }

    function drawEnd(v) {
      const right = S.results.filter(r => r.ok).length;
      const wrong = S.results.filter(r => !r.ok);
      const pct = S.results.length ? Math.round(right / S.results.length * 100) : 0;
      v.innerHTML = `
        <div class="card" style="text-align:center">
          <div class="result-big">${pct}%</div>
          <div class="muted">${right} von ${S.results.length} beim ersten Versuch richtig</div>
          <div class="small muted" style="margin-top:6px">🔥 Streak: ${plural(streak(), 'Tag', 'Tage')}</div>
        </div>
        ${wrong.length ? `<div class="card"><h2>Üben solltest du noch</h2>
          ${wrong.map(r => `<div class="vocab-item" style="cursor:default"><div class="spacer"><div class="it">${esc(r.card.it)}</div><div class="de">${esc(r.card.de)}</div></div></div>`).join('')}
        </div>` : ''}
        <div class="row">
          ${wrong.length ? `<button class="btn spacer" data-action="s-again">Falsche nochmal</button>` : ''}
          <button class="btn primary spacer" data-action="s-stop">Fertig</button>
        </div>`;
      S.lastWrong = wrong.map(r => ({ card: r.card, dir: r.dir }));
    }

    // Aktionen aus der Oberfläche
    const actions = {
      's-reveal': () => answer(null),
      's-grade': el => { S.cur.ok = el.dataset.ok === '1'; commitAndNext(); },
      's-check': () => {
        const inp = $('#answer');
        const val = inp ? inp.value : S.cur.input;
        if (!norm(val)) { toast('Erst etwas eintippen – oder „Weiß ich nicht“'); return; }
        const r = checkAnswer(val, answerOf(S.cur), S.cur.dir === 'de-it' ? 'it' : 'de');
        answer(r.ok, { input: val, hint: r.hint || '', close: !!r.close });
      },
      's-skip': () => answer(false, { input: '' }),
      's-accent': el => {
        const inp = $('#answer');
        const s = inp.selectionStart ?? inp.value.length, e = inp.selectionEnd ?? s;
        inp.value = inp.value.slice(0, s) + el.dataset.ch + inp.value.slice(e);
        S.cur.input = inp.value;
        inp.focus();
        inp.setSelectionRange(s + 1, s + 1);
      },
      's-choose': el => {
        const o = S.cur.options[+el.dataset.i];
        const ok = norm(o) === norm(answerOf(S.cur));
        answer(ok, { input: o });
      },
      's-override': () => { S.cur.ok = true; S.cur.hint = 'Als richtig gewertet.'; S.cur.close = false; draw(); },
      's-next': () => commitAndNext(),
      's-stop': () => stop(),
      's-again': () => { const items = S.lastWrong, exam = S.exam, random = S.random, mode = S.mode || state.settings.mode; S = null; start(shuffle(items), { mode, exam, random, practice: !!exam || random }); }
    };

    function key(e) {
      if (!S) return;
      if (S.phase === 'end') return;
      const it = S.cur;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!it.answered) {
          if (it.mode === 'type') actions['s-check']();
          else if (it.mode === 'flip') actions['s-reveal']();
        } else if (it.mode !== 'flip') commitAndNext();
        return;
      }
      if (it.mode === 'flip') {
        if (e.key === ' ' && !it.answered) { e.preventDefault(); actions['s-reveal'](); }
        if (it.answered && (e.key === '1' || e.key === '2')) { it.ok = e.key === '2'; commitAndNext(); }
      }
      if (it.mode === 'choice' && !it.answered && /^[1-4]$/.test(e.key)) {
        const btn = $$('.choice')[+e.key - 1];
        if (btn) actions['s-choose'](btn);
      }
    }

    return { start, actions, key, active: () => !!S };
  })();


  // ================= Termine & Lernpläne =================
  // Datumsangaben als "JJJJ-MM-TT" (Ortszeit). dayDiff(a, b) = b − a in Tagen.
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAY);
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const fmtDate = (d, o = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(d + 'T12:00:00').toLocaleDateString('de-DE', o);
  // Wie oft jede Vokabel bis zum Termin drankommt (inkl. Generalprobe)
  const targetReps = days => days >= 10 ? 5 : days >= 6 ? 4 : days >= 3 ? 3 : Math.max(1, days);

  const Exams = {
    list: () => Object.values(state.exams || {}).filter(e => !e.deleted).sort((a, b) => a.date.localeCompare(b.date)),
    upcoming: () => Exams.list().filter(e => e.date >= today()),
    cards(e) {
      const ls = new Set(e.lessons || []), ids = new Set(e.cardIds || []);
      return activeCards().filter(c => ls.has(c.lesson) || ids.has(c.id))
        .sort((a, b) => a.lesson.localeCompare(b.lesson, 'de', { numeric: true }) || (a.created || 0) - (b.created || 0));
    },
    // Welche Vokabeln sind am Tag `day` dran? reps: {kartenId: {n, first, last, weak}}
    dayList(e, cards, reps, day) {
      const left = dayDiff(day, e.date); // Lerntage ab `day` bis zum Tag vor dem Termin
      if (left < 0) return { ids: [], final: false, fresh: 0 };
      const open = cards.filter(c => reps[c.id]?.last !== day);
      if (left <= 1) return { ids: open.map(c => c.id), final: true, fresh: open.filter(c => !reps[c.id]?.n).length };
      const T = e.target || 3;
      const fresh = open.filter(c => !reps[c.id]?.n);
      const introToday = cards.filter(c => reps[c.id]?.first === day).length;
      const introDays = Math.max(1, Math.min(left - (T - 1), Math.ceil(left / 2))); // neue Wörter in der ersten Hälfte, damit genug Wiederholungen passen
      const quota = Math.max(0, Math.ceil((fresh.length + introToday) / introDays) - introToday);
      const ids = fresh.slice(0, quota).map(c => c.id);
      for (const c of open) {
        const r = reps[c.id];
        if (!r || !r.n) continue;
        if (r.weak && r.last < day) { ids.push(c.id); continue; } // falsch gewusst → gleich am nächsten Tag
        if (r.n >= T) continue;
        const gap = Math.max(1, Math.floor(dayDiff(r.last, e.date) / (T - r.n)));
        if (dayDiff(r.last, day) >= gap) ids.push(c.id);
      }
      return { ids, final: false, fresh: Math.min(quota, fresh.length) };
    },
    todayList(e) { return Exams.dayList(e, Exams.cards(e), e.reps || {}, today()); },
    doneToday(e) { const t = today(); return Exams.cards(e).filter(c => e.reps?.[c.id]?.last === t).length; },
    // Plan ab heute simulieren (unter der Annahme, dass jeder Tag erledigt wird)
    plan(e) {
      const cards = Exams.cards(e), reps = JSON.parse(JSON.stringify(e.reps || {})), out = [], t = today();
      for (let d = t; d < e.date && out.length < 400; d = addDays(d, 1)) {
        const l = Exams.dayList(e, cards, reps, d);
        out.push({ date: d, count: l.ids.length, fresh: l.fresh, final: l.final, done: d === t ? Exams.doneToday(e) : 0 });
        for (const id of l.ids) { const r = reps[id] || (reps[id] = { n: 0 }); r.n++; r.first = r.first || d; r.last = d; r.weak = false; }
      }
      return out;
    },
    planCounts(e) {
      const k = dirsFor(e.dir || 'de-it').length;
      const out = Object.fromEntries(Exams.plan(e).map(p => [p.date, p.count * k]));
      if (e.date === today()) out[e.date] = Exams.todayList(e).ids.length * k;
      return out;
    },
    progress(e) {
      const cards = Exams.cards(e), T = e.target || 3;
      if (!cards.length) return 0;
      return cards.reduce((n, c) => n + Math.min(T, e.reps?.[c.id]?.n || 0), 0) / (cards.length * T);
    },
    record(e, cardId, ok) {
      const t = today();
      e.reps = e.reps || {};
      const r = e.reps[cardId] || (e.reps[cardId] = { n: 0 });
      if (r.last !== t) { r.n++; r.first = r.first || t; r.last = t; r.weak = !ok; }
      else if (!ok) r.weak = true;
      e.updated = now();
    }
  };

  function startExam(id) {
    const e = state.exams[id];
    if (!e) return;
    const ids = new Set(Exams.todayList(e).ids);
    const items = [];
    for (const c of Exams.cards(e)) if (ids.has(c.id)) for (const d of dirsFor(e.dir || 'de-it')) items.push({ card: c, dir: d });
    Session.start(shuffle(items), { mode: state.settings.mode, practice: true, exam: id });
  }

  function startLearning(lessons, opts = {}) {
    const st = state.settings;
    const dir = opts.dir || st.dir;
    const mode = opts.mode || st.mode;
    const { due, fresh } = pool(lessons, dir);
    let items;
    if (opts.random) {
      // Zufällig üben: nichts mehr fällig → zufällige Vokabeln aus der Auswahl
      const want = lessons && lessons.length ? new Set(lessons) : null;
      items = [];
      for (const c of activeCards()) if (!want || want.has(c.lesson)) for (const d of dirsFor(dir)) items.push({ card: c, dir: d });
      items = shuffle(items).slice(0, st.sessionSize);
    } else if (opts.practice) {
      // im Test-Modus: alle Vokabeln der Auswahl, egal ob fällig
      const want = lessons && lessons.length ? new Set(lessons) : null;
      items = [];
      for (const c of activeCards()) if (!want || want.has(c.lesson)) for (const d of dirsFor(dir)) items.push({ card: c, dir: d });
      shuffle(items);
    } else {
      // fällige zuerst, dann neue (Fach 0) – kein Tageslimit mehr
      items = due.concat(fresh).slice(0, st.sessionSize);
      if (!items.length && opts.randomIfDone) return startLearning(lessons, { ...opts, random: true });
      shuffle(items);
    }
    Session.start(items, { mode, practice: opts.practice || opts.random, random: opts.random });
  }

  // ================= Ansichten =================
  let route = 'home';
  let ui = { pagesLesson: '', pageId: null, pageZoom: false, pageTab: 'foto', pageVocabFor: null, pageVocabText: '', pageVocabLesson: '', vocabLesson: '', vocabSearch: '', editId: null, formLesson: '', importLesson: '', importText: '', examId: null, examDraft: null, examSearch: '' };

  function setTitle(t) { $('#title').textContent = t; document.title = t === 'Avanti Italiano' ? t : t + ' · Avanti Italiano'; }

  function go(r, params = {}) {
    route = r;
    Object.assign(ui, params);
    if (Session.active() && !r.startsWith('session')) { /* Session läuft weiter */ }
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    if (Session.active()) return; // Session zeichnet sich selbst
    const tab = { edit: 'vocab', import: 'vocab', pages: 'vocab', page: 'vocab', exam: 'exams', examEdit: 'exams' }[route] || route;
    $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.to === tab));
    const v = $('#view');
    const views = { home: viewHome, learn: viewLearn, vocab: viewVocab, edit: viewEdit, import: viewImport, more: viewMore, exams: viewExams, exam: viewExam, examEdit: viewExamEdit, pages: viewPages, page: viewPage };
    (views[route] || viewHome)(v);
    Sync.paint();
  }

  // ---------- Start ----------
  function viewHome(v) {
    setTitle('Avanti Italiano');
    const st = state.settings;
    const { due, fresh } = pool(st.lessons, st.dir);
    const newCount = fresh.length;
    const ds = state.days[today()] || { reviews: 0 };
    const cards = activeCards();
    let mastered = 0;
    for (const c of cards) for (const d of ['de-it', 'it-de']) if ((prog(c.id, d)?.box || 0) >= MASTER_BOX) mastered++;
    const lessons = lessonMap();
    const scope = st.lessons.length ? plural(st.lessons.length, 'Lektion', 'Lektionen') : 'alle Lektionen';
    const todo = Math.min(due.length + newCount, st.sessionSize);
    const anyCards = activeCards().some(c => !st.lessons.length || st.lessons.includes(c.lesson));

    v.innerHTML = `
      <div class="card hero">
        <div style="font-weight:600;margin-bottom:10px">Ciao${CFG.name ? ' ' + esc(CFG.name) : ''}! 👋</div>
        <div class="row" style="align-items:flex-end;gap:18px">
          <div><div class="big-num">${due.length}</div><div class="muted small">fällig</div></div>
          <div><div class="big-num" style="font-size:30px">${newCount}</div><div class="muted small">neu</div></div>
        </div>
        <div class="muted small" style="margin:10px 0 14px">${esc(scope)} · ${esc(DIR_LABEL[st.dir] || 'beide Richtungen')}</div>
        <div class="row">
          ${todo
            ? `<button class="btn big spacer" data-action="learn-now">Jetzt lernen (${todo})</button>`
            : anyCards
              ? `<button class="btn big spacer" data-action="learn-random">Alles gelernt ✓ · Zufällig üben 🎲</button>`
              : `<button class="btn big spacer" data-action="go" data-to="import">Vokabeln hinzufügen</button>`}
          <button class="btn big ghost" data-action="go" data-to="learn">Auswahl</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>🔥 ${streak()}</b><span>Tage Streak</span></div>
        <div class="stat"><b>${ds.reviews || 0}</b><span>Abfragen heute</span></div>
        <div class="stat"><b>${mastered}</b><span>sicher von ${cards.length * 2}</span></div>
      </div>
      ${Exams.upcoming().length ? `<div class="section-title">Nächste Termine</div>${Exams.upcoming().slice(0, 2).map(e => examCard(e)).join('')}` : ''}
      <div class="section-title">Lektionen</div>
      <div class="card">
        ${allLessons().length ? allLessons().map(name => {
          const list = lessons.get(name) || [];
          const pages = lessonPages(name).length;
          const p = pool([name], st.dir);
          const bits = [list.length ? plural(list.length, 'Vokabel', 'Vokabeln') : '', pages ? plural(pages, 'Buchseite', 'Buchseiten') : ''].filter(Boolean).join(' · ');
          return `<div class="lesson">
            <div class="info">
              <div class="name">${esc(name)}</div>
              <div class="small muted">${bits}${p.due.length ? ` · <b style="color:var(--green)">${p.due.length} fällig</b>` : ''}</div>
              ${list.length ? `<div class="bar"><i style="width:${Math.round(masteredShare(list) * 100)}%"></i></div>` : ''}
            </div>
            ${pages ? `<button class="btn small ghost" data-action="pages-open" data-lesson="${esc(name)}" aria-label="Buchseiten">📖</button>` : ''}
            ${list.length ? `<button class="btn small" data-action="learn-lesson" data-lesson="${esc(name)}">Lernen</button>` : ''}
          </div>`;
        }).join('') : `<div class="empty">Noch keine Vokabeln. <a href="#" data-action="go" data-to="import">Liste importieren</a> oder <a href="#" data-action="go" data-to="pages">Buchseiten fotografieren</a></div>`}
      </div>`;
  }


  // ---------- Termine ----------
  const countdown = e => { const d = dayDiff(today(), e.date); return d === 0 ? 'heute' : d === 1 ? 'morgen' : d < 0 ? 'vorbei' : `in ${d} Tagen`; };

  function examCard(e, detail = false) {
    const t = Exams.todayList(e), k = dirsFor(e.dir || 'de-it').length, n = Exams.cards(e).length;
    const done = Exams.doneToday(e), isDay = e.date === today();
    const todayTxt = t.ids.length
      ? `<b>Heute: ${plural(t.ids.length * k, 'Abfrage', 'Abfragen')}</b>${t.final ? (isDay ? ' · letzter Check' : ' · Generalprobe') : ''}`
      : done ? 'Heute erledigt ✓' : 'Heute frei';
    const d = new Date(e.date + 'T12:00:00');
    return `<div class="card exam-card" ${detail ? '' : `data-action="exam-open" data-id="${esc(e.id)}"`}>
      <div class="row">
        <div class="exam-date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('de-DE', { month: 'short' })}</span></div>
        <div class="spacer" style="min-width:0">
          <div class="name">${esc(e.title)}</div>
          <div class="small muted">${countdown(e)} · ${plural(n, 'Vokabel', 'Vokabeln')}${e.notify ? ' · 🔔 7:00' : ''}</div>
        </div>
      </div>
      <div class="bar" title="Fortschritt im Lernplan"><i style="width:${Math.round(Exams.progress(e) * 100)}%"></i></div>
      <div class="row" style="margin-top:12px">
        <span class="small spacer">${todayTxt}</span>
        ${t.ids.length ? `<button class="btn primary small" data-action="exam-learn" data-id="${esc(e.id)}">Lernen</button>` : ''}
      </div>
    </div>`;
  }

  function viewExams(v) {
    setTitle('Termine');
    const up = Exams.upcoming(), past = Exams.list().filter(e => e.date < today()).reverse();
    v.innerHTML = `
      <button class="btn primary block" style="margin:6px 0 14px" data-action="exam-new">+ Neuer Termin</button>
      ${up.length ? up.map(e => examCard(e)).join('') : `<div class="card empty">Noch keine Termine.<br>Leg z. B. deine nächste Ex an – die App macht dir dann einen Lernplan bis dahin.</div>`}
      ${past.length ? `<div class="section-title">Vergangen</div><div class="card">${past.map(e => `
        <div class="vocab-item" data-action="exam-open" data-id="${esc(e.id)}">
          <div class="spacer"><div class="it">${esc(e.title)}</div><div class="de">${fmtDate(e.date, { day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
        </div>`).join('')}</div>` : ''}`;
  }

  function viewExam(v) {
    const e = state.exams[ui.examId];
    if (!e || e.deleted) { route = 'exams'; return viewExams(v); }
    setTitle(e.title);
    const k = dirsFor(e.dir || 'de-it').length, t = today();
    const plan = Exams.plan(e);
    const dayName = d => d === t ? 'Heute' : d === addDays(t, 1) ? 'Morgen' : fmtDate(d);
    const rows = plan.map(p => {
      let txt;
      if (p.final) txt = p.count ? `<b>Generalprobe:</b> ${plural(p.count * k, 'Abfrage', 'Abfragen')}` : 'Generalprobe erledigt ✓';
      else if (p.count) txt = `${plural(p.count * k, 'Abfrage', 'Abfragen')}${p.fresh ? ` <span class="muted">(${p.fresh} neu)</span>` : ''}`;
      else txt = p.date === t && p.done ? 'erledigt ✓' : '<span class="muted">frei</span>';
      if (p.date === t && p.done && p.count) txt += ` <span class="muted">· ${p.done} schon geschafft</span>`;
      return `<div class="plan-row ${p.date === t ? 'today' : ''}"><span class="plan-day">${dayName(p.date)}</span><span class="spacer">${txt}</span></div>`;
    }).join('');
    const lessons = (e.lessons || []).filter(l => lessonMap().has(l));
    const extra = (e.cardIds || []).filter(id => state.cards[id] && !state.cards[id].deleted && !lessons.includes(state.cards[id].lesson)).length;
    v.innerHTML = `
      ${examCard(e, true)}
      <div class="section-title">Lernplan</div>
      <div class="card">
        ${rows || ''}
        <div class="plan-row exam-day"><span class="plan-day">${dayName(e.date) === 'Heute' ? 'Heute' : fmtDate(e.date)}</span><span class="spacer"><b>🎯 ${esc(e.title)}</b> – viel Erfolg!</span></div>
        <p class="small muted" style="margin:10px 0 0">Jede Vokabel kommt bis zum Termin etwa ${e.target || 3}× dran, mit wachsenden Abständen. Was du falsch hast, kommt am nächsten Tag nochmal.</p>
      </div>
      <div class="section-title">Stoff</div>
      <div class="card small">
        ${lessons.length ? `<div class="chips" style="margin-bottom:${extra ? 8 : 0}px">${lessons.map(l => `<span class="chip on">${esc(l)}</span>`).join('')}</div>` : ''}
        ${extra ? `<div class="muted">+ ${plural(extra, 'einzelne Vokabel', 'einzelne Vokabeln')}</div>` : ''}
        <div class="muted" style="margin-top:6px">${esc(DIR_LABEL[e.dir] || 'Beide Richtungen')}</div>
      </div>
      <div class="row">
        <button class="btn spacer" data-action="exam-edit" data-id="${esc(e.id)}">Bearbeiten</button>
        <button class="btn spacer" data-action="exam-practice" data-id="${esc(e.id)}">Alles abfragen</button>
      </div>`;
  }

  function viewExamEdit(v) {
    const e = ui.examId ? state.exams[ui.examId] : null;
    setTitle(e ? 'Termin bearbeiten' : 'Neuer Termin');
    if (!ui.examDraft) {
      ui.examDraft = e
        ? { title: e.title, date: e.date, lessons: [...(e.lessons || [])], cardIds: [...(e.cardIds || [])], dir: e.dir || 'de-it', notify: e.notify !== false }
        : { title: '', date: addDays(today(), 7), lessons: [], cardIds: [], dir: 'de-it', notify: true };
      ui.examSearch = '';
    }
    const d = ui.examDraft;
    const lessons = [...lessonMap().keys()];
    const seg = (val, label) => `<button type="button" class="${d.dir === val ? 'on' : ''}" data-action="exam-dir" data-v="${val}">${label}</button>`;
    const pushOff = !('Notification' in window) || Notification.permission !== 'granted';
    v.innerHTML = `
      <div class="card">
        <label class="field"><span>Titel</span><input type="text" id="exTitle" value="${esc(d.title)}" placeholder="z. B. Ex Lektion 3"></label>
        <label class="field" style="margin-bottom:0"><span>Datum</span><input type="date" id="exDate" value="${esc(d.date)}" min="${today()}"></label>
      </div>
      <div class="section-title">Lektionen</div>
      <div class="card">
        ${lessons.length ? `<div class="chips">${lessons.map(l => `<button type="button" class="chip ${d.lessons.includes(l) ? 'on' : ''}" data-action="exam-lesson" data-lesson="${esc(l)}">${esc(l)}</button>`).join('')}</div>` : '<span class="muted small">Noch keine Lektionen.</span>'}
      </div>
      <div class="section-title">Einzelne Vokabeln</div>
      <div class="card">
        <input type="search" id="exSearch" placeholder="Vokabel suchen und anhaken …" value="${esc(ui.examSearch)}" style="margin-bottom:8px">
        <div id="exCardList" class="pick-list"></div>
      </div>
      <div class="section-title">Richtung</div>
      <div class="seg">${seg('de-it', 'DE → IT')}${seg('it-de', 'IT → DE')}${seg('both', 'Beide')}</div>
      <div class="section-title">Erinnerung</div>
      <div class="card">
        <label class="check"><input type="checkbox" id="exNotify" ${d.notify ? 'checked' : ''}><span><b>Mitteilung um 7:00 Uhr</b><br><span class="small muted">erinnert dich jeden Tag an deinen Lernplan für diesen Termin</span></span></label>
        ${pushOff ? `<p class="small muted" style="margin:8px 0 0">Damit sie ankommt, müssen Mitteilungen auf dem Gerät eingeschaltet sein (Einstellungen → Mitteilungen).</p>` : ''}
      </div>
      <div class="card" id="exSummary"></div>
      <div class="row">
        <button class="btn" data-action="exam-cancel">Abbrechen</button>
        <button class="btn primary spacer" data-action="exam-save">${e ? 'Speichern' : 'Termin anlegen'}</button>
      </div>
      ${e ? `<button class="btn danger block" style="margin-top:12px" data-action="exam-delete">Termin löschen</button>` : ''}`;

    const summary = () => {
      const tmp = { lessons: d.lessons, cardIds: d.cardIds };
      const n = Exams.cards(tmp).length, days = Math.max(0, dayDiff(today(), d.date));
      $('#exSummary').innerHTML = `<div class="small">${n ? `<b>${plural(n, 'Vokabel', 'Vokabeln')}</b> ausgewählt` : '<span class="muted">Noch keine Vokabeln ausgewählt.</span>'}
        ${n && d.date >= today() ? ` · ${plural(days, 'Lerntag', 'Lerntage')} · jede Vokabel ca. ${targetReps(days)}×` : ''}</div>`;
    };
    const drawCards = () => {
      const q = noAccent(norm(ui.examSearch));
      const inLesson = new Set(d.lessons);
      const picked = new Set(d.cardIds);
      let list = activeCards().filter(c => !inLesson.has(c.lesson));
      list = q ? list.filter(c => noAccent(norm(c.it + ' ' + c.de)).includes(q)) : list.filter(c => picked.has(c.id));
      $('#exCardList').innerHTML = list.length
        ? list.slice(0, 60).map(c => `<label class="check"><input type="checkbox" data-card="${esc(c.id)}" ${picked.has(c.id) ? 'checked' : ''}><span>${esc(c.it)} <span class="muted small">– ${esc(c.de)} · ${esc(c.lesson)}</span></span></label>`).join('')
        : `<p class="small muted" style="margin:0">${q ? 'Nichts gefunden (Vokabeln aus gewählten Lektionen sind schon drin).' : 'Suche oben, um einzelne Vokabeln aus anderen Lektionen dazuzunehmen.'}</p>`;
      $$('[data-card]', $('#exCardList')).forEach(cb => cb.addEventListener('change', () => {
        const s2 = new Set(d.cardIds);
        cb.checked ? s2.add(cb.dataset.card) : s2.delete(cb.dataset.card);
        d.cardIds = [...s2];
        summary();
      }));
    };
    $('#exTitle').addEventListener('input', ev => { d.title = ev.target.value; });
    $('#exDate').addEventListener('change', ev => { d.date = ev.target.value; summary(); });
    $('#exNotify').addEventListener('change', ev => { d.notify = ev.target.checked; });
    $('#exSearch').addEventListener('input', ev => { ui.examSearch = ev.target.value; drawCards(); });
    drawCards();
    summary();
  }

  // ---------- Lernen einstellen ----------
  function viewLearn(v) {
    setTitle('Lernen');
    const st = state.settings;
    const lessons = [...lessonMap().keys()];
    const sel = new Set(st.lessons.filter(l => lessons.includes(l)));
    const { due, fresh } = pool([...sel], st.dir);
    const seg = (name, val, label) => `<button class="${st[name] === val ? 'on' : ''}" data-action="set" data-k="${name}" data-v="${val}">${label}</button>`;
    const allCount = activeCards().filter(c => !sel.size || sel.has(c.lesson)).length * dirsFor(st.dir).length;

    v.innerHTML = `
      <div class="section-title">Lektionen</div>
      <div class="card">
        <div class="chips">
          <button class="chip ${sel.size ? '' : 'on'}" data-action="lesson-all">Alle</button>
          ${lessons.map(l => `<button class="chip ${sel.has(l) ? 'on' : ''}" data-action="lesson-toggle" data-lesson="${esc(l)}">${esc(l)}</button>`).join('')}
        </div>
      </div>
      <div class="section-title">Richtung</div>
      <div class="seg">${seg('dir', 'de-it', 'DE → IT')}${seg('dir', 'it-de', 'IT → DE')}${seg('dir', 'both', 'Beide')}</div>
      <div class="section-title">Abfrageart</div>
      <div class="seg">${seg('mode', 'mix', 'Gemischt')}${seg('mode', 'type', 'Tippen')}${seg('mode', 'choice', 'Auswahl')}${seg('mode', 'flip', 'Karte')}</div>
      <p class="small muted" style="margin:8px 4px 0">${{
        mix: 'Neue Vokabeln als Auswahl, bekannte zum Eintippen.',
        type: 'Du tippst die Lösung ein. Am strengsten, lernt am meisten.',
        choice: 'Du wählst aus vier Möglichkeiten.',
        flip: 'Karte umdrehen und selbst bewerten.'
      }[st.mode]}</p>
      <div style="margin-top:22px" class="card">
        ${due.length + fresh.length
          ? `<button class="btn primary block big" data-action="learn-now">Lernen: ${due.length} fällig + ${fresh.length} neu</button>
             <p class="small muted" style="margin:8px 2px 14px">Neue Vokabeln starten in Fach 0. Was du gut kannst, kommt seltener dran.</p>`
          : `<button class="btn primary block big" data-action="learn-random" ${allCount ? '' : 'disabled'}>Zufällig üben 🎲</button>
             <p class="small muted" style="margin:8px 2px 14px">Alles gelernt! Hier kommen zufällige Vokabeln. Richtig → bleibt, falsch → Fach 1.</p>`}
        <button class="btn block" data-action="learn-practice" ${allCount ? '' : 'disabled'}>Test-Modus: alle ${allCount} abfragen</button>
        <p class="small muted" style="margin:8px 2px 0">Gut vor einer Ex oder Schulaufgabe: fragt alles aus der Auswahl ab, egal ob fällig.</p>
      </div>`;
  }

  // ---------- Vokabelliste ----------
  function viewVocab(v) {
    setTitle('Vokabeln');
    const lessons = [...lessonMap().keys()];
    if (ui.vocabLesson && !lessons.includes(ui.vocabLesson)) ui.vocabLesson = '';
    v.innerHTML = `
      ${vocabTabs('vocab')}
      <div class="row" style="margin:6px 0 12px">
        <button class="btn primary spacer" data-action="new-card">+ Neue Vokabel</button>
        <button class="btn spacer" data-action="go" data-to="import">Liste importieren</button>
      </div>
      <div class="row" style="margin-bottom:12px">
        <select id="lessonFilter" style="flex:1">
          <option value="">Alle Lektionen</option>
          ${lessons.map(l => `<option ${l === ui.vocabLesson ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
      </div>
      <input type="search" id="search" placeholder="Suchen …" value="${esc(ui.vocabSearch)}" style="margin-bottom:12px">
      <div class="card" id="vocabList"></div>
      ${ui.vocabLesson ? `<button class="btn danger block" data-action="delete-lesson">Lektion „${esc(ui.vocabLesson)}“ löschen</button>` : ''}`;
    drawVocabList();
    $('#lessonFilter').addEventListener('change', e => { ui.vocabLesson = e.target.value; render(); });
    $('#search').addEventListener('input', e => { ui.vocabSearch = e.target.value; drawVocabList(); });
  }

  const vocabTabs = on => `<div class="seg" style="margin:4px 0 14px">
      <button class="${on === 'vocab' ? 'on' : ''}" data-action="go" data-to="vocab">Vokabeln</button>
      <button class="${on === 'pages' ? 'on' : ''}" data-action="go" data-to="pages">Buchseiten${activePages().length ? ` (${activePages().length})` : ''}</button>
    </div>`;

  // ---------- Buchseiten ----------
  function viewPages(v) {
    setTitle('Buchseiten');
    const lessons = allLessons();
    if (ui.pagesLesson && !lessons.includes(ui.pagesLesson) && ui.pagesLesson !== ui.pagesNewLesson) ui.pagesLesson = '';
    const shown = ui.pagesLesson ? [ui.pagesLesson] : lessons.filter(l => lessonPages(l).length);
    const target = ui.pagesLesson || '';
    v.innerHTML = `
      ${vocabTabs('pages')}
      <div class="card">
        <label class="field"><span>Lektion</span>
          <input type="text" id="pgLesson" list="pgLessonList" placeholder="leer lassen = Unsortiert" value="${esc(target)}" autocomplete="off">
        </label>
        <p class="small muted" style="margin:-4px 2px 12px">Text und Vokabeln werden nach dem Fotografieren automatisch erkannt${Sync.user() ? '' : ' (dafür in den Einstellungen anmelden)'}. Die Lektion kannst du später bei jeder Seite ändern.</p>
        <datalist id="pgLessonList">${lessons.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
        <div class="row">
          <button class="btn primary spacer" data-action="pages-camera">📷 Fotografieren</button>
          <button class="btn spacer" data-action="pages-pick">🖼️ Aus Fotos</button>
        </div>
        <input type="file" id="pgCam" accept="image/*" capture="environment" hidden>
        <input type="file" id="pgPick" accept="image/*" multiple hidden>
        <p class="small muted" style="margin:10px 2px 0" id="pagesInfo">${esc(Pages.info())}</p>
      </div>
      ${lessons.some(l => lessonPages(l).length) ? `<div class="chips" style="margin-bottom:14px">
          <button class="chip ${ui.pagesLesson ? '' : 'on'}" data-action="pages-filter" data-lesson="">Alle</button>
          ${lessons.filter(l => lessonPages(l).length).map(l => `<button class="chip ${ui.pagesLesson === l ? 'on' : ''}" data-action="pages-filter" data-lesson="${esc(l)}">${esc(l)}</button>`).join('')}
        </div>` : ''}
      ${shown.map(l => {
        const list = lessonPages(l);
        return `<div class="section-title">${esc(l)} <span class="muted">· ${plural(list.length, 'Seite', 'Seiten')}</span></div>
          ${list.length ? `<div class="page-grid">${list.map((p, i) => `
            <button class="page-thumb" data-action="page-open" data-id="${esc(p.id)}">
              <img data-page="${esc(p.id)}" data-kind="thumb" alt="Seite ${i + 1}">
              <span>${i + 1}</span>
              ${Pages.isRecognizing(p.id) ? '<em>erkenne …</em>' : p.ocr ? `<em class="ok">${p.ocr.vokabeln.length} Vok.</em>` : ''}
            </button>`).join('')}</div>` : `<div class="card empty">Noch keine Seiten in dieser Lektion.</div>`}`;
      }).join('') || `<div class="card empty">Noch keine Buchseiten. Lektion eintragen und los geht's 📷</div>`}`;
    fillImages(v);
    const inp = $('#pgLesson');
    inp.addEventListener('change', () => { ui.pagesNewLesson = inp.value.trim(); if (lessons.includes(ui.pagesNewLesson)) { ui.pagesLesson = ui.pagesNewLesson; render(); } });
    const onFiles = async e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      const lesson = inp.value.trim() || 'Unsortiert';
      toast(files.length > 1 ? `${files.length} Fotos werden gespeichert …` : 'Foto wird gespeichert …');
      try {
        const n = await Pages.add(files, lesson);
        toast(n ? `${plural(n, 'Seite', 'Seiten')} zu „${lesson}“ hinzugefügt ✓` : 'Keine Bilder gefunden');
        ui.pagesLesson = lesson;
        render();
      } catch (err) { toast(err.message || 'Speichern fehlgeschlagen'); }
    };
    $('#pgCam').addEventListener('change', onFiles);
    $('#pgPick').addEventListener('change', onFiles);
  }

  function viewPage(v) {
    const p = state.pages[ui.pageId];
    if (!p || p.deleted) return go('pages');
    const list = lessonPages(p.lesson);
    const i = list.findIndex(x => x.id === p.id);
    setTitle(`${p.lesson} · Seite ${i + 1}`);
    const lessons = allLessons();
    v.innerHTML = `
      <div class="row" style="margin:4px 0 12px">
        <button class="btn" data-action="pages-back">‹ Zurück</button>
        <span class="spacer"></span>
        <button class="btn" data-action="page-nav" data-d="-1" ${i > 0 ? '' : 'disabled'} aria-label="Vorherige Seite">←</button>
        <span class="small muted">${i + 1} / ${list.length}</span>
        <button class="btn" data-action="page-nav" data-d="1" ${i < list.length - 1 ? '' : 'disabled'} aria-label="Nächste Seite">→</button>
      </div>
      <div class="seg" style="margin-bottom:12px">
        ${[['foto', 'Foto'], ['text', 'Text'], ['vok', `Vokabeln${p.ocr ? ` (${p.ocr.vokabeln.length})` : ''}`]].map(([k, l]) => `<button class="${ui.pageTab === k ? 'on' : ''}" data-action="page-tab" data-v="${k}">${l}</button>`).join('')}
      </div>
      ${ui.pageTab === 'text' || ui.pageTab === 'vok' ? pageOcrBox(p) : `
      <div class="page-view ${ui.pageZoom ? 'zoom' : ''}" data-action="page-zoom">
        <img data-page="${esc(p.id)}" data-kind="full" alt="Buchseite">
      </div>
      <p class="small muted" style="text-align:center;margin:6px 0 14px">Antippen zum Vergrößern${ui.pageZoom ? ' · nochmal antippen zum Verkleinern' : ''}</p>`}
      <div class="card">
        <label class="field"><span>Lektion</span>
          <input type="text" id="pvLesson" list="pvLessonList" value="${esc(p.lesson)}" autocomplete="off">
        </label>
        <datalist id="pvLessonList">${lessons.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
        <div class="row">
          <button class="btn spacer" data-action="page-move" data-d="-1" ${i > 0 ? '' : 'disabled'}>Nach vorne</button>
          <button class="btn spacer" data-action="page-move" data-d="1" ${i < list.length - 1 ? '' : 'disabled'}>Nach hinten</button>
        </div>
        <button class="btn danger block" style="margin-top:12px" data-action="page-delete">Seite löschen</button>
      </div>`;
    fillImages(v);
    const vt = $('#pvVocab');
    if (vt) {
      const upd = () => {
        ui.pageVocabText = vt.value;
        const lines = vt.value.split(/\r?\n/).filter(l => l.trim());
        const ok = lines.map(parseLine).filter(Boolean).length;
        $('#pvVocabInfo').innerHTML = `${plural(ok, 'Vokabel', 'Vokabeln')} erkannt${lines.length - ok ? ` · <span style="color:var(--red)">${lines.length - ok} Zeile(n) nicht verstanden</span>` : ''}`;
        $('#pvImport').disabled = !ok;
      };
      vt.addEventListener('input', upd);
      upd();
    }
    $('#pvLesson').addEventListener('change', e => {
      const l = e.target.value.trim();
      if (!l || l === p.lesson) return;
      p.lesson = l;
      p.order = Math.max(0, ...lessonPages(l).map(x => x.order || 0)) + 1;
      p.updated = now();
      save(); toast(`In „${l}“ verschoben`); render();
    });
  }

  const ocrLines = p => (p.ocr?.vokabeln || []).map(x => `${x.it} - ${x.de}${x.notiz ? ` [${x.notiz}]` : ''}`).join('\n');
  function pageOcrBox(p) {
    if (Pages.isRecognizing(p.id)) return `<div class="card empty">Text und Vokabeln werden erkannt … (dauert etwa eine halbe Minute)</div>`;
    if (!p.ocr) return `<div class="card">
        ${p.ocrError ? `<p class="small" style="color:var(--red);margin-top:0">${esc(p.ocrError)}</p>` : `<p class="small muted" style="margin-top:0">Für diese Seite wurde noch nichts erkannt.</p>`}
        <button class="btn primary block" data-action="page-recognize" ${Sync.user() ? '' : 'disabled'}>🔍 Text und Vokabeln erkennen</button>
        ${Sync.user() ? '' : '<p class="small muted" style="margin-bottom:0">Dafür in den Einstellungen anmelden.</p>'}
      </div>`;
    if (ui.pageTab === 'text') return `<div class="card">
        ${p.ocr.titel ? `<div style="font-weight:700;margin-bottom:8px">${esc(p.ocr.titel)}</div>` : ''}
        <div class="ocr-text" lang="it">${esc(p.ocr.text) || '<span class="muted">Kein Text erkannt.</span>'}</div>
        <button class="btn block small" style="margin-top:14px" data-action="page-recognize">Neu erkennen</button>
      </div>`;
    if (ui.pageVocabFor !== p.id) { ui.pageVocabFor = p.id; ui.pageVocabText = ocrLines(p); ui.pageVocabLesson = p.lesson === 'Unsortiert' ? '' : p.lesson; }
    const lessons = allLessons().filter(l => l !== 'Unsortiert');
    return `<div class="card">
        ${p.imported ? `<p class="small" style="margin-top:0;color:var(--green)"><b>✓ Schon übernommen</b> nach „${esc(p.imported)}“. Doppelte werden beim nochmal Übernehmen übersprungen.</p>` : ''}
        <label class="field"><span>Vokabeln prüfen und bei Bedarf ändern (eine pro Zeile)</span>
          <textarea id="pvVocab" style="min-height:220px">${esc(ui.pageVocabText)}</textarea>
        </label>
        <p class="small muted" style="margin:-4px 2px 10px" id="pvVocabInfo"></p>
        <label class="field"><span>In welche Lektion?</span>
          <input type="text" id="pvTarget" list="pvTargetList" placeholder="z. B. Lektion 3" value="${esc(ui.pageVocabLesson)}" autocomplete="off">
        </label>
        <datalist id="pvTargetList">${lessons.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
        <button class="btn primary block big" id="pvImport" data-action="page-import">In die Lektion übernehmen</button>
        <button class="btn block small" style="margin-top:10px" data-action="page-recognize">Neu erkennen</button>
      </div>`;
  }

  function drawVocabList() {
    const q = noAccent(norm(ui.vocabSearch));
    const list = activeCards()
      .filter(c => !ui.vocabLesson || c.lesson === ui.vocabLesson)
      .filter(c => !q || noAccent(norm(c.it + ' ' + c.de)).includes(q))
      .sort((a, b) => a.lesson.localeCompare(b.lesson, 'de', { numeric: true }) || (a.created || 0) - (b.created || 0));
    const dots = c => {
      const n = Math.min(MAX_BOX, Math.max(prog(c.id, 'de-it')?.box || 0, prog(c.id, 'it-de')?.box || 0));
      return `<div class="dots" title="Fach ${n} von ${MAX_BOX}">${[1, 2, 3, 4].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;
    };
    $('#vocabList').innerHTML = list.length
      ? `<div class="small muted" style="margin-bottom:4px">${plural(list.length, 'Vokabel', 'Vokabeln')}</div>` + list.map(c => `
        <div class="vocab-item" data-action="edit-card" data-id="${esc(c.id)}">
          <div class="spacer" style="min-width:0"><div class="it">${esc(c.it)}</div><div class="de">${esc(c.de)}</div></div>
          ${dots(c)}
        </div>`).join('')
      : `<div class="empty">Keine Vokabeln gefunden.</div>`;
  }

  // ---------- Vokabel bearbeiten / neu ----------
  function viewEdit(v) {
    const c = ui.editId ? state.cards[ui.editId] : null;
    setTitle(c ? 'Vokabel bearbeiten' : 'Neue Vokabel');
    const lessons = allLessons();
    const lesson = c ? c.lesson : (ui.formLesson || ui.vocabLesson || lessons[lessons.length - 1] || 'Meine Vokabeln');
    v.innerHTML = `
      <form class="card" id="cardForm" autocomplete="off">
        <label class="field"><span>Italienisch</span><input type="text" name="it" lang="it" required value="${esc(c?.it)}" placeholder="z. B. il libro" autocapitalize="off"></label>
        <label class="field"><span>Deutsch</span><input type="text" name="de" required value="${esc(c?.de)}" placeholder="z. B. das Buch" autocapitalize="off"></label>
        <label class="field"><span>Lektion</span><input type="text" name="lesson" list="lessonList" required value="${esc(lesson)}"></label>
        <datalist id="lessonList">${lessons.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
        <label class="field"><span>Notiz (optional)</span><input type="text" name="note" value="${esc(c?.note)}" placeholder="z. B. Plural, unregelmäßig …"></label>
        <p class="small muted" style="margin:-4px 2px 12px">Mehrere richtige Antworten mit ; trennen, z. B. „machen; tun“.</p>
        <div class="row">
          <button type="button" class="btn" data-action="go" data-to="vocab">Abbrechen</button>
          <button type="submit" class="btn primary spacer">${c ? 'Speichern' : 'Hinzufügen'}</button>
        </div>
        ${c ? `<button type="button" class="btn danger block" style="margin-top:12px" data-action="delete-card">Vokabel löschen</button>` : ''}
      </form>`;
    const f = $('#cardForm');
    if (!c) f.it.focus();
    f.addEventListener('submit', e => {
      e.preventDefault();
      const data = { it: f.it.value.trim(), de: f.de.value.trim(), lesson: f.lesson.value.trim() || 'Meine Vokabeln', note: f.note.value.trim() };
      if (!data.it || !data.de) return;
      if (c) {
        Object.assign(c, data, { updated: now() });
        save();
        toast('Gespeichert');
        go('vocab');
      } else {
        const id = uid();
        state.cards[id] = { id, ...data, created: now(), updated: now() };
        save();
        ui.formLesson = data.lesson;
        toast(`„${data.it}“ hinzugefügt`);
        viewEdit(v); // gleich die nächste eintragen
      }
    });
  }

  // ---------- Import ----------
  function parseLine(line) {
    const l = line.trim();
    if (!l || l.startsWith('#')) return null;
    for (const s of ['\t', ' = ', ' – ', ' — ', ' - ', ';']) {
      const i = l.indexOf(s);
      if (i > 0) {
        const it = l.slice(0, i).trim();
        let rest = l.slice(i + s.length).trim(), note = '';
        if (s === '\t' && rest.includes('\t')) { [rest, note] = [rest.slice(0, rest.indexOf('\t')), rest.slice(rest.indexOf('\t') + 1)]; }
        const m = rest.match(/^(.*?)\s*\[(.*)\]$/); // Notiz in eckigen Klammern: "das Buch [Pl. i libri]"
        if (m) { rest = m[1]; note = m[2]; }
        if (it && rest) return { it, de: rest.trim(), note: note.trim() };
      }
    }
    return null;
  }

  // Vokabeln in eine Lektion übernehmen (doppelte überspringen), gibt Anzahl neuer zurück
  function importRows(lesson, rows) {
    const existing = new Set(activeCards().filter(c => c.lesson === lesson).map(c => norm(c.it)));
    let added = 0;
    const t = now();
    for (const r of rows) {
      if (existing.has(norm(r.it))) continue;
      const id = uid();
      state.cards[id] = { id, it: r.it, de: r.de, note: r.note, lesson, created: t + added, updated: t };
      existing.add(norm(r.it));
      added++;
    }
    save();
    return added;
  }

  function viewImport(v) {
    setTitle('Liste importieren');
    const lessons = allLessons();
    v.innerHTML = `
      <div class="card">
        <label class="field"><span>Lektion</span><input type="text" id="impLesson" list="lessonList2" placeholder="z. B. Lektion 3" value="${esc(ui.importLesson)}"></label>
        <datalist id="lessonList2">${lessons.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
        <label class="field"><span>Vokabeln (eine pro Zeile: italienisch - deutsch)</span>
          <textarea id="impText" placeholder="il libro - das Buch&#10;la penna - der Stift&#10;essere - sein [unregelmäßig]&#10;fare - machen; tun">${esc(ui.importText)}</textarea>
        </label>
        <p class="small muted" style="margin-top:-4px">Trennzeichen: „ - “, „ = “, Tab oder „;“. Notiz in [eckigen Klammern]. Aus Excel/Tabellen kopieren geht auch.</p>
        <div id="impPreview" class="preview"></div>
        <button class="btn primary block big" style="margin-top:14px" data-action="do-import" id="impBtn">Importieren</button>
      </div>`;
    const upd = () => {
      ui.importLesson = $('#impLesson').value;
      ui.importText = $('#impText').value;
      const lines = ui.importText.split(/\r?\n/).filter(l => l.trim());
      const ok = lines.map(parseLine).filter(Boolean);
      const bad = lines.length - ok.length;
      $('#impPreview').innerHTML = lines.length
        ? `<b>${plural(ok.length, 'Vokabel', 'Vokabeln')} erkannt</b>${bad ? ` · <span style="color:var(--red)">${bad} Zeile(n) nicht verstanden</span>` : ''}` +
          ok.slice(0, 4).map(r => `<div>${esc(r.it)} → ${esc(r.de)}${r.note ? ` <span class="muted">(${esc(r.note)})</span>` : ''}</div>`).join('') +
          (ok.length > 4 ? `<div class="muted">… und ${ok.length - 4} weitere</div>` : '')
        : '';
      $('#impBtn').disabled = !ok.length || !ui.importLesson.trim();
    };
    $('#impLesson').addEventListener('input', upd);
    $('#impText').addEventListener('input', upd);
    upd();
  }

  // ---------- Einstellungen ----------
  function viewMore(v) {
    setTitle('Einstellungen');
    const user = Sync.user();
    const st = state.settings;
    const syncBox = !Sync.configured
      ? `<p class="small muted" style="margin-bottom:0">Sobald die Supabase-Daten in <code>config.js</code> stehen, kannst du dich hier anmelden.</p>`
      : user
        ? `<p class="small">Angemeldet als <b>${esc(user.email)}</b></p>
           <div class="row"><button class="btn primary spacer" data-action="sync-now">Jetzt synchronisieren</button><button class="btn" data-action="sign-out">Abmelden</button></div>`
        : `<form id="loginForm">
             <label class="field"><span>E-Mail</span><input type="email" name="email" required autocomplete="username"></label>
             <label class="field"><span>Passwort</span><input type="password" name="pw" required minlength="6" autocomplete="current-password"></label>
             <div class="row"><button type="submit" class="btn primary spacer">Anmelden</button><button type="button" class="btn" data-action="sign-up">Konto erstellen</button></div>
           </form>`;

    v.innerHTML = `
      <div class="section-title">Geräte-Sync</div>
      <div class="card">
        <p class="small muted" id="syncInfo" style="margin-top:0">${esc(Sync.info().text)}</p>
        ${syncBox}
      </div>

      <div class="section-title">Mitteilungen</div>
      <div class="card" id="pushBox"><p class="small muted" style="margin:0">…</p></div>

      <div class="section-title">Lernen</div>
      <div class="card">
        <label class="field" style="margin-bottom:0"><span>Abfragen pro Runde</span><input type="number" min="5" max="200" id="setSize" value="${st.sessionSize}"></label>
      </div>

      <div class="section-title">Sicherung</div>
      <div class="card">
        <p class="small muted" style="margin-top:0">Alle Vokabeln und dein Lernstand als Datei. Fotos der Buchseiten sind nicht enthalten, die sichert der Geräte-Sync.</p>
        <div class="row"><button class="btn spacer" data-action="export">Sichern</button><button class="btn spacer" data-action="import-file">Wiederherstellen</button></div>
        <input type="file" id="fileIn" accept=".json,application/json" hidden>
      </div>

      <div class="section-title">Als App installieren</div>
      <div class="card small">
        <p style="margin-top:0"><b>iPhone / iPad:</b> In Safari öffnen → Teilen-Symbol → „Zum Home-Bildschirm“.</p>
        <p style="margin-bottom:0"><b>PC:</b> In Chrome oder Edge rechts in der Adressleiste auf „App installieren“ klicken.</p>
      </div>
      <p class="small muted" style="text-align:center">Avanti Italiano · Version 1.6</p>`;

    Push.paint();
    const f = $('#loginForm');
    if (f) f.addEventListener('submit', async e => {
      e.preventDefault();
      try { await Sync.signIn(f.email.value.trim(), f.pw.value); toast('Angemeldet ✓'); render(); }
      catch (err) { toast(err.message); }
    });
    const num = (id, k, min, max) => $(id).addEventListener('change', e => {
      state.settings[k] = Math.max(min, Math.min(max, parseInt(e.target.value, 10) || min));
      e.target.value = state.settings[k];
      persist();
      toast('Gespeichert');
    });
    num('#setSize', 'sessionSize', 5, 200);
    $('#fileIn').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data.cards) throw new Error();
        if (!confirm('Sicherung laden? Sie wird mit deinen aktuellen Daten zusammengeführt.')) return;
        const base = emptyState();
        state = { ...mergeStates(state, data), settings: { ...base.settings, ...state.settings } };
        save();
        toast('Sicherung geladen');
        render();
      } catch (err) { toast('Diese Datei ist keine gültige Sicherung.'); }
    });
  }

  // ================= Aktionen =================
  const actions = {
    go: el => go(el.dataset.to),
    speak: el => speak(el.dataset.text),
    'learn-now': () => startLearning(state.settings.lessons, { randomIfDone: true }),
    'learn-random': () => startLearning(state.settings.lessons, { random: true }),
    'learn-lesson': el => startLearning([el.dataset.lesson], { randomIfDone: true }),
    'learn-practice': () => startLearning(state.settings.lessons, { practice: true }),
    set: el => { state.settings[el.dataset.k] = el.dataset.v; persist(); render(); },
    'lesson-all': () => { state.settings.lessons = []; persist(); render(); },
    'lesson-toggle': el => {
      const l = el.dataset.lesson, s = new Set(state.settings.lessons);
      s.has(l) ? s.delete(l) : s.add(l);
      state.settings.lessons = [...s];
      persist(); render();
    },
    'new-card': () => go('edit', { editId: null }),
    'pages-open': el => go('pages', { pagesLesson: el.dataset.lesson }),
    'pages-filter': el => go('pages', { pagesLesson: el.dataset.lesson }),
    'pages-camera': () => $('#pgCam').click(),
    'pages-pick': () => $('#pgPick').click(),
    'pages-back': () => go('pages', { pagesLesson: state.pages[ui.pageId]?.lesson || ui.pagesLesson }),
    'page-open': el => go('page', { pageId: el.dataset.id, pageZoom: false, pageTab: 'foto' }),
    'page-nav': el => {
      const p = state.pages[ui.pageId], list = lessonPages(p.lesson);
      const q = list[list.findIndex(x => x.id === p.id) + +el.dataset.d];
      if (q) go('page', { pageId: q.id, pageZoom: false });
    },
    'page-zoom': () => { ui.pageZoom = !ui.pageZoom; render(); },
    'page-move': el => {
      const p = state.pages[ui.pageId], list = lessonPages(p.lesson);
      const i = list.findIndex(x => x.id === p.id), j = i + +el.dataset.d;
      if (!list[j]) return;
      list.forEach((x, k) => { if (x.order !== k + 1) { x.order = k + 1; x.updated = now(); } }); // lückenlos nummerieren
      [list[i].order, list[j].order] = [list[j].order, list[i].order];
      list[i].updated = list[j].updated = now();
      save(); render();
    },
    'page-delete': () => {
      if (!confirm('Diese Buchseite löschen?')) return;
      const lesson = state.pages[ui.pageId]?.lesson;
      Pages.remove(ui.pageId);
      toast('Seite gelöscht');
      go('pages', { pagesLesson: lesson });
    },
    'exam-new': () => go('examEdit', { examId: null, examDraft: null }),
    'exam-open': el => go('exam', { examId: el.dataset.id }),
    'exam-edit': el => go('examEdit', { examId: el.dataset.id, examDraft: null }),
    'exam-learn': el => startExam(el.dataset.id),
    'exam-practice': el => {
      const e = state.exams[el.dataset.id];
      const items = [];
      for (const c of Exams.cards(e)) for (const d of dirsFor(e.dir || 'de-it')) items.push({ card: c, dir: d });
      Session.start(shuffle(items), { mode: state.settings.mode, practice: true, exam: e.id });
    },
    'exam-dir': el => { ui.examDraft.dir = el.dataset.v; render(); },
    'exam-lesson': el => {
      const s2 = new Set(ui.examDraft.lessons), l = el.dataset.lesson;
      s2.has(l) ? s2.delete(l) : s2.add(l);
      ui.examDraft.lessons = [...s2];
      render();
    },
    'exam-cancel': () => { const id = ui.examId; ui.examDraft = null; id && state.exams[id] ? go('exam', { examId: id }) : go('exams'); },
    'exam-save': () => {
      const d = ui.examDraft;
      d.title = ($('#exTitle')?.value ?? d.title).trim();
      if (!d.title) return toast('Gib dem Termin einen Titel');
      if (!d.date || d.date < today()) return toast('Wähle ein Datum ab heute');
      if (!Exams.cards(d).length) return toast('Wähle mindestens eine Lektion oder Vokabel');
      const ex = ui.examId ? state.exams[ui.examId] : null;
      let id;
      if (ex) {
        if (ex.date !== d.date) ex.target = targetReps(dayDiff(today(), d.date));
        Object.assign(ex, d, { updated: now() });
        id = ex.id;
      } else {
        id = uid();
        state.exams[id] = { id, ...d, target: targetReps(dayDiff(today(), d.date)), reps: {}, created: now(), updated: now() };
      }
      ui.examDraft = null;
      save();
      toast('Lernplan erstellt ✓');
      go('exam', { examId: id });
    },
    'exam-delete': () => {
      const e = state.exams[ui.examId];
      if (!e || !confirm(`Termin „${e.title}“ löschen?`)) return;
      e.deleted = true; e.updated = now();
      ui.examDraft = null;
      save(); toast('Termin gelöscht'); go('exams');
    },
    'edit-card': el => go('edit', { editId: el.dataset.id }),
    'delete-card': () => {
      const c = state.cards[ui.editId];
      if (!c || !confirm(`„${c.it}“ löschen?`)) return;
      c.deleted = true; c.updated = now();
      save(); toast('Gelöscht'); go('vocab');
    },
    'delete-lesson': () => {
      const l = ui.vocabLesson;
      const list = activeCards().filter(c => c.lesson === l);
      const pages = lessonPages(l);
      if (!confirm(`Lektion „${l}“ mit ${plural(list.length, 'Vokabel', 'Vokabeln')}${pages.length ? ` und ${plural(pages.length, 'Buchseite', 'Buchseiten')}` : ''} löschen?`)) return;
      list.forEach(c => { c.deleted = true; c.updated = now(); });
      pages.forEach(p => { p.deleted = true; p.updated = now(); });
      ui.vocabLesson = '';
      save(); toast('Lektion gelöscht'); render();
    },
    'page-tab': el => { ui.pageTab = el.dataset.v; render(); },
    'page-recognize': async () => {
      const id = ui.pageId;
      ui.pageVocabFor = null;
      try { await Pages.recognize(id); toast('Erkannt ✓'); } catch (e) { toast(e.message); }
    },
    'page-import': () => {
      const p = state.pages[ui.pageId];
      const lesson = ($('#pvTarget')?.value || '').trim();
      if (!lesson) return toast('Gib eine Lektion an');
      const rows = ($('#pvVocab')?.value || '').split(/\r?\n/).map(parseLine).filter(Boolean);
      if (!rows.length) return;
      const added = importRows(lesson, rows);
      p.imported = lesson;
      if (p.lesson === 'Unsortiert') { p.lesson = lesson; p.order = Math.max(0, ...lessonPages(lesson).map(x => x.order || 0)) + 1; }
      p.updated = now();
      save();
      ui.pageVocabFor = null;
      toast(`${plural(added, 'Vokabel', 'Vokabeln')} nach „${lesson}“ übernommen` + (added < rows.length ? ` (${rows.length - added} schon vorhanden)` : ''));
      render();
    },
    'do-import': () => {
      const lesson = ui.importLesson.trim();
      const rows = ui.importText.split(/\r?\n/).map(parseLine).filter(Boolean);
      if (!lesson || !rows.length) return;
      const added = importRows(lesson, rows);
      ui.importText = '';
      toast(`${plural(added, 'Vokabel', 'Vokabeln')} importiert` + (added < rows.length ? ` (${rows.length - added} schon vorhanden)` : ''));
      go('vocab', { vocabLesson: lesson, vocabSearch: '' });
    },
    'sync-now': () => Sync.run(),
    'sign-out': () => { if (confirm('Abmelden? Deine Daten bleiben auf diesem Gerät.')) { Sync.signOut(); render(); } },
    'sign-up': async () => {
      const f = $('#loginForm');
      if (!f.reportValidity()) return;
      try { toast(await Sync.signUp(f.email.value.trim(), f.pw.value)); render(); }
      catch (err) { toast(err.message); }
    },
    export: () => {
      const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `italiano-sicherung-${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    'import-file': () => $('#fileIn').click(),
    'push-on': async el => {
      el.disabled = true; el.textContent = 'Einen Moment …';
      try { await Push.enable(); toast('Mitteilungen eingeschaltet 🔔'); } catch (e) { toast(e.message); }
      Push.paint();
    },
    'push-off': async () => {
      try { await Push.disable(); toast('Mitteilungen ausgeschaltet'); } catch (e) { toast(e.message); }
      Push.paint();
    },
    'push-test': async el => {
      el.disabled = true;
      try { const n = await Push.test(); toast(n ? 'Test-Mitteilung geschickt ✓' : 'Kein Gerät erreicht'); } catch (e) { toast(e.message); }
      el.disabled = false;
    }
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const name = el.dataset.action;
    const fn = name.startsWith('s-') ? Session.actions[name] : actions[name];
    if (!fn) return;
    e.preventDefault();
    if (name === 'go' && Session.active()) return; // während der Abfrage nicht wegnavigieren
    fn(el);
  });
  document.addEventListener('keydown', e => Session.key(e));

  // ================= Start =================
  seed();
  render();
  Sync.run();
  Push.refresh();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Sync.run(); });
  window.addEventListener('online', () => Sync.run());
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Fürs Testen in der Konsole
  window.__italiano = { get state() { return state; }, checkAnswer, parseLine, Exams, dayDiff, addDays, targetReps, grade };
})();
