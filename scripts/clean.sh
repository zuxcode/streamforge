#!/usr/bin/env bash
set -euo pipefail

echo "🧹 Removing node_modules..."
find . -type d -name node_modules -prune -exec rm -rf {} +

echo "🧹 Removing bun.lock..."
rm -f bun.lock

echo "🧹 Removing stray '~' directory..."
rm -rf ./~

echo "✅ Cleanup complete."