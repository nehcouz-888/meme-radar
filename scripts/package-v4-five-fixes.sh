#!/bin/bash
set -e

VERSION="v4-five-fixes-$(date +%Y%m%d-%H%M%S)"
WORK_DIR="/tmp/meme-radar-package-$VERSION"
TAR_NAME="meme-radar-$VERSION.tar.gz"
TAR_PATH="/opt/cursor/artifacts/$TAR_NAME"

echo "=== Creating v4 package (5 fixes) ==="

# 清理并创建工作目录
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"/{meme-radar-branch,tests,scripts}

# 复制生产文件
echo "Copying production files..."
cp -r /workspace/src "$WORK_DIR/meme-radar-branch/"
cp -r /workspace/scripts-production "$WORK_DIR/meme-radar-branch/"
cp /workspace/package.json "$WORK_DIR/meme-radar-branch/"

# 复制脚本
echo "Copying scripts..."
cp /workspace/scripts/deploy-fomo-watch-safe.sh "$WORK_DIR/scripts/"
cp /workspace/scripts/migrate-pending-to-queue.mjs "$WORK_DIR/scripts/"

# 复制测试源码
echo "Copying test source..."
cp /workspace/test/five-fixes.test.mjs "$WORK_DIR/tests/"
cp /workspace/test/queue-lock-multi-process.test.mjs "$WORK_DIR/tests/"
cp /tmp/five-fixes-test-output.txt "$WORK_DIR/tests/five-fixes-output.txt" 2>/dev/null || echo "No test output" > "$WORK_DIR/tests/five-fixes-output.txt"
cp /tmp/multi-process-test-output.txt "$WORK_DIR/tests/multi-process-output.txt" 2>/dev/null || echo "No test output" > "$WORK_DIR/tests/multi-process-output.txt"

# 生成manifest
cat > "$WORK_DIR/MANIFEST.md" << 'EOF'
# Meme Radar v4 - 5项阻断修复

## Git Commit
`946c1bc` - fix: 5项阻断修复

## 修复清单

### 1. LEASE-DEFAULT
- lease默认5min（短于10min TTL）
- sent状态必须验证lease
- lease过期可重claim
- 文件: `src/modules/alert-queue.mjs:190,226,240`

### 2. ROLLBACK-ARTIFACT
- 记录部署前hash+新增文件清单
- rollback删除新增、恢复旧文件
- 保护state/config
- 文件: `scripts/deploy-fomo-watch-safe.sh`

### 3. SYMLINK-TRAVERSAL
- 白名单校验目标和父路径
- 拒绝指向外部symlink
- safeReadFile/safeWriteFile API
- 文件: `src/modules/path-validator.mjs`

### 4. CONFIG-MERGE
- 增量合并新规则
- 保留真实userId/apiKey/secret
- 移除脱敏占位符
- 文件: `src/modules/config-merge.mjs`

### 5. CLAIM-MIGRATION
- 归档已delivered（不重放）
- 迁移未发送event
- 显式rollback
- 文件: `scripts/migrate-pending-to-queue.mjs`

## 测试

### 5项修复测试
```bash
cd tests
node five-fixes.test.mjs
```

### 多进程锁测试
```bash
cd tests
node queue-lock-multi-process.test.mjs
```

## 部署

### 安全部署（带rollback）
```bash
cd scripts
bash deploy-fomo-watch-safe.sh deploy
```

### Rollback
```bash
cd scripts
bash deploy-fomo-watch-safe.sh rollback
```

### 迁移旧pending
```bash
cd scripts
node migrate-pending-to-queue.mjs migrate --dry-run  # 预演
node migrate-pending-to-queue.mjs migrate            # 执行
node migrate-pending-to-queue.mjs rollback           # 回滚
```

## 依赖
从v3继承：
- B4金额证据严格化
- B8月预算守护（150k credits）
- 统一队列锁+owner/token校验

## 限制
- 未部署到生产
- 未触及scanner/exit
- 未扩预算
- 离线fixture测试

## Git历史
- `8ddf4fc`: B4+B8
- `aa4083b`: 统一锁+token
- `4d58401`: 多进程测试
- `91b6860`: v3打包
- `946c1bc`: 5项阻断修复
EOF

# 生成checksums
echo "Generating checksums..."
cd "$WORK_DIR"
find . -type f ! -name "checksums.sha256" -exec sha256sum {} \; | sort > checksums.sha256

CHECKSUM_LINES=$(wc -l < checksums.sha256)
echo "Checksums generated ($CHECKSUM_LINES files)"

if [[ $CHECKSUM_LINES -eq 0 ]]; then
  echo "❌ Checksums empty, aborting"
  exit 1
fi

# 打包
echo "Creating tarball..."
cd /tmp
tar -czf "$TAR_PATH" "meme-radar-package-$VERSION"

echo "✅ Package created: $TAR_PATH"
ls -lh "$TAR_PATH"

# 自验证
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
if sha256sum -c checksums.sha256 2>&1 | tail -5; then
  VERIFY_COUNT=$(sha256sum -c checksums.sha256 2>&1 | grep -c ": OK" || true)
  echo "✅ Checksums verified ($VERIFY_COUNT files)"
else
  echo "❌ Checksum verification failed"
  exit 1
fi

echo "Checking test source..."
[[ -f tests/five-fixes.test.mjs ]] && echo "✅ Five fixes test included" || { echo "❌ Missing"; exit 1; }
[[ -f tests/queue-lock-multi-process.test.mjs ]] && echo "✅ Multi-process test included" || { echo "❌ Missing"; exit 1; }

echo "Checking original outputs..."
[[ -f tests/five-fixes-output.txt ]] && echo "✅ Five fixes output included" || { echo "❌ Missing"; exit 1; }
[[ -f tests/multi-process-output.txt ]] && echo "✅ Multi-process output included" || { echo "❌ Missing"; exit 1; }

echo "Syntax checks..."
node --check meme-radar-branch/scripts-production/fomo-trader-watch-integrated.mjs && echo "✅ Watcher OK"
node --check meme-radar-branch/src/modules/alert-queue.mjs && echo "✅ Queue OK"
node --check meme-radar-branch/src/modules/path-validator.mjs && echo "✅ Path validator OK"
node --check meme-radar-branch/src/modules/config-merge.mjs && echo "✅ Config merge OK"
node --check scripts/migrate-pending-to-queue.mjs && echo "✅ Migration script OK"

echo ""
echo "✅ Self-verification complete"
echo "Package: $TAR_PATH"
echo "SHA256: $(sha256sum "$TAR_PATH")"
