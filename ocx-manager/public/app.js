/* OCX Manager — logique front (vanilla JS, zéro dépendance) */

const $ = (id) => document.getElementById(id);
let state = null;
let editingProvider = null; // null = mode ajout
let modelsModalProvider = null;

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("toast-zone").appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

async function jfetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------------
// Chargement d'état
// ---------------------------------------------------------------------------

async function loadState() {
  $("health").className = "health";
  $("health-text").textContent = "connexion…";
  try {
    state = await jfetch("/local/state");
    const up = state.health?.status === "ok";
    $("health").className = `health ${up ? "ok" : "ko"}`;
    $("health-text").textContent = up
      ? `opencodex v${state.health.version} · port ${state.health.port}`
      : "proxy injoignable";
    render();
  } catch (err) {
    $("health").className = "health ko";
    $("health-text").textContent = "proxy injoignable";
    $("providers-list").innerHTML = `<div class="empty">Impossible de joindre le serveur local : ${esc(err.message)}<br>Vérifiez que le proxy opencodex tourne (<code>ocx start</code>) et relancez l'app.</div>`;
  }
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function providerModels(name) {
  // Lignes complètes de /api/models : le flag `disabled` reflète la visibilité réelle.
  return (state.models || []).filter((m) => m.provider === name);
}

function visibleModels(name) {
  return providerModels(name).filter((m) => !m.disabled);
}

function render() {
  renderActiveSection();
  renderProviders();
}

function renderActiveSection() {
  $("active-model").textContent = state.activeModel || "— aucun modèle défini —";

  const provSel = $("switch-provider");
  provSel.innerHTML = "";
  const enabled = state.providers.filter((p) => !p.disabled).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  if (!enabled.length) {
    provSel.innerHTML = `<option>aucun provider actif</option>`;
    return;
  }
  const activeProvider = state.activeModel?.split("/")[0];
  for (const [i, p] of enabled.entries()) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = `${i + 1} · ${p.name}` + (p.name === state.config?.defaultProvider ? " (défaut)" : "");
    if (p.name === activeProvider) opt.selected = true;
    provSel.appendChild(opt);
  }
  renderSwitchModels();
  $("switch-note").textContent = "Basculer = définir le provider par défaut, mettre à jour le catalogue de Codex et écrire le modèle actif.";
}

