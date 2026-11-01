// HydraForge Station · Handy
// Zeigt den NPC-Modus aller Projekte, beantwortet Freigaben und Fragen und steuert den Lauf.
// Der PC führt alles aus: Das Handy schreibt nur Antworten in die Projektdaten („remote“), HydraForge auf dem PC liest sie.
(() => {
  'use strict';
  const app = document.getElementById('app');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const arr = v => Array.isArray(v) ? v : [];
  const usd = n => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const hhmm = t => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* privat */ } }, del: k => { try { localStorage.removeItem(k); } catch (e) { /* privat */ } } };
  const S = { sb: null, user: null, projects: [], err: '', busy: false, drafts: {}, sent: {}, open: {}, at: 0 };

  // Server-Daten kommen einmal über den Link aus HydraForge (#u=…&k=…) und bleiben auf dem Handy
  function config() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('u') && h.get('k')) { store.set('hf_url', h.get('u')); store.set('hf_key', h.get('k')); history.replaceState(null, '', location.pathname); }
    return { url: store.get('hf_url'), key: store.get('hf_key') };
  }

  const ROOM = { werkstatt: 'Werkstatt', labor: 'Prüflabor', planung: 'Planung', archiv: 'Archiv', werft: 'Asset-Werft' };
  const MODE = m => m === 2 ? 'Autopilot' : 'Copilot';
  const REASON = { fragen: 'Fragen warten', budget: 'Budget aufgebraucht', limit: 'Monatslimit', fehler: 'Fehlerserie', meilenstein: 'Meilenstein erreicht', manuell: 'angehalten', neustart: 'PC neu gestartet', unity: 'Unity antwortet nicht', hand: 'Handarbeit', fertig: 'fertig' };
  const npc = p => (p.data && p.data.npc) || null;
  const pcOnline = n => n && n.beat && Date.now() - n.beat < 150000;

  async function load() {
    const r = await S.sb.from('projects').select('id,name,data,updated_at').order('updated_at', { ascending: false });
    if (r.error) { S.err = r.error.message; } else { S.projects = r.data || []; S.err = ''; }
    S.at = Date.now(); render();
  }
  // Antwort an den PC: an die Liste „remote“ anhängen (nur das Handy schreibt dorthin)
  async function send(p, item) {
    item = Object.assign({ id: uid(), at: Date.now(), by: S.user && S.user.email }, item);
    const fresh = await S.sb.from('projects').select('data').eq('id', p.id).single();
    const list = arr(fresh.data && fresh.data.data && fresh.data.data.remote).concat([item]).slice(-40);
    const r = await S.sb.rpc('patch_project', { pid: p.id, patch: { remote: list } });
    if (r.error) { alert('Senden fehlgeschlagen: ' + r.error.message); return; }
    S.sent[item.id] = item; await load();
  }
  const done = (p, id) => arr((npc(p) || {}).remoteDone).includes(id);
  const waiting = p => Object.values(S.sent).filter(x => x.pid === p.id && !done(p, x.id));

  function vLogin() {
    const c = config();
    if (!c.url || !c.key) return '<section class="card"><h1>HydraForge Station</h1><p>Öffne diese Seite einmal über den Link aus HydraForge (Einstellungen → Handy). Darin stecken die Server-Daten.</p></section>';
    return '<section class="card"><img src="icon-192.png" alt="" class="logo"><h1>HydraForge Station</h1><p class="muted">Melde dich mit deinem HydraForge-Konto an.</p>' +
      '<label>E-Mail<input id="mail" type="email" autocomplete="username" value="' + esc(S.drafts.mail || '') + '"></label>' +
      '<label>Passwort<input id="pw" type="password" autocomplete="current-password"></label>' +
      (S.err ? '<p class="err">' + esc(S.err) + '</p>' : '') + '<button class="btn p wide" data-act="login"' + (S.busy ? ' disabled' : '') + '>Anmelden</button></section>';
  }
  function meter(pct, c) { return '<div class="meter"><i style="width:' + Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%;background:' + (c || 'var(--acc)') + '"></i></div>'; }
  function vProject(p) {
    const n = npc(p); const d = p.data || {}; const ts = arr(d.tasks); const doneN = ts.filter(t => t.status === 'done').length;
    const on = pcOnline(n); const run = n.state === 'laeuft' && on; const st = n.stats || {};
    const pend = arr(n.pending); const qs = arr(n.questions).filter(q => !q.answer); const ag = arr(n.agents); const wt = waiting(p);
    const openPh = ts.filter(t => t.status !== 'done'); const ph = openPh.length ? Math.min.apply(null, openPh.map(t => Number(t.phase) || 1)) : null;
    const inPh = ph ? ts.filter(t => (Number(t.phase) || 1) === ph) : ts; const phDone = inPh.filter(t => t.status === 'done').length;
    const state = !n.on ? ['aus', 'off'] : n.state === 'fertig' ? ['fertig', 'fin'] : run ? ['läuft', 'run'] : n.state === 'laeuft' ? ['PC offline?', 'warn'] : ['pausiert', 'warn'];
    const isOpen = S.open[p.id] !== false;
    return '<section class="card proj' + (run ? ' live' : '') + '">' +
      '<button class="phead" data-act="toggle" data-id="' + esc(p.id) + '"><span class="pname">' + esc(p.name) + '</span><span class="pill ' + state[1] + '">' + state[0] + '</span></button>' +
      (!isOpen ? '' :
      '<p class="muted small">' + MODE(n.mode) + ' · PC ' + (on ? 'online' : 'nicht erreichbar' + (n.beat ? ' (zuletzt ' + hhmm(n.beat) + ')' : '')) + '</p>' +
      (n.state !== 'laeuft' && n.reasonText ? '<p class="why">' + esc(REASON[n.reason] ? REASON[n.reason] + ': ' : '') + esc(n.reasonText) + '</p>' : '') +
      (run && n.step ? '<p class="step">Gerade: ' + esc(n.step) + '</p>' : '') +
      (pend.length ? '<div class="block warnb"><h3>Freigabe nötig</h3>' + pend.map(a => { const sent = wt.find(x => x.kind === 'approve' && x.reqId === a.reqId);
        return '<div class="appr"><b>' + esc(a.explain || a.why || 'Freigabe') + '</b>' + (a.tn ? '<span class="muted small">Task #' + a.tn + '</span>' : '') + '<code>' + esc(String(a.text || '').slice(0, 220)) + '</code>' +
          (sent ? '<span class="muted small">' + (sent.allow ? 'Erlaubt' : 'Abgelehnt') + ' · wartet auf den PC …</span>' : '<div class="row"><button class="btn p" data-act="approve" data-id="' + esc(p.id) + '" data-k="' + esc(a.reqId) + '" data-v="1">Erlauben</button><button class="btn" data-act="approve" data-id="' + esc(p.id) + '" data-k="' + esc(a.reqId) + '" data-v="0">Ablehnen</button></div>') + '</div>'; }).join('') + '</div>' : '') +
      '<div class="kpis"><div><span class="lbl">Budget</span><b>' + usd(n.spent || 0) + ' / ' + usd(n.budget || 0) + '</b>' + meter(n.budget ? (n.spent || 0) / n.budget : 0) + '</div>' +
      '<div><span class="lbl">' + (ph ? 'Meilenstein · Phase ' + ph : 'Alle Phasen') + '</span><b>' + phDone + ' / ' + inPh.length + '</b>' + meter(inPh.length ? phDone / inPh.length : 1, 'var(--ok)') + '</div>' +
      '<div><span class="lbl">Gesamt</span><b>' + doneN + ' / ' + ts.length + '</b><span class="muted small">' + (st.done || 0) + ' ✓ · ' + (st.failed || 0) + ' ✕</span></div></div>' +
      (qs.length ? '<div class="block"><h3>Fragen · ' + qs.length + '</h3>' + qs.map(q => { const sent = wt.find(x => x.kind === 'answer' && x.qid === q.id);
        return '<div class="q' + (q.crit ? ' crit' : '') + '"><span>' + (q.crit ? '<b class="crit">KRITISCH</b> · ' : '') + (q.tn ? '#' + q.tn + ' · ' : '') + esc(q.q) + '</span>' + (q.guess ? '<span class="muted small">Vorschlag: ' + esc(q.guess) + '</span>' : '') +
          (sent ? '<span class="muted small">Gesendet · wartet auf den PC …</span>' : '<div class="row"><input id="q_' + esc(q.id) + '" placeholder="' + (q.guess ? 'Leer = Vorschlag übernehmen' : 'Deine Antwort') + '" value="' + esc(S.drafts['q_' + q.id] || '') + '"><button class="btn' + (q.crit ? ' p' : '') + '" data-act="answer" data-id="' + esc(p.id) + '" data-k="' + esc(q.id) + '">Senden</button></div>') + '</div>'; }).join('') + '</div>' : '') +
      (ag.length && run ? '<div class="block"><h3>Agenten</h3>' + ag.map(a => '<div class="agent' + (a.needs ? ' need' : '') + '"><span class="bot" aria-hidden="true"></span><span><b>' + esc(a.label) + '</b><span class="muted small">' + esc((ROOM[a.room] || '') + (a.detail ? ' · ' + a.detail : '')) + '</span></span></div>').join('') + '</div>' : '') +
      (n.on && n.state !== 'fertig' ? '<div class="row ctl">' + (run ? '<button class="btn p" data-act="ctl" data-id="' + esc(p.id) + '" data-k="stopAfter">Nach diesem Schritt anhalten</button><button class="btn" data-act="ctl" data-id="' + esc(p.id) + '" data-k="stopNow">Sofort stoppen</button>' : '<button class="btn p" data-act="ctl" data-id="' + esc(p.id) + '" data-k="resume"' + (on ? '' : ' disabled') + '>' + (n.reason === 'meilenstein' ? 'Weiter zum nächsten Meilenstein' : 'Fortsetzen') + '</button>') + '</div>' +
        (wt.some(x => x.kind === 'ctl') ? '<p class="muted small">Befehl gesendet · wartet auf den PC …</p>' : '') + (!on ? '<p class="muted small">Steuern geht nur, wenn HydraForge auf dem PC läuft.</p>' : '') : '') +
      (arr(n.log).length ? '<details><summary>Verlauf</summary><div class="log">' + arr(n.log).slice(-12).reverse().map(l => esc(hhmm(l.at) + '  ' + l.text)).join('<br>') + '</div></details>' : '')) + '</section>';
  }
  function render() {
    const a = document.activeElement; const fid = a && a.id; const val = a && a.value;
    if (!S.user) { app.innerHTML = vLogin(); return; }
    const ps = S.projects.filter(p => npc(p) && (npc(p).on || npc(p).state === 'fertig'));
    app.innerHTML = '<header class="top"><img src="icon-192.png" alt="" class="logo sm"><div><b>HydraForge Station</b><span class="muted small">' + (S.at ? 'Stand ' + hhmm(S.at) : '') + '</span></div><span class="grow"></span><button class="btn sm" data-act="reload">↻</button><button class="btn sm" data-act="logout">Abmelden</button></header>' +
      (S.err ? '<p class="err pad">' + esc(S.err) + '</p>' : '') +
      (ps.length ? ps.map(vProject).join('') : '<section class="card"><p>Gerade ist kein NPC-Modus aktiv. Starte ihn am PC in der Agenten-Station.</p></section>');
    if (fid) { const el = document.getElementById(fid); if (el) { el.focus(); if (val != null && el.value !== val) el.value = val; } }
  }

  app.addEventListener('input', e => { if (e.target.id) S.drafts[e.target.id] = e.target.value; });
  app.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const act = b.getAttribute('data-act'); const id = b.getAttribute('data-id'); const k = b.getAttribute('data-k'); const p = S.projects.find(x => x.id === id);
    if (act === 'login') {
      const pw = document.getElementById('pw').value; S.busy = true; S.err = ''; S.drafts.mail = document.getElementById('mail').value.trim(); render();
      const r = await S.sb.auth.signInWithPassword({ email: S.drafts.mail, password: pw });
      S.busy = false; if (r.error) { S.err = 'Anmeldung fehlgeschlagen. Prüfe E-Mail und Passwort.'; render(); return; }
      S.user = r.data.user; await load(); subscribe(); return;
    }
    if (act === 'logout') { await S.sb.auth.signOut(); S.user = null; render(); return; }
    if (act === 'reload') { await load(); return; }
    if (act === 'toggle') { S.open[id] = S.open[id] === false; render(); return; }
    if (!p) return;
    if (act === 'approve') { await send(p, { pid: p.id, kind: 'approve', reqId: k, allow: b.getAttribute('data-v') === '1' }); return; }
    if (act === 'answer') { await send(p, { pid: p.id, kind: 'answer', qid: k, value: (S.drafts['q_' + k] || '').trim() }); delete S.drafts['q_' + k]; return; }
    if (act === 'ctl') {
      if (k === 'stopNow' && !confirm('Sofort stoppen? Der laufende Schritt wird abgebrochen, sein Zwischenstand bleibt im Task-Branch.')) return;
      await send(p, { pid: p.id, kind: 'ctl', cmd: k });
    }
  });

  let ch = null;
  function subscribe() {
    if (ch) return;
    ch = S.sb.channel('hf-station').on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => { clearTimeout(subscribe.t); subscribe.t = setTimeout(load, 400); }).subscribe();
  }
  setInterval(() => { if (S.user && document.visibilityState === 'visible') load(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (S.user && document.visibilityState === 'visible') load(); });

  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    const c = config(); if (!c.url || !c.key || !window.supabase) { render(); return; }
    S.sb = window.supabase.createClient(c.url, c.key, { auth: { persistSession: true, autoRefreshToken: true } });
    const s = await S.sb.auth.getSession(); S.user = s.data && s.data.session ? s.data.session.user : null;
    if (S.user) { await load(); subscribe(); } else render();
  }
  boot().catch(e => { app.innerHTML = '<p class="err pad">Start fehlgeschlagen: ' + esc(e.message || e) + '</p>'; });
})();
