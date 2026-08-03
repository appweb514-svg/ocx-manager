const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") || "add";
const view = document.getElementById("view");

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (typeof child === "string") node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

window.ocx.onError((msg) => {
  const status = document.querySelector(".status");
  if (status) { status.textContent = msg; status.className = "status err"; }
});

async function submitAdd(form) {
  const name = form.name.value.trim();
  const baseUrl = form.baseUrl.value.trim();
  if (!name || !baseUrl) {
    setStatus("Nom et Base URL sont obligatoires", "err");
    return;
  }
  const provider = {
    adapter: form.adapter.value,
    baseUrl,
  };
  if (form.defaultModel.value.trim()) provider.defaultModel = form.defaultModel.value.trim();
  if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) provider.allowPrivateNetwork = true;

  setStatus("Ajout en cours…");
  const res = await window.ocx.providerAdd({
    name,
    provider,
    setDefault: form.setDefault.checked,
    apiKey: form.apiKey.value.trim(),
  });
  if (res.ok) {
    setStatus(`Provider « ${name} » ajouté ✓`, "ok");
    setTimeout(() => window.ocx.close(), 900);
  } else if (res.step === "key") {
    setStatus(`Provider ajouté, mais clé non enregistrée : ${res.error}`, "err");
  } else {
    setStatus(res.error || "Échec de l'ajout", "err");
  }
}

function setStatus(text, kind = "") {
  const status = document.querySelector(".status");
  if (status) { status.textContent = text; status.className = `status ${kind}`; }
}

if (mode === "add") {
  renderAdd();
} else if (mode === "visibility") {
  renderVisibility(params.get("provider") || "");
}

async function renderAdd() {
  document.title = "Ajouter un provider — OCX Switcher";
  view.append(el("h1", {}, ["➕ Ajouter un provider"]));

  const form = el("form", { onsubmit: (e) => { e.preventDefault(); submitAdd(form); } });
  const presetSel = el("select", { id: "preset" });
  presetSel.append(el("option", { value: "", textContent: "— Personnalisé —" }));
  const nameInput = el("input", { type: "text", id: "name", placeholder: "ex : openrouter", required: true });
  const adapterSel = el("select", { id: "adapter" });
  for (const adapter of ["openai-chat", "openai-responses", "anthropic", "google", "azure-openai", "cursor"]) {
    adapterSel.append(el("option", { value: adapter, textContent: adapter }));
  }
  const baseInput = el("input", { type: "text", id: "baseUrl", placeholder: "https://api.example.com/v1", required: true, spellcheck: false });
  const keyInput = el("textarea", { id: "apiKey", placeholder: "Collez votre clé API ici (Ctrl+V)" });
  const modelInput = el("input", { type: "text", id: "defaultModel", placeholder: "ex : gpt-4o (optionnel)", spellcheck: false });
  const defaultCheck = el("input", { type: "checkbox", id: "setDefault" });

  form.append(
    el("label", { htmlFor: "preset" }, ["Preset (remplit les champs)"]),
    presetSel,
    el("label", { htmlFor: "name" }, ["Nom  *"]),
    nameInput,
    el("label", { htmlFor: "adapter" }, ["Adapter  *"]),
    adapterSel,
    el("label", { htmlFor: "baseUrl" }, ["Base URL  *"]),
    baseInput,
    el("label", { htmlFor: "apiKey" }, ["Clé API (visible, sans masquage)"]),
    keyInput,
    el("div", { className: "hint" }, ["La clé est enregistrée localement dans la config opencodex, jamais dans le dépôt."]),
    el("label", { htmlFor: "defaultModel" }, ["Modèle par défaut (optionnel)"]),
    modelInput,
    el("div", { className: "row", style: "margin-top:14px" }, [
      defaultCheck,
      el("label", { className: "model-name", htmlFor: "setDefault" }, ["Définir comme provider par défaut"]),
    ]),
    el("div", { className: "actions" }, [
      el("button", { type: "button", onclick: () => window.ocx.close() }, ["Annuler"]),
      el("button", { type: "submit", className: "primary" }, ["Ajouter"]),
    ]),
    el("div", { className: "status" }),
  );
  view.append(form);

  const presets = await window.ocx.presets();
  if (Array.isArray(presets)) {
    presets
      .slice()
      .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)))
      .forEach((p) => presetSel.append(el("option", { value: p.id, textContent: p.label || p.id })));
  }

  presetSel.addEventListener("change", () => {
    const preset = presets.find((p) => p.id === presetSel.value);
    if (!preset) return;
    nameInput.value = preset.id || "";
    const adapter = preset.provider?.adapter || preset.adapter || "openai-chat";
    if ([...adapterSel.options].some((o) => o.value === adapter)) adapterSel.value = adapter;
    baseInput.value = preset.provider?.baseUrl || preset.baseUrl || "";
    modelInput.value = preset.provider?.defaultModel || preset.defaultModel || "";
  });

  nameInput.focus();
}

async function renderVisibility(provider) {
  document.title = `Modèles — ${provider}`;
  view.append(el("h1", {}, [`👁 Modèles — ${provider}`]));

  const { rows } = await window.ocx.visibilityLoad(provider);
  const checks = new Map();
  const list = el("div", { className: "list" });
  const summary = el("div", { className: "summary" });
  const showAll = el("button", { type: "button" }, ["👁 Tout afficher"]);
  const hideAll = el("button", { type: "button" }, ["🙈 Tout cacher"]);

  function updateSummary() {
    const visibleCount = [...checks.values()].filter((c) => c.checked).length;
    const hidden = rows.length - visibleCount;
    summary.textContent = rows.length
      ? `${visibleCount} affiché${visibleCount > 1 ? "s" : ""} · ${hidden} masqué${hidden > 1 ? "s" : ""}`
      : "aucun modèle";
    showAll.disabled = visibleCount >= rows.length;
    hideAll.disabled = visibleCount === 0;
  }

  for (const row of rows) {
    const checkbox = el("input", { type: "checkbox", checked: row.disabled !== true });
    checkbox.addEventListener("change", updateSummary);
    checks.set(row.id, checkbox);
    list.append(el("div", { className: "row" }, [
      checkbox,
      el("label", { className: "model-name", htmlFor: `cb-${row.id}`, textContent: row.id }),
    ]));
    checkbox.id = `cb-${row.id}`;
  }

  showAll.addEventListener("click", () => { checks.forEach((c) => { c.checked = true; }); updateSummary(); });
  hideAll.addEventListener("click", () => { checks.forEach((c) => { c.checked = false; }); updateSummary(); });

  const save = el("button", { type: "button", className: "primary" }, ["Enregistrer"]);
  const cancel = el("button", { type: "button" }, ["Annuler"]);
  save.addEventListener("click", async () => {
    save.disabled = true;
    setStatus("Enregistrement…");
    const visibleIds = [...checks.entries()].filter(([, c]) => c.checked).map(([id]) => id);
    const res = await window.ocx.visibilitySave({ provider, visibleIds });
    if (res.ok) {
      setStatus("Visibilité enregistrée ✓", "ok");
      setTimeout(() => window.ocx.close(), 700);
    } else {
      setStatus(res.error || "Erreur lors de l'enregistrement", "err");
      save.disabled = false;
    }
  });
  cancel.addEventListener("click", () => window.ocx.close());

  view.append(
    el("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:10px" }, [
      showAll,
      hideAll,
    ]),
    summary,
    list,
    el("div", { className: "actions" }, [cancel, save]),
    el("div", { className: "status" }),
  );
  updateSummary();
}
