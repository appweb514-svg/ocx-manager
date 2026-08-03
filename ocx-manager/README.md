# OCX Manager

> ⚡ Projet basé sur [opencodex](https://github.com/lidge-jun/opencodex) — le README principal (apps macOS, Windows et Linux, build GitHub Actions) est à la [racine du dépôt](../README.md).

Petit tableau de bord web pour gérer **plusieurs providers** dans Codex via le proxy
[opencodex](https://github.com/lidge-jun/opencodex) — là où Codex seul ne permet pas d'en
configurer plusieurs.

## Lancer

```bash
cd ocx-manager
node server.mjs          # http://localhost:10105
```

Prérequis : le proxy opencodex doit tourner (`ocx start`, port 10100 par défaut).
Le token admin est lu depuis `~/.opencodex/admin-api-token` côté serveur et n'est
jamais exposé au navigateur.

Variables d'env : `APP_PORT` (défaut 10105), `OCX_PORT` (défaut 10100).

## Ce que fait l'interface

- **Modèle actif** : bascule en un clic (provider par défaut + ligne `model =` de
  `~/.codex/config.toml` + resync du catalogue Codex). Un backup `.bak-switch-*`
  est créé avant chaque écriture. S'applique à la prochaine session Codex.
- **Providers** : liste, statut de découverte du catalogue, test de connexion,
  ajout de providers personnalisés (64 presets intégrés : OpenRouter, Groq,
  Anthropic, Gemini, Ollama local, etc.), édition, activation/désactivation,
  suppression, choix du provider par défaut.
- **Modèles par provider** : sélection fine des modèles exposés dans Codex.

## App macOS « OCX Switcher » (barre des menus)

L'icône ⚡ dans la barre des menus permet de :

- basculer provider + modèle en un clic (sous-menu par provider, modèle actif coché) ;
- définir le provider par défaut ;
- **ajouter un provider présent dans opencodex** : menu « ➕ Ajouter un provider… »,
  choisir un preset (64 presets intégrés), les champs se remplissent automatiquement,
  saisir la clé API si nécessaire — le provider est créé, la clé enregistrée et le
  catalogue resynchronisé ;
- ouvrir le tableau de bord web et relancer le serveur OCX Manager.

Reconstruire l'app : `macos/build-app.sh` (Swift + AppKit, icône incluse).

## Astuce

`openference` apparaît « catalogue KO (401) » : il n'a pas de clé API configurée.
Ajoutez-en une depuis la carte du provider (bouton Modifier).
