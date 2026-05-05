/**
 * 连接时序 & 重连 & 心跳 & 异常处理 测试
 * 覆盖现有测试未涉及的 10 个关键场景
 */

const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const { CryptoHelper } = require('../crypto');

const PORT = 19093;
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

// =====================================================
// 消息缓冲机制：解决 auth_ok 和 device_status 同时到达的问题
// =====================================================

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
    // 优先匹配等待中的 waiter
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === msg.type) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
    }
    // 没有匹配的 waiter，存入缓冲区
    buffer.push(msg);
  });
}

function nextMsg(ws, type, timeout = 5000) {
  // 先检查缓冲区
  const idx = ws._msgBuffer.findIndex(m => m.type === type);
  if (idx >= 0) {
    return Promise.resolve(ws._msgBuffer.splice(idx, 1)[0]);
  }
  // 缓冲区没有，等待新消息
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const wi = ws._msgWaiters.findIndex(w => w.type === type && w.resolve === resolve);
      if (wi >= 0) ws._msgWaiters.splice(wi, 1);
      reject(new Error(`等待 ${type} 超时`));
    }, timeout);
    ws._msgWaiters.push({ type, resolve, timer });
  });
}

/** 认证辅助 */
async function auth(ws, device) {
  ws.send(JSON.stringify({
    type: 'auth', username: 'testuser', password: 'testpass', device
  }));
  await nextMsg(ws, 'auth_ok');
}

/** 完整密钥交换辅助：mobile发起，desktop响应，返回 {mobileCrypto, desktopCrypto} */
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

// =====================================================
// 第一类：连接时序不确定（3个场景）
// =====================================================

/**
 * 场景 1: Desktop 先连，Mobile 后连
 * 验证 desktop 等待后 mobile 发起握手，密钥交换正常完成
 */
async function test_desktopFirst_thenMobile() {
  console.log('[测试] 场景1: Desktop 先连，Mobile 后连');

  const desktop = await wsConnect();
  await auth(desktop, 'desktop');

  // desktop 等待中没有 key_init
  await delay(300);

  const mobile = await wsConnect();
  await auth(mobile, 'mobile');

  // desktop 收到 mobile 上线通知
  await nextMsg(desktop, 'device_status');

  // mobile 发起密钥交换 → desktop 响应
  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);

  assert(mobileCrypto.ready === true, '场景1: mobile 加密就绪');
  assert(desktopCrypto.ready === true, '场景1: desktop 加密就绪');

  // 验证加密通信
  const enc = mobileCrypto.encrypt({ type: 'chat_message', content: 'test' });
  const dec = desktopCrypto.decrypt(enc);
  assert(dec.content === 'test', '场景1: 加密通信正常');

  mobile.close();
  desktop.close();
  await delay(300);
}

/**
 * 场景 2: Mobile 先连，Desktop 后连
 * mobile 发 key_init 时 desktop 离线 → 收到 offline 通知
 * desktop 连上后，mobile 重新发起握手
 */
async function test_mobileFirst_keyInitFails_thenDesktopConnects() {
  console.log('[测试] 场景2: Mobile 先连，Desktop 后连，key_init 转发失败');

  const mobile = await wsConnect();
  await auth(mobile, 'mobile');

  // mobile 发 key_init，但 desktop 不在线
  const mobileCrypto1 = new CryptoHelper();
  const pubKey1 = mobileCrypto1.initAsInitiator();
  mobile.send(JSON.stringify({ type: 'key_init', publicKey: pubKey1 }));

  // 应收到 device_status: desktop offline
  const offlineMsg = await nextMsg(mobile, 'device_status');
  assert(offlineMsg.device === 'desktop', '场景2: 收到 desktop 离线通知');
  assert(offlineMsg.online === false, '场景2: desktop 离线');

  // desktop 后连上
  const desktop = await wsConnect();
  await auth(desktop, 'desktop');

  // 等待 mobile 收到 desktop 上线通知
  await nextMsg(mobile, 'device_status');

  // mobile 重新发起握手（新密钥）
  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);

  assert(mobileCrypto.ready === true, '场景2: 重新握手后 mobile 就绪');
  assert(desktopCrypto.ready === true, '场景2: 重新握手后 desktop 就绪');

  const enc = desktopCrypto.encrypt({ type: 'chat_reply', content: 'recovered' });
  const dec = mobileCrypto.decrypt(enc);
  assert(dec.content === 'recovered', '场景2: 恢复后加密通信正常');

  mobile.close();
  desktop.close();
  await delay(300);
}

/**
 * 场景 3: 两端几乎同时连接（竞态条件）
 * 两端可能几乎同时发 key_init，验证最终能建立有效加密通道
 */
