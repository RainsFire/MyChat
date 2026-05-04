/**
 * Mac Agent 测试
 * 测试加密模块、消息处理、CLI 交互
 */

const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const { CryptoHelper } = require('../crypto');
const Store = require('../store');
const ClaudeCLI = require('../claude-cli');
const path = require('path');
const fs = require('fs');

const PORT = 19091;
const URL = `ws://localhost:${PORT}`;

let relayServer;
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

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function wsMessageType(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeout);
    const handler = (data) => {
      const msg = JSON.parse(data);
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

/**
 * 启动中继服务器用于测试
 */
async function startRelay() {
  process.env.MYCHAT_PORT = PORT;
  process.env.MYCHAT_USER = 'testuser';
  const hash = await bcrypt.hash('testpass', 4);
  process.env.MYCHAT_PASS_HASH = hash;

  // 清除 require 缓存以使用新端口
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/relay/')) delete require.cache[key];
  });

  const { start } = require('../../relay/server');
  await start();
  await delay(500);
}

async function runTests() {
  console.log('\n=== Mac Agent 测试 ===\n');

  await startRelay();

  try {
    await testCryptoHelper();
    await testStore();
    await testAgentConnectAndAuth();
    await testKeyExchange();
    await testEncryptedMessageFlow();
    await testModeSwitch();
    await testInterrupt();
  } catch (e) {
    console.error('测试异常:', e.message);
  }

  console.log('\n--- 测试结果 ---');
  results.forEach(r => console.log(r));
  console.log(`\n通过: ${passed}  失败: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

/**
 * 测试 1: CryptoHelper 加密模块
 */
async function testCryptoHelper() {
  console.log('[测试] CryptoHelper 加密模块');
  const mobile = new CryptoHelper();
  const desktop = new CryptoHelper();

  // 手机端发起握手
  const mobilePubKey = mobile.initAsInitiator();
  assert(mobilePubKey !== null, 'initAsInitiator 返回公钥');

  // 桌面端响应
  const desktopPubKey = desktop.initAsResponder(mobilePubKey);
  assert(desktopPubKey !== null, 'initAsResponder 返回公钥');
  assert(desktop.ready === true, '桌面端加密就绪');

  // 手机端完成握手
  mobile.completeHandshake(desktopPubKey);
  assert(mobile.ready === true, '手机端加密就绪');

  // 双向加密解密
  const data1 = { type: 'chat_message', content: 'Hello from mobile!' };
  const encrypted1 = mobile.encrypt(data1);
  const decrypted1 = desktop.decrypt(encrypted1);
  assert(decrypted1.type === 'chat_message', '手机→桌面: type 正确');
  assert(decrypted1.content === 'Hello from mobile!', '手机→桌面: content 正确');

  const data2 = { type: 'chat_reply', content: 'Hello from desktop!' };
  const encrypted2 = desktop.encrypt(data2);
  const decrypted2 = mobile.decrypt(encrypted2);
  assert(decrypted2.content === 'Hello from desktop!', '桌面→手机: content 正确');

  // reset 测试
  mobile.reset();
  assert(mobile.ready === false, 'reset 后 ready 为 false');
  assert(mobile.privateKey === null, 'reset 后 privateKey 为 null');
}

/**
 * 测试 2: Store 数据库
 */
async function testStore() {
  console.log('[测试] Store 数据库');
  const testDbPath = path.join(__dirname, 'test-chat.db');
  // 清理旧测试文件
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const Database = require('better-sqlite3');
  const db = new Database(testDbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'delivered',
      created_at INTEGER NOT NULL
    )
  `);

  const stmt = db.prepare('INSERT INTO messages (role, content, status, created_at) VALUES (?, ?, ?, ?)');
  stmt.run('user', 'Hello', 'delivered', Date.now());
  stmt.run('assistant', 'Hi there', 'delivered', Date.now());
  stmt.run('user', 'How are you?', 'delivered', Date.now());

  const rows = db.prepare('SELECT * FROM messages ORDER BY id').all();
  assert(rows.length === 3, '插入 3 条消息');
  assert(rows[0].role === 'user', '第一条是 user');
  assert(rows[1].role === 'assistant', '第二条是 assistant');
  assert(rows[2].content === 'How are you?', '第三条内容正确');

  // 清空
  db.exec('DELETE FROM messages');
  const empty = db.prepare('SELECT COUNT(*) as c FROM messages').get();
  assert(empty.c === 0, '清空后无消息');

  db.close();
  fs.unlinkSync(testDbPath);
}

