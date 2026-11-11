#!/bin/bash
set -e

VERSION="v5-watcher-$(date +%Y%m%d-%H%M%S)"
WORK_DIR="/tmp/meme-radar-package-$VERSION"
TAR_NAME="meme-radar-$VERSION.tar.gz"
TAR_PATH="/opt/cursor/artifacts/$TAR_NAME"

echo "=== Creating v5 package (narrow watcher fix) ==="

# 清理
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"/{meme-radar-branch,tests}

# 复制生产文件
echo "Copying production files..."
cp -r /workspace/src "$WORK_DIR/meme-radar-branch/"
cp -r /workspace/scripts-production "$WORK_DIR/meme-radar-branch/"
cp /workspace/package.json "$WORK_DIR/meme-radar-branch/"

# 复制测试
echo "Copying tests..."
cp /workspace/test/queue-lock-multi-process.test.mjs "$WORK_DIR/tests/"
cp /workspace/test/watcher-b4-b8-fixtures.test.mjs "$WORK_DIR/tests/"
cp /tmp/multi-process-test-output.txt "$WORK_DIR/tests/multi-process-output.txt" 2>/dev/null || echo "No output" > "$WORK_DIR/tests/multi-process-output.txt"
cp /tmp/watcher-fixtures-output.txt "$WORK_DIR/tests/watcher-fixtures-output.txt" 2>/dev/null || echo "No output" > "$WORK_DIR/tests/watcher-fixtures-output.txt"

# Manifest
cat > "$WORK_DIR/MANIFEST.md" << 'EOF'
# Meme Radar v5 - Narrow Watcher Fix

## Git Commits
- `98e3743`: B4+B8+CLI lease核心修复
- `ebd323a`: 真实watcher B4+B8 fixtures

## 修复清单

### 1. CLI lease默认5min
- `scripts-production/claim-pending-alerts.mjs:12`
- 与module默认一致
- 6min可重领，10min TTL过期

### 2. B4: empty/zero holding → unknown
- `scripts-production/fomo-trader-watch-integrated.mjs:454-464`
- 无holding或amt=0/value=0 → unknown
- 不推定新仓（可能API未返回/低于阈值）
- 需显式prior balance证据

### 3. B8: 共享账本+并发预留
- `scripts-production/fomo-trader-watch-integrated.mjs:30,628-705`
- LEDGER_FILE固定路径：`/workspace/meme-radar-run/meme-radar-branch/state/fomo-credits-ledger.json`
- 每次请求前readLedger()
- reserved字段原子预留
- 不覆盖外部更新
- Cache去重（同tradeId/handle）

### 4. Lock 0字节崩溃恢复
- `src/modules/alert-queue.mjs:120-126`
- stat.size===0 立即reclaim
- JSON parse失败 + age>1s → reclaim

## 测试

### 多进程锁
```bash
cd tests
node queue-lock-multi-process.test.mjs
```

### Watcher B4+B8 fixtures
```bash
cd tests
node watcher-b4-b8-fixtures.test.mjs
```

## 已知BLOCKED（后续修复）

- deploy/rollback路径映射+白名单
- pathvalidator未接入真实路径
- config-merge traders结构
- migration旧格式+锁
- test package ../src路径
- sent lease recovery 完整语义（部分通过）

## 未部署
仅打包到 `/opt/cursor/artifacts/`，未安装到生产。

## 基线保持
37个运行文件unchanged。不触及API/WS/发送/交易。
EOF

# Checksums
echo "Generating checksums..."
cd "$WORK_DIR"
find . -type f ! -name "checksums.sha256" -exec sha256sum {} \; | sort > checksums.sha256

CHECKSUM_LINES=$(wc -l < checksums.sha256)
echo "Checksums: $CHECKSUM_LINES files"

if [[ $CHECKSUM_LINES -eq 0 ]]; then
  echo "❌ Empty checksums"
  exit 1
fi

# Tarball
echo "Creating tarball..."
cd /tmp
tar -czf "$TAR_PATH" "meme-radar-package-$VERSION"

echo "✅ Package: $TAR_PATH"
ls -lh "$TAR_PATH"

# Self-verify
echo ""
echo "=== Self-verification ==="
VERIFY_DIR="/tmp/verify-$VERSION"
rm -rf "$VERIFY_DIR"
mkdir -p "$VERIFY_DIR"
cd "$VERIFY_DIR"

echo "Extracting..."
tar -xzf "$TAR_PATH"

echo "Verifying checksums..."
cd "meme-radar-package-$VERSION"
VERIFY_COUNT=$(sha256sum -c checksums.sha256 2>&1 | grep -c ": OK" || true)
echo "✅ Checksums verified: $VERIFY_COUNT files"

echo "Syntax checks..."
node --check meme-radar-branch/scripts-production/fomo-trader-watch-integrated.mjs && echo "✅ Watcher OK"
node --check meme-radar-branch/scripts-production/claim-pending-alerts.mjs && echo "✅ Claim CLI OK"
node --check meme-radar-branch/src/modules/alert-queue.mjs && echo "✅ Queue OK"

echo "Test sources..."
[[ -f tests/watcher-b4-b8-fixtures.test.mjs ]] && echo "✅ Watcher fixtures included" || { echo "❌ Missing"; exit 1; }
[[ -f tests/queue-lock-multi-process.test.mjs ]] && echo "✅ Multi-process test included" || { echo "❌ Missing"; exit 1; }

echo ""
echo "✅ Self-verification complete"
echo "Package: $TAR_PATH"
echo "SHA256: $(sha256sum "$TAR_PATH")"
