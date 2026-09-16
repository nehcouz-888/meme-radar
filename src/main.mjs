#!/usr/bin/env node
import { config } from './config.mjs';
import { GmgnClient } from './gmgn.mjs';
import { GmgnKeyStore } from './gmgn-key-store.mjs';
import { GmgnConnection } from './gmgn-connection.mjs';
import { RadarState } from './state.mjs';
import { Scanner } from './scanner.mjs';
import { SecondaryValidator } from './secondary.mjs';
import { createServer, toPublicStatus } from './server.mjs';
import { RadarControls } from './local-store.mjs';
import { LiveDiscovery } from './live-discovery.mjs';
import { XMonitor } from './x-monitor.mjs';
import { WebhookNotifier } from './webhook.mjs';
import { configureWindowsSystemProxy } from './windows-proxy.mjs';

// Browsers use the Windows system proxy automatically, while Node normally
// only sees proxy environment variables. Mirror the effective Windows proxy
// before any GMGN worker is launched so the portable build follows the same
// network route as the user's browser.
const proxy = configureWindowsSystemProxy();
if (process.platform === 'win32') {
  console.log(proxy.proxy ? '已接入 Windows 系统网络代理。' : '未检测到 Windows 系统代理，将使用直连网络。');
}

const once = process.argv.includes('--once');
const state = new RadarState(config.stateDir);
const keyStore = new GmgnKeyStore(config.stateDir);
// Community installations must be explicit: never inherit an API key from the
// user's shell or a pre-existing global GMGN CLI configuration.
const gmgn = new GmgnClient({
  apiKeyProvider: () => keyStore.get(),
  privateKeyProvider: () => keyStore.verificationPrivateKey(),
  legacyKeyProvider: () => ''
});
if (keyStore.disconnected()) gmgn.resetCredentials({ disabled: true });
gmgn.nextAllowedAt = Math.max(0, Number(state.value.retryAt) || 0);
const controls = new RadarControls(config.stateDir, config.supportedChains, state.value.activeChain || config.chain);
const webhookNotifier = new WebhookNotifier({ settings: config });
const xMonitor = await new XMonitor({ settings: config }).init();
const scanner = new Scanner({ gmgn, secondary: new SecondaryValidator(), state, controls, webhookNotifier, xMonitor });
const connection = new GmgnConnection({ gmgn, keyStore, scanner });
const liveDiscovery = new LiveDiscovery({ gmgn });

if (once) {
  await scanner.cycle();
  console.log(JSON.stringify(toPublicStatus(state.value), null, 2));
  process.exit(state.value.status === 'ERROR' ? 1 : 0);
}

const server = createServer({
  state,
  controls,
  liveDiscovery,
  xMonitor,
  webhookNotifier,
  enqueueReview: (chain, row) => scanner.enqueueReview(chain, row),
  settings: config,
  supportedChains: config.supportedChains,
  switchChain: chain => scanner.switchChain(chain),
  saveGmgnKey: apiKey => connection.apply(apiKey),
  disconnectGmgnKey: () => connection.disconnect(),
  getGmgnOnboarding: options => keyStore.onboarding(options),
  getGmgnConnection: () => connection.snapshot()
});
server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, '127.0.0.1', resolve);
});
console.log(`金狗雷达 (Meme Radar Jindou)：http://127.0.0.1:${config.port}`);
console.log('只读扫描器：交易执行永久关闭');
    const providerName = xMonitor.mode === 'stub' ? '演示模式' 
      : xMonitor.mode === 'official' ? '官方Twitter API'
      : xMonitor.mode === 'socialdata' ? 'SocialData第三方'
      : xMonitor.mode === 'sorsa' ? 'Sorsa第三方'
      : '未知';
    console.log(`X监控模式：${providerName}${xMonitor.mode === 'stub' ? '（设置 X_BEARER_TOKEN 或 SOCIALDATA_API_KEY 启用实时监控）' : ''}`);
console.log(`Webhook通知：${webhookNotifier.isEnabled() ? '已启用' : '未启用（设置 WEBHOOK_URL 启用）'}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    scanner.stop();
    liveDiscovery.stop();
    xMonitor.stop();
    server.close(() => process.exit(0));
  });
}
await xMonitor.start();
await scanner.start();
