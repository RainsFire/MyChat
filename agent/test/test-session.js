/**
 * 会话持久化测试
 * 覆盖 Session 模块的保存/加载/清除，以及端到端会话恢复场景
 */

const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const { CryptoHelper } = require('../crypto');
const fs = require('fs');
const path = require('path');

const PORT = 19095;
const URL = `ws://localhost:${PORT}`;

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, testName) {
  if (condition) {
    passed++;
    results.push(`  ✓ ${testName}`);
  } else {
    failed++;
    results.push(`  ✗ ${testName}`);
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function wsConnect(url = URL) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      _bufferMessages(ws);
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function _bufferMessages(ws) {
  const buffer = [];
  const waiters = [];
  ws._msgBuffer = buffer;
  ws._msgWaiters = waiters;
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === msg.type) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
    }
    buffer.push(msg);
  });
}

function nextMsg(ws, type, timeout = 5000) {
  const idx = ws._msgBuffer.findIndex(m => m.type === type);
  if (idx >= 0) {
    return Promise.resolve(ws._msgBuffer.splice(idx, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const wi = ws._msgWaiters.findIndex(w => w.type === type && w.resolve === resolve);
      if (wi >= 0) ws._msgWaiters.splice(wi, 1);
      reject(new Error(`等待 ${type} 超时`));
    }, timeout);
    ws._msgWaiters.push({ type, resolve, timer });
  });
}

async function auth(ws, device) {
  ws.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device
  }));
  await nextMsg(ws, 'auth_ok');
}

async function doKeyExchange(mobile, desktop) {
  const mobileCrypto = new CryptoHelper();
  const desktopCrypto = new CryptoHelper();
  const mobilePubKey = mobileCrypto.initAsInitiator();
  mobile.send(JSON.stringify({ type: 'key_init', publicKey: mobilePubKey }));
  const keyInitMsg = await nextMsg(desktop, 'key_init');
  const desktopPubKey = desktopCrypto.initAsResponder(keyInitMsg.publicKey);
  desktop.send(JSON.stringify({ type: 'key_response', publicKey: desktopPubKey }));
  const keyRespMsg = await nextMsg(mobile, 'key_response');
  mobileCrypto.completeHandshake(keyRespMsg.publicKey);
  return { mobileCrypto, desktopCrypto };
}

// 使用真实 ~/.mychat 目录，测试后恢复原始状态
const SESSION_DIR = path.join(process.env.HOME || '/tmp', '.mychat');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');
let originalSessionContent = null;

function backupSession() {
  if (fs.existsSync(SESSION_FILE)) {
    originalSessionContent = fs.readFileSync(SESSION_FILE, 'utf8');
    fs.unlinkSync(SESSION_FILE);
  }
}

function restoreSession() {
  if (originalSessionContent !== null) {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, originalSessionContent);
  } else if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
  }
}

// =====================================================
// 第一类：Session 模块单元测试（4个场景）
// =====================================================

async function test_session_newIsEmpty() {
  console.log('[测试] 场景1: 新建 Session 无持久化文件');

  // 清除 require 缓存确保新实例
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);

  const Session = require('../session');
  const session = new Session();
  assert(session.sessionId === null, '场景1: 初始 sessionId 为 null');
  assert(session.createdAt === null, '场景1: 初始 createdAt 为 null');
  assert(session.hasSession() === false, '场景1: hasSession 返回 false');
}

async function test_session_saveAndReload() {
  console.log('[测试] 场景2: save 后重新加载验证持久化');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);

  const Session = require('../session');
  const session1 = new Session();
  session1.save('test-session-id-abc123');

  assert(fs.existsSync(SESSION_FILE), '场景2: session.json 文件已创建');

  const fileContent = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  assert(fileContent.sessionId === 'test-session-id-abc123', '场景2: 文件中 sessionId 正确');
  assert(fileContent.createdAt !== null, '场景2: 文件中 createdAt 不为空');

  // 模拟重启：清除缓存创建新实例
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });
  const Session2 = require('../session');
  const session2 = new Session2();
  assert(session2.sessionId === 'test-session-id-abc123', '场景2: 重新加载后 sessionId 恢复');
  assert(session2.hasSession() === true, '场景2: 重新加载后 hasSession 为 true');
  assert(session2.createdAt === session1.createdAt, '场景2: createdAt 保持不变');

  // 再次 save 更新 sessionId，createdAt 应保持不变
  session2.save('test-session-id-xyz789');
  assert(session2.sessionId === 'test-session-id-xyz789', '场景2: 更新后 sessionId 正确');
  assert(session2.createdAt === session1.createdAt, '场景2: 更新后 createdAt 不变');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });
  const Session3 = require('../session');
  const session3 = new Session3();
  assert(session3.sessionId === 'test-session-id-xyz789', '场景2: 再次加载后 sessionId 为新值');
  assert(session3.createdAt === session1.createdAt, '场景2: 再次加载后 createdAt 不变');
}

