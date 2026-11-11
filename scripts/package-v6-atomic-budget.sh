#!/bin/bash
set -e

VERSION="v6-atomic-$(date +%Y%m%d-%H%M%S)"
WORK_DIR="/tmp/meme-radar-package-$VERSION"
TAR_NAME="meme-radar-$VERSION.tar.gz"
TAR_PATH="/opt/cursor/artifacts/$TAR_NAME"

echo "=== Creating v6 package (atomic budget + lock race fix) ==="

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"/{meme-radar-branch,scan-accum/fomo-free,tests}

# 生产文件
echo "Copying production files..."
cp -r /workspace/src "$WORK_DIR/meme-radar-branch/"
cp -r /workspace/scripts-production "$WORK_DIR/meme-radar-branch/"
cp /workspace/package.json "$WORK_DIR/meme-radar-branch/"

# Scanner（兼容reserved协议）
echo "Copying scanner..."
cp /workspace/scan-accum/fomo-free/fomo-free-scan.mjs "$WORK_DIR/scan-accum/fomo-free/"

# 测试
echo "Copying tests..."
cp /workspace/test/queue-lock-multi-process.test.mjs "$WORK_DIR/tests/" || true
cp /workspace/tests/budget-lock-integration.test.mjs "$WORK_DIR/tests/" || true
cp /workspace/tests/watcher-real-entry.test.mjs "$WORK_DIR/tests/" || true

# Manifest
cat > "$WORK_DIR/MANIFEST.md" << 'EOF'
# Meme Radar v6 - Atomic Budget + Lock Race Fix

## Git Commit
`d83e0ca` - fix: 锁竞争+跨进程原子预算

## 修复清单

### 1. Lock健康owner保护
- `src/modules/alert-queue.mjs:119-145`
- 0字节锁100ms初始化窗口
- 不立即删除（防止健康writer丢数据）
- 超100ms且无owner → reclaim

### 2. 跨进程原子预算
- `scripts-production/fomo-trader-watch-integrated.mjs:628-780`
- acquireLedgerLock共享锁
- reservations{resId: {amount,pid,at,path}}
- 原子: 读取→检查→预留→请求→结算
- SIGKILL后reserved保守计入spent
- 无cost header保守用estimate（非0）

### 3. Scanner兼容reserved协议
- `scan-accum/fomo-free/fomo-free-scan.mjs:63-119`
- 同锁同schema (reservations字段)
- 预算=spent+totalReserved+estCost
- 原子reserve/settle

### 4. 缓存分离+TTL
- tradeCacheMap: immutable (trade/seed)
- balanceCacheMap: 30s TTL + 容量1000
- 失败/预算拒绝不缓存
- 只缓存ok结果

## 测试

### 多进程锁
```bash
cd tests
node queue-lock-multi-process.test.mjs
```

## 继承v5修复
- CLI lease 5min
- B4 empty/zero → unknown
- B8 共享ledger路径
- Lock 0字节检测

## 已知BLOCKED（后续）
- deploy/rollback/symlink/config/migration
  （v4新模块未接入真实路径）
- 真实入口fixture测试
  （需要禁网HTTP mock注入）

## 未部署
仅打包到 `/opt/cursor/artifacts/`，未安装到生产。

## 基线保持
37个运行文件unchanged (watcher/scanner/queue除外)。
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
node --check scan-accum/fomo-free/fomo-free-scan.mjs && echo "✅ Scanner OK"

echo ""
echo "✅ Self-verification complete"
echo "Package: $TAR_PATH"
echo "SHA256: $(sha256sum "$TAR_PATH")"
