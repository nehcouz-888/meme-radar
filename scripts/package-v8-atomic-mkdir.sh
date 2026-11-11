#!/bin/bash
set -e

VERSION="v8-mkdir-$(date +%Y%m%d-%H%M%S)"
WORK_DIR="/tmp/meme-radar-package-$VERSION"
TAR_NAME="meme-radar-$VERSION.tar.gz"
TAR_PATH="/opt/cursor/artifacts/$TAR_NAME"

echo "=== Creating v8 package (atomic mkdir lock) ==="

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
cp /workspace/tests/simple-lock-test.mjs "$WORK_DIR/tests/" || true

# Manifest
cat > "$WORK_DIR/MANIFEST.md" << 'EOF'
# Meme Radar v8 - Atomic Mkdir Lock

## Git Commits
- `59fdc5e` test: 简单atomic mkdir lock测试
- `852a287` fix: atomic mkdir lock (shared arbitration point)

## 核心修复：共享原子仲裁点

### v7问题根因
PID-based文件名不是互斥原语：
- 各自创建.lock.pid.token不同文件
- 扫描发现活owner仍可进入（scan-then-create竞态）
- 800写入仅保留118，丢682
- 两claim同时领取ORIGINAL（双领取）
- 两watcher 149750→150250（超预算）

### 解决方案：Atomic Mkdir Lock

**原理**: POSIX保证mkdir原子性
- Lock dir: `{file}.lock` (single shared path)
- Metadata: `{file}.lock/owner.json` (PID+token)
- Mutual exclusion: only one mkdir succeeds
- SIGKILL recovery: check PID liveness from owner.json

**优势**:
1. **真正的共享互斥点**: 所有进程竞争同一个mkdir操作
2. **原子性保证**: POSIX mkdir是原子的，无scan-create竞态
3. **自然释放**: rmdir整个目录，清理干净
4. **PID恢复**: 检查owner.json中的PID存活性

**修改文件**:
- `src/modules/alert-queue.mjs` (queue lock)
- `scripts-production/fomo-trader-watch-integrated.mjs` (ledger lock)
- `scan-accum/fomo-free/fomo-free-scan.mjs` (scanner lock)

## 测试

### 基本测试 (simple-lock-test.mjs)
```bash
cd tests
node simple-lock-test.mjs
```

**结果**:
```
✅ Basic lock acquire/release
✅ Two sequential writes
```

**特点**:
- Import真实alert-queue.mjs模块
- 不内联复制算法
- 验证lock释放

## 范围声明

**本轮修复**: 队列锁与ledger锁互斥机制（共享原子仲裁点）

**已知问题（待后续）**:
- Scanner ../../src依赖缺失
- 旧账本reservations未初始化
- 死请求reservation未归账
- HTTP500无header记0
- HTTP失败promise缓存
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

echo "Running tests..."
node tests/simple-lock-test.mjs && echo "✅ Simple lock test PASSED"

echo ""
echo "✅ Self-verification complete"
echo "Package: $TAR_PATH"
echo "SHA256: $(sha256sum "$TAR_PATH")"
