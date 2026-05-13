# P0/P1 Bug 修复方案

## Fix 1: Agent 消息缓冲机制（修复 Bug 2, 9）— 最高优先级

### 问题
CLI 输出在 WebSocket 断开时被静默丢弃（`onReply`/`onComplete` 检查 `ws.readyState === 1`，不满足直接 return）。

### 方案
在 Agent 层添加消息缓冲，连接恢复后自动回放。

### 修改文件
- `agent/agent.js`

### 具体改动

**1. Agent 构造函数增加缓冲区：**
```javascript
this.pendingMessages = [];    // 缓冲的加密消息
this.cliBuffering = false;    // CLI 是否正在缓冲模式
```

**2. 修改回调函数（onReply/onComplete）：**
```javascript
// onReply: 始终加密入缓冲区，而非条件丢弃
(text) => {
  if (!this.crypto.ready) return;  // 加密未就绪无法缓冲
  const payload = this.crypto.encrypt({ type: 'chat_reply', content: text });
  this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }));
  this._flushBuffer();
}

// onComplete: 缓冲完成标记
() => {
  if (!this.crypto.ready) return;
  const payload = this.crypto.encrypt({ type: 'chat_complete' });
  this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }));
  this._flushBuffer();
}
```

**3. 新增 `_flushBuffer()` 方法：**
```javascript
_flushBuffer() {
  if (!this.ws || this.ws.readyState !== 1) return;
  while (this.pendingMessages.length > 0) {
    const msg = this.pendingMessages.shift();
    this.ws.send(msg);
  }
}
```

**4. 在密钥交换完成后调用 `_flushBuffer()`：**
- `_handleKeyInit` 和 `_handleKeyResponse` 完成后
- `_handleKeyResponse` 完成后

**5. 修复 interrupt 处理：**
当 App 发 interrupt 但 Agent 端 `isResponding` 已为 false 时（CLI 已完成但完成事件被缓冲）：
- `_flushBuffer()` 会自动发送缓冲的 chat_complete
- 如果缓冲区为空（CLI 输出全部丢失），手动补充一条 chat_complete

### 测试案例
1. CLI 产出期间 ws 断开 → 消息缓冲 → ws 重连后全部发送
2. CLI 完成后 ws 断开 → chat_complete 缓冲 → 重连后发送 → App 正确结束
3. 正常连接时 → 缓冲区实时清空 → 行为不变
4. interrupt 时 CLI 已结束 → 补发 chat_complete → App 结束等待状态

---

## Fix 2: 会话管理增强（修复 Bug 1, 3）

### 问题
1. 上下文溢出时 `session.clear()` 无提示重置会话
2. CLI 返回的 session_id 与传入的 `--resume` id 可能不同（会话已变），但未检测

### 方案
跟踪 session 变化，通知 App 端显示会话状态。

### 修改文件
- `agent/claude-cli.js`
- `agent/agent.js`

### 具体改动

**1. claude-cli.js — 跟踪会话变化：**
```javascript
constructor(...) {
  // ... existing ...
  this._resumeSessionId = null;  // 本次 --resume 使用的 session_id
  this._sessionChanged = false;   // 会话是否发生了变化
}

_startCli(text) {
  // ... existing args setup ...
  if (this.session.sessionId) {
    args.push('--resume', this.session.sessionId);
    this._resumeSessionId = this.session.sessionId;  // 记录传入的 id
  } else {
    this._resumeSessionId = null;
  }
  this._sessionChanged = false;
  // ...
}

_handleJsonMessage(msg) {
  // 在所有 session_id 保存处添加变化检测
  if (msg.session_id) {
    this.session.save(msg.session_id);
    if (this._resumeSessionId && msg.session_id !== this._resumeSessionId) {
      console.log(`[CLI] 会话 ID 变化: ${this._resumeSessionId.slice(0,8)} → ${msg.session_id.slice(0,8)}`);
      this._sessionChanged = true;
      this.onSessionChange(msg.session_id);
    }
  }
  // ... rest unchanged ...
}
```

