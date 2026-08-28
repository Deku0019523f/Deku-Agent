# Deku Agent — V1.0

Agent de développement autonome. Boucle agentique (planning explicite → action → observation) avec 4 providers LLM (OpenRouter, Gemini, Groq, OpenAI), permissions granulaires, rollback via snapshots Git, délégation à des sous-agents, extensibilité via MCP et plugins, et intégration GitHub distante.

Conçu pour Termux (Android), fonctionne aussi bien sur Linux/macOS/WSL.

## Installation

### Installation rapide (recommandée)

Une seule commande, sur Termux comme sur Linux/macOS — installe Node.js si besoin, télécharge Deku Agent, compile, et crée la commande `deku` :

```bash
curl -fsSL https://raw.githubusercontent.com/Deku0019523f/Deku-Agent/main/scripts/install.sh | bash
```

```
[ok] Node.js déjà présent (v20.x.x).
[info] Téléchargement de Deku Agent...
[ok] Dépôt cloné dans .../opt/deku-agent
[info] Installation des dépendances (npm install)...
[ok] Dépendances installées.
[info] Compilation (npm run build)...
[ok] Compilation terminée.
[ok] Lanceur créé à .../bin/deku
[info] Tests de fumée...
[ok] deku --version -> 1.0.0

[ok] Deku Agent installé. Run: deku
```

Relancer la même commande plus tard met à jour l'installation existante (`git pull` + recompilation) au lieu de la dupliquer.

> **Pourquoi Node.js et pas Bun ?** Le binaire officiel de Bun n'est pas compilé en PIE et ne peut pas s'exécuter sur Android — Bun n'est [pas supporté sur Termux](https://github.com/oven-sh/bun/issues/28924), quelle que soit la méthode d'installation. Node.js, lui, tourne nativement sur Termux (paquet `nodejs` officiel), sans chroot ni `proot-distro`. C'est pour ça que Deku Agent est un projet Node.js/TypeScript classique (compilé via `tsc`, aucune dépendance native).

### Installation manuelle (pour contribuer / modifier le code)

