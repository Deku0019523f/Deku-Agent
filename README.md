# Deku Agent — V0.4

Agent de développement autonome pour Android/Termux. Boucle agentique + 4 providers LLM (OpenRouter, Gemini, Groq, OpenAI) + outils filesystem/terminal de base.

## Installation (Termux)

```bash
pkg install -y unzip
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

unzip deku-agent.zip -d ~/
cd ~/deku-agent
bun install
```

## Configuration

Exporte les clés API des providers que tu comptes utiliser :

```bash
export OPENROUTER_API_KEY="..."
export GEMINI_API_KEY="..."
export GROQ_API_KEY="..."
export OPENAI_API_KEY="..."
```

Ajoute ces lignes à `~/.bashrc` pour ne pas les retaper à chaque session.

## Utilisation

```bash
# Mode interactif
bun run src/cli.ts

# Objectif direct, provider Groq, sur un projet précis
bun run src/cli.ts "Corrige le bug de connexion WhatsApp" \
  --provider groq --model llama-3.3-70b-versatile --cwd ~/whatsapp-gateway

# Mode plan (analyse seulement, ne modifie rien)
bun run src/cli.ts "Ajoute une auth JWT" --plan

# Mode auto (enchaîne les commandes SAFE sans confirmer)
bun run src/cli.ts "Lance les tests et corrige les erreurs" --auto

# Reprendre la dernière session interrompue sur ce projet
bun run src/cli.ts --resume --cwd ~/whatsapp-gateway
```

Astuce : `alias deku="bun run ~/deku-agent/src/cli.ts"` dans `~/.bashrc` pour lancer `deku` depuis n'importe quel dossier.

## Où en est le projet

**Fait (V0.1 → V0.4) :**
- Protocole interne commun LLM ↔ Tools (`src/types.ts`)
- 4 adaptateurs providers avec traduction de format (OpenAI-style pour OpenRouter/Groq/OpenAI, format natif pour Gemini)
- Boucle agentique (OBJECTIF → PLAN → ACTION → OBSERVATION → ... → TERMINÉ) avec limite d'itérations
- Outils filesystem : `read_file`, `write_file`, `list_files`
- Outils recherche : `grep_search`, `find_files` (pur Node, sans dépendance à ripgrep)
- Outils Git : `git_status`, `git_diff`, `git_log`, `git_commit`, `git_branch`
- Outil shell générique : `run_command`
- Permissions SAFE/CONFIRM/DANGEROUS partagées par `run_command` et les outils `git_*`
- **Project Scanner** (`src/context/scanner.ts`) : détecte langage (Node.js/TypeScript, Python...), framework (Express, Next.js, Baileys, discord.js...), package manager, nombre de fichiers/tests, présence de `.env`, fichiers clés — injecté dans le prompt système à la place d'un listing brut
- **Mémoire SQLite** (`src/memory/`) via `bun:sqlite` (natif à Bun, aucune compilation requise — contrairement à `better-sqlite3`) :
  - Sessions et messages persistés au fil de l'eau dans `~/.deku-agent/deku.db`
  - `--resume` reprend la dernière session interrompue sur le projet courant (crash, fermeture Termux)
  - Table `project_memory` (clé/valeur) prête à recevoir des notes persistantes par projet (l'agent pourra y écrire lui-même en V0.6+ via un outil `remember`)
- Mode `--plan` (aucune modification) et `--auto` (SAFE sans confirmation)
- CLI terminal avec rendu de la boucle en temps réel

**Pas encore fait (suite de la roadmap) :**
- V0.5 : rollback via snapshots Git, permissions plus fines
- V0.6 : Planning explicite avant action, error recovery automatique
- V1.0 : MCP, plugins, sous-agents, intégration GitHub distante

## Points d'attention techniques

- **Gemini** a un format de tool calling différent des 3 autres (rôles `user`/`model`, pas de rôle `tool` natif, schema JSON plus strict) — c'est géré dans `src/providers/gemini.ts`, à garder en tête si tu ajoutes des tools avec des schémas complexes.
- Les outils filesystem sont **restreints au `--cwd`** — toute tentative de sortir du workspace est bloquée (garde-fou basique, sera remplacé par le vrai système de permissions en V0.5).
- La base SQLite est **globale** (`~/.deku-agent/deku.db`), pas une base par projet — les sessions/mémoire sont séparées par `project_path` en base. Supprime ce fichier pour tout réinitialiser.
- `--resume` ne retrouve que les sessions au statut `running` (interrompues) — une session `completed` ne peut pas être reprise, seulement consultée en base.