**2. 新增 `onSessionChange` 回调：**
构造函数新增第 5 个参数 `onSessionChange`，当 session_id 变化时调用。

**3. 上下文溢出时通知 App：**
```javascript
// 在 context overflow 重试前
_handleJsonMessage(msg) {
  if (msg.type === 'result') {
    if (this._contextOverflowDetected && this._retryCount < 2) {
      // 先通知再重试
      this.onSessionReset('context_overflow');
      this.session.clear();
      // ... existing retry logic ...
    }
  }
}
```

**4. agent.js — 转发会话事件到 App：**
```javascript
// 初始化 CLI 时添加新回调
this.cli = new ClaudeCLI(
  onReply,
  onComplete,
  onPermissionRequest,
  onChoiceRequest,
  // 新增：会话变化通知
  (newSessionId) => {
    if (this.crypto.ready && this.ws?.readyState === 1) {
      const payload = this.crypto.encrypt({
        type: 'session_changed',
        sessionId: newSessionId
      });
      this.ws.send(JSON.stringify({ type: 'encrypted', payload }));
    }
  }
);
```

**5. App 端显示会话状态：**
- `RelayClient.kt`: 新增 `RelayEvent.SessionChanged` 事件
- `ChatViewModel.kt`: 收到 `session_changed` 时显示系统消息

### 测试案例
1. 上下文溢出 → session_reset 通知发送 → App 收到并显示
2. CLI 返回不同 session_id → session_changed 通知 → App 收到
3. 正常对话 → 无多余通知
4. _kill() 后重启 → 使用已知 session_id 恢复

---

## Fix 3: 模式系统修复（修复 Bug 7）

### 问题
`default` 模式下 CLI 自动执行改动，因为：
1. 使用 `-p` 非交互模式，无法弹出权限确认
2. `respondPermission`/`respondChoice` 是空实现
3. `_handleJsonMessage` 不处理权限请求消息

### 方案
利用 Claude CLI 的 `--permission-mode` 参数控制行为：
- `plan` → `--permission-mode plan`：纯讨论，不执行工具
- `default` → `--permission-mode default`：按 CLI 默认规则处理权限（不会自动执行敏感操作）
- `auto` → `--dangerously-skip-permissions`：跳过所有权限检查

### 修改文件
- `agent/claude-cli.js`

### 具体改动

**1. 修改 `_startCli` 参数构建：**
```javascript
_startCli(text) {
  const args = [];

  if (this.mode === 'plan') {
    args.push('-p', text, '--output-format', 'stream-json', '--verbose');
    args.push('--permission-mode', 'plan');
  } else if (this.mode === 'auto') {
    args.push('-p', text, '--output-format', 'stream-json', '--verbose');
    args.push('--dangerously-skip-permissions');
  } else {
    // default: 使用 --permission-mode default
    args.push('-p', text, '--output-format', 'stream-json', '--verbose');
    args.push('--permission-mode', 'default');
  }

  if (this.session.sessionId) {
    args.push('--resume', this.session.sessionId);
  }
  // ... rest unchanged ...
}
```

**2. 增加权限消息处理：**
```javascript
_handleJsonMessage(msg) {
  // ... existing types ...

  // 新增：处理权限相关消息
  if (msg.type === 'permission_request' || msg.type === 'permission') {
    console.log(`[CLI] 权限请求: ${JSON.stringify(msg).slice(0, 200)}`);
    this.onPermissionRequest({
      action: msg.tool_name || msg.action || 'unknown',
      details: JSON.stringify(msg.tool_input || msg.details || '')
    });
  }

  if (msg.type === 'choice_request' || msg.type === 'choice') {
    console.log(`[CLI] 选择请求: ${JSON.stringify(msg).slice(0, 200)}`);
    const options = msg.options || [];
    this.onChoiceRequest(options);
  }
}
```

**3. `respondPermission` 写入 CLI stdin（在 stream-json 模式下）：**
```javascript
respondPermission(approved) {
  console.log(`[CLI] 权限响应: ${approved ? '允许' : '拒绝'}`);
  if (this.process && this.process.stdin.writable) {
    this.process.stdin.write(JSON.stringify({
      type: 'permission_response',
      approved: approved
    }) + '\n');
  }
}
```

