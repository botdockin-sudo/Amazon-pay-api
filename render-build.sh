#!/usr/bin/env bash
set -o errexit

npm install
# Isse Puppeteer apna browser khud install karega Render ke folder mein
npx puppeteer install
