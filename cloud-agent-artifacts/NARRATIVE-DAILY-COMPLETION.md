# Narrative Daily 完成状态 (2026-11-12)

## ✅ 已完成（本轮窄任务）

### 1. TTL新鲜度筛选 (Fix a)
- **✅ 实现**: `src/narrative-daily.mjs`
- **功能**:
  - 默认7天TTL（可配置`NARRATIVE_TTL_DAYS`）
  - 从最近2000条事件中筛选TTL内的新鲜事件
  - 保存`first_seen`（首次见到时间）和`last_seen`（末见时间）
  - 按`last_seen`降序排序，优先最新事件
  - 旧事件不再按历史最佳rank继续优先
- **测试**: ✅ 11/11 PASS
  - `test/narrative-daily-ttl.test.mjs` - 单元测试
  - `test/narrative-daily-runner-e2e.test.mjs` - E2E测试
- **证据**: 
  - 11/3旧事件在11/11（固定时钟）不可出现 ✅
  - 重复事件更新`last_seen`但不篡改`first_seen` ✅

### 2. 噪声过滤 (Fix b)
- **✅ 实现**: `src/narrative-daily.mjs`
- **功能**:
  - 去除`gm`/`gn`/`hello`/`hi`/`bye`等问候词
  - 去除`Good Thursday`/`Good Monday`等星期问候
  - 去除`Happy Friday`等通用问候
  - 去除通用短语（天气、今天、明天等）
  - 未有可代币化证据不默认`meme_name`
  - 允许零候选，不填充到40
- **测试**: ✅ 11/11 PASS
- **证据**:
  - `Good Thursday`被过滤 ✅
  - `gm`/`gn`被过滤 ✅
  - 真实新词（MAGA, Pepe）保留 ✅
  - 零候选时不填充 ✅

### 3. A级标注 (Fix c)
- **✅ 实现**: `src/narrative-daily.mjs` - `formatNarrativeDigest()`
- **功能**:
  - 明确标注"⚠️ A级：仅叙事匹配，非链上安全验证"
  - 说明"仿盘不共享主币评级"
  - 显示首见/末见时间
- **测试**: ✅ PASS
- **证据**:
  - digest包含A级disclaimer ✅
  - 零候选时有明确提示 ✅

### 4. 保留真实入口逻辑 (Fix e)
- **✅ 实现**: `scripts/narrative-daily-run.mjs`
- **功能**:
  - 保留完整runner上下文
  - 从本地配置文件读取设置
  - 写入JSON和digest输出
  - 秘密配置保持从本地载入
  - 只修改必要部分（添加TTL参数传递）
- **测试**: ✅ E2E PASS

---

## ⚠️ 本轮未涉及（按用户要求）

### organicScore单位 (Fix d)
- **状态**: 不在本轮范围（需要修改其他模块的输出）
- **已完成部分**: fomo-free-scan.mjs已在上一轮修正

### chain+CA固定比较
- **状态**: 不在本轮范围（需要跨文件schema变更）

### 退出监控/Fomo/X监控
- **状态**: 按用户要求，本轮只处理narrative，其他继续诚实列待做

---

## 📊 测试结果

### 本轮新增测试
```
test/narrative-daily-ttl.test.mjs:         11/11 PASS ✅
test/narrative-daily-runner-e2e.test.mjs:   2/2  PASS ✅
```

**新增测试覆盖**:
1. ✅ gm/gn/Good Thursday等噪声过滤
2. ✅ 真实可代币化名词保留
3. ✅ TTL 7天筛选
4. ✅ first_seen/last_seen追踪
5. ✅ 按last_seen排序（不按历史rank）
6. ✅ 允许零候选
7. ✅ A级disclaimer显示
8. ✅ 11/3旧事件在11/11过滤
9. ✅ 重复事件时间更新但不篡改首见
10. ✅ E2E完整流程
11. ✅ E2E零候选处理