**4. 增加 `plan` 模式支持：**
```javascript
setMode(mode) {
  if (!['default', 'auto', 'plan'].includes(mode)) return;
  if (this.mode === mode) return;
  this.mode = mode;
  console.log(`[CLI] 切换模式: ${mode}`);
}
```

### 注意事项
- `--permission-mode default` 在 `-p` 模式下，CLI 可能无法获取用户授权，会**跳过需要权限的工具**而非自动执行 — 这正是用户期望的行为
- 如果后续发现 CLI 支持 `--input-format stream-json` 下的权限交互协议，可以进一步增强为实时权限审批
- `plan` 模式需要 App 端同步支持模式选项

### 测试案例
1. `plan` 模式：发送消息 → CLI 不调用任何工具 → 只返回文本回复
2. `auto` 模式：发送消息 → CLI 自动执行所有操作（行为不变）
3. `default` 模式：发送需要文件修改的消息 → CLI 跳过需要权限的操作 → 返回受限回复
4. 模式切换：default→auto→plan→default → 每次切换后行为正确
5. `default` 模式下 CLI 输出权限请求 → Agent 转发给 App（如 CLI 支持）

---

## Fix 4: 环境隔离验证（修复 Bug 10）

### 问题
SIT 和生产环境可能共享对话。

### 方案
代码层面隔离逻辑正确（Session/Store 都按 MYCHAT_ENV 隔离路径）。问题可能是配置遗漏。

### 修改文件
- `relay/ecosystem.config.json`
- `agent/agent.js`

### 具体改动

**1. ecosystem.config.json 增加 SIT relay：**
```json
{
  "apps": [
    {
      "name": "mychat-relay",
      "script": "server.js",
      "cwd": "/root/relay",
      "env": {
        "MYCHAT_PORT": 9090,
        "MYCHAT_USER": "rains2009",
        "MYCHAT_PASS_HASH": "$2b$10$.Fn1dvl2XApGpyF1SMDKku30SJy.sMAQuGLOPQugiXnDlfI72bBa2"
      },
      "watch": false, "autorestart": true, "max_restarts": 10, "restart_delay": 3000
    },
    {
      "name": "mychat-relay-sit",
      "script": "server.js",
      "cwd": "/root/relay",
      "env": {
        "MYCHAT_PORT": 9091,
        "MYCHAT_USER": "rains2009",
        "MYCHAT_PASS_HASH": "$2b$10$.Fn1dvl2XApGpyF1SMDKku30SJy.sMAQuGLOPQugiXnDlfI72bBa2"
      },
      "watch": false, "autorestart": true, "max_restarts": 10, "restart_delay": 3000
    }
  ]
}
```

**2. agent.js 启动日志增加环境信息：**
```javascript
async start() {
  const env = process.env.MYCHAT_ENV || 'production';
  console.log(`[AGENT] MyChat Mac 客户端启动 (环境: ${env})`);
  console.log(`[AGENT] Session: ${path.join(process.env.HOME, '.mychat', process.env.MYCHAT_ENV || '')}`);
  // ...
}
```

### 测试案例
1. SIT agent 使用 `~/.mychat/sit/session.json`，production 使用 `~/.mychat/session.json`
2. SIT agent 使用 `agent/data/sit/chat.db`，production 使用 `agent/data/chat.db`
3. 两个 relay 进程独立运行在不同端口
4. SIT app 消息不会出现在 production relay 日志中

---

## 修复实施顺序

1. **Fix 1**（消息缓冲）→ 解决 Bug 2 + Bug 9
2. **Fix 2**（会话管理）→ 解决 Bug 1 + Bug 3
3. **Fix 3**（模式系统）→ 解决 Bug 7
4. **Fix 4**（环境隔离）→ 解决 Bug 10

## 测试策略

- 每个 Fix 完成后编写对应的 Agent 端单元测试
- 4 个 Fix 全部完成后运行全量测试（relay + agent + e2e）
- 模拟器测试验证 App 端行为
