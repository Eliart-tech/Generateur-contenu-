/* Générateur de contenu — frontend (vanilla JS, aucune dépendance). */
"use strict";

const PLATFORM_LABELS = { linkedin: "LinkedIn", reels: "Reels", x: "X", youtube: "YouTube" };
const BAND_LABELS = {
  top10: "Top 10 % potentiel",
  top25: "Top 25 % potentiel",
  top50: "Top 50 % potentiel",
  moitie_basse: "Sous la médiane",
};
const FACTOR_LABELS = {
  hook: "Hook",
  structure: "Structure",
  adequation_tendance: "Adéquation tendance",
  emotion: "Émotion",
  cta: "Appel à l'action",
};
const TYPE_LABELS = {
  contrarian: "contrarian",
  storytelling: "storytelling",
  liste: "liste",
  educatif: "éducatif",
  reaction: "réaction",
  etude_de_cas: "étude de cas",
};

let currentEntry = null;

/* ---------- utilitaires DOM ---------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function show(id) { document.getElementById(id).classList.remove("hidden"); }
function hide(id) { document.getElementById(id).classList.add("hidden"); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setLoading(text) {
  if (text) {
    document.getElementById("loading-text").textContent = text;
    show("create-loading");
  } else hide("create-loading");
  hide("create-error");
}

function setError(message) {
  hide("create-loading");
  const box = document.getElementById("create-error");
  box.textContent = message;
  show("create-error");
}

/* ---------- onglets ---------- */

