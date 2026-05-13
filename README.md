# MyChat

通过手机远程控制 Mac 上的 Claude CLI，实现随时随地的 AI 对话。

## 架构

```
┌──────────┐    WebSocket     ┌──────────┐    WebSocket     ┌──────────────┐
│  Android │ ◄──────────────► │  Relay   │ ◄──────────────► │  Mac Agent   │
│  App     │   E2E Encrypted  │  Server  │   E2E Encrypted  │  (Claude CLI)│
└──────────┘                  └──────────┘                  └──────────────┘
```

- **Android App** — Kotlin/Jetpack Compose，负责 UI 和用户交互
- **Relay Server** — Node.js WebSocket 中继，部署在远程服务器（pm2 守护）
- **Mac Agent** — Node.js 桌面客户端（launchctl 常驻），管理 Claude CLI 进程

## 端到端加密

使用 ECDH (P-256) 密钥交换 + AES-256-GCM 加密：

1. Mobile 发起 `key_init`，Desktop 响应 `key_response`
2. 双方通过 ECDH 协商出共享密钥
3. 所有业务消息（chat、permission、mode 等）均加密传输

## 快速开始

### Relay Server（远程服务器）

```bash
cd relay
npm install
MYCHAT_PORT=9090 MYCHAT_USER=username MYCHAT_PASS_HASH='bcrypt-hash' node server.js
```

使用 pm2 守护进程：

```bash
pm2 start server.js --name mychat-relay -- --env production
```

### Mac Agent

```bash
cd agent
npm install
MYCHAT_RELAY_URL=ws://your-server:9090 MYCHAT_USER=username MYCHAT_PASS=password node agent.js
```

使用 launchctl 开机自启：

```bash
# 生产环境
cp agent/com.mychat.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mychat.agent.plist

# 测试环境（9091 端口）
cp agent/com.mychat.agent.sit.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mychat.agent.sit.plist
```

### Android App

```bash
cd app

# SIT 测试版（MyChat-SIT，连接 9091 端口）
./gradlew assembleDebug

# 生产版（MyChat，连接 9090 端口）
./gradlew assembleRelease
```

APK 输出路径：
- 测试版：`app/build/outputs/apk/debug/MyChat-SIT-1.0.0.apk`
- 生产版：`app/build/outputs/apk/release/MyChat-1.0.0.apk`

### 环境配置

Relay 服务器地址在 `app/gradle.properties` 中配置，修改后重新编译即可切换：

```properties
RELAY_URL_SIT=ws://121.41.103.157:9091
RELAY_URL_PROD=ws://121.41.103.157:9090
```

| | SIT (debug) | Production (release) |
|---|---|---|
| applicationId | com.mychat.sit | com.mychat |
| App 名称 | MyChat-SIT | MyChat |
| 默认 Relay | 9091 端口 | 9090 端口 |
| 可同时安装 | 是 | 是 |

## 项目结构

```
MyChat/
├── agent/              # Mac 桌面客户端
│   ├── agent.js        # Agent 主程序（消息缓冲 + 环境日志）
│   ├── claude-cli.js   # Claude CLI 进程管理（会话跟踪 + 模式控制）
│   ├── session.js      # 会话 ID 持久化（~/.mychat/session.json）
│   ├── crypto.js       # 加密模块（ECDH + AES-GCM）
│   └── store.js        # SQLite 消息存储
├── relay/              # WebSocket 中继服务器
│   ├── server.js       # 服务端入口
│   ├── router.js       # 消息路由
│   ├── crypto.js       # 加密模块
│   └── test/           # 测试
│       ├── test-relay.js    # 中继服务器测试（22 assertions）
│       ├── test-e2e.js      # 端到端集成测试（21 assertions）
│       ├── test-timing.js   # 连接时序/重连/心跳/异常测试（31 assertions）
│       └── test-notification.js # 通知与复合场景测试（77 assertions）
├── agent/test/
│       ├── test-session.js  # 会话持久化测试（30 assertions）
│       └── test-fixes.js    # Bug 修复验证测试（21 assertions）
└── app/                # Android 应用
    └── app/src/main/java/com/mychat/
        ├── data/
        │   ├── api/RelayClient.kt     # WebSocket 客户端
        │   ├── crypto/                # ECDH + AES 加密
        │   └── db/                    # Room 数据库
        ├── notification/NotificationHelper.kt  # 通知管理
        ├── service/ChatService.kt     # 前台服务（后台保活）
        └── ui/                        # Jetpack Compose UI
```

## 测试

```bash
# 中继服务器测试
node relay/test/test-relay.js

# 端到端集成测试
node relay/test/test-e2e.js

# 通知与复合场景测试（19个场景，含9个图片场景）
node relay/test/test-notification.js

# 连接时序 & 重连 & 心跳 & 异常测试（10个场景）
node relay/test/test-timing.js

# Mac Agent 测试
node agent/test/test-agent.js

# 会话持久化测试（6个场景）
node agent/test/test-session.js

# 全部运行（181 个断言）
```

## 更新日志

