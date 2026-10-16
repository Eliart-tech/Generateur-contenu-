/* Amorce — interface (vanilla JS, aucune dépendance, aucun build).
   Parcours : brief → relevé des tendances → angles → scripts → bulletin de prévision. */
"use strict";

/* =========================================================================
   Référentiels
   ========================================================================= */

const PLATFORMS = ["linkedin", "reels", "x", "youtube"];
const PF = {
  linkedin: { name: "LinkedIn", icon: "linkedin" },
  reels: { name: "Reels", icon: "reels" },
  x: { name: "X", icon: "x" },
  youtube: { name: "YouTube", icon: "youtube" },
};

// Bandes de potentiel, de la plus froide à la plus chaude.
const BAND_ORDER = ["moitie_basse", "top50", "top25", "top10"];
const BANDS = {
  moitie_basse: { label: "Bas 50 %", title: "Sous la médiane de ta niche", heat: "cold", idx: 0 },
  top50: { label: "Top 50 %", title: "Top 50 % de ta niche", heat: "mild", idx: 1 },
  top25: { label: "Top 25 %", title: "Top 25 % de ta niche", heat: "warm", idx: 2 },
  top10: { label: "Top 10 %", title: "Top 10 % de ta niche", heat: "hot", idx: 3 },
};
// Une prévision n'est jamais certaine : l'indice plafonne à 4/5.
const CONFIDENCE = { faible: 2, moyenne: 3, haute: 4 };
const FACTOR_LABELS = {
  hook: "Accroche",
  structure: "Structure",
  adequation_tendance: "Tendance",
  emotion: "Émotion",
  cta: "Appel à l'action",
};
const TYPE_LABELS = {
  contrarian: "Contre-courant",
  storytelling: "Récit",
  liste: "Liste",
  educatif: "Pédagogie",
  reaction: "Réaction",
  etude_de_cas: "Étude de cas",
};
const VIEW_TITLES = { creer: "Créer", idees: "Idées", radar: "Radar", historique: "Historique", reglages: "Réglages" };
const RADAR_IDEAS = ["intelligence artificielle", "reconversion", "marketing local", "productivité"];

const ICONS = {
  check: '<path d="M5 12l4.5 4.5L19 7"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  rewrite: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1"/>',
  front: '<path d="M1 12h32"/><path class="front-fill" d="M5 12a3.5 3.5 0 0 1 7 0M15 12a3.5 3.5 0 0 1 7 0M25 12a3.5 3.5 0 0 1 7 0"/>',
  linkedin: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M8 10.5V16M8 7.75v.01M11.5 16v-5.5M11.5 13.2c0-1.6.9-2.7 2.3-2.7s2.2 1 2.2 2.7V16"/>',
  reels: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M3.5 8.5h17M9 3.5l2.4 5M14.6 3.5l2.4 5M10.6 12.3v4.4l3.7-2.2z"/>',
  x: '<path d="M5 4.5h3.6L19 19.5h-3.6zM18.6 4.5L12.9 11M11.1 13l-5.7 6.5"/>',
  youtube: '<rect x="2.75" y="5.5" width="18.5" height="13" rx="4"/><path d="M10.3 9.5v5l4.2-2.5z"/>',
  tiktok: '<path d="M13.5 3.5v11.2a3.3 3.3 0 1 1-3.3-3.3"/><path d="M13.5 3.5c.4 2.6 2.2 4.4 5 4.6"/>',
  instagram: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="3.8"/><path d="M16.9 7.1v.01"/>',
};

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* =========================================================================
   État
   ========================================================================= */

const state = {
  health: null,
  entries: [], // historique, le plus récent d'abord
  entriesLoaded: false,
  entriesError: null,
  calibration: null,
  settings: null,
  route: { view: "creer", id: null },
  entry: null, // prévision ouverte (#prevision/<id>)
  job: null, // { kind: angles|scripts|judge|rewrite, id, platform, t0, ... } — une seule génération à la fois
  error: null, // { kind, id, platform, message, ... }
  showAngles: false,
  activePf: null,
  rewritten: null, // { id, platform } : script réécrit dans cette session
  dropOnShow: null, // id dont le bulletin doit « tomber » au retour sur l'onglet
  healthLoaded: false,
  openHistory: new Set(),
  focusIdea: false,
};

/* =========================================================================
   Utilitaires
   ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "vars") for (const [name, val] of Object.entries(v)) node.style.setProperty(name, val);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat(2)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(name, cls = "ico", viewBox = "0 0 24 24") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", viewBox);
  if (cls) node.setAttribute("class", cls);
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  node.innerHTML = ICONS[name];
  return node;
}

const frontGlyph = () => svg("front", "front-glyph", "0 0 34 14");
const fmt = (n) => Number(n || 0).toLocaleString("fr-FR");
const fmtRatio = (r) => Number(r || 0).toLocaleString("fr-FR", { maximumFractionDigits: Number(r) >= 10 ? 0 : 1 });
const timeOf = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dateOf = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const countWords = (text) => (String(text).trim().match(/\S+/g) || []).length;
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

// Échelle thermique d'une note sur 100.
function heatOf(score) {
  if (score >= 85) return "hot";
  if (score >= 75) return "warm";
  if (score >= 60) return "tepid";
  if (score >= 40) return "mild";
  return "cold";
}

function tchip(value, heat, small = false) {
  if (value === null || value === undefined || !heat) {
    return el("span", { class: `t${small ? " t-sm" : ""} t-empty` }, "—");
  }
  return el("span", { class: `t${small ? " t-sm" : ""}`, "data-heat": heat, vars: { "--t": `var(--${heat})` } }, String(value));
}

function bar(score, heat) {
  return el("i", { vars: { "--v": `${Math.max(0, Math.min(100, score))}%`, "--t": `var(--${heat})` } });
}

function disclosure(summary, body, cls = "") {
  return el("details", { class: `disclosure ${cls}`.trim() },
    el("summary", {}, svg("chev", "ico chev"), summary),
    el("div", { class: "disclosure-body" }, body),
  );
}

function alertBox(title, message, actions = []) {
  return el("div", { class: "alert enter", role: "alert" },
    svg("alert"),
    el("div", {},
      el("strong", {}, title),
      el("p", {}, message),
      actions.length
        ? el("div", { class: "alert-actions" },
            actions.map(([label, fn, primary]) =>
              el("button", { type: "button", class: `btn${primary ? " btn-primary" : ""}`, onclick: fn }, label),
            ),
          )
        : null,
    ),
  );
}

let toastTimer = 0;
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-on"), 3200);
}

// Transition de vue native quand le navigateur la propose (sauf mouvement réduit).
function transition(update) {
  if (!document.startViewTransition || reduceMotion.matches || document.hidden) {
    update();
    return Promise.resolve();
  }
  return document.startViewTransition(update).updateCallbackDone.catch((err) => console.error(err));
}

function scrollTop() {
  window.scrollTo({ top: 0, behavior: "instant" });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el("textarea", { "aria-hidden": "true", readonly: true, class: "copy-buffer" });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (data?.error) throw new Error(data.error);
    // Réponse non JSON : coupure par l'hébergeur (Vercel renvoie 504 au-delà de 5 min).
    if (res.status === 504) {
      throw new Error("Délai dépassé (limite de 5 min par requête sur Vercel). Mets CLAUDE_EFFORT à « low » dans les variables Vercel, puis réessaie.");
    }
    throw new Error(`Erreur serveur (HTTP ${res.status}). Réessaie dans un instant.`);
  }
  if (data === null) throw new Error("Réponse illisible du serveur.");
  return data;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

/* =========================================================================
   Données de prévision
   ========================================================================= */

const isJudged = (score) => Boolean(score && BANDS[score.bande] && score.facteurs?.length);

function platformsOf(entry) {
  return (entry.brief?.platforms || []).filter((p) => entry.scripts?.[p]);
}

function bestOf(entry) {
  let best = null;
  for (const p of platformsOf(entry)) {
    const sc = entry.scripts[p].score;
    if (isJudged(sc) && (!best || sc.final > best.final)) best = { final: sc.final, heat: heatOf(sc.final) };
  }
  return best;
}

function sortEntries(list) {
  return [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

let pendingLoad = null;
let mutatedDuringLoad = null;

// Recharge l'historique. Une entrée mise à jour pendant le chargement garde sa version locale.
function loadEntries() {
  if (pendingLoad) return pendingLoad;
  mutatedDuringLoad = new Set();
  pendingLoad = api("/api/history")
    .then((data) => {
      const local = new Map(state.entries.map((e) => [e.id, e]));
      const fresh = (data.entries || []).map((e) =>
        mutatedDuringLoad.has(e.id) && local.has(e.id) ? local.get(e.id) : e,
      );
      for (const id of mutatedDuringLoad) {
        if (!fresh.some((e) => e.id === id) && local.has(id)) fresh.push(local.get(id));
      }
      state.entries = sortEntries(fresh);
      state.calibration = data.calibration || state.calibration;
      state.entriesLoaded = true;
      state.entriesError = null;
      if (state.entry?.id) state.entry = state.entries.find((e) => e.id === state.entry.id) || state.entry;
      renderRecents();
    })
    .catch((err) => {
      state.entriesError = err.message;
    })
    .finally(() => {
      pendingLoad = null;
      mutatedDuringLoad = null;
    });
  return pendingLoad;
}

function upsertEntry(entry) {
  if (!entry?.id) return;
  mutatedDuringLoad?.add(entry.id);
  const i = state.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) state.entries[i] = entry;
  else state.entries.unshift(entry);
  if (state.entry?.id === entry.id) state.entry = entry;
  renderRecents();
}

async function loadSettingsData() {
  try {
    state.settings = await api("/api/settings");
  } catch {
    state.settings = state.settings || { voice: "", medianViews: {} };
  }
  return state.settings;
}

/* =========================================================================
   Navigation
   ========================================================================= */

function parseHash() {
  const [view, id] = location.hash.replace(/^#/, "").split("/");
  if (view === "prevision" && id) return { view: "prevision", id: decodeURIComponent(id) };
  if (VIEW_TITLES[view]) return { view, id: null };
  return { view: "creer", id: null };
}

const viewName = (route) => (route.view === "prevision" ? "creer" : route.view);
const isViewingFlow = (id) => state.route.view === "prevision" && state.route.id === id;

function applyRoute({ focus = false } = {}) {
  const route = parseHash();
  state.route = route;
  const name = viewName(route);

  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("hidden", view.dataset.view !== name);
  }
  for (const link of document.querySelectorAll(".nav-link")) {
    if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.title = `${VIEW_TITLES[name]} · Amorce`;
  stopSticky();
  scrollTop();

  let target = null;
  if (name === "creer") {
    const flow = syncCreer();
    if (route.view === "prevision") openEntry(route.id, focus);
    else if (flow) renderFlow();
    if (!flow) {
      target = state.focusIdea ? $("#f-idea") : $("#creer-title");
      state.focusIdea = false;
    } else if (route.view !== "prevision") target = $(".flow-title");
  } else if (name === "idees") {
    loadIdeasView();
    target = $("#ideas-title");
  } else if (name === "radar") {
    renderRadarIdle();
    target = $("#radar-title");
  } else if (name === "historique") {
    loadHistoryView();
    target = $("#hist-title");
  } else if (name === "reglages") {
    loadSettingsView();
    target = $("#settings-title");
  }
  renderRecents();
  if (focus && target) {
    if (!target.hasAttribute("tabindex") && !/^(INPUT|TEXTAREA)$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
}

// Dans « Créer » : le brief, ou le parcours pendant le relevé des tendances.
function syncCreer() {
  const name = viewName(state.route);
  if (name !== "creer") return false;
  const flow = state.route.view === "prevision" || state.job?.kind === "angles";
  $("#step-brief").classList.toggle("hidden", flow);
  $("#step-flow").classList.toggle("hidden", !flow);
  return flow;
}

function go(hash) {
  if (location.hash === hash) applyRoute({ focus: true });
  else location.hash = hash;
}

async function openEntry(id, focus) {
  if (state.entry?.id !== id) {
    let found = state.entries.find((e) => e.id === id);
    if (!found) {
      $("#flow-head").replaceChildren();
      $("#flow-body").replaceChildren(
        el("div", { class: "card loading-card", "aria-busy": "true" },
          el("div", { class: "skeleton sk-title" }),
          el("div", { class: "skeleton sk-line" }),
          el("div", { class: "skeleton sk-line" }),
        ),
      );
      await loadEntries();
      if (state.route.view !== "prevision" || state.route.id !== id) return;
      found = state.entries.find((e) => e.id === id);
    }
    if (!found) {
      $("#flow-body").replaceChildren(
        alertBox("Prévision introuvable.", state.entriesError || "Elle a peut-être été générée sur un stockage temporaire, effacé depuis.", [
          ["Nouvelle prévision", () => go("#creer"), true],
        ]),
      );
      return;
    }
    state.entry = found;
    state.showAngles = false;
    state.activePf = null;
    if (state.rewritten?.id !== id) state.rewritten = null;
  }
  document.title = `${state.entry.brief.idea.slice(0, 48)} · Amorce`;
  renderFlow();
  if (focus) $(".flow-title")?.focus({ preventScroll: true });
}

/* =========================================================================
   Brief
   ========================================================================= */

const DRAFT_KEY = "amorce.brief";

function readDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null") || {};
  } catch {
    return {};
  }
}

function saveDraft({ niche, audience, goal, platforms }) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ niche, audience, goal, platforms }));
  } catch {
    /* stockage navigateur indisponible : simple confort perdu */
  }
}

function renderPlatformOptions(selected) {
  $("#platform-options").replaceChildren(
    ...PLATFORMS.map((p) =>
      el("label", { class: "pf-toggle" },
        el("input", { type: "checkbox", name: "platform", value: p, checked: selected.includes(p) }),
        el("span", {},
          el("span", { class: "check", "aria-hidden": "true" }, svg("check", "")),
          svg(PF[p].icon, "ico pf-ico"),
          PF[p].name,
        ),
      ),
    ),
  );
}

function readBrief() {
  return {
    idea: $("#f-idea").value.trim(),
    niche: $("#f-niche").value.trim(),
    audience: $("#f-audience").value.trim(),
    goal: $("#f-goal").value,
    platforms: [...document.querySelectorAll('input[name="platform"]:checked')].map((c) => c.value),
  };
}

function goalLabel(goal) {
  const option = [...$("#f-goal").options].find((o) => o.value === goal);
  return option ? option.textContent : goal;
}

function setFieldError(fieldEl, errorEl, on) {
  if (fieldEl) fieldEl.dataset.invalid = String(on);
  errorEl.hidden = !on;
}

function initBrief() {
  const draft = readDraft();
  renderPlatformOptions(Array.isArray(draft.platforms) && draft.platforms.length ? draft.platforms : ["linkedin", "reels"]);
  if (draft.niche) $("#f-niche").value = draft.niche;
  if (draft.audience) $("#f-audience").value = draft.audience;
  if (draft.goal && [...$("#f-goal").options].some((o) => o.value === draft.goal)) $("#f-goal").value = draft.goal;

  const form = $("#brief-form");
  const idea = $("#f-idea");
  idea.setAttribute("aria-describedby", "f-idea-error");
  idea.addEventListener("input", () => setFieldError(idea.closest(".field"), $("#f-idea-error"), false));
  $("#platform-options").addEventListener("change", () => setFieldError(null, $("#f-platform-error"), false));
  form.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const brief = readBrief();
    const missingIdea = !brief.idea;
    const missingPf = !brief.platforms.length;
    setFieldError(idea.closest(".field"), $("#f-idea-error"), missingIdea);
    setFieldError(null, $("#f-platform-error"), missingPf);
    if (missingIdea) return idea.focus();
    if (missingPf) return $('input[name="platform"]').focus();
    saveDraft(brief);
    startForecast(brief);
  });
}

