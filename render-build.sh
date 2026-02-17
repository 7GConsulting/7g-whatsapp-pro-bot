#!/usr/bin/env bash

# Sortir en cas d'erreur
set -o errexit

echo "📦 Installation des dépendances..."
npm install

# Configuration du cache Puppeteer
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

echo "🌐 Installation de Chrome pour Puppeteer..."
npx puppeteer browsers install chrome

# CRÉER LE DOSSIER DE CACHE LOCAL S'IL N'EXISTE PAS
mkdir -p /opt/render/project/src/.cache/puppeteer/chrome

# Copier Chrome vers le cache pour les prochains builds
if [[ -d $PUPPETEER_CACHE_DIR ]]; then
    echo "...Stockage de Chrome dans le cache de build"
    cp -R $PUPPETEER_CACHE_DIR/* /opt/render/project/src/.cache/puppeteer/chrome/ 2>/dev/null || true
fi

echo "✅ Build terminé avec succès!"