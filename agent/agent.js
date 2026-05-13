/**
 * MyChat Mac 桌面客户端
 * 连接中继服务器，管理 Claude CLI 交互
 */

const WebSocket = require('ws');
const { CryptoHelper } = require('./crypto');
const ClaudeCLI = require('./claude-cli');
const Store = require('./store');

const RELAY_URL = process.env.MYCHAT_RELAY_URL || 'ws://localhost:9090';
const USERNAME = process.env.MYCHAT_USER || 'admin';
const PASSWORD = process.env.MYCHAT_PASS || 'changeme';
const DEVICE = 'desktop';
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 60000;

class Agent {
  constructor() {
    this.ws = null;
    this.crypto = new CryptoHelper();
    this.cli = null;
    this.store = new Store();
    this.reconnectDelay = RECONNECT_BASE;
    this.running = false;
    this.heartbeatTimer = null;
    this.pendingMessages = []; // Fix 1: 消息缓冲，断连时暂存，重连后回放
  }

  /**
   * 启动 agent
   */
  async start() {
    const env = process.env.MYCHAT_ENV || 'production';
    console.log(`[AGENT] MyChat Mac 客户端启动 (环境: ${env})`);
    console.log(`[AGENT] Session 路径: ${path.join(process.env.HOME, '.mychat', process.env.MYCHAT_ENV || '')}`);
    console.log(`[AGENT] 数据库路径: ${path.join(__dirname, 'data', process.env.MYCHAT_ENV || '')}`);
    this.running = true;
    this._initCLI();
    this._connect();
  }