document.getElementById("main-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === btn));
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`),
  );
  if (btn.dataset.tab === "history") loadHistory();
  if (btn.dataset.tab === "settings") loadSettings();
});

/* ---------- santé ---------- */

async function loadHealth() {
  try {
    const h = await api("/api/health");
    const bits = [`modèle ${h.model}`, `tendances ${h.geo}`];
    if (!h.hasAnthropicKey) bits.push("⚠ clé API manquante (.env)");
    document.getElementById("status-line").textContent = bits.join(" · ");
    const env = document.getElementById("env-info");
    env.textContent = "";
    env.append(
      el("p", {}, `Modèle : ${h.model} (effort ${h.effort}) — modifiable via CLAUDE_MODEL / CLAUDE_EFFORT dans .env`),
      el("p", {}, `Clé Anthropic : ${h.hasAnthropicKey ? "présente ✓" : "absente ✗ (obligatoire)"}`),
      el("p", {}, `Clé YouTube : ${h.hasYoutubeKey ? "présente ✓" : "absente (source optionnelle du radar)"}`),
    );
  } catch {
    document.getElementById("status-line").textContent = "Serveur injoignable";
  }
}

/* ---------- étape 1 : brief → angles ---------- */

document.getElementById("brief-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const platforms = [...document.querySelectorAll('input[name="platform"]:checked')].map((c) => c.value);
  const payload = {
    idea: document.getElementById("f-idea").value,
    niche: document.getElementById("f-niche").value,
    audience: document.getElementById("f-audience").value,
    goal: document.getElementById("f-goal").value,
    platforms,
  };
  const btn = document.getElementById("btn-angles");
  btn.disabled = true;
  setLoading("Collecte des tendances (Google Trends, actualité, YouTube, Reddit…) puis proposition d'angles…");
  hide("step-angles");
  hide("step-scripts");
  try {
    currentEntry = await api("/api/angles", { method: "POST", body: JSON.stringify(payload) });
    renderAngles(currentEntry);
    setLoading(null);
    show("step-angles");
  } catch (err) {
    setError(err.message);
  } finally {
    btn.disabled = false;
  }
});

function renderTrendSources(trends, container) {
  container.textContent = "";
  const sources = Object.values(trends?.sources || {});
  if (!sources.length) {
    container.append(el("p", { class: "muted" }, "Aucune source de tendances n'a répondu (réseau ? clés ?). Les angles reposeront sur le brief seul."));
  }
  for (const source of sources) {
    const list = el("ul", {}, source.items.slice(0, 8).map((it) =>
      el("li", {},
        it.url ? el("a", { href: it.url, target: "_blank", rel: "noopener" }, it.title) : it.title,
        " ",
        el("span", { class: "sig" }, it.signal || ""),
      ),
    ));
    container.append(el("details", { class: "trend-source" }, el("summary", {}, `${source.label} (${source.items.length})`), list));
  }
  for (const err of trends?.errors || []) {
    container.append(el("p", { class: "muted small" }, `· ${err.source} indisponible : ${err.error}`));
  }
}

function renderAngles(entry) {
  const trendsCard = document.getElementById("trends-card");
  trendsCard.textContent = "";
  trendsCard.append(el("h2", {}, "2 · Ce que disent les réseaux en ce moment"));
  renderTrendSources(entry.trends, trendsCard.appendChild(el("div")));

  const retained = entry.angles?.tendances_retenues || [];
  if (retained.length) {
    trendsCard.append(el("h3", {}, "Tendances retenues pour ton idée"));
    trendsCard.append(el("div", { class: "chips" }, retained.map((t) =>
      el("span", { class: "chip", title: t.pourquoi }, `${t.titre} · ${t.source}`),
    )));
  }

  const anglesCard = document.getElementById("angles-card");
  anglesCard.textContent = "";
  anglesCard.append(el("h2", {}, "3 · Choisis un angle"));
  (entry.angles?.angles || []).forEach((angle, i) => {
    anglesCard.append(
      el("div", { class: "angle" },
        el("div", { class: "angle-head" },
          el("strong", {}, angle.titre),
          el("span", { class: "badge" }, TYPE_LABELS[angle.type] || angle.type),
        ),
        el("p", { class: "hook" }, `« ${angle.accroche} »`),
        el("p", { class: "why" }, angle.justification),
        el("div", { class: "angle-foot" },
          el("div", { class: "meter", title: `Adéquation tendances : ${angle.score_tendance}/100` },
            el("div", { style: `width:${angle.score_tendance}%` }),
          ),
          el("button", { class: "primary", onclick: () => generateScripts(i) }, "Choisir cet angle →"),
        ),
      ),
    );
  });
}

/* ---------- étape 2 : scripts + scores ---------- */

async function generateScripts(angleIndex) {
  setLoading("Écriture des scripts par plateforme, puis évaluation critique (2 passes IA)…");
  hide("step-scripts");
  try {
    currentEntry = await api("/api/scripts", {
      method: "POST",
      body: JSON.stringify({ id: currentEntry.id, angleIndex }),
    });
    renderScripts(currentEntry);
    setLoading(null);
    show("step-scripts");
    document.getElementById("step-scripts").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    setError(err.message);
  }
}

function scorePanel(script) {
  const score = script.score || {};
  const panel = el("div", { class: "score-panel" });
  panel.append(
    el("div", { class: "score-big" },
      el("div", { class: "n" }, String(score.final ?? "—")),
      score.bande ? el("span", { class: `band ${score.bande}` }, BAND_LABELS[score.bande]) : null,
      el("div", { class: "sub" }, score.confiance ? `confiance ${score.confiance}` : ""),
    ),
  );

  const right = el("div");
  for (const f of score.facteurs || []) {
    right.append(
      el("div", { class: "factor" },
        el("span", {}, FACTOR_LABELS[f.nom] || f.nom),
        el("div", { class: "meter" }, el("div", { style: `width:${f.score}%` })),
        el("span", { class: "val" }, String(f.score)),
        el("div", { class: "factor-comment" }, f.commentaire),
      ),
    );
  }
  const heur = score.heuristique;
  if (heur) {
    right.append(
      el("div", { class: "factor" },
        el("span", {}, "Conformité du format"),
        el("div", { class: "meter" }, el("div", { style: `width:${heur.global}%` })),
        el("span", { class: "val" }, String(heur.global)),
      ),
    );
    if (heur.flags?.length) {
      right.append(el("ul", { class: "flags" }, heur.flags.map((f) => el("li", {}, f))));
    }
  }
  panel.append(right);
  return panel;
}

function renderScripts(entry) {
  const container = document.getElementById("step-scripts");
  container.textContent = "";
  const card = el("div", { class: "card" });
  card.append(
    el("h2", {}, "4 · Tes scripts, notés avant publication"),
    el("p", { class: "muted small" },
      "Le score est un potentiel relatif (jamais une promesse de vues) : il combine une évaluation critique IA et la conformité aux codes du format. ",
      "Après publication, saisis tes stats réelles dans l'Historique pour vérifier la prédiction."),
  );

  const platforms = Object.keys(entry.scripts || {});
  const tabsBar = el("div", { class: "script-tabs" });
  const panels = {};

  platforms.forEach((p, idx) => {
    const script = entry.scripts[p];
    const tabBtn = el("button", { class: `script-tab${idx === 0 ? " active" : ""}` },
      PLATFORM_LABELS[p] || p,
      el("span", { class: "score-pill" }, String(script.score?.final ?? "")),
    );
    tabBtn.addEventListener("click", () => {
      tabsBar.querySelectorAll(".script-tab").forEach((b) => b.classList.toggle("active", b === tabBtn));
      Object.entries(panels).forEach(([key, node]) => node.classList.toggle("hidden", key !== p));
    });
    tabsBar.append(tabBtn);

    const panel = el("div", { class: idx === 0 ? "" : "hidden" });
    panel.append(scorePanel(script));
    if (script.score?.comparaison) {
      panel.append(el("p", { class: "comparison" }, script.score.comparaison));
    }
    if (script.titre) panel.append(el("h3", {}, script.titre));
    panel.append(el("div", { class: "script-content" }, script.contenu));
    if (script.hashtags?.length) {
      panel.append(el("div", { class: "chips" }, script.hashtags.map((h) =>
        el("span", { class: "chip" }, h.startsWith("#") ? h : `#${h}`),
      )));
    }
    if (script.score?.suggestions?.length) {
      panel.append(el("h3", {}, "Pour gagner des points"));
      panel.append(el("ol", { class: "suggestions" }, script.score.suggestions.map((s) => el("li", {}, s))));
    }
    const copyBtn = el("button", { class: "ghost" }, "Copier le script");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(`${script.titre ? script.titre + "\n\n" : ""}${script.contenu}`);
      copyBtn.textContent = "Copié ✓";
      setTimeout(() => (copyBtn.textContent = "Copier le script"), 1500);
    });
    const rewriteBtn = el("button", { class: "primary" }, "Réécrire selon les suggestions");
    rewriteBtn.addEventListener("click", () => rewrite(p));
    panel.append(el("div", { class: "script-actions" }, copyBtn, rewriteBtn));
    panels[p] = panel;
  });

  card.append(tabsBar);
  platforms.forEach((p) => card.append(panels[p]));
  container.append(card);
}

