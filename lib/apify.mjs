// Client minimal de l'API Apify (sans dépendance). Les runs sont lancés en
// asynchrone puis relus : une fonction Vercel ne bloque jamais 300 s sur un
// scraping, et un run trop long est interrompu sans perdre ce qu'il a déjà payé.
import { config } from "./env.mjs";

export const hasApifyToken = () => Boolean(config.apifyToken);

// Les identifiants d'actor s'écrivent "owner/name" dans le Store et "owner~name" dans l'URL.
const actorPath = (actor) => encodeURIComponent(actor.replace("/", "~"));

async function call(method, path, { body, timeoutMs = 30000 } = {}) {
  if (!config.apifyToken) throw new Error("APIFY_TOKEN absent");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${config.apifyBase}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        // En en-tête plutôt qu'en ?token= : le jeton ne finit pas dans les journaux.
        authorization: `Bearer ${config.apifyToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`Apify : délai dépassé (${Math.round(timeoutMs / 1000)} s)`);
    throw new Error(`Apify injoignable : ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.type || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("Jeton Apify refusé (APIFY_TOKEN invalide).");
    if (res.status === 402) throw new Error("Crédit Apify épuisé pour ce mois.");
    throw new Error(`Apify : ${msg}`);
  }
  return data;
}

// Lance un actor. timeout = durée max du run côté Apify ; maxCharge = plafond de dépense.
export async function startRun(actor, input, { timeout = 120, maxCharge } = {}) {
  const qs = new URLSearchParams({ timeout: String(timeout) });
  if (maxCharge) qs.set("maxTotalChargeUsd", String(maxCharge));
  const out = await call("POST", `/v2/acts/${actorPath(actor)}/runs?${qs}`, { body: input });
  const run = out?.data || {};
  return { id: run.id, datasetId: run.defaultDatasetId, status: run.status || "READY", startedAt: run.startedAt };
}

// État d'un run ; waitForFinish (≤ 60 s) fait patienter Apify plutôt que nous.
export async function getRun(id, waitSecs = 0) {
  const wait = Math.max(0, Math.min(60, Math.round(waitSecs)));
  const out = await call("GET", `/v2/actor-runs/${encodeURIComponent(id)}${wait ? `?waitForFinish=${wait}` : ""}`, {
    timeoutMs: (wait + 15) * 1000,
  });
  const run = out?.data || {};
  return {
    id: run.id,
    status: run.status,
    datasetId: run.defaultDatasetId,
    usageUsd: run.usageTotalUsd ?? null,
    runSecs: run.stats?.runTimeSecs ?? null,
  };
}

export async function abortRun(id) {
  try {
    await call("POST", `/v2/actor-runs/${encodeURIComponent(id)}/abort`);
  } catch {
    /* déjà terminé : rien à faire */
  }
}

export async function datasetItems(datasetId, limit = 80) {
  const qs = new URLSearchParams({ clean: "true", format: "json", limit: String(limit) });
  const out = await call("GET", `/v2/datasets/${encodeURIComponent(datasetId)}/items?${qs}`);
  return Array.isArray(out) ? out : [];
}

export const isTerminal = (status) => ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMING-OUT", "ABORTING"].includes(status);

// Offre et crédit restant du mois. Ne bloque jamais un scan si l'API ne répond pas.
export async function accountInfo() {
  const [me, limits] = await Promise.all([
    call("GET", "/v2/users/me").catch(() => null),
    call("GET", "/v2/users/me/limits").catch(() => null),
  ]);
  const plan = String(me?.data?.plan?.id || me?.data?.plan?.description || "").toUpperCase();
  const max = Number(limits?.data?.limits?.maxMonthlyUsageUsd);
  const used = Number(limits?.data?.current?.monthlyUsageUsd);
  const remaining = Number.isFinite(max) && Number.isFinite(used) ? Math.max(0, max - used) : null;
  return {
    plan: plan || null,
    // L'offre gratuite plafonne à 5 $/mois ; certains actors X n'y fonctionnent qu'en démo.
    free: plan ? plan.includes("FREE") : Number.isFinite(max) ? max <= 5 : null,
    remainingUsd: remaining === null ? null : Math.round(remaining * 100) / 100,
    maxUsd: Number.isFinite(max) ? max : null,
  };
}