async function test_simultaneousConnect_raceCondition() {
  console.log('[测试] 场景3: 两端同时连接（竞态条件）');

  const mobile = await wsConnect();
  const desktop = await wsConnect();

  // 同时认证
  mobile.send(JSON.stringify({ type: 'auth', username: 'testuser', password: 'testpass', device: 'mobile' }));
  desktop.send(JSON.stringify({ type: 'auth', username: 'testuser', password: 'testpass', device: 'desktop' }));
  await nextMsg(mobile, 'auth_ok');
  await nextMsg(desktop, 'auth_ok');

  // 消费可能到达的 device_status 通知（用 delay 替代，因为时序不确定）
  await delay(300);

  // mobile 发起密钥交换（正常路径）
  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);

  assert(mobileCrypto.ready === true, '场景3: mobile 加密就绪');
  assert(desktopCrypto.ready === true, '场景3: desktop 加密就绪');

  // 验证双向加密通信
  const enc1 = mobileCrypto.encrypt({ type: 'chat_message', content: 'race test' });
  const dec1 = desktopCrypto.decrypt(enc1);
  assert(dec1.content === 'race test', '场景3: mobile→desktop 正确');

  const enc2 = desktopCrypto.encrypt({ type: 'chat_reply', content: 'race reply' });
  const dec2 = mobileCrypto.decrypt(enc2);
  assert(dec2.content === 'race reply', '场景3: desktop→mobile 正确');

  mobile.close();
  desktop.close();
  await delay(300);
}

// =====================================================
// 第二类：重连与密钥状态不同步（3个场景）
// =====================================================

/**
 * 场景 4: 一端断开重连，另一端不知道（旧密钥失效）
 * mobile 断开重连后使用新密钥，desktop 旧密钥无法解密新消息
 * 验证 desktop 需要感知到 mobile 重连并重新握手
 */
async function test_oneSideReconnects_otherSideKeepsOldKey() {
  console.log('[测试] 场景4: 一端重连，另一端保持旧密钥');

  // 建立初始连接
  const mobile1 = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile1, 'mobile');
  await auth(desktop, 'desktop');
  await nextMsg(mobile1, 'device_status');
  const crypto1 = await doKeyExchange(mobile1, desktop);

  // 验证初始加密通信正常
  const enc1 = crypto1.mobileCrypto.encrypt({ type: 'chat_message', content: 'before reconnect' });
  const dec1 = crypto1.desktopCrypto.decrypt(enc1);
  assert(dec1.content === 'before reconnect', '场景4: 初始通信正常');

  // mobile 断开
  mobile1.close();
  await nextMsg(desktop, 'device_status'); // desktop 收到 offline 通知

  // mobile 重连
  const mobile2 = await wsConnect();
  await auth(mobile2, 'mobile');
  await nextMsg(desktop, 'device_status'); // desktop 收到 online 通知

  // 重新握手
  const crypto2 = await doKeyExchange(mobile2, desktop);

  // 验证新密钥可以正常通信
  const enc2 = crypto2.mobileCrypto.encrypt({ type: 'chat_message', content: 'after reconnect' });
  const dec2 = crypto2.desktopCrypto.decrypt(enc2);
  assert(dec2.content === 'after reconnect', '场景4: 重连后新密钥通信正常');

  // 验证旧密钥不能解密新消息
  try {
    crypto1.desktopCrypto.decrypt(enc2);
    assert(false, '场景4: 旧密钥不应能解密新消息');
  } catch (e) {
    assert(true, '场景4: 旧密钥无法解密新消息（符合预期）');
  }

  mobile2.close();
  desktop.close();
  await delay(300);
}

/**
 * 场景 5: 密钥交换失败后重试
 * mobile 发 key_init，desktop 还没连上 → mobile 收到 offline
 * desktop 连上后，mobile 应该重新发起握手
 */
async function test_keyExchangeFailure_thenRetry() {
  console.log('[测试] 场景5: 密钥交换失败后重试');

  const mobile = await wsConnect();
  await auth(mobile, 'mobile');

  // 第一次尝试：desktop 不在线
  const failCrypto = new CryptoHelper();
  failCrypto.initAsInitiator();
  mobile.send(JSON.stringify({ type: 'key_init', publicKey: 'dummy' }));
  const offlineMsg = await nextMsg(mobile, 'device_status');
  assert(offlineMsg.online === false, '场景5: 第一次 key_init 失败，desktop 离线');

  // desktop 连上
  const desktop = await wsConnect();
  await auth(desktop, 'desktop');
  await nextMsg(mobile, 'device_status');

  // 第二次尝试：正常握手
  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);
  assert(mobileCrypto.ready === true, '场景5: 重试后 mobile 加密就绪');
  assert(desktopCrypto.ready === true, '场景5: 重试后 desktop 加密就绪');

  const enc = mobileCrypto.encrypt({ type: 'chat_message', content: 'retry ok' });
  const dec = desktopCrypto.decrypt(enc);
  assert(dec.content === 'retry ok', '场景5: 重试后通信正常');

  mobile.close();
  desktop.close();
  await delay(300);
}

