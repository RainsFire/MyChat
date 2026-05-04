/**
 * 中继服务器测试
 * 测试认证、消息转发、心跳、设备状态
 */

const WebSocket = require('ws');
const bcrypt = require('bcrypt');

const PORT = 19090; // 测试端口
const URL = `ws://localhost:${PORT}`;

let server;
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

function wsMessage(ws, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('消息超时')), timeout);
    const handler = (data) => {
      clearTimeout(timer);
      ws.removeListener('message', handler);
      resolve(JSON.parse(data));
    };
    ws.on('message', handler);
  });
}

/**
 * 等待特定类型的消息
 */
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

async function runTests() {
  console.log('\n=== 中继服务器测试 ===\n');

  // 启动测试服务器
  process.env.MYCHAT_PORT = PORT;
  process.env.MYCHAT_USER = 'testuser';
  const hash = await bcrypt.hash('testpass', 4);
  process.env.MYCHAT_PASS_HASH = hash;

  const { start, auth, router } = require('../server');
  server = await new Promise((resolve) => {
    const http = require('http');
    const { wss } = require('../server');
    // 直接启动
    start().then(() => resolve(true));
  });

  await delay(500);

  try {
    await testHealthCheck();
    await testAuthSuccess();
    await testAuthFailure();
    await testAuthTimeout();
    await testMessageForward();
    await testDeviceStatus();
    await delay(500);
    await testQueryDeviceStatus();
    await delay(300);
    await testOfflineForward();
    await testCrypto();
    await testHeartbeat();
  } catch (e) {
    console.error('测试异常:', e.message);
  }

  // 输出结果
  console.log('\n--- 测试结果 ---');
  results.forEach(r => console.log(r));
  console.log(`\n通过: ${passed}  失败: ${failed}`);

  // 关闭服务器
  process.exit(failed > 0 ? 1 : 0);
}

/**
 * 测试 1: 健康检查
 */
async function testHealthCheck() {
  console.log('[测试] 健康检查');
  const http = require('http');
  const res = await new Promise((resolve) => {
    http.get(`http://localhost:${PORT}/health`, resolve);
  });
  const body = await new Promise((resolve) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(JSON.parse(data)));
  });
  assert(body.status === 'ok', '健康检查返回 ok');
  assert(typeof body.time === 'number', '健康检查返回时间戳');
}

/**
 * 测试 2: 认证成功
 */
async function testAuthSuccess() {
  console.log('[测试] 认证成功');
  const ws = await wsConnect(URL);
  ws.send(JSON.stringify({
    type: 'auth',
    username: 'testuser',
    password: 'testpass',
    device: 'mobile'
  }));
  const msg = await wsMessageType(ws, 'auth_ok');
  assert(msg.type === 'auth_ok', '认证成功返回 auth_ok');
  ws.close();
}

/**
 * 测试 3: 认证失败
 */
async function testAuthFailure() {
  console.log('[测试] 认证失败');
  const ws = await wsConnect(URL);
  ws.send(JSON.stringify({
    type: 'auth',
    username: 'testuser',
    password: 'wrongpass',
    device: 'mobile'
  }));
  const msg = await wsMessageType(ws, 'auth_fail');
  assert(msg.type === 'auth_fail', '认证失败返回 auth_fail');
  assert(msg.reason === '用户名或密码错误', '返回错误原因');
  ws.close();
}

/**
 * 测试 4: 认证超时
 */
async function testAuthTimeout() {
  console.log('[测试] 认证超时');
  const ws = await wsConnect(URL);
  // 不发送 auth，等待超时
  await delay(11000);
  assert(ws.readyState !== 1, '认证超时后连接关闭');
  ws.close();
}

/**
 * 测试 5: 消息转发
 */
