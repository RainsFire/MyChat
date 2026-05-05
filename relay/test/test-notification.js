/**
 * 通知与复合场景测试
 * 结合 [连接]、[会话]、[通知] 三重要素，覆盖典型复合场景
 */

const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const { CryptoHelper } = require('../crypto');
const fs = require('fs');
const path = require('path');

const PORT = 19096;
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

function encryptSend(ws, crypto, data) {
  const payload = crypto.encrypt(data);
  ws.send(JSON.stringify({ type: 'encrypted', payload }));
}

async function decryptNext(ws, crypto, type, timeout = 5000) {
  const msg = await nextMsg(ws, 'encrypted', timeout);
  return crypto.decrypt(msg.payload);
}

// Session 文件路径
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
// 场景 1: permission_request 加密转发完整流程
// =====================================================

async function test_permissionRequest_encryptedFlow() {
  console.log('[测试] 场景1: permission_request 加密转发完整流程');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // Desktop 发送 permission_request
  encryptSend(desktop, desktopCrypto, {
    type: 'permission_request',
    action: 'read_file',
    details: '/tmp/test.txt'
  });

  const received = await decryptNext(mobile, mobileCrypto, 'encrypted');
  assert(received.type === 'permission_request', '场景1: mobile 收到 permission_request');
  assert(received.action === 'read_file', '场景1: action 正确');
  assert(received.details === '/tmp/test.txt', '场景1: details 正确');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 2: choice_request 加密转发完整流程
// =====================================================

async function test_choiceRequest_encryptedFlow() {
  console.log('[测试] 场景2: choice_request 加密转发完整流程');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // Desktop 发送 choice_request
  encryptSend(desktop, desktopCrypto, {
    type: 'choice_request',
    options: ['选项A', '选项B', '选项C']
  });

  const received = await decryptNext(mobile, mobileCrypto, 'encrypted');
  assert(received.type === 'choice_request', '场景2: mobile 收到 choice_request');
  assert(Array.isArray(received.options), '场景2: options 是数组');
  assert(received.options.length === 3, '场景2: options 数量正确');
  assert(received.options[0] === '选项A', '场景2: 第一个选项正确');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 3: permission_response 回传验证
// =====================================================

async function test_permissionResponse_roundTrip() {
  console.log('[测试] 场景3: permission_response 回传验证');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // Desktop 发送 permission_request
  encryptSend(desktop, desktopCrypto, {
    type: 'permission_request',
    action: 'write_file',
    details: '/tmp/output.txt'
  });

  await decryptNext(mobile, mobileCrypto, 'encrypted');

  // Mobile 回复 permission_response
  encryptSend(mobile, mobileCrypto, {
    type: 'permission_response',
    response: 'approve'
  });

  const received = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(received.type === 'permission_response', '场景3: desktop 收到 permission_response');
  assert(received.response === 'approve', '场景3: response 正确');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 4: choice_response 回传验证
// =====================================================

async function test_choiceResponse_roundTrip() {
  console.log('[测试] 场景4: choice_response 回传验证');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // Desktop 发送 choice_request
  encryptSend(desktop, desktopCrypto, {
    type: 'choice_request',
    options: ['A', 'B']
  });

  await decryptNext(mobile, mobileCrypto, 'encrypted');

  // Mobile 回复 choice_response
  encryptSend(mobile, mobileCrypto, {
    type: 'choice_response',
    selected: 1
  });

  const received = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(received.type === 'choice_response', '场景4: desktop 收到 choice_response');
  assert(received.selected === 1, '场景4: selected 正确');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 5: chat 流程中穿插 permission_request
// =====================================================

async function test_chatWithPermissionRequestInterleaved() {
  console.log('[测试] 场景5: chat 流程中穿插 permission_request');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // Desktop 发送混合消息流
  encryptSend(desktop, desktopCrypto, { type: 'chat_reply', content: 'Hello ' });
  encryptSend(desktop, desktopCrypto, { type: 'chat_reply', content: 'World!' });
  encryptSend(desktop, desktopCrypto, { type: 'permission_request', action: 'execute', details: 'npm test' });
  encryptSend(desktop, desktopCrypto, { type: 'chat_reply', content: 'Done.' });
  encryptSend(desktop, desktopCrypto, { type: 'chat_complete' });

  const messages = [];
  for (let i = 0; i < 5; i++) {
    const msg = await decryptNext(mobile, mobileCrypto, 'encrypted');
    messages.push(msg);
  }

  assert(messages[0].type === 'chat_reply', '场景5: 第一条是 chat_reply');
  assert(messages[1].type === 'chat_reply', '场景5: 第二条是 chat_reply');
  assert(messages[2].type === 'permission_request', '场景5: 第三条是 permission_request');
  assert(messages[3].type === 'chat_reply', '场景5: 第四条是 chat_reply');
  assert(messages[4].type === 'chat_complete', '场景5: 第五条是 chat_complete');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 6: mobile 重连后收到 permission_request
// =====================================================

async function test_mobileReconnect_thenPermissionRequest() {
  console.log('[测试] 场景6: mobile 重连后收到 permission_request');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto: crypto1, desktopCrypto: desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // Mobile 断开
  mobile.close();
  await delay(300);

  // Mobile 重连
  const mobile2 = await wsConnect();
  await auth(mobile2, 'mobile');
  await delay(100);

  // Desktop 收到 device_status (mobile online)
  const statusMsg = await nextMsg(desktop, 'device_status', 2000);
  assert(statusMsg.device === 'mobile', '场景6: desktop 收到 mobile 上线状态');
  assert(statusMsg.online === true, '场景6: mobile 状态为 online');

  // 新的密钥交换
  const { mobileCrypto: crypto2, desktopCrypto: desktopCrypto2 } = await doKeyExchange(mobile2, desktop);
  await delay(100);

  // Desktop 发送 permission_request（用新密钥）
  encryptSend(desktop, desktopCrypto2, {
    type: 'permission_request',
    action: 'delete',
    details: '/tmp/old.log'
  });

  const received = await decryptNext(mobile2, crypto2, 'encrypted');
  assert(received.type === 'permission_request', '场景6: 重连后 mobile 收到 permission_request');

  mobile2.close();
  desktop.close();
}

// =====================================================
// 场景 7: session 查询与 permission_request 并发
// =====================================================

async function test_sessionQuery_withPermissionRequestConcurrent() {
  console.log('[测试] 场景7: session 查询与 permission_request 并发');

  // 先创建 session 文件
  backupSession();
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({
    sessionId: 'test-session-001',
    createdAt: Date.now() - 1000
  }));

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // 同时发送两个消息
  encryptSend(mobile, mobileCrypto, { type: 'query_session_status' });
  encryptSend(desktop, desktopCrypto, { type: 'permission_request', action: 'read', details: 'config.json' });

  // Desktop 收到 query_session_status
  const sessionQuery = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(sessionQuery.type === 'query_session_status', '场景7: desktop 收到 session 查询');

  // Desktop 回复 session_status
  encryptSend(desktop, desktopCrypto, {
    type: 'session_status',
    hasSession: true,
    createdAt: Date.now() - 1000
  });

  // Mobile 同时收到 permission_request 和 session_status
  const msg1 = await decryptNext(mobile, mobileCrypto, 'encrypted');
  const msg2 = await decryptNext(mobile, mobileCrypto, 'encrypted');

  const hasSessionStatus = msg1.type === 'session_status' || msg2.type === 'session_status';
  const hasPermission = msg1.type === 'permission_request' || msg2.type === 'permission_request';
  assert(hasSessionStatus, '场景7: mobile 收到 session_status');
  assert(hasPermission, '场景7: mobile 收到 permission_request');

  mobile.close();
  desktop.close();
  restoreSession();
}

// =====================================================
// 场景 8: desktop 重连后发送 notification
// =====================================================

async function test_desktopReconnect_thenSendNotification() {
  console.log('[测试] 场景8: desktop 重连后发送 notification');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto: mobileCrypto1, desktopCrypto: crypto1 } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // 消费初始的 device_status (desktop online)
  await nextMsg(mobile, 'device_status', 2000);

  // Desktop 断开
  desktop.close();
  await delay(300);

  // Mobile 收到 device_status (desktop offline)
  const offlineMsg = await nextMsg(mobile, 'device_status', 2000);
  assert(offlineMsg.device === 'desktop', '场景8: mobile 收到 desktop 离线状态');
  assert(offlineMsg.online === false, '场景8: desktop 状态为 offline');

  // Desktop 重连
  const desktop2 = await wsConnect();
  await auth(desktop2, 'desktop');
  await delay(100);

  // Mobile 收到 device_status (desktop online)
  const onlineMsg = await nextMsg(mobile, 'device_status', 2000);
  assert(onlineMsg.device === 'desktop', '场景8: mobile 收到 desktop 上线状态');
  assert(onlineMsg.online === true, '场景8: desktop 状态为 online');

  // 新的密钥交换
  const { mobileCrypto: mobileCrypto2, desktopCrypto: crypto2 } = await doKeyExchange(mobile, desktop2);
  await delay(100);

  // Desktop 发送 choice_request
  encryptSend(desktop2, crypto2, {
    type: 'choice_request',
    options: ['Continue', 'Abort']
  });

  const received = await decryptNext(mobile, mobileCrypto2, 'encrypted');
  assert(received.type === 'choice_request', '场景8: 重连后 mobile 收到 choice_request');
  assert(received.options.length === 2, '场景8: options 数量正确');

  mobile.close();
  desktop2.close();
}

// =====================================================
// 场景 9: 多种 notification 快速连续到达
// =====================================================

async function test_multipleNotificationsRapidSequence() {
  console.log('[测试] 场景9: 多种 notification 快速连续到达');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // Desktop 快速发送 10 条混合消息
  const expected = [
    { type: 'chat_reply', content: 'Line 1' },
    { type: 'chat_reply', content: 'Line 2' },
    { type: 'permission_request', action: 'exec', details: 'cmd1' },
    { type: 'chat_reply', content: 'Line 3' },
    { type: 'choice_request', options: ['A', 'B'] },
    { type: 'chat_reply', content: 'Line 4' },
    { type: 'permission_request', action: 'read', details: 'file1' },
    { type: 'chat_reply', content: 'Line 5' },
    { type: 'chat_complete' },
    { type: 'mode_changed', mode: 'auto' }
  ];

  for (const msg of expected) {
    encryptSend(desktop, desktopCrypto, msg);
  }

  const received = [];
  for (let i = 0; i < 10; i++) {
    const msg = await decryptNext(mobile, mobileCrypto, 'encrypted');
    received.push(msg);
  }

  for (let i = 0; i < 10; i++) {
    assert(received[i].type === expected[i].type, `场景9: 第${i + 1}条消息类型正确 (${expected[i].type})`);
  }

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 10: 三重要素复合：session + notification + connection
// =====================================================

async function test_threeElementsCompound() {
  console.log('[测试] 场景10: 三重要素复合：session + notification + connection');

  // 创建 session 文件
  backupSession();
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({
    sessionId: 'compound-session-001',
    createdAt: Date.now() - 5000
  }));

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto: mCrypto1, desktopCrypto: dCrypto1 } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // 查询 session
  encryptSend(mobile, mCrypto1, { type: 'query_session_status' });
  const sessionQuery = await decryptNext(desktop, dCrypto1, 'encrypted');
  assert(sessionQuery.type === 'query_session_status', '场景10: desktop 收到 session 查询');

  encryptSend(desktop, dCrypto1, { type: 'session_status', hasSession: true, createdAt: Date.now() - 5000 });
  const sessionResp = await decryptNext(mobile, mCrypto1, 'encrypted');
  assert(sessionResp.type === 'session_status', '场景10: mobile 收到 session 状态');
  assert(sessionResp.hasSession === true, '场景10: hasSession 为 true');

  // Chat 流程 + permission_request
  encryptSend(desktop, dCrypto1, { type: 'chat_reply', content: 'Processing...' });
  encryptSend(desktop, dCrypto1, { type: 'permission_request', action: 'install', details: 'npm package' });
  encryptSend(desktop, dCrypto1, { type: 'chat_complete' });

  const chatMsg = await decryptNext(mobile, mCrypto1, 'encrypted');
  assert(chatMsg.type === 'chat_reply', '场景10: 收到 chat_reply');

  const permMsg = await decryptNext(mobile, mCrypto1, 'encrypted');
  assert(permMsg.type === 'permission_request', '场景10: 收到 permission_request');

  const compMsg = await decryptNext(mobile, mCrypto1, 'encrypted');
  assert(compMsg.type === 'chat_complete', '场景10: 收到 chat_complete');

  // Desktop 断开重连
  desktop.close();
  await delay(300);

  const desktop2 = await wsConnect();
  await auth(desktop2, 'desktop');
  await delay(100);

  // 新密钥交换
  const { mobileCrypto: mCrypto2, desktopCrypto: dCrypto2 } = await doKeyExchange(mobile, desktop2);
  await delay(100);

  // 新的 notification
  encryptSend(desktop2, dCrypto2, { type: 'choice_request', options: ['Retry', 'Skip'] });
  const choiceMsg = await decryptNext(mobile, mCrypto2, 'encrypted');
  assert(choiceMsg.type === 'choice_request', '场景10: 重连后收到 choice_request');

  // Session 仍然存在
  encryptSend(mobile, mCrypto2, { type: 'query_session_status' });
  const sessionQuery2 = await decryptNext(desktop2, dCrypto2, 'encrypted');
  assert(sessionQuery2.type === 'query_session_status', '场景10: 重连后 session 查询正常');

  encryptSend(desktop2, dCrypto2, { type: 'session_status', hasSession: true, createdAt: Date.now() - 5000 });
  const sessionResp2 = await decryptNext(mobile, mCrypto2, 'encrypted');
  assert(sessionResp2.hasSession === true, '场景10: 重连后 session 状态保持');

  mobile.close();
  desktop2.close();
  restoreSession();
}

// =====================================================

async function runTests() {
  console.log('\n=== 通知与复合场景测试 ===\n');

  process.env.MYCHAT_PORT = PORT;
  process.env.MYCHAT_USER = 'testuser';
  const hash = await bcrypt.hash('testpass', 4);
  process.env.MYCHAT_PASS_HASH = hash;

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/relay/')) delete require.cache[key];
  });

  const { start, auth, router, wss } = require('../server');
  await start();
  await delay(500);

  try {
    await test_permissionRequest_encryptedFlow();
    await test_choiceRequest_encryptedFlow();
    await test_permissionResponse_roundTrip();
    await test_choiceResponse_roundTrip();
    await test_chatWithPermissionRequestInterleaved();
    await test_mobileReconnect_thenPermissionRequest();
    await test_sessionQuery_withPermissionRequestConcurrent();
    await test_desktopReconnect_thenSendNotification();
    await test_multipleNotificationsRapidSequence();
    await test_threeElementsCompound();
  } catch (e) {
    console.error('测试异常:', e);
  }

  // 关闭服务器
  wss.close();

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