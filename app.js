// HydraForge Station · Handy (0.15)
// Station mit Agenten-Karte, NPC-Modus starten und steuern, Fragen und Ergänzungen, Recherche, eigene Einstellungen.
// Der PC führt alles aus: Das Handy schreibt nur Befehle (station_cmds) oder Antworten ins Projekt („remote“).
(() => {
  'use strict';
  const app = document.getElementById('app');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const arr = v => Array.isArray(v) ? v : [];
  const usd = n => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const hhmm = t => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* privat */ } }, del: k => { try { localStorage.removeItem(k); } catch (e) { /* privat */ } } };
  const S = { sb: null, user: null, projects: [], st: null, cmds: [], err: '', busy: false, drafts: {}, sent: {}, at: 0, tab: store.get('hf_tab') || 'station', sig: '', flash: null, usage: null, shots: {}, logOpen: {}, noStation: false, sel: null };

  function config() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('u') && h.get('k')) { store.set('hf_url', h.get('u')); store.set('hf_key', h.get('k')); history.replaceState(null, '', location.pathname); }
    return { url: store.get('hf_url'), key: store.get('hf_key') };
  }
  const MODE = m => Number(m) === 2 ? 'Autopilot' : 'Copilot';
  const REASON = { fragen: 'Fragen warten', budget: 'Budget', limit: 'Monatslimit', fehler: 'Fehler', meilenstein: 'Meilenstein erreicht', manuell: 'angehalten', neustart: 'PC neu gestartet', unity: 'Unity antwortet nicht', hand: 'Handarbeit', fertig: 'fertig' };
  const npc = p => (p.data && p.data.npc) || null;
  const pcOnline = n => n && n.beat && Date.now() - n.beat < 150000;
  const stOnline = () => S.st && S.st.beat && Date.now() - S.st.beat < 120000;
  const mine = n => !n.owner || !S.user || n.owner === S.user.id;

  // ---------- Laden (alle 5 s bei offenem Bildschirm, sonst sofort per Live-Verbindung) ----------
  async function load(force) {
    if (!S.sb || !S.user) return;
    const [r, st, cm] = await Promise.all([
      S.sb.from('projects').select('id,name,data,updated_at').order('updated_at', { ascending: false }),
      S.noStation ? Promise.resolve({ data: null }) : S.sb.from('station_state').select('data,updated_at').eq('user_id', S.user.id).maybeSingle(),
      S.noStation ? Promise.resolve({ data: [] }) : S.sb.from('station_cmds').select('id,kind,created_at,done_at,result').eq('user_id', S.user.id).order('created_at', { ascending: false }).limit(15)
    ]);
    if (r.error) S.err = r.error.message; else { S.projects = r.data || []; S.err = ''; }
    if (st.error && /station_state|does not exist|schema cache|relation/i.test(st.error.message)) S.noStation = true;
    S.st = st.data ? st.data.data : S.st; S.cmds = arr(cm.data);
    S.at = Date.now();
    const sig = JSON.stringify([S.projects.map(p => [p.id, p.updated_at]), S.st, S.cmds.map(c => [c.id, c.done_at, !!c.result]), S.err, S.tab]);
    if (force || sig !== S.sig) { S.sig = sig; render(); } else liveTick();
  }
  // Antwort ins Projekt (nur für den laufenden NPC-Modus dieses Projekts)
  async function send(p, item) {
    item = Object.assign({ id: uid(), at: Date.now(), by: S.user && S.user.email, pid: p.id }, item);
    const fresh = await S.sb.from('projects').select('data').eq('id', p.id).single();
    const list = arr(fresh.data && fresh.data.data && fresh.data.data.remote).concat([item]).slice(-40);
    const r = await S.sb.rpc('patch_project', { pid: p.id, patch: { remote: list } });
    if (r.error) { flash('Senden fehlgeschlagen: ' + r.error.message, true); return; }
    S.sent[item.id] = item; await load(true);
  }
  // Befehl an den eigenen PC
  async function cmd(kind, payload, okText) {
    if (S.noStation) { flash('Dafür fehlt noch das Server-Update 0.15. Sag dem Admin Bescheid.', true); return false; }
    const r = await S.sb.from('station_cmds').insert({ kind: kind, payload: payload || {} });
    if (r.error) { flash('Senden fehlgeschlagen: ' + r.error.message, true); return false; }
    flash((okText || 'Gesendet') + (stOnline() ? '' : ' · Der PC ist gerade nicht erreichbar, er erledigt es, sobald HydraForge läuft.'));
    await load(true); return true;
  }
  const done = (p, id) => arr((npc(p) || {}).remoteDone).includes(id);
  const waiting = p => Object.values(S.sent).filter(x => x.pid === p.id && !done(p, x.id));
  function flash(t, bad) { S.flash = { t: t, bad: !!bad, at: Date.now() }; render(); setTimeout(() => { if (S.flash && Date.now() - S.flash.at > 4500) { S.flash = null; render(); } }, 5000); }

  // ---------- Anzeige ----------
  function meter(pct, c) { return '<div class="meter"><i style="width:' + Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%;background:' + (c || 'var(--acc)') + '"></i></div>'; }
  function vLogin() {
    const c = config();
    if (!c.url || !c.key) return '<section class="card"><h1>HydraForge Station</h1><p>Öffne diese Seite einmal über den Link aus HydraForge (Einstellungen → Handy). Darin stecken die Server-Daten.</p></section>';
    return '<section class="card"><img src="icon-192.png" alt="" class="logo"><h1>HydraForge Station</h1><p class="muted">Melde dich mit deinem HydraForge-Konto an.</p>' +
      '<label>E-Mail<input id="mail" type="email" autocomplete="username" value="' + esc(S.drafts.mail || '') + '"></label>' +
      '<label>Passwort<input id="pw" type="password" autocomplete="current-password"></label>' +
      (S.err ? '<p class="err">' + esc(S.err) + '</p>' : '') + '<button class="btn p wide" data-act="login"' + (S.busy ? ' disabled' : '') + '>Anmelden</button></section>';
  }
  // Mini-Station: Hydra oben, sechs Räume darunter, Bots laufen mit Ergebnissen hoch und zurück
  const ROOMS = [['planung', 'Planung', '#B69CFF', 'L', 150], ['werkstatt', 'Werkstatt', '#FF9F43', 'R', 150], ['archiv', 'Archiv', '#FFC857', 'L', 270], ['labor', 'Prüflabor', '#5BD69B', 'R', 270], ['werft', 'Asset-Werft', '#FF7AB6', 'L', 390], ['reparatur', 'Reparatur', '#4FD1C5', 'R', 390]];
  const ICO = { planung: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>', werkstatt: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>', archiv: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>', labor: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/>', werft: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>', reparatur: '<path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L2 10l8-8z"/>' };
  const ico = (k, c, z) => '<svg width="' + z + '" height="' + z + '" viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICO[k] + '</svg>';
  const BOT = (c, idle) => '<svg width="26" height="32" viewBox="0 0 26 32" aria-hidden="true" class="bsvg"><line x1="13" y1="1.5" x2="13" y2="5" stroke="' + (idle ? '#8C9BB3' : '#C9D6EA') + '" stroke-width="1.4"/><circle cx="13" cy="1.8" r="1.6" fill="' + c + '"/><rect x="3" y="5" width="20" height="15" rx="7" fill="' + (idle ? '#AEB8C8' : '#E9EEF7') + '"/><rect x="6" y="8.5" width="14" height="8" rx="4" fill="#0B1426"/>' +
    (idle ? '<rect x="8.5" y="12" width="3" height="1.4" rx=".7" fill="' + c + '"/><rect x="14.5" y="12" width="3" height="1.4" rx=".7" fill="' + c + '"/>' : '<rect class="eye" x="8.5" y="11" width="3" height="3" rx="1.5" fill="' + c + '"/><rect class="eye" x="14.5" y="11" width="3" height="3" rx="1.5" fill="' + c + '"/>') +
    '<rect x="7" y="20.5" width="12" height="7.5" rx="3" fill="' + (idle ? '#9AA6B8' : '#D9E2F0') + '"/><rect x="10.5" y="23" width="5" height="2" rx="1" fill="' + c + '"/><rect x="8" y="28" width="3.5" height="4" rx="1.4" fill="#5B6B86"/><rect x="14.5" y="28" width="3.5" height="4" rx="1.4" fill="#5B6B86"/></svg>';
  function vMap(n, run, hasPend) {
    const ag = run ? arr(n.agents) : [];
    const line = hasPend ? 'Ein Agent wartet auf deine Freigabe.' : arr(S.st && S.st.dialogs).length ? 'Unity wartet auf eine Antwort.' : run && n.step ? n.step : run ? 'Arbeitet.' : 'Pause.';
    const rooms = ROOMS.map(r => { const js = ag.filter(a => a.room === r[0]); const on = js.length > 0; const need = js.some(a => a.needs); const L = r[3] === 'L';
      return '<div class="mr' + (on ? ' on' : '') + (need ? ' need' : '') + '" style="left:' + (L ? 6 : 194) + 'px;top:' + r[4] + 'px;--c:' + r[2] + '"><div class="mrh">' + ico(r[0], on ? r[2] : '#8C9BB3', 13) + '<span>' + r[1] + '</span></div>' +
        '<div class="mmon" style="' + (L ? 'left' : 'right') + ':10px">' + ico(r[0], on ? r[2] : '#4A586F', 14) + '</div>' +
        '<div class="mrf"><span class="mjob">' + esc(js[0] ? js[0].label : 'bereit') + '</span>' + (js[0] ? '<span class="mdet">' + esc(js[0].needs ? 'wartet auf dich' : js[0].detail || '') + '</span>' : '') + '</div></div>'; }).join('');
    const now = Date.now() / 1000;
    const bots = ROOMS.map((r, ri) => { const js = ag.filter(a => a.room === r[0]); const L = r[3] === 'L'; const row = (r[4] + 52); const restX = L ? 132 : 226;
      if (!js.length) return '<div class="mb idle" style="transform:translate(' + (restX - 13 + (L ? -20 : 20)) + 'px,' + (row - 6) + 'px)">' + BOT(r[2], true) + '<i class="zz">z</i></div>';
      return js.slice(0, 2).map((a, i) => { if (a.needs) return '<div class="mb" style="transform:translate(' + (restX - 13 + i * 26) + 'px,' + (row - 16) + 'px)">' + BOT(r[2]) + '<i class="bang">!</i></div>';
        const dur = 10 + (ri % 3); const d = -((now + ri * 2.3 + i * 4) % dur);
        return '<div class="mb walk w' + ri + '" style="animation-delay:' + d.toFixed(2) + 's;margin-left:' + (i * 24) + 'px;animation-duration:' + dur + 's">' + BOT(r[2]) + '<i class="pkt" style="--c:' + r[2] + ';animation-delay:' + d.toFixed(2) + 's;animation-duration:' + dur + 's"></i></div>'; }).join(''); }).join('');
    return '<div class="block"><h3>Agenten-Station</h3><div class="map"><div class="spine"></div>' + [202, 322, 442].map(y => '<div class="arm" style="top:' + (y - 7) + 'px;left:164px"></div><div class="arm" style="top:' + (y - 7) + 'px;left:185px"></div>').join('') +
      '<div class="ring"></div><div class="hub"><img src="hydra.png" alt="Hydra" width="62" height="62"><span>AUFSEHER</span></div><div class="say">' + esc(line) + '</div>' + rooms + bots + '</div></div>';
  }
  function vProject(p) {
    const n = npc(p); const d = p.data || {}; const ts = arr(d.tasks); const doneN = ts.filter(t => t.status === 'done').length;
    const on = pcOnline(n); const run = n.state === 'laeuft' && on; const st = n.stats || {}; const my = mine(n);
    const pend = arr(n.pending); const qs = arr(n.questions).filter(q => !q.answer); const wt = waiting(p);
    const openPh = ts.filter(t => t.status !== 'done'); const ph = openPh.length ? Math.min.apply(null, openPh.map(t => Number(t.phase) || 1)) : null;
    const inPh = ph ? ts.filter(t => (Number(t.phase) || 1) === ph) : ts; const phDone = inPh.filter(t => t.status === 'done').length;
    const state = !n.on ? ['aus', 'off'] : n.state === 'fertig' ? ['fertig', 'fin'] : run ? ['läuft', 'run'] : n.state === 'laeuft' ? ['PC offline?', 'warn'] : ['pausiert', 'warn'];
    const shot = n.shotRemote && my ? S.shots[p.id] : null;
    return '<section class="card proj' + (run ? ' live' : '') + '">' +
      '<div class="phead"><span class="pname">' + esc(p.name) + '</span><span class="pill ' + state[1] + '">' + state[0] + '</span></div>' +
      '<p class="muted small">' + MODE(n.mode) + (n.ownerName ? ' · ' + (my ? 'dein Lauf' : 'Lauf von ' + esc(n.ownerName)) : '') + ' · PC ' + (on ? 'online' : 'nicht erreichbar' + (n.beat ? ' (zuletzt ' + hhmm(n.beat) + ')' : '')) + '</p>' +
      (n.state !== 'laeuft' && n.reasonText ? '<p class="why">' + esc(REASON[n.reason] ? REASON[n.reason] + ': ' : '') + esc(n.reasonText) + '</p>' : '') +
      (run && n.step ? '<p class="step">Gerade: ' + esc(n.step) + '</p>' : '') +
      (my && pend.length ? '<div class="block warnb"><h3>Wartet auf dich</h3>' + pend.map(a => { const sent = wt.find(x => x.kind === 'approve' && x.reqId === a.reqId);
        return '<div class="appr"><b>' + esc(a.explain || a.why || 'Freigabe') + '</b>' + (a.code ? '<code>' + esc(a.code) + '</code>' : '') + (a.verdict ? '<span class="verd' + (a.crit ? ' crit' : '') + '">' + esc(a.verdict) + '</span>' : '') + (a.tn ? '<span class="muted small">Task #' + a.tn + '</span>' : '') +
          (sent ? '<span class="muted small">' + (sent.allow ? 'Erlaubt' : 'Abgelehnt') + ' · wartet auf den PC …</span>' : '<div class="row"><button class="btn p" data-act="approve" data-id="' + esc(p.id) + '" data-k="' + esc(a.reqId) + '" data-v="1">Erlauben</button><button class="btn" data-act="approve" data-id="' + esc(p.id) + '" data-k="' + esc(a.reqId) + '" data-v="0">Ablehnen</button></div>') + '</div>'; }).join('') + '</div>' : '') +
      '<div class="kpis"><div><span class="lbl">Budget</span><b>' + usd(n.spent || 0) + ' / ' + usd(n.budget || 0) + '</b>' + meter(n.budget ? (n.spent || 0) / n.budget : 0) + '</div>' +
      '<div><span class="lbl">' + (ph ? 'Phase ' + ph : 'Alle Phasen') + '</span><b>' + phDone + ' / ' + inPh.length + '</b>' + meter(inPh.length ? phDone / inPh.length : 1, 'var(--ok)') + '</div>' +
      '<div><span class="lbl">Gesamt</span><b>' + doneN + ' / ' + ts.length + '</b><span class="muted small">' + (st.done || 0) + ' ✓ · ' + (st.failed || 0) + ' ✕</span></div></div>' +
      (my && n.on && n.state !== 'fertig' ? '<div class="row ctl">' + (run ? '<button class="btn p" data-act="ctl" data-id="' + esc(p.id) + '" data-k="stopAfter">Nach Schritt anhalten</button><button class="btn" data-act="ctl" data-id="' + esc(p.id) + '" data-k="stopNow">Stopp</button>' : '<button class="btn p" data-act="ctl" data-id="' + esc(p.id) + '" data-k="resume"' + (on ? '' : ' disabled') + '>' + (n.reason === 'meilenstein' ? 'Weiter zum nächsten Meilenstein' : 'Fortsetzen') + '</button>') + '</div>' +
        (wt.some(x => x.kind === 'ctl') ? '<p class="muted small">Befehl gesendet · wartet auf den PC …</p>' : '') + (!on ? '<p class="muted small">Steuern geht nur, wenn HydraForge auf dem PC läuft.</p>' : '') : '') +
      (my && arr(n.blocked).length && !run ? '<div class="block"><h3>Gescheiterte Tasks</h3>' + arr(n.blocked).map(b => '<div class="q"><span><b>#' + b.n + ' ' + esc(b.t) + '</b>' + (b.cnt ? ' · blockiert ' + b.cnt : '') + '</span>' + (b.why ? '<span class="muted small">' + esc(b.why) + '</span>' : '') +
        '<div class="row wrap"><button class="btn sm p" data-act="task" data-id="' + esc(p.id) + '" data-k="retry" data-t="' + esc(b.tid) + '">Neu versuchen</button><button class="btn sm" data-act="task" data-id="' + esc(p.id) + '" data-k="done" data-t="' + esc(b.tid) + '">Erledigt</button><button class="btn sm" data-act="task" data-id="' + esc(p.id) + '" data-k="skip" data-t="' + esc(b.tid) + '">Überspringen</button></div></div>').join('') + '</div>' : '') +
      (qs.length ? '<div class="block"><h3>Fragen · ' + qs.length + '</h3>' + qs.map(q => { const sent = wt.find(x => x.kind === 'answer' && x.qid === q.id);
        return '<div class="q' + (q.crit ? ' crit' : '') + '"><span>' + (q.crit ? '<b class="crit">KRITISCH</b> · ' : '') + (q.tn ? '#' + q.tn + ' · ' : '') + esc(q.q) + '</span>' + (q.guess ? '<span class="muted small">Vorschlag: ' + esc(q.guess) + '</span>' : '') +
          (!my ? '' : sent ? '<span class="muted small">Gesendet · wartet auf den PC …</span>' : '<input id="q_' + esc(q.id) + '" placeholder="' + (q.guess ? 'Leer = Vorschlag übernehmen' : 'Deine Antwort') + '" value="' + esc(S.drafts['q_' + q.id] || '') + '"><textarea id="qx_' + esc(q.id) + '" rows="2" placeholder="Ergänzung (optional)">' + esc(S.drafts['qx_' + q.id] || '') + '</textarea><button class="btn' + (q.crit ? ' p' : '') + '" data-act="answer" data-id="' + esc(p.id) + '" data-k="' + esc(q.id) + '">Senden</button>') + '</div>'; }).join('') + '</div>' : '') +
      (n.on && n.state !== 'fertig' ? vMap(n, run, pend.length > 0) : '') +
      (my && n.shotRemote ? '<div class="block"><h3>Letzter Spieltest · #' + esc(n.shotRemote.tn || '') + '</h3>' + (shot && shot.at === n.shotRemote.at ? '<img class="shot" src="' + shot.url + '" alt="Screenshot aus dem Spieltest">' : '<button class="btn sm" data-act="shot" data-id="' + esc(p.id) + '">Bild anzeigen</button>') + '<span class="muted small">Nur angezeigt, nicht gespeichert.</span></div>' : '') +
      (my && n.on ? '<details class="block"' + (S.drafts['open_more_' + p.id] ? ' open' : '') + '><summary data-act="more" data-id="' + esc(p.id) + '">Ergänzen, Budget, Reparatur</summary>' +
        '<label>Ergänzung zum Projekt<textarea id="note_' + esc(p.id) + '" rows="3" placeholder="z. B. Gebäude zeigen beim Platzieren eine Vorschau">' + esc(S.drafts['note_' + p.id] || '') + '</textarea></label>' +
        '<div class="row wrap"><input id="notetn_' + esc(p.id) + '" inputmode="numeric" placeholder="zu Task # (optional)" value="' + esc(S.drafts['notetn_' + p.id] || '') + '" style="flex:1 1 140px"><button class="btn sm" data-act="note" data-id="' + esc(p.id) + '">Als Klärung</button><button class="btn sm p" data-act="noteTask" data-id="' + esc(p.id) + '">Als neuen Task</button></div>' +
        '<label>Budget für diesen Lauf ($)<input id="bud_' + esc(p.id) + '" inputmode="decimal" value="' + esc(S.drafts['bud_' + p.id] || n.budget || '') + '"></label>' +
        '<div class="row wrap"><button class="btn sm" data-act="mode" data-id="' + esc(p.id) + '" data-k="1"' + (Number(n.mode) === 1 ? ' disabled' : '') + '>Copilot</button><button class="btn sm" data-act="mode" data-id="' + esc(p.id) + '" data-k="2"' + (Number(n.mode) === 2 ? ' disabled' : '') + '>Autopilot</button><button class="btn sm p" data-act="budget" data-id="' + esc(p.id) + '">Budget speichern</button></div>' +
        '<div class="row wrap" style="margin-top:10px"><button class="btn sm" data-act="repair" data-id="' + esc(p.id) + '">Projekt prüfen und reparieren</button></div><span class="muted small">Prüft Kompilieren, einen kurzen Spieltest und fehlende Verweise. Gefundene Fehler werden ein Reparatur-Task.</span></details>' : '') +
      (arr(n.log).length ? '<details class="block"' + (S.logOpen[p.id] ? ' open' : '') + '><summary data-act="log" data-id="' + esc(p.id) + '">Verlauf</summary><div class="log">' + arr(n.log).slice(-14).reverse().map(l => esc(hhmm(l.at) + '  ' + l.text)).join('<br>') + '</div></details>' : '') + '</section>';
  }
  function vStart() {
    const own = S.projects.some(p => { const n = npc(p); return n && n.on && n.state !== 'fertig' && mine(n); });
    if (own || !S.st) return '';
    const ready = arr(S.st.projects).filter(x => x.ready && !(S.projects.find(p => p.id === x.id && npc(p) && npc(p).on)));
    if (!ready.length) return '';
    const sel = S.drafts.start_pid || ready[0].id; const mode = S.drafts.start_mode || '1';
    return '<section class="card"><h3>NPC-Modus starten</h3><label>Projekt<select id="start_pid">' + ready.map(x => '<option value="' + esc(x.id) + '"' + (x.id === sel ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></label>' +
      '<div class="seg" role="radiogroup" aria-label="Modus"><button role="radio" aria-checked="' + (mode === '1') + '" class="' + (mode === '1' ? 'on' : '') + '" data-act="startMode" data-k="1">Copilot<small>Stopp an Meilensteinen</small></button><button role="radio" aria-checked="' + (mode === '2') + '" class="' + (mode === '2' ? 'on' : '') + '" data-act="startMode" data-k="2">Autopilot<small>läuft durch</small></button></div>' +
      '<label>Budget ($)<input id="start_bud" inputmode="decimal" value="' + esc(S.drafts.start_bud || '20') + '"></label><button class="btn p wide" data-act="start"' + (stOnline() ? '' : ' disabled') + '>Starten</button>' + (stOnline() ? '<span class="muted small">Unity muss am PC mit dem Projekt offen sein.</span>' : '<span class="muted small">Der PC ist gerade nicht erreichbar. HydraForge muss laufen.</span>') + '</section>';
  }
  function vDialogs() {
    const dl = arr(S.st && S.st.dialogs); if (!dl.length) return '';
    return '<section class="card warnb"><h3>Unity wartet auf dich</h3>' + dl.map(d => '<div class="appr"><span class="muted small">' + esc(d.title) + '</span><b>' + esc(String(d.text || '').slice(0, 400)) + '</b><div class="row wrap">' + arr(d.buttons).map((b, i) => '<button class="btn' + (i === 0 ? ' p' : '') + '" data-act="dlg" data-k="' + esc(d.hwnd) + '" data-v="' + esc(b) + '">' + esc(b) + '</button>').join('') + '</div></div>').join('') + '</section>';
  }
  function vStation() {
    const ps = S.projects.filter(p => npc(p) && (npc(p).on || npc(p).state === 'fertig'));
    ps.sort((a, b) => (mine(npc(b)) ? 1 : 0) - (mine(npc(a)) ? 1 : 0));
    return vDialogs() + (ps.length ? ps.map(vProject).join('') : '<section class="card"><p class="muted">Gerade ist kein NPC-Modus aktiv.</p></section>') + vStart();
  }
  function vResearch() {
    const R = (S.st && S.st.research) || {}; const q = arr(R.queue); const un = arr(R.unverified); const dc = R.disc; const dirs = arr(R.dirs).length ? R.dirs : [['ueberrasch', 'Überrasch mich']];
    return '<section class="card"><h3>Spiele recherchieren</h3><label>Titel (mehrere mit Komma)<textarea id="res_titles" rows="2" placeholder="z. B. Anno 1800, They Are Billions">' + esc(S.drafts.res_titles || '') + '</textarea></label><button class="btn p wide" data-act="research">Recherchieren</button></section>' +
      '<section class="card"><h3>Neue Spiele entdecken</h3><label>Richtung<select id="disc_dir">' + dirs.map(x => '<option value="' + esc(x[0]) + '"' + ((S.drafts.disc_dir || 'ueberrasch') === x[0] ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select></label>' +
      ((S.drafts.disc_dir || '') === 'genre' ? '<label>Genre<input id="disc_genre" value="' + esc(S.drafts.disc_genre || '') + '" placeholder="z. B. Aufbauspiel"></label>' : '') + '<button class="btn wide" data-act="discover">Vorschläge holen</button>' +
      (dc ? '<div class="block"><h3>' + esc(dc.richtung) + ' · ' + arr(dc.list).length + ' Vorschläge</h3>' + arr(dc.list).map((g, i) => '<label class="chk' + (g.skip ? ' off' : '') + '"><input type="checkbox" id="dc_' + i + '"' + ((S.drafts['dc_' + i] !== undefined ? S.drafts['dc_' + i] === '1' : g.on) ? ' checked' : '') + '><span><b>' + esc(g.titel) + '</b>' + (g.jahr ? ' (' + g.jahr + ')' : '') + '<br><span class="muted small">' + esc(g.skip || g.warum) + '</span></span></label>').join('') +
        '<div class="row"><button class="btn p" data-act="discGo">Ausgewählte recherchieren</button><button class="btn" data-act="discDrop">Verwerfen</button></div></div>' : '') + '</section>' +
      (q.length ? '<section class="card"><h3>Warteschlange' + (R.running ? ' · läuft' : '') + '</h3>' + q.slice().reverse().map(x => '<div class="qrow"><span>' + esc(x.title) + '</span><span class="pill ' + (x.status === 'läuft' ? 'run' : x.status === 'fertig' ? 'fin' : x.status === 'fehler' || x.status === 'verworfen' ? 'warn' : '') + '">' + esc(x.status) + '</span>' + (x.msg ? '<span class="muted small">' + esc(x.msg) + '</span>' : '') + '</div>').join('') + '</section>' : '') +
      '<section class="card"><h3>Ungeprüfte Ergebnisse · ' + un.length + '</h3>' + (un.length ? un.map(g => '<div class="qrow"><span><b>' + esc(g.title) + '</b>' + (g.year ? ' (' + g.year + ')' : '') + ' <span class="muted small">' + g.cards + ' Ideen-Karten</span></span><div class="row"><button class="btn sm p" data-act="verify" data-k="' + esc(g.id) + '">Bestätigen</button><button class="btn sm" data-act="discard" data-k="' + esc(g.id) + '">Verwerfen</button></div></div>').join('') + (un.length > 1 ? '<button class="btn wide" data-act="verifyAll">Alle ' + un.length + ' bestätigen</button>' : '') : '<p class="muted">Nichts zu prüfen.</p>') + '</section>';
  }
  function vSettings() {
    const pr = (S.st && S.st.prefs) || {}; const nf = pr.notify || {}; const u = S.usage;
    const kinds = [['stop', 'NPC-Modus hält an'], ['approval', 'Kritische Freigabe wartet'], ['done', 'NPC-Modus ist fertig'], ['dialog', 'Unity wartet auf eine Antwort']];
    return '<section class="card"><h3>Dein Verbrauch</h3>' + (u ? '<div class="kpis two"><div><span class="lbl">Diesen Monat</span><b>' + usd(u.month) + '</b>' + (pr.monthLimit ? meter(u.month / pr.monthLimit) + '<span class="muted small">von ' + usd(pr.monthLimit) + '</span>' : '') + '</div><div><span class="lbl">Heute</span><b>' + usd(u.day) + '</b>' + (pr.dayLimit ? meter(u.day / pr.dayLimit, 'var(--ok)') + '<span class="muted small">NPC-Tageslimit ' + usd(pr.dayLimit) + '</span>' : '') + '</div></div>' : '<p class="muted">Wird geladen …</p>') +
      '<span class="muted small">Alles läuft über deinen eigenen Schlüssel und zählt gegen dein eigenes Limit.</span></section>' +
      '<section class="card"><h3>Limits</h3><label>Monatslimit ($, 0 = keins)<input id="lim_month" inputmode="decimal" value="' + esc(S.drafts.lim_month !== undefined ? S.drafts.lim_month : pr.monthLimit || 0) + '"></label><button class="btn wide" data-act="saveMonth">Monatslimit speichern</button>' +
      '<label>Tageslimit für den NPC-Modus ($, 0 = keins)<input id="lim_day" inputmode="decimal" value="' + esc(S.drafts.lim_day !== undefined ? S.drafts.lim_day : pr.dayLimit || 0) + '"></label><button class="btn wide" data-act="saveDay">Tageslimit speichern</button></section>' +
      '<section class="card"><h3>Benachrichtigungen</h3>' + (pushOk() ? '<button class="btn wide' + (pushOn() ? '' : ' p') + '" data-act="push">' + (pushOn() ? 'Auf diesem Handy an · neu anmelden' : 'Auf diesem Handy einschalten') + '</button>' : '<p class="muted">Dieser Browser kann keine Benachrichtigungen. Öffne die App über Chrome vom Startbildschirm.</p>') +
      kinds.map(k => '<label class="chk"><input type="checkbox" id="nf_' + k[0] + '"' + (nf[k[0]] !== false ? ' checked' : '') + '><span>' + k[1] + '</span></label>').join('') + '<button class="btn wide" data-act="saveNotify">Auswahl speichern</button></section>' +
      '<section class="card"><p class="muted small">Angemeldet als ' + esc(S.user.email) + '</p><button class="btn wide" data-act="logout">Abmelden</button></section>';
  }
  function liveTick() { const el = document.getElementById('liveago'); if (el) { const s = Math.max(0, Math.round((Date.now() - S.at) / 1000)); el.textContent = 'Live · vor ' + s + ' s'; } }
  function render() {
    const a = document.activeElement; const fid = a && a.id; const val = a && a.value; const sel = a && a.selectionStart;
    if (!S.user) { app.innerHTML = vLogin(); return; }
    const tabs = [['station', 'Station'], ['research', 'Recherche'], ['settings', 'Einstellungen']];
    const lastRes = S.cmds.find(c => c.result && Date.now() - new Date(c.created_at).getTime() < 120000 && c.result.ok === false);
    app.innerHTML = '<header class="top"><img src="icon-192.png" alt="" class="logo sm"><div><b>HydraForge Station</b><span class="muted small livetxt"><i class="ldot' + (stOnline() ? '' : ' off') + '"></i><span id="liveago">Live · vor 0 s</span>' + (stOnline() ? '' : ' · PC nicht erreichbar') + '</span></div><span class="grow"></span>' + (pushOk() && !pushOn() ? '<button class="btn sm" data-act="push">🔕 Push an</button>' : '') + '</header>' +
      (S.flash ? '<p class="flash' + (S.flash.bad ? ' bad' : '') + '" role="status">' + esc(S.flash.t) + '</p>' : '') +
      (lastRes ? '<p class="flash bad" role="status">PC meldet: ' + esc(lastRes.result.msg || 'fehlgeschlagen') + '</p>' : '') +
      (S.err ? '<p class="err pad">' + esc(S.err) + '</p>' : '') +
      (S.noStation ? '<p class="flash bad">Für Start, Recherche und Einstellungen vom Handy fehlt noch das Server-Update 0.15 (update_0_15.sql).</p>' : '') +
      '<div class="content">' + (S.tab === 'research' ? vResearch() : S.tab === 'settings' ? vSettings() : vStation()) + '</div>' +
      '<nav class="tabs" aria-label="Bereiche">' + tabs.map(t => '<button class="' + (S.tab === t[0] ? 'on' : '') + '" data-act="tab" data-k="' + t[0] + '" aria-current="' + (S.tab === t[0] ? 'page' : 'false') + '">' + t[1] + '</button>').join('') + '</nav>';
    liveTick();
    document.querySelectorAll('.map').forEach(m => { const w = m.parentElement.clientWidth; if (w) m.style.zoom = Math.min(1, w / 358); });
    if (fid) { const el = document.getElementById(fid); if (el) { el.focus(); if (val != null && el.value !== val) el.value = val; try { if (sel != null) el.setSelectionRange(sel, sel); } catch (e) { /* select */ } } }
  }

  // ---------- Benachrichtigungen (Web-Push vom PC) ----------
  const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const pushOn = () => pushOk() && Notification.permission === 'granted' && !!store.get('hf_push_ep');
  const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); };
  async function pushEnable() {
    const p = S.projects.find(x => npc(x) && npc(x).vapid && npc(x).on && mine(npc(x)));
    if (!p) { flash('Starte oder pausiere zuerst einen NPC-Modus. Dann kann sich das Handy anmelden.', true); return; }
    if (!pcOnline(npc(p))) { flash('Der PC ist gerade nicht erreichbar. HydraForge muss laufen.', true); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { flash('Benachrichtigungen sind blockiert. Erlaube sie in den Chrome-Einstellungen für diese Seite.', true); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription(); const key = npc(p).vapid;
    if (sub && store.get('hf_push_key') !== key) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    await send(p, { kind: 'pushsub', sub: sub.toJSON() });
    store.set('hf_push_ep', sub.endpoint); store.set('hf_push_key', key); flash('Benachrichtigungen sind an.');
  }
  async function usageLoad() {
    const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0); const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const r = await S.sb.from('usage').select('cost_usd,created_at,provider').eq('user_id', S.user.id).gte('created_at', m0.toISOString());
    const rows = arr(r.data).filter(x => x.provider !== 'local');
    S.usage = { month: rows.reduce((s, x) => s + Number(x.cost_usd || 0), 0), day: rows.filter(x => new Date(x.created_at) >= d0).reduce((s, x) => s + Number(x.cost_usd || 0), 0) }; render();
  }
  // Spieltest-Bild nur im Speicher (kein Cache, keine Datei auf dem Handy)
  async function shotLoad(p) {
    const n = npc(p); if (!n || !n.shotRemote) return;
    const r = await S.sb.storage.from('station').createSignedUrl(n.shotRemote.path, 60);
    if (r.error) { flash('Bild nicht verfügbar.', true); return; }
    const res = await fetch(r.data.signedUrl, { cache: 'no-store' }); const blob = await res.blob();
    const old = S.shots[p.id]; if (old) URL.revokeObjectURL(old.url);
    S.shots[p.id] = { url: URL.createObjectURL(blob), at: n.shotRemote.at }; render();
  }

  // ---------- Bedienung ----------
  app.addEventListener('input', e => { if (e.target.id) S.drafts[e.target.id] = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value; });
  app.addEventListener('change', e => { const t = e.target; if (!t.id) return; S.drafts[t.id] = t.type === 'checkbox' ? (t.checked ? '1' : '0') : t.value; if (t.id === 'disc_dir' || t.id === 'start_pid') render(); });
  app.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const act = b.getAttribute('data-act'); const id = b.getAttribute('data-id'); const k = b.getAttribute('data-k'); const p = S.projects.find(x => x.id === id);
    try {
      if (act === 'login') {
        const pw = document.getElementById('pw').value; S.busy = true; S.err = ''; S.drafts.mail = document.getElementById('mail').value.trim(); render();
        const r = await S.sb.auth.signInWithPassword({ email: S.drafts.mail, password: pw });
        S.busy = false; if (r.error) { S.err = 'Anmeldung fehlgeschlagen. Prüfe E-Mail und Passwort.'; render(); return; }
        S.user = r.data.user; await load(true); subscribe(); return;
      }
      if (act === 'logout') { await S.sb.auth.signOut(); S.user = null; render(); return; }
      if (act === 'tab') { S.tab = k; store.set('hf_tab', k); if (k === 'settings') usageLoad(); render(); window.scrollTo(0, 0); return; }
      if (act === 'push') { if (pushOn() && !confirm('Benachrichtigungen sind an. Neu anmelden (z. B. wenn keine mehr ankommen)?')) return; store.del('hf_push_ep'); await pushEnable(); return; }
      if (act === 'log') { e.preventDefault(); S.logOpen[id] = !S.logOpen[id]; render(); return; }
      if (act === 'more') { e.preventDefault(); S.drafts['open_more_' + id] = !S.drafts['open_more_' + id]; render(); return; }
      if (act === 'startMode') { S.drafts.start_mode = k; render(); return; }
      if (act === 'start') { const pid = S.drafts.start_pid || (document.getElementById('start_pid') || {}).value; const bud = Number(String(S.drafts.start_bud || '20').replace(',', '.')) || 20; const mode = Number(S.drafts.start_mode || 1);
        const nm = (arr(S.st && S.st.projects).find(x => x.id === pid) || {}).name || '';
        if (!confirm('NPC-Modus für „' + nm + '“ starten? ' + MODE(mode) + ', Budget ' + usd(bud) + '. Die Kosten laufen über deinen Schlüssel.')) return;
        await cmd('npcStart', { pid: pid, mode: mode, budget: bud }, 'Start gesendet'); return; }
      if (act === 'dlg') { await cmd('dlg', { hwnd: k, button: b.getAttribute('data-v') }, '„' + b.getAttribute('data-v') + '“ gesendet'); return; }
      if (act === 'research') { const t = String(S.drafts.res_titles || '').split(/[\n;,]+/).map(x => x.trim()).filter(x => x.length > 1); if (!t.length) { flash('Gib mindestens einen Spieletitel ein.', true); return; } if (await cmd('research', { titles: t }, t.length + ' in die Warteschlange')) S.drafts.res_titles = ''; return; }
      if (act === 'discover') { await cmd('discover', { dir: S.drafts.disc_dir || 'ueberrasch', genre: S.drafts.disc_genre || '' }, 'Vorschläge werden geholt'); return; }
      if (act === 'discGo') { const dc = S.st && S.st.research && S.st.research.disc; const t = arr(dc && dc.list).filter((g, i) => S.drafts['dc_' + i] !== undefined ? S.drafts['dc_' + i] === '1' : g.on).map(g => g.titel); await cmd('discGo', { titles: t }, t.length + ' werden recherchiert'); Object.keys(S.drafts).filter(x => /^dc_/.test(x)).forEach(x => delete S.drafts[x]); return; }
      if (act === 'discDrop') { await cmd('discDrop', {}, 'Vorschläge verworfen'); return; }
      if (act === 'verify') { await cmd('verify', { gid: k }, 'Bestätigt'); return; }
      if (act === 'verifyAll') { await cmd('verify', { all: true }, 'Alle bestätigt'); return; }
      if (act === 'discard') { if (!confirm('Dieses Ergebnis verwerfen? Es wird aus der Bibliothek gelöscht.')) return; await cmd('discard', { gid: k }, 'Verworfen'); return; }
      if (act === 'saveMonth') { const v = Math.max(0, Number(String(S.drafts.lim_month || 0).replace(',', '.')) || 0); const r = await S.sb.rpc('set_my_limit', { v: v }); if (r.error) flash(r.error.message, true); else { flash(v ? 'Monatslimit gespeichert.' : 'Monatslimit aufgehoben.'); delete S.drafts.lim_month; } return; }
      if (act === 'saveDay') { const v = Math.max(0, Number(String(S.drafts.lim_day || 0).replace(',', '.')) || 0); await cmd('prefs', { dayLimit: v }, 'Tageslimit gesendet'); delete S.drafts.lim_day; return; }
      if (act === 'saveNotify') { const nf = {}; ['stop', 'approval', 'done', 'dialog'].forEach(x => { const el = document.getElementById('nf_' + x); nf[x] = !el || el.checked; }); await cmd('prefs', { notify: nf }, 'Auswahl gesendet'); return; }
      if (!p) return;
      if (act === 'approve') { await send(p, { kind: 'approve', reqId: k, allow: b.getAttribute('data-v') === '1' }); return; }
      if (act === 'answer') { await send(p, { kind: 'answer', qid: k, value: (S.drafts['q_' + k] || '').trim(), extra: (S.drafts['qx_' + k] || '').trim() }); delete S.drafts['q_' + k]; delete S.drafts['qx_' + k]; return; }
      if (act === 'ctl') { if (k === 'stopNow' && !confirm('Sofort stoppen? Der laufende Schritt wird abgebrochen, sein Zwischenstand bleibt im Task-Branch.')) return; await send(p, { kind: 'ctl', cmd: k }); return; }
      if (act === 'task') { const lbl = { retry: 'Neu versuchen (kostet Budget)?', done: 'Als erledigt markieren? Nur, wenn du es selbst gelöst hast.', skip: 'Überspringen? Abhängige Tasks dürfen dann trotzdem starten.' }[k]; if (!confirm(lbl)) return; await send(p, { kind: 'task', tid: b.getAttribute('data-t'), action: k }); return; }
      if (act === 'note' || act === 'noteTask') { const t = String(S.drafts['note_' + p.id] || '').trim(); if (t.length < 3) { flash('Schreib zuerst die Ergänzung.', true); return; } const tn = Number(S.drafts['notetn_' + p.id]) || null;
        await send(p, { kind: 'note', text: t, tn: tn, asTask: act === 'noteTask' }); delete S.drafts['note_' + p.id]; delete S.drafts['notetn_' + p.id]; flash(act === 'noteTask' ? 'Neuer Task wird angelegt.' : 'Ergänzung gesendet.'); return; }
      if (act === 'mode') { await send(p, { kind: 'set', mode: Number(k) }); return; }
      if (act === 'budget') { const v = Number(String(S.drafts['bud_' + p.id] || '').replace(',', '.')); if (!(v >= 1)) { flash('Gib ein Budget ab 1 $ ein.', true); return; } await send(p, { kind: 'set', budget: v }); delete S.drafts['bud_' + p.id]; return; }
      if (act === 'repair') { if (!confirm('Projekt prüfen? Das dauert etwa eine Minute. Gefundene Fehler werden ein Reparatur-Task.')) return; await cmd('repair', { pid: p.id }, 'Prüfung gestartet'); return; }
      if (act === 'shot') { await shotLoad(p); return; }
    } catch (err) { flash('Fehler: ' + (err.message || err), true); }
  });

  let ch = null;
  function subscribe() {
    if (ch) return;
    const again = () => { clearTimeout(subscribe.t); subscribe.t = setTimeout(() => load(), 300); };
    ch = S.sb.channel('hf-station').on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, again)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'station_state', filter: 'user_id=eq.' + S.user.id }, again)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'station_cmds', filter: 'user_id=eq.' + S.user.id }, again).subscribe();
  }
  setInterval(() => { if (S.user && document.visibilityState === 'visible') load(); }, 5000);
  setInterval(liveTick, 1000);
  document.addEventListener('visibilitychange', () => { if (S.user && document.visibilityState === 'visible') load(true); });

  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    const c = config(); if (!c.url || !c.key || !window.supabase) { render(); return; }
    S.sb = window.supabase.createClient(c.url, c.key, { auth: { persistSession: true, autoRefreshToken: true } });
    const s = await S.sb.auth.getSession(); S.user = s.data && s.data.session ? s.data.session.user : null;
    if (S.user) { await load(true); subscribe(); if (S.tab === 'settings') usageLoad(); } else render();
  }
  boot().catch(e => { app.innerHTML = '<p class="err pad">Start fehlgeschlagen: ' + esc(e.message || e) + '</p>'; });
})();