  /**
   * 初始化 Claude CLI
   */
  _initCLI() {
    this.cli = new ClaudeCLI(
      // onReply: Claude 输出的文本片段（Fix 1: 始终缓冲，连接就绪时发送）
      (text) => {
        if (!this.crypto.ready) return;
        const payload = this.crypto.encrypt({
          type: 'chat_reply',
          content: text
        });
        this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }));
        this._flushBuffer();
      },
      // onComplete: Claude 回复结束（Fix 1: 缓冲完成标记）
      () => {
        if (!this.crypto.ready) return;
        const payload = this.crypto.encrypt({ type: 'chat_complete' });
        this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }));
        this._flushBuffer();
      },
      // onPermissionRequest: 权限请求
      (details) => {
        if (!this.crypto.ready) return;
        const payload = this.crypto.encrypt({
          type: 'permission_request',
          action: details.action || 'unknown',
          details: details.details || ''
        });
        this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }));
        this._flushBuffer();
      },
      // onChoiceRequest: 选择请求
      (options) => {
        if (!this.crypto.ready) return;
        const payload = this.crypto.encrypt({
          type: 'choice_request',
          options: options
        });
        this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }));
        this._flushBuffer();
      },
      // onSessionChange: 会话变化通知（Fix 2）
      (newSessionId) => {
        if (!this.crypto.ready) return;
        const payload = this.crypto.encrypt({
          type: 'session_changed',
          sessionId: newSessionId
        });
        this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }));
        this._flushBuffer();
      }
    );
  }

  /**
   * 连接中继服务器
   */
  _connect() {
    if (!this.running) return;

    console.log(`[AGENT] 连接中继: ${RELAY_URL}`);
    this.ws = new WebSocket(RELAY_URL);

    this.ws.on('open', () => {
      console.log('[AGENT] WebSocket 已连接，发送认证');
      this.reconnectDelay = RECONNECT_BASE;
      this.ws.send(JSON.stringify({
        type: 'auth',
        username: USERNAME,
        password: PASSWORD,
        device: DEVICE
      }));
      this._startHeartbeat();
    });

    this.ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return;
      }
      console.log(`[AGENT] 收到原始消息: type=${msg.type}`);
      this._handleMessage(msg);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[AGENT] 连接断开: code=${code} reason=${reason || '无'}`);
      this._stopHeartbeat();
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[AGENT] 连接错误: ${err.message}`);
    });
  }

  /**
   * 处理收到的消息
   */
  _handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        console.log('[AGENT] 认证成功');
        this._startKeyExchange();
        break;

      case 'auth_fail':
        console.error(`[AGENT] 认证失败: ${msg.reason}`);
        break;

      case 'key_init':
        this._handleKeyInit(msg);
        break;

      case 'key_response':
        this._handleKeyResponse(msg);
        break;

      case 'encrypted':
        this._handleEncrypted(msg);
        break;

      case 'device_status':
        console.log(`[AGENT] 设备状态: ${msg.device} ${msg.online ? '在线' : '离线'}`);
        // mobile 在线但密钥未就绪：等 2 秒让 mobile 先发起，超时则 desktop 主动发起
        if (msg.device === 'mobile' && msg.online && !this.crypto.ready) {
          setTimeout(() => {
            if (!this.crypto.ready && this.ws && this.ws.readyState === 1) {
              this._initiateKeyExchange();
            }
          }, 2000);
        }
        break;

      case 'pong':
        break;

      default:
        console.log(`[AGENT] 未知消息: ${msg.type}`);
    }
  }

  /**
   * 发起密钥交换（desktop 作为发起者）
   */
  _initiateKeyExchange() {
    console.log('[AGENT] 发起密钥交换...');
    const myPubKey = this.crypto.initAsInitiator();
    this.ws.send(JSON.stringify({
      type: 'key_init',
      publicKey: myPubKey
    }));
  }

  /**
   * 发起密钥交换（desktop 作为响应者）
   */
  _startKeyExchange() {
    // 等待手机端发起 key_init，desktop 作为响应者
    console.log('[AGENT] 等待密钥交换...');
  }

  /**
   * Fix 1: 回放缓冲消息
   * 当 WebSocket 连接就绪时，将断连期间缓冲的消息全部发送
   */
  _flushBuffer() {
    if (!this.ws || this.ws.readyState !== 1) return;
    while (this.pendingMessages.length > 0) {
      const msg = this.pendingMessages.shift();
      try {
        this.ws.send(msg);
      } catch (e) {
        console.error(`[AGENT] 缓冲消息发送失败: ${e.message}`);
        this.pendingMessages.unshift(msg); // 放回队列
        return;
      }
    }
  }

  /**
   * Fix 1/4: 辅助方法 - 加密并缓冲消息
   */
  _sendToBuffer(data) {
    if (!this.crypto.ready) return;
    const payload = this.crypto.encrypt(data);
    this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }));
    this._flushBuffer();
  }

  /**
   * 处理 key_init（手机端发起的握手）
   */
  _handleKeyInit(msg) {
    console.log(`[AGENT] 收到 key_init`);
    const myPubKey = this.crypto.initAsResponder(msg.publicKey);

    this.ws.send(JSON.stringify({
      type: 'key_response',
      publicKey: myPubKey
    }));

    console.log('[AGENT] 密钥交换完成');
    this._flushBuffer(); // Fix 1: 密钥就绪后立即回放缓冲消息
  }

  /**
   * 处理 key_response
   */
  _handleKeyResponse(msg) {
    this.crypto.completeHandshake(msg.publicKey);
    console.log('[AGENT] 密钥交换完成');
    this._flushBuffer(); // Fix 1: 密钥就绪后立即回放缓冲消息
  }

  /**
   * 处理加密消息
   */
  _handleEncrypted(msg) {
    if (!this.crypto.ready) {
      console.log('[AGENT] 加密未就绪，忽略消息');
      return;
    }

    let data;
    try {
      data = this.crypto.decrypt(msg.payload);
    } catch (e) {
      console.error(`[AGENT] 解密失败: ${e.message}`);
      return;
    }

    console.log(`[AGENT] 收到: ${data.type}`);

    switch (data.type) {
      case 'chat_message':
        this.store.saveMessage('user', data.content);
        this.cli.sendMessage(data.content);
        break;

      case 'image_message':
        this._handleImageMessage(data);
        break;

      case 'permission_response':
        this.cli.respondPermission(data.response === 'approve');
        break;

      case 'choice_response':
        this.cli.respondChoice(data.selected);
        break;

      case 'interrupt':
        this.cli.interrupt();
        // Fix 1: 如果 CLI 已完成但完成事件还在缓冲区，确保 chat_complete 被发送
        // 如果缓冲区为空且 CLI 已不在响应，手动补发 chat_complete
        if (!this.cli.isResponding) {
          const hasComplete = this.pendingMessages.some(m => m.includes('chat_complete'));
          if (!hasComplete && this.crypto.ready) {
            const payload = this.crypto.encrypt({ type: 'chat_complete' });
            this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }));
            this._flushBuffer();
          } else {
            this._flushBuffer();
          }
        }
        break;

      case 'set_mode':
        this.cli.setMode(data.mode);
        // 确认模式切换
        this._sendToBuffer({ type: 'mode_changed', mode: data.mode });
        break;

      case 'reset_session':
        this.cli.resetSession();
        this._sendToBuffer({ type: 'session_reset_ok' });
        break;

      case 'query_session_status':
        if (this.crypto.ready) {
          const status = this.cli.session.getStatus();
          this._sendToBuffer({
            type: 'session_status',
            hasSession: status.hasSession,
            createdAt: status.createdAt
          });
        }
        break;

      case 'upload_crash_log':
        // 保存崩溃日志
        const fs = require('fs');
        const logDir = path.join(__dirname, 'logs', 'crash');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, `${Date.now()}.log`);
        fs.writeFileSync(logPath, data.content);
        console.log(`[AGENT] 崩溃日志已保存: ${logPath}`);
        // 发送确认
        this._sendToBuffer({ type: 'crash_log_received' });
        break;

      default:
        console.log(`[AGENT] 未知加密消息类型: ${data.type}`);
    }
  }

  /**
   * 处理图片消息：保存文件，发送给 CLI 分析
   */
  _handleImageMessage(data) {
    const fs = require('fs');
    const imgDir = path.join(process.env.HOME, '.mychat', process.env.MYCHAT_ENV || '', 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const imgName = `${Date.now()}.jpg`;
    const imgPath = path.join(imgDir, imgName);

    try {
      const buf = Buffer.from(data.imageBase64, 'base64');
      fs.writeFileSync(imgPath, buf);
      console.log(`[AGENT] 图片已保存: ${imgPath} (${buf.length} bytes)`);
    } catch (e) {
      console.error(`[AGENT] 图片保存失败: ${e.message}`);
      this._sendToBuffer({ type: 'image_ack', success: false });
      return;
    }

    // 发送确认
    this._sendToBuffer({ type: 'image_ack', success: true });

    // 发给 CLI 分析
    this.store.saveMessage('user', data.text || '[图片]');
    const prompt = data.text
      ? `${data.text}\n\n用户发送了一张图片，请分析: ${imgPath}`
      : `用户发送了一张图片，请分析: ${imgPath}`;
    this.cli.sendMessage(prompt);
  }

  /**
   * 重连（指数退避）
   */
  _scheduleReconnect() {
    if (!this.running) return;
    const delay = this.reconnectDelay;
    console.log(`[AGENT] ${delay}ms 后重连...`);
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
      this._connect();
    }, delay);
  }

  /**
   * 应用层心跳，每 25 秒发 ping
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 停止 agent
   */
  stop() {
    this.running = false;
    this._stopHeartbeat();
    if (this.cli) this.cli.stop();
    if (this.ws) this.ws.close();
    this.store.close();
    console.log('[AGENT] 已停止');
  }
}

const path = require('path');

// 给 console.log 加时间戳
const origLog = console.log;
const origErr = console.error;
function ts() { return new Date().toISOString().slice(11, 23); }
console.log = (...args) => origLog(`[${ts()}]`, ...args);
console.error = (...args) => origErr(`[${ts()}]`, ...args);

// 启动
const agent = new Agent();
agent.start().catch(err => {
  console.error('[AGENT] 启动失败:', err);
  process.exit(1);
});

// 优雅退出
process.on('SIGINT', () => {
  agent.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  agent.stop();
  process.exit(0);
});

module.exports = Agent;