### v1.5 — Bug 修复与稳定性增强
- **Fix 1: 消息缓冲机制**（修复 Bug 2, 9）
  - Agent 层新增 `pendingMessages` 缓冲区，CLI 输出不再因 WebSocket 断开而静默丢弃
  - 连接恢复（密钥交换完成）后自动回放缓冲消息
  - 修复 interrupt 在 CLI 已完成时无法结束 App 等待状态的问题
  - App 后台收到回复时通知正常弹出（依赖 chat_complete 事件可靠送达）
- **Fix 2: 会话管理增强**（修复 Bug 1, 3）
  - 新增 `_resumeSessionId` 跟踪，检测 CLI session_id 变化并通知 App
  - 上下文溢出重置会话前发送 `session_changed` 通知
  - App 显示系统消息提示会话状态变化
  - MessageBubble 新增 `system` 角色消息样式（居中灰色文字）
- **Fix 3: 模式系统修复**（修复 Bug 7）
  - 使用 Claude CLI `--permission-mode` 参数控制模式行为
  - `plan` 模式：`--permission-mode plan`，纯讨论不执行工具
  - `auto` 模式：`--dangerously-skip-permissions`，跳过所有权限检查
  - `default` 模式：`--permission-mode default`，CLI 按默认规则处理权限
  - 新增 `permission_request`/`choice_request` 消息类型处理
  - `respondPermission`/`respondChoice` 现在写入 CLI stdin
- **Fix 4: 环境隔离验证**（修复 Bug 10）
  - `ecosystem.config.json` 新增 SIT relay 配置
  - Agent 启动日志增加环境信息（MYCHAT_ENV、Session 路径、数据库路径）
- **新增协议消息**：`session_changed`、`SessionResetOk`
- **新增 RelayEvent 类型**：`SessionChanged`、`SessionResetOk`
- 新增 21 个修复验证测试，全量测试（relay 22 + e2e 21 + notification 77 + timing 31 + agent 24 + session 30 + fix 21 = 226 assertions）全部通过

### v1.4 — 图片识别
- App 端新增图片选择按钮（输入栏左侧），支持从相册选择图片
- 图片压缩：最大 1024x1024，JPEG 70%，base64 编码后加密发送
- Mac Agent 接收 image_message，保存图片到 ~/.mychat/images/，将路径传给 Claude CLI 分析
- Claude 使用 Read 工具读取图片文件，分析结果通过 chat_reply 返回 App
- MessageBubble 支持 contentType="image" 显示图片缩略图
- 协议层新增：imageMessage(imageBase64, text) + image_ack(success)
- 测试新增 9 个图片场景（27 assertions），总计 77 assertions 全部通过

### v1.3 — SIT 测试环境隔离
- Debug 构建：applicationId=com.mychat.sit，App 名=MyChat-SIT，连接 9091 端口
- Release 构建：applicationId=com.mychat，连接 9090 端口
- 两个 APK 可同时安装共存，测试与生产完全隔离
- Relay URL 配置外置到 gradle.properties，一键切换环境
- APK 文件名自动区分：MyChat-SIT-1.0.0.apk / MyChat-1.0.0.apk
- 新增 SIT agent plist（com.mychat.agent.sit）连接测试 relay

### v1.2 — 后台保活与通知优化
- 新增 ChatService 前台服务：App 进入后台时自动启动，保持 WebSocket 连接不断
- 前台服务通知使用 IMPORTANCE_MIN，状态栏无图标、无声音、几乎无感
- App 回到前台时自动停止前台服务，通知消失
- 回复通知添加 setTimeoutAfter(5s) 自动消失（类似微信横幅通知）
- 通知渠道添加 lockscreenVisibility=PUBLIC，锁屏可见
- 点击通知 Intent 改用 CLEAR_TOP|SINGLE_TOP，保留聊天状态不重建
- 补充 3 个前后台切换场景测试 + NotificationHelper 通知渠道配置测试

### v1.1 — 通知与 UI 优化
- NotificationHelper 改进：PendingIntent 点击打开 App、POST_NOTIFICATIONS 权限检查
- 新增权限确认通知（PermissionRequest）和选择请求通知（ChoiceRequest）
- App 后台时弹出通知，点击通知直接打开对话界面
- MessageBubble 文本选择高亮优化：用户/助手气泡使用对比色
- 补充 10 个通知与复合场景测试（47 assertions，结合连接+会话+通知三重要素）

### v1.0 — 会话持久化
- 新增 session.js：Claude CLI session_id 持久化到 ~/.mychat/session.json
- Agent 重启/崩溃后自动恢复会话上下文（--resume）
- 多次 CLI 调用更新 session_id 时保留原始 createdAt
- 损坏 session.json 优雅降级，不导致崩溃
- 补充 6 个会话持久化测试场景（30 assertions）

### v0.2 — 连接稳定性增强
- 修复 relay heartbeat pongTimer 泄漏导致连接被误断
- Agent 添加应用层心跳（25s ping）
- Agent 添加 device_status 触发的主动密钥交换
- 修复 launchctl 环境下 claude CLI 找不到的问题（PATH 补全）
- 修复 launchctl plist 配置（node 路径、连接参数）
- RelayClient 添加 try/catch 防止解密异常导致 WebSocket 断连
- ECDHCrypto 添加 completeHandshake null check
- 补充 10 个连接时序/重连/心跳/异常测试场景
- ChatScreen UI 优化：分离键盘弹收与新消息滚动逻辑
- MessageBubble 支持 Markdown 渲染和文本选择