function renderSwitchModels() {
  const name = $("switch-provider").value;
  const sel = $("switch-model");
  sel.innerHTML = "";
  const models = visibleModels(name).map((m) => m.id).sort((a, b) => a.localeCompare(b, "fr"));
  const activeId = state.activeModel?.startsWith(`${name}/`) ? state.activeModel.slice(name.length + 1) : null;
  if (!models.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "⚠ catalogue vide — testez la connexion du provider";
    sel.appendChild(opt);
    return;
  }
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    if (m === activeId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function discoveryBadge(p) {
  const d = p.discovery || {};
  if (p.disabled) return "";
  if (d.status === "ok") return `<span class="badge ok">catalogue OK</span>`;
  if (d.status === "failed") return `<span class="badge ko" title="${esc(d.reason || "")}">catalogue KO${d.httpStatus ? ` (${d.httpStatus})` : ""}</span>`;
  if (d.status === "pending") return `<span class="badge warn">découverte…</span>`;
  return "";
}

function renderProviders() {
  const list = $("providers-list");
  if (!state.providers.length) {
    list.innerHTML = `<div class="empty">Aucun provider configuré. Ajoutez-en un !</div>`;
    return;
  }
  const defaultProvider = state.config?.defaultProvider;
  list.innerHTML = "";
  const ordered = [...state.providers].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  for (const [i, p] of ordered.entries()) {
    const isDefault = p.name === defaultProvider;
    const allModels = providerModels(p.name);
    const nModels = allModels.filter((m) => !m.disabled).length;
    const nHidden = allModels.length - nModels;
    const card = document.createElement("div");
    card.className = `provider ${isDefault ? "is-default" : ""} ${p.disabled ? "disabled" : ""}`;
    card.innerHTML = `
      <div class="provider-head">
        <span class="provider-num">${i + 1}</span>
        <span class="provider-name">${esc(p.name)}</span>
        ${isDefault ? `<span class="badge default">par défaut</span>` : ""}
        <span class="badge">${esc(p.adapter)}</span>
        ${p.hasApiKey ? `<span class="badge">🔑 clé</span>` : ""}
        ${p.disabled ? `<span class="badge warn">désactivé</span>` : ""}
        ${discoveryBadge(p)}
        <span class="badge">${nModels} modèle${nModels > 1 ? "s" : ""}</span>
        ${nHidden > 0 ? `<span class="badge warn">${nHidden} masqué${nHidden > 1 ? "s" : ""}</span>` : ""}
        <div class="provider-actions">
          ${!isDefault && !p.disabled ? `<button class="btn small" data-act="default">Définir par défaut</button>` : ""}
          <button class="btn small" data-act="test">Tester</button>
          <button class="btn small" data-act="models">Modèles</button>
          <button class="btn small" data-act="edit">Modifier</button>
          <button class="btn small" data-act="toggle">${p.disabled ? "Activer" : "Désactiver"}</button>
          <button class="btn small danger" data-act="remove">Supprimer</button>
        </div>
      </div>
      <div class="provider-meta">${esc(p.baseUrl)}${p.defaultModel ? ` · défaut : <code>${esc(p.defaultModel)}</code>` : ""}</div>
    `;
    card.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", () => providerAction(p.name, btn.dataset.act, btn))
    );
    list.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Actions providers
// ---------------------------------------------------------------------------

async function providerAction(name, act, btn) {
  btn.disabled = true;
  const restore = btn.textContent;
  try {
    if (act === "default") {
      btn.textContent = "…";
      await jfetch(`/ocx/providers?name=${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ setDefault: true }) });
      await jfetch("/ocx/sync", { method: "POST" }).catch(() => {});
      toast(`« ${name} » est maintenant le provider par défaut`, "ok");
      await loadState();
    } else if (act === "test") {
      btn.innerHTML = '<span class="spin">⟳</span>';
      const r = await jfetch(`/ocx/providers/test?name=${encodeURIComponent(name)}`, { method: "POST" });
      if (r.applicable === false) toast(`« ${name} » : catalogue statique, rien à tester`, "");
      else if (r.ok) toast(`« ${name} » connecté en ${r.latencyMs} ms — ${r.models} modèles`, "ok");
      else toast(`Échec « ${name} » : ${r.error}`, "ko");
    } else if (act === "models") {
      openModelsModal(name);
    } else if (act === "edit") {
      openProviderModal(name);
    } else if (act === "toggle") {
      const p = state.providers.find((x) => x.name === name);
      await jfetch(`/ocx/providers?name=${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ disabled: !p.disabled }) });
      toast(`« ${name} » ${p.disabled ? "réactivé" : "désactivé"}`, "ok");
      await loadState();
    } else if (act === "remove") {
      if (!confirm(`Supprimer définitivement le provider « ${name} » ?`)) return;
      await jfetch(`/ocx/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(`« ${name} » supprimé`, "ok");
      await loadState();
    }
  } catch (err) {
    toast(`Erreur : ${err.message}`, "ko");
  } finally {
    btn.disabled = false;
    btn.textContent = restore;
  }
}

// ---------------------------------------------------------------------------
// Switch rapide (provider + modèle actif)
// ---------------------------------------------------------------------------

async function doSwitch() {
  const provider = $("switch-provider").value;
  const model = $("switch-model").value;
  if (!provider) return toast("Choisissez un provider", "ko");
  if (!model) return toast("Choisissez un modèle (ou vérifiez le catalogue du provider)", "ko");
  const btn = $("btn-switch");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">⟳</span>';
  try {
    const r = await jfetch("/local/switch", { method: "POST", body: JSON.stringify({ provider, model }) });
    toast(`Basculé sur ${provider}/${model} ✓`, "ok");
    await loadState();
  } catch (err) {
    toast(`Switch impossible : ${err.message}`, "ko");
  } finally {
    btn.disabled = false;
    btn.textContent = "Basculer";
  }
}

// ---------------------------------------------------------------------------
// Modale provider (ajout / édition)
// ---------------------------------------------------------------------------

function openProviderModal(name = null) {
  editingProvider = name;
  $("modal-error").hidden = true;
  $("modal-title").textContent = name ? `Modifier « ${name} »` : "Ajouter un provider";
  $("preset-zone").hidden = !!name;
  $("preset-select").value = "";
  $("preset-note").textContent = "";

  const p = name ? state.providers.find((x) => x.name === name) : null;
  $("f-name").value = name || "";
  $("f-name").disabled = !!name;
  $("f-adapter").value = p?.adapter || "openai-chat";
  $("f-baseurl").value = p?.baseUrl || "";
  $("f-apikey").value = "";
  $("f-apikey").placeholder = name ? (p?.hasApiKey ? "clé existante conservée — remplir pour en ajouter une" : "sk-…") : "sk-…";
  $("f-defaultmodel").value = p?.defaultModel || "";
  $("f-setdefault").checked = false;
  $("f-setdefault").disabled = !!name;
  $("f-privatenet").checked = !!p?.allowPrivateNetwork;

  $("modal").hidden = false;
  if (!name) $("f-name").focus();
}

function applyPreset() {
  const id = $("preset-select").value;
  const preset = (state.presets?.providers || []).find((p) => p.id === id);
  if (!preset) {
    $("preset-note").textContent = "";
    return;
  }
  $("f-name").value = preset.id;
  $("f-name").disabled = true;
  $("f-adapter").value = preset.provider?.adapter || preset.adapter || "openai-chat";
  $("f-baseurl").value = preset.provider?.baseUrl || preset.baseUrl || "";
  $("f-defaultmodel").value = preset.defaultModel || preset.provider?.defaultModel || "";
  $("preset-note").textContent =
    (preset.auth === "oauth" ? `Authentification OAuth — après création, lancez : ocx login ${preset.oauthProvider || preset.id}. ` : "") +
    (preset.note || "");
}

async function saveProvider() {
  $("modal-error").hidden = true;
  const name = $("f-name").value.trim();
  const adapter = $("f-adapter").value;
  const baseUrl = $("f-baseurl").value.trim();
  const apiKey = $("f-apikey").value.trim();
  const defaultModel = $("f-defaultmodel").value.trim();
  const setDefault = $("f-setdefault").checked;
  const allowPrivateNetwork = $("f-privatenet").checked;

  if (!name) return showModalError("Le nom est obligatoire.");
  if (!baseUrl) return showModalError("La base URL est obligatoire.");

  const btn = $("modal-save");
  btn.disabled = true;
  try {
    if (editingProvider) {
      // Édition : PATCH des champs supportés + clé via l'endpoint dédié.
      const patch = { adapter, baseUrl };
      if (defaultModel) patch.defaultModel = defaultModel;
      patch.allowPrivateNetwork = allowPrivateNetwork;
      await jfetch(`/ocx/providers?name=${encodeURIComponent(editingProvider)}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (apiKey) {
        await jfetch("/ocx/providers/keys", { method: "POST", body: JSON.stringify({ name: editingProvider, key: apiKey }) });
        toast("Nouvelle clé API ajoutée et activée", "ok");
      }
      toast(`« ${editingProvider} » mis à jour`, "ok");
    } else {
      const preset = (state.presets?.providers || []).find((p) => p.id === $("preset-select").value);
      const provider = { ...(preset?.provider || {}), adapter, baseUrl };
      if (apiKey) { provider.apiKey = apiKey; if (!provider.authMode) provider.authMode = "key"; }
      if (defaultModel) provider.defaultModel = defaultModel;
      if (allowPrivateNetwork) provider.allowPrivateNetwork = true;
      await jfetch("/ocx/providers", { method: "POST", body: JSON.stringify({ name, provider, setDefault }) });
      toast(`Provider « ${name} » ajouté${setDefault ? " et défini par défaut" : ""}`, "ok");
      if (preset?.auth === "oauth") toast(`OAuth requis : lancez ensuite « ocx login ${preset.oauthProvider || preset.id} »`, "");
    }
    $("modal").hidden = true;
    await loadState();
  } catch (err) {
    showModalError(err.message);
  } finally {
    btn.disabled = false;
  }
}

function showModalError(msg) {
  $("modal-error").textContent = msg;
  $("modal-error").hidden = false;
}

// ---------------------------------------------------------------------------
// Modale modèles (allowlist par provider)
// ---------------------------------------------------------------------------

function openModelsModal(name) {
  modelsModalProvider = name;
  $("models-modal-title").textContent = `Modèles exposés — ${name}`;
  $("models-error").hidden = true;
  const box = $("models-checks");
  const available = providerModels(name).sort((a, b) => a.id.localeCompare(b.id, "fr"));
  box.innerHTML = "";
  if (!available.length) {
    box.innerHTML = `<div class="empty">Aucun modèle découvert pour ce provider. Testez la connexion d'abord, ou le catalogue est statique.</div>`;
  } else {
    const header = document.createElement("div");
    header.className = "models-row models-head";
    header.innerHTML = `<span>Modèle</span><span class="models-eye">Visible</span>`;
    box.appendChild(header);
  }
  for (const m of available) {
    const row = document.createElement("label");
    row.className = "check models-row";
    row.innerHTML = `
      <code class="models-name" title="${esc(m.contextWindow ? `Contexte ${m.contextWindow.toLocaleString("fr-FR")} tokens` : "")}">${esc(m.id)}</code>
      <input type="checkbox" class="models-eye" data-model="${esc(m.id)}" ${m.disabled ? "" : "checked"} />
    `;
    box.appendChild(row);
  }
  updateModelsSummary();
  $("models-modal").hidden = false;
}

function updateModelsSummary() {
  const inputs = [...$("models-checks").querySelectorAll("input[type=checkbox]")];
  const checked = inputs.filter((i) => i.checked).length;
  const total = inputs.length;
  $("models-summary").textContent = total
    ? `${checked} affiché${checked > 1 ? "s" : ""} · ${total - checked} masqué${total - checked > 1 ? "s" : ""}`
    : "";
  $("models-show-all").disabled = checked === total;
  $("models-hide-all").disabled = checked === 0;
}

async function saveModels() {
  if (!modelsModalProvider) return;
  const all = providerModels(modelsModalProvider);
  const visible = new Set([...$("models-checks").querySelectorAll("input:checked")].map((i) => i.dataset.model));
  const allIds = all.map((m) => m.id);
  const hiddenIds = allIds.filter((id) => !visible.has(id));
  const btn = $("models-save");
  btn.disabled = true;
  try {
    // 1) Tout réafficher (vider allowlist + blocklist du provider)
    await jfetch("/ocx/model-visibility", {
      method: "PUT",
      body: JSON.stringify({
        scope: "provider",
        provider: modelsModalProvider,
        enabled: true,
        targets: allIds.map((id) => ({ id, native: false })),
      }),
    });
    // 2) Masquer ceux qui sont décochés
    if (hiddenIds.length) {
      await jfetch("/ocx/model-visibility", {
        method: "PUT",
        body: JSON.stringify({
          scope: "models",
          provider: modelsModalProvider,
          enabled: false,
          targets: hiddenIds.map((id) => ({ id, native: false })),
        }),
      });
    }
    await jfetch("/ocx/sync", { method: "POST" }).catch(() => {});
    toast(
      `${visible.size} affiché${visible.size > 1 ? "s" : ""} · ${hiddenIds.length} masqué${hiddenIds.length > 1 ? "s" : ""} — « ${modelsModalProvider} » mis à jour`,
      "ok"
    );
    $("models-modal").hidden = true;
    await loadState();
  } catch (err) {
    $("models-error").textContent = err.message;
    $("models-error").hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

function init() {
  $("btn-refresh").addEventListener("click", loadState);
  $("btn-switch").addEventListener("click", doSwitch);
  $("switch-provider").addEventListener("change", renderSwitchModels);

  $("btn-add-provider").addEventListener("click", () => openProviderModal());
  $("modal-close").addEventListener("click", () => ($("modal").hidden = true));
  $("modal-cancel").addEventListener("click", () => ($("modal").hidden = true));
  $("modal-save").addEventListener("click", saveProvider);
  $("preset-select").addEventListener("change", applyPreset);

  $("models-modal-close").addEventListener("click", () => ($("models-modal").hidden = true));
  $("models-save").addEventListener("click", saveModels);
  $("models-show-all").addEventListener("click", () => {
    $("models-checks").querySelectorAll("input[type=checkbox]").forEach((i) => (i.checked = true));
    updateModelsSummary();
  });
  $("models-hide-all").addEventListener("click", () => {
    $("models-checks").querySelectorAll("input[type=checkbox]").forEach((i) => (i.checked = false));
    updateModelsSummary();
  });
  $("models-checks").addEventListener("change", updateModelsSummary);

  // Fermer les modales avec Échap
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("modal").hidden = true;
      $("models-modal").hidden = true;
    }
  });
}

(async function boot() {
  init();
  await loadState();
  // Remplir le sélecteur de presets après le premier chargement
  if (state?.presets?.providers) {
    const sel = $("preset-select");
    const ordered = [...state.presets.providers].sort((a, b) => a.label.localeCompare(b.label, "fr"));
    for (const p of ordered) {
      if (p.id === "custom") continue;
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.label}${p.auth === "oauth" ? " (OAuth)" : p.auth === "local" ? " (local)" : ""}`;
      sel.appendChild(opt);
    }
  }
  // Rafraîchissement doux toutes les 30 s
  setInterval(loadState, 30000);
})();
