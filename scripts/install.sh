#!/usr/bin/env bash
# Installateur Deku Agent — Termux et Linux/macOS.
# Usage :
#   curl -fsSL https://raw.githubusercontent.com/Deku0019523f/Deku-Agent/main/scripts/install.sh | bash
set -euo pipefail

REPO_URL="https://github.com/Deku0019523f/Deku-Agent.git"

info() { printf "\033[36m[info]\033[0m %s\n" "$1"; }
ok()   { printf "\033[32m[ok]\033[0m %s\n" "$1"; }
err()  { printf "\033[31m[erreur]\033[0m %s\n" "$1" >&2; }

# ------------------------------------------------------------------
# Détection de l'environnement (Termux vs Linux/macOS générique)
# ------------------------------------------------------------------
IS_TERMUX=false
if [[ -n "${PREFIX:-}" && "$PREFIX" == *"com.termux"* ]]; then
  IS_TERMUX=true
fi

if [[ "$IS_TERMUX" == true ]]; then
  INSTALL_DIR="$PREFIX/opt/deku-agent"
  BIN_DIR="$PREFIX/bin"
else
  INSTALL_DIR="$HOME/.local/opt/deku-agent"
  BIN_DIR="$HOME/.local/bin"
fi

# ------------------------------------------------------------------
# Prérequis : git
# ------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  info "git absent, installation..."
  if [[ "$IS_TERMUX" == true ]]; then
    pkg install -y git
  elif command -v apt >/dev/null 2>&1; then
    sudo apt update -y && sudo apt install -y git
  elif command -v brew >/dev/null 2>&1; then
    brew install git
  else
    err "git introuvable et impossible à installer automatiquement sur ce système. Installe-le manuellement puis relance ce script."
    exit 1
  fi
  ok "git installé."
fi

# ------------------------------------------------------------------
# Prérequis : Bun
# ------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  info "Bun absent, installation..."
  curl -fsSL https://bun.sh/install | bash
  # bun s'installe dans ~/.bun/bin, pas garanti d'être déjà dans PATH pour ce shell
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    err "Bun installé mais introuvable dans le PATH. Ouvre un nouveau terminal (ou 'source ~/.bashrc') puis relance ce script."
    exit 1
  fi
  ok "Bun installé ($(bun --version))."
else
  ok "Bun déjà présent ($(bun --version))."
fi

# ------------------------------------------------------------------
# Clone / mise à jour du dépôt
# ------------------------------------------------------------------
mkdir -p "$(dirname "$INSTALL_DIR")"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Installation existante détectée, mise à jour..."
  git -C "$INSTALL_DIR" fetch --quiet origin main
  git -C "$INSTALL_DIR" reset --quiet --hard origin/main
  ok "Dépôt mis à jour."
else
  info "Téléchargement de Deku Agent..."
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Dépôt cloné dans $INSTALL_DIR"
fi

# ------------------------------------------------------------------
# Dépendances
# ------------------------------------------------------------------
info "Installation des dépendances (bun install)..."
(cd "$INSTALL_DIR" && bun install --silent)
ok "Dépendances installées."

# ------------------------------------------------------------------
# Lanceur `deku`
# ------------------------------------------------------------------
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/deku"

cat > "$LAUNCHER" << LAUNCHER_EOF
#!/usr/bin/env bash
exec bun run "$INSTALL_DIR/src/cli.ts" "\$@"
LAUNCHER_EOF
chmod +x "$LAUNCHER"
ok "Lanceur créé à $LAUNCHER"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  info "$BIN_DIR n'est pas dans ton PATH."
  SHELL_RC="$HOME/.bashrc"
  [[ "${SHELL:-}" == *zsh* ]] && SHELL_RC="$HOME/.zshrc"
  if ! grep -qs "$BIN_DIR" "$SHELL_RC" 2>/dev/null; then
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
    info "Ajouté à $SHELL_RC — ouvre un nouveau terminal (ou 'source $SHELL_RC') pour que 'deku' soit reconnu."
  fi
  export PATH="$BIN_DIR:$PATH"
fi

# ------------------------------------------------------------------
# Tests de fumée
# ------------------------------------------------------------------
info "Tests de fumée..."
if "$LAUNCHER" --version >/dev/null 2>&1; then
  ok "deku --version fonctionne."
else
  err "Le lanceur 'deku' ne démarre pas correctement. Essaie manuellement : bun run $INSTALL_DIR/src/cli.ts"
  exit 1
fi

echo
ok "Deku Agent installé. Run: deku"
