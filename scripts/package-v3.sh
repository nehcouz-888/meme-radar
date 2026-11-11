#!/bin/bash
set -e

VERSION="v3-lock-evidence-$(date +%Y%m%d-%H%M%S)"
WORK_DIR="/tmp/meme-radar-package-$VERSION"
TAR_NAME="meme-radar-$VERSION.tar.gz"
TAR_PATH="/opt/cursor/artifacts/$TAR_NAME"

echo "===  Creating package $VERSION ==="

# 清理并创建工作目录
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"/{meme-radar-branch,tests}

# 复制生产文件
echo "Copying production files..."
cp -r /workspace/src "$WORK_DIR/meme-radar-branch/"
cp -r /workspace/scripts-production "$WORK_DIR/meme-radar-branch/"
cp /workspace/package.json "$WORK_DIR/meme-radar-branch/"

# 复制测试源码
echo "Copying test source..."
cp /workspace/test/queue-lock-multi-process.test.mjs "$WORK_DIR/tests/"
cp /tmp/multi-process-test-output.txt "$WORK_DIR/tests/test-output-original.txt"

# 生成README
cat > "$WORK_DIR/README.md" << 'EOF'
# Meme Radar v3 - Lock + Evidence + Budget

## 变更
- B4金额证据严格化（tradeUsd=verified, 拒绝>100%）
- B8月预算守护（150k credits，共享账本）
- 统一队列锁+owner/token校验（addPendingAlert/cleanupQueue）
- 进程存活检测（kill(pid,0)安全恢复dead lock）

## 测试
```bash
cd tests
node queue-lock-multi-process.test.mjs
```

## 部署
```bash
cd meme-radar-branch
npm install
# 手动部署到 /workspace/meme-radar-run/meme-radar-branch/
```

## Git版本
- 8ddf4fc: B4+B8金额证据+预算
- aa4083b: 统一锁+owner/token
- 4d58401: 多进程测试
EOF

# 生成checksums（排除自身）
echo "Generating checksums..."
cd "$WORK_DIR"
find . -type f ! -name "checksums.sha256" -exec sha256sum {} \; | sort > checksums.sha256

echo "Checksums generated ($(wc -l < checksums.sha256) files)"

# 打包
echo "Creating tarball..."
cd /tmp
tar -czf "$TAR_PATH" "meme-radar-package-$VERSION"

echo "✅ Package created: $TAR_PATH"
ls -lh "$TAR_PATH"

# 自验证：解压到临时目录
echo ""
echo "=== Self-verification ==="
VERIFY_DIR="/tmp/verify-$VERSION"
rm -rf "$VERIFY_DIR"
mkdir -p "$VERIFY_DIR"
cd "$VERIFY_DIR"

echo "Extracting tarball..."
tar -xzf "$TAR_PATH"

echo "Verifying checksums..."
cd "meme-radar-package-$VERSION"
if sha256sum -c checksums.sha256 2>&1 | tee checksum-verify.log; then
  echo "✅ Checksums verified"
else
  echo "❌ Checksum verification failed"
  exit 1
fi

echo "Checking test source..."
if [[ -f tests/queue-lock-multi-process.test.mjs ]]; then
  echo "✅ Test source included"
else
  echo "❌ Test source missing"
  exit 1
fi

echo "Checking original test output..."
if [[ -f tests/test-output-original.txt ]]; then
  echo "✅ Original test output included"
else
  echo "❌ Original test output missing"
  exit 1
fi

echo "Syntax check imports..."
node --check meme-radar-branch/scripts-production/fomo-trader-watch-integrated.mjs && echo "✅ Watcher syntax OK"
node --check meme-radar-branch/src/modules/alert-queue.mjs && echo "✅ Queue syntax OK"

echo ""
echo "✅ Self-verification complete"
echo "Package location: $TAR_PATH"
echo "Checksum: $(sha256sum "$TAR_PATH")"