### 全量测试
```
原有测试: 211 tests, 207 pass, 4 fail (预存在)
新增测试: +13 tests, +13 pass
总计:     224 tests, 220 pass, 4 fail
```

**4个预存在失败**（与本次修改无关）:
1. `detectChainCompetition: single chain with high-tier activity`
2. `detectChainCompetition: cross-chain competition`
3. `production GMGN worker ignores project/global dotenv...`
4. `matchesTriggerKeywords: deduplicates keywords`

---

## 📦 部署包更新

### 新部署包
- **路径**: `/workspace/cloud-agent-artifacts/meme-radar-audit-fix-narrative-20261111-165904.tar.gz`
- **大小**: 87KB
- **SHA256**: `0c6fc30a1d20c4437ea0a2b3c23ca5c828408aef7f3d993acaee534f4ac08b6d`

### 包含文件（本轮新增/修改）
```
src/narrative-daily.mjs                    ✅ 核心逻辑（TTL+噪声+A级）
scripts/narrative-daily-run.mjs            ✅ 真实runner入口
test/narrative-daily-ttl.test.mjs          ✅ 单元测试（11个）
test/narrative-daily-runner-e2e.test.mjs   ✅ E2E测试（2个）
deployment/checksums.txt                    ✅ 更新SHA256
```

---

## 🧪 离线fixture测试证据

### Fixture设计（固定时钟：2026-11-11 12:00 UTC）

**输入事件**:
1. `OLDCOIN` (11/3, rank=1) - 超过7天TTL ❌
2. `Good Thursday` (11/11, rank=2) - 噪声 ❌
3. `gm` (11/11, rank=3) - 噪声 ❌
4. `MAGA` (11/10, rank=4) - 真实新词 ✅
5. `Pepe` (11/11, rank=5) - 真实新词 ✅
6. `MAGA` (11/11, rank=2, 重复) - 更新last_seen ✅

**预期输出**:
- 候选数: 2
- 候选1: `MAGA` (abbrev, last_seen=11/11 09:00, first_seen=11/10 12:00)
- 候选2: `Pepe` (meme_name, last_seen=11/11 08:00, first_seen=11/11 08:00)
- 排序: MAGA在前（last_seen更新）
- 过滤: OLDCOIN、Good Thursday、gm全部被过滤

**实际结果**: ✅ 完全符合预期

### 零候选测试

**输入**: 只有噪声（Good Thursday, gm, hello）
**预期输出**: 0候选
**实际结果**: ✅ 0候选，无填充

---

## 📝 关键修改点

### src/narrative-daily.mjs

#### 修改1: 配置添加TTL
```javascript
// Line 21
ttlDays: Number(E('NARRATIVE_TTL_DAYS', 7)),
```

#### 修改2: 扩展噪声词库和pattern
```javascript
// Line 27-41
const STOP = new Set([
  // ... 原有词 ...
  'gm', 'gn', 'hello', 'hi', 'hey', 'bye', 'goodbye',
  '早安', '晚安', '你好', '再见', '周一', ...
]);

const GREETING_PATTERNS = [
  /^good\s+(morning|night|...|thursday|...)$/i,
  /^happy\s+(monday|...|sunday)$/i,
  /^(goodnight|goodmorning)$/i
];
```

#### 修改3: classifyTokenizable不默认meme_name
```javascript
// Line 73-95
let kind = null;  // 不默认
if (/^[A-Z]{2,6}$/.test(compact)) kind = 'abbrev';
else if (/(公司|品牌|...)/.test(name)) kind = 'brand';
else if (/已知人物|meme/.test(name)) kind = 'meme_name';
// 无evidence则拒绝
if (!kind) return { ok: false, reason: 'no_tokenizable_evidence' };
```

