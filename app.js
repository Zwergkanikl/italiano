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
    gtopics: {},    // Grammatik-Themen: id -> {id, title, lesson, explanation, created, updated, deleted}
    gitems: {},     // Grammatik-Übungen: id -> {id, topicId, type: gap|choice|translate, prompt, answer, options, hint, created, updated, deleted}
    exams: {},      // id -> {id, title, date, lessons, cardIds, dir, notify, target, reps, planCounts, created, updated, deleted}
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


  // ================= Konjugation =================
  const PERSONS = ['io', 'tu', 'lui/lei', 'noi', 'voi', 'loro'];
  const TENSES = { presente: 'Presente', passato: 'Passato prossimo', imperfetto: 'Imperfetto', futuro: 'Futuro' };
  const IRR_PRES = {
    essere: 'sono sei è siamo siete sono', avere: 'ho hai ha abbiamo avete hanno', fare: 'faccio fai fa facciamo fate fanno',
    andare: 'vado vai va andiamo andate vanno', venire: 'vengo vieni viene veniamo venite vengono', stare: 'sto stai sta stiamo state stanno',
    dare: 'do dai dà diamo date danno', dire: 'dico dici dice diciamo dite dicono', potere: 'posso puoi può possiamo potete possono',
    volere: 'voglio vuoi vuole vogliamo volete vogliono', dovere: 'devo devi deve dobbiamo dovete devono', sapere: 'so sai sa sappiamo sapete sanno',
    uscire: 'esco esci esce usciamo uscite escono', bere: 'bevo bevi beve beviamo bevete bevono', rimanere: 'rimango rimani rimane rimaniamo rimanete rimangono',
    tenere: 'tengo tieni tiene teniamo tenete tengono', salire: 'salgo sali sale saliamo salite salgono', scegliere: 'scelgo scegli sceglie scegliamo scegliete scelgono',
    piacere: 'piaccio piaci piace piacciamo piacete piacciono', tradurre: 'traduco traduci traduce traduciamo traducete traducono',
    morire: 'muoio muori muore moriamo morite muoiono', sedere: 'siedo siedi siede sediamo sedete siedono', togliere: 'tolgo togli toglie togliamo togliete tolgono',
    porre: 'pongo poni pone poniamo ponete pongono', produrre: 'produco produci produce produciamo producete producono'
  };
  const IMPF_STEM = { fare: 'fac', dire: 'dic', bere: 'bev', tradurre: 'traduc', produrre: 'produc', porre: 'pon' };
  const IRR_FUT = {
    essere: 'sar', avere: 'avr', andare: 'andr', fare: 'far', dare: 'dar', stare: 'star', venire: 'verr', volere: 'vorr', potere: 'potr',
    dovere: 'dovr', sapere: 'sapr', vedere: 'vedr', vivere: 'vivr', bere: 'berr', rimanere: 'rimarr', tenere: 'terr', dire: 'dir',
    cadere: 'cadr', tradurre: 'tradurr', produrre: 'produrr', porre: 'porr'
  };
  const PART = {
    essere: 'stato', fare: 'fatto', dire: 'detto', prendere: 'preso', mettere: 'messo', vedere: 'visto', leggere: 'letto', scrivere: 'scritto',
    aprire: 'aperto', chiudere: 'chiuso', rispondere: 'risposto', chiedere: 'chiesto', bere: 'bevuto', venire: 'venuto', rimanere: 'rimasto',
    nascere: 'nato', morire: 'morto', scendere: 'sceso', perdere: 'perso', vivere: 'vissuto', correre: 'corso', decidere: 'deciso',
    offrire: 'offerto', ridere: 'riso', spendere: 'speso', accendere: 'acceso', succedere: 'successo', piacere: 'piaciuto',
    conoscere: 'conosciuto', vincere: 'vinto', spegnere: 'spento', scegliere: 'scelto', tradurre: 'tradotto', rompere: 'rotto',
    piangere: 'pianto', dipingere: 'dipinto', produrre: 'prodotto', porre: 'posto', togliere: 'tolto', muovere: 'mosso', soffrire: 'sofferto',
    discutere: 'discusso', dividere: 'diviso', esprimere: 'espresso', giungere: 'giunto', nascondere: 'nascosto', ottenere: 'ottenuto',
    raggiungere: 'raggiunto', sorridere: 'sorriso', uccidere: 'ucciso', apparire: 'apparso', coprire: 'coperto', scoprire: 'scoperto'
  };
  const ESSERE_VERBS = new Set(['andare', 'venire', 'essere', 'stare', 'arrivare', 'partire', 'tornare', 'ritornare', 'uscire', 'entrare', 'restare',
    'rimanere', 'nascere', 'morire', 'diventare', 'cadere', 'piacere', 'succedere', 'costare', 'riuscire', 'salire', 'scendere', 'apparire', 'sembrare', 'bastare', 'durare']);
  const ISC = new Set(['capire', 'finire', 'preferire', 'pulire', 'spedire', 'costruire', 'colpire', 'sparire', 'unire', 'ubbidire', 'suggerire',
    'restituire', 'tradire', 'impedire', 'fornire', 'gestire', 'guarire', 'proibire', 'inserire', 'garantire', 'reagire', 'stabilire', 'distribuire', 'sostituire', 'definire', 'agire']);
  const REFL = ['mi', 'ti', 'si', 'ci', 'vi', 'si'];

  // Liefert 6 Formen (io … loro) oder null. Formen können Varianten mit ";" enthalten (z. B. andato/andata).
  function conjugate(infRaw, tense) {
    let inf = String(infRaw || '').trim().toLowerCase();
    const reflexive = /(arsi|ersi|irsi|ursi|orsi)$/.test(inf);
    if (reflexive) inf = inf.slice(0, -2) + 'e';
    const end = inf.slice(-3), stem = inf.slice(0, -3);
    const known = /^[a-zàèéìòù]+(are|ere|ire)$/.test(inf) || IRR_PRES[inf];
    if (!known || !TENSES[tense]) return null;
    let forms;
    if (tense === 'presente') {
      if (IRR_PRES[inf]) forms = IRR_PRES[inf].split(' ');
      else if (end === 'are') {
        const iStem = stem.endsWith('i'), h = /[cg]$/.test(stem) ? 'h' : '';
        const tu = iStem ? stem : stem + h + 'i';
        forms = [stem + 'o', tu, stem + 'a', tu + 'amo', stem + 'ate', stem + 'ano'];
      } else if (end === 'ere') forms = [stem + 'o', stem + 'i', stem + 'e', stem + 'iamo', stem + 'ete', stem + 'ono'];
      else if (ISC.has(inf)) forms = [stem + 'isco', stem + 'isci', stem + 'isce', stem + 'iamo', stem + 'ite', stem + 'iscono'];
      else forms = [stem + 'o', stem + 'i', stem + 'e', stem + 'iamo', stem + 'ite', stem + 'ono'];
    } else if (tense === 'imperfetto') {
      if (inf === 'essere') forms = 'ero eri era eravamo eravate erano'.split(' ');
      else if (IMPF_STEM[inf]) forms = ['evo', 'evi', 'eva', 'evamo', 'evate', 'evano'].map(e => IMPF_STEM[inf] + e);
      else { const vow = { are: 'a', ere: 'e', ire: 'i' }[end]; forms = ['vo', 'vi', 'va', 'vamo', 'vate', 'vano'].map(e => stem + vow + e); }
    } else if (tense === 'futuro') {
      let fs = IRR_FUT[inf];
      if (!fs) {
        if (end === 'are') fs = (/[cg]i$/.test(stem) ? stem.slice(0, -1) : /[cg]$/.test(stem) ? stem + 'h' : stem) + 'er';
        else fs = stem + (end === 'ere' ? 'er' : 'ir');
      }
      forms = ['ò', 'ai', 'à', 'emo', 'ete', 'anno'].map(e => fs + e);
    } else if (tense === 'passato') {
      const part = PART[inf] || (end === 'are' ? stem + 'ato' : end === 'ere' ? stem + 'uto' : end === 'ire' ? stem + 'ito' : null);
      if (!part) return null;
      const ess = reflexive || ESSERE_VERBS.has(inf);
      if (!ess) return ['ho', 'hai', 'ha', 'abbiamo', 'avete', 'hanno'].map(a => a + ' ' + part);
      const base = part.slice(0, -1);
      return ['sono', 'sei', 'è', 'siamo', 'siete', 'sono'].map((a, i) => {
        const v = i < 3 ? [base + 'o', base + 'a'] : [base + 'i', base + 'e'];
        return v.map(x => (reflexive ? REFL[i] + ' ' : '') + a + ' ' + x).join('; ');
      });
    }
    return reflexive ? forms.map((f, i) => REFL[i] + ' ' + f) : forms;
  }

  // Ist eine Vokabel ein Verb (Infinitiv)? → Infinitiv oder null
  function verbOf(c) {
    const w = String(c.it || '').split(';')[0].replace(/\([^)]*\)/g, '').trim().toLowerCase();
    if (!/^[a-zàèéìòù]+(are|ere|ire|arsi|ersi|irsi|urre|orre|ursi)$/.test(w)) return null;
    return conjugate(w, 'presente') ? w : null;
  }
  const conjTenses = () => (state.settings.conjTenses && state.settings.conjTenses.length) ? state.settings.conjTenses : ['presente'];
  function conjCard(c, verb, tense) {
    const forms = conjugate(verb, tense);
    if (!forms) return null;
    return { id: `c:${c.id}:${tense}`, de: verb, it: forms.join(', '), note: c.de, lesson: c.lesson, grammar: true, gtype: 'conj', forms, verb, tense };
  }
  // automatisch erzeugte Konjugationsübungen aus den Vokabeln
  function conjItems(lessons) {
    const want = lessons && lessons.length ? new Set(lessons) : null;
    const out = [];
    for (const c of activeCards()) {
      if (want && !want.has(c.lesson)) continue;
      const v = verbOf(c);
      if (!v) continue;
      for (const t of conjTenses()) { const cc = conjCard(c, v, t); if (cc) out.push({ card: cc, dir: 'de-it' }); }
    }
    return out;
  }

  // ---------- Grammatik als "Karten" ----------
  const activeTopics = () => Object.values(state.gtopics || {}).filter(t => !t.deleted);
  const activeGItems = (topicId) => Object.values(state.gitems || {}).filter(i => !i.deleted && state.gtopics[i.topicId] && !state.gtopics[i.topicId].deleted && (!topicId || i.topicId === topicId));
  // Übung → kartenähnliches Objekt für die Abfrage (Frage = "de", Lösung = "it")
  function gCard(i) {
    const t = state.gtopics[i.topicId] || {};
    if (i.type === 'conj') return { id: 'g:' + i.id, de: i.prompt, it: (i.options || []).join(', '), note: '', lesson: t.lesson || '', grammar: true, topicId: i.topicId, gtype: 'conj', forms: i.options || [], verb: i.prompt, tense: i.hint };
    return { id: 'g:' + i.id, de: i.prompt, it: i.answer, note: i.hint || '', lesson: t.lesson || '', grammar: true, topicId: i.topicId, gtype: i.type, options: i.options || [] };
  }
  const allLessons = () => [...new Set([...lessonMap().keys(), ...activeTopics().map(t => t.lesson).filter(Boolean)])]
    .sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
  // Alle lernbaren Einheiten der Auswahl; content: vocab | grammar | both
  function learnables(lessons, dir, content = state.settings.content || 'vocab') {
    const want = lessons && lessons.length ? new Set(lessons) : null;
    const out = [];
    if (content !== 'grammar') for (const c of activeCards()) if (!want || want.has(c.lesson)) for (const d of dirsFor(dir)) out.push({ card: c, dir: d });
    if (content !== 'vocab') for (const i of activeGItems()) { const g = gCard(i); if (!want || want.has(g.lesson)) out.push({ card: g, dir: 'de-it' }); }
    if (content !== 'vocab' && state.settings.conjAuto !== false) out.push(...conjItems(lessons));
    return out;
  }

  // Fällige und neue Abfragen für eine Auswahl von Lektionen
  function pool(lessons, dir, content) {
    const t = now(), due = [], fresh = [];
    for (const it of learnables(lessons, dir, content)) {
      const p = prog(it.card.id, it.dir);
      if (!p || !p.seen) fresh.push(it);
      else if (p.due <= t) due.push({ ...it, due: p.due });
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
    for (const key of ['gtopics', 'gitems']) {
      out[key] = { ...(local[key] || {}) };
      for (const [k, v] of Object.entries(remote[key] || {})) out[key][k] = newer(out[key][k], v);
    }
    out.exams = { ...(local.exams || {}) };
    for (const [k, v] of Object.entries(remote.exams || {})) out.exams[k] = newer(out.exams[k], v);
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
  function checkAnswer(input, answer, lang, strict = false) {
    const inp = norm(input);
    if (!inp) return { ok: false };
    if (strict) {
      // Grammatik: Artikel & Endungen zählen – nur Akzentfehler werden verziehen
      for (const v of variants(answer)) {
        if (inp === v) return { ok: true };
        if (noAccent(inp) === noAccent(v)) return { ok: true, hint: `Achte auf den Akzent: ${v}` };
      }
      for (const v of variants(answer)) if (v.length >= 4 && lev(noAccent(inp), noAccent(v)) === 1) return { ok: false, close: true };
      return { ok: false };
    }
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


  // ================= Foto-Scan (Texterkennung mit Tesseract, kostenlos im Browser) =================
  const Scan = (() => {
    const LIB = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    let workerP = null;
    let onLog = null;
    const median = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };

    function loadLib() {
      if (window.Tesseract) return Promise.resolve();
      return new Promise((res, rej) => {
        const el = document.createElement('script');
        el.src = LIB;
        el.onload = res;
        el.onerror = () => rej(new Error('Texterkennung konnte nicht geladen werden. Bist du online?'));
        document.head.appendChild(el);
      });
    }

    async function worker() {
      await loadLib();
      if (!workerP) workerP = Tesseract.createWorker(['ita', 'deu'], 1, { logger: m => onLog && onLog(m) })
        .catch(e => { workerP = null; throw e; });
      return workerP;
    }

    // Foto laden, verkleinern, in Graustufen mit mehr Kontrast
    function prepare(file) {
      return new Promise((res, rej) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * scale);
          c.height = Math.round(img.naturalHeight * scale);
          const g = c.getContext('2d');
          g.filter = 'grayscale(1) contrast(1.4)';
          g.drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          res(c);
        };
        img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Das Bild konnte nicht geöffnet werden.')); };
        img.src = url;
      });
    }

    function linesOf(data) {
      if (data.lines && data.lines.length && data.lines[0].words) return data.lines;
      const out = [];
      for (const b of data.blocks || []) for (const pa of b.paragraphs || []) for (const l of pa.lines || []) out.push(l);
      return out;
    }

    // Wörter einer Zeile an großen Lücken trennen, Spalten über die Startpositionen finden
    function analyze(lines, W) {
      const raw = [];
      for (const l of lines) {
        const ws = (l.words || []).filter(w => w.text && w.text.trim() && (w.confidence ?? 100) > 15)
          .sort((a, b) => a.bbox.x0 - b.bbox.x0);
        if (!ws.length) continue;
        const h = median(ws.map(w => w.bbox.y1 - w.bbox.y0)) || 20;
        const parts = [];
        let cur = null;
        for (const w of ws) {
          if (cur && w.bbox.x0 - cur.x1 > Math.max(h * 1.5, W * 0.025)) { parts.push(cur); cur = null; }
          if (!cur) cur = { x0: w.bbox.x0, x1: w.bbox.x1, text: w.text.trim() };
          else { cur.x1 = w.bbox.x1; cur.text += ' ' + w.text.trim(); }
        }
        parts.push(cur);
        raw.push(parts);
      }
      const tol = W * 0.06;
      const xs = raw.flatMap(r => r.map(q => q.x0)).sort((a, b) => a - b);
      const clusters = [];
      for (const x of xs) {
        const c = clusters[clusters.length - 1];
        if (c && x - c.max <= tol) { c.max = x; c.n++; } else clusters.push({ min: x, max: x, n: 1 });
      }
      const minN = Math.max(2, raw.length * 0.2);
      let cols = clusters.filter(c => c.n >= minN).map(c => c.min);
      if (!cols.length) cols = [0];
      const rows = raw.map(parts => {
        const cells = cols.map(() => '');
        for (const q of parts) {
          let i = 0;
          for (let k = 0; k < cols.length; k++) if (q.x0 >= cols[k] - tol) i = k;
          cells[i] = cells[i] ? cells[i] + ' ' + q.text : q.text;
        }
        return cells;
      });
      // Zeilen ohne erste Spalte gehören meist zur Zeile davor (Umbruch)
      const merged = [];
      for (const cells of rows) {
        if (merged.length && cols.length > 1 && !cells[0]) {
          const prev = merged[merged.length - 1];
          cells.forEach((t, i) => { if (t) prev[i] = prev[i] ? prev[i] + ' ' + t : t; });
        } else merged.push(cells);
      }
      if (cols.length === 1) {
        // Nur eine Spalte erkannt: vielleicht "italienisch - deutsch" in einer Zeile
        return { cols: 2, rows: merged.map(c => { const r = parseLine(c[0]); return r ? [r.it, r.de] : [c[0], '']; }) };
      }
      return { cols: cols.length, rows: merged };
    }

    const defaultMap = n => Array.from({ length: n }, (_, i) => i === 0 ? 'it' : i === n - 1 ? 'de' : (n === 3 ? 'note' : 'skip'));

    async function recognize(file) {
      const w = await worker();
      const canvas = await prepare(file);
      const { data } = await w.recognize(canvas);
      const res = analyze(linesOf(data), canvas.width);
      const map = defaultMap(res.cols);
      return {
        cols: res.cols, map,
        thumb: canvas.toDataURL('image/jpeg', 0.5),
        rows: res.rows.map(cells => ({ cells, on: !!(cells[map.indexOf('it')] && cells[map.indexOf('de')]) }))
      };
    }

    return { recognize, setLog: f => { onLog = f; }, analyze };
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
      if (it.card.gtype === 'conj') return 'table';
      if (it.card.gtype === 'order') return 'order';
      if (it.card.grammar) return it.card.gtype === 'choice' ? 'choice' : (mode === 'flip' ? 'flip' : 'type');
      if (mode === 'mix') {
        const p = prog(it.card.id, it.dir);
        return (!p || p.box < 2) ? 'choice' : 'type';
      }
      return mode;
    }

    function next() {
      if (!S.queue.length) { S.phase = 'end'; draw(); return; }
      const it = S.queue[0];
      S.cur = { ...it, answered: false, ok: null, input: it.mode === 'table' ? [] : '', hint: '', close: false };
      S.showRule = false;
      S.lastInput = null;
      if (S.cur.mode === 'order') {
        const tiles = it.card.options || [];
        let ord = tiles.map((_, i) => i);
        for (let k = 0; k < 6; k++) { shuffle(ord); if (ord.some((x, i) => x !== i)) break; }
        S.cur.order = ord; S.cur.picked = [];
      }
      if (it.mode === 'choice') {
        S.cur.options = it.card.grammar ? shuffle(it.card.options.slice()) : buildOptions(it);
        if (!S.cur.options || S.cur.options.length < 2) S.cur.mode = 'type';
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
      } else if (it.mode === 'order') {
        const tiles = it.card.options || [];
        const used = new Set(it.picked);
        body = `<div class="card order-card">
          <div class="order-line ${it.answered ? (it.ok ? 'ok' : 'bad') : ''}">${it.picked.length ? it.picked.map((ti, pos) => `<button class="tile on" data-action="s-untile" data-k="${pos}" ${it.answered ? 'disabled' : ''}>${esc(tiles[ti])}</button>`).join('') : '<span class="muted small">Tippe die Wörter in der richtigen Reihenfolge an</span>'}</div>
          ${it.answered ? '' : `<div class="order-pool">${it.order.map(ti => used.has(ti) ? `<span class="tile ghost">${esc(tiles[ti])}</span>` : `<button class="tile" data-action="s-tile" data-i="${ti}">${esc(tiles[ti])}</button>`).join('')}</div>`}
        </div>
        ${it.answered ? '' : `<div class="row" style="margin-top:4px"><button class="btn" data-action="s-skip">Weiß ich nicht</button><button class="btn" data-action="s-untile-all">↺</button><button class="btn primary spacer" data-action="s-check" ${it.picked.length ? '' : 'disabled'}>Prüfen</button></div>`}`;
      } else if (it.mode === 'table') {
        const vals = it.input || [];
        body = `<div class="card conj-card">${PERSONS.map((pe, i) => {
          const cls = it.answered ? (it.cells && it.cells[i] ? 'ok' : 'bad') : '';
          return `<div class="conj-row ${cls}"><span class="conj-p">${pe}</span>
            <input class="conj-input" data-i="${i}" type="text" lang="it" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${esc(vals[i] || '')}" ${it.answered ? 'readonly' : ''}>
            ${it.answered && !(it.cells && it.cells[i]) ? `<span class="conj-sol">${esc(it.card.forms[i].split(';')[0].trim())}</span>` : ''}</div>`;
        }).join('')}</div>
          ${!it.answered ? `<div class="accents">${['à', 'è', 'é', 'ì', 'ò', 'ù'].map(a => `<button data-action="s-accent" data-ch="${a}">${a}</button>`).join('')}</div>
          <div class="row" style="margin-top:12px"><button class="btn" data-action="s-skip">Weiß ich nicht</button><button class="btn primary spacer" data-action="s-check">Prüfen</button></div>` : ''}`;
      } else if (it.mode === 'choice') {
        const right = answerOf(it);
        body = `<div class="choices">${it.options.map((o, i) => {
          let cls = '';
          if (it.answered) { if (o === right) cls = 'right'; else if (o === it.input) cls = 'wrong'; }
          return `<button class="choice ${cls}" data-action="s-choose" data-i="${i}" ${it.answered ? 'disabled' : ''}>${esc(o)}</button>`;
        }).join('')}</div>`;
      }

      let fb = '';
      if (it.answered && it.mode === 'table') {
        const n = (it.cells || []).filter(Boolean).length;
        fb = it.ok ? `<div class="feedback ok"><div class="title">Richtig! Alle 6 Formen 🎉</div>${it.hint ? `<div>${esc(it.hint)}</div>` : ''}</div>`
          : `<div class="feedback bad"><div class="title">${n} von 6 richtig</div><div class="small">Die richtige Form steht jeweils unter dem Fehler.</div>
             ${n ? `<button class="btn small" style="margin-top:8px" data-action="s-override">Ich hatte recht</button>` : ''}</div>`;
      } else if (it.answered && it.mode !== 'flip') {
        const sol = answerOf(it);
        fb = it.ok
          ? `<div class="feedback ok"><div class="title">Richtig!</div>${it.hint ? `<div>${esc(it.hint)}</div>` : ''}${it.mode !== 'choice' && !variants(sol).includes(norm(it.input)) ? `<div class="small muted">Lösung: ${esc(sol)}</div>` : ''}</div>`
          : `<div class="feedback bad"><div class="title">${it.close ? 'Fast! Kleiner Fehler.' : 'Leider falsch'}</div><div class="solution">${esc(sol.split(/\s*;\s*/).join(' / '))}</div>
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
          <div class="prompt-label">${it.card.gtype === 'conj' ? '🔁 Konjugiere · ' + esc(TENSES[it.card.tense] || '') : it.card.grammar ? '📘 ' + esc(state.gtopics[it.card.topicId]?.title || 'Grammatik') : DIR_LABEL[it.dir]}${isNew ? '<span class="new-badge">NEU</span>' : ''}</div>
          <div class="prompt">${esc(promptOf(it))}</div>
          ${it.card.note && (it.answered || it.dir === 'de-it') ? `<div class="prompt-note">${esc(it.card.note)}</div>` : ''}
          ${promptIsIt ? `<button class="speak" data-action="speak" data-text="${esc(it.card.it)}" aria-label="Vorlesen">🔊</button>` : ''}
          ${it.card.grammar && state.gtopics[it.card.topicId]?.explanation ? `<div><button class="btn small" style="margin-top:10px" data-action="s-rule">💡 ${S.showRule ? 'Regel ausblenden' : 'Regel zeigen'}</button></div>
            ${S.showRule ? `<div class="rule-box">${mdLite(state.gtopics[it.card.topicId].explanation)}</div>` : ''}` : ''}
          ${it.mode === 'flip' && it.answered ? `<div class="reveal">${esc(answerOf(it))}
            ${!promptIsIt ? `<div><button class="speak" data-action="speak" data-text="${esc(it.card.it)}">🔊</button></div>` : ''}</div>` : ''}
        </div>
        ${body}
        ${fb}
        ${it.answered && it.mode !== 'flip' && it.mode !== 'table' && !promptIsIt ? `<div style="text-align:center;margin-bottom:12px"><button class="btn small" data-action="speak" data-text="${esc(it.card.it)}">🔊 Anhören</button></div>` : ''}
        ${actions}`;

      const inp = $('#answer');
      const cins = $$('.conj-input');
      if (cins.length && !it.answered) {
        cins.forEach(ci => {
          ci.addEventListener('input', () => { S.cur.input[+ci.dataset.i] = ci.value; });
          ci.addEventListener('focus', () => { S.lastInput = ci; });
        });
        const firstEmpty = cins.find(ci => !ci.value) || cins[0];
        firstEmpty.focus();
      } else if (inp && !it.answered) {
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
        if (S.cur.mode === 'order') {
          const tiles = S.cur.card.options || [];
          const val = S.cur.picked.map(i => tiles[i]).join(' ');
          if (!val) return;
          const r = checkAnswer(val, answerOf(S.cur), 'it', true);
          answer(r.ok, { input: val, hint: r.hint || '' });
          return;
        }
        if (S.cur.mode === 'table') {
          const vals = $$('.conj-input').map(ci => ci.value);
          if (!vals.some(x => norm(x))) { toast('Erst etwas eintippen – oder „Weiß ich nicht“'); return; }
          const res = S.cur.card.forms.map((f, i) => checkAnswer(vals[i], f, 'it', true));
          const cells = res.map(r => r.ok);
          const hint = res.some(r => r.ok && r.hint) ? 'Achte auf die Akzente.' : '';
          answer(cells.every(Boolean), { input: vals, cells, hint });
          return;
        }
        const inp = $('#answer');
        const val = inp ? inp.value : S.cur.input;
        if (!norm(val)) { toast('Erst etwas eintippen – oder „Weiß ich nicht“'); return; }
        const r = checkAnswer(val, answerOf(S.cur), S.cur.dir === 'de-it' ? 'it' : 'de', !!S.cur.card.grammar);
        answer(r.ok, { input: val, hint: r.hint || '', close: !!r.close });
      },
      's-skip': () => answer(false, { input: S.cur.mode === 'table' ? [] : '', cells: [] }),
      's-accent': el => {
        const inp = (S.lastInput && document.body.contains(S.lastInput)) ? S.lastInput : $('#answer');
        if (!inp) return;
        const s = inp.selectionStart ?? inp.value.length, e = inp.selectionEnd ?? s;
        inp.value = inp.value.slice(0, s) + el.dataset.ch + inp.value.slice(e);
        if (inp.classList.contains('conj-input')) S.cur.input[+inp.dataset.i] = inp.value; else S.cur.input = inp.value;
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
      's-rule': () => { S.showRule = !S.showRule; draw(); },
      's-tile': el => { if (!S.cur.answered) { S.cur.picked.push(+el.dataset.i); draw(); } },
      's-untile': el => { if (!S.cur.answered) { S.cur.picked.splice(+el.dataset.k, 1); draw(); } },
      's-untile-all': () => { if (!S.cur.answered) { S.cur.picked = []; draw(); } },
      's-again': () => { const items = S.lastWrong, exam = S.exam, random = S.random, mode = S.mode || state.settings.mode; S = null; start(shuffle(items), { mode, exam, random, practice: !!exam || random }); }
    };

    function key(e) {
      if (!S) return;
      if (S.phase === 'end') return;
      const it = S.cur;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!it.answered && it.mode === 'order') { if (it.picked.length) actions['s-check'](); return; }
        if (!it.answered && it.mode === 'table') {
          const a = document.activeElement;
          if (a && a.classList.contains('conj-input') && +a.dataset.i < 5) $$('.conj-input')[+a.dataset.i + 1].focus();
          else actions['s-check']();
          return;
        }
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
      const ls = new Set(e.lessons || []), ids = new Set(e.cardIds || []), tids = new Set(e.topicIds || []);
      const vocab = activeCards().filter(c => ls.has(c.lesson) || ids.has(c.id))
        .sort((a, b) => a.lesson.localeCompare(b.lesson, 'de', { numeric: true }) || (a.created || 0) - (b.created || 0));
      const gram = tids.size ? activeGItems().filter(i => tids.has(i.topicId)).sort((a, b) => (a.created || 0) - (b.created || 0)).map(gCard) : [];
      const conj = [];
      if (e.conj) for (const c of vocab) { const vb = verbOf(c); if (vb) for (const t of conjTenses()) { const cc = conjCard(c, vb, t); if (cc) conj.push(cc); } }
      // reißverschlussartig mischen, damit von Anfang an Vokabeln und Grammatik drankommen
      const out = [], lists = [vocab, gram, conj];
      for (let i = 0; out.length < vocab.length + gram.length + conj.length; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
      return out;
    },
    // Abfragen pro Einheit: Vokabeln je Richtung, Grammatik einmal
    weight: (e, c) => c.grammar ? 1 : dirsFor(e.dir || 'de-it').length,
    count(e, ids) { const by = new Map(Exams.cards(e).map(c => [c.id, c])); return ids.reduce((n, id) => n + (by.has(id) ? Exams.weight(e, by.get(id)) : 0), 0); },
    items(e, ids) {
      const out = [];
      for (const c of Exams.cards(e)) if (!ids || ids.has(c.id)) for (const d of (c.grammar ? ['de-it'] : dirsFor(e.dir || 'de-it'))) out.push({ card: c, dir: d });
      return out;
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
      const by = new Map(cards.map(c => [c.id, c]));
      for (let d = t; d < e.date && out.length < 400; d = addDays(d, 1)) {
        const l = Exams.dayList(e, cards, reps, d);
        out.push({ date: d, count: l.ids.reduce((n, id) => n + Exams.weight(e, by.get(id)), 0), fresh: l.fresh, final: l.final, done: d === t ? Exams.doneToday(e) : 0 });
        for (const id of l.ids) { const r = reps[id] || (reps[id] = { n: 0 }); r.n++; r.first = r.first || d; r.last = d; r.weak = false; }
      }
      return out;
    },
    planCounts(e) {
      const out = Object.fromEntries(Exams.plan(e).map(p => [p.date, p.count]));
      if (e.date === today()) out[e.date] = Exams.count(e, Exams.todayList(e).ids);
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
    const items = Exams.items(e, new Set(Exams.todayList(e).ids));
    Session.start(shuffle(items), { mode: state.settings.mode, practice: true, exam: id });
  }

  function startLearning(lessons, opts = {}) {
    const st = state.settings;
    const dir = opts.dir || st.dir;
    const mode = opts.mode || st.mode;
    const { due, fresh } = pool(lessons, dir, opts.content);
    let items;
    if (opts.random) {
      // Zufällig üben: nichts mehr fällig → zufällige Einheiten aus der Auswahl
      items = shuffle(learnables(lessons, dir, opts.content)).slice(0, st.sessionSize);
    } else if (opts.practice) {
      // im Test-Modus: alles aus der Auswahl, egal ob fällig
      items = shuffle(learnables(lessons, dir, opts.content));
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
  let ui = { vocabLesson: '', vocabSearch: '', editId: null, formLesson: '', importLesson: '', importText: '', examId: null, examDraft: null, examSearch: '' };

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
    const tab = { edit: 'vocab', import: 'vocab', scan: 'vocab', gtopic: 'vocab', gimport: 'vocab', conj: 'vocab', exam: 'exams', examEdit: 'exams' }[route] || route;
    $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.to === tab));
    const v = $('#view');
    const views = { home: viewHome, learn: viewLearn, vocab: viewVocab, edit: viewEdit, import: viewImport, more: viewMore, exams: viewExams, exam: viewExam, examEdit: viewExamEdit, scan: viewScan, gtopic: viewGTopic, gimport: viewGImport, conj: viewConj };
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
    const anyCards = learnables(st.lessons, st.dir).length > 0;

    v.innerHTML = `
      <div class="card hero">
        <div style="font-weight:600;margin-bottom:10px">Ciao${CFG.name ? ' ' + esc(CFG.name) : ''}! 👋</div>
        <div class="row" style="align-items:flex-end;gap:18px">
          <div><div class="big-num">${due.length}</div><div class="muted small">fällig</div></div>
          <div><div class="big-num" style="font-size:30px">${newCount}</div><div class="muted small">neu</div></div>
        </div>
        <div class="muted small" style="margin:10px 0 14px">${{ vocab: 'Vokabeln', grammar: 'Grammatik', both: 'Vokabeln + Grammatik' }[st.content || 'vocab']} · ${esc(scope)}${(st.content || 'vocab') !== 'grammar' ? ' · ' + esc(DIR_LABEL[st.dir] || 'beide Richtungen') : ''}</div>
        <div class="row">
          ${todo
            ? `<button class="btn big spacer" data-action="learn-now">Jetzt lernen (${todo})</button>`
            : anyCards
              ? `<button class="btn big spacer" data-action="learn-random">Alles gelernt ✓ · Zufällig üben 🎲</button>`
              : `<button class="btn big spacer" data-action="go" data-to="scan">📷 Vokabeln hinzufügen</button>`}
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
        }).join('') : `<div class="empty">Noch keine Vokabeln. <a href="#" data-action="go" data-to="scan">Foto scannen</a> oder <a href="#" data-action="go" data-to="import">Liste importieren</a></div>`}
      </div>`;
  }


  // ---------- Termine ----------
  const countdown = e => { const d = dayDiff(today(), e.date); return d === 0 ? 'heute' : d === 1 ? 'morgen' : d < 0 ? 'vorbei' : `in ${d} Tagen`; };

  function examCard(e, detail = false) {
    const t = Exams.todayList(e), all = Exams.cards(e), nG = all.filter(c => c.grammar).length, n = all.length - nG;
    const todayN = Exams.count(e, t.ids);
    const done = Exams.doneToday(e), isDay = e.date === today();
    const todayTxt = t.ids.length
      ? `<b>Heute: ${plural(todayN, 'Abfrage', 'Abfragen')}</b>${t.final ? (isDay ? ' · letzter Check' : ' · Generalprobe') : ''}`
      : done ? 'Heute erledigt ✓' : 'Heute frei';
    const d = new Date(e.date + 'T12:00:00');
    return `<div class="card exam-card" ${detail ? '' : `data-action="exam-open" data-id="${esc(e.id)}"`}>
      <div class="row">
        <div class="exam-date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('de-DE', { month: 'short' })}</span></div>
        <div class="spacer" style="min-width:0">
          <div class="name">${esc(e.title)}</div>
          <div class="small muted">${countdown(e)} · ${plural(n, 'Vokabel', 'Vokabeln')}${nG ? ` + ${nG} Grammatik` : ''}${e.notify ? ' · 🔔 7:00' : ''}</div>
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
    const t = today();
    const plan = Exams.plan(e);
    const dayName = d => d === t ? 'Heute' : d === addDays(t, 1) ? 'Morgen' : fmtDate(d);
    const rows = plan.map(p => {
      let txt;
      if (p.final) txt = p.count ? `<b>Generalprobe:</b> ${plural(p.count, 'Abfrage', 'Abfragen')}` : 'Generalprobe erledigt ✓';
      else if (p.count) txt = `${plural(p.count, 'Abfrage', 'Abfragen')}${p.fresh ? ` <span class="muted">(${p.fresh} neu)</span>` : ''}`;
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
        <p class="small muted" style="margin:10px 0 0">Jede Vokabel und Übung kommt bis zum Termin etwa ${e.target || 3}× dran, mit wachsenden Abständen. Was du falsch hast, kommt am nächsten Tag nochmal.</p>
      </div>
      <div class="section-title">Stoff</div>
      <div class="card small">
        ${lessons.length ? `<div class="chips" style="margin-bottom:${extra ? 8 : 0}px">${lessons.map(l => `<span class="chip on">${esc(l)}</span>`).join('')}</div>` : ''}
        ${extra ? `<div class="muted">+ ${plural(extra, 'einzelne Vokabel', 'einzelne Vokabeln')}</div>` : ''}
        ${(e.topicIds || []).filter(id => state.gtopics[id] && !state.gtopics[id].deleted).map(id => `<div>📘 ${esc(state.gtopics[id].title)}</div>`).join('')}
        ${e.conj ? `<div>🔁 Konjugation (${conjTenses().map(x => TENSES[x]).join(', ')})</div>` : ''}
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
        ? { title: e.title, date: e.date, lessons: [...(e.lessons || [])], cardIds: [...(e.cardIds || [])], topicIds: [...(e.topicIds || [])], conj: !!e.conj, dir: e.dir || 'de-it', notify: e.notify !== false }
        : { title: '', date: addDays(today(), 7), lessons: [], cardIds: [], topicIds: [], conj: false, dir: 'de-it', notify: true };
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
      <div class="section-title">Grammatik</div>
      <div class="card">
        ${activeTopics().length ? `<div class="chips">${activeTopics().map(t => `<button type="button" class="chip ${(d.topicIds || []).includes(t.id) ? 'on' : ''}" data-action="exam-topic" data-id="${esc(t.id)}">📘 ${esc(t.title)}</button>`).join('')}</div>` : '<span class="muted small">Noch keine Grammatik-Themen.</span>'}
        <label class="check" style="margin-top:10px"><input type="checkbox" id="exConj" ${d.conj ? 'checked' : ''}><span><b>Konjugation</b><br><span class="small muted">Verben aus den gewählten Vokabeln, Zeiten wie im Konjugationstrainer (${conjTenses().map(x => TENSES[x]).join(', ')})</span></span></label>
      </div>
      <div class="section-title">Richtung (Vokabeln)</div>
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
      const all = Exams.cards(d), nG = all.filter(c => c.grammar).length, nV = all.length - nG, days = Math.max(0, dayDiff(today(), d.date));
      $('#exSummary').innerHTML = `<div class="small">${all.length ? `<b>${plural(nV, 'Vokabel', 'Vokabeln')}${nG ? ` + ${plural(nG, 'Grammatik-Übung', 'Grammatik-Übungen')}` : ''}</b> ausgewählt` : '<span class="muted">Noch nichts ausgewählt.</span>'}
        ${all.length && d.date >= today() ? ` · ${plural(days, 'Lerntag', 'Lerntage')} · alles ca. ${targetReps(days)}×` : ''}</div>`;
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
    $('#exConj').addEventListener('change', ev => { d.conj = ev.target.checked; summary(); });
    $('#exSearch').addEventListener('input', ev => { ui.examSearch = ev.target.value; drawCards(); });
    drawCards();
    summary();
  }

  // ---------- Lernen einstellen ----------
  function viewLearn(v) {
    setTitle('Lernen');
    const st = state.settings;
    if (!st.content) st.content = 'vocab';
    const lessons = allLessons();
    const sel = new Set(st.lessons.filter(l => lessons.includes(l)));
    const { due, fresh } = pool([...sel], st.dir);
    const seg = (name, val, label) => `<button class="${st[name] === val ? 'on' : ''}" data-action="set" data-k="${name}" data-v="${val}">${label}</button>`;
    const allCount = learnables([...sel], st.dir).length;

    v.innerHTML = `
      <div class="section-title">Was lernen?</div>
      <div class="seg">${seg('content', 'vocab', 'Vokabeln')}${seg('content', 'grammar', 'Grammatik')}${seg('content', 'both', 'Beides')}</div>
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
             <p class="small muted" style="margin:8px 2px 14px">Neues startet in Fach 0. Was du gut kannst, kommt seltener dran.</p>`
          : `<button class="btn primary block big" data-action="learn-random" ${allCount ? '' : 'disabled'}>Zufällig üben 🎲</button>
             <p class="small muted" style="margin:8px 2px 14px">Alles gelernt! Hier kommt Zufälliges aus deiner Auswahl. Richtig → bleibt, falsch → Fach 1.</p>`}
        <button class="btn block" data-action="learn-practice" ${allCount ? '' : 'disabled'}>Test-Modus: alle ${allCount} abfragen</button>
        <p class="small muted" style="margin:8px 2px 0">Gut vor einer Ex oder Schulaufgabe: fragt alles aus der Auswahl ab, egal ob fällig.</p>
      </div>`;
  }


  // ---------- Grammatik ----------
  // Mini-Markdown für Erklärungen: Absätze, Listen mit "- ", **fett**, Tabellenzeilen mit "|"
  function mdLite(text) {
    const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1<i>$2</i>');
    const out = [];
    let list = null, table = null;
    const flush = () => { if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; } if (table) { out.push('<table>' + table.join('') + '</table>'); table = null; } };
    for (const raw of String(text || '').split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) { flush(); continue; }
      if (/^[-*•]\s+/.test(l)) { if (table) flush(); (list ||= []).push('<li>' + inline(l.replace(/^[-*•]\s+/, '')) + '</li>'); continue; }
      if (l.includes('|') && !/^\|?\s*-{2,}/.test(l)) { if (list) flush(); (table ||= []).push('<tr>' + l.replace(/^\||\|$/g, '').split('|').map(c => '<td>' + inline(c.trim()) + '</td>').join('') + '</tr>'); continue; }
      if (/^\|?\s*-{2,}/.test(l)) continue;
      flush();
      out.push('<p>' + inline(l) + '</p>');
    }
    flush();
    return out.join('');
  }

  // Grammatik-Paket lesen. Rückgabe: {topics: [{title, lesson, explanation, items: [...]}], errors: [], skipped: []}
  const GTYPES = { 'lücke': 'gap', 'luecke': 'gap', 'gap': 'gap', 'wahl': 'choice', 'auswahl': 'choice', 'choice': 'choice', 'übersetze': 'translate', 'uebersetze': 'translate', 'übersetzen': 'translate', 'translate': 'translate' };
  const GLATER = [];
  const TENSE_ALIASES = { 'presente': 'presente', 'passato prossimo': 'passato', 'passato': 'passato', 'imperfetto': 'imperfetto', 'futuro': 'futuro', 'futuro semplice': 'futuro' };
  function parsePack(text, defaultLesson = '') {
    const topics = [], errors = [], skipped = [];
    let cur = null, section = 'expl';
    String(text || '').split(/\r?\n/).forEach((raw, n) => {
      const line = raw.replace(/\s+$/, '');
      const l = line.trim();
      if (/^#\s+/.test(l)) { cur = { title: l.replace(/^#\s+/, '').trim(), lesson: defaultLesson, expl: [], items: [] }; topics.push(cur); section = 'expl'; return; }
      if (!cur) { if (l) errors.push(`Zeile ${n + 1}: Vor der ersten Zeile mit „# Thema“ steht Text.`); return; }
      const lm = l.match(/^lektion\s*:\s*(.+)$/i);
      if (lm && section === 'expl' && !cur.items.length) { cur.lesson = lm[1].trim(); return; }
      if (/^##\s*(erklärung|erklaerung|regel)/i.test(l)) { section = 'expl'; return; }
      if (/^##\s*(übungen|uebungen|aufgaben)/i.test(l)) { section = 'ex'; return; }
      if (section === 'expl') { cur.expl.push(line); return; }
      if (!l) return;
      const m = l.match(/^([\wäöüÄÖÜ]+)\s*:\s*(.+)$/);
      if (!m) { errors.push(`Zeile ${n + 1}: „${l.slice(0, 40)}“ – Typ fehlt (z. B. „lücke:“)`); return; }
      const kind = m[1].toLowerCase(), body = m[2];
      if (GLATER.includes(kind)) { skipped.push(kind); return; }
      if (kind === 'ordne' || kind === 'satzbau') {
        const eq2 = body.lastIndexOf(' = ');
        if (eq2 < 0) { errors.push(`Zeile ${n + 1}: Lösung fehlt („ = Lösung“ am Ende)`); return; }
        let prompt = body.slice(0, eq2).trim(); const answer = body.slice(eq2 + 3).trim();
        let tiles;
        if (prompt.includes(' / ')) { tiles = prompt.split(' / ').map(x => x.trim()).filter(Boolean); prompt = 'Bilde einen richtigen Satz.'; }
        else tiles = answer.split(';')[0].trim().replace(/[.!?…]+$/, '').split(/\s+/).filter(Boolean);
        if (tiles.length < 2) { errors.push(`Zeile ${n + 1}: Satz ordnen braucht mindestens 2 Wörter`); return; }
        cur.items.push({ type: 'order', prompt: prompt || 'Bilde einen richtigen Satz.', answer, options: tiles });
        return;
      }
      if (kind === 'konjugiere' || kind === 'konjugation') {
        const [left, right] = body.split(' = ');
        const m2 = left.trim().match(/^([a-zàèéìòù]+)\s*(?:\(([^)]+)\))?$/i);
        if (!m2) { errors.push(`Zeile ${n + 1}: Format „konjugiere: verbo (Zeit)“`); return; }
        const verb = m2[1].toLowerCase(), tense = TENSE_ALIASES[(m2[2] || 'presente').trim().toLowerCase()];
        if (!tense) { errors.push(`Zeile ${n + 1}: Zeit „${m2[2]}“ unbekannt (Presente, Passato prossimo, Imperfetto, Futuro)`); return; }
        let forms = right ? right.split(',').map(x => x.trim()) : conjugate(verb, tense);
        if (!forms || forms.length !== 6) { errors.push(`Zeile ${n + 1}: Für „${verb}“ bitte alle 6 Formen angeben („= io, tu, lui, noi, voi, loro“)`); return; }
        cur.items.push({ type: 'conj', prompt: verb, answer: forms.join(', '), options: forms, hint: tense });
        return;
      }
      const type = GTYPES[kind];
      if (!type) { errors.push(`Zeile ${n + 1}: Unbekannter Typ „${m[1]}“`); return; }
      const eq = body.lastIndexOf(' = ');
      if (eq < 0) { errors.push(`Zeile ${n + 1}: Lösung fehlt („ = Lösung“ am Ende)`); return; }
      let prompt = body.slice(0, eq).trim(); const answer = body.slice(eq + 3).trim();
      let options = [];
      if (type === 'choice') {
        const parts = prompt.split('|').map(x => x.trim()).filter(Boolean);
        prompt = parts.shift() || '';
        options = parts;
        if (!options.some(o => norm(o) === norm(answer))) options.push(answer);
        if (options.length < 2) { errors.push(`Zeile ${n + 1}: Auswahl braucht mindestens 2 Möglichkeiten`); return; }
      }
      if (!prompt || !answer) { errors.push(`Zeile ${n + 1}: Frage oder Lösung leer`); return; }
      cur.items.push({ type, prompt, answer, options });
    });
    for (const t of topics) t.explanation = t.expl.join('\n').trim();
    return { topics: topics.filter(t => t.title), errors, skipped };
  }

  function topicStats(t) {
    const items = activeGItems(t.id), now_ = now();
    let due = 0, fresh = 0, boxSum = 0;
    for (const i of items) {
      const p = prog('g:' + i.id, 'de-it');
      if (!p || !p.seen) fresh++; else { if (p.due <= now_) due++; boxSum += Math.min(p.box, MAX_BOX); }
    }
    return { n: items.length, due, fresh, pct: items.length ? boxSum / (items.length * MAX_BOX) : 0 };
  }


  function conjStats() {
    const items = conjItems(), t = now();
    let due = 0, fresh = 0;
    for (const it of items) { const p = prog(it.card.id, 'de-it'); if (!p || !p.seen) fresh++; else if (p.due <= t) due++; }
    return { n: items.length, verbs: new Set(items.map(x => x.card.verb)).size, due, fresh };
  }
  function conjTrainerCard() {
    const cs = conjStats(), sel = new Set(conjTenses());
    return `<div class="card">
      <div class="row"><div class="spacer"><div class="name" style="font-weight:700">🔁 Konjugationstrainer</div>
        <div class="small muted">${plural(cs.verbs, 'Verb', 'Verben')} aus deinen Vokabeln${cs.due ? ` · <b style="color:var(--green)">${cs.due} fällig</b>` : ''}${cs.fresh ? ` · ${cs.fresh} neu` : ''}</div></div></div>
      <div class="chips" style="margin:12px 0">${Object.entries(TENSES).map(([k, lab]) => `<button class="chip ${sel.has(k) ? 'on' : ''}" data-action="conj-tense" data-t="${k}">${lab}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" id="conjAuto" ${state.settings.conjAuto !== false ? 'checked' : ''}><span class="small">Beim Lernen von Grammatik automatisch mitüben</span></label>
      <div class="row" style="margin-top:10px">
        <button class="btn primary spacer" data-action="conj-learn" ${cs.n ? '' : 'disabled'}>Üben${cs.due + cs.fresh ? ` (${cs.due + cs.fresh})` : cs.n ? ' 🎲' : ''}</button>
        <button class="btn spacer" data-action="go" data-to="conj">Nachschlagen</button>
      </div>
      ${cs.verbs ? '' : `<p class="small muted" style="margin:10px 0 0">Sobald Verben (z. B. „parlare“) in deinen Vokabeln sind, erscheinen sie hier automatisch.</p>`}
    </div>`;
  }
  function startConj() {
    const items = conjItems(), t = now(), st = state.settings;
    const open = items.filter(it => { const p = prog(it.card.id, 'de-it'); return !p || !p.seen || p.due <= t; });
    if (open.length) return Session.start(shuffle(open).slice(0, st.sessionSize), { mode: st.mode });
    Session.start(shuffle(items).slice(0, st.sessionSize), { mode: st.mode, practice: true, random: true });
  }
  function conjTable(verb, tense) {
    const f = conjugate(verb, tense);
    if (!f) return `<p class="small muted">Kann ich nicht konjugieren.</p>`;
    return `<table class="conj-table">${f.map((x, i) => `<tr><td>${PERSONS[i]}</td><td>${esc(x.split(';').map(y => y.trim()).join(' / '))}</td></tr>`).join('')}</table>`;
  }
  function viewConj(v) {
    setTitle('Konjugation');
    const verbs = [...new Map(activeCards().map(c => [verbOf(c), c]).filter(([vb]) => vb)).entries()].sort((a, b) => a[0].localeCompare(b[0], 'it'));
    const q = (ui.conjQ || '').trim().toLowerCase();
    const shown = q ? verbs.filter(([vb, c]) => vb.includes(q) || norm(c.de).includes(q)) : verbs;
    const free = q && /^[a-zàèéìòù]+(are|ere|ire|arsi|ersi|irsi|urre|orre)$/.test(q) && !verbs.some(([vb]) => vb === q) ? q : null;
    const open = ui.conjOpen;
    const block = vb => `<div class="conj-tables">${Object.entries(TENSES).map(([k, lab]) => `<div><div class="small muted" style="font-weight:700;margin-top:8px">${lab}</div>${conjTable(vb, k)}</div>`).join('')}</div>`;
    v.innerHTML = `
      <input type="search" id="conjQ" placeholder="Verb suchen oder eingeben, z. B. scrivere" value="${esc(ui.conjQ || '')}" style="margin:6px 0 12px">
      ${free ? `<div class="card"><b>${esc(free)}</b><span class="small muted"> · nicht in deinen Vokabeln</span>${block(free)}
        <p class="small muted" style="margin:8px 0 0">Unregelmäßige Verben, die die App nicht kennt, können falsch sein.</p></div>` : ''}
      <div class="card">${shown.length ? shown.map(([vb, c]) => `
        <div class="vocab-item" data-action="conj-open" data-v="${esc(vb)}">
          <div class="spacer" style="min-width:0"><div class="it">${esc(vb)}</div><div class="de">${esc(c.de)}</div>${open === vb ? block(vb) : ''}</div>
          <span class="muted">${open === vb ? '▴' : '▾'}</span>
        </div>`).join('') : `<div class="empty">${verbs.length ? 'Nichts gefunden.' : 'Noch keine Verben in deinen Vokabeln.'}</div>`}</div>`;
    const inp = $('#conjQ');
    inp.addEventListener('input', () => { ui.conjQ = inp.value; const pos = inp.selectionStart; viewConj(v); const n2 = $('#conjQ'); n2.focus(); n2.setSelectionRange(pos, pos); });
  }

  function viewGrammar(v) {
    setTitle('Stoff');
    const topics = activeTopics();
    const byLesson = new Map();
    for (const t of topics.sort((a, b) => (a.lesson || '~').localeCompare(b.lesson || '~', 'de', { numeric: true }) || (a.created || 0) - (b.created || 0))) {
      const k = t.lesson || 'Ohne Lektion';
      if (!byLesson.has(k)) byLesson.set(k, []);
      byLesson.get(k).push(t);
    }
    v.innerHTML = `
      ${stoffSeg()}
      <button class="btn primary block" style="margin:0 0 14px" data-action="go" data-to="gimport">Grammatik-Paket importieren</button>
      ${conjTrainerCard()}
      ${topics.length ? [...byLesson.entries()].map(([lesson, list]) => `
        <div class="section-title">${esc(lesson)}</div>
        <div class="card">${list.map(t => { const s2 = topicStats(t); return `
          <div class="lesson" data-action="gtopic-open" data-id="${esc(t.id)}" style="cursor:pointer">
            <div class="info">
              <div class="name">📘 ${esc(t.title)}</div>
              <div class="small muted">${plural(s2.n, 'Übung', 'Übungen')}${s2.due ? ` · <b style="color:var(--green)">${s2.due} fällig</b>` : ''}${s2.fresh ? ` · ${s2.fresh} neu` : ''}</div>
              <div class="bar"><i style="width:${Math.round(s2.pct * 100)}%"></i></div>
            </div>
            <button class="btn small" data-action="gtopic-learn" data-id="${esc(t.id)}">Üben</button>
          </div>`; }).join('')}</div>`).join('')
        : `<div class="card empty">Noch keine Grammatik.<br>Fotografiere eine Grammatikseite aus deinem Buch und schick sie Claude – du bekommst ein Paket zum Einfügen.</div>`}`;
  }

  function viewGTopic(v) {
    const t = state.gtopics[ui.gtopicId];
    if (!t || t.deleted) { route = 'vocab'; ui.stoff = 'grammar'; return viewGrammar(v); }
    setTitle(t.title);
    const items = activeGItems(t.id);
    const s2 = topicStats(t);
    const typ = { gap: 'Lücke', choice: 'Auswahl', translate: 'Übersetzen', conj: 'Konjugation', order: 'Satz ordnen' };
    v.innerHTML = `
      <div class="card">
        <div class="small muted">${esc(t.lesson || 'Ohne Lektion')} · ${plural(s2.n, 'Übung', 'Übungen')}</div>
        <div class="bar" style="margin:10px 0 14px"><i style="width:${Math.round(s2.pct * 100)}%"></i></div>
        <div class="row">
          <button class="btn primary spacer" data-action="gtopic-learn" data-id="${esc(t.id)}">Üben${s2.due + s2.fresh ? ` (${s2.due + s2.fresh})` : ' 🎲'}</button>
          <button class="btn spacer" data-action="gtopic-all" data-id="${esc(t.id)}">Alle abfragen</button>
        </div>
      </div>
      ${t.explanation ? `<div class="section-title">Regel</div><div class="card rule-box">${mdLite(t.explanation)}</div>` : ''}
      <div class="section-title">Übungen</div>
      <div class="card">${items.map(i => `
        <div class="vocab-item" style="cursor:default">
          <div class="spacer" style="min-width:0"><div class="small muted">${typ[i.type] || i.type}</div><div>${esc(i.prompt)}</div><div class="it" style="color:var(--green)">${esc(i.answer)}</div></div>
          <button class="icon-btn" data-action="gitem-delete" data-id="${esc(i.id)}" aria-label="Übung löschen">✕</button>
        </div>`).join('') || '<div class="empty">Keine Übungen.</div>'}</div>
      <button class="btn danger block" data-action="gtopic-delete" data-id="${esc(t.id)}">Thema löschen</button>`;
  }

  const GPACK_EXAMPLE = `# Presente: Verben auf -are
Lektion: Lektion 3
## Erklärung
Regelmäßige Verben auf **-are** (z. B. parlare): Stamm **parl-** + Endung
io | parlo
tu | parli
lui/lei | parla
noi | parliamo
voi | parlate
loro | parlano
## Übungen
lücke: Io ___ italiano. (parlare) = parlo
lücke: Noi ___ a Roma. (abitare) = abitiamo
lücke: Loro ___ la pizza. (mangiare) = mangiano
wahl: Tu ___ tedesco? | parli | parla | parlate = parli
wahl: Voi ___ molto. | studiate | studiano | studi = studiate
übersetze: Wir sprechen Italienisch. = Parliamo italiano.
übersetze: Er wohnt in Mailand. = Abita a Milano.; Lui abita a Milano.`;

  function viewGImport(v) {
    setTitle('Grammatik importieren');
    const lessons = allLessons();
    v.innerHTML = `
      <div class="card">
        <p style="margin-top:0" class="small">So geht's: Grammatikseite fotografieren → an Claude schicken („Mach mir ein Grammatik-Paket für Avanti“) → das Paket hier einfügen.</p>
        <label class="field"><span>Lektion (falls nicht im Paket angegeben)</span><input type="text" id="gLesson" list="gLessons" value="${esc(ui.gLesson || '')}" placeholder="z. B. Lektion 3"></label>
        <datalist id="gLessons">${lessons.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
        <label class="field"><span>Grammatik-Paket</span><textarea id="gText" placeholder="# Thema …">${esc(ui.gText || '')}</textarea></label>
        <button class="btn small" data-action="gimport-example">Beispiel-Paket einfügen</button>
        <div id="gPreview" class="preview"></div>
        <button class="btn primary block big" style="margin-top:14px" data-action="gimport-do" id="gBtn">Importieren</button>
      </div>
      <div class="section-title">Format</div>
      <div class="card small">
        <p style="margin-top:0"><code># Titel</code> startet ein Thema, <code>Lektion: …</code> darunter (optional).</p>
        <p><code>## Erklärung</code> – Text, Listen mit „- “, Tabellen mit „|“.</p>
        <p style="margin-bottom:0"><code>## Übungen</code> – eine pro Zeile:<br>
        <code>lücke: Satz mit ___ (Hinweis) = Lösung</code><br>
        <code>wahl: Satz ___ | A | B | C = Lösung</code><br>
        <code>übersetze: deutscher Satz = italienischer Satz</code><br>
        <code>ordne: Marco spricht Italienisch. = Marco parla italiano.</code> – Wörter werden zu Kacheln<br>
        <code>konjugiere: parlare (presente)</code> – Formen rechnet die App selbst aus (oder <code>= io, tu, lui, noi, voi, loro</code> angeben)<br>
        Mehrere richtige Lösungen mit <code>;</code> trennen.</p>
      </div>`;
    const upd = () => {
      ui.gText = $('#gText').value; ui.gLesson = $('#gLesson').value;
      const r = parsePack(ui.gText, ui.gLesson.trim());
      const n = r.topics.reduce((a, t) => a + t.items.length, 0);
      $('#gPreview').innerHTML = ui.gText.trim() ? `
        <b>${plural(r.topics.length, 'Thema', 'Themen')}, ${plural(n, 'Übung', 'Übungen')} erkannt</b>
        ${r.topics.map(t => `<div>📘 ${esc(t.title)} <span class="muted">· ${esc(t.lesson || 'ohne Lektion')} · ${t.items.length} Übungen${t.explanation ? ' · mit Regel' : ''}</span></div>`).join('')}
        ${r.skipped.length ? `<div class="muted">${r.skipped.length} Übung(en) vom Typ ${[...new Set(r.skipped)].join(', ')} kommen erst in Version 1.8/1.9 und werden übersprungen.</div>` : ''}
        ${r.errors.slice(0, 6).map(e => `<div style="color:var(--red)">${esc(e)}</div>`).join('')}${r.errors.length > 6 ? `<div style="color:var(--red)">… und ${r.errors.length - 6} weitere Fehler</div>` : ''}` : '';
      $('#gBtn').disabled = !n;
    };
    $('#gText').addEventListener('input', upd);
    $('#gLesson').addEventListener('input', upd);
    upd();
  }

  function startGrammar(topicId, all = false) {
    const items = activeGItems(topicId).map(i => ({ card: gCard(i), dir: 'de-it' }));
    const t = now();
    const open = items.filter(it => { const p = prog(it.card.id, 'de-it'); return !p || !p.seen || p.due <= t; });
    const st = state.settings;
    if (all) return Session.start(shuffle(items), { mode: st.mode, practice: true });
    if (open.length) return Session.start(shuffle(open).slice(0, st.sessionSize), { mode: st.mode });
    Session.start(shuffle(items).slice(0, st.sessionSize), { mode: st.mode, practice: true, random: true });
  }

  // ---------- Vokabelliste ----------
  const stoffSeg = () => `<div class="seg" style="margin:6px 0 14px">
      <button class="${ui.stoff !== 'grammar' ? 'on' : ''}" data-action="stoff" data-v="vocab">Vokabeln</button>
      <button class="${ui.stoff === 'grammar' ? 'on' : ''}" data-action="stoff" data-v="grammar">Grammatik</button></div>`;

  function viewVocab(v) {
    if (ui.stoff === 'grammar') return viewGrammar(v);
    setTitle('Stoff');
    const lessons = [...lessonMap().keys()];
    if (ui.vocabLesson && !lessons.includes(ui.vocabLesson)) ui.vocabLesson = '';
    v.innerHTML = `
      ${stoffSeg()}
      <button class="btn primary block" style="margin:0 0 10px" data-action="go" data-to="scan">📷 Foto scannen</button>
      <div class="row" style="margin:0 0 12px">
        <button class="btn spacer" data-action="new-card">+ Neue Vokabel</button>
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


  // ---------- Foto scannen ----------
  const SCAN_STATUS = {
    'loading tesseract core': 'Lade Texterkennung …',
    'initializing tesseract': 'Starte Texterkennung …',
    'loading language traineddata': 'Lade Sprachdaten (nur beim ersten Mal) …',
    'initializing api': 'Starte Texterkennung …',
    'recognizing text': 'Erkenne Text …'
  };
  const scanState = () => ui.scan || (ui.scan = { pages: [], busy: false, status: '', progress: 0, lesson: '' });
  const scanField = (pg, f) => pg.map.indexOf(f);
  const scanSelected = () => scanState().pages.reduce((n, pg) => n + pg.rows.filter(r => r.on).length, 0);

  function viewScan(v) {
    setTitle('Foto scannen');
    const sc = scanState();
    const lessons = [...lessonMap().keys()];
    const opts = [['it', 'Italienisch'], ['de', 'Deutsch'], ['note', 'Notiz'], ['skip', 'ignorieren']];
    const pages = sc.pages.map((pg, pi) => {
      const iIt = scanField(pg, 'it'), iDe = scanField(pg, 'de');
      return `<div class="card">
        <div class="row" style="margin-bottom:10px">
          <img src="${pg.thumb}" class="scan-thumb" alt="">
          <div class="spacer"><b>Foto ${pi + 1}</b><div class="small muted">${plural(pg.rows.length, 'Zeile', 'Zeilen')} erkannt · ${plural(pg.cols, 'Spalte', 'Spalten')}</div></div>
          <button class="icon-btn" data-action="scan-drop" data-p="${pi}" aria-label="Foto entfernen">✕</button>
        </div>
        <div class="scan-map">${pg.map.map((m, ci) => `<label><span class="small muted">Spalte ${ci + 1}</span>
          <select data-p="${pi}" data-col="${ci}">${opts.map(([val, lab]) => `<option value="${val}" ${m === val ? 'selected' : ''}>${lab}</option>`).join('')}</select></label>`).join('')}</div>
        ${iIt < 0 || iDe < 0 ? `<p class="small" style="color:var(--red)">Bitte je eine Spalte als Italienisch und Deutsch wählen.</p>` : `
        <div class="scan-rows">${pg.rows.map((r, ri) => `<div class="scan-row">
          <input type="checkbox" data-p="${pi}" data-r="${ri}" ${r.on ? 'checked' : ''} aria-label="übernehmen">
          <input type="text" lang="it" data-p="${pi}" data-r="${ri}" data-c="${iIt}" value="${esc(r.cells[iIt])}" placeholder="italienisch">
          <input type="text" data-p="${pi}" data-r="${ri}" data-c="${iDe}" value="${esc(r.cells[iDe])}" placeholder="deutsch">
        </div>`).join('')}</div>`}
      </div>`;
    }).join('');

    v.innerHTML = `
      <div class="card">
        <p style="margin-top:0">Fotografiere eine Vokabelseite aus deinem Buch. Die App erkennt den Text, danach prüfst du die Liste und sortierst die Vokabeln in Lektionen.</p>
        <label class="btn primary block big" for="scanFile" ${sc.busy ? 'style="pointer-events:none;opacity:.5"' : ''}>📷 ${sc.pages.length ? 'Weiteres Foto' : 'Foto aufnehmen oder auswählen'}</label>
        <input type="file" id="scanFile" accept="image/*" multiple hidden>
        <p class="small muted" style="margin:10px 0 0">Tipps: Seite gerade und gut beleuchtet fotografieren, möglichst nur den Vokabelteil. Beim ersten Mal lädt die App die Sprachdaten (ein paar MB).</p>
        ${sc.pages.length ? `<p class="small muted" style="margin:8px 0 0"><b>In Lektionen aufteilen:</b> Nur die Zeilen anhaken, die in eine Lektion sollen, unten die Lektion eintragen und importieren. Der Rest bleibt hier für die nächste Lektion.</p>
        <button class="btn small" style="margin-top:10px" data-action="scan-all">Alle an/aus</button>` : ''}
      </div>
      ${sc.busy ? `<div class="card"><div class="small"><b>${esc(sc.status || 'Einen Moment …')}</b></div><div class="bar" style="margin-top:10px"><i style="width:${Math.round(sc.progress * 100)}%"></i></div></div>` : ''}
      ${pages}
      ${sc.pages.length ? `<div class="card scan-import">
        <datalist id="scanLessons">${lessons.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
        <div class="row">
          <input type="text" id="scanLesson" list="scanLessons" value="${esc(sc.lesson)}" placeholder="Lektion, z. B. Lektion 3" aria-label="Lektion">
          <button class="btn primary" data-action="scan-import" id="scanImportBtn">Importieren (${scanSelected()})</button>
        </div>
      </div>` : ''}`;

    $('#scanFile').addEventListener('change', e => { const files = [...e.target.files]; e.target.value = ''; scanFiles(files); });
    $('#scanLesson')?.addEventListener('input', e => { sc.lesson = e.target.value; });
    const count = () => { const b = $('#scanImportBtn'); if (b) b.textContent = `Importieren (${scanSelected()})`; };
    $$('.scan-map select').forEach(sel => sel.addEventListener('change', () => {
      sc.pages[+sel.dataset.p].map[+sel.dataset.col] = sel.value;
      render();
    }));
    $$('.scan-row input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
      sc.pages[+cb.dataset.p].rows[+cb.dataset.r].on = cb.checked; count();
    }));
    $$('.scan-row input[type=text]').forEach(inp => inp.addEventListener('input', () => {
      sc.pages[+inp.dataset.p].rows[+inp.dataset.r].cells[+inp.dataset.c] = inp.value;
    }));
  }

  async function scanFiles(files) {
    const sc = scanState();
    if (!files.length || sc.busy) return;
    sc.busy = true;
    Scan.setLog(m => {
      sc.status = SCAN_STATUS[m.status] || sc.status;
      if (typeof m.progress === 'number') sc.progress = m.progress;
      if (route === 'scan') { const bar = $('.card .bar i'); const st = $('.card .small b'); if (bar) bar.style.width = Math.round(sc.progress * 100) + '%'; if (st) st.textContent = sc.status; }
    });
    for (let i = 0; i < files.length; i++) {
      sc.status = files.length > 1 ? `Foto ${i + 1} von ${files.length} …` : 'Einen Moment …';
      sc.progress = 0;
      if (route === 'scan') render();
      try {
        const page = await Scan.recognize(files[i]);
        if (page.rows.length) sc.pages.push(page); else toast('Auf dem Foto wurde kein Text erkannt.');
      } catch (e) { toast(e.message || 'Texterkennung fehlgeschlagen'); }
    }
    sc.busy = false;
    if (route === 'scan') render();
    else toast('Foto erkannt – unter Vokabeln → Foto scannen prüfen');
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

      <div class="section-title">Mitteilungen</div>
      <div class="card" id="pushBox"><p class="small muted" style="margin:0">…</p></div>

      <div class="section-title">Lernen</div>
      <div class="card">
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
      <p class="small muted" style="text-align:center">Avanti Italiano · Version 1.9</p>`;

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
    'stoff': el => { ui.stoff = el.dataset.v; render(); },
    'conj-tense': el => {
      const s2 = new Set(conjTenses()); const k = el.dataset.t;
      if (s2.has(k)) { if (s2.size > 1) s2.delete(k); else return toast('Mindestens eine Zeit auswählen'); } else s2.add(k);
      state.settings.conjTenses = Object.keys(TENSES).filter(x => s2.has(x)); persist(); render();
    },
    'conj-learn': () => startConj(),
    'conj-open': el => { ui.conjOpen = ui.conjOpen === el.dataset.v ? null : el.dataset.v; render(); },
    'gtopic-open': el => go('gtopic', { gtopicId: el.dataset.id }),
    'gtopic-learn': el => startGrammar(el.dataset.id),
    'gtopic-all': el => startGrammar(el.dataset.id, true),
    'gtopic-delete': el => {
      const t = state.gtopics[el.dataset.id];
      if (!t || !confirm(`Thema „${t.title}“ mit allen Übungen löschen?`)) return;
      const ts = now();
      t.deleted = true; t.updated = ts;
      for (const i of Object.values(state.gitems)) if (i.topicId === t.id && !i.deleted) { i.deleted = true; i.updated = ts; }
      save(); toast('Thema gelöscht'); ui.stoff = 'grammar'; go('vocab');
    },
    'gitem-delete': el => {
      const i = state.gitems[el.dataset.id];
      if (!i || !confirm('Diese Übung löschen?')) return;
      i.deleted = true; i.updated = now(); save(); render();
    },
    'gimport-example': () => { const ta = $('#gText'); ta.value = GPACK_EXAMPLE; ta.dispatchEvent(new Event('input')); },
    'gimport-do': () => {
      const r = parsePack(ui.gText, (ui.gLesson || '').trim());
      let nT = 0, nI = 0; const ts = now();
      for (const pt of r.topics) {
        if (!pt.items.length && !pt.explanation) continue;
        let t = activeTopics().find(x => norm(x.title) === norm(pt.title) && (x.lesson || '') === (pt.lesson || ''));
        if (!t) { const id = uid(); t = state.gtopics[id] = { id, title: pt.title, lesson: pt.lesson || '', explanation: pt.explanation, created: ts + nT, updated: ts }; nT++; }
        else if (pt.explanation) { t.explanation = pt.explanation; t.updated = ts; }
        const have = new Set(activeGItems(t.id).map(i => norm(i.prompt)));
        for (const it of pt.items) {
          if (have.has(norm(it.prompt))) continue;
          const id = uid();
          state.gitems[id] = { id, topicId: t.id, type: it.type, prompt: it.prompt, answer: it.answer, options: it.options, hint: it.hint || '', created: ts + nI, updated: ts };
          have.add(norm(it.prompt)); nI++;
        }
      }
      save();
      ui.gText = '';
      toast(`${plural(nI, 'Übung', 'Übungen')} importiert${nT ? ` (${plural(nT, 'neues Thema', 'neue Themen')})` : ''}`);
      ui.stoff = 'grammar'; go('vocab');
    },
    'scan-drop': el => { scanState().pages.splice(+el.dataset.p, 1); render(); },
    'scan-all': () => {
      const rows = scanState().pages.flatMap(pg => pg.rows);
      const on = !rows.every(r => r.on);
      rows.forEach(r => { r.on = on; });
      render();
    },
    'scan-import': () => {
      const sc = scanState();
      const lesson = ($('#scanLesson')?.value || sc.lesson).trim();
      if (!lesson) return toast('Wähle oder schreib eine Lektion');
      const existing = new Set(activeCards().filter(c => c.lesson === lesson).map(c => norm(c.it)));
      let added = 0, skipped = 0, t = now();
      for (const pg of sc.pages) {
        const iIt = scanField(pg, 'it'), iDe = scanField(pg, 'de'), iNote = scanField(pg, 'note');
        if (iIt < 0 || iDe < 0) continue;
        pg.rows = pg.rows.filter(r => {
          if (!r.on) return true;
          const it = (r.cells[iIt] || '').trim(), de = (r.cells[iDe] || '').trim();
          if (!it || !de) return true; // unvollständig → bleibt zum Korrigieren
          if (!existing.has(norm(it))) {
            const id = uid();
            state.cards[id] = { id, it, de, note: iNote >= 0 ? (r.cells[iNote] || '').trim() : '', lesson, created: t + added, updated: t };
            existing.add(norm(it));
            added++;
          } else skipped++;
          return false;
        });
      }
      sc.pages = sc.pages.filter(pg => pg.rows.length);
      sc.lesson = lesson;
      if (!added && !skipped) return toast('Keine vollständigen angehakten Zeilen');
      save();
      toast(`${plural(added, 'Vokabel', 'Vokabeln')} in „${lesson}“` + (skipped ? ` (${skipped} schon vorhanden)` : ''));
      if (sc.pages.length) render(); else { ui.scan = null; go('vocab', { vocabLesson: lesson, vocabSearch: '' }); }
    },
    'exam-new': () => go('examEdit', { examId: null, examDraft: null }),
    'exam-open': el => go('exam', { examId: el.dataset.id }),
    'exam-edit': el => go('examEdit', { examId: el.dataset.id, examDraft: null }),
    'exam-learn': el => startExam(el.dataset.id),
    'exam-practice': el => {
      const e = state.exams[el.dataset.id];
      Session.start(shuffle(Exams.items(e)), { mode: state.settings.mode, practice: true, exam: e.id });
    },
    'exam-dir': el => { ui.examDraft.dir = el.dataset.v; render(); },
    'exam-topic': el => {
      const s2 = new Set(ui.examDraft.topicIds || []), id = el.dataset.id;
      s2.has(id) ? s2.delete(id) : s2.add(id);
      ui.examDraft.topicIds = [...s2];
      render();
    },
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
      if (!Exams.cards(d).length) return toast('Wähle mindestens eine Lektion, Vokabel oder ein Grammatik-Thema');
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
  document.addEventListener('change', e => {
    if (e.target && e.target.id === 'conjAuto') { state.settings.conjAuto = e.target.checked; persist(); toast('Gespeichert'); }
  });

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
  window.__italiano = { get state() { return state; }, checkAnswer, parseLine, Exams, dayDiff, addDays, targetReps, grade, Scan, scanFiles, parsePack, mdLite, learnables, conjugate, verbOf };
})();
