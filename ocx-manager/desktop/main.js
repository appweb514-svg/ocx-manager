// OCX Switcher — app tray Windows/Linux (et macOS via Electron si besoin).
// Miroir des fonctions de l'app Swift macOS : switch provider/modèle,
// provider par défaut, ajout de provider, visibilité des modèles.
const { app, Tray, Menu, BrowserWindow, ipcMain, shell, nativeImage } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

const MANAGER_URL = "http://127.0.0.1:10105";
const REQUEST_TIMEOUT_MS = 6000;

let tray = null;
let addWindow = null;
let visibilityWindow = null;

// ---------------------------------------------------------------------------
// API locale (relais serveur OCX Manager — token admin jamais lu ici)
// ---------------------------------------------------------------------------

async function api(apiPath, { method = "GET", body } = {}) {
  const res = await fetch(`${MANAGER_URL}${apiPath}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function fetchState() {
  try {
    const { json } = await api("/local/state");
    return json;
  } catch {
    return null;
  }
}

async function switchModel(provider, model) {
  try {
    await api("/local/switch", { method: "POST", body: { provider, model } });
  } catch (err) {
    dialogError(`Impossible de basculer : ${err.message}`);
  }
}

async function setDefaultProvider(name) {
  try {
    await api(`/ocx/providers?name=${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: { setDefault: true },
    });
  } catch (err) {
    dialogError(`Impossible de définir le provider par défaut : ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Serveur OCX Manager (embarqué dans extraResources lors du packaging)
// ---------------------------------------------------------------------------

function serverEntry() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "server", "server.mjs");
  }
  return path.join(__dirname, "..", "server.mjs");
}

function startManagerServer() {
  const entry = serverEntry();
  const child = spawn(process.platform === "win32" ? "node.exe" : "node", [entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayIcon() {
  const base = path.join(__dirname, "assets");
  if (process.platform === "win32") {
    return nativeImage.createFromPath(path.join(base, "tray-16.png"));
  }
  return nativeImage.createFromPath(path.join(base, "tray-22.png"));
}

function refreshTray() {
  buildMenu().then((menu) => {
    if (process.platform === "linux") tray.setContextMenu(menu);
  });
}

async function buildMenu() {
  const state = await fetchState();
  const template = [];

  if (!state) {
    template.push({ label: "OCX Manager injoignable", enabled: false });
    template.push({ type: "separator" });
    template.push({ label: "Démarrer le serveur", click: () => { startManagerServer(); setTimeout(refreshTray, 1500); } });
    template.push({ type: "separator" });
    template.push({ label: "Quitter OCX Switcher", click: () => app.quit() });
    return Menu.buildFromTemplate(template);
  }

  const active = state.activeModel || "— aucun modèle —";
  template.push({ label: `Modèle actif : ${active}`, enabled: false });
  if (state.health?.status !== "ok") {
    template.push({ label: "⚠ proxy opencodex arrêté", enabled: false });
  }
  template.push({ type: "separator" });

  const providers = (state.providers || [])
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  const defaultProvider = state.config?.defaultProvider;

  providers.forEach((provider, index) => {
    const isDefault = provider.name === defaultProvider;
    const submenu = [];

    if (provider.disabled === true) {
      submenu.push({ label: "Désactivé", enabled: false });
    } else {
      submenu.push({
        label: isDefault ? "Provider par défaut ✓" : "Définir comme provider par défaut",
        enabled: !isDefault,
        click: () => {
          setDefaultProvider(provider.name);
          setTimeout(refreshTray, 800);
        },
      });
      submenu.push({ type: "separator" });

      const rows = (state.models || []).filter((m) => m.provider === provider.name);
      const visible = rows.filter((m) => m.disabled !== true);
      const hiddenCount = rows.length - visible.length;

      if (visible.length === 0) {
        submenu.push({
          label: hiddenCount > 0 ? "tous les modèles sont masqués" : "aucun modèle découvert",
          enabled: false,
        });
      } else {
        visible
          .map((m) => m.id)
          .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
          .forEach((id) => {
            const slug = `${provider.name}/${id}`;
            submenu.push({
              label: id,
              type: "checkbox",
              checked: active === slug || active === id,
              click: () => {
                switchModel(provider.name, slug);
                setTimeout(refreshTray, 900);
              },
            });
          });
      }
      if (hiddenCount > 0) {
        submenu.push({ label: `${hiddenCount} modèle${hiddenCount > 1 ? "s" : ""} masqué${hiddenCount > 1 ? "s" : ""}`, enabled: false });
      }
      submenu.push({ type: "separator" });
      submenu.push({ label: "👁 Gérer les modèles…", click: () => openVisibilityWindow(provider.name) });
    }

    template.push({
      label: `${index + 1} · ${provider.name}${isDefault ? "  ★" : ""}`,
      submenu,
    });
  });

  template.push({ type: "separator" });
  template.push({ label: "➕ Ajouter un provider…", click: () => openAddWindow() });
  template.push({ type: "separator" });
  template.push({ label: "Rafraîchir", click: refreshTray });
  template.push({ label: "Ouvrir le tableau de bord", click: () => shell.openExternal("http://localhost:10105/") });
  template.push({ label: "Quitter OCX Switcher", click: () => app.quit() });

  return Menu.buildFromTemplate(template);
}

function showTrayMenu() {
  buildMenu().then((menu) => {
    if (process.platform === "linux") {
      tray.setContextMenu(menu);
    } else {
      tray.popUpContextMenu(menu);
    }
  });
}

// ---------------------------------------------------------------------------
// Fenêtres
// ---------------------------------------------------------------------------

function createWindow(name, options) {
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "assets", "icon-codex-black.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"), { query: options.query });

  // Hook dev : OCX_DEV_SHOT=<fichier.png> capture la fenêtre après chargement
  if (process.env.OCX_DEV_SHOT) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          fs.writeFileSync(process.env.OCX_DEV_SHOT, image.toPNG());
          console.log(`capture → ${process.env.OCX_DEV_SHOT}`);
          if (process.env.OCX_DEV_DOM) {
            const dom = await win.webContents.executeJavaScript(`({
              title: document.title,
              h1: document.querySelector("h1")?.textContent,
              name: !!document.getElementById("name"),
              apiKeyH: document.getElementById("apiKey")?.offsetHeight,
              presets: document.getElementById("preset")?.options.length,
              rows: document.querySelectorAll(".row").length,
              status: document.querySelector(".status")?.textContent
            })`);
            console.log("DOM:", JSON.stringify(dom));
          }
        } catch (err) {
          console.error("capture failed:", err.message);
        }
      }, 900);
    });
  }
  return win;
}

function openAddWindow() {
  if (addWindow && !addWindow.isDestroyed()) {
    addWindow.focus();
    return;
  }
  addWindow = createWindow("add", { width: 560, height: 700, query: { mode: "add" } });
  addWindow.on("closed", () => { addWindow = null; });
}

function openVisibilityWindow(provider) {
  if (visibilityWindow && !visibilityWindow.isDestroyed()) {
    visibilityWindow.focus();
    return;
  }
  visibilityWindow = createWindow("visibility", {
    width: 560,
    height: 620,
    query: { mode: "visibility", provider },
  });
  visibilityWindow.on("closed", () => { visibilityWindow = null; });
}

function dialogError(message) {
  const win = addWindow || visibilityWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send("dialog:error", message);
  }
}

// ---------------------------------------------------------------------------
// IPC (renderer → main)
// ---------------------------------------------------------------------------

ipcMain.handle("state:get", async () => fetchState());

ipcMain.handle("presets:list", async () => {
  try {
    const { json } = await api("/ocx/provider-presets");
    return json?.providers || [];
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("visibility:load", async (_event, provider) => {
  const state = await fetchState();
  const rows = (state?.models || [])
    .filter((m) => m.provider === provider)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return { provider, rows };
});

ipcMain.handle("visibility:save", async (_event, payload) => {
  const { provider, visibleIds } = payload;
  try {
    const state = await fetchState();
    const rows = (state?.models || []).filter((m) => m.provider === provider);
    const allIds = rows.map((m) => m.id);
    const hiddenIds = allIds.filter((id) => !visibleIds.includes(id));

    // 1) Tout réafficher (vider allowlist/blocklist du provider)
    await api("/ocx/model-visibility", {
      method: "PUT",
      body: { scope: "provider", provider, enabled: true, targets: allIds.map((id) => ({ id, native: false })) },
    });
    // 2) Masquer ceux qui sont décochés
    if (hiddenIds.length > 0) {
      await api("/ocx/model-visibility", {
        method: "PUT",
        body: { scope: "models", provider, enabled: false, targets: hiddenIds.map((id) => ({ id, native: false })) },
      });
    }
    // 3) Resynchroniser le catalogue Codex
    await api("/ocx/sync", { method: "POST", body: {} });
    refreshTray();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("provider:add", async (_event, payload) => {
  const { name, provider, setDefault, apiKey } = payload;
  try {
    const r1 = await api("/ocx/providers", { method: "POST", body: { name, provider, setDefault } });
    if (r1.status !== 200 && r1.status !== 201) {
      return { ok: false, step: "create", error: r1.json?.error || `HTTP ${r1.status}` };
    }
    if (apiKey) {
      const r2 = await api("/ocx/providers/keys", {
        method: "POST",
        body: { name, key: apiKey, label: "via OCX Switcher" },
      });
      if (r2.status !== 200 && r2.status !== 201) {
        return { ok: false, step: "key", error: r2.json?.error || `HTTP ${r2.status}` };
      }
    }
    await api("/ocx/sync", { method: "POST", body: {} });
    refreshTray();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showTrayMenu());

  app.whenReady().then(() => {
    tray = new Tray(trayIcon());
    tray.setToolTip("OCX Switcher — opencodex");
    if (process.platform === "linux") {
      tray.setContextMenu(Menu.buildFromTemplate([{ label: "Chargement…", enabled: false }]));
    }
    tray.on("click", showTrayMenu);
    tray.on("right-click", showTrayMenu);
    tray.on("double-click", () => shell.openExternal("http://localhost:10105/"));
    refreshTray();
    setInterval(refreshTray, 30_000);

    // Hook dev : OCX_DEV_OPEN=add | visibility:<provider> ouvre la fenêtre au démarrage
    const devOpen = process.env.OCX_DEV_OPEN;
    if (devOpen === "add") openAddWindow();
    else if (devOpen && devOpen.startsWith("visibility:")) {
      openVisibilityWindow(devOpen.slice("visibility:".length));
    }
  });
}