#### 修改4: filterTokenizableEvents添加TTL逻辑
```javascript
// Line 104-181
export function filterTokenizableEvents(events, cfg, { now = Date.now() } = {}) {
  // TTL筛选
  const ttlMs = cfg.ttlDays * 24 * 3600 * 1000;
  const cutoff = now - ttlMs;
  
  for (const e of events || []) {
    const eventAt = e.at ? new Date(e.at).getTime() : now;
    if (eventAt < cutoff) continue;  // ✅ 跳过过期事件
    
    // ✅ 追踪first_seen和last_seen
    if (!prev) {
      row.first_seen = row.at;
      row.last_seen = row.at;
    } else {
      // 更新last_seen，保留first_seen
      if (currAt > prevAt) prev.last_seen = row.at;
    }
  }
  
  // ✅ 排序：按last_seen降序（最新在前）
  list.sort((a, b) => {
    const aTime = new Date(a.last_seen || a.at).getTime();
    const bTime = new Date(b.last_seen || b.at).getTime();
    if (bTime !== aTime) return bTime - aTime;
    return (a.rank ?? 999) - (b.rank ?? 999);
  });
  
  return list.slice(0, cfg.maxCandidates);  // ✅ 不填充
}
```

#### 修改5: formatNarrativeDigest添加A级disclaimer
```javascript
// Line 203-222
export function formatNarrativeDigest(candidates) {
  const lines = [
    '叙事日筛 (可代币化候选，微博+X 热)',
    '⚠️ A级：仅叙事匹配，非链上安全验证。仿盘不共享主币评级。',
    `共 ${candidates.length} 条`,
    ''
  ];
  
  if (candidates.length === 0) {
    lines.push('今日无符合条件的新鲜叙事候选。');
  } else {
    candidates.forEach((c, i) => {
      const timeInfo = c.first_seen && c.last_seen 
        ? ` 首见:${c.first_seen.split('T')[0]} 末见:${c.last_seen.split('T')[0]}`
        : '';
      lines.push(`${i + 1}. ${c.name} ...${timeInfo}`);
    });
  }
  return lines.join('\n');
}
```

### scripts/narrative-daily-run.mjs

#### 修改1: 传入当前时间用于TTL
```javascript
// Line 34
const candidates = filterTokenizableEvents(events, nd, { now: Date.now() });
```

#### 修改2: 输出TTL配置信息
```javascript
// Line 40-47
fs.writeFileSync(outFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  ttlDays: nd.ttlDays,  // ✅ 添加
  eventsRead: events.length,
  candidatesCount: candidates.length,
  candidates
}, null, 2));
```

---

## 🚀 生产部署建议

### 立即可部署
1. ✅ `src/narrative-daily.mjs` - 核心逻辑完整实现
2. ✅ `scripts/narrative-daily-run.mjs` - 真实runner完整保留

### 配置迁移
- 保留现有配置文件路径
- 新增可选环境变量:
  - `NARRATIVE_TTL_DAYS=7` (默认)
  - `NARRATIVE_MAX_CANDIDATES=100` (不填充)

### 无外部依赖
- ✅ 无需API密钥
- ✅ 无需外部认证
- ✅ 纯本地文件读写
- ✅ 已用offline fixture完整测试

---

## 📌 总结

### 本轮完成
- ✅ **TTL新鲜度筛选** - 7天TTL，first/last_seen追踪，按新鲜度排序
- ✅ **噪声过滤** - gm/gn/Good weekday等问候词，允许零候选
- ✅ **A级标注** - 明确"仅叙事匹配，非链上安全"
- ✅ **真实入口保留** - 完整runner逻辑，本地配置读取
- ✅ **离线fixture测试** - 固定时钟11/11，验证所有要求
- ✅ **13个新测试** - 全部通过，无破坏原有测试

### 未涉及（按用户要求）
- organicScore单位（不在本轮）
- chain+CA固定比较（不在本轮）
- 其他模块（退出/Fomo/X）继续待做

### 部署包
- **路径**: `/workspace/cloud-agent-artifacts/meme-radar-audit-fix-narrative-20261111-165904.tar.gz`
- **SHA256**: `0c6fc30a1d20c4437ea0a2b3c23ca5c828408aef7f3d993acaee534f4ac08b6d`
- **大小**: 87KB
- **状态**: ✅ 生产ready