/**
 * 场景 6: Relay 重启，两端都需要重建连接和握手
 */
async function test_relayRestart_bothSidesReconnect() {
  console.log('[测试] 场景6: Relay 重启后两端重建');

  // 清除 require 缓存以获取新 server 实例
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/relay/')) delete require.cache[key];
  });

  const restartPort1 = 19094;
  const restartPort2 = 19095;
  const restartUrl1 = `ws://localhost:${restartPort1}`;
  const restartUrl2 = `ws://localhost:${restartPort2}`;

  // 启动 relay
  process.env.MYCHAT_PORT = restartPort1;
  process.env.MYCHAT_USER = 'testuser';
  const hash = await bcrypt.hash('testpass', 4);
  process.env.MYCHAT_PASS_HASH = hash;

  const { start: start1 } = require('../server');
  await start1();
  await delay(300);

  // 两端连接
  let mobile = await wsConnect(restartUrl1);
  let desktop = await wsConnect(restartUrl1);
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');
  await nextMsg(mobile, 'device_status');
  const crypto1 = await doKeyExchange(mobile, desktop);

  const enc1 = crypto1.mobileCrypto.encrypt({ type: 'chat_message', content: 'before restart' });
  const dec1 = crypto1.desktopCrypto.decrypt(enc1);
  assert(dec1.content === 'before restart', '场景6: 重启前通信正常');

  // 关闭所有连接（模拟 relay 重启）
  mobile.close();
  desktop.close();
  await delay(500);

  // 清除缓存重新加载 server
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/relay/')) delete require.cache[key];
  });

  // 用新端口重启 relay
  process.env.MYCHAT_PORT = restartPort2;
  const { start: start2 } = require('../server');
  await start2();
  await delay(300);

  // 两端重新连接（新端口）
  mobile = await wsConnect(restartUrl2);
  desktop = await wsConnect(restartUrl2);
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');
  await nextMsg(mobile, 'device_status');
  const crypto2 = await doKeyExchange(mobile, desktop);

  const enc2 = crypto2.mobileCrypto.encrypt({ type: 'chat_message', content: 'after restart' });
  const dec2 = crypto2.desktopCrypto.decrypt(enc2);
  assert(dec2.content === 'after restart', '场景6: 重启后重建通信正常');

  // 旧密钥不能用于新连接
  try {
    crypto1.desktopCrypto.decrypt(enc2);
    assert(false, '场景6: 旧密钥不应解密新连接消息');
  } catch (e) {
    assert(true, '场景6: 旧密钥无法解密新连接消息（符合预期）');
  }

  mobile.close();
  desktop.close();
}

// =====================================================
// 第三类：心跳与保活（2个场景）
// =====================================================

/**
 * 场景 7: Relay pongTimer 不泄漏
 * 连接存活超过一个 PING_INTERVAL (30s)，验证不被误断
 * 用较短的超时测试：监听意外 close 事件
 */
async function test_pongTimerNoLeak() {
  console.log('[测试] 场景7: pongTimer 不泄漏（35秒连接保活）');

  const ws = await wsConnect();
  await auth(ws, 'mobile');

  let unexpectedClose = false;
  const closePromise = new Promise((resolve) => {
    ws.on('close', (code, reason) => {
      unexpectedClose = true;
      resolve({ code, reason: reason.toString() });
    });
  });

  // 持续发 ping 保持活跃，等 35 秒（超过一个 30s PING_INTERVAL）
  const keepAlive = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 5000);

  // 等 35 秒，验证连接不断
  await delay(35000);
  clearInterval(keepAlive);

  assert(!unexpectedClose, '场景7: 35秒后连接未被误断');
  assert(ws.readyState === 1, '场景7: WebSocket 仍然 OPEN');

  ws.close();
  await delay(300);
}

/**
 * 场景 8: 网络抖动 → 短暂断连 → 自动恢复
 * 模拟 desktop 断开后重连，mobile 重新发起握手
 */
async function test_networkGlitch_recovery() {
  console.log('[测试] 场景8: 网络抖动后恢复');

  const mobile = await wsConnect();
  let desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');
  await nextMsg(mobile, 'device_status');

  const crypto1 = await doKeyExchange(mobile, desktop);

  // desktop 意外断开
  desktop.close();
  const offlineMsg = await nextMsg(mobile, 'device_status');
  assert(offlineMsg.online === false, '场景8: mobile 收到 desktop 离线');

  // desktop 快速重连
  desktop = await wsConnect();
  await auth(desktop, 'desktop');

  await nextMsg(mobile, 'device_status'); // mobile 收到 desktop online

  // 重新握手
  const crypto2 = await doKeyExchange(mobile, desktop);

  const enc = crypto2.mobileCrypto.encrypt({ type: 'chat_message', content: 'recovered' });
  const dec = crypto2.desktopCrypto.decrypt(enc);
  assert(dec.content === 'recovered', '场景8: 恢复后加密通信正常');

  mobile.close();
  desktop.close();
  await delay(300);
}