async function testMessageForward() {
  console.log('[测试] 消息转发');
  const mobile = await wsConnect(URL);
  const desktop = await wsConnect(URL);

  // 认证手机端
  mobile.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile'
  }));
  const mobileAuth = await wsMessageType(mobile, 'auth_ok');
  assert(mobileAuth.type === 'auth_ok', '手机认证成功');

  // 认证桌面端
  desktop.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'desktop'
  }));
  const desktopAuth = await wsMessageType(desktop, 'auth_ok');
  assert(desktopAuth.type === 'auth_ok', '桌面端认证成功');

  // 等待手机收到 desktop online 通知
  await wsMessageType(mobile, 'device_status');

  // 手机发送加密消息
  mobile.send(JSON.stringify({
    type: 'encrypted',
    payload: 'test_payload_data'
  }));

  const received = await wsMessageType(desktop, 'encrypted');
  assert(received.type === 'encrypted', '桌面端收到 encrypted 消息');
  assert(received.payload === 'test_payload_data', 'payload 内容正确');

  // 桌面端回复
  desktop.send(JSON.stringify({
    type: 'encrypted',
    payload: 'reply_data'
  }));

  const reply = await wsMessageType(mobile, 'encrypted');
  assert(reply.type === 'encrypted', '手机端收到回复');
  assert(reply.payload === 'reply_data', '回复内容正确');

  mobile.close();
  desktop.close();
  await delay(300); // 等待连接清理
}

/**
 * 测试 6: 设备状态通知
 */
async function testDeviceStatus() {
  console.log('[测试] 设备状态通知');
  const mobile = await wsConnect(URL);
  mobile.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  // 桌面端上线
  const desktop = await wsConnect(URL);
  desktop.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'desktop'
  }));
  await wsMessageType(desktop, 'auth_ok');

  const statusMsg = await wsMessageType(mobile, 'device_status');
  assert(statusMsg.device === 'desktop', '设备类型为 desktop');
  assert(statusMsg.online === true, '状态为 online');

  // 先注册监听，再关闭桌面端
  const offlinePromise = wsMessageType(mobile, 'device_status');
  desktop.close();
  const offlineMsg = await offlinePromise;
  assert(offlineMsg.online === false, '状态为 offline');

  mobile.close();
  desktop.close && void 0;
  await delay(500); // 等待连接清理完成
}

/**
 * 测试 7: 查询设备状态
 */
async function testQueryDeviceStatus() {
  console.log('[测试] 查询设备状态');
  const mobile = await wsConnect(URL);
  mobile.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  // 查询 desktop 状态（离线）
  mobile.send(JSON.stringify({ type: 'query_device_status' }));
  const status = await wsMessageType(mobile, 'device_status');
  assert(status.device === 'desktop', '返回 desktop 状态');
  assert(status.online === false, 'desktop 离线');

  mobile.close();
}

/**
 * 测试 8: 对端离线时转发失败
 */
async function testOfflineForward() {
  console.log('[测试] 对端离线转发');
  const mobile = await wsConnect(URL);
  mobile.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile'
  }));
  await wsMessageType(mobile, 'auth_ok');

  // 发送消息但 desktop 不在线
  mobile.send(JSON.stringify({
    type: 'encrypted',
    payload: 'offline_msg'
  }));

  const msg = await wsMessageType(mobile, 'device_status');
  assert(msg.online === false, 'desktop 不在线');

  mobile.close();
}

/**
 * 测试 9: 加密模块
 */
async function testCrypto() {
  console.log('[测试] 加密模块');
  const { CryptoHelper } = require('../crypto');

  const mobile = new CryptoHelper();
  const desktop = new CryptoHelper();

  // 手机端发起握手
  const mobilePubKey = mobile.initAsInitiator();

  // 桌面端响应
  const desktopPubKey = desktop.initAsResponder(mobilePubKey);

  // 手机端完成握手
  mobile.completeHandshake(desktopPubKey);

  // 测试加密解密
  const testData = { type: 'chat_message', content: 'Hello Claude!' };
  const encrypted = mobile.encrypt(testData);
  const decrypted = desktop.decrypt(encrypted);
  assert(decrypted.type === 'chat_message', '加密模块: type 正确');
  assert(decrypted.content === 'Hello Claude!', '加密模块: content 正确');

  // 反向加密
  const testData2 = { type: 'chat_reply', content: 'Hello!' };
  const encrypted2 = desktop.encrypt(testData2);
  const decrypted2 = mobile.decrypt(encrypted2);
  assert(decrypted2.content === 'Hello!', '反向加密解密正确');
}

/**
 * 测试 10: 心跳
 */
async function testHeartbeat() {
  console.log('[测试] 心跳');
  const ws = await wsConnect(URL);
  ws.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile'
  }));
  await wsMessageType(ws, 'auth_ok');

  // 发送 ping
  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await wsMessageType(ws, 'pong');
  assert(pong.type === 'pong', '收到 pong 回复');

  ws.close();
}

// 运行测试
runTests().catch(err => {
  console.error('测试启动失败:', err);
  process.exit(1);
});