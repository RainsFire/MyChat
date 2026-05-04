/**
 * 端到端集成测试
 * 模拟完整消息流: 手机 → 中继 → Mac agent
 * 验证加密、认证、转发、模式切换、中断等完整流程
 */

const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const { CryptoHelper } = require('../../agent/crypto');

const PORT = 19092;
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

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function wsMessageType(ws, type, timeout = 8000) {
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

async function startRelay() {
  process.env.MYCHAT_PORT = PORT;
  process.env.MYCHAT_USER = 'e2euser';
  const hash = await bcrypt.hash('e2epass', 4);
  process.env.MYCHAT_PASS_HASH = hash;

  Object.keys(require.cache).forEach(key => {
    if (key.includes('/relay/')) delete require.cache[key];
  });

  const { start } = require('../../relay/server');
  await start();
  await delay(500);
}

/**
 * 完整认证+密钥交换+加密消息流程
 */
async function testFullEncryptedFlow() {
  console.log('[测试] 完整加密消息流');

  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  // 认证
  mobile.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'desktop'
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

  assert(mobileCrypto.ready === true, '手机端加密就绪');
  assert(desktopCrypto.ready === true, '桌面端加密就绪');

  // 手机发送加密聊天消息
  const chatPayload = mobileCrypto.encrypt({ type: 'chat_message', content: 'Hello from phone!' });
  mobile.send(JSON.stringify({ type: 'encrypted', payload: chatPayload }));

  // 桌面端收到并解密
  const encMsg = await wsMessageType(desktop, 'encrypted');
  const decrypted = desktopCrypto.decrypt(encMsg.payload);
  assert(decrypted.type === 'chat_message', '解密后 type 正确');
  assert(decrypted.content === 'Hello from phone!', '解密后 content 正确');

  // 桌面端回复
  const replyPayload = desktopCrypto.encrypt({ type: 'chat_reply', content: 'Hello from Mac!' });
  desktop.send(JSON.stringify({ type: 'encrypted', payload: replyPayload }));

  const replyMsg = await wsMessageType(mobile, 'encrypted');
  const replyDecrypted = mobileCrypto.decrypt(replyMsg.payload);
  assert(replyDecrypted.content === 'Hello from Mac!', '手机端收到回复正确');

  // 桌面端发送 chat_complete
  const completePayload = desktopCrypto.encrypt({ type: 'chat_complete' });
  desktop.send(JSON.stringify({ type: 'encrypted', payload: completePayload }));

  const completeMsg = await wsMessageType(mobile, 'encrypted');
  const completeDecrypted = mobileCrypto.decrypt(completeMsg.payload);
  assert(completeDecrypted.type === 'chat_complete', '手机端收到 chat_complete');

  mobile.close();
  desktop.close();
  await delay(500);
}

/**
 * 模式切换流程
 */
async function testModeSwitch() {
  console.log('[测试] 模式切换流程');

  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  mobile.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'desktop'
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

  // 切换到 auto 模式
  const modePayload = mobileCrypto.encrypt({ type: 'set_mode', mode: 'auto' });
  mobile.send(JSON.stringify({ type: 'encrypted', payload: modePayload }));

  const modeMsg = await wsMessageType(desktop, 'encrypted');
  const modeDecrypted = desktopCrypto.decrypt(modeMsg.payload);
  assert(modeDecrypted.type === 'set_mode', '模式切换 type 正确');
  assert(modeDecrypted.mode === 'auto', '模式为 auto');

  // 桌面端确认模式切换
  const confirmPayload = desktopCrypto.encrypt({ type: 'mode_changed', mode: 'auto' });
  desktop.send(JSON.stringify({ type: 'encrypted', payload: confirmPayload }));

  const confirmMsg = await wsMessageType(mobile, 'encrypted');
  const confirmDecrypted = mobileCrypto.decrypt(confirmMsg.payload);
  assert(confirmDecrypted.type === 'mode_changed', '模式确认 type 正确');
  assert(confirmDecrypted.mode === 'auto', '确认模式为 auto');

  mobile.close();
  desktop.close();
  await delay(500);
}

/**
 * 权限审批流程
 */
async function testPermissionFlow() {
  console.log('[测试] 权限审批流程');

  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  mobile.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'desktop'
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

  // 桌面端发送权限请求
  const permPayload = desktopCrypto.encrypt({
    type: 'permission_request',
    action: 'execute_command',
    details: 'npm install express'
  });
  desktop.send(JSON.stringify({ type: 'encrypted', payload: permPayload }));

  const permMsg = await wsMessageType(mobile, 'encrypted');
  const permDecrypted = mobileCrypto.decrypt(permMsg.payload);
  assert(permDecrypted.type === 'permission_request', '权限请求 type 正确');
  assert(permDecrypted.action === 'execute_command', '权限请求 action 正确');

  // 手机端批准
  const approvePayload = mobileCrypto.encrypt({ type: 'permission_response', response: 'approve' });
  mobile.send(JSON.stringify({ type: 'encrypted', payload: approvePayload }));

  const approveMsg = await wsMessageType(desktop, 'encrypted');
  const approveDecrypted = desktopCrypto.decrypt(approveMsg.payload);
  assert(approveDecrypted.type === 'permission_response', '权限响应 type 正确');
  assert(approveDecrypted.response === 'approve', '权限已批准');

  mobile.close();
  desktop.close();
  await delay(500);
}

/**
 * 中断操作流程
 */
async function testInterruptFlow() {
  console.log('[测试] 中断操作流程');

  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  mobile.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'desktop'
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

  const intMsg = await wsMessageType(desktop, 'encrypted');
  const intDecrypted = desktopCrypto.decrypt(intMsg.payload);
  assert(intDecrypted.type === 'interrupt', '中断消息 type 正确');

  mobile.close();
  desktop.close();
  await delay(500);
}

/**
 * 选择流程
 */
async function testChoiceFlow() {
  console.log('[测试] 选择流程');

  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  mobile.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'desktop'
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

  // 桌面端发送选择请求
  const choicePayload = desktopCrypto.encrypt({
    type: 'choice_request',
    options: ['选项A', '选项B', '选项C']
  });
  desktop.send(JSON.stringify({ type: 'encrypted', payload: choicePayload }));

  const choiceMsg = await wsMessageType(mobile, 'encrypted');
  const choiceDecrypted = mobileCrypto.decrypt(choiceMsg.payload);
  assert(choiceDecrypted.type === 'choice_request', '选择请求 type 正确');
  assert(choiceDecrypted.options.length === 3, '选项数量为 3');

  // 手机端选择第 2 项
  const selPayload = mobileCrypto.encrypt({ type: 'choice_response', selected: 1 });
  mobile.send(JSON.stringify({ type: 'encrypted', payload: selPayload }));

  const selMsg = await wsMessageType(desktop, 'encrypted');
  const selDecrypted = desktopCrypto.decrypt(selMsg.payload);
  assert(selDecrypted.type === 'choice_response', '选择响应 type 正确');
  assert(selDecrypted.selected === 1, '选择了第 2 项');

  mobile.close();
  desktop.close();
  await delay(500);
}

/**
 * 设备离线通知
 */
async function testOfflineNotification() {
  console.log('[测试] 设备离线通知');

  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  mobile.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  desktop.send(JSON.stringify({
    type: 'auth', username: 'e2euser', password: 'e2epass', device: 'desktop'
  }));
  await wsMessageType(desktop, 'auth_ok');
  await wsMessageType(mobile, 'device_status');

  // desktop 下线，mobile 收到通知
  const offlinePromise = wsMessageType(mobile, 'device_status');
  desktop.close();
  const offlineMsg = await offlinePromise;
  assert(offlineMsg.device === 'desktop', '离线设备为 desktop');
  assert(offlineMsg.online === false, '状态为离线');

  mobile.close();
  await delay(500);
}

async function runTests() {
  console.log('\n=== 端到端集成测试 ===\n');

  await startRelay();

  try {
    await testFullEncryptedFlow();
    await testModeSwitch();
    await testPermissionFlow();
    await testInterruptFlow();
    await testChoiceFlow();
    await testOfflineNotification();
  } catch (e) {
    console.error('测试异常:', e.message);
  }

  console.log('\n--- 测试结果 ---');
  results.forEach(r => console.log(r));
  console.log(`\n通过: ${passed}  失败: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('测试启动失败:', err);
  process.exit(1);
});