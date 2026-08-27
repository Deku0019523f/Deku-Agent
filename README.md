# Deku Agent — V1.0

Agent de développement autonome. Boucle agentique (planning explicite → action → observation) avec 4 providers LLM (OpenRouter, Gemini, Groq, OpenAI), permissions granulaires, rollback via snapshots Git, délégation à des sous-agents, extensibilité via MCP et plugins, et intégration GitHub distante.

Conçu pour Termux (Android), fonctionne aussi bien sur Linux/macOS/WSL.

## Installation

Prérequis commun : [Bun](https://bun.sh) (runtime JS/TS, aucune compilation native requise — `bun:sqlite` est natif à Bun).

### Termux (Android)

```bash
pkg update -y
pkg install -y git unzip

curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

git clone https://github.com/Deku0019523f/Deku-Agent.git ~/deku-agent
cd ~/deku-agent
bun install
```

### PC — Linux / macOS

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc   # ou ~/.zshrc selon le shell

git clone https://github.com/Deku0019523f/Deku-Agent.git ~/deku-agent
cd ~/deku-agent
bun install
```

### PC — Windows

Bun ne supporte pas nativement Windows en dehors de WSL. Installe [WSL2](https://learn.microsoft.com/windows/wsl/install) (Ubuntu recommandé), puis suis les étapes **Linux / macOS** ci-dessus depuis un terminal WSL.

### Vérifier l'installation

```bash
bun run src/cli.ts --help
```

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

Alternative aux variables d'environnement : un assistant interactif façon Cline, qui enregistre la clé et laisse choisir le modèle dans le catalogue du provider.

`bun run start` (ou `deku`, sans argument) **démarre toujours**, même sans aucune clé configurée — la session interactive s'ouvre et propose `/config` directement au prompt :

```
╭────────────────────────────────────────╮
│              DEKU AGENT                 │
╰────────────────────────────────────────╯
Project : ~/mon-projet
Tape /config pour ajouter une clé API / changer de modèle, /help pour l'aide.

Objectif (ou /config, /help) > /config

⚙️  Configuration Deku Agent

Quel provider configurer ?
  1. OpenRouter
  2. Gemini (Google)
  3. Groq
  4. OpenAI
> 3

Clé API Groq : ****************************

Récupération des modèles disponibles...
Quel modèle Groq utiliser par défaut ?
  1. llama-3.3-70b-versatile
  2. llama-3.1-8b-instant
  ...
> 1

✓ Configuré: Groq / llama-3.3-70b-versatile

Objectif (ou /config, /help) >
```

Après `/config`, retape directement ton objectif au même prompt — pas besoin de relancer le programme. Commandes disponibles en session : `/config`, `/help`, `/exit` (ou `/quit`).

`deku config` (en dehors de toute session, une seule fois) fait exactement la même chose en ligne de commande directe. Dans les deux cas, la clé est stockée dans `~/.deku-agent/credentials.json` (permissions 600, jamais dans un projet ni committée) ; une variable d'environnement déjà exportée reste toujours prioritaire sur celle sauvegardée.

Commandes scriptables (sans passer par l'assistant) :

```bash
deku config show                          # config actuelle, clés masquées
deku config set-key groq gsk_...          # enregistre une clé directement
deku config set-model groq llama-3.3-70b-versatile  # change le défaut
deku config remove-key groq               # supprime une clé sauvegardée
```

### Alias pratique

```bash
echo 'alias deku="bun run ~/deku-agent/src/cli.ts"' >> ~/.bashrc
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
- **Config interactive** (`deku config`) : ajout de clé API et choix du modèle après le lancement (façon Cline), catalogue de modèles fetché en direct par provider avec repli statique
- **Project Scanner** (`src/contexte/scanner.ts`) : détecte langage, framework, package manager, nombre de fichiers/tests, présence de `.env`, fichiers clés — injecté dans le prompt système
- **Mémoire SQLite** (`src/memory/`) via `bun:sqlite` : sessions/messages persistés dans `~/.deku-agent/deku.db`, `--resume` reprend une session interrompue, historique des snapshots
- Mode `--plan` (aucune modification, aucun appel GitHub) et `--auto` (SAFE sans confirmation — les écritures GitHub et les rollbacks restent toujours confirmés)
- CLI terminal avec rendu de la boucle en temps réel

**Pas encore fait (pistes pour la suite) :**
- Rafraîchissement dynamique des outils MCP en cours de run (`notifications/tools/list_changed` actuellement ignoré)
- Tests automatisés (unitaires/intégration) — validation actuelle faite manuellement par scénarios bundlés (esbuild) contre de vrais serveurs MCP/GitHub
- Sandbox pour les plugins (actuellement exécution en process, sans isolation)

## Points d'attention techniques

- **Gemini** a un format de tool calling différent des 3 autres (rôles `user`/`model`, pas de rôle `tool` natif, schema JSON plus strict) — géré dans `src/providers/gemini.ts`.
- Les outils filesystem sont **restreints au `--cwd`** — toute tentative de sortir du workspace est bloquée.
- La base SQLite est **globale** (`~/.deku-agent/deku.db`) ; sessions/mémoire/snapshots sont séparés par `project_path`. Supprime ce fichier pour tout réinitialiser.
- `--resume` ne retrouve que les sessions au statut `running` (interrompues) — une session `completed` ne peut pas être reprise, seulement consultée en base.
- Les snapshots Git automatiques nécessitent un dépôt Git initialisé dans `--cwd` ; hors dépôt Git, ils sont silencieusement désactivés (pas de rollback possible, le reste de l'agent fonctionne normalement).
- Un plugin ou serveur MCP mal configuré ne bloque jamais le démarrage : l'agent journalise un avertissement et continue sans lui.
