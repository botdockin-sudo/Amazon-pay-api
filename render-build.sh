#!/usr/bin/env bash
# exit on error
set -o errexit

npm install

# Chrome install karne ke liye (Puppeteer ke liye zaroori hai)
# Agar aap Render ke free tier par hain, toh niche wali lines kaam karengi
if [[ ! -d $PUPPETEER_CACHE_DIR ]]; then
  echo "Installing Chrome..."
  # Ye command puppeteer ko chrome download karne par majboor karegi
  npx puppeteer install
fi