Prérequis commun : [Node.js](https://nodejs.org) ≥ 18.

#### Termux (Android)

```bash
pkg update -y
pkg install -y git nodejs

git clone https://github.com/Deku0019523f/Deku-Agent.git ~/deku-agent
cd ~/deku-agent
npm install
npm run build
```

#### PC — Linux / macOS

```bash
# Debian/Ubuntu : sudo apt install -y nodejs npm
# macOS         : brew install node

git clone https://github.com/Deku0019523f/Deku-Agent.git ~/deku-agent
cd ~/deku-agent
npm install
npm run build
```

#### PC — Windows

Fonctionne directement (Node.js est multiplateforme), ou via [WSL2](https://learn.microsoft.com/windows/wsl/install) en suivant les étapes **Linux / macOS** ci-dessus.

### Vérifier l'installation

```bash
deku --version
```

(avec l'installation manuelle, sans lanceur global : `node dist/cli.js --version`, ou `npm start -- --version`)

## Configuration

### Clés API des providers

Exporte les clés des providers que tu comptes utiliser :

```bash
export OPENROUTER_API_KEY="..."
export GEMINI_API_KEY="..."
export GROQ_API_KEY="..."
export OPENAI_API_KEY="..."
```

### Token GitHub (optionnel — requis pour les outils `github_*`)

```bash
export GITHUB_TOKEN="ghp_..."
```

Alternative sans variable d'environnement : installe [GitHub CLI](https://cli.github.com/) et authentifie-toi avec `gh auth login` — Deku Agent réutilise automatiquement `gh auth token` si `GITHUB_TOKEN` n'est pas défini. Le token n'est jamais lu depuis un fichier versionné.

Ajoute toutes ces lignes à `~/.bashrc` (ou `~/.zshrc`) pour ne pas les retaper à chaque session.

### Configurer une clé API après le lancement (`deku config` ou `/config`)

Alternative aux variables d'environnement : un assistant interactif façon Cline (navigation aux flèches, recherche live), qui enregistre la clé et laisse choisir le modèle dans le catalogue du provider.

`deku` (sans argument) **démarre toujours**, même sans aucune clé configurée, et se connecte au dossier courant :

```
      @@@@@@
    @@@@@@@@@@
   @@@@@@@@@@@@
  @@@@  @@  @@@@
 @@@@    @    @@@@
  @@@@  @@  @@@@
   @@@@@@@@@@@@
    @@@@@@@@@@
      @@@@@@

Que puis-je faire pour toi ?
Dossier : ~/mon-projet
Tape / pour les commandes (essaie /help), Ctrl+C pour quitter.

❯ /config

⚙️  Configuration Deku Agent

Quel provider configurer ?
Rechercher...
❯ OpenRouter
  Gemini (Google)
  Groq
  OpenAI
↑/↓ naviguer · Entrée valider · Échap annuler
```

Après avoir choisi un provider (flèches ↑/↓ ou en tapant pour filtrer), la clé est demandée (saisie masquée), puis le modèle — liste **récupérée en direct** chez le provider, avec recherche live comme le champ "Search models..." de Cline. Retape ensuite directement ton objectif au même prompt, pas besoin de relancer le programme.

Commandes disponibles en session :

| Commande | Effet |
|---|---|
| `/config`, `/model`, `/settings` | Ouvre l'assistant clé + modèle |
| `/mcp` | Liste les serveurs MCP configurés pour ce projet |
| `/plugins` | Liste les plugins chargés pour ce projet |
| `/help` | Affiche cette liste |
| `/exit`, `/quit` | Quitte |

`deku config` (en dehors de toute session, une seule fois) fait exactement la même chose en ligne de commande directe. Dans les deux cas, la clé est stockée dans `~/.deku-agent/credentials.json` (permissions 600, jamais dans un projet ni committée) ; une variable d'environnement déjà exportée reste toujours prioritaire sur celle sauvegardée.

Commandes scriptables (sans passer par l'assistant) :

```bash
deku config show                          # config actuelle, clés masquées
deku config set-key groq gsk_...          # enregistre une clé directement
deku config set-model groq llama-3.3-70b-versatile  # change le défaut
deku config remove-key groq               # supprime une clé sauvegardée
```

### Alias pratique (installation manuelle uniquement)

L'installation rapide (`scripts/install.sh`) crée déjà la commande `deku` globalement — cette étape ne concerne que l'installation manuelle.

```bash
echo 'alias deku="node ~/deku-agent/dist/cli.js"' >> ~/.bashrc
source ~/.bashrc
```

Permet de lancer `deku` depuis n'importe quel dossier.

## Utilisation

```bash
# Mode interactif (prompt l'objectif)
deku

# Objectif direct, provider Groq, sur un projet précis
deku "Corrige le bug de connexion WhatsApp" \
  --provider groq --model llama-3.3-70b-versatile --cwd ~/whatsapp-gateway

# Mode plan (analyse seulement, ne modifie rien, aucun appel réseau externe)
deku "Ajoute une auth JWT" --plan

# Mode auto (enchaîne les actions SAFE sans confirmer)
deku "Lance les tests et corrige les erreurs" --auto

# Reprendre la dernière session interrompue sur ce projet
deku --resume --cwd ~/whatsapp-gateway

# Snapshots Git (créés automatiquement avant chaque écriture/action risquée)
deku --list-snapshots --cwd ~/whatsapp-gateway
deku --rollback 3 --cwd ~/whatsapp-gateway
```

### Options principales

| Option | Description | Défaut |
|---|---|---|
| `--provider <p>` | `openrouter` \| `gemini` \| `groq` \| `openai` | `openrouter` |
| `--model <m>` | Modèle à utiliser | `anthropic/claude-3.5-sonnet` |
| `--cwd <path>` | Racine du projet ciblé | dossier courant |
| `--plan` | Analyse et propose sans rien modifier | désactivé |
| `--auto` | Enchaîne les actions SAFE sans confirmation | désactivé |
| `--max-iterations <n>` | Limite d'itérations de la boucle | `25` |
| `--resume` | Reprend la dernière session interrompue sur ce projet | désactivé |
| `--list-snapshots` | Liste les snapshots Git du projet et quitte | — |
| `--rollback <id>` | Restaure le working tree à l'état du snapshot `<id>` et quitte | — |

À chaque lancement, l'agent produit d'abord un **plan explicite** (liste d'étapes numérotées) avant d'agir ; en mode interactif il demande confirmation avant de lancer ce plan (sauf `--auto`).

Lancé **sans objectif en argument**, `deku` ouvre une session interactive persistante : après chaque tâche (ou commande `/config`, `/help`), il revient au prompt pour un nouvel objectif, jusqu'à `/exit`. Lancé **avec un objectif en argument** (`deku "..."`), il reste en mode one-shot (une tâche, puis sortie) — pratique pour l'usage scripté.

## Extensibilité

### Serveurs MCP

Connecte des serveurs [Model Context Protocol](https://modelcontextprotocol.io) externes en créant `.deku-agent/mcp.json` (à la racine du projet, ou dans `~/.deku-agent/mcp.json` pour une config globale) :

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/chemin/autorisé"],
      "enabled": true
    }
  }
}
```

Les outils exposés apparaissent dans l'agent sous le nom `mcp__<serveur>__<outil>`. Un serveur qui échoue à se connecter est journalisé en avertissement et simplement absent — jamais bloquant pour le reste de l'agent.

### Plugins

Ajoute des outils personnalisés en créant `.deku-agent/plugins/<nom>/plugin.json` + `index.ts` (projet) ou `~/.deku-agent/plugins/<nom>/...` (global) :

```json
// .deku-agent/plugins/mon-plugin/plugin.json
{ "name": "mon-plugin", "entry": "index.ts", "enabled": true }
```

```ts
// .deku-agent/plugins/mon-plugin/index.ts
export default {
  name: "mon-plugin",
  tools: [
    {
      name: "hello",
      description: "Salue quelqu'un",
      parameters: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
    },
  ],
  async executeTool(name, args) {
    if (name === "hello") return `Bonjour, ${args.who} !`;
    throw new Error(`Outil inconnu: ${name}`);
  },
};
```

⚠️ Un plugin s'exécute **en process, sans sandbox** — mêmes privilèges que Deku Agent lui-même. Ne charge que des plugins que tu as écrits ou audités.

### Permissions personnalisées

`.deku-agent/permissions.json` (projet ou `~/.deku-agent/permissions.json` global) permet d'étendre les listes SAFE/DANGEROUS par défaut :

```json
{
  "safe": ["^docker compose ps"],
  "dangerous": ["^terraform apply"]
}
```

## Où en est le projet

**Fait (V0.1 → V1.0) :**
- Protocole interne commun LLM ↔ Tools (`src/types.ts`)
- 4 adaptateurs providers avec traduction de format (OpenAI-style pour OpenRouter/Groq/OpenAI, format natif pour Gemini)
- Boucle agentique avec **planning explicite** avant action, limite d'itérations, retry + backoff exponentiel sur erreurs provider transitoires, garde-fou anti-boucle-d'échec (arrêt si la même action échoue 3 fois d'affilée)
- Outils filesystem : `read_file`, `write_file`, `list_files`
- Outils recherche : `grep_search`, `find_files` (pur Node, sans dépendance à ripgrep)
- Outils Git : `git_status`, `git_diff`, `git_log`, `git_commit`, `git_branch`, `git_rollback`
- Outils GitHub distants : `github_list_issues`, `github_create_issue`, `github_comment_issue`, `github_list_prs`, `github_get_pr`, `github_create_pr`
- Outil shell générique : `run_command`
- Outil `spawn_subagent` : délègue une sous-tâche bornée à un sous-agent (profondeur max 1, pas de récursion)
- **Snapshots Git automatiques** avant toute écriture ou commande DANGEROUS, restaurables via `git_rollback` ou `--rollback`
- **Permissions SAFE/CONFIRM/DANGEROUS** étendues et personnalisables par projet, confirmation forcée sur fichiers sensibles (`.env`, `.git/`, lockfiles) même en `--auto`
- **Support MCP** : connexion à des serveurs externes, outils agrégés dynamiquement
- **Système de plugins** : extensibilité en-process via modules locaux
- **Config interactive** (`deku config` ou `/config` en session) : ajout de clé API et choix du modèle après le lancement (façon Cline — navigation flèches, recherche live), catalogue de modèles fetché en direct par provider avec repli statique
- **Session persistante avec commandes slash** : `deku` sans argument démarre toujours (même sans clé configurée) et reste ouvert entre les tâches ; `/config`, `/model`, `/settings`, `/mcp`, `/plugins`, `/help`, `/exit`
- **Installateur one-liner** (`scripts/install.sh`, façon cline-termux) : installe Node.js si besoin, clone/met à jour le dépôt, compile, crée la commande globale `deku`, tests de fumée automatiques
- **Project Scanner** (`src/contexte/scanner.ts`) : détecte langage, framework, package manager, nombre de fichiers/tests, présence de `.env`, fichiers clés — injecté dans le prompt système
- **Stockage en fichiers JSON** (`src/memory/`, `~/.deku-agent/store/`) : sessions et historique des snapshots dans des fichiers dédiés, messages shardés par session (`store/messages/<id>.json`), écriture atomique (fichier temporaire + `rename()`) pour résister à un arrêt brutal du process. `--resume` reprend une session interrompue. Zéro dépendance native — voir "Pourquoi Node.js et pas Bun" plus haut.
- Mode `--plan` (aucune modification, aucun appel GitHub) et `--auto` (SAFE sans confirmation — les écritures GitHub et les rollbacks restent toujours confirmés)
- CLI terminal avec rendu de la boucle en temps réel

**Pas encore fait (pistes pour la suite) :**
- Rafraîchissement dynamique des outils MCP en cours de run (`notifications/tools/list_changed` actuellement ignoré)
- Tests automatisés (unitaires/intégration) — validation actuelle faite manuellement, avec du vrai code compilé exécuté sous Node (`npm run build && node dist/cli.js`) et de vrais serveurs MCP/GitHub
- Sandbox pour les plugins (actuellement exécution en process, sans isolation)

## Points d'attention techniques

- **Gemini** a un format de tool calling différent des 3 autres (rôles `user`/`model`, pas de rôle `tool` natif, schema JSON plus strict) — géré dans `src/providers/gemini.ts`.
- Les outils filesystem sont **restreints au `--cwd`** — toute tentative de sortir du workspace est bloquée.
- Le stockage est **global** (`~/.deku-agent/store/`) ; sessions/mémoire/snapshots sont séparés par `project_path` à l'intérieur des fichiers JSON. Supprime ce dossier pour tout réinitialiser.
- Plugins écrits en `.ts` : transpilés à la volée vers `.js` (via le compilateur TypeScript, pur JS, aucune dépendance native) et mis en cache dans `<plugin>/.deku-agent-cache/`, régénéré uniquement si la source a changé (comparaison de date de modification).
- `--resume` ne retrouve que les sessions au statut `running` (interrompues) — une session `completed` ne peut pas être reprise, seulement consultée en base.
- Les snapshots Git automatiques nécessitent un dépôt Git initialisé dans `--cwd` ; hors dépôt Git, ils sont silencieusement désactivés (pas de rollback possible, le reste de l'agent fonctionne normalement).
- Un plugin ou serveur MCP mal configuré ne bloque jamais le démarrage : l'agent journalise un avertissement et continue sans lui.
