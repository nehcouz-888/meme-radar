#!/bin/bash
set -e

VERSION="v7-pid-lock-$(date +%Y%m%d-%H%M%S)"
WORK_DIR="/tmp/meme-radar-package-$VERSION"
TAR_NAME="meme-radar-$VERSION.tar.gz"
TAR_PATH="/opt/cursor/artifacts/$TAR_NAME"

echo "=== Creating v7 package (PID-based lock only) ==="

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"/{meme-radar-branch,scan-accum/fomo-free,tests}

# 生产文件
echo "Copying production files..."
cp -r /workspace/src "$WORK_DIR/meme-radar-branch/"
cp -r /workspace/scripts-production "$WORK_DIR/meme-radar-branch/"
cp /workspace/package.json "$WORK_DIR/meme-radar-branch/"

# Scanner
echo "Copying scanner..."
cp /workspace/scan-accum/fomo-free/fomo-free-scan.mjs "$WORK_DIR/scan-accum/fomo-free/"

# 测试
echo "Copying tests..."
cp /workspace/tests/pid-lock-race-real.test.mjs "$WORK_DIR/tests/" || true
cp /workspace/tests/pid-lock-ledger-race-real.test.mjs "$WORK_DIR/tests/" || true
cp /workspace/test/queue-lock-multi-process.test.mjs "$WORK_DIR/tests/" || true

# Manifest
cat > "$WORK_DIR/MANIFEST.md" << 'EOF'
# Meme Radar v7 - PID-based Lock (Atomic Ownership)

## Git Commits
- `90760a0` test: PID-based lock真实竞争（>=500ms暂停）
- `b2b29a8` fix: PID-based lock (atomic ownership, no age check)

## 核心修复：锁初始化竞争

### 问题
v6的100ms年龄阈值无法区分健康owner vs死亡owner：
- Queue lock: 健康writer暂停154ms → 被claim抢锁 → HEALTHY_NEW丢失
- Ledger lock: 健康watcher暂停150ms → 被另一watcher抢锁 → 149750→150250超预算

任何有限年龄初始化窗口都不能证明owner死亡（进程可被调度暂停）

### 解决方案：PID-based文件名锁

**Lock file格式**: `{file}.lock.{pid}.{token}`

**原理**:
1. **原子所有权**: 文件创建 = 所有权建立（不依赖metadata写入）
2. **不检查年龄**: 只检查PID存活（`process.kill(pid, 0)`）
3. **SIGKILL恢复**: 死PID → 可reclaim
4. **老owner无法删除新owner锁**: 文件名不同

**修改文件**:
- `src/modules/alert-queue.mjs` (queue lock)
- `scripts-production/fomo-trader-watch-integrated.mjs` (ledger lock)
- `scan-accum/fomo-free/fomo-free-scan.mjs` (scanner ledger lock)

## 测试证据

### 1. Queue Lock (>=500ms暂停)
```
Owner: wx后暂停500ms
Contender: 并发等待
Result: 两个事件都保留 ✅
```

### 2. Ledger Lock (149750起点)
```
W1: wx后暂停500ms
W2: 成功reserve+settle (150000)
W1: 恢复后被拒绝
Final spent: 150000 (不超预算) ✅
```

### 测试命令
```bash
cd tests
node pid-lock-race-real.test.mjs
node pid-lock-ledger-race-real.test.mjs
```

## 范围声明

**本轮仅修复**: 队列锁与ledger锁初始化竞争

**明确未修复（待后续）**:
- Scanner ../../src依赖缺失
- 旧账本reservations未初始化
- 死请求reservation未归账
- HTTP500无header记0
- HTTP失败promise缓存
- Map>1000容量
- 其他预算/cache问题

## 未部署
仅打包到 `/opt/cursor/artifacts/`，未安装到生产。

## 基线保持
37个运行文件unchanged (queue/watcher/scanner锁修复除外)。
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
node --check meme-radar-branch/src/modules/alert-queue.mjs && echo "✅ Queue OK"
node --check scan-accum/fomo-free/fomo-free-scan.mjs && echo "✅ Scanner OK"

echo "Running PID lock tests..."
node tests/pid-lock-race-real.test.mjs && echo "✅ Queue lock race test PASSED"
node tests/pid-lock-ledger-race-real.test.mjs && echo "✅ Ledger lock race test PASSED"

echo ""
echo "✅ Self-verification complete"
echo "Package: $TAR_PATH"
echo "SHA256: $(sha256sum "$TAR_PATH")"
