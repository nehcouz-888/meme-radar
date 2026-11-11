#!/bin/bash
set -e

DEPLOY_TARGET="/workspace/meme-radar-run/meme-radar-branch"
BACKUP_DIR="/workspace/meme-radar-run/.deploy-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH="$BACKUP_DIR/backup-$TIMESTAMP"

# 保护目录白名单
PROTECTED_DIRS=(
  "state"
  "config"
)

usage() {
  echo "Usage: $0 <deploy|rollback>"
  echo "  deploy   - Deploy from /workspace to $DEPLOY_TARGET"
  echo "  rollback - Rollback to previous state using latest backup"
  exit 1
}

# 计算文件hash
hash_file() {
  sha256sum "$1" | awk '{print $1}'
}

# 检查路径是否受保护
is_protected() {
  local path="$1"
  for protected in "${PROTECTED_DIRS[@]}"; do
    if [[ "$path" == "$DEPLOY_TARGET/$protected"* ]]; then
      return 0
    fi
  done
  return 1
}

deploy() {
  echo "=== Deploying Fomo Watcher ==="
  
  # 创建备份目录
  mkdir -p "$BACKUP_PATH"
  
  # 记录所有现有文件的hash
  echo "Recording existing files..."
  if [[ -d "$DEPLOY_TARGET" ]]; then
    find "$DEPLOY_TARGET" -type f ! -path "*/state/*" ! -path "*/config/*" ! -path "*/.deploy-backups/*" -exec sha256sum {} \; | sort > "$BACKUP_PATH/files-before.sha256"
  else
    touch "$BACKUP_PATH/files-before.sha256"
  fi
  
  # 复制文件（排除保护目录）
  echo "Copying files..."
  mkdir -p "$DEPLOY_TARGET"
  
  # 复制src
  rsync -a --delete /workspace/src/ "$DEPLOY_TARGET/src/"
  
  # 复制scripts-production
  rsync -a --delete /workspace/scripts-production/ "$DEPLOY_TARGET/scripts-production/"
  
  # 复制package.json
  cp /workspace/package.json "$DEPLOY_TARGET/"
  
  # 记录部署后所有文件的hash
  echo "Recording deployed files..."
  find "$DEPLOY_TARGET" -type f ! -path "*/state/*" ! -path "*/config/*" ! -path "*/.deploy-backups/*" -exec sha256sum {} \; | sort > "$BACKUP_PATH/files-after.sha256"
  
  # 找出新增文件
  echo "Identifying new files..."
  comm -13 \
    <(awk '{print $2}' "$BACKUP_PATH/files-before.sha256" | sort) \
    <(awk '{print $2}' "$BACKUP_PATH/files-after.sha256" | sort) \
    > "$BACKUP_PATH/new-files.txt"
  
  # 找出修改的文件
  echo "Identifying modified files..."
  comm -12 \
    <(awk '{print $2}' "$BACKUP_PATH/files-before.sha256" | sort) \
    <(awk '{print $2}' "$BACKUP_TARGET/files-after.sha256" | sort) \
    | while read file; do
      hash_before=$(grep "$file" "$BACKUP_PATH/files-before.sha256" | awk '{print $1}')
      hash_after=$(grep "$file" "$BACKUP_PATH/files-after.sha256" | awk '{print $1}')
      if [[ "$hash_before" != "$hash_after" ]]; then
        echo "$file" >> "$BACKUP_PATH/modified-files.txt"
        # 备份旧版本
        mkdir -p "$BACKUP_PATH/old-versions/$(dirname "$file")"
        cp "$file" "$BACKUP_PATH/old-versions/$file" 2>/dev/null || true
      fi
    done
  
  touch "$BACKUP_PATH/modified-files.txt"
  
  # 保存部署元数据
  cat > "$BACKUP_PATH/deploy-metadata.json" << EOF
{
  "timestamp": "$TIMESTAMP",
  "target": "$DEPLOY_TARGET",
  "newFiles": $(wc -l < "$BACKUP_PATH/new-files.txt"),
  "modifiedFiles": $(wc -l < "$BACKUP_PATH/modified-files.txt"),
  "protectedDirs": [$(printf '"%s",' "${PROTECTED_DIRS[@]}" | sed 's/,$//')],
  "gitCommit": "$(cd /workspace && git rev-parse HEAD)"
}
EOF
  
  echo "✅ Deploy complete"
  echo "Backup saved to: $BACKUP_PATH"
  echo "New files: $(wc -l < "$BACKUP_PATH/new-files.txt")"
  echo "Modified files: $(wc -l < "$BACKUP_PATH/modified-files.txt")"
  echo "Protected: state/, config/"
}

rollback() {
  echo "=== Rolling back Fomo Watcher ==="
  
  # 找最新备份
  LATEST_BACKUP=$(ls -1t "$BACKUP_DIR" | head -1)
  if [[ -z "$LATEST_BACKUP" ]]; then
    echo "❌ No backup found"
    exit 1
  fi
  
  RESTORE_PATH="$BACKUP_DIR/$LATEST_BACKUP"
  echo "Rolling back using: $RESTORE_PATH"
  
  # 验证备份完整性
  if [[ ! -f "$RESTORE_PATH/files-before.sha256" ]] || \
     [[ ! -f "$RESTORE_PATH/new-files.txt" ]] || \
     [[ ! -f "$RESTORE_PATH/deploy-metadata.json" ]]; then
    echo "❌ Backup incomplete or corrupted"
    exit 1
  fi
  
  # 删除新增文件
  echo "Removing new files..."
  while IFS= read -r file; do
    if ! is_protected "$file"; then
      rm -f "$file"
      echo "  Removed: $file"
    else
      echo "  Skipped (protected): $file"
    fi
  done < "$RESTORE_PATH/new-files.txt"
  
  # 恢复修改的文件
  echo "Restoring modified files..."
  if [[ -f "$RESTORE_PATH/modified-files.txt" ]]; then
    while IFS= read -r file; do
      if ! is_protected "$file"; then
        if [[ -f "$RESTORE_PATH/old-versions/$file" ]]; then
          cp "$RESTORE_PATH/old-versions/$file" "$file"
          echo "  Restored: $file"
        fi
      else
        echo "  Skipped (protected): $file"
      fi
    done < "$RESTORE_PATH/modified-files.txt"
  fi
  
  # 清理空目录
  find "$DEPLOY_TARGET" -type d -empty ! -path "*/state/*" ! -path "*/config/*" -delete 2>/dev/null || true
  
  echo "✅ Rollback complete"
  echo "Backup retained at: $RESTORE_PATH"
}

# 主逻辑
case "${1:-}" in
  deploy)
    deploy
    ;;
  rollback)
    rollback
    ;;
  *)
    usage
    ;;
esac
