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
// 场景 11: image_message 加密转发完整流程
// =====================================================

async function test_imageMessage_encryptedFlow() {
  console.log('[测试] 场景11: image_message 加密转发完整流程');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  const fakeBase64 = Buffer.from('fake-image-data-for-testing').toString('base64');
  encryptSend(mobile, mobileCrypto, {
    type: 'image_message',
    imageBase64: fakeBase64,
    text: '请分析这张图片'
  });

  const received = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(received.type === 'image_message', '场景11: desktop 收到 image_message');
  assert(received.imageBase64 === fakeBase64, '场景11: imageBase64 完整无损');
  assert(received.text === '请分析这张图片', '场景11: text 正确');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 12: image_ack 确认回传
// =====================================================

async function test_imageAck_roundTrip() {
  console.log('[测试] 场景12: image_ack 确认回传');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  const fakeBase64 = Buffer.from('test-image').toString('base64');
  encryptSend(mobile, mobileCrypto, {
    type: 'image_message',
    imageBase64: fakeBase64,
    text: ''
  });

  const imgMsg = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(imgMsg.type === 'image_message', '场景12: desktop 收到 image_message');

  encryptSend(desktop, desktopCrypto, { type: 'image_ack', success: true });

  const ack = await decryptNext(mobile, mobileCrypto, 'encrypted');
  assert(ack.type === 'image_ack', '场景12: mobile 收到 image_ack');
  assert(ack.success === true, '场景12: success 为 true');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 13: image_message 与 chat_message 交错
// =====================================================

async function test_imageAndChat_interleaved() {
  console.log('[测试] 场景13: image_message 与 chat_message 交错');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  const fakeBase64 = Buffer.from('interleaved-image').toString('base64');

  encryptSend(mobile, mobileCrypto, { type: 'chat_message', content: '第一条文本' });
  encryptSend(mobile, mobileCrypto, { type: 'image_message', imageBase64: fakeBase64, text: '第二张图' });
  encryptSend(mobile, mobileCrypto, { type: 'chat_message', content: '第三条文本' });

  const msgs = [];
  for (let i = 0; i < 3; i++) {
    msgs.push(await decryptNext(desktop, desktopCrypto, 'encrypted'));
  }

  assert(msgs[0].type === 'chat_message' && msgs[0].content === '第一条文本', '场景13: 第一条 chat_message 正确');
  assert(msgs[1].type === 'image_message' && msgs[1].text === '第二张图', '场景13: image_message 正确');
  assert(msgs[2].type === 'chat_message' && msgs[2].content === '第三条文本', '场景13: 第三条 chat_message 正确');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 14: 纯图片无文字
// =====================================================

async function test_imageMessage_noText() {
  console.log('[测试] 场景14: 纯图片无文字');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  const fakeBase64 = Buffer.from('image-no-text').toString('base64');
  encryptSend(mobile, mobileCrypto, {
    type: 'image_message',
    imageBase64: fakeBase64,
    text: ''
  });

  const received = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(received.type === 'image_message', '场景14: desktop 收到 image_message');
  assert(received.text === '', '场景14: text 为空字符串');
  assert(received.imageBase64 === fakeBase64, '场景14: base64 完整');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 15: 超大 base64 (>5MB 模拟)
// =====================================================

async function test_imageMessage_largeBase64() {
  console.log('[测试] 场景15: 超大 base64 (>5MB 模拟)');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  const largeData = 'A'.repeat(6 * 1024 * 1024);
  const largeBase64 = Buffer.from(largeData).toString('base64');

  encryptSend(mobile, mobileCrypto, {
    type: 'image_message',
    imageBase64: largeBase64,
    text: '大图测试'
  });

  const received = await decryptNext(desktop, desktopCrypto, 'encrypted', 10000);
  assert(received.type === 'image_message', '场景15: desktop 收到 image_message');
  assert(received.imageBase64 === largeBase64, '场景15: 大数据完整无损');
  assert(received.imageBase64.length === largeBase64.length, '场景15: 长度一致');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 16: mobile 重连后发图片
// =====================================================

async function test_mobileReconnect_thenSendImage() {
  console.log('[测试] 场景16: mobile 重连后发图片');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto: crypto1, desktopCrypto: dCrypto1 } = await doKeyExchange(mobile, desktop);
  await delay(100);

  mobile.close();
  await delay(300);

  const mobile2 = await wsConnect();
  await auth(mobile2, 'mobile');
  await delay(100);

  await nextMsg(desktop, 'device_status', 2000);

  const { mobileCrypto: crypto2, desktopCrypto: dCrypto2 } = await doKeyExchange(mobile2, desktop);
  await delay(100);

  const fakeBase64 = Buffer.from('reconnect-image').toString('base64');
  encryptSend(mobile2, crypto2, {
    type: 'image_message',
    imageBase64: fakeBase64,
    text: '重连后发的图'
  });

  const received = await decryptNext(desktop, dCrypto2, 'encrypted');
  assert(received.type === 'image_message', '场景16: 重连后 desktop 收到 image_message');
  assert(received.imageBase64 === fakeBase64, '场景16: base64 完整');

  mobile2.close();
  desktop.close();
}

// =====================================================
// 场景 17: 快速连续多张图片
// =====================================================

async function test_multipleImages_rapidSequence() {
  console.log('[测试] 场景17: 快速连续多张图片');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  const images = [];
  for (let i = 0; i < 5; i++) {
    const b64 = Buffer.from(`image-${i}`).toString('base64');
    images.push(b64);
    encryptSend(mobile, mobileCrypto, {
      type: 'image_message',
      imageBase64: b64,
      text: `第${i + 1}张`
    });
  }

  for (let i = 0; i < 5; i++) {
    const msg = await decryptNext(desktop, desktopCrypto, 'encrypted');
    assert(msg.type === 'image_message', `场景17: 第${i + 1}张类型正确`);
    assert(msg.imageBase64 === images[i], `场景17: 第${i + 1}张数据正确`);
  }

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 18: chat + image + permission 三重并发
// =====================================================

async function test_chatImagePermission_concurrent() {
  console.log('[测试] 场景18: chat + image + permission 三重并发');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  const fakeBase64 = Buffer.from('concurrent-img').toString('base64');

  encryptSend(mobile, mobileCrypto, { type: 'chat_message', content: '文本消息' });
  encryptSend(mobile, mobileCrypto, { type: 'image_message', imageBase64: fakeBase64, text: '图片消息' });
  encryptSend(desktop, desktopCrypto, { type: 'chat_reply', content: '回复' });
  encryptSend(desktop, desktopCrypto, { type: 'permission_request', action: 'read', details: 'file.txt' });
  encryptSend(desktop, desktopCrypto, { type: 'image_ack', success: true });

  const msg1 = await decryptNext(desktop, desktopCrypto, 'encrypted');
  const msg2 = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(msg1.type === 'chat_message', '场景18: desktop 收到 chat_message');
  assert(msg2.type === 'image_message', '场景18: desktop 收到 image_message');

  const msgs = [];
  for (let i = 0; i < 3; i++) {
    msgs.push(await decryptNext(mobile, mobileCrypto, 'encrypted'));
  }
  const types = msgs.map(m => m.type);
  assert(types.includes('chat_reply'), '场景18: mobile 收到 chat_reply');
  assert(types.includes('permission_request'), '场景18: mobile 收到 permission_request');
  assert(types.includes('image_ack'), '场景18: mobile 收到 image_ack');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 19: desktop 重连后发送 image_ack
// =====================================================

async function test_desktopReconnect_thenImageAck() {
  console.log('[测试] 场景19: desktop 重连后发送 image_ack');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto: mCrypto1, desktopCrypto: dCrypto1 } = await doKeyExchange(mobile, desktop);
  await delay(100);

  await nextMsg(mobile, 'device_status', 2000);

  desktop.close();
  await delay(300);

  await nextMsg(mobile, 'device_status', 2000);

  const desktop2 = await wsConnect();
  await auth(desktop2, 'desktop');
  await delay(100);

  await nextMsg(mobile, 'device_status', 2000);

  const { mobileCrypto: mCrypto2, desktopCrypto: dCrypto2 } = await doKeyExchange(mobile, desktop2);
  await delay(100);

  const fakeBase64 = Buffer.from('after-reconnect').toString('base64');
  encryptSend(mobile, mCrypto2, {
    type: 'image_message',
    imageBase64: fakeBase64,
    text: '重连后测试'
  });

  const imgMsg = await decryptNext(desktop2, dCrypto2, 'encrypted');
  assert(imgMsg.type === 'image_message', '场景19: desktop 重连后收到 image_message');

  encryptSend(desktop2, dCrypto2, { type: 'image_ack', success: true });
  const ack = await decryptNext(mobile, mCrypto2, 'encrypted');
  assert(ack.type === 'image_ack' && ack.success === true, '场景19: mobile 收到 image_ack');

  mobile.close();
  desktop2.close();
}

// =====================================================
// 场景 11: image_message 加密转发
// =====================================================

async function test_imageMessage_encryptedFlow() {
  console.log('[测试] 场景11: image_message 加密转发');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // 生成模拟 base64 图片数据（1x1 JPEG 最小合法数据）
  const fakeBase64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

  encryptSend(mobile, mobileCrypto, {
    type: 'image_message',
    imageBase64: fakeBase64,
    text: '这是什么图片？'
  });

  const received = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(received.type === 'image_message', '场景11: desktop 收到 image_message');
  assert(received.imageBase64 === fakeBase64, '场景11: imageBase64 完整无损');
  assert(received.text === '这是什么图片？', '场景11: text 正确');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 12: image_message 纯图片无文字
// =====================================================

async function test_imageMessage_noText() {
  console.log('[测试] 场景12: image_message 纯图片无文字');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  const fakeBase64 = 'dGVzdF9pbWFnZV9iYXNlNjQ=';
  encryptSend(mobile, mobileCrypto, {
    type: 'image_message',
    imageBase64: fakeBase64,
    text: ''
  });

  const received = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(received.type === 'image_message', '场景12: desktop 收到 image_message');
  assert(received.text === '', '场景12: text 为空不崩溃');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 13: image_message 与 chat_message 交错
// =====================================================

async function test_imageMessage_interleavedWithChat() {
  console.log('[测试] 场景13: image_message 与 chat_message 交错');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  encryptSend(mobile, mobileCrypto, { type: 'chat_message', content: '你好' });
  encryptSend(mobile, mobileCrypto, { type: 'image_message', imageBase64: 'aW1hZ2U=', text: '看这个' });
  encryptSend(mobile, mobileCrypto, { type: 'chat_message', content: '分析一下' });

  const msg1 = await decryptNext(desktop, desktopCrypto, 'encrypted');
  const msg2 = await decryptNext(desktop, desktopCrypto, 'encrypted');
  const msg3 = await decryptNext(desktop, desktopCrypto, 'encrypted');

  assert(msg1.type === 'chat_message', '场景13: 第1条是 chat_message');
  assert(msg2.type === 'image_message', '场景13: 第2条是 image_message');
  assert(msg2.imageBase64 === 'aW1hZ2U=', '场景13: imageBase64 正确');
  assert(msg3.type === 'chat_message', '场景13: 第3条是 chat_message');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 14: 大体积 image_message (>1MB base64)
// =====================================================

async function test_imageMessage_largePayload() {
  console.log('[测试] 场景14: 大体积 image_message (>1MB base64)');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // 生成约 1.5MB 的 base64 数据
  const largeBase64 = 'A'.repeat(1.5 * 1024 * 1024);
  encryptSend(mobile, mobileCrypto, {
    type: 'image_message',
    imageBase64: largeBase64,
    text: '大图测试'
  });

  const received = await decryptNext(desktop, desktopCrypto, 'encrypted', 10000);
  assert(received.type === 'image_message', '场景14: desktop 收到大体积 image_message');
  assert(received.imageBase64.length === largeBase64.length, '场景14: base64 长度一致，无截断');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 15: image_message mobile 重连后发送
// =====================================================

async function test_imageMessage_afterReconnect() {
  console.log('[测试] 场景15: image_message mobile 重连后发送');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto: crypto1, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // 先发一条普通消息
  encryptSend(mobile, crypto1, { type: 'chat_message', content: '第一条消息' });
  await decryptNext(desktop, desktopCrypto, 'encrypted');

  // Mobile 断开重连
  mobile.close();
  await delay(300);

  const mobile2 = await wsConnect();
  await auth(mobile2, 'mobile');
  await nextMsg(desktop, 'device_status', 2000);

  const { mobileCrypto: crypto2, desktopCrypto: desktopCrypto2 } = await doKeyExchange(mobile2, desktop);
  await delay(100);

  // 重连后发图片
  encryptSend(mobile2, crypto2, {
    type: 'image_message',
    imageBase64: 'cmVjb25uZWN0X2ltYWdl',
    text: '重连后发的图'
  });

  const received = await decryptNext(desktop, desktopCrypto2, 'encrypted');
  assert(received.type === 'image_message', '场景15: 重连后 desktop 收到 image_message');
  assert(received.text === '重连后发的图', '场景15: text 正确');

  mobile2.close();
  desktop.close();
}

// =====================================================
// 场景 16: image_ack 回传确认
// =====================================================

async function test_imageAck_roundTrip() {
  console.log('[测试] 场景16: image_ack 回传确认');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  // Desktop 发送 image_ack
  encryptSend(desktop, desktopCrypto, { type: 'image_ack', success: true });

  const received = await decryptNext(mobile, mobileCrypto, 'encrypted');
  assert(received.type === 'image_ack', '场景16: mobile 收到 image_ack');
  assert(received.success === true, '场景16: success 为 true');

  // 测试失败 ack
  encryptSend(desktop, desktopCrypto, { type: 'image_ack', success: false });
  const received2 = await decryptNext(mobile, mobileCrypto, 'encrypted');
  assert(received2.type === 'image_ack', '场景16: mobile 收到失败 image_ack');
  assert(received2.success === false, '场景16: success 为 false');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 17: 连续多张图片
// =====================================================

async function test_imageMessage_multipleImages() {
  console.log('[测试] 场景17: 连续多张图片');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  for (let i = 0; i < 3; i++) {
    encryptSend(mobile, mobileCrypto, {
      type: 'image_message',
      imageBase64: `aW1hZ2Vf${i}`,
      text: `图片${i + 1}`
    });
  }

  for (let i = 0; i < 3; i++) {
    const received = await decryptNext(desktop, desktopCrypto, 'encrypted');
    assert(received.type === 'image_message', `场景17: 第${i + 1}张图片收到`);
    assert(received.text === `图片${i + 1}`, `场景17: 第${i + 1}张 text 正确`);
  }

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 18: chat + image + permission 三重并发
// =====================================================

async function test_chatImagePermission_concurrent() {
  console.log('[测试] 场景18: chat + image + permission 三重并发');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  await delay(100);

  const fakeBase64 = Buffer.from('concurrent-img').toString('base64');

  encryptSend(mobile, mobileCrypto, { type: 'chat_message', content: '文本消息' });
  encryptSend(mobile, mobileCrypto, { type: 'image_message', imageBase64: fakeBase64, text: '图片消息' });
  encryptSend(desktop, desktopCrypto, { type: 'chat_reply', content: '回复' });
  encryptSend(desktop, desktopCrypto, { type: 'permission_request', action: 'read', details: 'file.txt' });
  encryptSend(desktop, desktopCrypto, { type: 'image_ack', success: true });

  const msg1 = await decryptNext(desktop, desktopCrypto, 'encrypted');
  const msg2 = await decryptNext(desktop, desktopCrypto, 'encrypted');
  assert(msg1.type === 'chat_message', '场景18: desktop 收到 chat_message');
  assert(msg2.type === 'image_message', '场景18: desktop 收到 image_message');

  const msgs = [];
  for (let i = 0; i < 3; i++) {
    msgs.push(await decryptNext(mobile, mobileCrypto, 'encrypted'));
  }
  const types = msgs.map(m => m.type);
  assert(types.includes('chat_reply'), '场景18: mobile 收到 chat_reply');
  assert(types.includes('permission_request'), '场景18: mobile 收到 permission_request');
  assert(types.includes('image_ack'), '场景18: mobile 收到 image_ack');

  mobile.close();
  desktop.close();
}

// =====================================================
// 场景 19: desktop 重连后发送 image_ack
// =====================================================

async function test_desktopReconnect_thenImageAck() {
  console.log('[测试] 场景19: desktop 重连后发送 image_ack');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');

  const { mobileCrypto: mCrypto1, desktopCrypto: dCrypto1 } = await doKeyExchange(mobile, desktop);
  await delay(100);

  await nextMsg(mobile, 'device_status', 2000);

  desktop.close();
  await delay(300);

  await nextMsg(mobile, 'device_status', 2000);

  const desktop2 = await wsConnect();
  await auth(desktop2, 'desktop');
  await delay(100);

  await nextMsg(mobile, 'device_status', 2000);

  const { mobileCrypto: mCrypto2, desktopCrypto: dCrypto2 } = await doKeyExchange(mobile, desktop2);
  await delay(100);

  const fakeBase64 = Buffer.from('after-reconnect').toString('base64');
  encryptSend(mobile, mCrypto2, {
    type: 'image_message',
    imageBase64: fakeBase64,
    text: '重连后测试'
  });

  const imgMsg = await decryptNext(desktop2, dCrypto2, 'encrypted');
  assert(imgMsg.type === 'image_message', '场景19: desktop 重连后收到 image_message');

  encryptSend(desktop2, dCrypto2, { type: 'image_ack', success: true });
  const ack = await decryptNext(mobile, mCrypto2, 'encrypted');
  assert(ack.type === 'image_ack' && ack.success === true, '场景19: mobile 收到 image_ack');

  mobile.close();
  desktop2.close();
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
    // 图片识别测试
    await test_imageMessage_encryptedFlow();
    await test_imageMessage_noText();
    await test_imageMessage_interleavedWithChat();
    await test_imageMessage_largePayload();
    await test_imageMessage_afterReconnect();
    await test_imageAck_roundTrip();
    await test_imageMessage_multipleImages();
    await test_chatImagePermission_concurrent();
    await test_desktopReconnect_thenImageAck();
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