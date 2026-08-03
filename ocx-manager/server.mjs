#!/usr/bin/env node
/**
 * OCX Manager — tableau de bord local pour gérer les providers opencodex.
 * Zéro dépendance. Node 18+.
 *
 *   node server.mjs          (APP_PORT=10105, OCX_PORT=10100 par défaut)
 *
 * Rôle du serveur :
 *  - servir l'interface web (dossier public/)
 *  - relayer les appels vers l'API admin d'opencodex en y injectant le token
 *    (~/.opencodex/admin-api-token), sans jamais l'exposer au navigateur
 *  - gérer le "switch" du modèle actif dans ~/.codex/config.toml (avec backup)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OCX_PORT = Number(process.env.OCX_PORT || 10100);
const APP_PORT = Number(process.env.APP_PORT || 10105);
const OCX_BASE = `http://127.0.0.1:${OCX_PORT}`;
const CODEX_HOME = path.join(os.homedir(), ".codex");
const OCX_HOME = path.join(os.homedir(), ".opencodex");
const TOKEN_PATH = path.join(OCX_HOME, "admin-api-token");
const CODEX_TOML = path.join(CODEX_HOME, "config.toml");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function adminToken() {
  return fs.readFileSync(TOKEN_PATH, "utf8").trim();
}

async function ocxApi(method, apiPath, body) {
  const res = await fetch(`${OCX_BASE}/api/${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken()}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// ~/.codex/config.toml — lecture / écriture de la ligne `model = "..."`
// ---------------------------------------------------------------------------

function readCodexModel() {
  try {
    const content = fs.readFileSync(CODEX_TOML, "utf8");
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (t.startsWith("[")) break; // on ne lit que les clés racine
      const m = t.match(/^model\s*=\s*"(.*)"$/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

function writeCodexModel(slug) {
  const content = fs.readFileSync(CODEX_TOML, "utf8");
  const lines = content.split("\n");
  let idx = -1;
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("[")) break;
    if (/^model\s*=/.test(t)) { idx = i; break; }
    if (/^openai_base_url\s*=/.test(t) || /^model_catalog_json\s*=/.test(t)) insertAt = i + 1;
  }
  const backup = `${CODEX_TOML}.bak-switch-${stamp()}`;
  fs.copyFileSync(CODEX_TOML, backup);
  const newLine = `model = "${slug}"`;
  if (idx === -1) lines.splice(insertAt, 0, newLine);
  else lines[idx] = newLine;
  fs.writeFileSync(CODEX_TOML, lines.join("\n"));
  return backup;
}

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

function sendJson(res, status, data) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(buf);
}

async function readBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const file = path.normalize(path.join(__dirname, "public", rel));
  if (!file.startsWith(path.join(__dirname, "public"))) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Routes locales (/local/*)
// ---------------------------------------------------------------------------

async function handleLocal(req, res, url) {
  if (url.pathname === "/local/state" && req.method === "GET") {
    try {
      const [health, providers, presets, selected, cfg, models] = await Promise.all([
        fetch(`${OCX_BASE}/healthz`).then((r) => r.json()).catch(() => null),
        ocxApi("GET", "providers"),
        ocxApi("GET", "provider-presets"),
        ocxApi("GET", "selected-models"),
        ocxApi("GET", "config"),
        ocxApi("GET", "models"),
      ]);
      return sendJson(res, 200, {
        health,
        providers: providers.json,
        presets: presets.json,
        selectedModels: selected.json,
        config: cfg.json,
        models: models.json,
        activeModel: readCodexModel(),
        codexToml: CODEX_TOML,
      });
    } catch (err) {
      return sendJson(res, 502, { error: `opencodex injoignable: ${err.message}` });
    }
  }

  if (url.pathname === "/local/active-model" && req.method === "GET") {
    return sendJson(res, 200, { model: readCodexModel() });
  }

  if (url.pathname === "/local/active-model" && req.method === "PUT") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const model = String(body.model || "").trim();
      if (!model || model.includes('"')) return sendJson(res, 400, { error: "model invalide" });
      const backup = writeCodexModel(model);
      return sendJson(res, 200, { ok: true, model, backup });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Switch complet : provider par défaut + modèle actif + sync du catalogue Codex.
  if (url.pathname === "/local/switch" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const provider = String(body.provider || "").trim();
      const model = String(body.model || "").trim();
      if (!provider || !model) return sendJson(res, 400, { error: "provider et model requis" });

      const steps = {};
      const r1 = await ocxApi("PATCH", `providers?name=${encodeURIComponent(provider)}`, { setDefault: true });
      steps.defaultProvider = { status: r1.status, body: r1.json };
      if (r1.status !== 200) return sendJson(res, r1.status, { ok: false, step: "defaultProvider", steps });

      const slug = model.includes("/") ? model : `${provider}/${model}`;
      const backup = writeCodexModel(slug);
      steps.activeModel = { ok: true, model, backup };

      const r3 = await ocxApi("POST", "sync");
      steps.sync = { status: r3.status, body: r3.json };

      return sendJson(res, 200, { ok: true, provider, model, steps });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  return sendJson(res, 404, { error: "route locale inconnue" });
}

// ---------------------------------------------------------------------------
// Proxy vers l'API admin opencodex (/ocx/*)
// ---------------------------------------------------------------------------

async function handleProxy(req, res, url) {
  const sub = url.pathname.replace(/^\/ocx\//, "");
  const target = `${OCX_BASE}/api/${sub}${url.search}`;
  try {
    const bodyBuf = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${adminToken()}`,
        ...(bodyBuf && bodyBuf.length ? { "Content-Type": req.headers["content-type"] || "application/json" } : {}),
      },
      body: bodyBuf && bodyBuf.length ? bodyBuf : undefined,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
    res.end(text);
  } catch (err) {
    sendJson(res, 502, { error: `proxy opencodex: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/ocx/")) return await handleProxy(req, res, url);
    if (url.pathname.startsWith("/local/")) return await handleLocal(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(APP_PORT, "127.0.0.1", () => {
  console.log(`OCX Manager  →  http://localhost:${APP_PORT}`);
  console.log(`Proxy opencodex attendu sur ${OCX_BASE} (token: ${TOKEN_PATH})`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`OCX Manager : le port ${APP_PORT} est déjà utilisé (serveur déjà lancé ?)`);
    // Ne pas tuer un process hôte (ex : Electron embarquant ce module)
    if (typeof process.versions.electron === "undefined") process.exit(0);
  } else {
    console.error(`OCX Manager : ${err.message}`);
  }
});
