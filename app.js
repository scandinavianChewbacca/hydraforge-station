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
  const S = { runImgs: {}, itemImgs: {}, animSel: {}, animFor: null, gameFor: null, assetHl: null, sb: null, user: null, projects: [], st: null, cmds: [], err: '', busy: false, drafts: {}, sent: {}, at: 0, tab: store.get('hf_tab') || 'station', sig: '', flash: null, usage: null, shots: {}, logOpen: {}, noStation: false, sel: null };

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
    const r = await S.sb.from('station_cmds').insert({ kind: kind, payload: payload || {} }).select('id').single();
    if (r.error) { flash('Senden fehlgeschlagen: ' + r.error.message, true); return false; }
    if (okText !== null) flash((okText || 'Gesendet') + (stOnline() ? '' : ' · Der PC ist gerade nicht erreichbar, er erledigt es, sobald HydraForge läuft.'));
    await load(true); return (r.data && r.data.id) || true;
  }
  // Auf das Ergebnis eines Befehls warten (z. B. Vorschau-Datei), höchstens 90 s
  async function cmdWait(kind, payload, okText) {
    const id = await cmd(kind, payload, okText); if (!id || id === true) return null;
    for (let i = 0; i < 45; i++) { await new Promise(r => setTimeout(r, 2000)); const q = await S.sb.from('station_cmds').select('result').eq('id', id).maybeSingle(); if (q.data && q.data.result) return q.data.result; }
    flash('Der PC hat nicht rechtzeitig geantwortet.', true); return null;
  }
  async function signed(path) { const r = await S.sb.storage.from('station').createSignedUrl(path, 120); if (r.error) throw new Error(r.error.message); const res = await fetch(r.data.signedUrl, { cache: 'no-store' }); return URL.createObjectURL(await res.blob()); }
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
  const ICO = { planung: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>', werkstatt: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>', archiv: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>', labor: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/>', werft: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>', reparatur: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>' };
  const ico = (k, c, z) => '<svg width="' + z + '" height="' + z + '" viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICO[k] + '</svg>';
  const BOT = (c, idle) => '<svg width="26" height="32" viewBox="0 0 26 32" aria-hidden="true" class="bsvg"><line x1="13" y1="1.5" x2="13" y2="5" stroke="' + (idle ? '#8C9BB3' : '#C9D6EA') + '" stroke-width="1.4"/><circle cx="13" cy="1.8" r="1.6" fill="' + c + '"/><rect x="3" y="5" width="20" height="15" rx="7" fill="' + (idle ? '#AEB8C8' : '#E9EEF7') + '"/><rect x="6" y="8.5" width="14" height="8" rx="4" fill="#0B1426"/>' +
    (idle ? '<rect x="8.5" y="12" width="3" height="1.4" rx=".7" fill="' + c + '"/><rect x="14.5" y="12" width="3" height="1.4" rx=".7" fill="' + c + '"/>' : '<rect class="eye" x="8.5" y="11" width="3" height="3" rx="1.5" fill="' + c + '"/><rect class="eye" x="14.5" y="11" width="3" height="3" rx="1.5" fill="' + c + '"/>') +
    '<rect x="7" y="20.5" width="12" height="7.5" rx="3" fill="' + (idle ? '#9AA6B8' : '#D9E2F0') + '"/><rect x="10.5" y="23" width="5" height="2" rx="1" fill="' + c + '"/><rect x="8" y="28" width="3.5" height="4" rx="1.4" fill="#5B6B86"/><rect x="14.5" y="28" width="3.5" height="4" rx="1.4" fill="#5B6B86"/></svg>';
  function vMap() {
    const ag = stOnline() ? arr(S.st && S.st.jobs) : [];
    const rooms = ROOMS.map(r => { const js = ag.filter(a => a.room === r[0]); const on = js.length > 0; const need = js.some(a => a.needs); const L = r[3] === 'L';
      return '<div class="mr' + (on ? ' on' : '') + (need ? ' need' : '') + '" style="left:' + (L ? 6 : 194) + 'px;top:' + r[4] + 'px;--c:' + r[2] + '"><div class="mrh">' + ico(r[0], on ? r[2] : '#8C9BB3', 13) + '<span>' + r[1] + '</span></div>' +
        '<div class="mmon" style="' + (L ? 'left' : 'right') + ':10px">' + ico(r[0], on ? r[2] : '#4A586F', 14) + '</div>' +
        '<div class="mrf"><span class="mjob">' + esc(js[0] ? js[0].label + (js[0].tier ? ' · ' + js[0].tier : '') : 'bereit') + '</span>' + (js[0] ? '<span class="mdet">' + esc(js[0].needs ? 'wartet auf dich' : js[0].detail || '') + '</span>' : '') + '</div></div>'; }).join('');
    const now = Date.now() / 1000;
    const bots = ROOMS.map((r, ri) => { const js = ag.filter(a => a.room === r[0]); const L = r[3] === 'L'; const row = (r[4] + 52); const restX = L ? 132 : 226;
      if (!js.length) return '<div class="mb idle" style="transform:translate(' + (restX - 13 + (L ? -20 : 20)) + 'px,' + (row - 6) + 'px)">' + BOT(r[2], true) + '<i class="zz">z</i></div>';
      return js.slice(0, 2).map((a, i) => { if (a.needs) return '<div class="mb" style="transform:translate(' + (restX - 13 + i * 26) + 'px,' + (row - 16) + 'px)">' + BOT(r[2]) + '<i class="bang">!</i></div>';
        const dur = 10 + (ri % 3); const d = -((now + ri * 2.3 + i * 4) % dur);
        return '<div class="mb walk w' + ri + '" style="animation-delay:' + d.toFixed(2) + 's;margin-left:' + (i * 24) + 'px;animation-duration:' + dur + 's">' + BOT(r[2]) + '<i class="pkt" style="--c:' + r[2] + ';animation-delay:' + d.toFixed(2) + 's;animation-duration:' + dur + 's"></i></div>'; }).join(''); }).join('');
    const P = 'M179 124V442M164 202H194M164 322H194M164 442H194';
    return '<section class="card"><h3>Agenten-Station' + (ag.length ? ' · ' + ag.length + ' aktiv' : '') + '</h3><div class="map"><svg class="corr" width="358" height="506" viewBox="0 0 358 506" aria-hidden="true"><path d="' + P + '" stroke="#22324A" stroke-width="16" fill="none"/><path d="' + P + '" stroke="#0F1724" stroke-width="13" fill="none"/></svg>' +
      '<div class="ring"></div><div class="hub"><img src="hub.png" alt="Hydra, die Aufseherin" width="112" height="112"></div>' + rooms + bots + '</div>' + (stOnline() ? '' : '<p class="muted small">PC nicht erreichbar, die Karte zeigt keine Aufträge.</p>') + '</section>';
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
      (my && arr(n.blocked).length && !run ? '<div class="block"><h3>Gescheiterte Tasks</h3>' + arr(n.blocked).map(b => '<div class="q"><span><b>#' + b.n + ' ' + esc(b.t) + '</b>' + (b.cnt ? ' · blockiert ' + b.cnt : '') + (b.conflict ? ' · <b class="crit">Konflikt</b>' : '') + '</span>' + (b.why ? '<span class="muted small">' + esc(b.why) + '</span>' : '') +
        (b.report ? '<details><summary>Was die Prüfung gefunden hat</summary><div class="log">' + esc(b.report) + '</div></details>' : '') +
        '<div class="row wrap">' + (b.manual ? [['manual', b.manual], ['skip', 'Überspringen']] : b.conflict ? [['resolve', 'Konflikt lösen lassen'], ['reset', 'Neu aufsetzen'], ['skip', 'Überspringen']] : [['retry', 'Neu versuchen'], ['reset', 'Neu aufsetzen'], ['done', 'Erledigt'], ['skip', 'Überspringen']]).map((x, i) => '<button class="btn sm' + (i === 0 ? ' p' : '') + '" data-act="task" data-id="' + esc(p.id) + '" data-k="' + x[0] + '" data-t="' + esc(b.tid) + '">' + esc(x[1]) + '</button>').join('') + '</div></div>').join('') + '</div>' : '') +
      (my && arr(n.forYou).length ? '<div class="block"><h3>Für dich · Handarbeit</h3>' + arr(n.forYou).map(f => '<div class="q"><span><b>#' + f.n + ' ' + esc(f.t) + '</b></span><div class="row wrap">' + (f.ready ? '<button class="btn sm p" data-act="task" data-id="' + esc(p.id) + '" data-k="done" data-t="' + esc(f.tid) + '">Alle Assets fertig · abschließen</button>' : (f.kind !== 'map' ? '<button class="btn sm p" data-act="tab" data-k="assets" data-hl="' + esc(p.id + ':' + f.n) + '">' + esc(f.label) + '</button>' : '<span class="muted small">Baust du am PC in Unity.</span>') + '<button class="btn sm" data-act="task" data-id="' + esc(p.id) + '" data-k="done" data-t="' + esc(f.tid) + '">Erledigt</button>') + '<button class="btn sm" data-act="task" data-id="' + esc(p.id) + '" data-k="code" data-t="' + esc(f.tid) + '">Doch programmieren</button></div></div>').join('') + '</div>' : '') +
      (my && (n.vsPending || 0) >= 10 ? '<p class="why">Gesamtabgleich fällig: ' + n.vsPending + ' neue Entscheidungen seit der letzten Vision. Den Abgleich machst du am PC im Vision-Reiter.</p>' : '') +
      (qs.length ? '<div class="block"><h3>Fragen · ' + qs.length + '</h3>' + qs.map(q => { const sent = wt.find(x => x.kind === 'answer' && x.qid === q.id);
        return '<div class="q' + (q.crit ? ' crit' : '') + '"><span>' + (q.crit ? '<b class="crit">KRITISCH</b> · ' : '') + (q.tn ? '#' + q.tn + ' · ' : '') + esc(q.q) + '</span>' + (q.guess ? '<span class="muted small">Vorschlag: ' + esc(q.guess) + '</span>' : '') +
          (!my ? '' : sent ? '<span class="muted small">Gesendet · wartet auf den PC …</span>' : '<input id="q_' + esc(q.id) + '" placeholder="' + (q.guess ? 'Leer = Vorschlag übernehmen' : 'Deine Antwort') + '" value="' + esc(S.drafts['q_' + q.id] || '') + '"><textarea id="qx_' + esc(q.id) + '" rows="2" placeholder="Ergänzung (optional)">' + esc(S.drafts['qx_' + q.id] || '') + '</textarea><button class="btn' + (q.crit ? ' p' : '') + '" data-act="answer" data-id="' + esc(p.id) + '" data-k="' + esc(q.id) + '">Senden</button>') + '</div>'; }).join('') + '</div>' : '') +

      (my && n.shotRemote ? '<div class="block"><h3>Letzter Spieltest · #' + esc(n.shotRemote.tn || '') + '</h3>' + (shot && shot.at === n.shotRemote.at ? '<img class="shot" src="' + shot.url + '" alt="Screenshot aus dem Spieltest">' : '<button class="btn sm" data-act="shot" data-id="' + esc(p.id) + '">Bild anzeigen</button>') + '<span class="muted small">Nur angezeigt, nicht gespeichert.</span></div>' : '') +
      (my && n.on ? '<details class="block"' + (S.drafts['open_more_' + p.id] ? ' open' : '') + '><summary data-act="more" data-id="' + esc(p.id) + '">Ergänzen, Budget, Reparatur</summary>' +
        '<label>Ergänzung zum Projekt<textarea id="note_' + esc(p.id) + '" rows="3" placeholder="z. B. Gebäude zeigen beim Platzieren eine Vorschau">' + esc(S.drafts['note_' + p.id] || '') + '</textarea></label>' +
        '<div class="row wrap"><input id="notetn_' + esc(p.id) + '" inputmode="numeric" placeholder="zu Task # (optional)" value="' + esc(S.drafts['notetn_' + p.id] || '') + '" style="flex:1 1 140px"><button class="btn sm" data-act="note" data-id="' + esc(p.id) + '">Als Klärung</button><button class="btn sm p" data-act="noteTask" data-id="' + esc(p.id) + '">Als neuen Task</button></div>' +
        '<label>Budget für diesen Lauf ($)<input id="bud_' + esc(p.id) + '" inputmode="decimal" value="' + esc(S.drafts['bud_' + p.id] || n.budget || '') + '"></label>' +
        '<div class="row wrap"><button class="btn sm" data-act="mode" data-id="' + esc(p.id) + '" data-k="1"' + (Number(n.mode) === 1 ? ' disabled' : '') + '>Copilot</button><button class="btn sm" data-act="mode" data-id="' + esc(p.id) + '" data-k="2"' + (Number(n.mode) === 2 ? ' disabled' : '') + '>Autopilot</button><button class="btn sm p" data-act="budget" data-id="' + esc(p.id) + '">Budget speichern</button></div>' +
        '<div class="row wrap" style="margin-top:10px"><button class="btn sm" data-act="repair" data-id="' + esc(p.id) + '">Projekt prüfen und reparieren</button><button class="btn sm" data-act="ctl" data-id="' + esc(p.id) + '" data-k="end">NPC-Modus beenden</button></div><span class="muted small">Prüft Kompilieren, einen kurzen Spieltest und fehlende Verweise. Gefundene Fehler werden ein Reparatur-Task.</span></details>' : '') +
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
    return vDialogs() + vMap() + (ps.length ? ps.map(vProject).join('') : '<section class="card"><p class="muted">Gerade ist kein NPC-Modus aktiv.</p></section>') + vStart();
  }
  function vResearch() {
    const R = (S.st && S.st.research) || {}; const q = arr(R.queue); const un = arr(R.unverified); const dc = R.disc; const dirs = arr(R.dirs).length ? R.dirs : [['ueberrasch', 'Überrasch mich']];
    const tiers = arr(S.st && S.st.tiers); const tsel = (id, def) => tiers.length ? '<label>KI-Modell<select id="' + id + '">' + tiers.map(t => '<option value="' + esc(t[0]) + '"' + ((S.drafts[id] || def) === t[0] ? ' selected' : '') + '>' + esc(t[1]) + (t[0] === 'local' ? ' · kostenlos' : '') + '</option>').join('') + '</select></label>' : '';
    return '<section class="card"><h3>Spiele recherchieren</h3><label>Titel (mehrere mit Komma)<textarea id="res_titles" rows="2" placeholder="z. B. Anno 1800, They Are Billions">' + esc(S.drafts.res_titles || '') + '</textarea></label>' + tsel('res_tier', S.st && S.st.tierRes) +
      '<label class="chk"><input type="checkbox" id="res_deep"' + (S.drafts.res_deep === '1' ? ' checked' : '') + '><span>Gründlich (mehr Quellen, kostet mehr)</span></label><button class="btn p wide" data-act="research">Recherchieren</button></section>' +
      '<section class="card"><h3>Neue Spiele entdecken</h3><label>Richtung<select id="disc_dir">' + dirs.map(x => '<option value="' + esc(x[0]) + '"' + ((S.drafts.disc_dir || 'ueberrasch') === x[0] ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select></label>' +
      ((S.drafts.disc_dir || '') === 'genre' ? '<label>Genre<input id="disc_genre" value="' + esc(S.drafts.disc_genre || '') + '" placeholder="z. B. Aufbauspiel"></label>' : '') + tsel('disc_tier', S.st && S.st.tierDisc) + '<button class="btn wide" data-act="discover">Vorschläge holen</button>' +
      (dc ? '<div class="block"><h3>' + esc(dc.richtung) + ' · ' + arr(dc.list).length + ' Vorschläge</h3>' + arr(dc.list).map((g, i) => '<label class="chk' + (g.skip ? ' off' : '') + '"><input type="checkbox" id="dc_' + i + '"' + ((S.drafts['dc_' + i] !== undefined ? S.drafts['dc_' + i] === '1' : g.on) ? ' checked' : '') + '><span><b>' + esc(g.titel) + '</b>' + (g.jahr ? ' (' + g.jahr + ')' : '') + '<br><span class="muted small">' + esc(g.skip || g.warum) + '</span></span></label>').join('') +
        '<div class="row"><button class="btn p" data-act="discGo">Ausgewählte recherchieren</button><button class="btn" data-act="discDrop">Verwerfen</button></div></div>' : '') + '</section>' +
      (q.length ? '<section class="card"><h3>Warteschlange' + (R.running ? ' · läuft' : '') + '</h3>' + q.slice().reverse().map(x => '<div class="qrow"><span>' + esc(x.title) + '</span><span class="pill ' + (x.status === 'läuft' ? 'run' : x.status === 'fertig' ? 'fin' : x.status === 'fehler' || x.status === 'verworfen' ? 'warn' : '') + '">' + esc(x.status) + '</span>' + (x.msg ? '<span class="muted small">' + esc(x.msg) + '</span>' : '') + '</div>').join('') + '</section>' : '') +
      '<section class="card"><h3>Ungeprüfte Ergebnisse · ' + un.length + '</h3>' + (un.length ? un.map(g => '<div class="qrow"><span><b>' + esc(g.title) + '</b>' + (g.year ? ' (' + g.year + ')' : '') + ' <span class="muted small">' + g.cards + ' Ideen-Karten</span></span><div class="row"><button class="btn sm p" data-act="verify" data-k="' + esc(g.id) + '">Bestätigen</button><button class="btn sm" data-act="discard" data-k="' + esc(g.id) + '">Verwerfen</button></div></div>').join('') + (un.length > 1 ? '<button class="btn wide" data-act="verifyAll">Alle ' + un.length + ' bestätigen</button>' : '') : '<p class="muted">Nichts zu prüfen.</p>') + '</section>';
  }
  // ---------- Assets (Asset-Werft) ----------
  function vAssets() {
    const A = S.st && S.st.assets; if (!A) return '<section class="card"><p class="muted">' + (stOnline() ? 'Asset Studio wird am PC geladen …' : 'Der PC ist nicht erreichbar.') + '</p></section>';
    const cr = A.credits || {}; const hl = S.assetHl;
    const orders = arr(A.orders); const projOpts = arr(S.st.projects).map(x => '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>').join('');
    return '<section class="card"><h3>Meshy-Credits</h3><b>' + Math.max(0, (cr.limit || 0) - (cr.used || 0)) + ' von ' + (cr.limit || 0) + ' frei</b>' + meter(cr.limit ? (cr.used || 0) / cr.limit : 0, '#FF7AB6') + '<span class="muted small">Grenze je Modell ' + (cr.perModel || 0) + ' Credits' + (cr.key ? '' : ' · am PC fehlt der Meshy-Schlüssel') + '</span></section>' +
      (orders.length ? '<section class="card"><h3>Offene Asset-Aufträge · ' + orders.length + '</h3>' + orders.map(o => { const on = hl && hl === o.pid + ':' + o.task;
        return '<div class="qrow' + (on || o.need ? ' hl' : '') + '"><span><b>' + esc(o.name) + '</b> <span class="muted small">' + esc(o.pname) + ' · ' + esc(o.typ) + (o.task ? ' · Task #' + o.task : '') + '</span></span>' + (o.need ? '<span class="verd crit">Wird für Task #' + o.task + ' gebraucht</span>' : '') +
          (o.typ === 'modell' ? '<div class="row wrap"><button class="btn sm p" data-act="stOrder" data-k="' + esc(o.aid) + '" data-v="' + esc(o.name) + '" data-z="' + esc(o.zweck) + '">Mit Meshy erzeugen</button></div>' : '') + '</div>'; }).join('') + '</section>' : '') +
      (arr(A.runs).length ? '<section class="card"><h3>Laufende Erzeugung</h3>' + arr(A.runs).map(r => { const imgs = S.runImgs[r.id] || {};
        return '<div class="qrow"><span><b>' + esc(r.name) + '</b> <span class="muted small">' + esc({ neu: 'neu', konzepte: 'Konzeptbilder entstehen', auswahl: 'Bild auswählen', modell: '3D-Modell entsteht' }[r.stage] || r.stage) + ' · ' + r.spent + ' Credits</span></span>' + (r.err ? '<span class="verd crit">' + esc(r.err) + '</span>' : '') +
          (arr(r.concepts).length ? '<div class="cgrid">' + arr(r.concepts).map(c => '<button class="cpick' + (r.pick === c.i ? ' on' : '') + '" data-act="stPick" data-k="' + esc(r.id) + '" data-v="' + c.i + '"' + (c.ready ? '' : ' disabled') + '>' + (imgs[c.i] ? '<img src="' + imgs[c.i] + '" alt="Konzept ' + (c.i + 1) + '">' : '<span>' + (c.ready ? 'Bild ' + (c.i + 1) : c.status === 'FAILED' ? 'fehlgeschlagen' : c.progress + ' %') + '</span>') + '</button>').join('') + '</div>' : '') +
          '<div class="row wrap">' + (arr(r.concepts).some(c => c.ready) ? '<button class="btn sm" data-act="stImgs" data-k="' + esc(r.id) + '">Bilder laden</button>' : '') + (r.stage === 'auswahl' && r.pick != null ? '<button class="btn sm p" data-act="stModel" data-k="' + esc(r.id) + '">3D-Modell erzeugen (≈ 30 Credits)</button>' : '') + '</div></div>'; }).join('') + '</section>' : '') +
      '<section class="card"><h3>Neues Modell mit Meshy</h3><label>Name<input id="mr_name" value="' + esc(S.drafts.mr_name || '') + '" placeholder="z. B. Aegis-Soldat"></label><label>Art<select id="mr_art">' + [['einheit', 'Einheit / Figur'], ['gebaeude', 'Gebäude'], ['fahrzeug', 'Fahrzeug'], ['objekt', 'Objekt']].map(x => '<option value="' + x[0] + '"' + ((S.drafts.mr_art || 'einheit') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></label>' +
        '<label>Beschreibung (optional)<textarea id="mr_prompt" rows="2" placeholder="Leer = HydraForge beschreibt es aus Projekt und Stil">' + esc(S.drafts.mr_prompt || '') + '</textarea></label><button class="btn p wide" data-act="stRunNew">Konzeptbilder erzeugen</button><span class="muted small">Die Konzeptbilder kosten Meshy-Credits, HydraForge fragt vorher.</span></section>' +
      '<section class="card"><h3>Kostenlos suchen (Poly Haven)</h3><div class="row"><input id="st_q" value="' + esc(S.drafts.st_q || '') + '" placeholder="z. B. sand, rock, desert"><button class="btn" data-act="stSearch">Suchen</button></div>' +
        (arr(A.results).length ? '<div class="cgrid">' + arr(A.results).map(r => '<div class="rcard"><img src="' + esc(r.thumb) + '" alt="" loading="lazy"><span class="small">' + esc(r.name) + '</span><button class="btn sm" data-act="stFetch" data-k="' + esc(r.id) + '">Laden</button></div>').join('') + '</div>' : '') + '</section>' +
      '<section class="card"><h3>Bibliothek · ' + arr(A.items).length + '</h3>' + arr(A.items).map(it => '<div class="qrow"><span><b>' + esc(it.name) + '</b> <span class="muted small">' + esc(it.kind) + ' · ' + esc(it.source) + (it.rig ? ' · Rig ' + esc(it.rig === 'SUCCEEDED' ? 'fertig' : it.rig) : '') + '</span></span>' +
        (S.itemImgs[it.id] ? '<img class="shot" src="' + S.itemImgs[it.id] + '" alt="">' : '') +
        '<div class="row wrap">' + (it.prev ? '<button class="btn sm" data-act="stPrev" data-k="' + esc(it.id) + '">Bild</button>' : '') + (arr(it.glbs).length ? '<button class="btn sm p" data-act="st3d" data-k="' + esc(it.id) + '">3D-Vorschau' + (arr(it.glbs).filter(g => g.anim).length ? ' · ' + arr(it.glbs).filter(g => g.anim).length + ' Anim.' : '') + '</button>' : '') +
          (it.meshy && !it.rig ? '<button class="btn sm" data-act="stRig" data-k="' + esc(it.id) + '">Riggen (≈ 5)</button>' : '') + (it.rig === 'SUCCEEDED' ? '<button class="btn sm" data-act="stAnimOpen" data-k="' + esc(it.id) + '">Animationen</button>' : '') +
          '<button class="btn sm" data-act="stGame" data-k="' + esc(it.id) + '">Ins Spiel</button></div>' +
        (S.animFor === it.id ? vAnimPick(it) : '') + (S.gameFor === it.id ? '<div class="row wrap"><select id="st_pid">' + projOpts + '</select><button class="btn sm p" data-act="stGameGo" data-k="' + esc(it.id) + '">Einsetzen</button></div>' : '') + '</div>').join('') + '</section>';
  }
  function vAnimPick(it) {
    const L = S.st.assets.animLib; const sel = S.animSel[it.id] || [];
    return '<div class="block"><div class="row"><input id="an_q" value="' + esc(S.drafts.an_q || '') + '" placeholder="idle, walk, shoot …"><button class="btn sm" data-act="stAnimLib">Suchen</button></div>' +
      (L && arr(L.list).length ? arr(L.list).map(a => '<label class="chk anr"><input type="checkbox" data-act="anSel" data-k="' + esc(it.id) + '" data-v="' + a.id + '" data-n="' + esc(a.name) + '"' + (sel.some(x => x.id === a.id) ? ' checked' : '') + '>' + (a.prev ? (/\.(mp4|webm)(\?|$)/i.test(a.prev) ? '<video class="anprev" src="' + esc(a.prev) + '" muted loop autoplay playsinline></video>' : '<img class="anprev" src="' + esc(a.prev) + '" alt="" loading="lazy">') : '') + '<span>' + esc(a.name) + ' <span class="muted small">' + esc(a.cat || '') + '</span></span></label>').join('') : '<p class="muted small">Such nach einer Bewegung.</p>') +
      (sel.length ? '<button class="btn p wide" data-act="stAnimGo" data-k="' + esc(it.id) + '">' + sel.length + ' Animationen erzeugen (≈ ' + sel.length * 3 + ' Credits)</button>' : '') + '<span class="muted small">Nach dem Erzeugen kannst du jede Animation in der 3D-Vorschau ansehen und ungeeignete entfernen.</span></div>';
  }
  // 3D-Vorschau auf dem Handy: eigene Ebene, nur im Speicher
  function mvLoad() { if (window.customElements && customElements.get('model-viewer')) return Promise.resolve(); if (S.mvP) return S.mvP; S.mvP = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'model-viewer.js'; sc.onload = res; sc.onerror = () => rej(new Error('3D-Vorschau nicht verfügbar.')); document.head.appendChild(sc); }); return S.mvP; }
  async function mvShow(itemId, path) {
    const it = arr(S.st.assets.items).find(x => x.id === itemId); if (!it) return;
    const g = (path && arr(it.glbs).find(x => x.path === path)) || arr(it.glbs)[0];
    flash('3D-Datei wird vom PC geholt …'); await mvLoad();
    const r = await cmdWait('stPreview', { itemId: itemId, what: 'glb', path: g.path }, null); if (!r) return; if (!r.ok) { flash(r.msg || 'Keine Vorschau.', true); return; }
    const url = await signed(r.glb); if (S.mvUrl) URL.revokeObjectURL(S.mvUrl); S.mvUrl = url; S.flash = null; render();
    let lay = document.getElementById('mvlay'); if (!lay) { lay = document.createElement('div'); lay.id = 'mvlay'; lay.className = 'mvlay'; document.body.appendChild(lay); }
    lay.innerHTML = '<div class="mvbox"><div class="row"><b style="flex:1">' + esc(it.name) + ' · ' + esc(g.label) + '</b><button class="btn sm" id="mvx">Schließen</button></div><model-viewer id="mv" src="' + url + '" camera-controls touch-action="none" autoplay environment-image="neutral" shadow-intensity="0.8" style="width:100%;height:56vh;background:radial-gradient(circle at 50% 40%,#15233a,#0a0f18);border-radius:12px"></model-viewer>' +
      '<div class="row wrap"><span class="muted small" id="mvan"></span><select id="mvsp" style="width:auto"><option value="0.5">0,5×</option><option value="1" selected>1×</option><option value="2">2×</option></select></div>' +
      (arr(it.glbs).length > 1 ? '<div class="row wrap">' + arr(it.glbs).map(x => '<button class="btn sm' + (x.path === g.path ? ' p' : '') + '" data-mv="' + esc(x.path) + '">' + esc(x.label) + '</button>' + (x.anim ? '<button class="btn sm" data-mvdrop="' + esc(x.path) + '" aria-label="Animation entfernen">✕</button>' : '')).join('') + '</div>' : '') + '<span class="muted small">Ein Finger dreht, zwei Finger zoomen. ✕ nimmt eine Animation aus dem Asset.</span></div>';
    const mv = lay.querySelector('#mv');
    mv.addEventListener('load', () => { const an = mv.availableAnimations || []; lay.querySelector('#mvan').textContent = an.length ? an.join(', ') : 'keine Animation'; if (an.length) { mv.animationName = an[0]; mv.play(); } });
    lay.querySelector('#mvx').onclick = () => { lay.remove(); if (S.mvUrl) { URL.revokeObjectURL(S.mvUrl); S.mvUrl = null; } };
    lay.querySelector('#mvsp').onchange = e => { mv.timeScale = Number(e.target.value) || 1; };
    lay.querySelectorAll('[data-mv]').forEach(b => { b.onclick = () => mvShow(itemId, b.getAttribute('data-mv')); });
    lay.querySelectorAll('[data-mvdrop]').forEach(b => { b.onclick = async () => { if (!confirm('Diese Animation nicht mit ins Spiel übernehmen?')) return; await cmd('stDrop', { itemId: itemId, path: b.getAttribute('data-mvdrop') }, 'Entfernt'); lay.querySelector('#mvx').click(); }; });
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
    const tabs = [['station', 'Station'], ['assets', 'Assets'], ['research', 'Recherche'], ['settings', 'Mehr']];
    const lastRes = S.cmds.find(c => c.result && Date.now() - new Date(c.created_at).getTime() < 120000 && c.result.ok === false);
    app.innerHTML = '<header class="top"><img src="icon-192.png" alt="" class="logo sm"><div><b>HydraForge Station</b><span class="muted small livetxt"><i class="ldot' + (stOnline() ? '' : ' off') + '"></i><span id="liveago">Live · vor 0 s</span>' + (stOnline() ? '' : ' · PC nicht erreichbar') + '</span></div><span class="grow"></span>' + (pushOk() && !pushOn() ? '<button class="btn sm" data-act="push">🔕 Push an</button>' : '') + '</header>' +
      (S.flash ? '<p class="flash' + (S.flash.bad ? ' bad' : '') + '" role="status">' + esc(S.flash.t) + '</p>' : '') +
      (lastRes ? '<p class="flash bad" role="status">PC meldet: ' + esc(lastRes.result.msg || 'fehlgeschlagen') + '</p>' : '') +
      (S.err ? '<p class="err pad">' + esc(S.err) + '</p>' : '') +
      (S.noStation ? '<p class="flash bad">Für Start, Recherche und Einstellungen vom Handy fehlt noch das Server-Update 0.15 (update_0_15.sql).</p>' : '') +
      '<div class="content">' + (S.tab === 'research' ? vResearch() : S.tab === 'settings' ? vSettings() : S.tab === 'assets' ? vAssets() : vStation()) + '</div>' +
      '<nav class="tabs" aria-label="Bereiche">' + tabs.map(t => '<button class="' + (S.tab === t[0] ? 'on' : '') + '" data-act="tab" data-k="' + t[0] + '" aria-current="' + (S.tab === t[0] ? 'page' : 'false') + '">' + t[1] + '</button>').join('') + '</nav>';
    liveTick();
    document.querySelectorAll('.map').forEach(m => { const pe = m.parentElement; const cs = getComputedStyle(pe); const w = pe.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); if (w > 0) m.style.zoom = Math.min(1, w / 358); });
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
      if (act === 'tab') { S.assetHl = b.getAttribute('data-hl') || null; S.tab = k; store.set('hf_tab', k); if (k === 'settings') usageLoad(); render(); window.scrollTo(0, 0); return; }
      if (act === 'push') { if (pushOn() && !confirm('Benachrichtigungen sind an. Neu anmelden (z. B. wenn keine mehr ankommen)?')) return; store.del('hf_push_ep'); await pushEnable(); return; }
      if (act === 'log') { e.preventDefault(); S.logOpen[id] = !S.logOpen[id]; render(); return; }
      if (act === 'more') { e.preventDefault(); S.drafts['open_more_' + id] = !S.drafts['open_more_' + id]; render(); return; }
      if (act === 'startMode') { S.drafts.start_mode = k; render(); return; }
      if (act === 'start') { const pid = S.drafts.start_pid || (document.getElementById('start_pid') || {}).value; const bud = Number(String(S.drafts.start_bud || '20').replace(',', '.')) || 20; const mode = Number(S.drafts.start_mode || 1);
        const nm = (arr(S.st && S.st.projects).find(x => x.id === pid) || {}).name || '';
        if (!confirm('NPC-Modus für „' + nm + '“ starten? ' + MODE(mode) + ', Budget ' + usd(bud) + '. Die Kosten laufen über deinen Schlüssel.')) return;
        await cmd('npcStart', { pid: pid, mode: mode, budget: bud }, 'Start gesendet'); return; }
      if (act === 'stOrder') { S.drafts.mr_name = b.getAttribute('data-v'); S.drafts.mr_prompt = ''; S.drafts.mr_aid = k; render(); const el = document.getElementById('mr_name'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      if (act === 'stRunNew') { const nm = String(S.drafts.mr_name || '').trim(); if (!nm) { flash('Gib dem Modell einen Namen.', true); return; } if (!confirm('Konzeptbilder für „' + nm + '“ erzeugen? Das kostet Meshy-Credits (etwa 4 Bilder).')) return; await cmd('stRunNew', { name: nm, prompt: S.drafts.mr_prompt || '', art: S.drafts.mr_art || 'einheit', aid: S.drafts.mr_aid || null }, 'Konzeptbilder werden erzeugt'); delete S.drafts.mr_name; delete S.drafts.mr_prompt; delete S.drafts.mr_aid; return; }
      if (act === 'stImgs') { flash('Bilder werden vom PC geholt …'); const r = await cmdWait('stPreview', { runId: k }, null); if (!r || !r.ok) { flash((r && r.msg) || 'Keine Bilder.', true); return; } const m = S.runImgs[k] = {}; for (const x of arr(r.imgs)) m[x.i] = await signed(x.path); S.flash = null; render(); return; }
      if (act === 'stPick') { await cmd('stPick', { runId: k, i: Number(b.getAttribute('data-v')) }, 'Bild gewählt'); return; }
      if (act === 'stModel') { if (!confirm('3D-Modell aus dem gewählten Bild erzeugen? Etwa 30 Meshy-Credits.')) return; await cmd('stModel', { runId: k }, '3D-Modell wird erzeugt'); return; }
      if (act === 'stSearch') { const q = String(S.drafts.st_q || '').trim(); if (!q) return; await cmd('stSearch', { q: q }, 'Suche läuft'); return; }
      if (act === 'stFetch') { await cmd('stFetch', { id: k }, 'Wird geladen (2K)'); return; }
      if (act === 'stPrev') { const r = await cmdWait('stPreview', { itemId: k, what: 'img' }, 'Bild wird geholt'); if (r && r.ok) { S.itemImgs[k] = await signed(r.img); S.flash = null; render(); } else if (r) flash(r.msg || 'Kein Bild.', true); return; }
      if (act === 'st3d') { await mvShow(k); return; }
      if (act === 'stRig') { if (!confirm('Modell riggen? Etwa 5 Meshy-Credits. Nur für menschenähnliche Figuren.')) return; await cmd('stRig', { itemId: k }, 'Rigging läuft'); return; }
      if (act === 'stAnimOpen') { S.animFor = S.animFor === k ? null : k; render(); return; }
      if (act === 'stAnimLib') { await cmd('stAnimLib', { q: S.drafts.an_q || '' }, 'Suche läuft'); return; }
      if (act === 'anSel') { const it = b.getAttribute('data-k'); const id = Number(b.getAttribute('data-v')); const list = S.animSel[it] = S.animSel[it] || []; const i = list.findIndex(x => x.id === id); if (i >= 0) list.splice(i, 1); else if (list.length < 10) list.push({ id: id, name: b.getAttribute('data-n') }); render(); return; }
      if (act === 'stAnimGo') { const list = S.animSel[k] || []; if (!confirm(list.length + ' Animationen erzeugen? Etwa ' + list.length * 3 + ' Meshy-Credits.')) return; await cmd('stAnim', { itemId: k, actions: list }, 'Animationen werden erzeugt'); S.animSel[k] = []; S.animFor = null; return; }
      if (act === 'stGame') { S.gameFor = S.gameFor === k ? null : k; render(); return; }
      if (act === 'stGameGo') { const pid = (document.getElementById('st_pid') || {}).value; await cmd('stToGame', { itemId: k, pid: pid }, 'Wird ins Spiel eingesetzt'); S.gameFor = null; return; }
      if (act === 'dlg') { await cmd('dlg', { hwnd: k, button: b.getAttribute('data-v') }, '„' + b.getAttribute('data-v') + '“ gesendet'); return; }
      if (act === 'research') { const t = String(S.drafts.res_titles || '').split(/[\n;,]+/).map(x => x.trim()).filter(x => x.length > 1); if (!t.length) { flash('Gib mindestens einen Spieletitel ein.', true); return; } if (await cmd('research', { titles: t, tier: S.drafts.res_tier || (S.st && S.st.tierRes), deep: S.drafts.res_deep === '1' }, t.length + ' in die Warteschlange')) S.drafts.res_titles = ''; return; }
      if (act === 'discover') { await cmd('discover', { dir: S.drafts.disc_dir || 'ueberrasch', genre: S.drafts.disc_genre || '', tier: S.drafts.disc_tier || (S.st && S.st.tierDisc) }, 'Vorschläge werden geholt'); return; }
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
      if (act === 'ctl') { if (k === 'end' && !confirm('NPC-Modus beenden? Fortschritt und Fragen bleiben gespeichert.')) return; if (k === 'stopNow' && !confirm('Sofort stoppen? Der laufende Schritt wird abgebrochen, sein Zwischenstand bleibt im Task-Branch.')) return; await send(p, { kind: 'ctl', cmd: k }); return; }
      if (act === 'task') { const lbl = { retry: 'Neu versuchen (kostet Budget)?', done: 'Als erledigt markieren? Nur, wenn du es selbst gelöst hast.', skip: 'Überspringen? Abhängige Tasks dürfen dann trotzdem starten.', resolve: 'Konflikt von einem Agenten zusammenführen lassen (kostet)?', reset: 'Neu aufsetzen? Der Task-Branch wird verworfen und neu programmiert (kostet).', manual: 'Als Handarbeit markieren? Benötigte Assets landen in der Asset-Liste.', code: 'Doch programmieren lassen?' }[k]; if (lbl && !confirm(lbl)) return; await send(p, { kind: 'task', tid: b.getAttribute('data-t'), action: k }); return; }
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