function showBriefAlert(node) {
  const box = $("#brief-alert");
  box.replaceChildren(...(node ? [node] : []));
}

/* =========================================================================
   Générations
   ========================================================================= */

function busyToast() {
  toast("Une génération est déjà en cours : patiente jusqu'à la fin.");
}

function pickSignals(trends) {
  const lists = Object.values(trends?.sources || {}).map((s) => s.items.map((it) => ({ title: it.title, source: s.label })));
  const out = [];
  for (let i = 0; out.length < 6 && lists.some((l) => l[i]); i++) {
    for (const list of lists) if (list[i] && out.length < 6) out.push(list[i]);
  }
  return out;
}

async function startForecast(brief) {
  if (state.job) return busyToast();
  showBriefAlert(null);
  state.error = null;
  state.job = { kind: "angles", brief, t0: Date.now(), stage: "trends", signals: [], signalCount: 0 };
  const onBrief = state.route.view === "creer";
  if (onBrief) {
    await transition(() => {
      syncCreer();
      renderFlow();
      scrollTop();
    });
    $(".flow-title")?.focus({ preventScroll: true });
  }

  // 1. Relevé des tendances, affiché en direct (la même requête est ensuite servie par le cache).
  const query = [brief.idea, brief.niche].filter(Boolean).join(" ").slice(0, 120).trim();
  try {
    const trends = await api(`/api/trends?q=${encodeURIComponent(query)}`);
    state.job.signals = pickSignals(trends);
    state.job.signalCount = Object.values(trends.sources || {}).reduce((n, s) => n + s.items.length, 0);
  } catch {
    state.job.signals = [];
  }
  state.job.stage = "angles";
  if (state.route.view === "creer") renderFlow();

  // 2. Angles proposés par l'IA.
  try {
    const entry = await post("/api/angles", brief);
    state.job = null;
    upsertEntry(entry);
    if (state.route.view === "creer") {
      state.entry = entry;
      state.showAngles = false;
      state.activePf = null;
      history.pushState(null, "", `#prevision/${entry.id}`);
      state.route = { view: "prevision", id: entry.id };
      document.title = `${entry.brief.idea.slice(0, 48)} · Amorce`;
      await transition(() => {
        syncCreer();
        renderFlow();
        scrollTop();
      });
      renderRecents();
      toast("Angles prêts : choisis celui à écrire.");
    } else {
      toast("Tes angles sont prêts : retrouve-les dans Récents.");
      if (state.route.view === "creer") syncCreer();
    }
  } catch (err) {
    state.job = null;
    if (viewName(state.route) === "creer" && state.route.view === "creer") {
      await transition(() => {
        syncCreer();
        scrollTop();
      });
    }
    showBriefAlert(
      alertBox("La prévision n'a pas abouti.", err.message, [["Réessayer", () => startForecast(brief), true]]),
    );
    if (state.route.view !== "creer") toast("La prévision n'a pas abouti : le détail est dans « Créer ».");
  }
}

async function pickAngle(index) {
  if (state.job) return busyToast();
  const entry = state.entry;
  const angle = entry?.angles?.angles?.[index];
  if (!angle) return;
  state.error = null;
  state.job = { kind: "scripts", id: entry.id, t0: Date.now(), angle };
  await transition(() => {
    renderFlow();
    scrollTop();
  });
  try {
    const updated = await post("/api/scripts", { id: entry.id, angleIndex: index });
    state.job = null;
    upsertEntry(updated);
    if (state.rewritten?.id === entry.id) state.rewritten = null;
    if (isViewingFlow(entry.id)) {
      state.showAngles = false;
      state.activePf = null;
      await transition(() => {
        renderFlow();
        scrollTop();
      });
    }
  } catch (err) {
    state.job = null;
    state.error = { kind: "scripts", id: entry.id, angleIndex: index, message: err.message };
    state.showAngles = true;
    if (isViewingFlow(entry.id)) renderFlow();
    else toast("L'écriture des scripts n'a pas abouti.");
    return;
  }
  await runJudge(entry.id);
}

async function runJudge(id) {
  if (state.job) return busyToast();
  if (state.error?.id === id) state.error = null;
  state.job = { kind: "judge", id, t0: Date.now() };
  if (isViewingFlow(id)) renderFlow();
  try {
    const updated = await post("/api/judge", { id });
    state.job = null;
    upsertEntry(updated);
    if (isViewingFlow(id)) {
      // Onglet en arrière-plan : le bulletin tombera au retour de l'utilisateur.
      if (document.hidden) {
        renderFlow();
        state.dropOnShow = id;
      } else renderFlow({ drop: true });
    }
    const summary = platformsOf(updated)
      .filter((p) => isJudged(updated.scripts[p].score))
      .map((p) => `${PF[p].name} ${updated.scripts[p].score.final} (${BANDS[updated.scripts[p].score.bande].label})`)
      .join(", ");
    toast(`Bulletin prêt : ${summary}.`);
  } catch (err) {
    state.job = null;
    state.error = { kind: "judge", id, message: err.message };
    if (isViewingFlow(id)) renderFlow();
    else toast("L'évaluation n'a pas abouti.");
  }
}

async function rewrite(platform) {
  if (state.job) return busyToast();
  const entry = state.entry;
  const before = entry.scripts[platform].score?.final;
  state.error = null;
  state.job = { kind: "rewrite", id: entry.id, platform, t0: Date.now() };
  if (isViewingFlow(entry.id)) renderFlow();
  try {
    const updated = await post("/api/rewrite", { id: entry.id, platform });
    state.job = null;
    upsertEntry(updated);
    state.rewritten = { id: entry.id, platform };
    const after = updated.scripts[platform].score?.final;
    if (isViewingFlow(entry.id)) {
      state.activePf = platform;
      renderFlow({ rewrote: platform, from: before });
    }
    toast(`Script ${PF[platform].name} réécrit : ${before ?? "—"} → ${after ?? "—"}.`);
  } catch (err) {
    state.job = null;
    state.error = { kind: "rewrite", id: entry.id, platform, message: err.message };
    if (isViewingFlow(entry.id)) renderFlow();
    else toast("La réécriture n'a pas abouti.");
  }
}

/* =========================================================================
   Parcours : en-tête
   ========================================================================= */

function stepsList(entry, draftRun) {
  const judged = platformsOf(entry).length > 0 && platformsOf(entry).every((p) => isJudged(entry.scripts[p].score));
  const job = state.job;
  let done;
  if (draftRun) {
    done = [true, job.stage !== "trends", false, false, false];
  } else {
    const writing = job?.kind === "scripts" && job.id === entry.id;
    done = [true, true, Boolean(entry.scripts) || writing, Boolean(entry.scripts) && !writing, judged && !writing];
  }
  const names = ["Idée", "Tendances", "Angle", "Scripts", "Prévision"];
  const first = done.indexOf(false);
  const current = first < 0 ? names.length - 1 : first;
  return el("div", { class: "route-wrap" },
    el("ol", { class: "route", "aria-label": "Progression" },
      names.map((name, i) => {
        const cls = [done[i] ? "done" : "todo", i === current ? "is-current" : null].filter(Boolean).join(" ");
        return el("li", { class: cls, "aria-current": i === current ? "step" : null },
          el("span", { class: "st-dot", "aria-hidden": "true" }),
          el("span", { class: "st-label" }, name, done[i] ? el("span", { class: "sr-only" }, " (fait)") : null),
        );
      }),
    ),
    el("span", { class: "route-now", "aria-hidden": "true" }, `${current + 1}/${names.length} · ${names[current]}`),
  );
}

function flowHead(entry, draftRun) {
  const brief = entry.brief;
  const bits = [];
  if (brief.niche) bits.push(el("span", {}, brief.niche));
  if (entry.chosenAngle && entry.scripts && !state.showAngles) {
    bits.push(el("span", {}, "Angle ", el("q", {}, entry.chosenAngle.titre)));
  } else {
    if (brief.goal) bits.push(el("span", {}, `Objectif : ${goalLabel(brief.goal).toLowerCase()}`));
    bits.push(el("span", {}, brief.platforms.map((p) => PF[p].name).join(" · ")));
  }
  const meta = el("div", { class: "flow-meta" });
  if (entry.demo) meta.append(el("span", { class: "tag-demo" }, "Exemple"));
  bits.forEach((b, i) => {
    if (i) meta.append(el("span", { class: "meta-sep", "aria-hidden": "true" }));
    meta.append(b);
  });
  const front = entry.angles?.tendances_retenues?.[0];
  if (front && entry.scripts && !state.showAngles) {
    meta.append(
      el("span", { class: "front-pill", title: "Front de tendance retenu" },
        frontGlyph(),
        el("span", {}, el("strong", {}, front.titre), ` · ${front.source}`),
      ),
    );
  }

  if (!draftRun) {
    const actions = el("div", { class: "head-actions" });
    const hasAngles = Boolean(entry.angles?.angles?.length);
    if (entry.scripts && hasAngles && !state.job) {
      actions.append(
        state.showAngles
          ? el("button", { type: "button", class: "btn btn-quiet", onclick: () => toggleAngles(false) }, svg("back"), "Revenir au bulletin")
          : el("button", { type: "button", class: "btn btn-quiet", onclick: () => toggleAngles(true) }, "Changer d'angle"),
      );
    }
    actions.append(el("button", { type: "button", class: "btn btn-quiet", onclick: newIdea }, svg("plus"), "Nouvelle idée"));
    return [el("h1", { class: "flow-title", tabindex: "-1" }, brief.idea), actions, meta, stepsList(entry, draftRun)];
  }

  return [el("h1", { class: "flow-title", tabindex: "-1" }, brief.idea), meta, stepsList(entry, draftRun)];
}

function toggleAngles(on) {
  transition(() => {
    state.showAngles = on;
    renderFlow();
    scrollTop();
  });
}

function newIdea() {
  $("#f-idea").value = "";
  state.focusIdea = true;
  go("#creer");
}

/* =========================================================================
   Parcours : corps
   ========================================================================= */

function renderFlow(opts = {}) {
  const draftRun = state.route.view === "creer" && state.job?.kind === "angles";
  const entry = draftRun ? { brief: state.job.brief } : state.entry;
  if (!entry) return;
  stopSticky();
  const job = !draftRun && state.job?.id === entry.id ? state.job : null;
  const hadFocus = $("#step-flow").contains(document.activeElement);

  $("#flow-head").replaceChildren(...flowHead(entry, draftRun));
  let content;
  if (draftRun) content = runPanelAngles(state.job);
  else if (job?.kind === "scripts") content = runPanelScripts(entry, job);
  else if (entry.scripts && !state.showAngles) content = bulletinView(entry, job, opts);
  else content = anglesView(entry);
  $("#flow-body").replaceChildren(...[content].flat());

  // Le contenu remplacé emportait le focus : on le pose sur un repère proche.
  if (hadFocus && (!document.activeElement || document.activeElement === document.body)) {
    const target = $("#flow-body [data-focus]") || $(".flow-title");
    target?.focus({ preventScroll: true });
  }
}