async function rewrite(platform) {
  setLoading(`Réécriture du script ${PLATFORM_LABELS[platform]} puis réévaluation…`);
  try {
    currentEntry = await api("/api/rewrite", {
      method: "POST",
      body: JSON.stringify({ id: currentEntry.id, platform }),
    });
    renderScripts(currentEntry);
    setLoading(null);
  } catch (err) {
    setError(err.message);
  }
}

/* ---------- radar ---------- */

document.getElementById("radar-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = document.getElementById("radar-q").value.trim();
  const box = document.getElementById("radar-results");
  box.textContent = "";
  box.append(el("p", { class: "muted" }, "Scan en cours…"));
  try {
    const trends = await api(`/api/trends?q=${encodeURIComponent(q)}`);
    box.textContent = "";
    renderTrendSources(trends, box);
    box.querySelectorAll("details").forEach((d) => (d.open = true));
  } catch (err) {
    box.textContent = "";
    box.append(el("p", { class: "error" }, err.message));
  }
});

/* ---------- historique & calibration ---------- */

async function loadHistory() {
  const list = document.getElementById("history-list");
  const banner = document.getElementById("calibration-banner");
  list.textContent = "";
  banner.textContent = "";
  let data;
  try {
    data = await api("/api/history");
  } catch (err) {
    list.append(el("p", { class: "error" }, err.message));
    return;
  }

  const cal = data.calibration;
  banner.append(
    el("div", { class: "banner" },
      cal.n
        ? `Calibration sur ${cal.n} post(s) mesuré(s) : ${cal.exact} % de bandes exactes, ${cal.adjacent} % à ±1 bande.`
        : "Aucun post mesuré pour l'instant — publie un script puis saisis ses stats ici.",
    ),
  );

  if (!data.entries.length) {
    list.append(el("p", { class: "muted" }, "Aucune génération pour l'instant."));
    return;
  }

  const settings = await api("/api/settings").catch(() => ({ medianViews: {} }));

  for (const entry of data.entries) {
    const card = el("div", { class: "card history-entry" });
    const date = new Date(entry.createdAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
    const body = el("div", { class: "hidden" });
    const head = el("div", { class: "history-head", onclick: () => body.classList.toggle("hidden") },
      el("h3", {}, entry.brief.idea.slice(0, 90) + (entry.brief.idea.length > 90 ? "…" : "")),
      el("span", { class: "muted small" }, date),
    );
    card.append(head);

    const platRow = el("div", { class: "history-platforms" });
    for (const [p, script] of Object.entries(entry.scripts || {})) {
      const real = entry.realStats?.[p];
      platRow.append(
        el("span", { class: "chip" },
          `${PLATFORM_LABELS[p]} · ${script.score?.final ?? "—"}`,
          script.score?.bande ? el("span", { class: `band ${script.score.bande}`, style: "margin-left:6px" }, BAND_LABELS[script.score.bande]) : null,
          real ? ` → réel : ×${real.ratio}` : null,
        ),
      );
    }
    card.append(platRow);

    if (entry.chosenAngle) body.append(el("p", { class: "muted small" }, `Angle : ${entry.chosenAngle.titre}`));

    for (const [p, script] of Object.entries(entry.scripts || {})) {
      body.append(el("h3", {}, PLATFORM_LABELS[p] || p));
      body.append(el("div", { class: "script-content" }, `${script.titre ? script.titre + "\n\n" : ""}${script.contenu}`));
      const real = entry.realStats?.[p];
      if (real) {
        body.append(
          el("div", { class: "vs" },
            el("span", {}, "Prédit :"),
            el("span", { class: `band ${script.score?.bande || "top50"}` }, BAND_LABELS[script.score?.bande] || "—"),
            el("span", {}, "Observé :"),
            el("span", { class: `band ${real.band}` }, BAND_LABELS[real.band]),
            el("span", { class: "muted small" }, `${real.views.toLocaleString("fr-FR")} vues, ×${real.ratio} vs ta médiane (${real.medianViews.toLocaleString("fr-FR")})`),
          ),
        );
      } else {
        body.append(buildStatsForm(entry.id, p, settings.medianViews?.[p] || ""));
      }
    }
    card.append(body);
    list.append(card);
  }
}

function buildStatsForm(id, platform, medianDefault) {
  const views = el("input", { type: "number", min: "0", placeholder: "vues" });
  const likes = el("input", { type: "number", min: "0", placeholder: "likes" });
  const comments = el("input", { type: "number", min: "0", placeholder: "comm." });
  const median = el("input", { type: "number", min: "1", placeholder: "médiane", value: medianDefault });
  const btn = el("button", { class: "ghost" }, "Enregistrer les stats réelles");
  const form = el("div", { class: "stats-form" },
    el("label", {}, "Vues", views),
    el("label", {}, "Likes", likes),
    el("label", {}, "Commentaires", comments),
    el("label", {}, "Tes vues médianes", median),
    btn,
  );
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await api("/api/stats", {
        method: "POST",
        body: JSON.stringify({
          id,
          platform,
          views: views.value,
          likes: likes.value,
          comments: comments.value,
          medianViews: median.value,
        }),
      });
      loadHistory();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });
  return form;
}

/* ---------- réglages ---------- */

async function loadSettings() {
  try {
    const s = await api("/api/settings");
    document.getElementById("s-voice").value = s.voice || "";
    for (const p of ["linkedin", "reels", "x", "youtube"]) {
      document.getElementById(`s-median-${p}`).value = s.medianViews?.[p] || "";
    }
  } catch { /* le serveur affichera l'erreur ailleurs */ }
}

document.getElementById("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const medianViews = {};
  for (const p of ["linkedin", "reels", "x", "youtube"]) {
    const v = Number(document.getElementById(`s-median-${p}`).value);
    if (v > 0) medianViews[p] = v;
  }
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ voice: document.getElementById("s-voice").value, medianViews }),
    });
    show("settings-saved");
    setTimeout(() => hide("settings-saved"), 2000);
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- démarrage ---------- */
loadHealth();
