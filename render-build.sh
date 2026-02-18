#!/usr/bin/env bash
set -o errexit
set -o pipefail

# Fonction de logging
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

log "📦 Installation des dépendances..."
npm cache verify

if [ -f "package-lock.json" ]; then
    npm ci --only=production
else
    npm install --production
fi

RENDER_CACHE_DIR="${RENDER_BUILD_CACHE:-/opt/render/.cache}"
PUPPETEER_CACHE_DIR="${RENDER_CACHE_DIR}/puppeteer"
mkdir -p "$PUPPETEER_CACHE_DIR"

export PUPPETEER_CACHE_DIR="$PUPPETEER_CACHE_DIR"
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="false"

log "🌐 Installation de Chrome pour Puppeteer..."

if ! npx puppeteer browsers install chrome; then
    log "❌ Échec de l'installation de Chrome"
    exit 1
fi

if [ -d "$PUPPETEER_CACHE_DIR/chrome" ]; then
    CHROME_VERSION=$(ls "$PUPPETEER_CACHE_DIR/chrome" | head -1)
    log "✅ Chrome installé: $CHROME_VERSION"
else
    log "⚠️ Chrome installé mais chemin non standard"
fi

npm cache clean --force
log "✅ Build terminé avec succès!"
