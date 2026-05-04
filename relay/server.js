/**
 * MyChat 云中继服务器
 * 负责认证和消息转发，不存储任何消息
 */

const http = require('http');
const WebSocket = require('ws');
const AuthService = require('./auth');
const Router = require('./router');

// 配置
const PORT = process.env.MYCHAT_PORT || 9090;
const AUTH_TIMEOUT = 10000;  // 认证超时 10s
const PING_INTERVAL = 30000; // 心跳间隔 30s
const PONG_TIMEOUT = 60000;  // 心跳超时 60s

// 初始化服务
const auth = new AuthService();
const router = new Router();

// 创建 HTTP 服务器（健康检查）
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ server: httpServer });

/**
 * 处理新连接
 */
wss.on('connection', (ws, req) => {
  console.log(`[RELAY] 新连接: ${req.socket.remoteAddress}`);

  ws._mychatAuthenticated = false;
  ws._mychatUsername = null;
  ws._mychatDevice = null;

  // 认证超时
  const authTimer = setTimeout(() => {
    if (!ws._mychatAuthenticated) {
      ws.send(JSON.stringify({ type: 'auth_fail', reason: '认证超时' }));
      ws.close(4001, '认证超时');
    }
  }, AUTH_TIMEOUT);

  // 心跳检测
  let pongTimer = null;
  const pingTimer = setInterval(() => {
    if (ws.readyState !== 1) return;
    ws.ping();
    pongTimer = setTimeout(() => {
      console.log(`[RELAY] 心跳超时: ${ws._mychatUsername || '未认证'}`);
      ws.terminate();
    }, PONG_TIMEOUT);
  }, PING_INTERVAL);

  ws.on('pong', () => {
    if (pongTimer) clearTimeout(pongTimer);
  });

  /**
   * 处理消息
   */
  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.log('[RELAY] 无效 JSON');
      return;
    }

    // 未认证时只允许 auth 消息
    if (!ws._mychatAuthenticated) {
      if (msg.type === 'auth') {
        await handleAuth(ws, msg, authTimer);
      } else {
        ws.send(JSON.stringify({ type: 'auth_fail', reason: '请先认证' }));
      }
      return;
    }

    // 已认证，处理各类消息
    handleMessage(ws, msg);
  });

  /**
   * 处理关闭
   */
  ws.on('close', () => {
    clearTimeout(authTimer);
    clearInterval(pingTimer);
    if (pongTimer) clearTimeout(pongTimer);

    if (ws._mychatAuthenticated) {
      router.unregister(ws);
      console.log(`[RELAY] 断开: ${ws._mychatUsername} (${ws._mychatDevice})`);
    }
  });

  /**
   * 处理错误
   */
  ws.on('error', (err) => {
    console.error(`[RELAY] WebSocket 错误: ${err.message}`);
  });
});

/**
 * 处理认证
 */
async function handleAuth(ws, msg, authTimer) {
  const { username, password, device } = msg;

  if (!username || !password || !device) {
    ws.send(JSON.stringify({ type: 'auth_fail', reason: '缺少参数' }));
    ws.close(4002, '缺少参数');
    return;
  }

  if (device !== 'mobile' && device !== 'desktop') {
    ws.send(JSON.stringify({ type: 'auth_fail', reason: '无效设备类型' }));
    ws.close(4003, '无效设备类型');
    return;
  }

  const valid = await auth.verify(username, password);
  if (!valid) {
    ws.send(JSON.stringify({ type: 'auth_fail', reason: '用户名或密码错误' }));
    ws.close(4004, '认证失败');
    return;
  }

  // 认证成功
  clearTimeout(authTimer);
  ws._mychatAuthenticated = true;
  ws._mychatUsername = username;
  ws._mychatDevice = device;

  // 注册到路由
  router.register(username, device, ws);

  // 回复认证成功
  ws.send(JSON.stringify({ type: 'auth_ok' }));

  // 通知对端设备上线
  router.notifyOnline(ws);

  console.log(`[RELAY] 认证成功: ${username} (${device})`);
}

/**
 * 处理已认证消息
 */
function handleMessage(ws, msg) {
  const { type } = msg;

  switch (type) {
    // 查询设备状态
    case 'query_device_status':
      const status = router.getDeviceStatus(ws, 'desktop');
      ws.send(JSON.stringify({
        type: 'device_status',
        device: 'desktop',
        online: status.online,
        count: status.count
      }));
      break;

    // 转发到对端
    case 'key_init':
    case 'key_response':
    case 'encrypted':
      const forwarded = router.forward(ws, msg);
      if (!forwarded) {
        // 对端离线，通知发送方
        const targetDevice = ws._mychatDevice === 'mobile' ? 'desktop' : 'mobile';
        ws.send(JSON.stringify({
          type: 'device_status',
          device: targetDevice,
          online: false
        }));
      }
      break;

    // 心跳
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      console.log(`[RELAY] 未知消息类型: ${type}`);
  }
}

/**
 * 启动服务器
 */
async function start() {
  // 加载用户凭证（从环境变量或配置文件）
  const username = process.env.MYCHAT_USER || 'admin';
  const hashedPassword = process.env.MYCHAT_PASS_HASH;

  if (!hashedPassword) {
    // 首次运行，生成密码哈希
    const bcrypt = require('bcrypt');
    const defaultPassword = 'changeme';
    const hash = await bcrypt.hash(defaultPassword, 10);
    auth.addUser(username, hash);
    console.log(`[RELAY] 默认用户: ${username}`);
    console.log(`[RELAY] 默认密码: ${defaultPassword}`);
    console.log(`[RELAY] 密码哈希: ${hash}`);
    console.log('[RELAY] 请设置环境变量 MYCHAT_PASS_HASH=' + hash);
  } else {
    auth.addUser(username, hashedPassword);
    console.log(`[RELAY] 用户: ${username}`);
  }

  httpServer.listen(PORT, () => {
    console.log(`[RELAY] 中继服务器启动: ws://0.0.0.0:${PORT}`);
    console.log(`[RELAY] 健康检查: http://0.0.0.0:${PORT}/health`);
  });
}

// 导出用于测试
module.exports = { start, auth, router, wss };

// 直接运行时启动
if (require.main === module) {
  start().catch(err => {
    console.error('[RELAY] 启动失败:', err);
    process.exit(1);
  });
}