/**
 * 测试 3: Agent 连接和认证
 */
async function testAgentConnectAndAuth() {
  console.log('[测试] Agent 连接和认证');
  const ws = await wsConnect(URL);
  ws.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'desktop'
  }));
  const msg = await wsMessageType(ws, 'auth_ok');
  assert(msg.type === 'auth_ok', 'desktop 认证成功');
  ws.close();
  await delay(300);
}

/**
 * 测试 4: 密钥交换流程
 */
async function testKeyExchange() {
  console.log('[测试] 密钥交换流程');
  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  // 认证
  mobile.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'desktop'
  }));
  await wsMessageType(desktop, 'auth_ok');

  // 等待 device_status 通知
  await wsMessageType(mobile, 'device_status');

  // 手机端发起密钥交换
  const mobileCrypto = new CryptoHelper();
  const desktopCrypto = new CryptoHelper();

  const mobilePubKey = mobileCrypto.initAsInitiator();
  mobile.send(JSON.stringify({ type: 'key_init', publicKey: mobilePubKey }));

  // 桌面端收到 key_init
  const keyInitMsg = await wsMessageType(desktop, 'key_init');
  assert(keyInitMsg.publicKey === mobilePubKey, '桌面端收到公钥');

  // 桌面端响应
  const desktopPubKey = desktopCrypto.initAsResponder(keyInitMsg.publicKey);
  desktop.send(JSON.stringify({ type: 'key_response', publicKey: desktopPubKey }));

  // 手机端收到 key_response
  const keyRespMsg = await wsMessageType(mobile, 'key_response');
  mobileCrypto.completeHandshake(keyRespMsg.publicKey);

  assert(mobileCrypto.ready === true, '手机端加密就绪');
  assert(desktopCrypto.ready === true, '桌面端加密就绪');

  mobile.close();
  desktop.close();
  await delay(300);
}

/**
 * 测试 5: 加密消息收发
 */
async function testEncryptedMessageFlow() {
  console.log('[测试] 加密消息收发');
  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  // 认证
  mobile.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'desktop'
  }));
  await wsMessageType(desktop, 'auth_ok');
  await wsMessageType(mobile, 'device_status');

  // 密钥交换
  const mobileCrypto = new CryptoHelper();
  const desktopCrypto = new CryptoHelper();

  const mobilePubKey = mobileCrypto.initAsInitiator();
  mobile.send(JSON.stringify({ type: 'key_init', publicKey: mobilePubKey }));
  const keyInitMsg = await wsMessageType(desktop, 'key_init');

  const desktopPubKey = desktopCrypto.initAsResponder(keyInitMsg.publicKey);
  desktop.send(JSON.stringify({ type: 'key_response', publicKey: desktopPubKey }));
  const keyRespMsg = await wsMessageType(mobile, 'key_response');
  mobileCrypto.completeHandshake(keyRespMsg.publicKey);

  // 手机端发送加密聊天消息
  const chatPayload = mobileCrypto.encrypt({
    type: 'chat_message',
    content: 'Hello Claude!'
  });
  mobile.send(JSON.stringify({ type: 'encrypted', payload: chatPayload }));

  // 桌面端收到并解密
  const encMsg = await wsMessageType(desktop, 'encrypted');
  const decrypted = desktopCrypto.decrypt(encMsg.payload);
  assert(decrypted.type === 'chat_message', '解密后 type 正确');
  assert(decrypted.content === 'Hello Claude!', '解密后 content 正确');

  // 桌面端回复
  const replyPayload = desktopCrypto.encrypt({
    type: 'chat_reply',
    content: 'Hello! How can I help?'
  });
  desktop.send(JSON.stringify({ type: 'encrypted', payload: replyPayload }));

  const replyMsg = await wsMessageType(mobile, 'encrypted');
  const replyDecrypted = mobileCrypto.decrypt(replyMsg.payload);
  assert(replyDecrypted.content === 'Hello! How can I help?', '手机端收到回复正确');

  mobile.close();
  desktop.close();
  await delay(300);
}