function clockText() {
  if (!state.job) return "0:00";
  const s = Math.floor((Date.now() - state.job.t0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function runPanel({ title, sub, stages, side }) {
  return el("section", { class: "run card enter", "aria-labelledby": "run-title" },
    el("div", {},
      el("h2", { class: "run-title", id: "run-title", tabindex: "-1", "data-focus": "" }, title),
      el("p", { class: "run-sub" }, sub),
      el("ol", { class: "run-stages", "aria-live": "polite" },
        stages.map((st) =>
          el("li", { class: "run-stage", "data-state": st.state },
            el("span", { class: "dot", "aria-hidden": "true" }, st.state === "done" ? svg("check", "") : null),
            el("span", {}, st.label),
            el("span", { class: "when" }, st.when || ""),
          ),
        ),
      ),
    ),
    el("div", { class: "run-side" },
      el("span", { class: "label" }, "Temps écoulé"),
      el("div", { class: "run-clock", "data-clock": "", "aria-hidden": "true" }, clockText()),
      side,
    ),
  );
}

function runPanelAngles(job) {
  const trendsDone = job.stage !== "trends";
  const stages = [
    {
      label: "Relevé des tendances",
      state: trendsDone ? "done" : "active",
      when: trendsDone ? (job.signalCount ? plural(job.signalCount, "signal", "signaux") : "sources muettes") : "en cours",
    },
    { label: "Choix des angles", state: trendsDone ? "active" : "todo", when: trendsDone ? "en cours" : "" },
    { label: "Écriture des scripts", state: "todo", when: "après ton choix" },
  ];
  let signals;
  if (!trendsDone) {
    signals = el("div", { class: "live-signals", "aria-hidden": "true" },
      [0, 1, 2, 3].map(() => el("div", { class: "skeleton sk-line" })),
    );
  } else if (!job.signals.length) {
    signals = el("p", {}, "Aucune source n'a répondu : les angles s'appuieront sur ton brief.");
  } else {
    signals = el("ul", { class: "live-signals" },
      job.signals.map((s, i) =>
        el("li", { class: "live-signal", vars: { "--i": i } }, frontGlyph(), el("b", {}, s.title), el("span", { class: "src" }, s.source)),
      ),
    );
  }
  return runPanel({
    title: "Prévision en cours",
    sub: "Amorce relève ce qui monte autour de ton idée, puis cherche les angles qui ont une raison de marcher aujourd'hui.",
    stages,
    side: [
      el("p", {}, "Compte 1 à 2 minutes. Tu peux changer d'onglet : la prévision continue."),
      el("span", { class: "label" }, "Signaux relevés"),
      signals,
    ],
  });
}

function runPanelScripts(entry, job) {
  const names = entry.brief.platforms.map((p) => PF[p].name).join(", ");
  return runPanel({
    title: "Écriture des scripts",
    sub: `Un script par plateforme, écrit pour son format à partir de l'angle « ${job.angle.titre} ».`,
    stages: [
      { label: "Angle choisi", state: "done" },
      { label: "Écriture des scripts", state: "active", when: names },
      { label: "Évaluation critique", state: "todo", when: "ensuite" },
    ],
    side: [
      el("p", {}, "Compte 1 à 2 minutes. L'évaluation suit : tu pourras lire tes scripts pendant qu'elle tourne."),
      el("span", { class: "label" }, "Accroche retenue"),
      el("p", { class: "run-hook" }, `« ${job.angle.accroche} »`),
    ],
  });
}

/* ---------- Tendances & angles ---------- */

function errorsLine(trends) {
  const errors = trends?.errors || [];
  if (!errors.length) return null;
  return el("p", { class: "sources-missing" },
    `Sans réponse aujourd'hui : ${errors.map((e) => e.source).join(", ")}.`,
  );
}

function sourceItem(item, cls) {
  const label = item.url
    ? el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.title, el("span", { class: "sr-only" }, " (nouvel onglet)"))
    : el("span", {}, item.title);
  return el("li", { class: cls }, label, el("span", { class: "sig" }, item.signal || ""));
}

function frontsCard(entry) {
  const retained = entry.angles?.tendances_retenues || [];
  const sources = Object.values(entry.trends?.sources || {});
  const total = sources.reduce((n, s) => n + s.items.length, 0);
  const when = entry.trends?.fetchedAt ? ` · relevés à ${timeOf(entry.trends.fetchedAt)}` : "";
  return el("section", { class: "fronts card", "aria-labelledby": "fronts-title" },
    el("div", { class: "fronts-head" },
      el("h2", { class: "section-title", id: "fronts-title" }, "Fronts de tendance retenus"),
      el("span", { class: "hint" },
        total ? `${plural(total, "signal", "signaux")} sur ${plural(sources.length, "source", "sources")}${when}` : "Aucune source n'a répondu",
      ),
    ),
    retained.length
      ? el("ul", { class: "fronts-list" },
          retained.map((t) =>
            el("li", { class: "front-card" }, frontGlyph(), el("b", {}, t.titre), el("p", {}, t.pourquoi), el("small", {}, t.source)),
          ),
        )
      : el("p", { class: "sources-missing" }, "Aucune tendance ne recoupe directement ton idée : les angles s'appuient sur ton brief."),
    total
      ? disclosure(`Voir les ${plural(total, "signal brut", "signaux bruts")}`,
          el("div", { class: "sources" },
            sources.map((s) =>
              el("div", { class: "source" }, el("h4", {}, s.label), el("ul", {}, s.items.slice(0, 8).map((it) => sourceItem(it)))),
            ),
          ),
        )
      : null,
    errorsLine(entry.trends),
  );
}

function angleCard(entry, angle, index, recommended) {
  const heat = heatOf(angle.score_tendance);
  const current = entry.scripts && entry.chosenAngle?.titre === angle.titre;
  const tag = current ? "Angle actuel" : recommended ? "Le plus porté" : null;
  return el("article", { class: "angle enter", vars: { "--i": index } },
    el("div", { class: "angle-head" },
      el("h3", {}, angle.titre),
      tag ? el("span", { class: "cur-tag" }, tag) : null,
    ),
    el("p", { class: "hook" }, `« ${angle.accroche} »`),
    el("p", { class: "why" }, angle.justification),
    el("div", { class: "angle-foot" },
      el("span", { class: "fit" },
        el("span", { class: "angle-type" }, TYPE_LABELS[angle.type] || angle.type),
        el("span", { class: "meta-sep", "aria-hidden": "true" }),
        "Tendance",
        el("span", { class: "fit-bar", "aria-hidden": "true" }, bar(angle.score_tendance, heat)),
        tchip(angle.score_tendance, heat, true),
      ),
      el("button", {
        type: "button",
        class: `btn${recommended ? " btn-primary" : ""}`,
        disabled: Boolean(state.job),
        "aria-label": `Écrire l'angle « ${angle.titre} »`,
        onclick: () => pickAngle(index),
      }, "Écrire cet angle", svg("arrow")),
    ),
  );
}

function anglesView(entry) {
  const out = [];
  if (state.error?.kind === "scripts" && state.error.id === entry.id) {
    const idx = state.error.angleIndex;
    out.push(alertBox("L'écriture des scripts n'a pas abouti.", state.error.message, [["Réessayer", () => pickAngle(idx), true]]));
  }
  out.push(frontsCard(entry));
  const angles = entry.angles?.angles || [];
  out.push(el("h2", { class: "angles-title", id: "angles-title", tabindex: "-1", "data-focus": "" }, "Choisis l'angle à écrire"));
  if (entry.scripts) {
    out.push(el("p", { class: "angles-note" }, "Écrire un autre angle remplace les scripts actuels de cette prévision."));
  }
  if (!angles.length) {
    out.push(el("p", { class: "radar-empty" }, "Aucun angle n'a été proposé pour cette idée."));
    return out;
  }
  const best = angles.reduce((b, a, i) => (a.score_tendance > angles[b].score_tendance ? i : b), 0);
  out.push(el("div", { class: "angles" }, angles.map((a, i) => angleCard(entry, a, i, i === best))));
  return out;
}

/* ---------- Bulletin ---------- */

function bulletinView(entry, job, opts) {
  const pfs = platformsOf(entry);
  if (!pfs.includes(state.activePf)) state.activePf = pfs[0];
  const tabs = el("div", { class: "pf-tabs", role: "tablist", "aria-label": "Plateformes" },
    pfs.map((p) => tabButton(entry, p)),
    el("span", { class: "tabs-hint" }, "Potentiel relatif à ta niche, pas une promesse de vues"),
  );
  tabs.addEventListener("keydown", onTabsKey);
  const panel = el("section", { class: "bulletin", id: "bulletin-panel", role: "tabpanel" });
  const wrap = el("div", { class: "bulletin-wrap" }, tabs, panel);
  // Le panneau doit être dans le document pour observer la barre collante.
  queueMicrotask(() => fillPanel(panel, entry, state.activePf, job, opts));
  return wrap;
}

function tabButton(entry, p) {
  const sc = entry.scripts[p].score || {};
  const judged = isJudged(sc);
  const selected = p === state.activePf;
  return el("button", {
    type: "button",
    role: "tab",
    class: "pf-tab",
    id: `tab-${p}`,
    "data-pf": p,
    "aria-selected": String(selected),
    "aria-controls": "bulletin-panel",
    tabindex: selected ? "0" : "-1",
    "aria-label": judged
      ? `${PF[p].name} : potentiel ${sc.final} sur 100, ${BANDS[sc.bande].label}`
      : `${PF[p].name} : évaluation en attente`,
    "data-focus": selected ? "" : null,
    onclick: () => selectTab(p),
  },
    svg(PF[p].icon, "ico pf-ico"),
    PF[p].name,
    judged ? tchip(sc.final, heatOf(sc.final), true) : tchip(null, null, true),
  );
}

function onTabsKey(ev) {
  const tabs = [...ev.currentTarget.querySelectorAll(".pf-tab")];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  let next = null;
  if (ev.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
  else if (ev.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
  else if (ev.key === "Home") next = tabs[0];
  else if (ev.key === "End") next = tabs[tabs.length - 1];
  if (!next) return;
  ev.preventDefault();
  selectTab(next.dataset.pf, true);
}

function selectTab(p, focus = false) {
  const entry = state.entry;
  if (!entry?.scripts?.[p]) return;
  for (const tab of document.querySelectorAll(".pf-tab")) {
    const on = tab.dataset.pf === p;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  if (state.activePf === p) return;
  state.activePf = p;
  const job = state.job?.id === entry.id ? state.job : null;
  fillPanel($("#bulletin-panel"), entry, p, job, {});
}

function fillPanel(panel, entry, p, job, opts) {
  if (!panel?.isConnected) return;
  panel.setAttribute("aria-labelledby", `tab-${p}`);
  panel.replaceChildren(verdictBlock(entry, p, job), bodyBlock(entry, p, job));
  if (opts.drop) dropBulletin(panel);
  else if (opts.rewrote === p) dropRewrite(panel, opts.from);
  observeSticky(panel.querySelector(".verdict"), entry, p, job);
}

function verdictNodes(text) {
  const m = String(text).match(/^(.{8,90}?)(\s*[;:—–]\s+)(.+)$/u);
  if (!m) return [text];
  return [el("strong", {}, m[1]), m[2], m[3]];
}

function derivedVerdict(sc) {
  const fs = [...(sc.facteurs || [])].sort((a, b) => b.score - a.score);
  if (fs.length < 2) return "Évaluation disponible : détaille les facteurs ci-dessous.";
  const strong = FACTOR_LABELS[fs[0].nom] || fs[0].nom;
  const weak = (FACTOR_LABELS[fs.at(-1).nom] || fs.at(-1).nom).toLowerCase();
  return `${strong} solide ; ${weak} à renforcer en priorité.`;
}

function scaleBlock(band, observed) {
  const idx = band ? band.idx : -1;
  const obs = observed ? observed.idx : -1;
  return el("div", { class: "scale-block" },
    el("span", { class: "label" }, "Échelle de potentiel"),
    el("div", {
      class: "scale",
      role: "img",
      "aria-label": band
        ? `Échelle de Bas 50 % à Top 10 % : prévu ${band.label}${observed ? `, relevé ${observed.label}` : ""}`
        : "Position sur l'échelle : à venir",
    },
      el("div", { class: "scale-track" },
        BAND_ORDER.map((k, i) => el("span", { class: i === idx ? "cur" : null, vars: { "--t": `var(--${BANDS[k].heat})` } })),
      ),
      el("div", { class: "scale-needle", hidden: idx < 0, vars: { transform: `translateX(${Math.max(idx, 0) * 100}%)` } }),
      obs >= 0 ? el("div", { class: "scale-obs", vars: { transform: `translateX(${obs * 100}%)` } }) : null,
    ),
    el("div", { class: "scale-labels", "aria-hidden": "true" },
      BAND_ORDER.map((k, i) => el("span", { class: i === idx ? "cur" : null }, BANDS[k].label)),
    ),
  );
}

function confidenceRow(level) {
  const n = CONFIDENCE[level] || 0;
  return el("div", { class: "meta-row" },
    el("span", { class: "label" }, "Indice de confiance"),
    el("span", { class: "conf-dots", "aria-hidden": "true" }, [1, 2, 3, 4, 5].map((i) => el("i", { class: i <= n ? "f" : null }))),
    level ? [el("b", {}, `${n}/5`), ` ${level}`] : el("span", {}, "à venir"),
  );
}

function matchBadge(predicted, observed) {
  if (!BANDS[predicted] || !BANDS[observed]) return null;
  const gap = Math.abs(BANDS[predicted].idx - BANDS[observed].idx);
  if (gap === 0) return el("span", { class: "match ok" }, "Juste");
  if (gap === 1) return el("span", { class: "match near" }, "À une bande");
  return el("span", { class: "match miss" }, `Écart de ${gap} bandes`);
}

// Prévu → relevé sur une ligne ; le relevé est aussi marqué sur l'échelle (pastille creuse).
function observedRow(entry, p, sc) {
  const real = entry.realStats?.[p];
  const row = el("div", { class: "meta-row" },
    el("span", { class: "label" }, "Prévu · relevé"),
    el("b", {}, isJudged(sc) ? BANDS[sc.bande].label : "—"),
    svg("arrow", "ico arrow"),
  );
  if (real && BANDS[real.band]) {
    row.append(
      el("span", { class: "observed", title: `${fmt(real.views)} vues, ×${fmtRatio(real.ratio)} ta médiane` },
        el("span", { class: "obs-key", "aria-hidden": "true" }),
        el("span", { class: "sr-only" }, "relevé "),
        el("b", {}, BANDS[real.band].label),
      ),
      isJudged(sc) ? matchBadge(sc.bande, real.band) : null,
    );
  } else {
    row.append(el("a", { class: "pending", href: "#historique", title: "À saisir dans l'Historique après publication" }, "relevé à venir"));
  }
  return row;
}

function verdictBlock(entry, p, job) {
  const sc = entry.scripts[p].score || {};
  const judged = isJudged(sc);
  const band = judged ? BANDS[sc.bande] : null;
  const judging = job?.kind === "judge";
  const verdict = el("div", { class: "verdict", vars: { "--band": band ? `var(--${band.heat})` : "var(--line-strong)" } });

  verdict.append(
    el("div", {
      class: "temp",
      role: "img",
      "data-heat": judged ? heatOf(sc.final) : "pending",
      vars: judged ? { "--t": `var(--${heatOf(sc.final)})` } : null,
      "aria-label": judged ? `Potentiel ${sc.final} sur 100` : "Potentiel pas encore évalué",
    },
      el("b", { "aria-hidden": "true" }, judged ? String(sc.final) : "—"),
      el("span", { "aria-hidden": "true" }, judged ? "/ 100" : judging ? "en cours" : "à évaluer"),
    ),
  );

  if (judged) {
    verdict.append(
      el("div", { class: "verdict-main" },
        el("h2", { class: "band-title" }, band.title),
        el("p", { class: "verdict-say" }, verdictNodes(sc.verdict || derivedVerdict(sc))),
      ),
    );
  } else if (judging) {
    verdict.append(
      el("div", { class: "verdict-main" },
        el("h2", { class: "band-title" }, "Évaluation en cours…"),
        el("p", { class: "verdict-say" },
          el("strong", {}, "Tes scripts sont prêts"),
          " : lis-les pendant qu'Amorce les relit comme un éditeur exigeant.",
        ),
        el("p", { class: "judge-clock", "aria-hidden": "true" }, "Temps écoulé", el("b", { "data-clock": "" }, clockText())),
      ),
    );
  } else {
    const heur = sc.heuristique?.global;
    verdict.append(
      el("div", { class: "verdict-main" },
        el("h2", { class: "band-title" }, "Prévision incomplète"),
        el("p", { class: "verdict-say" },
          heur !== undefined ? `Seuls les codes du format sont notés (${heur}/100) : l'évaluation critique n'a pas abouti.` : "L'évaluation critique n'a pas encore tourné.",
        ),
      ),
    );
  }

  verdict.append(
    el("div", { class: "verdict-meta" }, scaleBlock(band, BANDS[entry.realStats?.[p]?.band]), confidenceRow(judged ? sc.confiance : null), observedRow(entry, p, sc)),
  );

  if (!judged && !judging) {
    const failed = state.error?.kind === "judge" && state.error.id === entry.id ? state.error.message : null;
    verdict.append(
      el("div", { class: "partial-note", role: failed ? "alert" : null },
        el("span", {}, failed ? `L'évaluation a échoué : ${failed}` : "Lance l'évaluation pour obtenir la bande, la confiance et les améliorations."),
        el("button", { type: "button", class: "btn btn-primary", disabled: Boolean(state.job), onclick: () => runJudge(entry.id) },
          failed ? "Relancer l'évaluation" : "Lancer l'évaluation"),
      ),
    );
  }
  return verdict;
}

/* ---------- Rendu des scripts ---------- */

const CAPTION_RE = /^\s*(?:l[ée]gende|caption)\s*[:\-]/im;
const HASHTAG_LINE_RE = /^(?:#[\p{L}\p{N}_]+[\s,·]*)+$/u;
const LIST_RE = /^(\d{1,2}[.)]|[-–—•·→▪✓✔✅*👉]|➡\uFE0F?)\s+(.+)$/u;
const TWEET_SPLIT_RE = /\n\s*\n|\n(?=\d{1,2}\/(?:\d{1,2})?\s)/;

function splitTweets(text) {
  return String(text).split(TWEET_SPLIT_RE).map((t) => t.trim()).filter(Boolean);
}

// Sépare les lignes faites uniquement de hashtags et les fusionne avec la liste fournie.
function extractHashtags(text, extra = []) {
  const found = [];
  const kept = String(text)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t && HASHTAG_LINE_RE.test(t)) {
        found.push(...t.match(/#[\p{L}\p{N}_]+/gu));
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
  // Un hashtag déjà écrit dans le texte n'est pas répété en pied de script.
  const inText = new Set((kept.match(/#[\p{L}\p{N}_]+/gu) || []).map((h) => h.toLowerCase()));
  const seen = new Set();
  const tags = [...found, ...extra.map((h) => `#${String(h).replace(/^#+/, "").trim()}`)]
    .filter((h) => h.length > 1 && !inText.has(h.toLowerCase()) && !seen.has(h.toLowerCase()) && seen.add(h.toLowerCase()));
  return { text: kept, tags };
}

function inline(parent, line, opts) {
  if (!opts.directions) {
    parent.append(line);
    return;
  }
  const re = /\[([^\]]+)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) parent.append(line.slice(last, m.index));
    parent.append(el("span", { class: "direction" }, m[1].trim()));
    last = re.lastIndex;
  }
  if (last < line.length) parent.append(line.slice(last));
}

function isHeading(line) {
  if (/^#{1,3}\s+\S/.test(line)) return true;
  if (line.length > 70 || /[.!?…]$/.test(line)) return false;
  return /^(?:\[?\d{1,2}:\d{2}|(?:hook|intro(?:duction)?|accroche|chapitre|partie|section|conclusion|outro|cta)\b)/i.test(line);
}

function paragraphs(text, opts = {}) {
  const out = [];
  for (const block of String(text).split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    let buf = [];
    let lastItem = null;
    const flush = () => {
      if (!buf.length) return;
      const p = el("p");
      buf.forEach((line, i) => {
        if (i) p.append(el("br"));
        inline(p, line, opts);
      });
      out.push(p);
      buf = [];
    };
    for (const line of lines) {
      const m = line.match(LIST_RE);
      if (m) {
        flush();
        const marker = /^\d/.test(m[1]) ? m[1].replace(")", ".") : /^[-*]$/.test(m[1]) ? "–" : m[1];
        lastItem = el("p", { class: "li" }, el("b", { "aria-hidden": "true" }, marker));
        inline(lastItem, m[2], opts);
        out.push(lastItem);
      } else if (opts.headings && isHeading(line)) {
        flush();
        lastItem = null;
        out.push(el("p", { class: "post-h" }, el("strong", {}, line.replace(/^#{1,3}\s*/, ""))));
      } else if (lastItem && !buf.length) {
        lastItem.append(el("br"));
        inline(lastItem, line, opts);
      } else {
        buf.push(line);
      }
    }
    flush();
  }
  return out;
}

function measure(p, script) {
  const text = script.contenu || "";
  if (p === "linkedin") return `${fmt(text.length)} caractères`;
  if (p === "reels") {
    const voice = text.split(CAPTION_RE)[0].replace(/\[[^\]]*\]/g, "");
    return `≈ ${Math.max(5, Math.round(countWords(voice) / 2.5))} s de voix off`;
  }
  if (p === "x") return plural(splitTweets(text).length, "tweet", "tweets");
  const minutes = Math.max(1, Math.round(countWords(text.replace(/\[[^\]]*\]/g, "")) / 150));
  return `≈ ${minutes} min de vidéo`;
}

function scriptContent(p, script) {
  const { text, tags } = extractHashtags(script.contenu || "", script.hashtags || []);
  const nodes = [];
  const title = (script.titre || "").trim();
  if (title && (p === "youtube" || !text.startsWith(title))) nodes.push(el("h3", { class: "script-title" }, title));

  if (p === "x") {
    const tweets = splitTweets(text);
    nodes.push(
      el("ol", { class: "tweets" },
        tweets.map((t, i) => {
          const over = t.length > 280;
          return el("li", { class: "tweet" },
            el("span", { class: "tweet-n" }, `${i + 1}/${tweets.length}`),
            el("div", {},
              el("p", {}, t.replace(/^\d{1,2}\/(?:\d{1,2})?\s*/, "")),
              el("small", { class: over ? "over" : null }, `${t.length}/280${over ? " · trop long" : ""}`),
            ),
          );
        }),
      ),
    );
  } else if (p === "reels") {
    const [voice, ...rest] = text.split(CAPTION_RE);
    const caption = rest.join("").trim();
    nodes.push(el("div", { class: "post" },
      paragraphs(voice, { directions: true }),
      caption ? el("div", { class: "caption" }, el("span", { class: "label" }, "Légende"), paragraphs(caption)) : null,
    ));
  } else {
    nodes.push(el("div", { class: "post" }, paragraphs(text, { directions: p === "youtube", headings: p === "youtube" })));
  }
  if (tags.length) nodes.push(el("p", { class: "hashtags" }, tags.map((t) => el("span", {}, t))));
  return nodes;
}

function copyPayload(script) {
  const { tags } = extractHashtags("", script.hashtags || []);
  const body = script.contenu || "";
  const missing = tags.filter((t) => !body.toLowerCase().includes(t.toLowerCase()));
  return [script.titre && !body.startsWith(script.titre) ? script.titre : null, body, missing.length ? missing.join(" ") : null]
    .filter(Boolean)
    .join("\n\n");
}

async function copyScript(p) {
  const script = state.entry?.scripts?.[p];
  if (!script) return;
  const ok = await copyText(copyPayload(script));
  toast(ok ? `Script ${PF[p].name} copié.` : "Copie impossible : sélectionne le texte à la main.");
}

function factorsList(facteurs) {
  const weakest = facteurs.reduce((m, f) => (f.score < m.score ? f : m), facteurs[0]);
  return el("div", { class: "factors" },
    facteurs.map((f) => {
      const heat = heatOf(f.score);
      const weak = f === weakest && f.score < 80;
      const button = el("button", { type: "button", class: `factor${weak ? " weak" : ""}`, "aria-expanded": "false" },
        el("span", { class: "factor-row" },
          el("span", { class: "name" }, FACTOR_LABELS[f.nom] || f.nom),
          el("span", { class: "factor-bar", "aria-hidden": "true" }, bar(f.score, heat)),
          tchip(f.score, heat, true),
        ),
        el("span", { class: "factor-note" }, weak ? el("span", { class: "weak-tag" }, "Priorité") : null, f.commentaire),
      );
      button.addEventListener("click", () =>
        button.setAttribute("aria-expanded", String(button.getAttribute("aria-expanded") !== "true")),
      );
      return button;
    }),
  );
}

// « Action courte : détail » → l'action reste visible, le détail se déplie.
function splitTip(text) {
  const t = String(text).trim();
  const m = t.match(/^(.{10,80}?)(\s*[:;—–]\s+|\s+\(|\.\s+)/u);
  if (!m) return { head: t, rest: "" };
  let rest = t.slice(m[1].length).replace(/^\s*[:;—–.]\s*/u, "").trim();
  if (!rest) return { head: t, rest: "" };
  return { head: m[1].trim(), rest };
}

function tipItem(text) {
  const { head, rest } = splitTip(text);
  if (!rest) return el("li", {}, el("span", { class: "tip-head" }, head));
  return el("li", {},
    el("details", { class: "tip" },
      el("summary", {}, el("span", { class: "tip-head" }, head), svg("chev", "ico chev")),
      el("p", { class: "tip-rest" }, rest),
    ),
  );
}

function sideBlock(entry, p, job) {
  const sc = entry.scripts[p].score || {};
  const judged = isJudged(sc);
  const rewriting = job?.kind === "rewrite" && job.platform === p;
  const side = el("aside", { class: "side", "aria-label": "Diagnostic du script" });

  if (judged) {
    side.append(el("section", {}, el("h3", {}, "Facteurs"), factorsList(sc.facteurs)));
    const tips = (sc.suggestions || []).slice(0, 3);
    if (tips.length) {
      side.append(el("section", {},
        el("h3", {}, plural(tips.length, "amélioration", "améliorations")),
        el("ol", { class: "improve" }, tips.map(tipItem)),
      ));
    }
  } else {
    side.append(el("section", {},
      el("h3", {}, "Facteurs"),
      job?.kind === "judge"
        ? el("div", { class: "factors", "aria-hidden": "true" }, [0, 1, 2, 3, 4].map(() => el("div", { class: "skeleton sk-factor" })))
        : el("p", { class: "side-note" }, "Accroche, structure, émotion, tendance et appel à l'action arrivent avec l'évaluation."),
    ));
  }

  side.append(
    el("button", {
      type: "button",
      class: "btn btn-primary rewrite-btn",
      "data-busy": rewriting ? "true" : null,
      disabled: Boolean(state.job) && !rewriting,
      "aria-disabled": rewriting ? "true" : null,
      onclick: () => rewrite(p),
    }, svg("rewrite"), rewriting ? "Réécriture en cours…" : judged ? "Réécrire avec ces améliorations" : "Réécrire selon les codes du format"),
  );
  if (state.error?.kind === "rewrite" && state.error.id === entry.id && state.error.platform === p) {
    side.append(alertBox("La réécriture n'a pas abouti.", state.error.message));
  }

  const heur = sc.heuristique || { global: null, flags: [] };
  const flags = heur.flags || [];
  const foot = el("div", { class: "side-foot" },
    el("div", { class: "format-line" },
      el("span", {}, `Codes du format ${PF[p].name}`),
      flags.length
        ? tchip(heur.global, heatOf(heur.global), true)
        : el("span", { class: "ok" }, svg("check"), "respectés"),
    ),
    flags.length
      ? disclosure(plural(flags.length, "point de format à corriger", "points de format à corriger"),
          el("ul", { class: "flags" }, flags.map((f) => el("li", {}, f))))
      : null,
    sc.comparaison ? disclosure("Analyse de l'éditeur", el("div", { class: "analysis" }, el("p", {}, sc.comparaison))) : null,
    el("p", { class: "side-note" }, "Après publication, saisis tes vues réelles dans l'Historique : chaque relevé mesure la fiabilité des prévisions."),
  );
  side.append(foot);
  return side;
}

function bodyBlock(entry, p, job) {
  const script = entry.scripts[p];
  const rewriting = job?.kind === "rewrite" && job.platform === p;
  const stamped = state.rewritten?.id === entry.id && state.rewritten.platform === p;
  // Le titre (YouTube) ouvre le script ; la ligne d'état le suit, jamais au-dessus en surtitre.
  const content = scriptContent(p, script);
  const title = content[0]?.classList?.contains("script-title") ? content.shift() : null;
  const article = el("article", { class: "script", "aria-label": `Script ${PF[p].name}` },
    title,
    el("div", { class: "script-head" },
      el("p", { class: "script-meta" },
        el("b", {}, "Prêt à publier"),
        el("span", {}, measure(p, script)),
        stamped ? el("span", { class: "rewrite-stamp" }, svg("check"), "Réécrit") : null,
      ),
      el("div", { class: "script-actions" },
        el("button", { type: "button", class: "btn", onclick: () => copyScript(p) }, svg("copy"), "Copier"),
      ),
    ),
    el("div", { class: `post-wrap${rewriting ? " is-rewriting" : ""}`, "aria-busy": rewriting ? "true" : null }, content),
  );
  return el("div", { class: "bulletin-body" }, article, sideBlock(entry, p, job));
}

/* ---------- « Le bulletin tombe » ---------- */

function countUp(node, from, to, duration, delay = 0) {
  if (!node || !Number.isFinite(to)) return;
  node.textContent = String(from);
  const start = performance.now() + delay;
  const step = (now) => {
    const p = Math.max(0, Math.min(1, (now - start) / duration));
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = String(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const rise = (node, delay, distance = 6, duration = 320) =>
  node?.animate(
    [{ opacity: 0, transform: `translateY(${distance}px)` }, { opacity: 1, transform: "none" }],
    { duration, delay, easing: EASE_OUT, fill: "backwards" },
  );

// Moment rare (une fois par prévision) : la note tombe, l'aiguille glisse, les facteurs se remplissent.
function dropBulletin(panel) {
  const verdict = panel.querySelector(".verdict");
  if (!verdict) return;
  if (reduceMotion.matches) {
    verdict.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 200, easing: "ease" });
    return;
  }
  const temp = verdict.querySelector(".temp");
  const num = temp.querySelector("b");
  temp.animate(
    [{ opacity: 0, transform: "translateY(-12px) scale(0.96)" }, { opacity: 1, transform: "none" }],
    { duration: 460, easing: EASE_OUT, fill: "backwards" },
  );
  countUp(num, 0, Number(num.textContent), 900, 120);
  verdict.querySelectorAll(".band-title, .verdict-say").forEach((n, i) => rise(n, 180 + i * 80));
  const needle = verdict.querySelector(".scale-needle:not([hidden])");
  if (needle) {
    needle.animate([{ transform: "translateX(0)" }, { transform: needle.style.transform }], {
      duration: 720, delay: 240, easing: EASE_IN_OUT, fill: "backwards",
    });
  }
  verdict.querySelectorAll(".conf-dots i.f").forEach((dot, i) =>
    dot.animate([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "none" }], {
      duration: 220, delay: 480 + i * 90, easing: EASE_OUT, fill: "backwards",
    }),
  );
  panel.querySelectorAll(".factor-bar i").forEach((b, i) =>
    b.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
      duration: 560, delay: 320 + i * 60, easing: EASE_OUT, fill: "backwards",
    }),
  );
  panel.querySelectorAll(".improve li").forEach((li, i) => rise(li, 640 + i * 70));
  document.querySelectorAll(".pf-tab .t").forEach((chip, i) =>
    chip.animate([{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "none" }], {
      duration: 240, delay: 200 + i * 60, easing: EASE_OUT, fill: "backwards",
    }),
  );
}

function dropRewrite(panel, from) {
  const num = panel.querySelector(".temp b");
  const post = panel.querySelector(".post-wrap");
  if (reduceMotion.matches) {
    post?.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 200, easing: "ease" });
    return;
  }
  post?.animate([{ opacity: 0.5, filter: "blur(2px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 260, easing: EASE_OUT });
  if (Number.isFinite(from) && num) countUp(num, from, Number(num.textContent), 700, 80);
  panel.querySelectorAll(".factor-bar i").forEach((b, i) =>
    b.animate([{ transform: "scaleX(0.6)" }, { transform: "scaleX(1)" }], {
      duration: 420, delay: 80 + i * 50, easing: EASE_OUT, fill: "backwards",
    }),
  );
  rise(panel.querySelector(".rewrite-stamp"), 120, 4, 240);
}

/* ---------- Barre collante ---------- */

let stickyObserver = null;

function setSticky(on) {
  const bar = $("#sticky-bar");
  bar.classList.toggle("is-on", on);
  bar.setAttribute("aria-hidden", String(!on));
  bar.inert = !on;
}

function stopSticky() {
  stickyObserver?.disconnect();
  stickyObserver = null;
  setSticky(false);
}

function observeSticky(verdict, entry, p, job) {
  stickyObserver?.disconnect();
  if (!verdict || !("IntersectionObserver" in window)) return;
  const pfs = platformsOf(entry);
  const rewriting = job?.kind === "rewrite";
  $("#sticky-bar").replaceChildren(
    el("span", { class: "sticky-title" }, entry.brief.idea),
    el("div", { class: "sticky-scores" },
      pfs.map((q) => {
        const sc = entry.scripts[q].score || {};
        return el("button", {
          type: "button",
          class: "sticky-score",
          "aria-pressed": String(q === p),
          onclick: () => {
            selectTab(q);
            $(".pf-tabs")?.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
          },
        }, PF[q].name, isJudged(sc) ? tchip(sc.final, heatOf(sc.final), true) : tchip(null, null, true));
      }),
    ),
    el("button", { type: "button", class: "btn", "aria-label": `Copier le script ${PF[p].name}`, onclick: () => copyScript(p) },
      svg("copy"), el("span", {}, "Copier")),
    el("button", {
      type: "button",
      class: "btn btn-primary",
      disabled: Boolean(state.job),
      "data-busy": rewriting ? "true" : null,
      "aria-label": `Réécrire le script ${PF[p].name}`,
      onclick: () => rewrite(p),
    }, svg("rewrite"), el("span", {}, rewriting ? "Réécriture…" : "Réécrire")),
  );
  stickyObserver = new IntersectionObserver(
    ([obs]) => setSticky(!obs.isIntersecting && obs.boundingClientRect.top < 0),
    { rootMargin: "-64px 0px 0px 0px" },
  );
  stickyObserver.observe(verdict);
}

/* =========================================================================
   Récents (barre latérale)
   ========================================================================= */

function renderRecents() {
  const list = $("#recents-list");
  if (!state.entriesLoaded) return;
  const items = state.entries.slice(0, 6);
  if (!items.length) {
    list.replaceChildren(el("li", { class: "recents-empty" }, "Tes prévisions apparaîtront ici."));
    return;
  }
  list.replaceChildren(
    ...items.map((e) => {
      const best = bestOf(e);
      const current = state.route.view === "prevision" && state.route.id === e.id;
      return el("li", {},
        el("a", { class: "recent-item", href: `#prevision/${e.id}`, "aria-current": current ? "page" : null },
          el("span", {}, e.brief.idea),
          best ? tchip(best.final, best.heat, true) : tchip(null, null, true),
        ),
      );
    }),
  );
}

/* =========================================================================
   Idées tendance : scan des réseaux, signaux viraux, idées à publier
   ========================================================================= */

const NETS = {
  tiktok: { name: "TikTok", icon: "tiktok" },
  instagram: { name: "Instagram", icon: "instagram" },
  x: { name: "X", icon: "x" },
  linkedin: { name: "LinkedIn", icon: "linkedin" },
  youtube: { name: "YouTube Shorts", icon: "youtube" },
};
const NET_ORDER = ["tiktok", "instagram", "x", "linkedin", "youtube"];
const IDEA_TARGET = { reels: "Reel · Instagram / TikTok", linkedin: "LinkedIn", x: "X", youtube: "YouTube" };
const IDEA_ICON = { reels: "reels", linkedin: "linkedin", x: "x", youtube: "youtube" };
const STAGE_HEAT = { "Émergent": "warm", "En explosion": "hot", "Établi": "mild", "Saturé": "cold" };
const NETWORKS_KEY = "amorce.scan.networks";

const fmtCompact = (n) => {
  if (n === null || n === undefined) return "—";
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`;
  if (n >= 1e4) return `${Math.round(n / 1e3).toLocaleString("fr-FR")} k`;
  if (n >= 1e3) return `${(n / 1e3).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k`;
  return n.toLocaleString("fr-FR");
};
const ageText = (h) => (h < 1 ? "à l'instant" : h < 48 ? `il y a ${Math.round(h)} h` : `il y a ${Math.round(h / 24)} j`);
const sinceText = (iso) => ageText((Date.now() - Date.parse(iso)) / 3.6e6);

let scanPolling = false;

function storedNetworks() {
  try {
    const v = JSON.parse(localStorage.getItem(NETWORKS_KEY) || "null");
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function renderScanNetworks() {
  const box = $("#scan-networks");
  const avail = state.health?.social || {};
  const chosen = storedNetworks() || state.settings?.socialNetworks || NET_ORDER;
  box.replaceChildren(
    ...NET_ORDER.map((n) => {
      const usable = avail[n] !== false;
      return el("label", { class: `pf-toggle${usable ? "" : " is-off"}`, title: usable ? null : n === "youtube" ? "Clé YouTube requise" : "Jeton Apify requis" },
        el("input", { type: "checkbox", name: "scan-net", value: n, checked: usable && chosen.includes(n), disabled: !usable }),
        el("span", {},
          el("span", { class: "check", "aria-hidden": "true" }, svg("check", "")),
          svg(NETS[n].icon, "ico pf-ico"),
          NETS[n].name,
          usable ? null : el("small", {}, n === "youtube" ? "clé requise" : "jeton requis"),
        ),
      );
    }),
  );
  updateScanCost();
}

function selectedNetworks() {
  return [...document.querySelectorAll('input[name="scan-net"]:checked')].map((c) => c.value);
}

function updateScanCost() {
  const costs = state.health?.scanCostUsd || {};
  const nets = selectedNetworks();
  const usd = nets.reduce((s, n) => s + (costs[n] || 0), 0);
  $("#scan-cost").textContent = usd > 0
    ? `≈ ${usd.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $ de crédit Apify par scan · résultats gardés 6 h · 1 à 3 minutes`
    : nets.length ? "Sources gratuites uniquement · moins d'une minute" : "Choisis au moins un réseau.";
}

function renderScanNotice() {
  const box = $("#scan-notice");
  const h = state.health;
  if (!h || h.hasApifyToken) return box.replaceChildren();
  box.replaceChildren(
    el("div", { class: "notice-card" },
      el("strong", {}, "TikTok, Instagram, X et LinkedIn ne sont pas encore branchés."),
      el("p", {},
        "Ajoute un jeton Apify (APIFY_TOKEN) dans ",
        h.deployed ? "les variables d'environnement Vercel, puis redéploie" : "le fichier .env, puis relance",
        ". En attendant, Amorce s'appuie sur YouTube Shorts (si la clé YouTube est là) et sur les sujets montants en France. ",
        el("a", { href: "#reglages" }, "Voir l'état du système"),
      ),
    ),
  );
}

function initIdeas() {
  const form = $("#scan-form");
  $("#scan-networks").addEventListener("change", () => {
    try {
      localStorage.setItem(NETWORKS_KEY, JSON.stringify(selectedNetworks()));
    } catch {
      /* confort seulement */
    }
    updateScanCost();
  });
  $("#sc-niche").addEventListener("input", () => setFieldError($("#sc-niche").closest(".field"), $("#sc-niche-error"), false));
  // Le formulaire réutilise un scan de moins de 6 h (même niche, audience et réseaux) ;
  // seul « Rafraîchir » force un nouveau relevé.
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    runScan();
  });
}

// Annonce courte pour les lecteurs d'écran (la zone de résultats n'est pas une région live).
function announceScan(text) {
  const box = $("#scan-status");
  if (box) box.textContent = text;
}

const scanBusy = () => scanPolling || Boolean(state.scanPending);

async function loadIdeasView() {
  renderScanNotice();
  if (!state.settings) await loadSettingsData();
  renderScanNetworks();
  if (!$("#sc-niche").value && state.settings?.profile?.niche) $("#sc-niche").value = state.settings.profile.niche;
  if (!$("#sc-audience").value && state.settings?.profile?.audience) $("#sc-audience").value = state.settings.profile.audience;
  if (state.scanPending) return renderScanRunning(state.scanPending);
  if (scanPolling) return renderScan(state.scan);
  if (!state.scan) {
    try {
      state.scan = await api("/api/scan?id=latest");
    } catch {
      state.scan = null;
    }
  }
  if (state.route.view !== "idees") return;
  if (!state.scan) return renderScanIdle();
  renderScan(state.scan);
  if (state.scan.status === "running") pollScan();
  else if (state.scan.status === "done" && !state.scan.ideas && !state.scan.ideasError) makeIdeas();
}

// Échec du dernier scan lancé : reste affiché au-dessus des résultats précédents jusqu'au scan suivant.
function scanErrorBox() {
  const e = state.scanError;
  if (!e) return null;
  const box = alertBox(`Le scan de « ${e.niche} » n'a pas abouti.`, e.message, [["Réessayer", () => runScan(e.params), true]]);
  // Annoncée et animée une seule fois ; ensuite elle reste simplement affichée.
  if (e.shown) {
    box.removeAttribute("role");
    box.classList.remove("enter");
  }
  e.shown = true;
  return box;
}

function renderScanIdle() {
  $("#scan-body").replaceChildren(
    ...[scanErrorBox(),
      el("section", { class: "scan-how", "aria-label": "Comment ça marche" },
        el("ol", { class: "stations stations-3" },
          [
            ["La veille", "Claude fait la veille de la semaine sur le web et choisit les mots-clés que ta niche emploie en ce moment."],
            ["Le relevé", "Les posts de la semaine, notés selon de combien ils dépassent l'audience de leur auteur\u00a0; Claude lit les meilleurs, visuels compris, et écarte le hors-sujet."],
            ["Les idées", "6 idées prêtes à tourner (accroche, plan, hashtags), appuyées sur les posts qui le prouvent et sur ton historique, à envoyer en un clic dans la prévision."],
          ].map(([t, d], i) =>
            el("li", { class: `station${i === 2 ? " station-end" : ""}` },
              el("span", { class: "station-dot", "aria-hidden": "true" }),
              el("h3", {}, t),
              el("p", {}, d),
            ),
          ),
        ),
      ),
    ].filter(Boolean),
  );
}

// Relance depuis le formulaire, ou avec des paramètres explicites (« Rafraîchir », « Réessayer »).
async function runScan(params = {}) {
  const niche = (params.niche ?? $("#sc-niche").value).trim();
  const audience = (params.audience ?? $("#sc-audience").value).trim();
  const networks = params.networks ?? selectedNetworks();
  const force = Boolean(params.force);
  if (!niche) {
    setFieldError($("#sc-niche").closest(".field"), $("#sc-niche-error"), true);
    return $("#sc-niche").focus();
  }
  if (!networks.length) return toast("Choisis au moins un réseau à scanner.");
  if (scanBusy()) return toast("Un scan est déjà en cours.");
  $("#sc-niche").value = niche;
  $("#sc-audience").value = audience;
  const btn = $("#btn-scan");
  btn.disabled = true;
  btn.dataset.busy = "true";
  state.scanError = null;
  state.scanT0 = Date.now();
  state.scanFocus = true;
  state.scanPending = { niche, networks, runs: {}, external: null };
  renderScanRunning(state.scanPending);
  announceScan(`Scan de « ${niche} » lancé.`);
  try {
    try {
      state.scan = await post("/api/scan", { niche, audience, networks, force });
    } finally {
      state.scanPending = null;
    }
    if (state.settings) state.settings.profile = { niche, audience };
    if (state.scan.reused) toast(`Scan de ${timeOf(state.scan.createdAt)} réutilisé (moins de 6 h)\u00a0: aucun crédit dépensé.`);
    if (state.scan.status === "running") await pollScan();
    else {
      if (state.route.view === "idees") renderScan(state.scan);
      if (!state.scan.ideas) await makeIdeas();
    }
  } catch (err) {
    state.scanError = { niche, message: err.message, params: { niche, audience, networks, force } };
    state.scanFocus = false;
    if (state.route.view === "idees") {
      state.scan ? renderScan(state.scan) : renderScanIdle();
      const lost = !document.activeElement || document.activeElement === document.body || document.activeElement.id === "btn-scan";
      if (lost) $("#scan-body .alert .btn-primary")?.focus({ preventScroll: true });
    } else toast(`Le scan de « ${niche} » n'a pas abouti\u00a0: ${err.message}`);
  } finally {
    btn.disabled = false;
    delete btn.dataset.busy;
  }
}

async function pollScan() {
  if (scanPolling || !state.scan) return;
  scanPolling = true;
  state.scanT0 = state.scanT0 || Date.parse(state.scan.createdAt);
  try {
    while (state.scan.status === "running") {
      if (state.route.view === "idees") renderScanRunning(state.scan);
      const t = Date.now();
      state.scan = await api(`/api/scan?id=${encodeURIComponent(state.scan.id)}`);
      // Au moins 2,5 s entre deux relevés, même quand le serveur répond tout de suite.
      const spent = Date.now() - t;
      if (state.scan.status === "running" && spent < 2500) await new Promise((r) => setTimeout(r, 2500 - spent));
    }
    announceScan(`Relevé terminé : ${plural((state.scan.posts || []).length, "post analysé", "posts analysés")}.`);
    if (state.route.view === "idees") renderScan(state.scan);
    if (state.scan.status === "done" && !state.scan.ideas) await makeIdeas();
  } catch (err) {
    if (state.route.view === "idees") {
      $("#scan-body").replaceChildren(alertBox("Le suivi du scan a échoué.", err.message, [["Reprendre", () => pollScan(), true]]));
    }
  } finally {
    scanPolling = false;
  }
}

// Une seule rédaction d'idées à la fois par scan, même si l'on quitte l'onglet et revient.
// Deux temps : Claude lit d'abord le relevé (pertinence, mécanismes, visuels), puis écrit les idées.
let ideasJob = null;

function makeIdeas() {
  const scan = state.scan;
  if (!scan || scan.status !== "done") return Promise.resolve();
  if (ideasJob?.id === scan.id) return ideasJob.promise;
  const needsAnalysis = !scan.analysis && !scan.analysisError && (scan.posts || []).length > 0;
  const job = { id: scan.id, stage: needsAnalysis ? "analyse" : "idees" };
  ideasJob = job;
  const stillHere = () => state.scan?.id === scan.id && !state.scanPending;
  const show = (s, opts) => {
    if (state.route.view === "idees" && stillHere()) renderScan(s, opts);
  };
  show(scan);
  job.promise = (async () => {
    let cur = scan;
    if (needsAnalysis) {
      try {
        cur = await post("/api/scan/analyze", { id: scan.id });
      } catch (err) {
        cur = { ...cur, analysisError: err.message };
      }
      if (state.scan?.id === scan.id) state.scan = cur;
      job.stage = "idees";
      // L'analyse s'affiche (tendances, mécanismes) pendant que Claude écrit les idées.
      show(cur);
    }
    let next;
    try {
      next = await post("/api/ideas", { id: scan.id, force: Boolean(cur.ideas) });
    } catch (err) {
      next = { ...cur, ideasError: err.message };
    }
    if (ideasJob === job) ideasJob = null;
    // Un autre scan a pris la place, ou va la prendre : ce résultat ne doit pas l'écraser à l'écran.
    if (state.scan?.id !== scan.id) return;
    state.scan = next;
    if (state.scanPending) return;
    if (next.ideas?.items?.length) {
      toast(`${plural(next.ideas.items.length, "idée prête", "idées prêtes")}\u00a0: ${next.ideas.items[0]?.titre || ""}`);
      announceScan(`${plural(next.ideas.items.length, "idée prête", "idées prêtes")}.`);
    }
    show(state.scan, { reveal: true });
  })();
  return job.promise;
}

function scanClock() {
  const s = Math.max(0, Math.floor((Date.now() - (state.scanT0 || Date.now())) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const STOPPED = ["ABORTED", "ABORTING", "TIMED-OUT", "TIMING-OUT"];
const FAILED = ["ERROR", "FAILED"];
const ytError = (scan) => (scan.errors || []).find((e) => e.source === NETS.youtube.name);

function runStage(scan, n) {
  if (n === "youtube") {
    if (!scan.status) return { state: "active", when: "en cours" };
    return ytError(scan) ? { state: "done", when: "indisponible" } : { state: "done", when: "relevé" };
  }
  const r = (scan.runs || {})[n];
  if (!r) return { state: "active", when: "lancement" };
  if (r.status === "SUCCEEDED") return { state: "done", when: "relevé" };
  if (STOPPED.includes(r.status)) return { state: "done", when: "arrêté, partiel gardé" };
  if (FAILED.includes(r.status)) return { state: "done", when: "indisponible" };
  return { state: "active", when: "en cours" };
}

function researchStage(scan) {
  if (!scan.id) return { state: "active", when: "recherche sur le web" };
  if (scan.planReused) return { state: "done", when: scan.research ? "réutilisée (moins de 20 h)" : "requêtes réutilisées" };
  if (scan.research) return { state: "done", when: plural(scan.research.sources?.length || 0, "source", "sources") };
  return { state: "done", when: scan.researchError ? "indisponible" : "sans veille" };
}

function renderScanRunning(scan) {
  const ai = state.health?.hasAnthropicKey;
  const stages = [];
  if (ai && state.health?.ai?.webResearch !== false) stages.push({ label: "Veille web de la semaine (Claude)", ...researchStage(scan) });
  stages.push(...(scan.networks || []).map((n) => ({ label: NETS[n].name, ...(scan.id ? runStage(scan, n) : { state: "todo", when: "ensuite" }) })));
  stages.push({ label: "Score de viralité", state: "todo", when: "ensuite" });
  if (ai) stages.push({ label: "Lecture des posts et des visuels (Claude)", state: "todo", when: "ensuite" });
  stages.push({ label: "Idées à publier", state: "todo", when: "ensuite" });
  const ext = scan.external;
  const topics = ext ? [...(ext.xFrance || []).filter((t) => t.rising).slice(0, 4).map((t) => ({ title: t.title, source: "X France, en hausse" })), ...(ext.googleTrends || []).slice(0, 3).map((t) => ({ title: t.title, source: "Google" }))] : [];
  // L'entrée animée ne joue qu'au premier affichage, pas à chaque relevé.
  const runKey = scan.id || `pending:${scan.niche}`;
  if (scan.id && state.scanRunKey === `pending:${scan.niche}`) state.scanRunKey = runKey;
  const first = state.scanRunKey !== runKey;
  state.scanRunKey = runKey;
  $("#scan-body").replaceChildren(
    el("section", { class: `run card${first ? " enter" : " is-static"}`, "aria-labelledby": "scan-run-title" },
      el("div", {},
        el("h2", { class: "run-title", id: "scan-run-title" }, `Scan de « ${scan.niche} »`),
        el("p", { class: "run-sub" }, state.health?.hasAnthropicKey
          ? "Claude fait d'abord la veille de la semaine sur le web pour viser les bons mots-clés, puis Amorce relève les posts sur chaque réseau. Les plus lents sont arrêtés au bout de 4 minutes\u00a0: on garde ce qu'ils ont déjà trouvé."
          : "Amorce relève les posts de la semaine sur chaque réseau. Les plus lents sont arrêtés au bout de 4 minutes\u00a0: on garde ce qu'ils ont déjà trouvé."),
        el("ol", { class: "run-stages" },
          stages.map((st) =>
            el("li", { class: "run-stage", "data-state": st.state },
              el("span", { class: "dot", "aria-hidden": "true" }, st.state === "done" ? svg("check", "") : null),
              el("span", {}, st.label),
              el("span", { class: "when" }, st.when),
            ),
          ),
        ),
      ),
      el("div", { class: "run-side" },
        el("span", { class: "label" }, "Temps écoulé"),
        el("div", { class: "run-clock", "data-scan-clock": "", "aria-hidden": "true" }, scanClock()),
        el("p", {}, "Tu peux changer de page\u00a0: le scan continue et ses résultats t'attendront ici."),
        topics.length ? [el("span", { class: "label" }, "Sujets montants en France"),
          el("ul", { class: "live-signals" }, topics.map((t, i) => el("li", { class: "live-signal", vars: { "--i": i } }, frontGlyph(), el("b", {}, t.title), el("span", { class: "src" }, t.source))))] : null,
      ),
    ),
  );
}

// Liens issus des réseaux : seulement http(s), jamais javascript: ou data:.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);

function evidenceItem(p) {
  const metrics = [
    p.views !== null ? `${fmtCompact(p.views)} vues` : `${fmtCompact(p.likes)} réactions`,
    p.reach !== null && p.reach >= 1.5 ? `×${fmtRatio(p.reach)} son audience` : null,
    ageText(p.ageH),
  ].filter(Boolean).join(" · ");
  const body = [svg(NETS[p.network].icon, "ico net-ico"), el("span", {}, el("b", {}, `@${p.authorHandle || "?"}`), ` · ${metrics}`)];
  const url = safeUrl(p.url);
  return el("li", {}, url ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, body, el("span", { class: "sr-only" }, " (nouvel onglet)")) : el("span", {}, body));
}

function ideaCard(idea, i, scan, reveal = false) {
  const byKey = Object.fromEntries((scan.posts || []).map((p) => [p.key, p]));
  const proofs = (idea.preuves || []).map((k) => byKey[k]).filter(Boolean);
  const heat = heatOf(idea.potentiel);
  return el("article", { class: `idea${reveal ? " enter" : ""}`, vars: { "--i": i } },
    el("div", { class: "idea-head" },
      el("h3", {}, idea.titre),
      el("span", { class: "idea-score", title: "Potentiel relatif dans ta niche" }, tchip(idea.potentiel, heat)),
    ),
    el("p", { class: "idea-meta" }, svg(IDEA_ICON[idea.plateforme], "ico pf-ico"), `${IDEA_TARGET[idea.plateforme]} · ${idea.format}`),
    el("p", { class: "hook" }, `«\u00a0${idea.accroche}\u00a0»`),
    el("p", { class: "idea-plan" }, idea.deroule),
    ideaDetails(idea),
    el("div", { class: "idea-why" },
      el("span", { class: "label" }, "Pourquoi maintenant"),
      el("p", {}, idea.pourquoi_maintenant),
      proofs.length ? el("ul", { class: "evidence", "aria-label": "Posts qui le prouvent" }, proofs.map(evidenceItem)) : null,
      idea.pourquoi_toi ? [el("span", { class: "label" }, "Pour toi"), el("p", {}, idea.pourquoi_toi)] : null,
      idea.risque ? el("p", { class: "idea-risk" }, el("b", {}, "À surveiller\u00a0: "), idea.risque) : null,
    ),
    el("div", { class: "idea-foot" },
      el("span", { class: "idea-window" },
        el("b", {}, `Fenêtre : ${idea.fenetre}`),
        ` · effort ${idea.effort}${idea.tendance ? ` · ${idea.tendance}` : ""}`,
      ),
      el("button", { type: "button", class: `btn${i === 0 ? " btn-primary" : ""}`, onclick: () => writeIdea(idea, scan) }, "Écrire cette idée", svg("arrow")),
    ),
  );
}

// Plan détaillé, autres accroches, appel à l'action et hashtags : repliés pour garder la carte lisible.
function ideaDetails(idea) {
  const plan = idea.plan || [];
  const variants = idea.variantes_accroche || [];
  const tags = idea.hashtags || [];
  if (!plan.length && !variants.length && !idea.cta && !tags.length) return null;
  return disclosure("Plan, autres accroches et hashtags",
    el("div", { class: "idea-details" },
      plan.length ? [el("span", { class: "label" }, "Plan"), el("ol", { class: "idea-steps" }, plan.map((step) => el("li", {}, step)))] : null,
      variants.length ? [el("span", { class: "label" }, "Autres accroches"), el("ul", { class: "idea-variants" }, variants.map((v) => el("li", {}, `«\u00a0${v}\u00a0»`)))] : null,
      idea.cta ? [el("span", { class: "label" }, "Appel à l'action"), el("p", {}, idea.cta)] : null,
      tags.length ? el("p", { class: "idea-tags" }, tags.map((t) => `#${t}`).join(" ")) : null,
    ),
    "idea-more",
  );
}

// L'idée part directement en prévision : brief pré-rempli et lancé, avec tout ce que Claude a préparé.
function writeIdea(idea, scan) {
  if (state.job) return busyToast();
  const context = [
    `${idea.format}.`,
    `Accroche envisagée : « ${idea.accroche} »${idea.variantes_accroche?.length ? ` (autres pistes : ${idea.variantes_accroche.map((v) => `« ${v} »`).join(", ")})` : ""}.`,
    idea.plan?.length ? `Plan : ${idea.plan.join(" / ")}.` : null,
    idea.cta ? `Appel à l'action : ${idea.cta}` : null,
    `Pourquoi maintenant : ${idea.pourquoi_maintenant}`,
    idea.risque ? `À surveiller : ${idea.risque}` : null,
  ].filter(Boolean).join(" ");
  const brief = {
    idea: idea.titre,
    niche: scan.niche,
    audience: scan.audience || $("#f-audience").value.trim(),
    goal: $("#f-goal").value,
    platforms: [idea.plateforme],
    context: context.slice(0, 2000),
  };
  $("#f-idea").value = brief.idea;
  $("#f-niche").value = brief.niche;
  $("#f-audience").value = brief.audience;
  renderPlatformOptions(brief.platforms);
  history.pushState(null, "", "#creer");
  applyRoute();
  startForecast(brief);
}

function signalRow(p) {
  const flags = p.flags.filter((f) => ["reproductible", "sponsorisé", "concours", "polémique"].includes(f));
  return el("li", { class: "signal" },
    el("span", { class: "signal-net", title: NETS[p.network].name }, svg(NETS[p.network].icon, "ico net-ico"), el("span", { class: "sr-only" }, NETS[p.network].name)),
    el("div", { class: "signal-main" },
      safeUrl(p.url)
        ? el("a", { class: "signal-text", href: safeUrl(p.url), target: "_blank", rel: "noopener noreferrer" }, p.text || "(sans texte)", el("span", { class: "sr-only" }, " (nouvel onglet)"))
        : el("span", { class: "signal-text" }, p.text || "(sans texte)"),
      el("span", { class: "signal-meta" },
        `@${p.authorHandle || "?"}`,
        p.authorFollowers !== null ? ` · ${fmtCompact(p.authorFollowers)} abonnés` : "",
        ` · ${ageText(p.ageH)}${p.mediaType ? ` · ${p.mediaType}` : ""}`,
        flags.map((f) => el("span", { class: `flag flag-${f}` }, f)),
      ),
      p.ai ? el("span", { class: "signal-ai" },
        el("b", {}, `${p.ai.format} · accroche ${p.ai.accroche_type}`),
        ` — ${p.ai.mecanisme}`,
        p.ai.texte_ecran ? el("span", { class: "signal-onscreen" }, ` À l'écran\u00a0: «\u00a0${p.ai.texte_ecran}\u00a0»`) : null,
      ) : null,
    ),
    el("div", { class: "signal-metrics" },
      el("b", {}, p.views !== null ? fmtCompact(p.views) : fmtCompact(p.likes)),
      el("span", {}, p.views !== null ? "vues" : "réactions"),
      p.reach !== null && p.reach >= 1.5 ? el("span", { class: "signal-reach" }, `×${fmtRatio(p.reach)} audience`) : p.confidence <= 0.3 ? el("span", { class: "signal-reach" }, `×${fmtRatio(p.ratio)} vs médiane`) : null,
    ),
    el("span", { class: "signal-score", title: `${p.label} · score de viralité ${p.score}/100` }, tchip(p.score, heatOf(p.score), true), el("small", {}, p.label)),
  );
}

function clusterRow(c) {
  const heat = STAGE_HEAT[c.stage] || "mild";
  return el("li", { class: "trend-row" },
    el("span", { class: "trend-name" }, c.kind === "son" ? ["Son · ", el("b", {}, c.label)] : el("b", {}, c.label)),
    el("span", { class: "stage" }, el("i", { vars: { "--t": `var(--${heat})` }, "aria-hidden": "true" }), c.stage),
    el("span", { class: "trend-facts" },
      `${plural(c.creators, "créateur", "créateurs")} · ${c.networks.map((n) => NETS[n].name).join(", ")} · ${c.hitRate} % des posts à ×3 et plus`,
      c.external ? " · aussi dans les tendances nationales" : "",
    ),
  );
}

function topicsBlock(ext) {
  if (!ext) return null;
  const groups = [
    ["X France, maintenant", (ext.xFrance || []).slice(0, 12).map((t) => `${t.title}${t.rising ? " (en hausse)" : ""}`)],
    ["Recherches Google en hausse", (ext.googleTrends || []).slice(0, 8).map((t) => t.title)],
  ].filter(([, list]) => list.length);
  const news = (ext.news || []).slice(0, 5);
  if (!groups.length && !news.length) return null;
  return el("section", { class: "topics", "aria-labelledby": "topics-title" },
    el("h2", { class: "scan-h2", id: "topics-title" }, "Sujets montants en France"),
    el("div", { class: "topic-groups" },
      groups.map(([label, list]) => el("div", { class: "topic-group" }, el("span", { class: "label" }, label), el("p", {}, list.join(" · ")))),
      news.length
        ? el("div", { class: "topic-group" }, el("span", { class: "label" }, "Actualité de ta niche"),
            el("ul", { class: "topic-news" }, news.map((n) => el("li", {}, safeUrl(n.url) ? el("a", { href: safeUrl(n.url), target: "_blank", rel: "noopener noreferrer" }, n.title) : n.title, el("small", {}, ` ${n.signal}`)))))
        : null,
    ),
  );
}

const AI_STAGE_HEAT = { "émergent": "warm", "en hausse": "hot", "installé": "mild", "saturé": "cold" };
const fmtUsd = (n) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const eventDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : d);

// Veille web de la semaine (Claude, recherche web) : faits, dates, mots du moment, sources.
function researchBlock(scan) {
  const r = scan.research;
  if (!r) return scan.researchError ? el("p", { class: "sources-missing" }, `Veille web indisponible pour ce scan\u00a0: ${scan.researchError}`) : null;
  const sources = (r.sources || []).filter((src) => safeUrl(src.url)).slice(0, 6);
  return el("section", { class: "veille card", "aria-labelledby": "veille-title" },
    el("div", { class: "fronts-head" },
      el("h2", { class: "section-title", id: "veille-title" }, "Veille de la semaine"),
      el("span", { class: "hint" }, `Recherche web par Claude${r.createdAt ? `, ${sinceText(r.createdAt)}` : ""}`),
    ),
    r.synthese ? el("p", { class: "veille-synthese" }, r.synthese) : null,
    el("div", { class: "veille-grid" },
      r.a_savoir?.length ? el("div", {}, el("span", { class: "label" }, "À savoir"), el("ul", { class: "veille-list" }, r.a_savoir.map((f) => el("li", {}, f)))) : null,
      r.dates?.length ? el("div", {}, el("span", { class: "label" }, "Dates à venir"), el("ul", { class: "veille-list veille-dates" }, r.dates.map((d) => el("li", {}, el("b", {}, eventDate(d.date)), ` ${d.evenement}`)))) : null,
      r.angles?.length ? el("div", {}, el("span", { class: "label" }, "Débats qui circulent"), el("ul", { class: "veille-list" }, r.angles.map((a) => el("li", {}, a)))) : null,
    ),
    r.mots_du_moment?.length ? el("div", { class: "veille-words" }, el("span", { class: "label" }, "Mots du moment"), el("p", {}, r.mots_du_moment.map((w) => el("span", { class: "word" }, w)))) : null,
    sources.length ? el("p", { class: "veille-sources" }, "Sources\u00a0: ", sources.map((src, i) => [i ? " · " : "", el("a", { href: safeUrl(src.url), target: "_blank", rel: "noopener noreferrer" }, src.title)])) : null,
  );
}

// Tendance dégagée par Claude (format, accroche, sujet…), avec les posts qui l'illustrent.
function aiTrendItem(t, scan) {
  const byKey = Object.fromEntries((scan.posts || []).map((p) => [p.key, p]));
  const proofs = (t.postKeys || []).map((k) => byKey[k]).filter(Boolean).slice(0, 3);
  return el("li", { class: "ai-trend" },
    el("div", { class: "ai-trend-head" },
      el("b", {}, t.nom),
      el("span", { class: "trend-type" }, t.type),
      el("span", { class: "stage" }, el("i", { vars: { "--t": `var(--${AI_STAGE_HEAT[t.stade] || "mild"})` }, "aria-hidden": "true" }), t.stade),
    ),
    el("p", {}, t.explication),
    el("p", { class: "ai-trend-how" }, el("b", {}, "Comment l'utiliser\u00a0: "), t.comment_l_utiliser),
    proofs.length ? el("ul", { class: "evidence", "aria-label": "Posts qui l'illustrent" }, proofs.map(evidenceItem)) : null,
  );
}

function renderScan(scan, { reveal = false } = {}) {
  if (!scan) return renderScanIdle();
  if (scan.status === "running") return renderScanRunning(scan);
  const allPosts = scan.posts || [];
  // Les posts que Claude a jugés hors sujet restent dans le relevé, mais pas dans la liste.
  const posts = allPosts.filter((p) => !p.offTopic);
  const hidden = allPosts.length - posts.length;
  // La liste ne montre que ce qui dépasse la norme ; à défaut, les meilleurs posts du relevé.
  const strong = posts.filter((p) => p.label !== "Dans la norme");
  const pool = (strong.length >= 3 ? strong : posts).slice().sort((a, b) => b.score - a.score);
  const filter = state.netFilter && pool.some((p) => p.network === state.netFilter) ? state.netFilter : "all";
  const shown = pool.filter((p) => filter === "all" || p.network === filter).slice(0, 15);
  const nets = NET_ORDER.filter((n) => pool.some((p) => p.network === n));
  // Réseaux sans résultat : en échec (avec la raison), vides, ou non scannés faute de clé.
  const failed = [];
  const empty = [];
  const filtered = [];
  for (const n of scan.networks || []) {
    const st = scan.stats?.[n];
    if ((st?.kept ?? st?.fetched) > 0) continue;
    if (st?.fetched > 0) {
      filtered.push(NETS[n].name);
      continue;
    }
    const r = (scan.runs || {})[n];
    const why = st?.error || r?.error || (n === "youtube" ? ytError(scan)?.error : null);
    if (why || FAILED.includes(r?.status) || FAILED.includes(st?.status)) failed.push(`${NETS[n].name}${why ? ` (${why})` : ""}`);
    else empty.push(NETS[n].name);
  }
  const skipped = (scan.skipped || []).map((n) => NETS[n]?.name || n);
  const missing = [
    failed.length ? `Sans réponse\u00a0: ${failed.join(", ")}.` : null,
    empty.length ? `Aucun post trouvé sur ${empty.join(", ")}.` : null,
    filtered.length ? `Posts de ${filtered.join(", ")} tous écartés (autre langue, plus de 14 jours ou audience trop faible).` : null,
    skipped.length ? `Non scannés faute de clé\u00a0: ${skipped.join(", ")}.` : null,
  ].filter(Boolean).join(" ");
  const meta = [
    `Relevé ${sinceText(scan.finishedAt || scan.createdAt)}`,
    plural(allPosts.length, "post analysé", "posts analysés"),
    scan.networks.map((n) => NETS[n].name).join(", "),
    scan.costUsd ? `${fmtUsd(scan.costUsd)} $ Apify` : null,
    scan.claude?.costUsd ? `${fmtUsd(scan.claude.costUsd)} $ Claude` : null,
  ].filter(Boolean).join(" · ");

  const out = [scanErrorBox()];
  out.push(el("header", { class: "scan-summary" },
    el("div", {},
      el("h2", { class: "scan-title", id: "scan-result-title", tabindex: "-1", "data-focus": "" }, `Cette semaine en « ${scan.niche} »`),
      scan.ideas?.synthese ? el("p", { class: "scan-synthese" }, scan.ideas.synthese) : null,
      el("p", { class: "scan-meta" }, meta),
    ),
    // Relance exactement ce scan (sa niche, son audience, ses réseaux), pas le contenu du formulaire.
    el("button", { type: "button", class: "btn btn-quiet", onclick: () => runScan({ force: true, niche: scan.niche, audience: scan.audience || "", networks: scan.networks }) }, svg("rewrite"), "Rafraîchir"),
  ));
  if (missing) out.push(el("p", { class: "sources-missing" }, missing));
  if (scan.analysisError) out.push(el("p", { class: "sources-missing" }, `Lecture des posts par Claude indisponible\u00a0: ${scan.analysisError}`));

  // Idées
  if (ideasJob?.id === scan.id) {
    const reading = ideasJob.stage === "analyse";
    out.push(el("section", { class: "ideas-loading card", "aria-busy": "true" },
      el("h2", { class: "scan-h2" }, reading ? "Claude lit le relevé…" : "Idées en préparation…"),
      el("p", {}, reading
        ? `Claude écarte les posts hors sujet, lit les accroches et le texte à l'écran des meilleurs visuels, puis dégage les tendances. Environ 30 secondes.`
        : "Claude croise les posts qui sur-performent, leur mécanisme, la veille de la semaine et ton historique pour écrire des idées prêtes à tourner. Compte 30 secondes à 2 minutes."),
      el("div", { class: "ideas-skel", "aria-hidden": "true" }, [0, 1].map(() => el("div", { class: "skeleton sk-idea" }))),
    ));
  } else if (scan.ideasError) {
    out.push(alertBox("Les idées n'ont pas pu être générées.", scan.ideasError, [["Réessayer", () => makeIdeas(), true]]));
  } else if (scan.ideas?.items?.length) {
    out.push(el("section", { "aria-labelledby": "ideas-list-title" },
      el("h2", { class: "scan-h2", id: "ideas-list-title" }, "Idées à publier"),
      el("div", { class: "ideas" }, scan.ideas.items.map((idea, i) => ideaCard(idea, i, scan, reveal))),
    ));
  }

  out.push(researchBlock(scan));

  // Tendances : celles que Claude a dégagées, puis les hashtags et sons repris par plusieurs créateurs.
  const aiTrends = scan.analysis?.tendances || [];
  const avoid = scan.analysis?.a_eviter || [];
  if (aiTrends.length || scan.clusters?.length) {
    out.push(el("section", { class: "trends card", "aria-labelledby": "trends-title" },
      el("div", { class: "fronts-head" },
        el("h2", { class: "section-title", id: "trends-title" }, "Tendances détectées"),
        el("span", { class: "hint" }, aiTrends.length ? "Formats, accroches et sujets repérés par Claude dans le relevé" : "Hashtags et sons repris par plusieurs créateurs ou sur plusieurs réseaux"),
      ),
      aiTrends.length ? el("ul", { class: "ai-trends" }, aiTrends.map((t) => aiTrendItem(t, scan))) : null,
      scan.clusters?.length
        ? [aiTrends.length ? el("h3", { class: "trends-sub" }, "Hashtags et sons repris") : null, el("ul", { class: "trend-rows" }, scan.clusters.slice(0, 6).map(clusterRow))]
        : null,
      avoid.length ? el("div", { class: "avoid" }, el("span", { class: "label" }, "À éviter cette semaine"), el("ul", { class: "veille-list" }, avoid.map((a) => el("li", {}, a)))) : null,
    ));
  }

  // Posts qui sur-performent
  if (posts.length) {
    const chips = el("div", { class: "net-filter", role: "group", "aria-label": "Filtrer par réseau" },
      [["all", "Tous"], ...nets.map((n) => [n, NETS[n].name])].map(([v, label]) =>
        el("button", { type: "button", class: "chip-btn", id: `net-chip-${v}`, "aria-pressed": String(filter === v), onclick: () => { state.netFilter = v === "all" ? null : v; renderScan(state.scan); } }, label),
      ),
    );
    const help = disclosure("Comment le score est calculé",
        el("div", { class: "analysis" },
          el("p", {}, "Le score de viralité (0 à 100) combine trois mesures : de combien le post dépasse l'audience habituelle de son auteur (abonnés, moyenne de ses posts), la qualité de l'engagement (les partages et enregistrements comptent plus que les likes) et la vitesse depuis la publication : un post récent qui monte vite passe devant un post plus ancien."),
          el("p", {}, "« Reproductible » signale un petit compte (moins de 50 000 abonnés) qui fait au moins 5 fois mieux que d'habitude : son mécanisme ne dépend pas de sa notoriété. Sur LinkedIn, les abonnés ne sont pas publics : le post est comparé aux autres posts du relevé."),
          scan.analysis ? el("p", {}, `Claude a ensuite lu les ${scan.analysis.analysed} meilleurs posts${scan.analysis.images ? ` et ${plural(scan.analysis.images, "visuel", "visuels")}` : ""} : format, type d'accroche, texte à l'écran et mécanisme ; ${plural(scan.analysis.horsSujet, "post hors sujet est masqué", "posts hors sujet sont masqués")}${scan.analysis.etrangers ? `, ${plural(scan.analysis.etrangers, "post non francophone retiré", "posts non francophones retirés")}` : ""}.`) : null,
          scan.queries ? el("p", {}, `Requêtes utilisées${scan.research ? " (préparées par Claude d'après la veille)" : ""} — TikTok : ${scan.queries.tiktok.join(", ")} · Instagram : ${scan.queries.instagram} · X : ${scan.queries.x} · LinkedIn : ${scan.queries.linkedin.join(", ")}.`) : null,
        ));
    help.open = Boolean(state.scoreHelpOpen);
    help.addEventListener("toggle", () => (state.scoreHelpOpen = help.open));
    out.push(el("section", { "aria-labelledby": "signals-title" },
      el("div", { class: "signals-head" }, el("h2", { class: "scan-h2", id: "signals-title" }, strong.length >= 3 ? "Posts qui sur-performent" : "Meilleurs posts du relevé"), chips),
      el("ol", { class: "signals card" }, shown.map(signalRow)),
      hidden ? el("p", { class: "signals-note" }, `${plural(hidden, "post hors sujet masqué", "posts hors sujet masqués")} par Claude.`) : null,
      help,
    ));
  } else if (!scan.ideas?.items?.length) {
    out.push(el("div", { class: "empty card" },
      el("h2", {}, "Aucun post relevé"),
      el("p", {}, state.health?.hasApifyToken ? "Les réseaux n'ont rien renvoyé pour cette niche cette semaine. Essaie un terme plus courant." : "Ajoute un jeton Apify pour relever TikTok, Instagram, X et LinkedIn."),
    ));
  }
  out.push(topicsBlock(scan.external));
  // Le focus reste où il était (titre, puce de filtre) ; après un scan lancé au clavier, il va au titre.
  const body = $("#scan-body");
  const keep = body.contains(document.activeElement) ? document.activeElement.id : null;
  body.replaceChildren(...out.filter(Boolean));
  const again = keep && document.getElementById(keep);
  if (again) again.focus({ preventScroll: true });
  else if (state.scanFocus && state.route.view === "idees" && (!document.activeElement || document.activeElement === document.body || document.activeElement.id === "btn-scan")) {
    $("#scan-result-title")?.focus({ preventScroll: true });
    state.scanFocus = false;
  }
}

/* =========================================================================
   Radar
   ========================================================================= */

let radarSearched = false;

function renderRadarIdle() {
  if (radarSearched) return;
  const niches = [...new Set(state.entries.map((e) => e.brief?.niche).filter(Boolean))].slice(0, 2);
  const ideas = [...niches, ...RADAR_IDEAS].slice(0, 5);
  $("#radar-results").replaceChildren(
    el("div", { class: "radar-suggest" },
      el("span", {}, "Essaie :"),
      ideas.map((q) => el("button", { type: "button", class: "chip-btn", onclick: () => runRadar(q) }, q)),
    ),
  );
}

async function runRadar(q) {
  const query = String(q).trim();
  if (!query) return;
  $("#radar-q").value = query;
  radarSearched = true;
  const box = $("#radar-results");
  const btn = $("#radar-submit");
  btn.disabled = true;
  btn.dataset.busy = "true";
  box.setAttribute("aria-busy", "true");
  box.replaceChildren(
    el("p", { class: "sr-only" }, "Scan en cours…"),
    el("div", { class: "radar-grid", "aria-hidden": "true" },
      [0, 1, 2].map(() =>
        el("div", { class: "radar-source card" },
          el("div", { class: "skeleton sk-title" }),
          [0, 1, 2, 3, 4].map(() => el("div", { class: "skeleton sk-line" })),
        ),
      ),
    ),
  );
  try {
    const trends = await api(`/api/trends?q=${encodeURIComponent(query)}`);
    const sources = Object.values(trends.sources || {});
    const total = sources.reduce((n, s) => n + s.items.length, 0);
    if (!sources.length) {
      box.replaceChildren(
        el("p", { class: "radar-empty" }, "Aucune source n'a répondu pour ce sujet. Essaie un mot-clé plus large."),
        errorsLine(trends),
      );
    } else {
      box.replaceChildren(
        el("p", { class: "radar-meta hint" },
          `${plural(total, "signal", "signaux")} sur ${plural(sources.length, "source", "sources")} · relevés à ${timeOf(trends.fetchedAt || new Date().toISOString())}`),
        el("div", { class: "radar-grid" },
          sources.map((s, i) =>
            el("section", { class: "radar-source card enter", vars: { "--i": i }, "aria-label": s.label },
              el("div", { class: "radar-source-head" }, el("h2", {}, s.label), el("span", {}, plural(s.items.length, "signal", "signaux"))),
              el("ul", { class: "radar-items" }, s.items.slice(0, 10).map((it) => sourceItem(it, "radar-item"))),
            ),
          ),
        ),
        errorsLine(trends),
      );
    }
  } catch (err) {
    box.replaceChildren(alertBox("Le scan n'a pas abouti.", err.message, [["Réessayer", () => runRadar(query), true]]));
  } finally {
    btn.disabled = false;
    delete btn.dataset.busy;
    box.removeAttribute("aria-busy");
  }
}

/* =========================================================================
   Historique
   ========================================================================= */

let historySignature = "";

async function loadHistoryView() {
  if (state.entriesLoaded) renderHistory();
  else {
    $("#calibration").replaceChildren();
    $("#history-list").replaceChildren(
      ...[0, 1, 2].map(() => el("div", { class: "h-entry h-skeleton", "aria-hidden": "true" }, el("div", { class: "skeleton sk-line" }))),
    );
  }
  await Promise.all([loadEntries(), state.settings ? null : loadSettingsData()]);
  if (state.route.view !== "historique") return;
  const signature = JSON.stringify(state.entries.map((e) => [e.id, e.realStats, platformsOf(e).map((p) => e.scripts[p].score?.final)]));
  if (signature !== historySignature || !$("#history-list").querySelector(".h-entry:not(.h-skeleton), .empty, .alert")) {
    renderHistory();
  }
}

function renderHistory() {
  historySignature = JSON.stringify(state.entries.map((e) => [e.id, e.realStats, platformsOf(e).map((p) => e.scripts[p].score?.final)]));
  const list = $("#history-list");
  const cal = $("#calibration");
  if (state.entriesError && !state.entriesLoaded) {
    cal.replaceChildren();
    list.replaceChildren(alertBox("Historique indisponible.", state.entriesError, [["Réessayer", () => loadHistoryView(), true]]));
    return;
  }
  if (!state.entries.length) {
    cal.replaceChildren();
    list.replaceChildren(
      el("div", { class: "empty card" },
        el("h2", {}, "Aucune prévision pour l'instant"),
        el("p", {}, "Lance ta première prévision : elle apparaîtra ici, prête à être comparée à tes vues réelles après publication."),
        el("a", { class: "btn btn-primary", href: "#creer" }, "Créer une prévision"),
      ),
    );
    return;
  }
  const c = state.calibration || { n: 0 };
  const filled = c.n ? Math.round((c.adjacent || 0) / 10) : 0;
  cal.replaceChildren(
    el("div", { class: "calib-meter", "aria-hidden": "true" }, Array.from({ length: 10 }, (_, i) => el("i", { class: i < filled ? "f" : null }))),
    c.n
      ? el("p", {},
          "Sur ", el("strong", {}, plural(c.n, "relevé", "relevés")),
          ", Amorce a vu juste à une bande près ", el("strong", {}, `${c.adjacent} %`),
          " du temps, dont ", el("strong", {}, `${c.exact} %`), " dans la bande exacte.")
      : el("p", {}, "Aucun relevé pour l'instant. Après publication, saisis les vues réelles d'un post : Amorce comparera la prévision à ce qui s'est passé et mesurera sa fiabilité."),
    c.n && state.entries.some((e) => e.demo && Object.keys(e.realStats || {}).length)
      ? el("span", { class: "tag-demo" }, "Inclut l'exemple")
      : null,
  );
  list.replaceChildren(...state.entries.map(historyEntry));
}

function historyEntry(entry) {
  const open = state.openHistory.has(entry.id);
  const pfs = platformsOf(entry);
  const art = el("article", { class: "h-entry", "data-open": String(open) });
  const sub = [dateOf(entry.createdAt), entry.brief.niche].filter(Boolean).join(" · ");
  const row = el("button", { type: "button", class: "h-row", "aria-expanded": String(open), "aria-controls": `h-detail-${entry.id}` },
    el("span", { class: "h-main" },
      el("span", { class: "h-idea" }, entry.brief.idea),
      el("span", { class: "h-sub" }, entry.demo ? [el("span", { class: "tag-demo" }, "Exemple"), " "] : null, sub),
    ),
    el("span", { class: "h-pfs" },
      pfs.length
        ? pfs.map((p) => {
            const sc = entry.scripts[p].score || {};
            const real = entry.realStats?.[p];
            return el("span", { class: "h-pf" },
              PF[p].name,
              isJudged(sc) ? tchip(sc.final, heatOf(sc.final), true) : tchip(null, null, true),
              real && BANDS[real.band]
                ? [svg("arrow", "ico arrow"), el("span", { class: "sr-only" }, " relevé "), el("b", {}, BANDS[real.band].label)]
                : null,
            );
          })
        : el("span", { class: "h-pf" }, "Angles proposés, script à écrire"),
    ),
    svg("chev", "ico h-chev"),
  );
  row.addEventListener("click", () => {
    const next = row.getAttribute("aria-expanded") !== "true";
    if (next) state.openHistory.add(entry.id);
    else state.openHistory.delete(entry.id);
    row.setAttribute("aria-expanded", String(next));
    art.dataset.open = String(next);
    art.querySelector(".h-detail")?.remove();
    if (next) art.append(historyDetail(state.entries.find((e) => e.id === entry.id) || entry));
  });
  art.append(row);
  if (open) art.append(historyDetail(entry));
  return art;
}

function historyDetail(entry) {
  const pfs = platformsOf(entry);
  const detail = el("div", { class: "h-detail enter", id: `h-detail-${entry.id}` },
    el("header", { class: "h-detail-head" },
      el("span", {}, entry.chosenAngle ? ["Angle ", el("q", {}, entry.chosenAngle.titre)] : "Aucun angle choisi pour l'instant"),
      el("a", { class: "btn", href: `#prevision/${entry.id}` }, entry.scripts ? "Ouvrir le bulletin" : "Choisir un angle", svg("arrow")),
    ),
  );
  for (const p of pfs) {
    const real = entry.realStats?.[p];
    detail.append(
      el("div", { class: "h-pf-block" },
        el("span", { class: "h-pf-name" }, PF[p].name),
        real && BANDS[real.band] ? vsLine(entry, p, real) : statForm(entry, p),
      ),
    );
  }
  return detail;
}

function vsLine(entry, p, real) {
  const sc = entry.scripts[p].score || {};
  return el("div", { class: "vs" },
    el("span", {}, "Prévu ", el("b", {}, isJudged(sc) ? BANDS[sc.bande].label : "—")),
    el("span", { class: "meta-sep", "aria-hidden": "true" }),
    el("span", {}, "Relevé ", el("b", {}, BANDS[real.band].label)),
    el("span", { class: "meta-sep", "aria-hidden": "true" }),
    el("span", {}, `${fmt(real.views)} vues, ×${fmtRatio(real.ratio)} ta médiane (${fmt(real.medianViews)})`),
    matchBadge(sc.bande, real.band),
  );
}

function statForm(entry, p) {
  const median = state.settings?.medianViews?.[p] || "";
  const field = (name, label, value = "") =>
    el("label", { class: "stat-input" },
      el("span", {}, label),
      el("input", { type: "number", name, min: "0", step: "1", inputmode: "numeric", value }),
    );
  const error = el("p", { class: "stat-err", role: "alert", hidden: true });
  const submit = el("button", { type: "submit", class: "btn" }, "Enregistrer le relevé");
  const form = el("form", { class: "stat-form", novalidate: true, "aria-label": `Relevé ${PF[p].name}` },
    field("views", "Vues"),
    field("likes", "Likes"),
    field("comments", "Commentaires"),
    field("median", "Tes vues médianes", median),
    submit,
    error,
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const fail = (message, name) => {
      error.textContent = message;
      error.hidden = false;
      form.elements[name]?.focus();
    };
    if (data.views === "" || !(Number(data.views) >= 0)) return fail("Renseigne le nombre de vues (0 ou plus).", "views");
    if (!(Number(data.median) > 0)) return fail("Renseigne tes vues médianes habituelles : elles servent à situer ce post par rapport à toi.", "median");
    error.hidden = true;
    submit.disabled = true;
    try {
      const res = await post("/api/stats", {
        id: entry.id,
        platform: p,
        views: data.views,
        likes: data.likes,
        comments: data.comments,
        medianViews: data.median,
      });
      upsertEntry(res.entry);
      state.calibration = res.calibration;
      if (state.settings) state.settings.medianViews = { ...state.settings.medianViews, [p]: Number(data.median) };
      state.openHistory.add(entry.id);
      renderHistory();
      $(`[aria-controls="h-detail-${entry.id}"]`)?.focus();
      const real = res.entry.realStats[p];
      toast(`Relevé ${PF[p].name} enregistré : ${BANDS[real.band].label} (×${fmtRatio(real.ratio)} ta médiane).`);
    } catch (err) {
      submit.disabled = false;
      fail(err.message);
    }
  });
  return form;
}

/* =========================================================================
   Réglages & état du système
   ========================================================================= */

async function loadSettingsView() {
  renderEnv();
  if (state.health?.hasApifyToken && !state.apify) {
    api("/api/social/account").then((a) => {
      state.apify = a;
      if (state.route.view === "reglages") renderEnv();
    }).catch(() => {});
  }
  const settings = await loadSettingsData();
  if (state.route.view !== "reglages") return;
  const form = $("#settings-form");
  if (form.contains(document.activeElement) && form.dataset.filled) return;
  $("#s-voice").value = settings.voice || "";
  $("#s-autoscan").checked = Boolean(settings.autoScan);
  $("#s-profile-help").textContent = settings.profile?.niche
    ? `Niche suivie : « ${settings.profile.niche} » (modifiable depuis « Idées »).`
    : "Niche suivie : définie au premier scan depuis « Idées ».";
  $("#medians-grid").replaceChildren(
    ...PLATFORMS.map((p) =>
      el("label", { class: "median-field" },
        el("span", {}, svg(PF[p].icon, "ico pf-ico"), PF[p].name),
        el("input", {
          type: "number", min: "0", step: "1", inputmode: "numeric", id: `s-median-${p}`,
          placeholder: "ex. 1 500", value: settings.medianViews?.[p] || "",
        }),
      ),
    ),
  );
  form.dataset.filled = "true";
}

function initSettings() {
  $("#settings-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const medianViews = {};
    for (const p of PLATFORMS) {
      const v = Number($(`#s-median-${p}`)?.value);
      // 0 explicite pour un champ vidé : efface une médiane enregistrée.
      medianViews[p] = Number.isFinite(v) && v > 0 ? v : 0;
    }
    const btn = ev.submitter || $("#settings-form button[type=submit]");
    btn.disabled = true;
    try {
      state.settings = await post("/api/settings", { voice: $("#s-voice").value, medianViews, autoScan: $("#s-autoscan").checked });
      const saved = $("#settings-saved");
      saved.classList.remove("hidden");
      setTimeout(() => saved.classList.add("hidden"), 2400);
    } catch (err) {
      toast(`Enregistrement impossible : ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

function apifyText(a) {
  const plan = a.plan ? `offre ${a.plan.toLowerCase()}` : null;
  const credit = a.remainingUsd !== null && a.remainingUsd !== undefined
    ? `${a.remainingUsd.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} $ de crédit restant ce mois-ci`
    : null;
  const xNote = a.free ? "X en mode réduit (sans vues) sur l'offre gratuite" : null;
  return ["Présent", plan, credit, xNote].filter(Boolean).join(" · ");
}

function renderEnv() {
  const h = state.health;
  const dl = $("#env-info");
  if (!state.healthLoaded) {
    dl.replaceChildren(el("dt", {}, "Serveur"), el("dd", {}, "Vérification…"));
    return;
  }
  if (!h) {
    dl.replaceChildren(el("dt", {}, "Serveur"), el("dd", { class: "bad" }, "Injoignable : vérifie que l'application tourne."));
    return;
  }
  const where = h.deployed ? "les variables d'environnement Vercel" : "le fichier .env";
  const storage = {
    redis: ["Redis, persistant", "good"],
    fichiers: ["Fichiers locaux (data/)", "good"],
    temporaire: ["Temporaire : effacé à chaque redémarrage. Ajoute Upstash Redis au projet Vercel (voir README).", "bad"],
  }[h.storage] || [h.storage, null];
  const rows = [
    ["Modèle d'écriture", `${h.model} · effort ${h.effort}`, null],
    ...(h.ai ? [["Claude dans « Idées »", `Lecture des posts : ${h.ai.analysisModel} · veille web ${h.ai.webResearch ? "activée" : "désactivée (CLAUDE_WEB_RESEARCH)"}`, null]] : []),
    ["Clé Anthropic", h.hasAnthropicKey ? "Présente" : `Absente : ajoute ANTHROPIC_API_KEY dans ${where}`, h.hasAnthropicKey ? "good" : "bad"],
    ["Clé YouTube", h.hasYoutubeKey ? "Présente" : "Absente (facultative : ajoute YOUTUBE_API_KEY pour YouTube et YouTube Shorts)", h.hasYoutubeKey ? "good" : null],
    ["Jeton Apify", h.hasApifyToken ? (state.apify ? apifyText(state.apify) : "Présent") : `Absent : ajoute APIFY_TOKEN dans ${where} pour scanner TikTok, Instagram, X et LinkedIn`, h.hasApifyToken ? "good" : "bad"],
    ["Historique", storage[0], storage[1]],
    ["Pays des tendances", h.geo, null],
  ];
  if (h.deployed) {
    rows.push(["Accès", "Vérifie que Settings → Deployment Protection → « All Deployments » est activé sur Vercel : sans protection, n'importe qui avec l'URL utilise ta clé.", null]);
  }
  dl.replaceChildren(...rows.flatMap(([k, v, cls]) => [el("dt", {}, k), el("dd", { class: cls }, v)]));
}

async function loadHealth() {
  try {
    state.health = await api("/api/health");
  } catch {
    state.health = null;
  }
  state.healthLoaded = true;
  const status = $("#shell-status");
  const text = $("#shell-status-text");
  const h = state.health;
  let s = ["err", "Serveur injoignable"];
  if (h && !h.hasAnthropicKey) s = ["err", "Clé API manquante"];
  else if (h && h.storage === "temporaire") s = ["warn", "Historique temporaire"];
  else if (h) s = ["ok", "Prêt · historique sauvegardé"];
  status.dataset.state = s[0];
  text.textContent = s[1];
  status.setAttribute("aria-label", `État : ${s[1]}. Ouvrir les réglages`);

  const notice = $("#global-notice");
  if (h && !h.hasAnthropicKey) {
    const where = h.deployed ? "les variables d'environnement Vercel, puis redéploie" : "le fichier .env, puis relance l'application";
    notice.replaceChildren(
      el("strong", {}, "Clé API Anthropic absente. "),
      `La prévision ne peut pas tourner : ajoute ANTHROPIC_API_KEY dans ${where}. `,
      el("a", { href: "#reglages" }, "Voir l'état du système"),
    );
    notice.classList.remove("hidden");
  } else notice.classList.add("hidden");
  if (state.route.view === "reglages") renderEnv();
  if (state.route.view === "idees") {
    renderScanNotice();
    renderScanNetworks();
  }
}

/* =========================================================================
   Révélations au défilement (section « Comment Amorce prévoit »)
   ========================================================================= */

function initReveal() {
  const items = [...document.querySelectorAll(".reveal")];
  if (!("IntersectionObserver" in window)) {
    items.forEach((n) => n.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver(
    (records) => {
      let k = 0;
      for (const r of records) {
        if (!r.isIntersecting) continue;
        r.target.style.setProperty("--i", k++);
        r.target.classList.add("is-in");
        io.unobserve(r.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.15 },
  );
  items.forEach((n) => io.observe(n));
}

/* =========================================================================
   Démarrage
   ========================================================================= */

function init() {
  initBrief();
  initIdeas();
  initSettings();
  initReveal();
  $("#radar-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    runRadar($("#radar-q").value);
  });
  window.addEventListener("hashchange", () => transition(() => applyRoute({ focus: true })));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !state.dropOnShow) return;
    const id = state.dropOnShow;
    state.dropOnShow = null;
    const panel = $("#bulletin-panel");
    if (isViewingFlow(id) && panel) dropBulletin(panel);
  });
  // Horloge des générations longues (texte seul, pas d'annonce lecteur d'écran).
  setInterval(() => {
    if (state.job) {
      const t = clockText();
      document.querySelectorAll("[data-clock]").forEach((n) => (n.textContent = t));
    }
    if (scanPolling || state.scanPending) document.querySelectorAll("[data-scan-clock]").forEach((n) => (n.textContent = scanClock()));
  }, 1000);

  applyRoute();
  loadHealth();
  loadEntries().then(() => {
    if (state.route.view === "radar") renderRadarIdle();
  });
}

init();
