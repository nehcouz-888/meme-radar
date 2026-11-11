#!/usr/bin/env node
/**
 * 旧pending文件迁移到新queue协议
 * - 扫描.pending文件
 * - 归档已发送的eventId（不重放80 delivered）
 * - 未发送的添加到queue
 * - 提供显式rollback步骤
 */

import fs from 'node:fs';
import path from 'node:path';
import { addPendingAlert, loadQueue } from '../src/modules/alert-queue.mjs';

const STATE_DIR = '/workspace/meme-radar-run/meme-radar-branch/state';
const QUEUE_FILE = path.join(STATE_DIR, 'fomo-alerts-queue.jsonl');
const ARCHIVE_DIR = path.join(STATE_DIR, 'migration-archive');
const MIGRATION_LOG = path.join(STATE_DIR, 'migration.log');

// 迁移状态
const state = {
  pendingFiles: [],
  archivedEvents: [],
  migratedEvents: [],
  skippedEvents: [],
  errors: []
};

/**
 * 扫描旧pending文件
 */
function scanPendingFiles() {
  console.log('Scanning for .pending files...');
  
  if (!fs.existsSync(STATE_DIR)) {
    console.log('State directory not found, nothing to migrate');
    return [];
  }
  
  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.pending'));
  console.log(`Found ${files.length} .pending files`);
  
  return files.map(f => path.join(STATE_DIR, f));
}

/**
 * 读取已delivered的eventId（从queue）
 */
function loadDeliveredEventIds() {
  if (!fs.existsSync(QUEUE_FILE)) {
    return new Set();
  }
  
  const items = loadQueue(QUEUE_FILE);
  const delivered = new Set();
  
  for (const item of items) {
    if (item.status === 'delivered') {
      delivered.add(item.eventId);
    }
  }
  
  console.log(`Loaded ${delivered.size} delivered eventIds from queue`);
  return delivered;
}

/**
 * 解析pending文件内容
 */
function parsePendingFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    
    const events = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        events.push(event);
      } catch (e) {
        console.error(`Failed to parse line in ${filePath}: ${e.message}`);
      }
    }
    
    return events;
  } catch (e) {
    console.error(`Failed to read ${filePath}: ${e.message}`);
    return [];
  }
}

/**
 * 归档已发送的event
 */
function archiveEvent(event, reason) {
  const archiveFile = path.join(ARCHIVE_DIR, 'archived-events.jsonl');
  const archiveEntry = {
    ...event,
    archivedAt: new Date().toISOString(),
    archiveReason: reason
  };
  
  fs.appendFileSync(archiveFile, JSON.stringify(archiveEntry) + '\n', 'utf8');
  state.archivedEvents.push(event.eventId);
}

/**
 * 迁移事件到queue
 */
