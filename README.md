# 金狗雷达（Meme Radar Jindou）

**Fork of [nhovongoc0-max/meme-radar](https://github.com/nhovongoc0-max/meme-radar) v0.1.6**

作者：**DeFi狙击手** · X：[@bi_9527zx](https://x.com/bi_9527zx)

本地运行的多链 Meme 候选雷达。使用 GMGN 做发现与标签，GoPlus 做已支持链的合约风险复核，DexScreener 做市值、流动性与官网交叉校验。

这是从上游开源版定制改造的**金狗萌芽研究版**，专注于极早期 meme 代币发现，增加了：
- **金狗萌芽评分系统**：0-100 分embryonic评分，hot/watch/ignore 三档分类
- **X/Twitter 监控**：官方账号、KOL 推特实时监控，自动提取合约地址
- **Webhook 通知**：可选的 HTTP webhook 推送，30 分钟去重
- **Solana 优先**：默认扫描 Solana 链，市值范围调整为 $10k-$200k 早期带

## 改造说明

### 与上游的关系

- **上游来源**：https://github.com/nhovongoc0-max/meme-radar v0.1.6
- **许可证**：AGPL-3.0-only（保持不变，完整保留上游 LICENSE 文件和版权声明）
- **改造性质**：私有 fork 用于金狗萌芽研究，**不向上游提交 PR**
- **功能边界**：保持只读/研究定位，**永不添加**钱包私钥、交易签名、swap 或自动下单功能

### 主要改造内容

#### 1. 金狗萌芽评分层（Embryonic Scoring）

在原有安全检查（貔貅/rug 仍硬拒绝）**之后**增加早期研究评分：

- **embryonicScore** (0-100)：综合市值带、流动性、年龄、聪明钱、持有人、成交量、社交链接
- **embryonicTier**：`ignore` | `watch` | `hot`（可配置阈值，默认 hot≥70, watch≥50）
- **embryonicSignals**：中英文原因列表，标记得分来源

评分因子（可用字段；未知显式标记，不伪造通过）：
- 市值带：偏好 $30k–$150k 最佳区间（可配 $10k–$200k）
- 流动性：足够交易但不荒谬（vs mcap 比例合理）
- 持有人集中度：top10 不极端；标记 bundler/sniper/dev 重仓 tag
- 年龄/新鲜度：偏好分钟–小时级（可检测时）
- 聪明钱/KOL 参与：有则加分（不强制）
- 社交链接（X/website）：轻度加分，**不自动背书**
- 1分钟发现成交额：轻度加分

**不改变原有 reject/review/watch 安全语义**；embryonic 是额外研究层。

#### 2. Solana 优先配置

- 默认扫描链：`sol`（Solana）
- 即时发现市值窗口默认调整为早期萌芽带
- 配置键在 README 记录

#### 3. X/Twitter 监控（核心优先功能）

##### 监控账号（Watchlist）

配置文件：`config/x-watchlist.json`

**硬性筛选规则**：KOL / community / meme_whale 账号必须 **≥10,000 粉丝**（不少于 1 万人关注）。Official/founder 账号（Binance、CZ、He Yi 等官方身份）不受此限制。

**链亲和性标签（Chain Affinity）**：
- 每个账号标记其主要链对齐：`sol` | `bsc` | `base` | `eth` | `multi` | `null`
- 用于跨链竞争检测和早期信号放大
- 示例：
  - Solana 官方和创始人 → `sol`
  - Binance/CZ/何一 → `bsc` (BNB Chain 创始人/倾向)
  - Base 官方和 Jesse Pollak → `base`
  - Vitalik → `eth`
  - 多链账号如 Binance Wallet → `multi`

**官方账号（official tier）**
- @binance (chainAffinity: bsc), @BinanceWallet (multi), @BinanceResearch (multi)

**创始人（founder tier）**
- @cz_binance (CZ - Changpeng Zhao, chainAffinity: bsc)
- @heyibinance (He Yi / 何一, chainAffinity: bsc)

**链生态负责人（chain_lead tier）**
- @solana, @aeyakovenko, @rajgokal (Solana, chainAffinity: sol)
- @bnbchain (BNB Chain, chainAffinity: bsc)
- @base, @jessepollak (Base/Coinbase L2, chainAffinity: base)
- @VitalikButerin (Ethereum, chainAffinity: eth)

**Meme 币大佬 / Meme Whales（meme_whale tier, ≥10k followers）**
- @Ansem (500k+ followers, major meme whale, chainAffinity: sol)
- @thecryptodogs (450k+, high-profile trader, chainAffinity: multi)
- @hsaka (200k+, veteran trader, early meme calls, chainAffinity: eth)
- @RunnerXBT (150k+, active crypto trader, chainAffinity: multi)
- @ThinkingUSD (120k+, Sol ecosystem whale, chainAffinity: sol)
- @CryptoCred (380k+, technical trader, chainAffinity: multi)

**活跃社区声音 / Community Amplifiers（community tier, ≥10k followers）**
- @MilkRoadDaily (90k+, crypto news + meme narratives, chainAffinity: multi)
- @degenmfer (45k+, Solana meme community organizer, chainAffinity: sol)
- @SolJakey (35k+, Solana meme calls, chainAffinity: sol)
- @Messiahbol (40k+, SOL meme narratives, CA posts, chainAffinity: sol)
- @thedefiedge (55k+, DeFi and memecoin educator, chainAffinity: multi)
- @Washigorira (28k+, Solana meme community voice, chainAffinity: sol)

**KOL Alpha 呼单者（kol_alpha tier, ≥10k followers）**
- 50+ 公开账号种子列表（CN/EN 加密 Twitter，近期 meme 呼单记录）
- 包含：@0xRacer (65k+, chainAffinity: sol), @blknoiz06 (48k+, sol), @Murad_MHH (280k+, sol), @DegenSpartan (175k+, eth), @cobie (520k+, eth), @0xMert_ (130k+, multi), @AltcoinGordon (220k+, multi), @CryptoKaleo (640k+, multi), @lookonchain (580k+, multi), @Pentosh1 (720k+, eth) 等
- 每个账号注明分类、display name、follower count、notes、chainAffinity

**跨链竞争检测（Cross-Chain Competition Detection）**：

系统检测当不同链的官方/创始人/chain_lead 账号在短时间窗口（默认6小时，可配置）内同时发布 meme 相关内容时的**链间竞争信号**：

- **触发条件**：
  - 同一链的多个高层级账号活跃（official/founder/chain_lead）
  - **或** 不同链在同一时间窗口推送竞争性叙事

- **竞争强度（Intensity）**：0-100 分，基于账号层级权重和活跃度
  - Official/Founder 权重最高 (10)
  - Chain Lead 次之 (7)
  - Meme Whale 中等 (4)
  - Community 较低 (3)
  - KOL Alpha 最低 (2)

- **信号应用**：
  - 当代币所属链的竞争强度 ≥40 且有高层级账号参与时，胚芽评分获得**加分**（最高 +20）
  - 信号示例（中文）：「所属链竞争升温（SOL） / 链官方或嫡系 KOL 同向」
  - 跨链竞争时信号：「跨链竞争：SOL vs BASE vs BSC」

- **Webhook 通知**：
  - 竞争强度 ≥60（默认，可通过 `X_COMPETITION_THRESHOLD` 配置）时，可选发送 `chain_competition_signal` 事件
  - Payload 包含：intensity, chains, signals, signalsCN, recentHitCount, windowHours, detectedAt

- **研究性质**：
  - 基于启发式算法（v1），非交易信号，仅用于早期叙事趋势研究
  - 不构成自动下单依据
  - 文档明确说明这是研究启发式，非证明

**账号数量**：当前种子列表 60+ 账号，覆盖：
- Official/founder: 5 账号（官方身份，不受粉丝数限制）
- Chain leads: 7 账号（生态负责人）
- Meme whales: 6 账号（10万+ 粉丝 meme 大佬）
- Community: 6 账号（2.8万-9万 粉丝社区组织者）
- KOL alpha: 36+ 账号（1.8万-72万 粉丝呼单者）

所有 KOL / community / meme_whale 账号均满足 ≥10k 粉丝要求。质量优于数量，精选高信号账号。

##### X API 设置（多种方式）

**方式1：官方 Twitter API（最贵，实时性最好）**
```bash
export X_BEARER_TOKEN=your_twitter_api_v2_bearer_token
export X_PROVIDER=official  # 可选，有 bearer token 时自动选择
export X_POLL_INTERVAL_MS=120000  # 默认2分钟（官方API）
```

**方式2：SocialData 第三方（便宜，推荐）**
```bash
export SOCIALDATA_API_KEY=your_socialdata_api_key
export X_PROVIDER=socialdata  # 可选，有 API key 时自动选择
export X_POLL_INTERVAL_MS=600000  # 默认10分钟（第三方API）
```

**方式3：Sorsa 第三方（待实现）**
```bash
export SORSA_API_KEY=your_sorsa_api_key
export X_PROVIDER=sorsa
```

**方式4：演示模式（无需配置）**

不设置任何密钥时，自动使用演示模式生成假数据用于测试。

##### 便宜第三方 vs 官方 API

**官方 Twitter API v2**
- **优势**：实时性最佳，直接从 Twitter 获取，数据完整度高
- **劣势**：**非常贵** — Free tier 极其有限（每月500条推文），Basic $100/月（10k条），Pro $5000/月
- **适用场景**：资金充足、需要实时监控、商业级产品
- **轮询频率**：可每 1-2 分钟

**SocialData.tools 第三方**
- **优势**：**价格友好** — 约 $29-79/月套餐，支持合理频率轮询
- **劣势**：非官方，有 ToS 风险，可能有延迟或断连，数据完整性次于官方
- **适用场景**：个人研究、成本敏感、可接受轻度延迟
- **轮询频率**：建议 10-15 分钟（避免触发限流）
- **月度成本估算**（~20个优先账号 @ 10分钟轮询）：
  - 每账号每小时6次 × 24小时 = 144次/天
  - 20账号 = 2,880次/天
  - 月度 ≈ 86,400次调用
  - SocialData 套餐通常包含 100k-500k 次调用/月，**足够覆盖**

**ToS 与可靠性风险**
- ⚠️ 第三方服务**非官方授权**，可能违反 Twitter ToS
- 第三方可能随时**下线、调整定价、限流**，无法保证长期稳定
- 生产环境或重要项目建议**官方API** + 备用第三方做冗余
- 本项目为**研究工具**，风险自担

**自动选择逻辑**
1. 若设置 `SOCIALDATA_API_KEY`，优先使用 SocialData（便宜）
2. 若仅设置 `X_BEARER_TOKEN`，使用官方API
3. 若设置 `X_PROVIDER=official|socialdata|sorsa|stub`，强制指定
4. 都不设置时，演示模式

**如何获取密钥**

Twitter API Bearer Token (官方)：
1. 访问 https://developer.twitter.com/en/portal/dashboard
2. 创建或选择一个 App
3. 在 "Keys and tokens" 中生成 Bearer Token
4. 将 token 设置为环境变量或在启动命令中传入

SocialData API Key (第三方)：
1. 访问 https://socialdata.tools 或类似服务
2. 注册账号并订阅套餐
3. 在 Dashboard 获取 API Key

**配置示例**：参考项目根目录的 `.env.example` 文件。

**演示/Dry-run 模式（无 token）**

未设置任何 API 密钥时，X 监控进入演示模式：
- 不发起真实 API 请求
- UI 和 API 端点正常工作
- 页面显示 "演示模式（设置 X_BEARER_TOKEN 或 SOCIALDATA_API_KEY 启用实时监控）"
- 可用于开发和测试 watchlist 配置

**不提供**凭据抓取或违反 ToS 的浏览器 cookie 窃取。

##### 工作流程

1. **推文拉取**：默认每 10 分钟（第三方 API）或 2 分钟（官方 API，可配）从监控账号拉取最新推文
2. **合约地址提取**：自动识别 Solana（base58）和 EVM（0x...）地址
3. **候选入队**：发现的合约地址入队到与链上发现相同的候选管道
4. **社交警报**：无合约地址的高层级（official/founder）推文通过 webhook 发送社交警报
5. **去重**：同一推文 ID / 同一 mint+账号 30 分钟去重

**X 来源标记**：从 X 发现的代币在候选中标记 `_xSource`（handle, displayName, tier, tweetUrl）

##### 未来扩展点（当前仅注释）

`social.mjs` 中预留集成注释：
- 聚合 X 命中与链上发现统一评分
- 交叉引用 KOL 呼单与链上地址
- 计算"社交动量"（多 KOL 提及）
- 跟踪 KOL 历史准确率加权

当前 X 监控功能（`x-monitor.mjs` 已实现）：
- Watchlist of Binance officials, CZ, He Yi, chain leads, 30 alpha KOLs
- Twitter API v2 integration + dry-run mode
- Contract address extraction (Solana + EVM)
- Enqueue into candidate pipeline
- Social alert webhooks
- 30-min deduplication

#### 4. Webhook 通知（可选，本地）

环境变量：
```bash
export WEBHOOK_URL=http://127.0.0.1:8080/alerts    # 或用户提供的 webhook 地址
export WEBHOOK_MIN_TIER=hot                        # hot | watch（默认 hot）
```

- **候选通知**：新 `hot`（或可选 `watch`）候选深度审计后 POST JSON 摘要
- **社交通知**：高层级账号无 CA 推文（official/founder）发送社交警报
- **安全**：payload 自动过滤 API key/secret/bearerToken 等敏感字段（显示 `[REDACTED]`）
- **去重**：同一 mint 30 分钟不重复发送

Webhook payload 示例（候选）：
```json
{
  "type": "embryonic_candidate",
  "timestamp": 1726455600000,
  "candidate": {
    "address": "...",
    "chain": "sol",
    "symbol": "EXAMPLE",
    "embryonicScore": 82,
    "embryonicTier": "hot",
    "embryonicSignals": ["Market cap in optimal early range", "..."],
    "embryonicSignalsCN": ["市值处于最佳早期区间", "..."],
    "status": "X_REVIEW",
    "gmgnUrl": "...",
    "twitter": "...",
    "website": "..."
  }
}
```

Webhook payload 示例（社交）：
```json
{
  "type": "social_alert",
  "timestamp": 1726455600000,
  "social": {
    "tweetId": "1234567890",
    "handle": "cz_binance",
    "displayName": "CZ",
    "tier": "founder",
    "category": "founder",
    "text": "Interesting project...",
    "url": "https://twitter.com/cz_binance/status/1234567890",
    "createdAt": 1726455000000,
    "addresses": { "solana": [], "evm": [], "all": [] },
    "cashtags": ["BTC"]
  }
}
```

#### 5. UI 更新

- 候选卡片展示 embryonic score / tier / signals
- 筛选/排序按 embryonic score
- X 监控面板：显示 watchlist、最近 X hits、推文链接
- 扫描设置中 webhook 配置项（中文 UI 标签）

（注：完整 UI 实现在 `public/index.html`，本次改造为后端优先，UI 为占位/API 就绪）

#### 6. 测试

单元测试（`test/embryonic.test.mjs`, `test/x-monitor.test.mjs`）：
- embryonic 评分逻辑 fixtures
- X watchlist 加载
- 合约地址提取（SOL + EVM）
- Cashtag 提取
- 去重逻辑

运行：`npm test`（必须通过）

### 硬约束（不变）

- **无交易模块**：无 swap、无 follow-wallet trade execution
- **Key 本地保存**：不记录或返回 secrets
- **AGPL-3.0-only**：保留许可证与上游归属
- **中文友好**：README「改造说明」+ 中文 UI 标签

## 功能介绍

- 支持 Solana、BNB 链、Base、以太坊、Robinhood Chain、Arc、Stable 七条扫描链，可选择 1–3 条链轮询。
- “即时发现”读取 1 分钟活跃榜，目标约每 20 秒刷新；严格深度审计独立运行，不用即时热度冒充安全结论。
- 综合查看合约权限、LP、税率/貔貅风险、持仓结构、普通钱包代理样本、聪明钱、5 分钟盘面与价格行为；未知字段不会假装通过。
- GoPlus 与 DexScreener 在已支持链上补充合约风险、市值、流动性和官网交叉验证，并明确标记数据缺失或冲突。
- 候选币可直接打开官网、GMGN 和 X，由使用者人工核验叙事与社区；雷达不会因社交热度自动下单。
- 提供收藏、备注、桌面提醒、筛选记录导出，以及 5 分钟至 24 小时的影子表现跟踪。
- API Key 和 Agent 认证私钥只保存在当前电脑；程序只扫描、只筛选、永不下单。

## 下载

- [Windows x64 一键便携版](https://github.com/nhovongoc0-max/meme-radar/releases/latest/download/MemeRadar-OpenSource-Windows-x64-0.1.6.zip)
- [macOS 版](https://github.com/nhovongoc0-max/meme-radar/releases/latest/download/MemeRadar-OpenSource-macOS-0.1.6.zip)

也可以在 [Releases](https://github.com/nhovongoc0-max/meme-radar/releases) 页面查看版本说明与文件校验值。

## 安全边界

- HTTP 服务只监听本机回环地址。
- 设置接口仅用于扫描链、收藏备注、保存或断开本机 GMGN API Key；不提供任何交易接口。
- GMGN API Key 只写入本项目 `state/gmgn-api-key`；创建 API 所需的 Ed25519 认证私钥只写入本项目的受限状态文件（目录 `0700`、文件 `0600`）。API Key 和私钥都不进入命令参数、状态 JSON、日志、HTTP 响应或浏览器存储，页面只会取得可公开上传的公钥。
- 浏览器只获取经过字段白名单过滤的状态，不返回上游原始响应。
- 未知或无法解析的风险字段不应被视为通过。
- X 链接仅供人工查看；未完成真实性验证时不做自动背书。
- 输出只有“拒绝 / 待复核 / 可看”三档，“可看”也只是进入人工研究清单，不代表可以买入。
- 筛选结果会记录 30 分钟、2 小时与 24 小时的影子表现；当前链未积累满 50 个样本前，不据此调参或宣称有效。

## 安装与使用

### Windows 10/11 x64

1. 下载 Windows 压缩包，右键选择 **全部解压**，不要直接在压缩软件里运行。
2. 进入解压后的文件夹，双击 **MemeRadar-OpenSource.exe**；便携包已包含运行环境，不需要另外安装 Node.js。
3. 若 Windows 显示“已保护你的电脑”，确认文件来自本仓库后点击 **更多信息 → 仍要运行**。
4. 保留启动后的黑色窗口；关闭该窗口会停止本地雷达。浏览器未自动打开时，访问 `http://127.0.0.1:3791/`。

### macOS

1. 下载 macOS 压缩包并完整解压到可写文件夹。
2. 双击 **安装并启动.command**。若系统首次阻止打开，请右键该文件选择 **打开**。
3. 首次运行会检查 Node.js；缺少兼容环境时会从 nodejs.org 下载项目专用版本并校验 SHA-256，然后安装固定依赖并打开浏览器。

### 连接 GMGN

1. 页面打开后点击 **首次使用 / 创建 API**，雷达会在本机生成本次 Agent 公钥。
2. 复制该公钥，按按钮打开 GMGN 创建 API 页面并粘贴公钥。
3. GMGN 权限只开启 **允许读取**，务必关闭 **允许交易**。
4. 创建后复制 API Key，回到雷达粘贴并点击 **✓**。验证成功后才会保存到本机并开始扫描。
5. 每次新建 API Key 都必须重新完成这套 Agent 公钥绑定；不能复用另一个 Key 的配对步骤。

以后继续双击同一个启动入口即可，Key 保存在本机，重启后不用重复填写。扫描到的代币可点击官网、GMGN 或 X 链接人工查看。若代理/VPN环境下 GMGN 连接超时，请先让浏览器能够访问 GMGN，并开启代理软件的“系统代理”，再完全关闭并重启雷达。

## 扫描与日常管理

- 默认每轮最多深审 6 个币，并受时间预算限制。按端点权重串行发送请求，明确的安全拒绝会提前结束审计。短期缓存最长 60 秒；遇到限流等待服务端冷却并降低速度，不绕过套餐限制。
- 展开“扫描设置与记录”，可选择 1–3 条链轮询，共用请求预算。单链模式点击链标签会切换扫描链；多链模式标签只切换查看，不打断后台轮询。界面标出当前链的第二数据源接入范围；“已接入”不代表每次查询都成功。
- 收藏与备注保存在本机 `state/preferences.json`，最多 50 个收藏、500 条备注。收藏币掉出发现范围后继续复查风险，不因此重新成为通过候选。关闭某条链的扫描后，该链的风险复查不再执行，但已有影子样本仍会排队补取历史价格。
- 人工通过绑定审核版本并最长保留 24 小时；风险状态变化后须重新确认。Solana 地址保留大小写。人工通过/忽略记录仅保存在当前浏览器，收藏备注由本机服务保存。
- 桌面提醒需手动开启并授权，且保持页面打开；只提醒新候选、风险恶化和长时间扫描失败。相同候选事件 30 分钟去重，静音不删除页面事件。未授权时不会影响扫描。
- “导出记录”下载不含 Key 的 JSON，包含各链的审计、影子样本、收藏备注及当前浏览器人工标记。不要将含个人备注的导出文件直接公开。
- “清除并断开 API”删除本项目 Key 并持久禁用旧 Key 回退；不会修改全局 GMGN 配置。只有重新验证并保存 Key 才恢复扫描。
- 桌面安装启动入口自带本地进程守护，异常崩溃自动恢复；状态与设置文件各保留一份有效备份。电脑关机/休眠不能扫描；本版不安装系统开机自启。`npm start` 是前台调试模式，不带守护。

## 即时发现窗口

“即时发现 · 1分钟活跃榜”与深度审计分开展示，目标每20秒读取一次 GMGN 1分钟成交额榜（最多100条），不等待整轮深审。仅在页面可见并启用自动更新时续订，离开页面约30秒后不再发起新的即时请求；后台严格扫描照常继续。多个页面共享单一请求队列和全局20秒间隔，限流冷却与审计排队仍会延迟更新，界面展示实际更新时间，超过60秒标记陈旧。它不是 WebSocket 推送或抢跑工具；GMGN 上游也可能有延迟。

窗口先排除已知貔貅、刷量、高风险、创建不足5分钟和基础流动性不足的记录；未知风险仍明确为未核验。展示范围为市值1万–50万美元，可按2万–8万美元优先、1分钟成交额或新进榜查看。新进榜指相对上次有效榜单新出现的代币（包括重新上榜），不代表刚发币；首屏不伪造“新币”，榜单缺失也不填充演示数据。两次快照价格变化使用真实间隔，不冒充1分钟K线涨幅。

“排队核验”只对已启用扫描链、通过原初筛的最新线索开放；仍按原安全标准审查，不会下单、不改变扫描链。每轮最多占用一个优先位置，原总审计预算不增大。请求最多12个，10分钟过期，重启后临时队列清空；已完成审计保存方式不变。共享API意味着即时窗口仍消耗额度，不能承诺对审计速度完全无影响。

## 筛选效果如何验证

通过组按合约地址跟踪 5 分钟、15 分钟、30 分钟、1 小时、2 小时、6 小时、24 小时的价格。代币掉榜或切换查看链也不丢弃样本；缺失窗口会通过对应时刻附近的已收盘 1 分钟 K 线补取，保存实际时间与数据来源，不用当前价格冒充历史价格。

深审拒绝组按合约地址哈希固定抽取约五分之一作对照，最多 200 条。两组分别展示到期数、完成数、缺失数与中位涨跌，不混成一个收益数字。缺失价格不是零收益；拒绝组抽样仅覆盖实际深审过的代币，不能代表所有新币。50 个样本只是最低观察门槛，不构成策略有效或盈利的证明。涨跌统计不含可成交性、滑点和手续费，不是模拟交易收益。

若 macOS 首次阻止打开下载的脚本，可在确认文件来源后通过“右键 → 打开”启动。首次安装需要网络；窗口中的安装错误会指出未完成的步骤。

## 命令行运行

已有 Node.js 22.23+ 或 24.5+ 的用户，在项目目录运行：

```bash
npm run setup
npm run open
```

`npm run setup` 自动执行锁文件对应的依赖安装，`npm run open` 在后台启动本机服务并打开 `http://127.0.0.1:3791/`。macOS 的自动安装路径已实测，Windows 与 Linux 仍需干净设备验证。

前台运行用 `npm start`；检查环境用 `npm run doctor`；测试用 `npm test`。端口占用时可通过 `RADAR_PORT` 指定另一端口；启动器不会覆盖其他程序或另一份项目。

GMGN 客户端固定为项目依赖 `gmgn-cli@1.5.7`，雷达直接使用其中的只读客户端。开源版不会读取环境变量、旧的 GMGN 全局配置或项目 `.env`；只有在当前开源版页面完成 Agent 公钥创建步骤并通过读取权限验证的 Key 才会生效。连接验证和日常扫描都不向请求进程传递认证私钥或调试开关，也不会调用 `follow-wallet`、swap 或下单接口；任何网页响应都不会返回私钥。

运行记录在 `state/`、日志在 `logs/`、自动下载的运行环境在 `.runtime/`。它们以及 `node_modules/` 不应加入版本库或发布包。不要把 API Key 放进截图、代码或日志。

## 许可

源代码采用 [GNU Affero General Public License v3.0](LICENSE)（`AGPL-3.0-only`）。可以使用、研究、修改和再发布；若修改后通过网络向他人提供服务，须按许可证向这些用户提供对应源代码。`private: true` 仅用于防止误发 npm。第三方数据接口仍受各自服务条款约束。开源版与专业版边界见 `docs/EDITION-BOUNDARY.md`。
