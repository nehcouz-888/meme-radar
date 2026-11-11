# 真实实现状态（2026-11-12）

## ⚠️ 警告：SHA623dc386包已BLOCKED，禁止部署

## ✅ 本轮已修正并验证的项目：

### 1. 完整生产扫描（418行真实扫描器）
**文件**: `scripts/fomo-free-scan.mjs`  
**状态**: ✅ 完成
- 使用真实40KB生产扫描器（不是Mock）
- 完整discover/enrichMarket/score逻辑
- 输出fullchain-scan-results.json
- 添加exit watchlist登记（top 20候选）

**证据**:
```bash
wc -l scripts/fomo-free-scan.mjs  # 418行
grep "await discover" scripts/fomo-free-scan.mjs  # 真实discover调用
grep "registerFromScanResults" scripts/fomo-free-scan.mjs  # exit登记
```

### 2. 真实退出免费行情刷新
**文件**: `scripts/exit-runner.mjs`  
**状态**: ✅ 完成（零Fomo密钥可运行）
- 真实GeckoTerminal API调用（虽然GT不提供holder地址，会fallback）
- 真实Fomo API调用（完整/v2/tokens/holders逻辑）
- recordCost到共享账本
- 预算耗尽时免费行情继续，持仓unknown

**证据**:
```bash
grep "api.geckoterminal.com" scripts/exit-runner.mjs  # 真实GT API
grep "api.fomoapi.io" scripts/exit-runner.mjs  # 真实Fomo API
grep "recordCost" scripts/exit-runner.mjs  # 账本记录
```

### 3. EXIT语义修正
**文件**: `src/modules/exit-runner-production.mjs`  
**状态**: ✅ 完成
- HOLDER_COUNT_DECLINE（持仓人数变动，不是NET_SELLING_PRESSURE）
- FULL_EXIT需要balance证据（不只是人数）
- NET_SELLING_PRESSURE需真实成交量（当前未实现，诚实标记TODO）

**证据**:
```bash
grep "HOLDER_COUNT_DECLINE" src/modules/exit-runner-production.mjs
grep "balance证据" src/modules/exit-runner-production.mjs  # 中文注释
grep "TODO.*NET_SELLING_PRESSURE" src/modules/exit-runner-production.mjs  # 未实现标记
```

### 4. 月预算显式配置
**文件**: `scripts/exit-runner.mjs`, `src/modules/exit-runner-production.mjs`  
**状态**: ✅ 完成
- EXIT_BUDGET_SHARE=0.3（默认30%给exit monitoring）
- 不用/2掩盖扩大调用
- 与扫描共用同一账本
- FREE_COVERAGE_RATIO显式可配

**证据**:
```bash
grep "EXIT_BUDGET_SHARE" scripts/exit-runner.mjs
grep "exitBudgetShare" src/modules/exit-runner-production.mjs
grep "150000 credits" scripts/exit-runner.mjs  # 明确是credits不是美元
```

### 5. claim/ack CLI脚本
**文件**: `scripts/claim-pending-alerts.mjs`, `scripts/ack-delivered-alerts.mjs`  
**状态**: ✅ 完成
- 真实queue读写
- lease机制
- 输出JSON格式

**证据**:
```bash
ls -lh scripts/{claim,ack}*.mjs
node scripts/claim-pending-alerts.mjs  # 可执行（需queue文件）
```

### 6. X keywords去重
**文件**: `src/x-monitor.mjs`  
**状态**: ✅ 完成
- 使用Set自动去重
- soft-mention测试9/9通过

**证据**:
```bash
grep "keywordSet = new Set" src/x-monitor.mjs
node test/soft-mention.test.mjs  # 9/9 pass
```

### 7. 测试状态
**状态**: ✅ 241/242通过（99.6%）
- exit-runner E2E: 8/8通过
- soft-mention: 9/9通过
- 剩余1个失败：GMGN onboarding（GMGN_DEPENDENCY_MISSING环境依赖）

**证据**:
```bash
npm test  # 241/242 pass
npm test -- test/exit-runner-e2e.test.mjs  # 8/8 pass
npm test -- test/soft-mention.test.mjs  # 9/9 pass
```

---

## ❌ 承认未完成（不再伪称）：

### 1. fomo-trader-watch.mjs路径问题
**问题**: 
- 绝对import `/workspace/src/modules/position-analysis.mjs`不存在
- `ROOT=__dirname`会把config/state/queue放错位置
- 真实路径应该是`/workspace/meme-radar-run/fomo-trader-watch`

**需要**: 重写静态import为动态import，适配生产路径

**当前**: 只有stub（`scripts/fomo-trader-watch-production.mjs`）

### 2. watchlist路径迁移
**问题**:
- 旧路径：scan-accum/narrative-early/state/watchlist.json
- 新路径：branch/state/exit-watchlist.json
- 消费者读scan-*.json但原输出fullchain-scan-results.json

**需要**: 迁移脚本 + 消费者适配

**当前**: 不存在

### 3. narrative runners未入包
**问题**:
- narrative-daily-runner.mjs不存在
- report/collect逻辑不存在
- TTL/default meme_name未修复

**需要**: 创建真实runner + 入包

**当前**: 不存在

### 4. 36静态import未验证
**问题**: 隔离部署时import路径可能失败

**需要**: 完整路径验证 + 隔离E2E测试

**当前**: 未验证

### 5. INSTALL/rollback不安全
**问题**:
- pkill广泛（杀错进程）
- crontab覆盖（丢失其他任务）
- rollback无白名单（tar解到/危险）

**需要**: 
- 精确进程匹配
- crontab增量更新
- rollback白名单 + manifest验证

**当前**: 不安全

### 6. X软提及未实现
**问题**:
- provider路由未实现
- 软提及事件路径未实现
- 健康检测逻辑未实现

**需要**: 完整X软提及真实入口

**当前**: 不存在

### 7. 隔离部署E2E测试
**问题**: 包未在隔离目录运行验证

**需要**: 真实布局 + fixture + 依赖检查

**当前**: 未运行

### 8. 包SHA623dc386问题总结
1. scan-accum/fomo-free/fomo-free-scan.mjs仅4969字节（原40175）- ✅已修正为418行真实版本
2. 路径解析错误 - ⚠️部分修正（exit-runner已修，watcher未修）
3. Mock免费源 - ✅已修正为真实API
4. watcher绝对import - ❌未修正
5. 无claim/ack CLI - ✅已创建
6. 旧watchlist路径 - ❌未迁移
7. narrative未入包 - ❌未完成
8. 36 import缺失 - ❌未验证
9. INSTALL不安全 - ❌未修正

---

## 结论

**本轮完成**: 完整生产扫描 + 真实退出免费行情刷新（用户要求的核心两项）

**测试状态**: 241/242通过（99.6%）

**不再自称完成**: 仍有7个大项未完成，不建议部署

**下一步建议**: 
1. 修正fomo-trader-watch路径
2. 创建watchlist迁移脚本
3. 添加narrative runners
4. 隔离E2E测试
5. 修正INSTALL/rollback安全问题

**Git提交**:
```
f7b9ba1 fix: 修正真实实现问题（部分）
29e3472 fix: X keywords去重逻辑（使用Set）
```
