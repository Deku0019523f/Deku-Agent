#!/usr/bin/env bash
# Installateur Deku Agent — Termux et Linux/macOS.
# Usage :
#   curl -fsSL https://raw.githubusercontent.com/Deku0019523f/Deku-Agent/main/scripts/install.sh | bash
#
# Runtime : Node.js (>=18). Bun n'est PAS utilisé : le binaire officiel de
# Bun n'est pas compilé en PIE et ne peut pas s'exécuter sur Android/Termux
# (voir https://github.com/oven-sh/bun/issues/28924). Node fonctionne
# nativement sur Termux (paquet `nodejs` officiel), sans chroot ni proot.
set -euo pipefail

REPO_URL="https://github.com/Deku0019523f/Deku-Agent.git"
MIN_NODE_MAJOR=18

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
# Prérequis : Node.js >= 18
# ------------------------------------------------------------------
node_major_version() {
  command -v node >/dev/null 2>&1 && node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

if [[ "$(node_major_version)" -lt "$MIN_NODE_MAJOR" ]]; then
  if command -v node >/dev/null 2>&1; then
    info "Node.js présent mais trop ancien ($(node --version)), mise à niveau..."
  else
    info "Node.js absent, installation..."
  fi
  if [[ "$IS_TERMUX" == true ]]; then
    pkg install -y nodejs
  elif command -v apt >/dev/null 2>&1; then
    sudo apt update -y && sudo apt install -y nodejs npm
  elif command -v brew >/dev/null 2>&1; then
    brew install node
  else
    err "Node.js introuvable et impossible à installer automatiquement. Installe Node.js >= $MIN_NODE_MAJOR manuellement (https://nodejs.org) puis relance ce script."
    exit 1
  fi
  if [[ "$(node_major_version)" -lt "$MIN_NODE_MAJOR" ]]; then
    err "Échec de l'installation de Node.js >= $MIN_NODE_MAJOR. Installe-le manuellement puis relance ce script."
    exit 1
  fi
  ok "Node.js installé ($(node --version))."
else
  ok "Node.js déjà présent ($(node --version))."
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
# Dépendances + build (TypeScript -> dist/*.js)
# ------------------------------------------------------------------
info "Installation des dépendances (npm install)..."
rm -rf "$INSTALL_DIR/node_modules"  # évite tout résidu d'une install Bun précédente
(cd "$INSTALL_DIR" && npm install --no-audit --no-fund --silent)
ok "Dépendances installées."

info "Compilation (npm run build)..."
(cd "$INSTALL_DIR" && npm run build --silent)
if [[ ! -f "$INSTALL_DIR/dist/cli.js" ]]; then
  err "La compilation n'a pas produit dist/cli.js. Essaie manuellement : cd $INSTALL_DIR && npm run build"
  exit 1
fi
ok "Compilation terminée."

# ------------------------------------------------------------------
# Lanceur `deku`
# ------------------------------------------------------------------
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/deku"

cat > "$LAUNCHER" << LAUNCHER_EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/dist/cli.js" "\$@"
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
if VERSION_OUTPUT="$("$LAUNCHER" --version 2>&1)"; then
  ok "deku --version -> $VERSION_OUTPUT"
else
  err "Le lanceur 'deku' ne démarre pas correctement (sortie : $VERSION_OUTPUT). Essaie manuellement : node $INSTALL_DIR/dist/cli.js"
  exit 1
fi

echo
ok "Deku Agent installé. Run: deku"