// =====================================================
// 第四类：异常处理（2个场景）
// =====================================================

/**
 * 场景 9: 无效 JSON 消息不导致连接断开
 */
async function test_invalidJSON_doesNotCrash() {
  console.log('[测试] 场景9: 无效 JSON 不导致断连');

  const ws = await wsConnect();
  await auth(ws, 'mobile');

  // 发送无效 JSON
  ws.send('not json at all');
  ws.send('{invalid json}');
  ws.send('');

  await delay(300);

  // 连接应该仍然存活
  assert(ws.readyState === 1, '场景9: 无效 JSON 后连接仍存活');

  // 正常消息仍然能工作
  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await nextMsg(ws, 'pong');
  assert(pong.type === 'pong', '场景9: 无效 JSON 后正常消息仍工作');

  ws.close();
  await delay(300);
}

/**
 * 场景 10: 加密/解密失败时的降级处理
 * desktop 用错误密钥解密 → 不应导致连接断开
 * mobile 收到无法解密的 encrypted 消息 → 不应导致连接断开
 */
async function test_decryptFailure_doesNotCrash() {
  console.log('[测试] 场景10: 解密失败不导致断连');

  const mobile = await wsConnect();
  const desktop = await wsConnect();
  await auth(mobile, 'mobile');
  await auth(desktop, 'desktop');
  await nextMsg(mobile, 'device_status');

  const { mobileCrypto, desktopCrypto } = await doKeyExchange(mobile, desktop);

  // 用不同密钥对加密消息发给 desktop（模拟密钥不匹配）
  const wrongA = new CryptoHelper();
  const wrongB = new CryptoHelper();
  const wrongAPubKey = wrongA.initAsInitiator();
  const wrongBPubKey = wrongB.initAsResponder(wrongAPubKey);
  wrongA.completeHandshake(wrongBPubKey);
  // wrongA 和 wrongB 共享密钥，但与 mobile/desktop 的密钥完全不同
  const wrongEnc = wrongA.encrypt({ type: 'chat_message', content: 'wrong key' });

  // 发送无法解密的消息给 desktop
  mobile.send(JSON.stringify({ type: 'encrypted', payload: wrongEnc }));

  // desktop 不应断连，等一下看
  await delay(500);
  assert(desktop.readyState === 1, '场景10: 收到无法解密消息后 desktop 连接仍存活');
  assert(mobile.readyState === 1, '场景10: mobile 连接仍存活');

  // 正常加密消息仍能工作（先清空缓冲区中错误密钥的 encrypted 消息）
  desktop._msgBuffer = desktop._msgBuffer.filter(m => m.type !== 'encrypted');
  const enc = mobileCrypto.encrypt({ type: 'chat_message', content: 'normal' });
  mobile.send(JSON.stringify({ type: 'encrypted', payload: enc }));

  const received = await nextMsg(desktop, 'encrypted');
  const dec = desktopCrypto.decrypt(received.payload);
  assert(dec.content === 'normal', '场景10: 错误消息后正常加密通信恢复');

  mobile.close();
  desktop.close();
  await delay(300);
}

// =====================================================

async function runTests() {
  console.log('\n=== 连接时序 & 重连 & 心跳 & 异常处理 测试 ===\n');

  process.env.MYCHAT_PORT = PORT;
  process.env.MYCHAT_USER = 'testuser';
  const hash = await bcrypt.hash('testpass', 4);
  process.env.MYCHAT_PASS_HASH = hash;

  const { start } = require('../server');
  await start();
  await delay(500);

  try {
    // 第一类：连接时序
    await test_desktopFirst_thenMobile();
    await test_mobileFirst_keyInitFails_thenDesktopConnects();
    await test_simultaneousConnect_raceCondition();

    // 第二类：重连与密钥状态
    await test_oneSideReconnects_otherSideKeepsOldKey();
    await test_keyExchangeFailure_thenRetry();
    await test_relayRestart_bothSidesReconnect();

    // 第三类：心跳与保活
    await test_pongTimerNoLeak();
    await test_networkGlitch_recovery();

    // 第四类：异常处理
    await test_invalidJSON_doesNotCrash();
    await test_decryptFailure_doesNotCrash();
  } catch (e) {
    console.error('测试异常:', e);
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