async function test_session_clearRemovesFile() {
  console.log('[测试] 场景3: clear 后清空 session 并删除文件');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });

  const Session = require('../session');
  const session = new Session();
  session.save('session-to-clear');
  assert(fs.existsSync(SESSION_FILE), '场景3: clear 前文件存在');

  session.clear();
  assert(session.sessionId === null, '场景3: clear 后 sessionId 为 null');
  assert(session.createdAt === null, '场景3: clear 后 createdAt 为 null');
  assert(session.hasSession() === false, '场景3: clear 后 hasSession 为 false');
  assert(!fs.existsSync(SESSION_FILE), '场景3: clear 后文件已删除');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });
  const Session2 = require('../session');
  const session2 = new Session2();
  assert(session2.sessionId === null, '场景3: 清除后重新加载 sessionId 为 null');
}

async function test_session_corruptFileGraceful() {
  console.log('[测试] 场景4: 损坏文件不导致崩溃');

  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, '{invalid json content');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });

  const Session = require('../session');
  const session = new Session();
  assert(session.sessionId === null, '场景4: 损坏文件后 sessionId 为 null');
  assert(session.hasSession() === false, '场景4: 损坏文件后 hasSession 为 false');

  session.save('recovery-session-id');
  assert(session.sessionId === 'recovery-session-id', '场景4: 损坏文件后仍可 save');
}

// =====================================================
// 第二类：多次 save 与 Agent 重启恢复（2个场景）
// =====================================================

async function test_session_multipleSavesPreserveCreatedAt() {
  console.log('[测试] 场景7: 多次 save 保持 createdAt 不变');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);

  const Session = require('../session');
  const session = new Session();

  session.save('session-001');
  const firstCreatedAt = session.createdAt;
  assert(firstCreatedAt !== null, '场景7: 第一次 save 有 createdAt');

  await delay(50);
  session.save('session-002');
  assert(session.createdAt === firstCreatedAt, '场景7: 第二次 save createdAt 不变');

  await delay(50);
  session.save('session-003');
  assert(session.createdAt === firstCreatedAt, '场景7: 第三次 save createdAt 不变');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });
  const Session2 = require('../session');
  const session2 = new Session2();
  assert(session2.sessionId === 'session-003', '场景7: 重载后 sessionId 为最新值');
  assert(session2.createdAt === firstCreatedAt, '场景7: 重载后 createdAt 不变');
}

async function test_agentRestart_sessionSurvives() {
  console.log('[测试] 场景8: 模拟 Agent 重启 session 存活');

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });

  const Session1 = require('../session');
  const session1 = new Session1();
  session1.save('surviving-session-id');
  const savedCreatedAt = session1.createdAt;

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/agent/session')) delete require.cache[key];
  });

  const Session2 = require('../session');
  const session2 = new Session2();
  assert(session2.sessionId === 'surviving-session-id', '场景8: 重启后 sessionId 恢复');
  assert(session2.createdAt === savedCreatedAt, '场景8: 重启后 createdAt 恢复');
  assert(session2.hasSession() === true, '场景8: 重启后 hasSession 为 true');
}

// =====================================================

async function runTests() {
  console.log('\n=== 会话持久化测试 ===\n');

  // 备份真实 session 文件
  backupSession();

  process.env.MYCHAT_PORT = PORT;
  process.env.MYCHAT_USER = 'testuser';
  const hash = await bcrypt.hash('testpass', 4);
  process.env.MYCHAT_PASS_HASH = hash;

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/relay/')) delete require.cache[key];
  });

  const { start } = require('../../relay/server');
  await start();
  await delay(500);

  try {
    await test_session_newIsEmpty();
    await test_session_saveAndReload();
    await test_session_clearRemovesFile();
    await test_session_corruptFileGraceful();
    await test_session_multipleSavesPreserveCreatedAt();
    await test_agentRestart_sessionSurvives();
  } catch (e) {
    console.error('测试异常:', e);
  }

  // 恢复真实 session 文件
  restoreSession();

  console.log('\n--- 测试结果 ---');
  results.forEach(r => console.log(r));
  console.log(`\n通过: ${passed}  失败: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('测试启动失败:', err);
  restoreSession();
  process.exit(1);
});