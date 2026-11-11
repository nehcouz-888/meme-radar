#!/bin/bash
# Backup script for audit fixes deployment
# Usage: ./backup.sh [backup-dir]

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${1:-/workspace/backups/pre-audit-fixes-$TIMESTAMP}"
ROOT="/workspace/meme-radar-run/meme-radar-branch"

echo "=== Backup Script for Audit Fixes ==="
echo "Timestamp: $TIMESTAMP"
echo "Backup directory: $BACKUP_DIR"
echo ""

# Create backup directory
mkdir -p "$BACKUP_DIR"/{scan-accum,scripts,config,state}

echo "📦 Backing up files..."

# Backup fomo-free-scan
if [ -f "/workspace/meme-radar-run/scan-accum/fomo-free/fomo-free-scan.mjs" ]; then
  echo "  - fomo-free-scan.mjs"
  cp "/workspace/meme-radar-run/scan-accum/fomo-free/fomo-free-scan.mjs" \
     "$BACKUP_DIR/scan-accum/fomo-free-scan.mjs"
  sha256sum "/workspace/meme-radar-run/scan-accum/fomo-free/fomo-free-scan.mjs" \
     > "$BACKUP_DIR/scan-accum/fomo-free-scan.mjs.sha256"
fi

# Backup exit-downgrade-run
if [ -f "$ROOT/scripts/exit-downgrade-run.mjs" ]; then
  echo "  - exit-downgrade-run.mjs"
  cp "$ROOT/scripts/exit-downgrade-run.mjs" \
     "$BACKUP_DIR/scripts/exit-downgrade-run.mjs"
  sha256sum "$ROOT/scripts/exit-downgrade-run.mjs" \
     > "$BACKUP_DIR/scripts/exit-downgrade-run.mjs.sha256"
fi

# Backup config files
if [ -d "$ROOT/config" ]; then
  echo "  - config/*.json"
  cp "$ROOT/config/"*.json "$BACKUP_DIR/config/" 2>/dev/null || true
fi

# Backup state files (watchlist, ledger)
if [ -f "$ROOT/narrative-early/state/watchlist.json" ]; then
  echo "  - watchlist.json"
  cp "$ROOT/narrative-early/state/watchlist.json" \
     "$BACKUP_DIR/state/watchlist.json"
fi

if [ -f "$ROOT/state/fomo-credits-ledger.json" ]; then
  echo "  - fomo-credits-ledger.json"
  cp "$ROOT/state/fomo-credits-ledger.json" \
     "$BACKUP_DIR/state/fomo-credits-ledger.json"
fi

# Create manifest
cat > "$BACKUP_DIR/BACKUP-MANIFEST.txt" <<EOF
Backup Created: $TIMESTAMP
Purpose: Pre-deployment backup for audit fixes
Repository: https://github.com/nehcouz-888/meme-radar
Branch: cursor/smart-money-live-holding-fix-c671

Files Backed Up:
$(find "$BACKUP_DIR" -type f | sort)

Checksums:
$(find "$BACKUP_DIR" -name "*.sha256" -exec cat {} \;)

To Rollback:
./rollback.sh "$BACKUP_DIR"
EOF

echo ""
echo "✅ Backup complete: $BACKUP_DIR"
echo "   Files: $(find "$BACKUP_DIR" -type f | wc -l)"
echo "   Size: $(du -sh "$BACKUP_DIR" | cut -f1)"
echo ""
echo "To rollback: ./rollback.sh \"$BACKUP_DIR\""