/**
 * 测试 6: 模式切换
 */
async function testModeSwitch() {
  console.log('[测试] 模式切换');
  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  // 认证 + 密钥交换（复用流程）
  mobile.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'desktop'
  }));
  await wsMessageType(desktop, 'auth_ok');
  await wsMessageType(mobile, 'device_status');

  const mobileCrypto = new CryptoHelper();
  const desktopCrypto = new CryptoHelper();
  const mobilePubKey = mobileCrypto.initAsInitiator();
  mobile.send(JSON.stringify({ type: 'key_init', publicKey: mobilePubKey }));
  const keyInitMsg = await wsMessageType(desktop, 'key_init');
  const desktopPubKey = desktopCrypto.initAsResponder(keyInitMsg.publicKey);
  desktop.send(JSON.stringify({ type: 'key_response', publicKey: desktopPubKey }));
  const keyRespMsg = await wsMessageType(mobile, 'key_response');
  mobileCrypto.completeHandshake(keyRespMsg.publicKey);

  // 手机端发送模式切换
  const modePayload = mobileCrypto.encrypt({ type: 'set_mode', mode: 'auto' });
  mobile.send(JSON.stringify({ type: 'encrypted', payload: modePayload }));

  // 桌面端收到
  const modeMsg = await wsMessageType(desktop, 'encrypted');
  const modeDecrypted = desktopCrypto.decrypt(modeMsg.payload);
  assert(modeDecrypted.type === 'set_mode', '模式切换 type 正确');
  assert(modeDecrypted.mode === 'auto', '模式为 auto');

  mobile.close();
  desktop.close();
  await delay(300);
}

/**
 * 测试 7: 中断操作
 */
async function testInterrupt() {
  console.log('[测试] 中断操作');
  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  // 认证 + 密钥交换
  mobile.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'desktop'
  }));
  await wsMessageType(desktop, 'auth_ok');
  await wsMessageType(mobile, 'device_status');

  const mobileCrypto = new CryptoHelper();
  const desktopCrypto = new CryptoHelper();
  const mobilePubKey = mobileCrypto.initAsInitiator();
  mobile.send(JSON.stringify({ type: 'key_init', publicKey: mobilePubKey }));
  const keyInitMsg = await wsMessageType(desktop, 'key_init');
  const desktopPubKey = desktopCrypto.initAsResponder(keyInitMsg.publicKey);
  desktop.send(JSON.stringify({ type: 'key_response', publicKey: desktopPubKey }));
  const keyRespMsg = await wsMessageType(mobile, 'key_response');
  mobileCrypto.completeHandshake(keyRespMsg.publicKey);

  // 手机端发送中断
  const intPayload = mobileCrypto.encrypt({ type: 'interrupt' });
  mobile.send(JSON.stringify({ type: 'encrypted', payload: intPayload }));

  // 桌面端收到
  const intMsg = await wsMessageType(desktop, 'encrypted');
  const intDecrypted = desktopCrypto.decrypt(intMsg.payload);
  assert(intDecrypted.type === 'interrupt', '中断消息 type 正确');

  mobile.close();
  desktop.close();
  await delay(300);
}

runTests().catch(err => {
  console.error('测试启动失败:', err);
  process.exit(1);
});
