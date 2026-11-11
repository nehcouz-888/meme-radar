# 金狗雷达审计修复部署包 (2026-11-12)

## 包含文件

### 核心审计修复模块
- `src/modules/holder-sample.mjs` - 持仓样本完整性跟踪（0分历史持仓修正）
- `src/modules/market-cap-tiers.mjs` - 市值分层（取消<$100k硬限制）
- `src/modules/exit-monitoring.mjs` - 退出监控真实数据刷新
- `src/modules/position-analysis.mjs` - 持仓分析（成交额vs市值异常检测）

### 集成脚本
- `scripts/fomo-free-scan.mjs` - **集成完整生产扫描器** (保留所有发现/预算/风控/报告逻辑)
- `scripts/fomo-trader-watch-integrated.mjs` - Fomo交易者持仓分析集成
- `scripts/exit-downgrade-run-integrated.mjs` - 退出监控集成

### 测试
- `test/*.test.mjs` - 所有单元测试和集成测试

### 配置与文档
- `deployment/DEPLOYMENT-MANIFEST.json` - 部署映射
- `deployment/CONFIG-MERGE-GUIDE.md` - 配置合并指南
- `deployment/backup.sh` - 备份脚本
- `deployment/rollback.sh` - 回滚脚本

## 部署步骤

详见 `deployment/CONFIG-MERGE-GUIDE.md`

## SHA256 校验和

见 `deployment/checksums.txt`
