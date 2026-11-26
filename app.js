'use strict';
(() => {
  const CFG = window.APP_CONFIG || {};
  const STORE_KEY = 'italiano.v1';
  const AUTH_KEY = 'italiano.auth';
  const DAY = 86400000;
  // Lernsystem (Leitner): Fach 0 = neu/falsch, danach wachsende Abstände in Tagen.
  const INTERVALS = [0, 1, 3, 7, 14, 30, 60, 120];
  const MASTER_BOX = 4; // ab Fach 4 gilt eine Vokabel als "sicher"
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
    settings: { newPerDay: 10, sessionSize: 20, lessons: [], dir: 'de-it', mode: 'mix' },
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

  const newLeftToday = () => Math.max(0, state.settings.newPerDay - (state.days[today()]?.new || 0));

  function grade(card, dir, correct) {
    const k = pkey(card.id, dir);
    const p = state.progress[k] || { box: 0, seen: 0, right: 0, wrong: 0 };
    const ds = dayStats();
    if (!p.seen) ds.new++;
    ds.reviews++;
    if (correct) {
      ds.correct++;
      p.right++;
      p.box = Math.min(p.box + 1, INTERVALS.length - 1);
      p.due = startOfToday() + INTERVALS[p.box] * DAY;
    } else {
      p.wrong++;
      p.box = 0;
      p.due = now();
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

    return { configured, run, schedule, signIn, signUp, signOut, paint, info, user: () => auth?.user };
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
        practice: !!opts.practice
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
        if (S.practice && S.cur.ok && p && p.seen && p.due > now()) { const ds = dayStats(); ds.reviews++; ds.correct++; ds.updated = now(); }
        else grade(it.card, it.dir, S.cur.ok);
        S.results.push({ card: it.card, dir: it.dir, ok: S.cur.ok });
        save();
      }
      if (!S.cur.ok) {
        // Falsche Vokabel kommt in dieser Runde noch einmal dran (wird aber nur einmal bewertet)
        S.queue.splice(Math.min(3, S.queue.length), 0, { ...it, mode: it.mode === 'choice' ? 'choice' : it.mode });
      }
      next();
    }

    function stop() {
      S = null;
      document.body.classList.remove('in-session');
      go('home');
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
      's-again': () => { const items = S.lastWrong; S = null; start(shuffle(items), { mode: state.settings.mode }); }
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

  function startLearning(lessons, opts = {}) {
    const st = state.settings;
    const dir = opts.dir || st.dir;
    const mode = opts.mode || st.mode;
    const { due, fresh } = pool(lessons, dir);
    let items;
    if (opts.practice) {
      // im Test-Modus: alle Vokabeln der Auswahl, egal ob fällig
      const want = lessons && lessons.length ? new Set(lessons) : null;
      items = [];
      for (const c of activeCards()) if (!want || want.has(c.lesson)) for (const d of dirsFor(dir)) items.push({ card: c, dir: d });
      shuffle(items);
    } else {
      items = due.slice(0, st.sessionSize);
      const room = Math.min(st.sessionSize - items.length, newLeftToday());
      if (room > 0) items = items.concat(fresh.slice(0, room));
      shuffle(items);
    }
    Session.start(items, { mode, practice: opts.practice });
  }

  // ================= Ansichten =================
  let route = 'home';
  let ui = { vocabLesson: '', vocabSearch: '', editId: null, formLesson: '', importLesson: '', importText: '' };

  function setTitle(t) { $('#title').textContent = t; document.title = t === 'Italiano' ? 'Italiano' : t + ' · Italiano'; }

  function go(r, params = {}) {
    route = r;
    Object.assign(ui, params);
    if (Session.active() && !r.startsWith('session')) { /* Session läuft weiter */ }
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    if (Session.active()) return; // Session zeichnet sich selbst
    $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.to === route || (route === 'edit' || route === 'import') && b.dataset.to === 'vocab'));
    const v = $('#view');
    const views = { home: viewHome, learn: viewLearn, vocab: viewVocab, edit: viewEdit, import: viewImport, more: viewMore };
    (views[route] || viewHome)(v);
    Sync.paint();
  }

  // ---------- Start ----------
  function viewHome(v) {
    setTitle('Italiano');
    const st = state.settings;
    const { due, fresh } = pool(st.lessons, st.dir);
    const newCount = Math.min(fresh.length, newLeftToday());
    const ds = state.days[today()] || { reviews: 0 };
    const cards = activeCards();
    let mastered = 0;
    for (const c of cards) for (const d of ['de-it', 'it-de']) if ((prog(c.id, d)?.box || 0) >= MASTER_BOX) mastered++;
    const lessons = lessonMap();
    const scope = st.lessons.length ? plural(st.lessons.length, 'Lektion', 'Lektionen') : 'alle Lektionen';
    const todo = Math.min(due.length, st.sessionSize) + Math.min(newCount, Math.max(0, st.sessionSize - due.length));

    v.innerHTML = `
      <div class="card hero">
        <div style="font-weight:600;margin-bottom:10px">Ciao${CFG.name ? ' ' + esc(CFG.name) : ''}! 👋</div>
        <div class="row" style="align-items:flex-end;gap:18px">
          <div><div class="big-num">${due.length}</div><div class="muted small">fällig</div></div>
          <div><div class="big-num" style="font-size:30px">${newCount}</div><div class="muted small">neu heute</div></div>
        </div>
        <div class="muted small" style="margin:10px 0 14px">${esc(scope)} · ${esc(DIR_LABEL[st.dir] || 'beide Richtungen')}</div>
        <div class="row">
          <button class="btn big spacer" data-action="learn-now" ${todo ? '' : 'disabled'}>${todo ? `Jetzt lernen (${todo})` : 'Alles erledigt ✓'}</button>
          <button class="btn big ghost" data-action="go" data-to="learn">Auswahl</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>🔥 ${streak()}</b><span>Tage Streak</span></div>
        <div class="stat"><b>${ds.reviews || 0}</b><span>Abfragen heute</span></div>
        <div class="stat"><b>${mastered}</b><span>sicher von ${cards.length * 2}</span></div>
      </div>
      <div class="section-title">Lektionen</div>
      <div class="card">
        ${lessons.size ? [...lessons.entries()].map(([name, list]) => {
          const p = pool([name], st.dir);
          return `<div class="lesson">
            <div class="info">
              <div class="name">${esc(name)}</div>
              <div class="small muted">${plural(list.length, 'Vokabel', 'Vokabeln')}${p.due.length ? ` · <b style="color:var(--green)">${p.due.length} fällig</b>` : ''}</div>
              <div class="bar"><i style="width:${Math.round(masteredShare(list) * 100)}%"></i></div>
            </div>
            <button class="btn small" data-action="learn-lesson" data-lesson="${esc(name)}">Lernen</button>
          </div>`;
        }).join('') : `<div class="empty">Noch keine Vokabeln. <a href="#" data-action="go" data-to="import">Liste importieren</a></div>`}
      </div>`;
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
        <button class="btn primary block big" data-action="learn-now" ${due.length + Math.min(fresh.length, newLeftToday()) ? '' : 'disabled'}>
          Lernen: ${due.length} fällig + ${Math.min(fresh.length, newLeftToday())} neu
        </button>
        <p class="small muted" style="margin:8px 2px 14px">Das Lernsystem fragt Wörter, die du gut kannst, immer seltener ab.</p>
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

  function drawVocabList() {
    const q = noAccent(norm(ui.vocabSearch));
    const list = activeCards()
      .filter(c => !ui.vocabLesson || c.lesson === ui.vocabLesson)
      .filter(c => !q || noAccent(norm(c.it + ' ' + c.de)).includes(q))
      .sort((a, b) => a.lesson.localeCompare(b.lesson, 'de', { numeric: true }) || (a.created || 0) - (b.created || 0));
    const dots = c => {
      const b = Math.max(prog(c.id, 'de-it')?.box || 0, 0) + Math.max(prog(c.id, 'it-de')?.box || 0, 0);
      const n = Math.min(5, Math.round(b / 2));
      return `<div class="dots" title="Lernstand">${[0, 1, 2, 3, 4].map(i => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;
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
    const lessons = [...lessonMap().keys()];
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

  function viewImport(v) {
    setTitle('Liste importieren');
    const lessons = [...lessonMap().keys()];
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

      <div class="section-title">Lernen</div>
      <div class="card">
        <label class="field"><span>Neue Vokabeln pro Tag</span><input type="number" min="0" max="100" id="setNew" value="${st.newPerDay}"></label>
        <label class="field" style="margin-bottom:0"><span>Abfragen pro Runde</span><input type="number" min="5" max="200" id="setSize" value="${st.sessionSize}"></label>
      </div>

      <div class="section-title">Sicherung</div>
      <div class="card">
        <p class="small muted" style="margin-top:0">Alle Vokabeln und dein Lernstand als Datei.</p>
        <div class="row"><button class="btn spacer" data-action="export">Sichern</button><button class="btn spacer" data-action="import-file">Wiederherstellen</button></div>
        <input type="file" id="fileIn" accept=".json,application/json" hidden>
      </div>

      <div class="section-title">Als App installieren</div>
      <div class="card small">
        <p style="margin-top:0"><b>iPhone / iPad:</b> In Safari öffnen → Teilen-Symbol → „Zum Home-Bildschirm“.</p>
        <p style="margin-bottom:0"><b>PC:</b> In Chrome oder Edge rechts in der Adressleiste auf „App installieren“ klicken.</p>
      </div>
      <p class="small muted" style="text-align:center">Italiano · Version 1.1</p>`;

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
    num('#setNew', 'newPerDay', 0, 100);
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
    'learn-now': () => startLearning(state.settings.lessons),
    'learn-lesson': el => startLearning([el.dataset.lesson]),
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
      if (!confirm(`Lektion „${l}“ mit ${list.length} Vokabeln löschen?`)) return;
      list.forEach(c => { c.deleted = true; c.updated = now(); });
      ui.vocabLesson = '';
      save(); toast('Lektion gelöscht'); render();
    },
    'do-import': () => {
      const lesson = ui.importLesson.trim();
      const rows = ui.importText.split(/\r?\n/).map(parseLine).filter(Boolean);
      if (!lesson || !rows.length) return;
      const existing = new Set(activeCards().filter(c => c.lesson === lesson).map(c => norm(c.it)));
      let added = 0, t = now();
      for (const r of rows) {
        if (existing.has(norm(r.it))) continue;
        const id = uid();
        state.cards[id] = { id, it: r.it, de: r.de, note: r.note, lesson, created: t + added, updated: t };
        existing.add(norm(r.it));
        added++;
      }
      save();
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
    'import-file': () => $('#fileIn').click()
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
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Sync.run(); });
  window.addEventListener('online', () => Sync.run());
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Fürs Testen in der Konsole
  window.__italiano = { get state() { return state; }, checkAnswer, parseLine };
})();
