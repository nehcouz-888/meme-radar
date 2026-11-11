#!/bin/bash
# Rollback script for audit fixes
# Usage: ./rollback.sh <backup-dir>

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <backup-dir>"
  echo "Example: $0 /workspace/backups/pre-audit-fixes-20261112-120000"
  exit 1
fi

BACKUP_DIR="$1"
ROOT="/workspace/meme-radar-run/meme-radar-branch"

if [ ! -d "$BACKUP_DIR" ]; then
  echo "❌ Error: Backup directory not found: $BACKUP_DIR"
  exit 1
fi

echo "=== Rollback Script for Audit Fixes ==="
echo "Backup directory: $BACKUP_DIR"
echo ""

# Verify backup manifest
if [ ! -f "$BACKUP_DIR/BACKUP-MANIFEST.txt" ]; then
  echo "⚠️  Warning: BACKUP-MANIFEST.txt not found"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo "📋 Backup manifest:"
cat "$BACKUP_DIR/BACKUP-MANIFEST.txt" 2>/dev/null || echo "  (not available)"
echo ""

read -p "🔄 Proceed with rollback? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Rollback cancelled"
  exit 0
fi

echo ""
echo "🔄 Rolling back files..."

# Rollback fomo-free-scan
if [ -f "$BACKUP_DIR/scan-accum/fomo-free-scan.mjs" ]; then
  echo "  - Restoring fomo-free-scan.mjs"
  cp "$BACKUP_DIR/scan-accum/fomo-free-scan.mjs" \
     "/workspace/meme-radar-run/scan-accum/fomo-free/fomo-free-scan.mjs"
  
  # Verify checksum if available
  if [ -f "$BACKUP_DIR/scan-accum/fomo-free-scan.mjs.sha256" ]; then
    cd "/workspace/meme-radar-run/scan-accum/fomo-free"
    if sha256sum -c "$BACKUP_DIR/scan-accum/fomo-free-scan.mjs.sha256" 2>/dev/null; then
      echo "    ✅ Checksum verified"
    else
      echo "    ⚠️  Checksum mismatch - file may have changed"
    fi
    cd - > /dev/null
  fi
fi

# Rollback exit-downgrade-run
if [ -f "$BACKUP_DIR/scripts/exit-downgrade-run.mjs" ]; then
  echo "  - Restoring exit-downgrade-run.mjs"
  cp "$BACKUP_DIR/scripts/exit-downgrade-run.mjs" \
     "$ROOT/scripts/exit-downgrade-run.mjs"
  
  if [ -f "$BACKUP_DIR/scripts/exit-downgrade-run.mjs.sha256" ]; then
    cd "$ROOT/scripts"
    if sha256sum -c "$BACKUP_DIR/scripts/exit-downgrade-run.mjs.sha256" 2>/dev/null; then
      echo "    ✅ Checksum verified"
    else
      echo "    ⚠️  Checksum mismatch"
    fi
    cd - > /dev/null
  fi
fi

# Rollback config files
if [ -d "$BACKUP_DIR/config" ] && [ "$(ls -A "$BACKUP_DIR/config")" ]; then
  echo "  - Restoring config files"
  cp "$BACKUP_DIR/config/"*.json "$ROOT/config/" 2>/dev/null || true
fi

# ⚠️ State files (watchlist, ledger) - ASK before restoring
echo ""
echo "⚠️  State file rollback:"
if [ -f "$BACKUP_DIR/state/watchlist.json" ]; then
  read -p "   Restore watchlist.json? This will LOSE any new registrations (y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "  - Restoring watchlist.json"
    cp "$BACKUP_DIR/state/watchlist.json" \
       "$ROOT/narrative-early/state/watchlist.json"
  else
    echo "  - Skipping watchlist.json (keeping current)"
  fi
fi

if [ -f "$BACKUP_DIR/state/fomo-credits-ledger.json" ]; then
  read -p "   Restore fomo-credits-ledger.json? This will LOSE recent credit tracking (y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "  - Restoring fomo-credits-ledger.json"
    cp "$BACKUP_DIR/state/fomo-credits-ledger.json" \
       "$ROOT/state/fomo-credits-ledger.json"
  else
    echo "  - Skipping ledger (keeping current)"
  fi
fi

echo ""
echo "✅ Rollback complete"
echo ""
echo "⚠️  Remember to:"
echo "  1. Verify scripts with: node --check <file.mjs>"
echo "  2. Run offline tests: npm test"
echo "  3. Check logs for any errors"
echo "  4. Monitor next scan run"
