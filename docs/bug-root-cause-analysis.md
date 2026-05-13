# P0/P1 Bug 根因分析报告

## P0 Bugs

### Bug 2: 切后台→切回→收不到回复，点终止才收到

**复现路径：**
1. App 发送消息 → Agent 启动 CLI 进程 → `isResponding = true`
2. App 切后台 → WebSocket 断开（网络波动或系统回收）
3. CLI 继续运行，产出回复 → Agent `onReply` 回调检查 `crypto.ready && ws.readyState === 1` → **不满足，回复被静默丢弃**
4. CLI 完成 → `onComplete` 回调同样被丢弃（ws 不通）
5. App 切回前台 → WebSocket 重连 → 新密钥交换
6. 但 CLI 进程已结束，`isResponding` 在 Agent 端已经是 `false`
7. App 端 `isResponding` 仍为 `true`（没收到 `chat_complete`）
8. 用户点终止 → 发送 `interrupt` → Agent 的 `cli.interrupt()` 检查 `this.isResponding` → 已经是 `false` → **无反应**

**根因：** Agent 的 `onReply`/`onComplete` 回调在连接断开时静默丢弃消息。CLI 已完成的回复不会重发。`interrupt()` 也因 `isResponding` 已为 false 而失效。

**涉及文件：** `agent/agent.js` L46-57, `agent/claude-cli.js` L94-99

---

### Bug 3: 会话一会儿记得一会儿不记得

**复现路径：**
1. 用户正常对话多轮 → session.json 持久化 session_id → CLI `--resume` 恢复上下文
2. 对话越来越长 → CLI 上下文溢出
3. `claude-cli.js` L169-178 检测到上下文溢出 → `session.clear()` 清除 session → 重试
4. 重试时无 session_id → CLI 开始全新会话 → Claude 不记得之前的内容
5. 用户感知：前面记得、突然不记得了

**另一个场景：**
- Agent 重启 → `Session._load()` 从文件恢复 → 正常
- 但如果 CLI 进程被 `_kill()` 杀死时，最后的 session_id 可能还没通过输出传递回来
- 下次 `sendMessage` 可能用的是过期的 session_id → CLI 无法恢复 → 新会话

**根因：**
1. 上下文溢出时 `session.clear()` 会重置会话（设计如此，但用户不知情）
2. `_kill()` 强杀进程可能导致最新 session_id 未保存
3. 无任何通知告知用户会话已重置

**涉及文件：** `agent/claude-cli.js` L169-178, `agent/session.js` L54-59

---

### Bug 7: default 模式没有真正起作用，改动自动执行了

**复现路径：**
1. 用户在 App 选择 `default` 模式 → 发送 `set_mode`
2. Agent 调用 `cli.setMode('default')` → `this.mode = 'default'`
3. 用户发消息 → `_startCli()` → 不加 `--dangerously-skip-permissions`
4. 但 CLI 使用 `-p` (非交互模式) → **无法弹出交互式权限确认**
5. CLI 在 `-p` 模式下自行决定是否执行工具使用 → 大部分工具自动执行
6. 同时，`respondPermission()` 和 `respondChoice()` 方法体为空（仅 log）
7. CLI 即使输出权限请求 → `_handleJsonMessage` 没有处理权限类型的消息
8. → 权限请求被忽略，CLI 可能默认允许或跳过

**根因：**
1. Claude CLI 的 `-p` 模式是非交互的，不支持运行时权限确认
2. Agent 的权限/选择响应函数是空实现（`claude-cli.js` L113-119）
3. `_handleJsonMessage` 不处理 CLI 输出的权限请求消息类型

**涉及文件：** `agent/claude-cli.js` L40-41, L113-119, L143-183

---

## P1 Bugs

### Bug 1: 切换模式后会话丢失

**与 Bug 3 同根。** `setMode()` 本身不清除会话（`claude-cli.js` L102-106），session_id 保持不变。

但用户感知"切换模式后丢失"是因为：
1. 之前对话积累了大量上下文
2. 切换模式后发消息 → CLI `--resume` → 上下文溢出 → session.clear()
3. 用户将丢失归因于"模式切换"，实际是上下文溢出

**根因：** Bug 3 的上下文溢出问题，用户误关联到模式切换

**涉及文件：** 同 Bug 3

---

### Bug 10: SIT 和生产环境共享同一个对话

**代码分析：**
- Mac Agent 侧：Session 和 Store 都通过 `MYCHAT_ENV` 隔离路径（`session.js` L9, `store.js` L9）
  - 生产：`~/.mychat/session.json`, `agent/data/chat.db`
  - SIT：`~/.mychat/sit/session.json`, `agent/data/sit/chat.db`
- Relay 侧：两个独立 pm2 进程（9090 和 9091），各自独立的 Router 实例
- App 侧：不同的 applicationId（`com.mychat` vs `com.mychat.sit`），独立数据目录

**实际发现的问题：**
1. 验证 `~/.mychat/sit/` 不存在 → SIT agent 从未持久化过 session
2. 两个 relay 使用相同用户名密码（`rains2009`），但端口不同，不会串流
3. `ecosystem.config.json` 只定义了生产 relay，SIT relay 是单独启动的

**根因假设：** 隔离代码逻辑正确，但最可能的场景是：
- 用户曾用 SIT app 连接到生产 relay（SIT relay 可能曾停机），导致消息发到了生产环境
- 或两个 Agent 共享同一个 Claude CLI 实例，CLI 的全局状态（如 `~/.claude/`）可能造成上下文混淆
- 需要实际运行时日志确认

**涉及文件：** `agent/session.js` L9, `agent/store.js` L9, `relay/ecosystem.config.json`

---

### Bug 9: 通知功能失效

**复现路径：**
1. App 收到 `ChatReply` → `replyBuffer.append(event.content)` → `isResponding = true`
2. 收到 `ChatComplete` → `isResponding = false` → 检查 `replyBuffer`
3. 如果 `content.isNotEmpty()` → 保存消息 → 检查 `!isAppForeground` → 弹通知

**问题分析：**
1. `isAppForeground` 在 `MainActivity.onResume/onPause` 中设置 → 逻辑正确
2. `NotificationHelper.showReplyNotification` 先调用 `canPostNotifications` 检查权限 → 可能权限未授予
3. 但更关键的问题：`ChatViewModel.handleEvent` 中的 `replyBuffer` 收集逻辑：
   - 每个 `ChatReply` 都 `_isResponding.value = true`
   - 只有 `ChatComplete` 时才保存和通知
   - **如果 `ChatComplete` 事件丢失**（Bug 2 的根因），通知永远不会弹出

**根因：**
1. 通知依赖 `ChatComplete` 事件，但该事件在连接不稳定时会丢失（Bug 2）
2. 即使 `ChatComplete` 到达，Android 13+ 需要 `POST_NOTIFICATIONS` 运行时权限，`canPostNotifications` 会返回 false
3. 前台服务通知可能抢占通知渠道

**涉及文件：** `ChatViewModel.kt` L162-180, `NotificationHelper.kt` L55-68, L114-116
