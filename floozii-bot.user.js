// ==UserScript==
// @name         Floozii Bot
// @namespace    grepolis-alarme
// @version      2.5.0
// @description  Floozii Bot : alarme d'attaques (son YouTube possible), ordres entrants/sortants, marché, récolte rapide des villages de paysans, fin gratuite des constructions, minage d'or. Menu déplaçable et réductible.
// @match        *://*.grepolis.com/game/*
// @run-at       document-idle
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const doc = document;
  if (uw.__flooziiBot) return;   // déjà lancé (évite le menu en double)
  uw.__flooziiBot = true;

  /* ------------------------------------------------------------------ */
  /*  Réglages sauvegardés                                               */
  /* ------------------------------------------------------------------ */
  const DEFAULTS = {
    enabled: true,      // alarme activée
    youtube: '',        // lien YouTube du son d'alarme (vide = sirène intégrée)
    volume: 60,         // 0-100
    espionage: false,   // sonner aussi pour l'espionnage
    ignoreUnits: true,  // ignorer les mouvements dont les troupes sont visibles (= retours)
    farmOption: 1,      // option de récolte du jeu (1 à 4)
    farmExtra: 0,       // attente supplémentaire par village (min)
    farmAuto: false,    // démarrer la ferme avec le jeu
    farmFast: true,     // récolte groupée (tous les villages prêts en une seule requête)
    farmPar: 3,         // récoltes simultanées en mode individuel (1 à 4)
    goldRes3: { wood: true, stone: true, iron: true },  // ressources vendues à chaque essai
    goldAmount: 1000,   // quantité par vente
    goldReserve: 0,     // réserve à garder dans la ville
    goldEvery: 5,       // intervalle entre deux essais de vente (minutes : 2, 5 ou 10)
    goldAuto: true,     // lancer la vente automatiquement avec le jeu
    goldMaxSales: 0,    // 0 = illimité
    goldTpl: null,      // requête de vente enregistrée
    plan: { type: 'attack', origin: '', target: '', units: '', duration: '', arrival: '', offset: 0, lead: 150, hook: false, slots: [], mode: 'yolo', time: '00:00:00', extra: [] },  // plan d'attaque / soutien
    triumph: false,     // lancer automatiquement les marches triomphales (et seulement elles)
    triTpl: null,       // requête de marche triomphale apprise
    buildAuto: true,    // terminer gratuitement les constructions < 5 min, avec le jeu
    min: false,         // menu réduit
    tab: 'orders',      // onglet actif
    filter: 'all',      // filtre des ordres
    pos: {}             // positions du menu et de l'icône
  };
  let S = Object.assign({}, DEFAULTS);
  try { Object.assign(S, JSON.parse(GM_getValue('gpa_settings', '{}'))); } catch (e) { /* ignore */ }
  if (!S.pos) S.pos = {};
  let goldMigrated = false;
  if (S.goldTpl && !S.goldTpl.v2) { S.goldTpl = null; goldMigrated = true; }
  const save = () => { try { GM_setValue('gpa_settings', JSON.stringify(S)); } catch (e) { /* ignore */ } };
  if (![2, 5, 10].includes(+S.goldEvery)) S.goldEvery = 5;
  if (!S.goldRes3 || typeof S.goldRes3 !== 'object') S.goldRes3 = { wood: true, stone: true, iron: true };
  S.plan = Object.assign({}, DEFAULTS.plan, S.plan || {});
  if (!Array.isArray(S.plan.slots)) S.plan.slots = [];
  S.plan.extra = Array.isArray(S.plan.extra) ? S.plan.extra.slice() : [];
  S.plan.mode = (S.plan.hook || S.plan.mode === 'snipe') ? 'snipe' : 'yolo';
  S.plan.hook = S.plan.mode === 'snipe';

  /* ------------------------------------------------------------------ */
  /*  Utilitaires                                                        */
  /* ------------------------------------------------------------------ */
  const $ = (s, r) => (r || doc).querySelector(s);
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const num = (v, lo, hi, d) => { v = parseInt(v, 10); if (isNaN(v)) v = d; return Math.max(lo, Math.min(hi, v)); };
  const errTxt = r => { try { return (r && (r.error || (r.json && r.json.error) || r.message)) || 'refusé'; } catch (e) { return 'refusé'; } };
  const stamp = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };

  function nowSec() {
    try { return uw.Timestamp.server(); } catch (e) { return Date.now() / 1000; }
  }
  function serverNow() {
    try { const n = uw.Timestamp.server(); return typeof n === 'number' ? n : null; } catch (e) { return null; }
  }
  function fmtCd(sec) {
    sec = Math.max(0, Math.floor(sec));
    return pad(Math.floor(sec / 3600)) + ':' + pad(Math.floor((sec % 3600) / 60)) + ':' + pad(sec % 60);
  }
  function fmtArr(ts) {
    const d = new Date(ts * 1000), t = new Date();
    const time = d.toLocaleTimeString('fr-FR', { hour12: false });
    return d.toDateString() === t.toDateString() ? time : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + time;
  }
  const allTowns = () => (uw.ITowns.getTowns ? uw.ITowns.getTowns() : uw.ITowns.towns);

  // Requête du jeu sous forme de promesse, avec délai maximum
  function ajax(controller, action, data, timeout) {
    return new Promise(resolve => {
      let done = false, tm = null;
      const fin = (ok, msg) => { if (done) return; done = true; clearTimeout(tm); resolve({ ok, msg }); };
      try {
        uw.gpAjax.ajaxPost(controller, action, data, false, {
          success: () => fin(true, ''),
          error: (_, r) => fin(false, errTxt(r))
        });
      } catch (e) { fin(false, String(e)); }
      tm = setTimeout(() => fin(false, 'pas de réponse'), timeout || 15000);
    });
  }

  // Journal générique
  function addLog(obj, msg) {
    obj.log.unshift(stamp() + '  ' + msg);
    if (obj.log.length > 30) obj.log.length = 30;
  }

  /* ------------------------------------------------------------------ */
  /*  Lecture des mouvements dans le jeu                                 */
  /* ------------------------------------------------------------------ */
  const own = id => { try { return !!(uw.ITowns.towns && uw.ITowns.towns[id]); } catch (e) { return false; } };
  function townName(id, given) {
    if (given) return given;
    try {
      const t = uw.ITowns.getTown(id) || (uw.ITowns.towns && uw.ITowns.towns[id]);
      if (t) {
        const n = (t.getName && t.getName()) || (t.attributes && t.attributes.name) || t.name;
        if (n) return n;
      }
    } catch (e) { /* ignore */ }
    return id ? 'Ville #' + id : '?';
  }

  function collectMovements() {
    const found = new Map();
    const add = (m, src) => {
      const a = m && (m.attributes || m);
      if (!a || typeof a !== 'object') return;
      const key = src + '|' + (a.id != null ? a.id : found.size);
      if (!found.has(key)) found.set(key, { a, src });
    };
    try {
      const cols = uw.MM.getCollections();
      for (const k in cols) {
        if (!/movement|^trade$/i.test(k)) continue;
        (cols[k] || []).forEach(c => (c.models || []).forEach(m => add(m, k)));
      }
    } catch (e) { /* ignore */ }
    try {
      const mods = uw.MM.getModels();
      for (const k in mods) {
        if (!/movement|^trade$/i.test(k)) continue;
        const obj = mods[k] || {};
        for (const id in obj) add(obj[id], k);
      }
    } catch (e) { /* ignore */ }
    return [...found.values()];
  }

  const LABELS = {
    attack: 'Attaque', attack_land: 'Attaque terrestre', attack_sea: 'Attaque maritime',
    attack_takeover: 'Conquête', revolt: 'Révolte', support: 'Soutien',
    colonization: 'Colonisation', espionage: 'Espionnage', breakthrough: 'Attaque (percée)',
    trade: 'Marché'
  };

  function unitsText(a) {
    const u = a.units || a.unit_list;
    if (!u || typeof u !== 'object') return '';
    const parts = [];
    for (const k in u) { const v = +u[k]; if (v > 0) parts.push(k + ' ' + v); }
    return parts.join(', ');
  }

  const RET_KEYS = ['return', 'returning', 'is_return', 'is_returning', 'back', 'back_home', 'coming_back'];
  const RET_RE = /revenan|retour|return|back|zur[uü]ck|r[uü]ckkehr|regres|ritorn|powr[oó]t|abort|cancel/i;

  function linkTitle(l) {
    try {
      if (!l) return null;
      const el = new DOMParser().parseFromString(String(l), 'text/html').querySelector('a');
      return el ? (el.getAttribute('title') || el.textContent) : null;
    } catch (e) { return null; }
  }

  // Le jeu met l'id de la ville dans le lien (#base64 d'un JSON)
  function linkId(l) {
    try { const m = String(l || '').match(/href="#([^"]+)"/); return m ? JSON.parse(atob(m[1])).id : null; } catch (e) { return null; }
  }

  function normalize(x) {
    const a = x.a, src = x.src;
    const srcType = /RevoltAttacker/.test(src) ? 'revolt_attacker' : /RevoltDefender/.test(src) ? 'revolt_defender' :
      /Spy/.test(src) ? 'espionage' : /Conqueror/.test(src) ? 'attack_takeover' : /Colonization/.test(src) ? 'colonization' : '';
    const type = String(a.type || srcType || '').toLowerCase();
    const cmd = String(a.command_type || '').toLowerCase();
    const cname = String(a.command_name || '');
    const both = type + ' ' + cmd;
    const arrival = +a.arrival_at || +a.arrival || +a.finished_at || 0;
    if (!arrival) return null;

    const oId = a.origin_town_id || linkId(a.link_origin) || linkId(a.origin_town_link);
    const dId = a.destination_town_id || linkId(a.link_destination) || linkId(a.destination_town_link) || a.target_town_id;
    const me = uw.Game && uw.Game.player_id;
    const myName = uw.Game && uw.Game.player_name;
    const isRevolt = /revolt/.test(type);
    const isReturn = !isRevolt && (RET_KEYS.some(k => a[k] === true || a[k] === 1) || RET_RE.test(cname + ' ' + both));
    const isTrade = src === 'Trade' || /trade|market/.test(both) || (a.res && typeof a.res === 'object') || ('wood' in a && 'stone' in a);

    const m = {
      key: src + '|' + (a.id != null ? a.id : arrival + '' + oId + dId),
      kind: isTrade ? 'trade' : 'unit',
      type, arrival, isReturn, isRevolt,
      originTown: isRevolt ? '' : townName(oId, a.origin_town_name || a.town_name_origin || linkTitle(a.origin_town_link) || linkTitle(a.link_origin)),
      destTown: townName(dId, a.destination_town_name || a.town_name_destination || a.target_town_name || linkTitle(a.destination_town_link) || linkTitle(a.link_destination) || (isRevolt ? a.town_name : null)),
      originPlayer: a.origin_player_name || a.origin_town_player_name || '',
      destPlayer: a.destination_player_name || a.target_player_name || '',
      units: unitsText(a)
    };

    if (isTrade) {
      const r = a.res || a.resources || a;
      m.res = (r.wood != null || r.stone != null || r.iron != null) ?
        '🪵 ' + (r.wood | 0) + '  🪨 ' + (r.stone | 0) + '  🪙 ' + (r.iron | 0) + (r.gold ? '  💰 ' + (r.gold | 0) : '') : '';
      const oOwn = own(oId) || (a.origin_town_player_id != null && me != null && a.origin_town_player_id == me);
      const dOwn = own(dId);
      m.incoming = a.incoming === true || (dOwn && !oOwn);
      m.dirLabel = oOwn && dOwn ? 'Interne' : (m.incoming ? 'Entrant' : 'Sortant');
      m.label = (a.in_exchange ? 'Échange' : 'Marché') + (isReturn ? ' (retour)' : '');
      return m;
    }

    const oOwn = own(oId);
    m.incoming = !isReturn && (isRevolt ? /defender/.test(type) :
      (a.incoming === true || (a.incoming === undefined && own(dId) && !oOwn)));
    m.isAttack = /attack|conquer|takeover|breakthrough/.test(both) && !isReturn && !isRevolt;
    m.isSupport = /support/.test(both);
    m.isSpy = /espionage/.test(both);
    const mine = oOwn ||
      (a.origin_player_id != null && me != null && a.origin_player_id == me) ||
      (!!myName && a.origin_player_name === myName);
    const visibleUnits = S.ignoreUnits && !!m.units;
    m.hostile = m.incoming && !mine && !isReturn && !isRevolt && !visibleUnits && (m.isAttack || (S.espionage && m.isSpy));
    m.label = isRevolt ? (/defender/.test(type) ? 'Révolte (dans ta ville)' : 'Révolte (la tienne)') :
      isReturn ? (cname || 'Retour') : (LABELS[type] || LABELS[cmd] || cname || type || 'Ordre');
    return m;
  }

  /* ------------------------------------------------------------------ */
  /*  Son d'alarme (YouTube ou sirène intégrée)                          */
  /* ------------------------------------------------------------------ */
  const Sound = {
    on: false, testing: false, ctx: null, osc: null, gain: null, tmr: null, frame: null, ttl: null, ttlOrig: null,
    blocked: false, ytOk: false, ytTimer: null, info: '',
    ytId(u) {
      const m = String(u || '').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
      return m ? m[1] : null;
    },
    start() {
      if (this.on) return;
      this.on = true; this.ytOk = false;
      const id = this.ytId(S.youtube);
      if (id) this.playYT(id); else this.beep();
      // Le navigateur bloque le son tant que tu n'as pas cliqué dans la page : on le détecte
      setTimeout(() => {
        this.blocked = this.on && !!this.ctx && this.ctx.state !== 'running' && !this.ytOk;
        if (this.blocked) this.info = '🔇 Son bloqué par le navigateur : clique n\'importe où dans le jeu pour l\'activer';
        updateIcon();
      }, 700);
      this.ttlOrig = doc.title;
      let f = false;
      this.ttl = setInterval(() => { f = !f; doc.title = f ? '🚨 ATTAQUE ! 🚨' : this.ttlOrig; }, 700);
    },
    stop() {
      if (!this.on) return;
      this.on = false; this.blocked = false; this.ytOk = false;
      clearTimeout(this.ytTimer); this.ytTimer = null;
      this.stopBeep();
      if (this.frame) { this.frame.remove(); this.frame = null; }
      clearInterval(this.ttl); this.ttl = null;
      if (this.ttlOrig != null) doc.title = this.ttlOrig;
      this.ttlOrig = null;
    },
    stopBeep() {
      clearInterval(this.tmr); this.tmr = null;
      try { this.osc && this.osc.stop(); } catch (e) { /* ignore */ }
      this.osc = null;
    },
    beep() {
      if (this.osc) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = this.ctx || new AC();
        try { this.ctx.resume(); } catch (e) { /* ignore */ }
        this.osc = this.ctx.createOscillator();
        this.gain = this.ctx.createGain();
        this.osc.type = 'square';
        this.osc.connect(this.gain); this.gain.connect(this.ctx.destination);
        this.setVolume();
        this.osc.start();
        let hi = false;
        this.tmr = setInterval(() => { hi = !hi; if (this.osc) this.osc.frequency.value = hi ? 950 : 650; }, 450);
        if (!this.frame) this.info = 'Son : sirène intégrée';
      } catch (e) { console.warn('[Alarme] Audio impossible', e); this.info = 'Audio impossible : ' + e; }
    },
    playYT(id) {
      const f = doc.createElement('iframe');
      f.src = 'https://www.youtube.com/embed/' + id + '?autoplay=1&loop=1&playlist=' + id + '&enablejsapi=1&controls=0&playsinline=1&origin=' + encodeURIComponent(location.origin);
      f.allow = 'autoplay; encrypted-media';
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      // YouTube refuse de lancer un lecteur trop petit ou caché : 200x200 quasi invisible, dans la page
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:200px;height:200px;opacity:0.01;pointer-events:none;border:0;z-index:1;';
      f.onload = () => {
        try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*'); } catch (e) { /* ignore */ }
        setTimeout(() => this.setVolume(), 600); setTimeout(() => this.setVolume(), 2000);
      };
      doc.body.appendChild(f);
      this.frame = f;
      this.info = 'YouTube : chargement…';
      clearTimeout(this.ytTimer);
      this.ytTimer = setTimeout(() => {
        if (this.on && !this.ytOk) this.ytFail('aucune lecture après 6 s (autoplay bloqué ou vidéo non intégrable)');
      }, 6000);
    },
    ytPlaying() {
      if (!this.on || this.ytOk) return;
      this.ytOk = true; clearTimeout(this.ytTimer);
      this.stopBeep();                       // YouTube joue : on coupe la sirène de secours
      this.info = 'Son : YouTube en lecture';
      updateIcon();
    },
    ytFail(msg) {
      if (!this.on) return;
      this.info = 'YouTube a échoué (' + msg + ') → sirène intégrée à la place';
      if (this.frame) { this.frame.remove(); this.frame = null; }
      this.beep();
      this.info = 'YouTube a échoué (' + msg + ') → sirène intégrée à la place';
      updateIcon();
    },
    setVolume() {
      const v = Math.max(0, Math.min(100, +S.volume || 0));
      if (this.gain) this.gain.gain.value = v / 100 * 0.4;
      if (this.frame && this.frame.contentWindow) {
        try { this.frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [v] }), '*'); } catch (e) { /* ignore */ }
      }
    }
  };

  // Réponses du lecteur YouTube (lecture en cours / erreur)
  uw.addEventListener('message', e => {
    if (typeof e.origin !== 'string' || e.origin.indexOf('youtube') < 0 || typeof e.data !== 'string') return;
    let d; try { d = JSON.parse(e.data); } catch (err) { return; }
    if (!d) return;
    if (d.event === 'onError') Sound.ytFail('erreur ' + d.info);
    else if (d.event === 'onStateChange' && d.info === 1) Sound.ytPlaying();
    else if (d.event === 'infoDelivery' && d.info && d.info.playerState === 1) Sound.ytPlaying();
  });

  // Déverrouille l'audio à chaque clic / touche (en phase de capture : le jeu ne peut pas l'intercepter)
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      Sound.ctx = Sound.ctx || new AC();
      if (Sound.ctx.state !== 'running') Sound.ctx.resume();
      if (Sound.on && Sound.blocked) {          // l'alarme sonnait en silence : on la relance maintenant
        Sound.blocked = false; Sound.stop(); Sound.start();
      }
    } catch (e) { /* ignore */ }
  }
  ['pointerdown', 'click', 'keydown', 'touchstart'].forEach(ev => doc.addEventListener(ev, unlockAudio, true));

  /* ------------------------------------------------------------------ */
  /*  État                                                               */
  /* ------------------------------------------------------------------ */
  const state = { moves: [], attacks: [], pending: [] };
  const acked = new Set();

  function scan() {
    state.moves = collectMovements().map(normalize).filter(Boolean);
    state.attacks = state.moves.filter(m => m.kind === 'unit' && m.hostile);
    const ids = new Set(state.attacks.map(m => m.key));
    [...acked].forEach(k => { if (!ids.has(k)) acked.delete(k); });
    state.pending = state.attacks.filter(m => !acked.has(m.key));

    if (S.enabled && state.pending.length) Sound.start();
    else if (!Sound.testing) Sound.stop();

    updateIcon(); updateBadge(); updateList();
  }

  function silence() {
    state.attacks.forEach(m => acked.add(m.key));
    Sound.testing = false;
    Sound.stop();
    scan();
  }

  /* ------------------------------------------------------------------ */
  /*  Farm : villages de paysans (version rapide)                        */
  /* ------------------------------------------------------------------ */
  // Durée de base (secondes) de chaque option du jeu
  const FARM_BASE = { 1: 300, 2: 600, 3: 1200, 4: 2400 };

  // Place libre dans l'entrepôt d'une ville (pour choisir la ville qui récolte)
  function freeStorage(id) {
    try {
      const r = uw.ITowns.getTown(id).resources();
      return (+r.storage || 0) - Math.max(+r.wood || 0, +r.stone || 0, +r.iron || 0);
    } catch (e) { return 0; }
  }

  function lootOf(relId) {
    try {
      const rel = uw.MM.getModels().FarmTownPlayerRelation[relId];
      return +((rel.attributes || rel).lootable_at) || 0;
    } catch (e) { return 0; }
  }

  function farmCandidates() {
    const M = uw.MM.getModels();
    const rels = M.FarmTownPlayerRelation || {}, farms = M.FarmTown || {};
    const towns = allTowns();
    const byIsland = {};
    for (const id in towns) {
      const t = towns[id], a = t.attributes || t;
      const ix = t.getIslandCoordinateX ? t.getIslandCoordinateX() : a.island_x;
      const iy = t.getIslandCoordinateY ? t.getIslandCoordinateY() : a.island_y;
      if (ix == null || iy == null) continue;
      (byIsland[ix + ',' + iy] = byIsland[ix + ',' + iy] || []).push(+id);
    }
    // Sur chaque île, la ville avec le plus de place libre récolte en premier
    for (const k in byIsland) byIsland[k].sort((x, y) => freeStorage(y) - freeStorage(x));

    const out = [];
    for (const id in rels) {
      const r = rels[id].attributes || rels[id];
      const f = farms[r.farm_town_id];
      if (!f || r.relation_status === 0) continue;       // village non débloqué
      const fa = f.attributes || f;
      const mine = byIsland[fa.island_x + ',' + fa.island_y];
      if (!mine) continue;                                // aucune de tes villes sur l'île
      const game = +r.lootable_at || 0;
      const ready = Math.max(game ? game + S.farmExtra * 60 : 0, Farm.localNext[r.id] || 0);
      out.push({ id: r.id, farmId: r.farm_town_id, townId: mine[0], name: fa.name || ('Village #' + r.farm_town_id), ready, game });
    }
    return out;
  }

  // Récolte d'un seul village
  async function claim(v) {
    const before = v.game;
    const data = {
      model_url: 'FarmTownPlayerRelation/' + v.id, action_name: 'claim',
      arguments: { farm_town_id: v.farmId, type: 'resources', option: +S.farmOption || 1 },
      town_id: v.townId, nl_init: true
    };
    const res = await ajax('frontend_bridge', 'execute', data, 10000);
    if (res.ok || res.msg !== 'pas de réponse') return res;
    // Pas de réponse : on regarde si le jeu a quand même mis à jour le village
    const after = lootOf(v.id);
    return after > before ? { ok: true, msg: '' } : res;
  }

  const Farm = {
    on: false, t: null, nextAt: 0, claimed: 0, log: [], localNext: {},
    status: 'Arrêté', ready: 0, total: 0, nextReady: 0, batchOk: true,
    addLog(msg) { addLog(this, msg); },
    start() {
      if (this.on) return;
      this.on = true; this.batchOk = true; this.addLog('Démarré');
      this.loop();
    },
    stop() {
      if (!this.on) return;
      this.on = false; clearTimeout(this.t); this.nextAt = 0; this.status = 'Arrêté';
      this.addLog('Arrêté');
    },
    schedule(ms) {
      clearTimeout(this.t);
      this.nextAt = Date.now() + ms;
      this.t = setTimeout(() => this.loop(), ms);
    },
    // Récolte groupée : tous les villages prêts en une seule requête
    async claimBatch(list) {
      this.status = 'Récolte groupée : ' + list.length + ' village(s)';
      updateFarmUI();
      const before = {};
      list.forEach(v => { before[v.id] = lootOf(v.id); });
      const res = await ajax('farm_town_overviews', 'claim_loads_multiple', {
        towns: list.map(v => ({ farm_town_id: v.farmId, town_id: v.townId })),
        time_option_base: FARM_BASE[+S.farmOption] || 300,
        claim_factor: 'normal',
        current_town_id: list[0].townId
      }, 12000);
      await sleep(2500);                                  // laisse le jeu mettre ses données à jour
      let ok = 0;
      list.forEach(v => {
        if (lootOf(v.id) > before[v.id]) { ok++; this.localNext[v.id] = nowSec() + Math.max(30, S.farmExtra * 60); }
        else this.localNext[v.id] = nowSec() + 120;
      });
      if (ok > 0) {
        this.claimed += ok;
        this.addLog('✔ Groupé : ' + ok + '/' + list.length + ' village(s)');
        const first = list.find(v => lootOf(v.id) > before[v.id]);
        if (first) this.addLog('ℹ Délai réel imposé par le jeu pour ce lot : ' + fmtCd(lootOf(first.id) - nowSec()));
      } else {
        this.batchOk = false;
        this.addLog('⚠ Récolte groupée sans effet (' + (res.msg || 'aucun changement') + ') – passage en mode individuel');
      }
    },
    // Récoltes individuelles, quelques-unes en même temps
    async claimSome(list) {
      await Promise.all(list.map(async (v, i) => {
        await sleep(i * rand(150, 400));
        if (!this.on) return;
        this.status = 'Récolte : ' + v.name;
        const res = await claim(v);
        if (!this.on) return;
        if (res.ok) {
          this.claimed++;
          this.localNext[v.id] = nowSec() + Math.max(30, S.farmExtra * 60);
          this.addLog('✔ ' + v.name);
        } else {
          this.localNext[v.id] = nowSec() + 300;
          this.addLog('✖ ' + v.name + ' (' + (res.msg || 'échec') + ') – nouvel essai dans 5 min');
        }
      }));
    },
    async loop() {
      if (!this.on) return;
      let c;
      try { c = farmCandidates(); } catch (e) {
        this.status = 'Erreur de lecture des villages'; this.addLog('Erreur : ' + e);
        this.schedule(15000); return;
      }
      const now = nowSec();
      const ready = c.filter(x => x.ready <= now).sort((a, b) => a.ready - b.ready);
      this.total = c.length; this.ready = ready.length;
      this.nextReady = c.length ? Math.min(...c.map(x => x.ready)) : 0;
      if (!ready.length) {
        this.status = c.length ? 'En attente du prochain village' : 'Aucun village de paysans trouvé';
        // On se réveille pile quand le prochain village est prêt (au plus 15 s d'attente)
        const wait = c.length ? (this.nextReady - now) * 1000 + 300 : 10000;
        this.schedule(Math.max(500, Math.min(wait, 15000)));
        return;
      }
      try {
        if (S.farmFast && this.batchOk) await this.claimBatch(ready.slice(0, 40));
        else await this.claimSome(ready.slice(0, num(S.farmPar, 1, 4, 1)));
      } catch (e) { this.addLog('Erreur : ' + e); }
      if (!this.on) return;
      this.status = 'Village suivant';
      this.schedule(rand(150, 400));
    }
  };

  function updateFarmUI() {
    const st = $('#flz-fst'); if (!st) return;
    let t = '<b>' + esc(Farm.status) + '</b>';
    if (Farm.on && Farm.nextAt) t += ' — prochaine action dans ' + Math.max(0, Math.ceil((Farm.nextAt - Date.now()) / 1000)) + ' s';
    if (Farm.on && Farm.ready === 0 && Farm.nextReady) t += '<br>Prochain village prêt dans ' + fmtCd(Farm.nextReady - nowSec());
    t += '<br>Villages : ' + Farm.ready + ' prêt(s) / ' + Farm.total + ' · Récoltes cette session : ' + Farm.claimed;
    t += '<br>Mode : ' + (S.farmFast && Farm.batchOk ? 'groupé' : 'individuel (' + num(S.farmPar, 1, 4, 1) + ' à la fois)');
    if (st._last !== t) { st._last = t; st.innerHTML = t; }
    const b = $('#flz-fbtn'); if (b) b.textContent = Farm.on ? '■ Arrêter la ferme' : '▶ Démarrer la ferme';
    const l = $('#flz-flog');
    if (l) { const lt = Farm.log.join('\n') || 'Aucune action pour le moment.'; if (l._last !== lt) { l._last = lt; l.textContent = lt; } }
  }

  function farmDebug() {
    const out = [];
    try {
      const M = uw.MM.getModels();
      const R = M.FarmTownPlayerRelation || {}, F = M.FarmTown || {};
      out.push('Relations: ' + Object.keys(R).length + ' | FarmTown: ' + Object.keys(F).length);
      Object.keys(R).slice(0, 3).forEach(k => out.push('REL ' + JSON.stringify(R[k].attributes || R[k])));
      Object.keys(F).slice(0, 2).forEach(k => out.push('FARM ' + JSON.stringify(F[k].attributes || F[k])));
      const towns = allTowns();
      Object.keys(towns).slice(0, 2).forEach(k => {
        const t = towns[k];
        out.push('VILLE ' + k + ' île ' + (t.getIslandCoordinateX ? t.getIslandCoordinateX() : '?') + ',' + (t.getIslandCoordinateY ? t.getIslandCoordinateY() : '?'));
      });
      out.push('Candidats: ' + farmCandidates().length + ' | mode groupé actif: ' + Farm.batchOk);
    } catch (e) { out.push('Erreur: ' + e); }
    out.push('--- journal ---'); Farm.log.forEach(l => out.push(l));
    return out.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /*  Minage d'or : vente de ressources contre de l'or (Échange d'or)    */
  /* ------------------------------------------------------------------ */
  const RES_LABEL = { wood: 'Bois', stone: 'Pierre', iron: 'Argent' };
  const RES_KEYS = ['wood', 'stone', 'iron'];
  const BUY_RE = /buy|purchase|achat|acheter/i;

  function findLeaves(o, path, out) {
    path = path || []; out = out || [];
    if (o && typeof o === 'object') { for (const k in o) findLeaves(o[k], path.concat(k), out); }
    else out.push({ path, v: o });
    return out;
  }
  function parentOf(o, path) { let c = o; for (let i = 0; i < path.length - 1; i++) c = c[path[i]]; return c; }
  function setPath(o, path, v) { parentOf(o, path)[path[path.length - 1]] = v; }

  // Achat ou vente ? (on cherche un mot-clé dans la requête)
  function tplDir(req) {
    const txt = req.action + ' ' + JSON.stringify(req.body);
    if (/sell|vend/i.test(txt)) return 'sell';
    if (BUY_RE.test(txt)) return 'buy';
    return '?';
  }
  // Analyse la requête capturée pour repérer où se trouvent la ressource et la quantité
  function buildTemplate(req) {
    const leaves = findLeaves(req.body);
    const tpl = { controller: req.controller, action: req.action, body: req.body, amountPath: null, resPath: null, resKeysParent: null };
    tpl.v2 = true; tpl.dir = tplDir(req); tpl.confirmed = tpl.dir === 'sell';
    const rl = leaves.find(l => typeof l.v === 'string' && /^(wood|stone|iron)$/.test(l.v));
    if (rl) tpl.resPath = rl.path;
    const last = l => String(l.path[l.path.length - 1]);
    const wl = leaves.find(l => typeof l.v === 'number' && /^(wood|stone|iron)$/.test(last(l)) && l.v > 0);
    if (wl) tpl.resKeysParent = wl.path.slice(0, -1);
    else {
      const nums = leaves.filter(l => typeof l.v === 'number' && !/id$/i.test(last(l)) && last(l) !== 'nl_init');
      const a = nums.find(l => /amount|count|quantity|value|sell|offer|resource/i.test(last(l))) || nums[0];
      if (a) tpl.amountPath = a.path;
    }
    return tpl;
  }
  // Taux de change appris pendant l'apprentissage (or reçu / quantité vendue)
  function tplRate(tpl) {
    const lv = findLeaves(tpl.body), k = l => String(l.path[l.path.length - 1]);
    const g = lv.find(l => typeof l.v === 'number' && k(l) === 'gold' && l.v > 0);
    let q = lv.find(l => typeof l.v === 'number' && /^(wood|stone|iron)$/.test(k(l)) && l.v > 0);
    if (!q && tpl.amountPath) q = lv.find(l => l.path.join('/') === tpl.amountPath.join('/'));
    return g && q && q.v > 0 && g !== q ? { goldPath: g.path, per: g.v / q.v } : null;
  }
  function applyTemplate(tpl, townId, res, amount) {
    const body = JSON.parse(JSON.stringify(tpl.body));
    if (body.town_id !== undefined) body.town_id = townId;
    if (tpl.resPath) setPath(body, tpl.resPath, res);
    if (tpl.resKeysParent) {
      const sub = o => (tpl.resKeysParent.length ? parentOf(o, tpl.resKeysParent.concat('x')) : o);
      const p = sub(body), origP = sub(tpl.body);
      const had = RES_KEYS.filter(k => k in origP);
      if (had.length > 1) RES_KEYS.forEach(k => { if (k in p) p[k] = (k === res ? amount : 0); });
      else had.forEach(k => { delete p[k]; });   // le modèle n'a qu'une ressource : on la remplace
      p[res] = amount;
    }
    if (tpl.amountPath) setPath(body, tpl.amountPath, amount);
    // L'or demandé suit la quantité vendue (même taux que pendant l'apprentissage)
    const rt = tplRate(tpl);
    if (rt) setPath(body, rt.goldPath, Math.max(1, Math.floor(amount * rt.per)));
    return body;
  }

  function parseReq(st) {
    const url = String(st.url || '');
    const um = url.match(/\/game\/([a-z_]+)\?([^#]*)/i);
    if (!um || typeof st.data !== 'string' || !st.data) return null;
    const action = new URLSearchParams(um[2]).get('action');
    const p = new URLSearchParams(st.data);
    let body;
    if (p.has('json')) body = JSON.parse(p.get('json'));
    else { body = {}; p.forEach((v, k) => { body[k] = v; }); }
    return { controller: um[1], action, body };
  }

  function goldPickTown(res, amount, reserve) {
    const towns = allTowns();
    let best = null;
    for (const id in towns) {
      let r; try { r = towns[id].resources(); } catch (e) { continue; }
      const avail = (+r[res] || 0) - reserve;
      if (avail >= amount && (!best || avail > best.avail)) best = { id: +id, avail, name: townName(+id) };
    }
    return best;
  }

  function townRes(id, res) {
    try { return +uw.ITowns.getTown(id).resources()[res] || 0; } catch (e) { return null; }
  }

  const goldEveryMs = () => (+S.goldEvery || 10) * 60000 + Math.random() * 15000;

  const Gold = {
    on: false, t: null, nextAt: 0, sold: 0, sales: 0, log: [], status: 'Arrêté',
    learning: false, hooked: false, last: null, fails: 0, tpl: null, captured: false, noEffect: 0,
    addLog(msg) { addLog(this, msg); },
    saveTemplate(r) {
      const tpl = buildTemplate(r);
      if (tpl.dir === 'buy') {
        this.addLog("⛔ C'est un ACHAT : non enregistré. Fais une VENTE à la main.");
        return;
      }
      S.goldTpl = tpl; save(); this.captured = true;
      this.addLog('✔ Modèle enregistré (' + (tpl.dir === 'sell' ? 'VENTE' : 'direction inconnue') + ') : ' + r.controller + '/' + r.action + ' ' + (r.body.model_url || ''));
      this.addLog("ℹ J'écoute encore 20 s pour voir si le jeu envoie une 2e requête (confirmation)…");
      setTimeout(() => { if (Gold.learning) { Gold.learning = false; Gold.addLog('Apprentissage terminé'); updateGoldUI(); } }, 20000);
    },
    useLast() {
      if (!this.last) { this.addLog('Aucune requête capturée pour le moment'); return; }
      this.saveTemplate(this.last);
    },
    start() {
      if (this.on) return;
      const t = S.goldTpl;
      if (!t) { this.status = 'Aucun modèle de vente'; this.addLog("Démarrage impossible : fais d'abord l'apprentissage"); return; }
      if (t.dir === 'buy') {
        this.status = 'Le modèle est un ACHAT : refusé';
        this.addLog("⛔ Le modèle enregistré est un ACHAT : refus. Refais l'apprentissage avec une VENTE");
        return;
      }
      if (!t.confirmed) {
        this.status = 'Modèle à confirmer';
        this.addLog("Direction inconnue : si tu as bien fait une VENTE, clique sur « C'était une vente »");
        return;
      }
      this.tpl = t;
      this.on = true; this.addLog('Démarré (un essai toutes les ' + S.goldEvery + ' min)');
      this.loop();
    },
    stop() {
      if (!this.on) return;
      this.on = false; clearTimeout(this.t); this.nextAt = 0; this.status = 'Arrêté';
      this.addLog('Arrêté');
    },
    schedule(ms) {
      clearTimeout(this.t);
      this.nextAt = Date.now() + ms;
      this.t = setTimeout(() => this.loop(), ms);
    },
    async loop() {
      if (!this.on) return;
      const list = RES_KEYS.filter(r => S.goldRes3 && S.goldRes3[r]);
      if (!list.length) { this.status = 'Aucune ressource cochée'; this.schedule(goldEveryMs()); return; }
      if (S.goldMaxSales && this.sales >= S.goldMaxSales) { this.addLog('Limite de ventes atteinte'); this.stop(); return; }
      const jobs = [];
      for (const r of list) {
        let pick = null;
        try { pick = goldPickTown(r, S.goldAmount, S.goldReserve); } catch (e) { this.addLog('Erreur : ' + e); }
        if (pick) jobs.push({ r, pick });
      }
      if (!jobs.length) {
        this.status = 'Pas assez de ressources dans tes villes';
        this.schedule(goldEveryMs()); return;
      }
      const sent = [];
      for (const j of jobs) {
        if (!this.on) return;
        if (S.goldMaxSales && this.sales + sent.length >= S.goldMaxSales) break;
        this.status = 'Vente : ' + RES_LABEL[j.r] + ' (' + j.pick.name + ')';
        updateGoldUI();
        const body = applyTemplate(this.tpl, j.pick.id, j.r, S.goldAmount);
        if (BUY_RE.test(JSON.stringify(body))) {
          this.addLog("⛔ La requête contient un mot d'ACHAT : envoi bloqué, modèle supprimé");
          S.goldTpl = null; save(); this.stop(); return;
        }
        const before = townRes(j.pick.id, j.r);
        const res = await ajax(this.tpl.controller, this.tpl.action, body, 15000);
        if (!this.on) return;
        if (res.ok) sent.push({ r: j.r, pick: j.pick, before });
        else { this.fails++; this.addLog('✖ ' + RES_LABEL[j.r] + ' (' + j.pick.name + ') : ' + (res.msg || 'échec')); }
        await sleep(rand(800, 1600));
      }
      if (sent.length) {
        await sleep(4000);                                // laisse le jeu mettre à jour les ressources
        if (!this.on) return;
        let worked = 0;
        for (const x of sent) {
          const after = townRes(x.pick.id, x.r);
          if (x.before != null && after != null && after - x.before >= S.goldAmount * 0.5) {
            this.addLog('⛔ ACHAT SUSPECTÉ (' + RES_LABEL[x.r] + ' a augmenté) : arrêt et modèle supprimé');
            S.goldTpl = null; save(); this.stop(); return;
          }
          if (x.before != null && after != null && x.before - after >= S.goldAmount * 0.5) {
            worked++; this.sales++; this.sold += S.goldAmount; this.fails = 0;
            this.addLog('✔ ' + S.goldAmount + ' ' + RES_LABEL[x.r] + ' (' + x.pick.name + ')');
          } else this.addLog('⚠ ' + RES_LABEL[x.r] + ' : requête acceptée mais ressources inchangées');
        }
        if (worked) this.noEffect = 0;
        else if (++this.noEffect >= 3) {
          this.addLog("⛔ 3 essais sans baisse de ressources : la vente demande sûrement une 2e étape. Refais l'apprentissage et regarde les requêtes vues.");
          this.stop(); return;
        }
      }
      this.status = 'Prochain essai de vente';
      this.schedule(goldEveryMs());
    }
  };

  if (goldMigrated) Gold.addLog("Ancien modèle supprimé (c'était peut-être un achat) : refais l'apprentissage avec une VENTE");

  // Capture de la requête pendant l'apprentissage
  function goldHook() {
    if (Gold.hooked) return;
    try {
      const $j = uw.jQuery || uw.$;
      $j(uw.document).ajaxSend(function (e, xhr, st) {
        try {
          if (Triumph.learning) {
            const rt = parseReq(st);
            if (rt && !/^(notify|heartbeat|chat)/.test(rt.controller)) {
              Triumph.addLog('Requête vue : ' + rt.controller + '/' + rt.action + ' ' + JSON.stringify(rt.body).slice(0, 160));
              Triumph.saveTemplate(rt);
            }
          }
          if (!Gold.learning) return;
          const r = parseReq(st);
          if (!r || /^(notify|heartbeat|chat)/.test(r.controller)) return;
          Gold.last = r;
          Gold.addLog('Requête vue : ' + r.controller + '/' + r.action + ' ' + (r.body.model_url || '') + ' ' + (r.body.action_name || '') + ' ' + (r.body.arguments ? JSON.stringify(r.body.arguments).slice(0, 160) : ''));
          if (!Gold.captured && /exchange|gold|premium/i.test(r.controller + ' ' + r.action + ' ' + JSON.stringify(r.body))) Gold.saveTemplate(r);
        } catch (err) { /* ignore */ }
      });
      Gold.hooked = true;
    } catch (e) { Gold.addLog('Capture impossible : ' + e); }
  }

  function updateGoldUI() {
    const st = $('#flz-gst'); if (!st) return;
    let t = '<b>' + esc(Gold.status) + '</b>';
    if (Gold.on && Gold.nextAt) t += ' — dans ' + fmtCd((Gold.nextAt - Date.now()) / 1000);
    t += '<br>Ventes cette session : ' + Gold.sales + ' · Quantité vendue : ' + Gold.sold;
    if (st._last !== t) { st._last = t; st.innerHTML = t; }
    const b = $('#flz-gbtn'); if (b) b.textContent = Gold.on ? '■ Arrêter la vente' : '▶ Démarrer la vente';
    const lb = $('#flz-glearn'); if (lb) lb.textContent = Gold.learning ? '■ Arrêter l\'apprentissage' : '🎓 Apprendre';
    const tp = $('#flz-gtpl');
    if (tp) {
      const T = S.goldTpl;
      const tt = Gold.learning ? "⏳ Apprentissage en cours : fais une VENTE à la main dans l'Échange d'or…" :
        !T ? '✖ Aucun modèle enregistré' :
        T.dir === 'buy' ? "⛔ Modèle d'ACHAT : refusé. Refais l'apprentissage avec une VENTE" :
        T.confirmed ? '✔ Modèle de VENTE enregistré : ' + T.controller + '/' + T.action + ' ' + (T.body.model_url || '') :
        "⚠ Modèle enregistré, direction inconnue : si c'était bien une VENTE, clique sur « C'était une vente »";
      if (tp._last !== tt) { tp._last = tt; tp.textContent = tt; }
    }
    const l = $('#flz-glog');
    if (l) { const lt = Gold.log.join('\n') || 'Aucune action pour le moment.'; if (l._last !== lt) { l._last = lt; l.textContent = lt; } }
  }

  function goldDebug() {
    const out = [];
    try {
      out.push('Collections: ' + Object.keys(uw.MM.getCollections()).filter(k => /exchange|gold|premium/i.test(k)).join(', '));
      out.push('Models: ' + Object.keys(uw.MM.getModels()).filter(k => /exchange|gold|premium/i.test(k)).join(', '));
      out.push('Modèle: ' + JSON.stringify(S.goldTpl));
      out.push('Dernière requête: ' + JSON.stringify(Gold.last));
    } catch (e) { out.push('Erreur: ' + e); }
    out.push('--- journal ---'); Gold.log.forEach(l => out.push(l));
    return out.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /*  Build : terminer gratuitement les constructions sous 5 minutes     */
  /* ------------------------------------------------------------------ */
  const BUILD_LIMIT = 290;   // secondes (5 min moins une marge : au-delà, la fin coûte de l'or)

  // Première construction de chaque ville (celle qui est en cours)
  function buildOrders() {
    const out = [];
    const towns = allTowns();
    for (const id in towns) {
      let orders;
      try { orders = towns[id].buildingOrders().models; } catch (e) { continue; }
      if (!orders || !orders.length) continue;
      let first = null;
      for (let i = 0; i < orders.length; i++) {
        const a = orders[i].attributes;
        if (+a.to_be_completed_at && (!first || +a.to_be_completed_at < +first.to_be_completed_at)) first = a;
      }
      if (!first) continue;
      out.push({ townId: +id, townName: townName(+id), orderId: first.id, building: first.building_type, tear: !!first.tear_down, end: +first.to_be_completed_at });
    }
    return out.sort((x, y) => x.end - y.end);
  }

  function buyInstant(o) {
    return ajax('frontend_bridge', 'execute', {
      model_url: 'BuildingOrder/' + o.orderId, action_name: 'buyInstant',
      arguments: { order_id: o.orderId }, town_id: o.townId, nl_init: true
    }, 15000);
  }

  const Build = {
    on: false, t: null, done: 0, log: [], status: 'Arrêté', rows: [], skip: {},
    addLog(msg) { addLog(this, msg); },
    start() { if (this.on) return; this.on = true; this.addLog('Démarré'); this.loop(); },
    stop() { if (!this.on) return; this.on = false; clearTimeout(this.t); this.status = 'Arrêté'; this.addLog('Arrêté'); },
    schedule(ms) { clearTimeout(this.t); this.t = setTimeout(() => this.loop(), ms); },
    async loop() {
      if (!this.on) return;
      const now = serverNow();
      if (now == null) { this.status = 'Heure du serveur indisponible (rien n\'est fait)'; this.schedule(15000); return; }
      let list;
      try { list = buildOrders(); } catch (e) { this.status = 'Erreur de lecture des constructions'; this.addLog('Erreur : ' + e); this.schedule(15000); return; }
      this.rows = list;
      const due = list.filter(o => { const left = o.end - now; return left > 0 && left <= BUILD_LIMIT && !((this.skip[o.orderId] || 0) > now); });
      if (!due.length) {
        this.status = list.length ? 'En attente : aucune construction sous 5 minutes' : 'Aucune construction en cours';
        // On se réveille quand la prochaine construction passe sous la limite (entre 3 et 10 s)
        const next = list.find(o => o.end - now > BUILD_LIMIT);
        const wait = next ? (next.end - now - BUILD_LIMIT) * 1000 + 300 : 10000;
        this.schedule(Math.max(3000, Math.min(wait, 10000))); return;
      }
      const o = due[0];
      this.status = 'Fin gratuite : ' + o.townName;
      updateBuildUI();
      // Dernière vérification juste avant l'envoi : jamais au-dessus de la limite gratuite
      const n2 = serverNow();
      if (n2 == null || o.end - n2 > BUILD_LIMIT || o.end - n2 <= 0) { this.schedule(2000); return; }
      const res = await buyInstant(o);
      if (!this.on) return;
      if (res.ok) { this.done++; this.addLog('✔ ' + o.townName + ' : ' + o.building + (o.tear ? ' (démolition)' : '')); }
      else { this.skip[o.orderId] = (serverNow() || nowSec()) + 300; this.addLog('✖ ' + o.townName + ' (' + (res.msg || 'échec') + ') – pas de nouvel essai avant 5 min'); }
      this.status = 'Pause';
      this.schedule(2000 + Math.random() * 4000);
    }
  };

  function updateBuildUI() {
    const st = $('#flz-bst'); if (!st) return;
    const now = serverNow();
    if (!Build.on) { try { Build.rows = buildOrders(); } catch (e) { /* ignore */ } }
    const t = '<b>' + esc(Build.status) + '</b><br>Constructions terminées gratuitement : ' + Build.done;
    if (st._last !== t) { st._last = t; st.innerHTML = t; }
    const b = $('#flz-bbtn'); if (b) b.textContent = Build.on ? '■ Arrêter' : '▶ Démarrer';
    const ls = $('#flz-blist');
    if (ls) {
      const html = Build.rows.length ? Build.rows.map(o =>
        `<div class="flz-row"><div class="l1"><span class="tag">${esc(o.townName)}</span><span>${esc(o.building)}${o.tear ? ' (démolition)' : ''}</span><span class="bcd" data-end="${o.end}" style="margin-left:auto"></span></div></div>`
      ).join('') : '<div class="flz-empty">Aucune construction en cours.</div>';
      if (ls._last !== html) { ls._last = html; ls.innerHTML = html; }
      if (now != null) ls.querySelectorAll('.bcd').forEach(el => {
        const left = el.dataset.end - now;
        el.textContent = fmtCd(left);
        el.style.color = left <= BUILD_LIMIT ? '#9fd6a5' : '#e8dcc0';
      });
    }
    const l = $('#flz-blog');
    if (l) { const lt = Build.log.join('\n') || 'Aucune action pour le moment.'; if (l._last !== lt) { l._last = lt; l.textContent = lt; } }
  }

  /* ------------------------------------------------------------------ */
  /*  Marches triomphales (uniquement celles-là)                         */
  /* ------------------------------------------------------------------ */
  const TRI_DEFAULT = { controller: 'building_place', action: 'start_celebration', body: { celebration_type: 'triumph' } };
  const TRI_RE = /triumph|triomph/i;
  const TRI_GLOBAL_ERR = /point|bataille|combat|battle|kill|punkt|punti/i;   // manque de points : inutile d'essayer les autres villes

  function celebrationsList() {
    const out = [];
    try {
      const col = uw.MM.getOnlyCollectionByName('Celebration');
      ((col && col.models) || []).forEach(m => out.push(m.attributes || m));
    } catch (e) { /* ignore */ }
    return out;
  }

  const Triumph = {
    on: false, t: null, log: [], status: 'Arrêté', sent: 0, active: 0, skip: {}, backoff: 0, learning: false,
    addLog(msg) { addLog(this, msg); },
    saveTemplate(r) {
      if (!TRI_RE.test(r.action + ' ' + JSON.stringify(r.body))) { this.addLog('Requête ignorée (pas une marche triomphale)'); return; }
      S.triTpl = { controller: r.controller, action: r.action, body: r.body }; save(); this.learning = false;
      this.addLog('✔ Requête enregistrée : ' + r.controller + '/' + r.action);
    },
    // Construit la requête d'une ville ; refuse tout ce qui n'est pas une marche triomphale
    request(townId) {
      const t = S.triTpl || TRI_DEFAULT;
      const body = JSON.parse(JSON.stringify(t.body));
      body.town_id = townId;
      if (body.arguments && typeof body.arguments === 'object' && 'town_id' in body.arguments) body.arguments.town_id = townId;
      if (!TRI_RE.test(JSON.stringify(body))) return null;
      return { controller: t.controller, action: t.action, body };
    },
    start() {
      if (this.on) return;
      this.on = true; this.addLog('Démarré'); this.loop();
    },
    stop() {
      if (!this.on) return;
      this.on = false; clearTimeout(this.t); this.status = 'Arrêté'; this.addLog('Arrêté');
    },
    schedule(ms) { clearTimeout(this.t); this.t = setTimeout(() => this.loop(), ms); },
    async loop() {
      if (!this.on) return;
      const now = serverNow();
      if (now == null) { this.status = 'Heure du serveur indisponible'; this.schedule(30000); return; }
      if (this.backoff > now) {
        this.status = 'Pause (points insuffisants ?) : reprise dans ' + fmtCd(this.backoff - now);
        this.schedule(30000); return;
      }
      let towns;
      try { towns = allTowns(); } catch (e) { this.status = 'Erreur de lecture des villes'; this.addLog('Erreur : ' + e); this.schedule(30000); return; }
      const act = {};
      celebrationsList().forEach(a => { if (TRI_RE.test(String(a.celebration_type)) && +a.finished_at > now) act[a.town_id] = +a.finished_at; });
      this.active = Object.keys(act).length;
      const ids = Object.keys(towns).map(Number).filter(id => !act[id] && !((this.skip[id] || 0) > now));
      if (!ids.length) { this.status = 'Surveillance : rien à lancer'; this.schedule(30000); return; }
      for (const id of ids) {
        if (!this.on) return;
        const rq = this.request(id);
        if (!rq) { this.addLog('⛔ La requête ne contient pas « triumph » : envoi bloqué'); this.stop(); return; }
        this.status = 'Marche triomphale : ' + townName(id);
        updateTriUI();
        const res = await ajax(rq.controller, rq.action, rq.body, 12000);
        if (!this.on) return;
        const n2 = serverNow() || now;
        if (res.ok) { this.sent++; this.skip[id] = n2 + 600; this.addLog('✔ ' + townName(id)); }
        else {
          this.skip[id] = n2 + 1800;
          this.addLog('✖ ' + townName(id) + ' (' + (res.msg || 'échec') + ')');
          if (TRI_GLOBAL_ERR.test(String(res.msg))) { this.backoff = n2 + 900; this.addLog('Pause de 15 min (points insuffisants ?)'); break; }
        }
        await sleep(rand(1500, 3000));
      }
      this.status = 'Surveillance des marches triomphales';
      this.schedule(30000);
    }
  };

  function updateTriUI() {
    const st = $('#flz-trist'); if (!st) return;
    const t = '<b>' + esc(Triumph.status) + '</b><br>Lancées cette session : ' + Triumph.sent + ' · En cours (connues du jeu) : ' + Triumph.active;
    if (st._last !== t) { st._last = t; st.innerHTML = t; }
    const tp = $('#flz-tritpl');
    if (tp) {
      const tt = Triumph.learning ? '⏳ Apprentissage : lance une marche triomphale à la main dans le jeu…' :
        S.triTpl ? '✔ Requête apprise : ' + S.triTpl.controller + '/' + S.triTpl.action :
        'Requête standard du jeu utilisée (non apprise)';
      if (tp._last !== tt) { tp._last = tt; tp.textContent = tt; }
    }
    const lb = $('#flz-trilearn'); if (lb) lb.textContent = Triumph.learning ? "■ Arrêter l'apprentissage" : '🎓 Apprendre';
    const l = $('#flz-trilog');
    if (l) { const lt = Triumph.log.join('\n') || 'Aucune action pour le moment.'; if (l._last !== lt) { l._last = lt; l.textContent = lt; } }
  }

  function triDebug() {
    const out = [];
    try {
      out.push('Heure serveur: ' + serverNow());
      out.push('Collection Celebration: ' + (celebrationsList().length) + ' entrée(s)');
      celebrationsList().slice(0, 6).forEach(a => out.push('CELEB ' + JSON.stringify(a)));
      out.push('Requête apprise: ' + JSON.stringify(S.triTpl));
      out.push('Exemple de requête: ' + JSON.stringify(Triumph.request(Object.keys(allTowns())[0] | 0)));
    } catch (e) { out.push('Erreur: ' + e); }
    out.push('--- journal ---'); Triumph.log.forEach(l => out.push(l));
    return out.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /*  Plan attaque : envoi d'une attaque / d'un soutien à la seconde     */
  /* ------------------------------------------------------------------ */
  function parseDur(t) {
    const m = String(t || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
    return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
  }
  function parseTownId(t) { const m = String(t || '').match(/\d{2,}/); return m ? +m[0] : 0; }
  function parseUnits(t) {
    const out = {};
    String(t || '').split(/[,;\n]+/).forEach(p => {
      const m = p.trim().match(/^([a-z_]+)\s*[:=]?\s*(\d+)$/i);
      if (m && +m[2] > 0) out[m[1].toLowerCase()] = +m[2];
    });
    return out;
  }

  const Plan = {
    on: false, log: [], status: 'Désarmé', offsetMs: 0, sendAtMs: 0, calibrated: false,
    addLog(msg) { addLog(this, msg); },
    serverMs() { return Date.now() + this.offsetMs; },
    plan() {
      const P = S.plan;
      const units = parseUnits(P.units), dur = parseDur(P.duration), tid = parseTownId(P.target);
      const arr = new Date(P.arrival).getTime() / 1000;
      if (!P.origin) return { err: "Choisis la ville d'origine" };
      if (!tid) return { err: 'ID de la ville cible invalide' };
      if (!Object.keys(units).length) return { err: 'Aucune troupe (exemple : sword:100, archer:50)' };
      if (!dur) return { err: 'Durée du trajet invalide (HH:MM:SS)' };
      if (!(arr > 0)) return { err: "Heure d'arrivée invalide" };
      const wanted = Math.floor(arr) + (+P.offset || 0);       // offset négatif : on arrive avant l'heure visée
      return { units, dur, tid, wanted, sendAt: wanted - dur };
    },
    body(p) {
      const b = { id: p.tid, type: S.plan.type === 'support' ? 'support' : 'attack', town_id: +S.plan.origin, nl_init: true };
      return Object.assign(b, p.units);
    },
    // Synchronise l'horloge locale sur la seconde du serveur (précision de quelques ms)
    async calibrate() {
      let last = serverNow();
      if (last != null && !Number.isInteger(last)) { this.offsetMs = last * 1000 - Date.now(); return; }
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        await sleep(4);
        const n = serverNow();
        if (n != null && last != null && n !== last) { this.offsetMs = n * 1000 - Date.now(); return; }
      }
    },
    // Retrouve l'ordre envoyé dans les mouvements du jeu
    findMove(p, origin) {
      let best = null;
      collectMovements().forEach(x => {
        const a = x.a;
        const d = a.destination_town_id || linkId(a.link_destination) || linkId(a.destination_town_link) || a.target_town_id;
        const o = a.origin_town_id || linkId(a.link_origin) || linkId(a.origin_town_link);
        const arr = +a.arrival_at || +a.arrival || 0;
        if (!arr || String(d) !== String(p.tid) || String(o) !== String(origin != null ? origin : S.plan.origin)) return;
        const dt = Math.abs(arr - p.wanted);
        if (dt <= 900 && (!best || dt < best.dt)) best = { arr, dt };
      });
      return best;
    },
    start() {
      if (this.on) return;
      const p = this.plan();
      if (p.err) { this.status = p.err; this.addLog('⛔ ' + p.err); return; }
      this.offsetMs = nowSec() * 1000 - Date.now();
      this.sendAtMs = p.sendAt * 1000 - num(S.plan.lead, 0, 2000, 150);
      if (this.sendAtMs - this.serverMs() < 1500) {
        this.status = "Heure d'envoi déjà passée (ou trop proche)";
        this.addLog("⛔ L'envoi devrait partir à " + fmtArr(p.sendAt) + ' : trop tard ou trop proche'); return;
      }
      this.on = true; this.calibrated = false;
      this.addLog('Armé : arrivée visée ' + fmtArr(p.wanted) + ', envoi prévu à ' + fmtArr(p.sendAt));
      this.run(p);
    },
    stop() {
      if (!this.on) return;
      this.on = false; this.status = 'Désarmé'; this.addLog('Annulé');
    },
    async run(p) {
      while (this.on) {
        const rem = this.sendAtMs - this.serverMs();
        if (rem > 5000) { this.status = 'Armé'; await sleep(Math.max(200, Math.min(1000, rem - 4500))); continue; }
        if (!this.calibrated) { this.status = "Calibrage de l'horloge…"; await this.calibrate(); this.calibrated = true; continue; }
        break;
      }
      if (!this.on) return;
      const rem = this.sendAtMs - this.serverMs();
      if (rem > 30) await sleep(rem - 20);
      while (this.on && this.serverMs() < this.sendAtMs) { /* attente active sur les derniers ms */ }
      if (!this.on) return;
      this.status = 'Envoi en cours…';
      const body = this.body(p);
      let ok = false;
      // Réessaie seulement si le jeu refuse ; jamais si l'ordre est déjà parti (pas de doublon)
      for (let i = 1; i <= 5 && this.on; i++) {
        const res = await ajax('town_info', 'send_units', body, 8000);
        if (res.ok || (res.msg === 'pas de réponse' && this.findMove(p))) { ok = true; break; }
        this.addLog('✖ Essai ' + i + ' : ' + (res.msg || 'refusé'));
        if (this.findMove(p)) { ok = true; break; }
        await sleep(300);
      }
      if (!ok) { this.on = false; this.status = 'Échec : ordre non envoyé'; return; }
      this.addLog('✔ Ordre envoyé (' + (S.plan.type === 'support' ? 'soutien' : 'attaque') + ')');
      const hm = { label: (S.plan.type === 'support' ? 'Soutien' : 'Attaque') + ' → ' + townName(p.tid) + ' (manuel)', sentAt: Math.round(this.serverMs() / 1000), wanted: p.wanted, arr: null, error: '' };
      this.history.unshift(hm); if (this.history.length > 30) this.history.length = 30;
      await sleep(2000);
      const m = this.findMove(p);
      if (m) {
        hm.arr = m.arr;
        const gap = m.arr - p.wanted;
        this.addLog('Arrivée réelle : ' + fmtArr(m.arr) + (gap === 0 ? ' (pile sur la cible)' : ' (écart ' + (gap > 0 ? '+' : '') + gap + ' s)'));
        if (gap > 0) this.addLog("ℹ Trop tard : augmente l'avance d'envoi de ~" + (gap * 1000) + ' ms la prochaine fois');
        if (gap < 0) this.addLog("ℹ Trop tôt : diminue l'avance d'envoi");
      } else this.addLog("ℹ Ordre introuvable dans les mouvements : vérifie l'heure d'arrivée dans le jeu");
      this.on = false; this.status = 'Terminé';
    }
  };

  function updatePlanUI() {
    const st = $('#flz-pst'); if (!st) return;
    let t = '<b>' + esc(Plan.status) + '</b>';
    if (Plan.on && Plan.sendAtMs && Plan.status === 'Armé') t += ' — envoi dans ' + fmtCd((Plan.sendAtMs - Plan.serverMs()) / 1000);
    if (st._last !== t) { st._last = t; st.innerHTML = t; }
    const b = $('#flz-pbtn'); if (b) b.textContent = Plan.on ? '■ Annuler' : "▶ Armer l'envoi";
    const ps = $('#flz-phst');
    if (ps) {
      const t2 = Plan.pending.length ? Plan.pending.map((j, i) =>
        `<div class="flz-row"><div class="l1"><span class="tag">${esc(j.label)}</span><span class="cd">${fmtCd((j.sendAtMs - Plan.serverMs()) / 1000)}</span><b class="flz-pcx" data-i="${i}" title="Annuler" style="cursor:pointer;color:#ff8a7a;margin-left:8px">✕</b></div>` +
        `<div class="l3">Envoi à ${fmtArr(j.sendAt || Math.round(j.sendAtMs / 1000))} · arrivée visée ${fmtArr(j.wanted)}</div></div>`).join('') :
        '<div class="flz-empty">Aucun ordre en attente d\'envoi.</div>';
      if (ps._last !== t2) { ps._last = t2; ps.innerHTML = t2; }
    }
    const ph = $('#flz-phist');
    if (ph) {
      const t3 = Plan.history.length ? Plan.history.map(h => {
        const gap = h.arr ? h.arr - h.wanted : 0;
        const res = h.error ? 'erreur : ' + esc(h.error) :
          h.arr ? 'arrivée réelle ' + fmtArr(h.arr) + (gap === 0 ? ' ✔ pile' : ' (écart ' + (gap > 0 ? '+' : '') + gap + ' s)') : 'vérification de l\'arrivée…';
        return `<div class="flz-row ${h.error ? 'hostile' : 'sup'}"><div class="l1"><span class="tag">${esc(h.label)}</span><span class="cd">envoyé ${fmtArr(h.sentAt)}</span></div>` +
          `<div class="l3">Arrivée visée ${fmtArr(h.wanted)} · ${res}</div></div>`;
      }).join('') : '<div class="flz-empty">Aucun ordre envoyé pour le moment.</div>';
      if (ph._last !== t3) { ph._last = t3; ph.innerHTML = t3; }
    }
    const l = $('#flz-plog');
    if (l) { const lt = Plan.log.join('\n') || 'Aucune action pour le moment.'; if (l._last !== lt) { l._last = lt; l.textContent = lt; } }
  }

  /* ----- Envoi chronométré depuis la fenêtre du jeu (clic sur Attaquer / Soutenir) ----- */
  function toast(msg) {
    let t = $('#flz-toast');
    if (!t) { t = doc.createElement('div'); t.id = 'flz-toast'; doc.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 7000);
  }

  // Durée du trajet affichée dans la fenêtre d'envoi du jeu
  function readWindowDuration(root) {
    const els = root ? root.querySelectorAll('.way_duration, .duration_container, [class*="duration"]') :
      doc.querySelectorAll('.attack_support_window .way_duration, .attack_support_window .duration_container, .attack_support_window [class*="duration"], .way_duration');
    for (const el of els) {
      const m = (el.textContent || '').match(/(\d{1,3}):(\d{2}):(\d{2})/);
      if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    }
    return 0;
  }

  Plan.pending = []; Plan.history = []; Plan.everCal = false; Plan.hooked = false; Plan.origPost = null;
  const _cal = Plan.calibrate;
  Plan.calibrate = async function () { await _cal.call(this); this.everCal = true; };

  Plan.reject = function (args, msg) {
    toast('⛔ ' + msg); this.addLog('⛔ ' + msg);
    try { const cb = args[4]; if (cb && typeof cb.error === 'function') cb.error(null, { error: msg }); } catch (e) { /* ignore */ }
  };

  // Prochaine occurrence (heure locale) d'une heure « HH:MM:SS », au plus tôt à afterS (secondes epoch)
  function nextOccurrence(hms, afterS) {
    const m = String(hms || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const d = new Date(afterS * 1000);
    d.setHours(+m[1], +m[2], +(m[3] || 0), 0);
    let t = Math.floor(d.getTime() / 1000);
    if (t < afterS) t += 86400;
    return t;
  }

  // Sniping : parmi l'heure d'arrivée et les heures « acceptées en plus », on vise la première atteignable
  Plan.decide = function (dur) {
    const times = [S.plan.time].concat(S.plan.extra || []).filter(t => /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(t || '')));
    if (!times.length) return { mode: 'none' };
    const nat = this.serverMs() / 1000 + dur + 1;            // arrivée si l'ordre part maintenant (+1 s d'envoi)
    const off = +S.plan.offset || 0;                          // 0 à -5 s : arriver un peu avant
    const after = Math.ceil(nat + 1.5) - off;
    let best = null;
    times.forEach(t => {
      const aim = nextOccurrence(t, after) + off;
      if (!best || aim < best.aim) best = { mode: 'wait', aim, sendAt: aim - dur, time: t };
    });
    return best;
  };

  // Appelé quand tu cliques sur Attaquer / Soutenir en mode Sniping
  Plan.interceptSend = function (self, args) {
    const data = args[2];
    const dur = readWindowDuration() || parseDur(S.plan.duration);
    if (!dur) { this.reject(args, 'Durée du trajet introuvable : renseigne-la dans Plan attaque'); return true; }
    if (!this.everCal) this.offsetMs = nowSec() * 1000 - Date.now();
    const d = this.decide(dur);
    if (d.mode === 'none') { this.reject(args, "Aucune heure d'arrivée valide (format HH:MM:SS)"); return true; }
    const label = (data.type === 'support' ? 'Soutien' : 'Attaque') + ' → ' + townName(+data.id);
    const sendAtMs = d.sendAt * 1000 - num(S.plan.lead, 0, 2000, 150);
    if (sendAtMs - this.serverMs() < 300) { this.reject(args, 'Trop tard pour programmer cet ordre'); return true; }
    const job = { label, sendAtMs, sendAt: d.sendAt, wanted: d.aim, canceled: false, cal: false, tid: +data.id, origin: data.town_id };
    this.pending.push(job);
    const at = fmtArr(d.sendAt);
    this.addLog('⏱ ' + label + ' retenu : envoi à ' + at + ', arrivée à ' + fmtArr(d.aim) + ' (' + d.time + ')');
    toast('⏱ ' + label + ' programmé : envoi à ' + at);
    this.runHook(job, self, args);
    return true;
  };

  Plan.runHook = async function (job, self, args) {
    while (!job.canceled) {
      const rem = job.sendAtMs - this.serverMs();
      if (rem > 5000) { await sleep(Math.max(200, Math.min(1000, rem - 4500))); continue; }
      if (!job.cal) { await this.calibrate(); job.cal = true; continue; }
      break;
    }
    if (job.canceled) return;
    const rem = job.sendAtMs - this.serverMs();
    if (rem > 30) await sleep(rem - 20);
    while (!job.canceled && this.serverMs() < job.sendAtMs) { /* attente active sur les derniers ms */ }
    if (job.canceled) return;
    const h = { label: job.label, sentAt: Math.round(this.serverMs() / 1000), wanted: job.wanted, arr: null, error: '' };
    this.history.unshift(h); if (this.history.length > 30) this.history.length = 30;
    try { this.origPost.apply(self, args); this.addLog('✔ ' + job.label + ' envoyé'); }
    catch (e) { h.error = String(e); this.addLog('✖ ' + job.label + ' : ' + e); }
    this.pending = this.pending.filter(j => j !== job);
    await sleep(2500);
    const m = this.findMove({ tid: job.tid, wanted: job.wanted }, job.origin);
    if (m) {
      const gap = m.arr - job.wanted; h.arr = m.arr;
      this.addLog('Arrivée réelle : ' + fmtArr(m.arr) + (gap === 0 ? ' (pile sur la cible)' : ' (écart ' + (gap > 0 ? '+' : '') + gap + ' s)'));
      if (gap > 0) this.addLog("ℹ Trop tard : augmente l'avance d'envoi de ~" + (gap * 1000) + ' ms');
      if (gap < 0) this.addLog("ℹ Trop tôt : diminue l'avance d'envoi");
    } else this.addLog("ℹ Ordre introuvable dans les mouvements : vérifie dans le jeu");
  };

  // On enveloppe l'envoi d'ordres du jeu (seulement attaque et soutien, seulement si l'option est cochée)
  function installPlanHook() {
    if (Plan.hooked || !uw.gpAjax || typeof uw.gpAjax.ajaxPost !== 'function') return;
    const orig = uw.gpAjax.ajaxPost;
    Plan.origPost = orig;
    uw.gpAjax.ajaxPost = function (controller, action, data) {
      try {
        if (S.plan.hook && !Plan.on && controller === 'town_info' && action === 'send_units' &&
            data && typeof data === 'object' && /^(attack|support)$/.test(String(data.type))) {
          if (Plan.interceptSend(this, arguments)) return;
        }
      } catch (e) { console.warn('[Plan] hook', e); }
      return orig.apply(this, arguments);
    };
    Plan.hooked = true;
  }

  // Ajoute les options de programmation directement dans la fenêtre Attaquer / Soutenir du jeu
  function attackWindows() {
    const list = [...doc.querySelectorAll('.attack_support_window')];
    // Secours : fenêtre reconnue par la durée du trajet, seulement si elle ne contient pas déjà une fenêtre d'attaque
    doc.querySelectorAll('.way_duration').forEach(el => {
      const w = el.closest('.gpwindow_content');
      if (w && !w.querySelector('.attack_support_window') && !list.includes(w)) list.push(w);
    });
    return list;
  }
  // Panneau « Mode / Arrival time / Also accept these arrival times » (fenêtre du jeu et menu)
  const SN_INP = 'background:#1f1811;color:#fff;border:1px solid #6b5026;padding:2px 4px;margin:0 6px 0 4px';
  const SN_BTN = 'padding:3px 10px;border:1px solid #a98a48;cursor:pointer;color:#fff;';
  function snipeBoxHTML() {
    const offs = [0, -1, -2, -3, -4, -5].map(v => `<option value="${v}">${v} s</option>`).join('');
    return `<div class="flz-snipe" style="padding:6px 8px;background:#2b2217;border:2px solid #8a6b2e;border-radius:6px;color:#e8dcc0;font:12px Verdana,Arial,sans-serif">
      <div style="display:flex;align-items:center;margin-bottom:6px"><b style="width:100px;color:#ffd87a">Mode</b>
        <span><button type="button" data-m="yolo" class="sn-m" style="${SN_BTN}border-radius:3px 0 0 3px">Yolo</button><button type="button" data-m="snipe" class="sn-m" style="${SN_BTN}border-radius:0 3px 3px 0">Sniping</button></span></div>
      <div class="sn-fields">
        <div style="display:flex;align-items:center;margin-bottom:6px"><b style="width:100px;color:#ffd87a">Arrival time</b>
          <input type="time" step="1" class="sn-time" style="${SN_INP}"><span style="color:#b8a578">Offset</span><select class="sn-off" style="${SN_INP}">${offs}</select></div>
        <div style="color:#ffd87a;margin-bottom:3px">Also accept these arrival times</div>
        <div class="sn-extra"></div>
        <button type="button" class="sn-add" style="${SN_BTN}background:#3f6b30;border-radius:3px;margin-top:2px;width:34px">+</button>
      </div>
      <div class="sn-info" style="margin-top:6px;color:#b8a578"></div>
      <button type="button" class="sn-send" style="${SN_BTN}background:#c0281c;border-radius:3px;margin-top:6px;font-weight:bold;display:none"></button></div>`;
  }

  // Bouton d'envoi (Attaquer / Soutenir) de la fenêtre du jeu
  function findSendButton(win) {
    const host = (win && win.closest('.gpwindow_content')) || win;
    if (!host) return null;
    const ok = e => !e.closest('.flz-inwin') && e.offsetParent !== null;
    const sel = '#btn_attack_town, #btn_support, .btn_attack_town, .btn_support, .btn_send_units, [id*="btn_attack"], [id*="btn_support"], [class*="btn_attack"], [class*="btn_support"]';
    const byId = [...host.querySelectorAll(sel)].find(ok);
    if (byId) return byId;
    return [...host.querySelectorAll('a, button, .button_new, .button')].find(e => ok(e) && /^(attaquer|soutenir|attack|support|angreifen|unterst)/i.test((e.textContent || '').trim()));
  }
  function bindSnipe(root) {
    if (!root || root._bound) return;
    root._bound = true;
    root.addEventListener('click', e => {
      const m = e.target.closest('.sn-m');
      if (m) { S.plan.mode = m.dataset.m; S.plan.hook = S.plan.mode === 'snipe'; save(); installPlanHook(); refreshAllSnipes(); return; }
      if (e.target.closest('.sn-add')) { S.plan.extra.push('00:00:00'); save(); refreshAllSnipes(true); return; }
      const d = e.target.closest('.sn-del');
      if (d) { S.plan.extra.splice(+d.dataset.i, 1); save(); refreshAllSnipes(true); return; }
      if (e.target.closest('.sn-send')) {
        const btn = findSendButton(root._win);
        if (!btn) { toast("⛔ Bouton Attaquer / Soutenir du jeu introuvable : clique directement dessus"); return; }
        btn.click();                          // le clic passe par l'envoi du jeu, que le mode Sniping intercepte
      }
    });
    root.addEventListener('change', e => {
      const t = e.target;
      if (t.classList.contains('sn-time')) S.plan.time = t.value || '00:00:00';
      else if (t.classList.contains('sn-off')) S.plan.offset = +t.value;
      else if (t.classList.contains('sn-x')) S.plan.extra[+t.dataset.i] = t.value || '00:00:00';
      else return;
      save();
    });
    ['keydown', 'keyup', 'keypress'].forEach(ev => root.addEventListener(ev, e => e.stopPropagation()));
  }
  function refreshSnipe(root, force, win) {
    if (!root.querySelector('.sn-m')) return;
    root.querySelectorAll('.sn-m').forEach(b => {
      const on = b.dataset.m === S.plan.mode;
      b.style.background = on ? (b.dataset.m === 'snipe' ? '#c0281c' : '#3f7fbf') : '#3d2f1b';
    });
    root.querySelector('.sn-fields').style.display = S.plan.mode === 'snipe' ? '' : 'none';
    const ti = root.querySelector('.sn-time');
    if (doc.activeElement !== ti && ti.value !== S.plan.time) ti.value = S.plan.time;
    const off = root.querySelector('.sn-off');
    if (doc.activeElement !== off) off.value = String(+S.plan.offset || 0);
    const ex = root.querySelector('.sn-extra'), sig = JSON.stringify(S.plan.extra);
    if (force || (ex._sig !== sig && !ex.contains(doc.activeElement))) {
      ex._sig = sig;
      ex.innerHTML = S.plan.extra.map((v, i) => `<div style="display:flex;align-items:center;margin-bottom:4px"><input type="time" step="1" class="sn-x" data-i="${i}" value="${esc(v)}" style="${SN_INP}"><button type="button" class="sn-del" data-i="${i}" style="${SN_BTN}background:#8b1a10;border-radius:3px;width:34px">−</button></div>`).join('');
    }
    const info = root.querySelector('.sn-info');
    const dur = readWindowDuration(win) || parseDur(S.plan.duration);
    let txt;
    if (S.plan.mode !== 'snipe') txt = "Yolo : l'ordre part tout de suite, sans programmation.";
    else if (!dur) txt = "Ouvre la fenêtre d'une ville pour voir l'heure d'envoi (ou saisis la durée du trajet dans Plan attaque).";
    else {
      const d = Plan.decide(dur);
      txt = d.mode === 'none' ? '⚠ Aucune heure valide.' : 'Trajet ' + fmtCd(dur) + " → l'ordre partira à " + fmtArr(d.sendAt) + ' pour arriver à ' + fmtArr(d.aim) + ' (' + d.time + ').';
    }
    if (info.textContent !== txt) info.textContent = txt;
    const send = root.querySelector('.sn-send');
    if (send) {
      send.style.display = win ? '' : 'none';           // bouton seulement dans la fenêtre du jeu
      const lb = S.plan.mode === 'snipe' ? '▶ Envoyer en Sniping' : '▶ Envoyer maintenant (Yolo)';
      if (send.textContent !== lb) send.textContent = lb;
    }
  }
  function refreshAllSnipes(force) {
    doc.querySelectorAll('.flz-inwin, #flz-sbox').forEach(r => refreshSnipe(r, force, r._win));
  }

  function injectAttackBox() {
    attackWindows().forEach(w => {
      const host = w.closest('.gpwindow_content') || w;
      host.querySelectorAll('.flz-inwin').forEach((b, i) => { if (i > 0) b.remove(); });   // jamais deux panneaux dans la même fenêtre
      if (!host.querySelector('.flz-inwin')) {
        const box = doc.createElement('div');
        box.className = 'flz-inwin';
        box.style.cssText = 'margin:8px;clear:both;position:relative;z-index:5';
        box.innerHTML = snipeBoxHTML();
        box._win = w;
        w.appendChild(box);
        bindSnipe(box);
        refreshSnipe(box, true, w);
      }
    });
    refreshAllSnipes(false);
  }

  function planDebug() {
    const out = [];
    try {
      const p = Plan.plan();
      out.push('Heure serveur: ' + serverNow() + ' | décalage horloge (ms): ' + Plan.offsetMs);
      out.push('Réglages: ' + JSON.stringify(S.plan));
      out.push('--- Mode fenêtre du jeu ---');
      out.push('Option cochée: ' + (S.plan.hook ? 'oui' : 'NON') + ' | interception installée: ' + (Plan.hooked ? 'oui' : 'NON') + ' | envoi retenus: ' + Plan.pending.length);
      out.push('Heure d\'arrivée réglée: ' + (new Date(S.plan.arrival).getTime() > 0 ? 'oui' : 'NON') + ' | durée lue dans la fenêtre ouverte: ' + (readWindowDuration() || 'introuvable') + ' s');
      out.push('--- Mode manuel ---');
      if (p.err) out.push('Non prêt: ' + p.err);
      else { out.push('Arrivée visée (s): ' + p.wanted + ' | envoi (s): ' + p.sendAt); out.push('Requête: town_info/send_units ' + JSON.stringify(Plan.body(p))); }
    } catch (e) { out.push('Erreur: ' + e); }
    out.push('--- journal ---'); Plan.log.forEach(l => out.push(l));
    return out.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /*  Interface                                                          */
  /* ------------------------------------------------------------------ */
  const css = `
  #flz-panel,#flz-spk{position:fixed;z-index:99999;font:12px/1.35 Verdana,Arial,sans-serif;color:#e8dcc0;box-sizing:border-box}
  #flz-panel{width:390px;background:#2b2217;border:2px solid #8a6b2e;border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,.6)}
  #flz-head{display:flex;align-items:center;gap:8px;padding:6px 8px;background:linear-gradient(#5a4322,#3b2c17);cursor:move;border-radius:4px 4px 0 0;touch-action:none;user-select:none}
  #flz-head .t{flex:1;font-weight:bold;color:#ffd87a}
  #flz-badge{background:#c0281c;color:#fff;border-radius:10px;padding:0 7px;font-weight:bold;display:none}
  #flz-min{cursor:pointer;background:#6b5026;border:1px solid #a98a48;color:#fff;border-radius:3px;width:22px;height:20px;line-height:16px;padding:0}
  #flz-tabs{display:flex;flex-wrap:wrap;background:#1f1811}
  #flz-tabs button{flex:1 1 auto;font-size:11px;padding:6px 6px;background:none;border:0;border-bottom:2px solid transparent;color:#bba577;cursor:pointer;font-weight:bold}
  #flz-tabs button.on{color:#ffd87a;border-bottom-color:#ffd87a;background:#2b2217}
  #flz-body{padding:8px;max-height:60vh;overflow:auto}
  #flz-panel.min #flz-body,#flz-panel.min #flz-tabs{display:none}
  .flz-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
  .flz-chips button{background:#3d2f1b;color:#d9c79c;border:1px solid #6b5026;border-radius:10px;padding:2px 8px;cursor:pointer}
  .flz-chips button.on{background:#8a6b2e;color:#fff}
  .flz-sec{margin:8px 0 3px;font-weight:bold;color:#ffd87a;border-bottom:1px solid #5a4322}
  .flz-row{padding:4px 6px;margin:3px 0;background:#382b1a;border-left:4px solid #6b5026;border-radius:3px}
  .flz-row.atk{border-left-color:#d1502f}
  .flz-row.sup{border-left-color:#3f9a54}
  .flz-row.trd{border-left-color:#3f7fbf}
  .flz-row.hostile{background:#5a1d17;border-left-color:#ff3b2a}
  .flz-row .l1{display:flex;gap:8px;align-items:baseline}
  .flz-row .tag{font-size:11px;color:#ffd87a}
  .flz-row .arr{font-size:13px;color:#fff}
  .flz-row .cd{margin-left:auto;color:#9fd6a5}
  .flz-row .l3{color:#b8a578;font-size:11px}
  .flz-empty{color:#998763;padding:8px;text-align:center}
  .flz-set label{display:block;margin:8px 0 3px;color:#ffd87a}
  .flz-set input[type=text]{width:100%;box-sizing:border-box;padding:4px;background:#1f1811;color:#fff;border:1px solid #6b5026}
  .flz-set input[type=range]{width:100%}
  .flz-set button{margin:6px 4px 0 0;padding:4px 10px;background:#6b5026;color:#fff;border:1px solid #a98a48;border-radius:3px;cursor:pointer}
  .flz-set textarea{width:100%;height:180px;box-sizing:border-box;background:#1f1811;color:#cfc;font-size:10px;margin-top:6px}
  .flz-set small{color:#998763;display:block;margin-top:2px}
  #flz-spk{display:flex;align-items:center;gap:8px;background:#2b2217;border:2px solid #8a6b2e;border-radius:22px;padding:4px 12px 4px 6px;cursor:move;touch-action:none;user-select:none;box-shadow:0 2px 10px rgba(0,0,0,.6)}
  #flz-spk .ic{font-size:22px;width:32px;height:32px;line-height:32px;text-align:center;border-radius:50%;background:#3d2f1b}
  #flz-spk .tx{font-weight:bold;color:#fff;max-width:320px;display:none}
  #flz-spk.idle{opacity:.65}
  #flz-spk.ring{background:#7a1610;border-color:#ff3b2a;animation:flz-pulse .8s infinite}
  #flz-spk.ring .ic{background:#c0281c;cursor:pointer}
  #flz-spk.ring .tx{display:block}
  @keyframes flz-pulse{50%{box-shadow:0 0 18px 4px #ff3b2a}}
  .flz-set select,.flz-set input[type=number]{padding:3px;background:#1f1811;color:#fff;border:1px solid #6b5026}
  .flz-set select{width:100%}
  .flz-set input[type=number]{width:70px}
  .flz-fst{padding:6px;background:#382b1a;border-left:4px solid #3f9a54;border-radius:3px;line-height:1.5}
  .flz-flog{margin:8px 0 0;max-height:120px;overflow:auto;background:#1a140d;color:#b9d9b0;font-size:10px;padding:4px;white-space:pre-wrap}
  #flz-toast{position:fixed;z-index:100000;top:12px;left:50%;transform:translateX(-50%);max-width:70vw;background:#2b2217;color:#ffd87a;border:2px solid #8a6b2e;border-radius:6px;padding:8px 14px;font:13px Verdana,Arial,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.6);display:none}
  `;
  const styleEl = doc.createElement('style'); styleEl.textContent = css; doc.head.appendChild(styleEl);

  // --- Panneau principal
  const panel = doc.createElement('div');
  panel.id = 'flz-panel';
  panel.innerHTML = `
    <div id="flz-head"><span class="t">🛡 Floozii Bot</span><span id="flz-badge"></span><button id="flz-min" class="flz-nodrag" title="Réduire / agrandir">–</button></div>
    <div id="flz-tabs">
      <button data-t="orders">Ordres</button><button data-t="market">Marché</button><button data-t="farm">Farm</button><button data-t="build">Build</button><button data-t="gold">Minage d'or</button><button data-t="plan">Plan attaque</button><button data-t="settings">Réglages</button>
    </div>
    <div id="flz-body"></div>`;
  doc.body.appendChild(panel);

  // --- Icône haut-parleur
  const spk = doc.createElement('div');
  spk.id = 'flz-spk';
  spk.className = 'idle';
  spk.innerHTML = '<span class="ic">🔈</span><span class="tx"></span>';
  doc.body.appendChild(spk);

  function place(el, key, dx, dy) {
    const p = S.pos[key];
    el.style.left = Math.max(0, Math.min(p ? p.x : dx, innerWidth - 60)) + 'px';
    el.style.top = Math.max(0, Math.min(p ? p.y : dy, innerHeight - 40)) + 'px';
  }
  function makeDraggable(el, handle, key) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('.flz-nodrag')) return;
      const r = el.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top, sx = e.clientX, sy = e.clientY;
      el._dragged = false;
      try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const mv = ev => {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) el._dragged = true;
        if (!el._dragged) return;
        el.style.left = Math.max(0, Math.min(innerWidth - el.offsetWidth, ev.clientX - ox)) + 'px';
        el.style.top = Math.max(0, Math.min(innerHeight - 30, ev.clientY - oy)) + 'px';
      };
      const up = () => {
        handle.removeEventListener('pointermove', mv);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (el._dragged) { const b = el.getBoundingClientRect(); S.pos[key] = { x: b.left, y: b.top }; save(); }
      };
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  }
  const placeAll = () => { place(panel, 'panel', Math.max(10, innerWidth - 410), 90); place(spk, 'spk', 20, 150); };
  placeAll();
  makeDraggable(panel, $('#flz-head'), 'panel');
  makeDraggable(spk, spk, 'spk');

  spk.addEventListener('click', () => { if (!spk._dragged && (state.pending.length || Sound.on)) silence(); });

  // --- Réduire
  function applyMin() { panel.classList.toggle('min', !!S.min); $('#flz-min').textContent = S.min ? '+' : '–'; }
  $('#flz-min').addEventListener('click', () => { S.min = !S.min; save(); applyMin(); });
  applyMin();

  // --- Onglets
  $('#flz-tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-t]'); if (!b) return;
    S.tab = b.dataset.t; save(); renderTab();
  });

  function updateIcon() {
    const ring = Sound.on && state.pending.length > 0;
    const active = Sound.on;
    spk.className = active ? 'ring' : 'idle';
    spk.querySelector('.ic').textContent = active ? '🔊' : (S.enabled ? '🔈' : '🔇');
    const groups = {};
    state.pending.forEach(m => { (groups[m.destTown] = groups[m.destTown] || []).push(m); });
    const names = Object.keys(groups).map(d => {
      const from = [...new Set(groups[d].map(m => m.originTown + (m.originPlayer ? ' (' + m.originPlayer + ')' : '')))];
      return d + ' ← ' + from.join(', ') + (groups[d].length > 1 ? ' ×' + groups[d].length : '');
    }).join(' | ');
    spk.querySelector('.tx').textContent = ring ? '⚠ ' + names + (Sound.blocked ? ' — 🔇 clique dans la page pour activer le son' : '') : (active ? '🔔 Test du son' : '');
    const sn = $('#flz-sndst'); if (sn) sn.textContent = Sound.info || '';
    spk.title = active ? 'Cliquer pour couper l\'alarme (glisser pour déplacer)' : 'Aucune attaque entrante (glisser pour déplacer)';
  }
  function updateBadge() {
    const b = $('#flz-badge'), n = state.attacks.length;
    b.style.display = n ? 'inline-block' : 'none';
    b.textContent = '⚔ ' + n;
  }

  /* ---------------- Rendu des onglets ---------------- */
  const byArr = (a, b) => a.arrival - b.arrival;

  function row(m) {
    const cls = (m.hostile ? 'hostile ' : '') + (m.kind === 'trade' ? 'trd' : m.isAttack ? 'atk' : m.isSupport ? 'sup' : '');
    const from = esc(m.originTown) + (m.originPlayer ? ' <i>(' + esc(m.originPlayer) + ')</i>' : '');
    const to = esc(m.destTown) + (m.destPlayer ? ' <i>(' + esc(m.destPlayer) + ')</i>' : '');
    const extra = m.kind === 'trade' ? (m.res || '') : m.units;
    return `<div class="flz-row ${cls}">
      <div class="l1"><span class="tag">${esc(m.kind === 'trade' ? m.dirLabel + ' · ' + m.label : m.label)}</span>
      <b class="arr">${fmtArr(m.arrival)}</b><span class="cd" data-ts="${m.arrival}"></span></div>
      <div class="l2">${m.originTown ? from + ' → ' + to : to}</div>
      ${extra ? '<div class="l3">' + esc(extra) + '</div>' : ''}
    </div>`;
  }
  function section(title, list) {
    return list.length ? `<div class="flz-sec">${title} (${list.length})</div>` + list.map(row).join('') : '';
  }

  function updateList() {
    const box = $('#flz-list'); if (!box) return;
    let html = '';
    if (S.tab === 'orders') {
      let l = state.moves.filter(m => m.kind === 'unit');
      const f = S.filter;
      if (f === 'in') l = l.filter(m => m.incoming);
      if (f === 'out') l = l.filter(m => !m.incoming);
      if (f === 'atk') l = l.filter(m => m.isAttack);
      if (f === 'sup') l = l.filter(m => m.isSupport);
      html = section('⬇ Entrants', l.filter(m => m.incoming).sort(byArr)) +
             section('⬆ Sortants', l.filter(m => !m.incoming && !m.isReturn).sort(byArr)) +
             section('↩ Retours', l.filter(m => m.isReturn).sort(byArr));
      if (!html) html = '<div class="flz-empty">Aucun ordre.</div>';
    } else if (S.tab === 'market') {
      const l = state.moves.filter(m => m.kind === 'trade').sort(byArr);
      html = l.length ? l.map(row).join('') :
        '<div class="flz-empty">Aucun ordre de marché.<br><small>Si tu en as et qu\'ils n\'apparaissent pas : Réglages → Debug.</small></div>';
    }
    if (box._last !== html) { box._last = html; box.innerHTML = html; }
    tick();
  }

  function tick() {
    const n = nowSec();
    doc.querySelectorAll('#flz-panel .cd[data-ts]').forEach(el => { el.textContent = fmtCd(el.dataset.ts - n); });
  }

  function debugDump() {
    const out = [];
    try {
      out.push('Joueur: ' + uw.Game.player_id + ' / ' + uw.Game.player_name);
      out.push('Collections: ' + Object.keys(uw.MM.getCollections()).filter(k => /movement|trade|command/i.test(k)).join(', '));
      out.push('Models: ' + Object.keys(uw.MM.getModels()).filter(k => /movement|trade|command/i.test(k)).join(', '));
    } catch (e) { out.push('Erreur MM: ' + e); }
    const items = collectMovements().map(x => ({ x, m: normalize(x) }));
    items.sort((p, q) => ((q.m && q.m.hostile) ? 1 : 0) - ((p.m && p.m.hostile) ? 1 : 0));
    const seen = {};
    items.filter(it => { seen[it.x.src] = (seen[it.x.src] || 0) + 1; return seen[it.x.src] <= 3; }).slice(0, 18).forEach(it => {
      let raw = ''; try { raw = JSON.stringify(it.x.a); } catch (e) { /* ignore */ }
      out.push('[' + it.x.src + '] ALARME=' + (it.m && it.m.hostile ? 'OUI' : 'non') + ' RETOUR=' + (it.m && it.m.isReturn ? 'oui' : 'non') + ' ' + raw);
    });
    return out.join('\n');
  }

  function showDebug(textareaSel, text) {
    const o = $(textareaSel); o.style.display = 'block'; o.value = text; o.select();
    try { navigator.clipboard.writeText(o.value); } catch (e) { /* ignore */ }
  }

  function renderTab() {
    doc.querySelectorAll('#flz-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === S.tab));
    const body = $('#flz-body');

    if (S.tab === 'orders') {
      const F = [['all', 'Tout'], ['in', 'Entrants'], ['out', 'Sortants'], ['atk', 'Attaques'], ['sup', 'Soutiens']];
      body.innerHTML = '<div class="flz-chips">' + F.map(f => `<button data-f="${f[0]}" class="${S.filter === f[0] ? 'on' : ''}">${f[1]}</button>`).join('') + '</div><div id="flz-list"></div>';
      $('.flz-chips', body).addEventListener('click', e => {
        const b = e.target.closest('button[data-f]'); if (!b) return;
        S.filter = b.dataset.f; save();
        doc.querySelectorAll('.flz-chips button').forEach(x => x.classList.toggle('on', x === b));
        updateList();
      });
      updateList();
    } else if (S.tab === 'market') {
      body.innerHTML = '<div id="flz-list"></div>';
      updateList();
    } else if (S.tab === 'farm') {
      const opt = n => `<option value="${n}" ${+S.farmOption === n ? 'selected' : ''}>`;
      const par = n => `<option value="${n}" ${+S.farmPar === n ? 'selected' : ''}>${n}</option>`;
      body.innerHTML = `<div class="flz-set">
        <div id="flz-fst" class="flz-fst"></div>
        <button id="flz-fbtn"></button>
        <label>Temps de récolte (option du jeu)</label>
        <select id="flz-fopt">${opt(1)}5 minutes</option>${opt(2)}10 minutes</option>${opt(3)}20 minutes</option>${opt(4)}40 minutes</option></select>
        <small>Même choix que dans la fenêtre d'un village de paysans : 5, 10, 20 ou 40 minutes. Pour récolter le plus vite possible, garde 5 minutes.</small>
        <label><input type="checkbox" id="flz-ffast" ${S.farmFast ? 'checked' : ''}> Récolte groupée (tous les villages prêts en une seule requête)</label>
        <small>Si ton compte ne la permet pas, le script bascule tout seul en mode individuel.</small>
        <label>Récoltes simultanées en mode individuel</label>
        <select id="flz-fpar">${[1, 2, 3, 4].map(par).join('')}</select>
        <label>Attente supplémentaire entre deux récoltes d'un village (minutes)</label>
        <input type="number" id="flz-fx" min="0" max="240" value="${S.farmExtra}">
        <small>0 = récolte dès que le jeu l'autorise.</small>
        <label><input type="checkbox" id="flz-fauto" ${S.farmAuto ? 'checked' : ''}> Démarrer automatiquement avec le jeu</label>
        <pre id="flz-flog" class="flz-flog"></pre>
        <button id="flz-fdbg">Debug ferme</button>
        <textarea id="flz-fout" style="display:none" readonly></textarea>
        <div class="flz-sec">Marches triomphales</div>
        <label><input type="checkbox" id="flz-tri" ${S.triumph ? 'checked' : ''}> Lancer automatiquement les marches triomphales (uniquement celles-là)</label>
        <div id="flz-trist" class="flz-fst"></div>
        <small id="flz-tritpl"></small>
        <button id="flz-trilearn"></button><button id="flz-triforget">Oublier</button><button id="flz-tridbg">Debug marches</button>
        <pre id="flz-trilog" class="flz-flog"></pre>
        <textarea id="flz-triout" style="display:none" readonly></textarea>
        <small>Si la requête standard échoue, clique sur « Apprendre » puis lance une marche triomphale à la main : le script la rejoue pour chaque ville.</small>
        <small>⚠ L'automatisation est interdite par les règles de Grepolis : il y a un risque de sanction sur ton compte.</small>
      </div>`;
      $('#flz-fbtn').onclick = () => { if (Farm.on) Farm.stop(); else Farm.start(); updateFarmUI(); };
      $('#flz-fopt').onchange = e => { S.farmOption = +e.target.value; save(); };
      $('#flz-ffast').onchange = e => { S.farmFast = e.target.checked; Farm.batchOk = true; save(); updateFarmUI(); };
      $('#flz-fpar').onchange = e => { S.farmPar = +e.target.value; save(); updateFarmUI(); };
      $('#flz-fx').onchange = e => { S.farmExtra = num(e.target.value, 0, 240, 0); e.target.value = S.farmExtra; save(); };
      $('#flz-fauto').onchange = e => { S.farmAuto = e.target.checked; save(); };
      $('#flz-fdbg').onclick = () => showDebug('#flz-fout', farmDebug());
      $('#flz-tri').onchange = e => { S.triumph = e.target.checked; save(); if (S.triumph) Triumph.start(); else Triumph.stop(); updateTriUI(); };
      $('#flz-trilearn').onclick = () => {
        Triumph.learning = !Triumph.learning;
        if (Triumph.learning) { goldHook(); Triumph.addLog("Apprentissage démarré : lance une marche triomphale à la main"); }
        else Triumph.addLog('Apprentissage arrêté');
        updateTriUI();
      };
      $('#flz-triforget').onclick = () => { S.triTpl = null; save(); Triumph.addLog('Requête apprise oubliée'); updateTriUI(); };
      $('#flz-tridbg').onclick = () => showDebug('#flz-triout', triDebug());
      updateTriUI();
      updateFarmUI();
    } else if (S.tab === 'build') {
      body.innerHTML = `<div class="flz-set">
        <div id="flz-bst" class="flz-fst"></div>
        <button id="flz-bbtn"></button>
        <label><input type="checkbox" id="flz-bauto" ${S.buildAuto ? 'checked' : ''}> Démarrer automatiquement avec le jeu</label>
        <small>Termine gratuitement toute construction qui passe sous 5 minutes. Le script n'agit jamais au-dessus de cette limite (ça coûterait de l'or).</small>
        <div class="flz-sec">Constructions en cours (une par ville)</div>
        <div id="flz-blist"></div>
        <pre id="flz-blog" class="flz-flog"></pre>
      </div>`;
      $('#flz-bbtn').onclick = () => { if (Build.on) Build.stop(); else Build.start(); updateBuildUI(); };
      $('#flz-bauto').onchange = e => { S.buildAuto = e.target.checked; save(); };
      updateBuildUI();
    } else if (S.tab === 'plan') {
      const P = S.plan;
      let townOpts = '';
      try { townOpts = Object.keys(allTowns()).map(id => `<option value="${id}" ${String(P.origin) === id ? 'selected' : ''}>${esc(townName(+id))}</option>`).join(''); } catch (e) { /* ignore */ }
      if (!P.origin) { try { P.origin = Object.keys(allTowns())[0] || ''; } catch (e) { /* ignore */ } }
      const offs = [0, -1, -2, -3, -4, -5].map(v => `<option value="${v}" ${+P.offset === v ? 'selected' : ''}>${v === 0 ? "Pile à l'heure visée" : v + ' s'}</option>`).join('');
      body.innerHTML = `<div class="flz-set">
        <div class="flz-sec">Depuis la fenêtre du jeu</div>
        <div id="flz-sbox">${snipeBoxHTML()}</div>
        <div class="flz-sec">⏱ Ordres Sniping en attente d'envoi</div>
        <div id="flz-phst"></div>
        <button id="flz-pcancel">Tout annuler</button>
        <div class="flz-sec">✔ Ordres envoyés (cette session)</div>
        <div id="flz-phist"></div>
        <button id="flz-phclear">Vider l'historique</button>
        <small>Sniping : clique sur Attaquer / Soutenir dans la fenêtre d'une ville, l'ordre part à la seconde voulue. Yolo : le jeu envoie normalement. Les heures sont celles de ton PC ; l'ordre vise la prochaine occurrence.</small>
        <div class="flz-sec">Réglages du timing</div>
        <label>Avance d'envoi (ms, pour compenser le temps réseau)</label>
        <input type="number" id="flz-plead" min="0" max="2000" value="${P.lead}">
        <label>Durée du trajet (HH:MM:SS) — utilisée seulement si le script ne la lit pas dans la fenêtre</label>
        <input type="text" id="flz-pdur" value="${esc(P.duration)}" placeholder="00:12:34">
        <div class="flz-sec">Envoi manuel (sans la fenêtre du jeu)</div>
        <div id="flz-pst" class="flz-fst"></div>
        <button id="flz-pbtn"></button>
        <label>Heure d'arrivée visée (envoi manuel)</label>
        <input type="datetime-local" step="1" id="flz-parr" value="${esc(P.arrival)}" style="background:#1f1811;color:#fff;border:1px solid #6b5026;padding:3px">
        <label>Type d'ordre</label>
        <select id="flz-ptype"><option value="attack" ${P.type !== 'support' ? 'selected' : ''}>Attaque</option><option value="support" ${P.type === 'support' ? 'selected' : ''}>Soutien</option></select>
        <label>Ville d'origine</label>
        <select id="flz-porig">${townOpts}</select>
        <label>Ville cible (ID, ou [town]ID[/town])</label>
        <input type="text" id="flz-ptgt" value="${esc(P.target)}" placeholder="123456">
        <label>Troupes (exemple : sword:100, archer:50)</label>
        <input type="text" id="flz-punits" value="${esc(P.units)}" placeholder="sword:100, archer:50">
        <small>Le script se cale sur l'horloge du serveur et envoie l'ordre une seule fois, à la seconde voulue.</small>
        <pre id="flz-plog" class="flz-flog"></pre>
        <button id="flz-pdbg">Debug plan</button>
        <textarea id="flz-pout" style="display:none" readonly></textarea>
      </div>`;
      const bind = (id, key, conv) => { $(id).onchange = e => { S.plan[key] = conv ? conv(e.target.value) : e.target.value; save(); }; };
      bind('#flz-ptype', 'type'); bind('#flz-porig', 'origin'); bind('#flz-ptgt', 'target'); bind('#flz-punits', 'units');
      bind('#flz-pdur', 'duration'); bind('#flz-parr', 'arrival');
      bind('#flz-plead', 'lead', v => num(v, 0, 2000, 150));
      $('#flz-pcancel').onclick = () => {
        const n = Plan.pending.length;
        Plan.pending.forEach(j => { j.canceled = true; }); Plan.pending = [];
        Plan.addLog(n ? n + ' envoi(s) programmé(s) annulé(s)' : 'Rien à annuler');
        if (n) toast('Envois annulés : ferme la fenêtre du jeu qui était en attente');
        updatePlanUI();
      };
      $('#flz-phst').addEventListener('click', e => {
        const x = e.target.closest('.flz-pcx'); if (!x) return;
        const j = Plan.pending[+x.dataset.i];
        if (j) { j.canceled = true; Plan.pending.splice(+x.dataset.i, 1); Plan.addLog('Annulé : ' + j.label); }
        updatePlanUI();
      });
      $('#flz-phclear').onclick = () => { Plan.history = []; updatePlanUI(); };
      $('#flz-pbtn').onclick = () => { if (Plan.on) Plan.stop(); else Plan.start(); updatePlanUI(); };
      $('#flz-pdbg').onclick = () => showDebug('#flz-pout', planDebug());
      bindSnipe($('#flz-sbox')); refreshSnipe($('#flz-sbox'), true);
      updatePlanUI();
    } else if (S.tab === 'gold') {
      const gr = (r, l) => `<label style="display:inline-block;margin:4px 12px 0 0"><input type="checkbox" class="flz-gr" data-r="${r}" ${S.goldRes3[r] ? 'checked' : ''}> ${l}</label>`;
      body.innerHTML = `<div class="flz-set">
        <div id="flz-gst" class="flz-fst"></div>
        <small>🔒 Sécurité : le script refuse tout modèle d'achat et s'arrête si une vente se comporte comme un achat.</small>
        <button id="flz-gbtn"></button>
        <label>Ressources vendues à chaque essai (les 3 à la suite)</label>
        ${gr('wood', 'Bois')}${gr('stone', 'Pierre')}${gr('iron', 'Argent')}
        <label>Quantité par vente (pour chaque ressource cochée)</label>
        <input type="number" id="flz-gamt" min="1" max="100000" value="${S.goldAmount}">
        <label>Réserve à garder dans chaque ville</label>
        <input type="number" id="flz-gkeep" min="0" max="100000" value="${S.goldReserve}">
        <label>Intervalle entre chaque essai de vente</label>
        <select id="flz-gevery">${[2, 5, 10].map(m => `<option value="${m}" ${+S.goldEvery === m ? 'selected' : ''}>${m} minutes</option>`).join('')}</select>
        <label><input type="checkbox" id="flz-gauto" ${S.goldAuto ? 'checked' : ''}> Démarrer automatiquement avec le jeu</label>
        <label>Arrêter après N ventes (0 = illimité)</label>
        <input type="number" id="flz-gcap" min="0" max="10000" value="${S.goldMaxSales}">
        <div class="flz-sec">Apprentissage de la vente</div>
        <small id="flz-gtpl"></small>
        <small>1) Clique sur « Apprendre ». 2) Ouvre le marché → Échange d'or et vends une petite quantité à la main. Le script enregistre la requête et la rejoue ensuite.</small>
        <button id="flz-glearn"></button><button id="flz-gok">✔ C'était une vente</button><button id="flz-glast">Utiliser la dernière requête</button><button id="flz-gforget">Oublier</button>
        <pre id="flz-glog" class="flz-flog"></pre>
        <button id="flz-gdbg">Debug or</button>
        <textarea id="flz-gout" style="display:none" readonly></textarea>
      </div>`;
      $('#flz-gbtn').onclick = () => { if (Gold.on) Gold.stop(); else Gold.start(); updateGoldUI(); };
      doc.querySelectorAll('.flz-gr').forEach(cb => { cb.onchange = () => { S.goldRes3[cb.dataset.r] = cb.checked; save(); }; });
      $('#flz-gamt').onchange = e => { S.goldAmount = num(e.target.value, 1, 100000, 1000); e.target.value = S.goldAmount; save(); };
      $('#flz-gkeep').onchange = e => { S.goldReserve = num(e.target.value, 0, 100000, 0); e.target.value = S.goldReserve; save(); };
      $('#flz-gevery').onchange = e => { S.goldEvery = +e.target.value; save(); };
      $('#flz-gauto').onchange = e => { S.goldAuto = e.target.checked; save(); };
      $('#flz-gcap').onchange = e => { S.goldMaxSales = num(e.target.value, 0, 10000, 0); e.target.value = S.goldMaxSales; save(); };
      $('#flz-glearn').onclick = () => {
        Gold.learning = !Gold.learning;
        if (Gold.learning) { goldHook(); Gold.last = null; Gold.captured = false; Gold.addLog('Apprentissage démarré : vends à la main dans l\'Échange d\'or'); }
        else Gold.addLog('Apprentissage arrêté');
        updateGoldUI();
      };
      $('#flz-gok').onclick = () => { if (S.goldTpl) { S.goldTpl.confirmed = true; save(); Gold.addLog('Modèle confirmé comme VENTE'); } updateGoldUI(); };
      $('#flz-glast').onclick = () => { Gold.useLast(); updateGoldUI(); };
      $('#flz-gforget').onclick = () => { S.goldTpl = null; save(); Gold.addLog('Modèle oublié'); updateGoldUI(); };
      $('#flz-gdbg').onclick = () => showDebug('#flz-gout', goldDebug());
      updateGoldUI();
    } else {
      body.innerHTML = `<div class="flz-set">
        <label><input type="checkbox" id="flz-en" ${S.enabled ? 'checked' : ''}> Alarme activée</label>
        <label><input type="checkbox" id="flz-spy" ${S.espionage ? 'checked' : ''}> Sonner aussi pour l'espionnage</label>
        <label><input type="checkbox" id="flz-iu" ${S.ignoreUnits ? 'checked' : ''}> Ignorer les mouvements aux troupes visibles (retours)</label>
        <label>Son d'alarme (lien YouTube)</label>
        <input type="text" id="flz-yt" placeholder="https://www.youtube.com/watch?v=..." value="${esc(S.youtube)}">
        <small>Vide = sirène intégrée. La vidéo doit autoriser l'intégration.</small>
        <label>Volume : <span id="flz-vv">${S.volume}</span>%</label>
        <input type="range" id="flz-vol" min="0" max="100" value="${S.volume}">
        <button id="flz-test">▶ Tester</button><button id="flz-stop">■ Arrêter le test</button>
        <small id="flz-sndst" style="margin-top:6px"></small>
        <hr style="border-color:#5a4322;margin:10px 0">
        <button id="flz-reset">Réinitialiser les positions</button><button id="flz-dbg">Debug données</button>
        <textarea id="flz-out" style="display:none" readonly></textarea>
      </div>`;
      $('#flz-en').onchange = e => { S.enabled = e.target.checked; save(); scan(); };
      $('#flz-spy').onchange = e => { S.espionage = e.target.checked; save(); scan(); };
      $('#flz-iu').onchange = e => { S.ignoreUnits = e.target.checked; save(); scan(); };
      $('#flz-yt').onchange = e => {
        S.youtube = e.target.value.trim(); save();
        if (Sound.on) { Sound.stop(); Sound.start(); }
      };
      $('#flz-vol').oninput = e => { S.volume = +e.target.value; $('#flz-vv').textContent = S.volume; Sound.setVolume(); save(); };
      $('#flz-test').onclick = () => { Sound.testing = true; Sound.start(); updateIcon(); };
      $('#flz-stop').onclick = () => { Sound.testing = false; scan(); };
      $('#flz-reset').onclick = () => { S.pos = {}; save(); placeAll(); };
      $('#flz-dbg').onclick = () => showDebug('#flz-out', debugDump());
    }
  }
  renderTab();
  window.addEventListener('resize', placeAll);

  /* ------------------------------------------------------------------ */
  /*  Démarrage : attendre que le jeu soit chargé                        */
  /* ------------------------------------------------------------------ */
  function checkOld() {
    const old = doc.getElementById('gpa-panel');   // ancien script « Alarme Grepolis »
    let w = $('#flz-warn');
    if (old && !w) {
      w = doc.createElement('div'); w.id = 'flz-warn';
      w.style.cssText = 'background:#8b1a10;color:#fff;padding:5px 8px;font-weight:bold;font-size:11px';
      w.textContent = '⚠ Ancien script « Alarme Grepolis » détecté : désactive-le dans Tampermonkey (double menu et double alarme).';
      $('#flz-tabs').before(w);
    } else if (!old && w) w.remove();
  }
  setInterval(checkOld, 3000); checkOld();

  const wait = setInterval(() => {
    if (uw.MM && uw.MM.getModels && uw.ITowns && uw.Game && uw.Game.player_id) {
      clearInterval(wait);
      scan();
      setInterval(scan, 2000);
      setInterval(() => { tick(); updateFarmUI(); updateGoldUI(); updateBuildUI(); updateTriUI(); updatePlanUI(); installPlanHook(); injectAttackBox(); }, 1000);
      goldHook();
      installPlanHook();
      if (S.goldAuto && S.goldTpl) Gold.start();
      if (S.buildAuto) Build.start();
      if (S.farmAuto) Farm.start();
      if (S.triumph) Triumph.start();
    }
  }, 1000);
})();