function migrateEvent(event) {
  try {
    // 转换为queue格式
    const queueEvent = {
      eventId: event.eventId || `migrated-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...event,
      migratedFrom: 'pending',
      migratedAt: new Date().toISOString()
    };
    
    if (addPendingAlert(QUEUE_FILE, queueEvent)) {
      state.migratedEvents.push(queueEvent.eventId);
      return true;
    } else {
      state.errors.push({ eventId: queueEvent.eventId, reason: 'addPendingAlert_failed' });
      return false;
    }
  } catch (e) {
    state.errors.push({ eventId: event.eventId, reason: e.message });
    return false;
  }
}

/**
 * 执行迁移
 */
async function migrate(options = {}) {
  const { dryRun = false, skipDelivered = true } = options;
  
  console.log('\n=== Migration Starting ===');
  console.log(`Dry run: ${dryRun}`);
  console.log(`Skip delivered: ${skipDelivered}`);
  
  // 创建归档目录
  if (!dryRun) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
  
  // 扫描pending文件
  state.pendingFiles = scanPendingFiles();
  if (state.pendingFiles.length === 0) {
    console.log('No pending files to migrate');
    return state;
  }
  
  // 加载已delivered的eventId
  const deliveredIds = skipDelivered ? loadDeliveredEventIds() : new Set();
  
  // 处理每个pending文件
  for (const filePath of state.pendingFiles) {
    console.log(`\nProcessing: ${filePath}`);
    const events = parsePendingFile(filePath);
    
    for (const event of events) {
      const eventId = event.eventId || 'unknown';
      
      // 检查是否已delivered
      if (deliveredIds.has(eventId)) {
        console.log(`  Archiving (already delivered): ${eventId}`);
        if (!dryRun) {
          archiveEvent(event, 'already_delivered');
        }
        continue;
      }
      
      // 迁移到queue
      console.log(`  Migrating: ${eventId}`);
      if (!dryRun) {
        migrateEvent(event);
      } else {
        state.migratedEvents.push(eventId);
      }
    }
    
    // 备份并删除原pending文件
    if (!dryRun) {
      const backupPath = path.join(ARCHIVE_DIR, path.basename(filePath) + '.backup');
      fs.copyFileSync(filePath, backupPath);
      fs.unlinkSync(filePath);
      console.log(`  Backed up and removed: ${filePath}`);
    }
  }
  
  // 写入迁移日志
  if (!dryRun) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      pendingFiles: state.pendingFiles.length,
      archived: state.archivedEvents.length,
      migrated: state.migratedEvents.length,
      skipped: state.skippedEvents.length,
      errors: state.errors.length,
      details: state
    };
    
    fs.appendFileSync(MIGRATION_LOG, JSON.stringify(logEntry) + '\n', 'utf8');
  }
  
  console.log('\n=== Migration Summary ===');
  console.log(`Pending files: ${state.pendingFiles.length}`);
  console.log(`Archived (already delivered): ${state.archivedEvents.length}`);
  console.log(`Migrated to queue: ${state.migratedEvents.length}`);
  console.log(`Errors: ${state.errors.length}`);
  
  if (state.errors.length > 0) {
    console.log('\nErrors:');
    for (const err of state.errors) {
      console.log(`  ${err.eventId}: ${err.reason}`);
    }
  }
  
  return state;
}

/**
 * 回滚迁移
 */
async function rollback() {
  console.log('\n=== Migration Rollback ===');
  
  if (!fs.existsSync(ARCHIVE_DIR)) {
    console.log('No archive found, nothing to rollback');
    return;
  }
  
  // 恢复pending文件
  const backups = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.pending.backup'));
  console.log(`Found ${backups.length} backup files`);
  
  for (const backup of backups) {
    const backupPath = path.join(ARCHIVE_DIR, backup);
    const originalName = backup.replace('.backup', '');
    const restorePath = path.join(STATE_DIR, originalName);
    
    fs.copyFileSync(backupPath, restorePath);
    console.log(`Restored: ${originalName}`);
  }
  
  // 读取迁移日志，移除迁移的事件
  if (fs.existsSync(MIGRATION_LOG)) {
    const logs = fs.readFileSync(MIGRATION_LOG, 'utf8').split('\n').filter(Boolean);
    const lastLog = JSON.parse(logs[logs.length - 1]);
    
    console.log(`Removing ${lastLog.migrated} migrated events from queue...`);
    
    const items = loadQueue(QUEUE_FILE);
    const migratedSet = new Set(lastLog.details.migratedEvents);
    const filtered = items.filter(item => !migratedSet.has(item.eventId));
    
    fs.writeFileSync(QUEUE_FILE, filtered.map(i => JSON.stringify(i)).join('\n') + '\n', 'utf8');
    console.log(`Removed ${items.length - filtered.length} events from queue`);
  }
  
  console.log('\n✅ Rollback complete');
  console.log('Archive retained for audit');
}

// CLI
const command = process.argv[2];

if (command === 'migrate') {
  const dryRun = process.argv.includes('--dry-run');
  migrate({ dryRun }).then(() => process.exit(0)).catch(e => {
    console.error('Migration failed:', e);
    process.exit(1);
  });
} else if (command === 'rollback') {
  rollback().then(() => process.exit(0)).catch(e => {
    console.error('Rollback failed:', e);
    process.exit(1);
  });
} else {
  console.log('Usage:');
  console.log('  node migrate-pending-to-queue.mjs migrate [--dry-run]');
  console.log('  node migrate-pending-to-queue.mjs rollback');
  process.exit(1);
}
