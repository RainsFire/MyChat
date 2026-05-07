# MyChat — 项目设计文档

---

## 第一部分：用户需求

### 1.1 核心使用场景

用户通过 Android 手机远程控制 Mac 上的 Claude Code CLI，实现随时随地编程、文件操作、系统管理等任务。

**系统拓扑：**
```
Android 手机 ←WS→ 阿里云中继服务器 ←WS→ Mac (Claude CLI)
```

### 1.2 功能需求清单

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 聊天对话 | 手机发送消息，Mac Claude CLI 回复，支持连续发送多条 | P0 |
| 流式回复显示 | 显示"响应中"状态，完整回复后一次性显示 | P0 |
| 权限模式切换 | Auto（完全自主）/ Default（需审批）/ Plan（只规划），实时切换 | P0 |
| 权限审批 | Default 模式下，Claude 操作需手机端弹窗审批 | P0 |
| 多选交互 | Claude 提供选项列表时，手机端弹窗选择 | P0 |
| 中断操作 | 点击停止按钮中断 Claude 当前操作（等效 ESC） | P0 |
| 用户认证 | 用户名+密码登录，登录后自动连接 | P0 |
| 离线消息 | 手机消息本地暂存，PC 上线后自动发送 | P0 |
| 连接状态 | 显示连接状态（已连接/断开/连接中），自动重连 | P0 |
| 后台通知 | App 在后台且 Claude 回复完成时弹出系统通知 | P0 |
| 清空历史 | 手机端支持清空聊天记录 | P1 |
| 崩溃日志 | App 崩溃后下次启动自动推送日志到 Mac 端 | P1 |
| 工作目录 | Agent cwd = ~，Claude 使用绝对路径访问 Mac 任意位置 | P0 |

### 1.3 补充需求（边界场景和冲突处理）

#### 多条消息回复归属

不关联。Claude CLI 交互模式下多条消息整体处理，Mac 端发送的所有 `chat_reply` 为综合回复。手机端收到 `chat_complete` 时将所有 `status=PENDING` 的消息统一更新为 `SENT`。

#### 登录失败处理

| 错误类型 | 提示文案 | 处理 |
|---------|---------|------|
| 密码错误 | "用户名或密码错误" | 回到登录页重新输入 |
| 网络不可达 | "无法连接服务器，请检查网络" | 显示重试按钮 |
| 服务器错误 | "服务器暂时不可用" | 显示重试按钮 |

不自动重试登录（避免密码错误时无限重试）。

#### 连接中断时审批对话框

WebSocket 断开时：关闭所有弹窗（审批/选择）→ 提示"连接已断开，操作已取消" → Mac 端向 CLI stdin 写入 n（拒绝）让 CLI 继续运行。

#### 模式切换与进行中操作

切换前检查是否有等待审批的请求或未完成的回复：
- 有 → 提示"Claude 正在执行任务，切换模式将中断当前操作，是否继续？"→ 用户确认后 interrupt + 重启 CLI
- 无 → 直接切换

#### 离线消息发送

离线消息发送时使用当前模式设置。

#### 消息发送失败 UI

发送失败的消息：红色气泡 + 右侧重试图标（↻），点击重试。错误类型：
- 网络断开："发送失败，网络不可用"
- 加密失败："发送失败，请重试"
- 超时："发送超时"

testTag: `message_retry_{id}`

#### Android 系统权限

| 权限 | 用途 | 处理 |
|------|------|------|
| INTERNET | 网络通信 | 自动授予 |
| POST_NOTIFICATIONS | 后台通知（Android 13+） | 启动时请求，拒绝则通知功能静默降级 |
| FOREGROUND_SERVICE | 后台保持连接（可选） | 后期按需添加 |

#### WS 明文流量（Android 9+）

AndroidManifest 配置 `android:usesCleartextTraffic="true"`，并添加 `network_security_config.xml` 允许指定域名的 WS 明文连接。

#### 日志管理

按天滚动，保留最近 7 天。

### 1.4 非功能需求

| 需求 | 描述 |
|------|------|
| 稳定性 | 解决老项目闪退问题，冷启动/切后台/断网重连均不崩溃 |
| 安全性 | WS + 应用层 ECDH/AES-256-GCM 加密，消息内容中继无法读取 |
| 可测试性 | 所有 UI 元素带 testTag，支持自动化测试快速定位 |
| 可扩展性 | 数据模型预留字段，后期支持图片/文件/多会话 |
| 可维护性 | 三端统一日志系统，异常完整记录 |

### 1.5 不包含（前期）

- 手机直调 Claude API
- 文件传输
- 消息撤回/编辑
- 多会话管理
- 图片发送/接收

### 1.6 后期扩展计划

- 图片发送/接收/识别
- 文件发送/接收
- 会话列表/多会话管理

### 1.7 待办功能（已评估）

#### 通用二进制分块传输协议（基础设施）

所有文件类传输共用统一传输层，分块（64KB）走现有 `encrypted` 加密通道，Relay 服务器无需改动。

协议流程：`file_transfer_start` → `file_transfer_chunk`（循环）→ `file_transfer_complete` → `file_transfer_ack`

| 组件 | 改动 |
|------|------|
| RelayProtocol.kt | 新增 4 个协议函数（start/chunk/complete/ack） |
| RelayClient.kt | 新增 sendFile() / onFileReceived 回调 |
| FileTransfer.kt（新） | 分块、拼装、校验、进度回调 |
| Agent agent.js | 处理 file_transfer 消息，保存文件到磁盘 |
| MessageEntity | 新增 contentType（text/image/file）和 filePath 字段 |

#### 待办 1：图片识别（P0，独立功能）— **v1 已实现**

App 选择/拍摄图片 → base64 加密发送给 Mac → Agent 保存为文件 → 将路径传给 Claude CLI 识别 → 结果返回 App。

- 不走分块传输层，走独立轻量逻辑
- App 端：图片选择器 + base64 编码发送（压缩到 1024x1024, JPEG 70%）
- Mac 端：保存文件到 `~/.mychat/images/` + 把路径作为消息发给 Claude CLI
- 协议：`image_message` (imageBase64 + text) → `image_ack` (success)
- 测试：70 个断言全部通过，覆盖加密转发、重连、大图、交错等 17 个场景

#### 待办 2：传输层 + 自动更新（P1）

- Phase 1：实现 FileTransfer 分块传输协议 + Agent 端接收保存
- Phase 2：自动更新 — App 启动检查版本 → 请求 Mac 发 APK → 下载安装
- Mac 端放 APK 文件，App 通过传输层下载后调用系统安装器
- 需新增 `REQUEST_INSTALL_PACKAGES` 权限 + FileProvider 配置

#### 待办 3：图片传输（P2，双向）

复用传输层。App/Mac 互相发送图片文件 → 接收端保存 → 聊天气泡展示。

- App 端：相册/拍照 → 压缩 → 分块传输
- Mac 端：接收保存 → 聊天气泡展示
- UI：图片气泡 + 缩略图

#### 待办 4：文件传输（P3，双向）

复用传输层。App/Mac 互相发送任意文件 → 接收端保存 → 文件卡片展示。

- App 端：文件选择器 → 分块传输
- Mac 端：接收保存到指定目录
- UI：文件卡片（文件名、大小、类型）

---

## 第二部分：设计架构 & 方案（用户阅读版）

### 2.1 系统整体架构

三端组成：
- **Android App** — 手机端聊天界面，发送消息、接收回复、权限审批、模式切换
- **云中继服务器** — 阿里云部署，负责认证和消息转发，不存储任何消息
- **Mac 桌面客户端** — 常驻后台，管理 Claude CLI 进程，解析 CLI 输出转发到手机

### 2.2 核心设计思路

#### 解决闪退问题

老项目根因：Singleton ViewModel 内存泄漏、Job 管理失控、数据库无事务保护。

解决方案：
- ViewModel 使用 Hilt + ViewModelProvider（非静态）
- Kotlin structuredConcurrency（协程自动取消）
- Room 数据库全部 @Transaction
- 连接状态机严格定义状态转换，杜绝非法状态

#### 解决连接中断问题

老项目根因：无超时、无状态检查、加密失败静默丢弃。

解决方案：
- 每个连接阶段有明确超时（认证 10s、握手 15s、心跳 60s）
- 状态机驱动：DISCONNECTED → CONNECTING → AUTHENTICATING → HANDSHAKING → CONNECTED
- 加密失败提示用户重试，不静默丢弃
- 自动重连：连接断开后 3 秒自动重连，用户主动退出不触发
- 应用层心跳：每 25 秒发送 ping，防止 relay 60 秒超时

#### 实现 CLI 交互

Agent 使用 Claude CLI **`-p` 单次模式**（每次消息启动新进程）：

```
用户发消息 → claude -p "text" --output-format stream-json --verbose → 解析 stdout → 转发到手机
```

通过 `--resume <session_id>` 保持多轮对话上下文。每条消息独立进程，不会因 CLI 崩溃影响整体稳定性。

#### 实现完整 CLI 交互

Agent 使用 Claude CLI **交互模式**（常驻进程），而非一次性 `-p` 模式：

```
用户发消息 → 写入 stdin → Claude 处理 → 读取 stdout → 转发到手机
```

Agent 解析 stdout 区分三种输出：
1. **聊天回复** → 转发 `chat_reply` / `chat_complete`
2. **权限请求** → 转发 `permission_request`，等待手机审批
3. **选项列表** → 转发 `choice_request`，等待手机选择

### 2.3 用户界面设计

**主界面布局：**
```
┌─────────────────────────────────────┐
│ [状态栏] 🟢已连接  [Auto▼] [⚙]       │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────┐       │
│  │ 用户：帮我写一个函数      │       │
│  └─────────────────────────┘       │
│                                     │
│       ┌─────────────────────────┐  │
│       │ Claude：好的，我来帮你... │  │
│       └─────────────────────────┘  │
│                                     │
├─────────────────────────────────────┤
│ [输入框................] [发送/停止] │
└─────────────────────────────────────┘
```

**交互弹窗：**

| 弹窗类型 | 触发条件 | 内容 |
|---------|---------|------|
| 审批对话框 | Default 模式下 Claude 请求执行操作 | 显示操作类型和详情，「允许」「拒绝」按钮 |
| 选择对话框 | Claude 提供选项列表 | 单选列表，点击一项立即响应 |
| 设置对话框 | 点击齿轮图标 | 「清空聊天记录」「退出登录」 |

### 2.4 权限模式说明

| 模式 | CLI 标志 | 行为 | 适合场景 |
|------|---------|------|---------|
| Auto | `--dangerously-skip-permissions` | Claude 完全自主执行，无需审批 | 信任 Claude 自动完成任务 |
| Default | 默认模式 | 每个工具调用需手机端审批 | 需要控制 Claude 操作 |
| Plan | plan mode | 只规划不执行 | 先看方案再决定是否执行 |

### 2.5 数据存储

- **手机端**：Room + SQLCipher 加密数据库，聊天记录本地存储
- **Mac 端**：better-sqlite3，聊天记录本地存储
- **中继服务器**：不存储任何消息，只转发

两端独立存储，不做同步。

### 2.6 安全设计

- **传输加密**：WS（非 WSS）+ 应用层 ECDH P-256 密钥交换 + AES-256-GCM 加密
- **密钥存储**：Android Keystore 保护私钥
- **中继无法读取**：消息内容加密，中继只能看到 encrypted 类型，无法解密 payload

---

## 第三部分：测试案例库

### 3.1 测试矩阵

| 测试类型 | 覆盖范围 | 优先级 |
|---------|---------|--------|
| 冒烟测试 | 启动/连接/发送消息/接收回复 | P0 |
| 功能测试 | 所有功能需求场景 | P0 |
| 单元测试 | 加密/协议解析/数据库操作 | P1 |
| 白盒测试 | 状态机转换/错误处理逻辑 | P1 |
| 黑盒测试 | 用户交互/UI 响应 | P1 |
| 边界测试 | 网络中断/超时/大数据量 | P2 |
| 压力测试 | 频繁重连/连续发送 | P2 |

### 3.2 冒烟测试（P0）

| ID | 测试项 | 步骤 | 预期结果 |
|----|--------|------|---------|
| SM-01 | 首次启动 | 安装 APK → 启动 | 不崩溃，显示登录界面 |
| SM-02 | 登录连接 | 输入用户名密码 → 点击登录 | 显示"已连接"，状态栏变绿 |
| SM-03 | 发送消息 | 输入文字 → 点击发送 | 消息显示在列表中，状态变为"响应中" |
| SM-04 | 接收回复 | 等待 Claude 回复完成 | 回复完整显示，"响应中"消失 |
| SM-05 | 切后台返回 | 按 Home → 切回 App | 不崩溃，状态恢复正常 |
| SM-06 | 断网重连 | 关闭网络 → 打开网络 | 显示"断开"→ 自动重连 → 显示"已连接" |
| SM-07 | 模式切换 | 点击模式选择器 → 选择 Auto | 模式切换成功，后续操作无需审批 |

### 3.3 功能测试（P0）

#### 聊天对话

| ID | 测试项 | 前置条件 | 步骤 | 预期结果 |
|----|--------|---------|------|---------|
| FT-01 | 单条消息发送 | 已连接 | 输入"Hello" → 发送 | 消息显示，收到回复 |
| FT-02 | 连续发送多条 | 已连接 | 发送第一条 → 立即发送第二条 | 两条都发送成功，排队处理 |
| FT-03 | 离线发送 | Mac 离线 | 输入消息 → 发送 | 消息显示，状态为"待发送"，提示"PC离线" |
| FT-04 | 离线消息自动发送 | 有待发送消息 | Mac 上线 | 待发送消息自动发送，状态变为"已发送" |
| FT-05 | 长文本发送 | 已连接 | 输入 >1000 字 → 发送 | 发送成功，回复正常 |
| FT-06 | Emoji 发送 | 已连接 | 输入"Hello 👋😊" → 发送 | Emoji 显示正确 |
| FT-07 | 空输入发送 | 已连接 | 输入框空 → 点击发送 | 不发送，无变化 |

#### 权限模式

| ID | 测试项 | 前置条件 | 步骤 | 预期结果 |
|----|--------|---------|------|---------|
| FT-08 | Auto 模式 | 已连接，Auto 模式 | Claude 执行操作 | 无审批弹窗，直接执行 |
| FT-09 | Default 模式审批 | 已连接，Default 模式 | Claude 请求执行命令 | 弹出审批对话框 |
| FT-10 | 审批允许 | 审批对话框弹出 | 点击「允许」 | Claude 继续执行 |
| FT-11 | 审批拒绝 | 审批对话框弹出 | 点击「拒绝」 | Claude 取消操作 |
| FT-12 | Plan 模式 | 已连接，Plan 模式 | 发送消息 | Claude 只返回规划，不执行 |
| FT-13 | 模式切换 | 已连接，Default 模式 | 切换到 Auto → 发送消息 | 无审批弹窗 |

#### 中断操作

| ID | 测试项 | 前置条件 | 步骤 | 预期结果 |
|----|--------|---------|------|---------|
| FT-14 | 中断响应 | Claude 正在响应 | 点击停止按钮 | 响应停止，状态恢复 |
| FT-15 | 中断后继续 | 响应被中断 | 输入新消息 → 发送 | 正常发送和回复 |

#### 多选交互

| ID | 测试项 | 前置条件 | 步骤 | 预期结果 |
|----|--------|---------|------|---------|
| FT-16 | 选择选项 | Claude 提供选项列表 | 弹窗显示 → 点击选项2 | 选择成功，Claude 继续 |
| FT-17 | 取消选择 | 选择对话框弹出 | 按 Home 切后台 | 选择对话框保持，回到前台可继续选择 |

#### 后台通知

| ID | 测试项 | 前置条件 | 步骤 | 预期结果 |
|----|--------|---------|------|---------|
| FT-18 | 后台回复完成通知 | App 在后台 | Claude 回复完成 | 弹出系统通知"Claude 等待你的输入" |
| FT-19 | 前台不通知 | App 在前台 | Claude 回复完成 | 不弹出通知，直接显示回复 |
| FT-20 | 点击通知打开 | 收到通知 | 点击通知 | 打开 App，显示聊天界面 |

#### 其他功能

| ID | 测试项 | 前置条件 | 步骤 | 预期结果 |
|----|--------|---------|------|---------|
| FT-21 | 清空历史 | 有聊天记录 | 点击设置 → 清空历史 → 确认 | 所有消息删除 |
| FT-22 | 退出登录 | 已登录 | 点击设置 → 退出登录 | 返回登录界面 |
| FT-23 | 自动登录 | 曾登录成功 | 重新启动 App | 自动连接，无需重新登录 |

#### 错误处理与边界场景

| ID | 测试项 | 前置条件 | 步骤 | 预期结果 |
|----|--------|---------|------|---------|
| FT-24 | 发送失败重试 | 网络断开 | 发送消息 → 点击重试图标 | 消息重新发送 |
| FT-25 | 连接中断关闭审批 | 审批对话框弹出 | 断开网络 | 对话框关闭，提示"连接已断开" |
| FT-26 | 模式切换中断操作 | Claude 执行中 | 切换模式 → 确认 | 操作中断，CLI 重启新模式 |
| FT-27 | 通知权限拒绝 | 首次启动 | 拒绝通知权限 → App 在后台 | 不弹通知，其他功能正常 |
| FT-28 | 登录错误提示 | 首次启动 | 输入错误密码 | 提示"用户名或密码错误" |
| FT-29 | 网络不可达 | 无网络 | 点击登录 | 提示"无法连接服务器"，显示重试按钮 |

### 3.4 单元测试（P1）

| ID | 测试模块 | 测试项 | 预期结果 |
|----|---------|--------|---------|
| UT-01 | ECDHCrypto | 密钥交换 | 两端计算出相同共享密钥 |
| UT-02 | AESCipher | 加密解密 | 加密后解密得到原文 |
| UT-03 | AESCipher | 加密失败处理 | 无效密钥返回错误，不崩溃 |
| UT-04 | RelayProtocol | JSON 解析 | 正确解析所有消息类型 |
| UT-05 | RelayProtocol | 无效类型 | 未知 type 返回解析错误 |
| UT-06 | MessageDao | 插入消息 | 消息插入成功，ID 返回 |
| UT-07 | MessageDao | 查询待发送 | 正确返回所有 status=pending 的消息 |
| UT-08 | MessageDao | 更新状态 | 状态从 pending → sent 更新成功 |
| UT-09 | ChatRepository | 事务完整性 | 插入失败时回滚，不留脏数据 |

### 3.5 白盒测试（P1）

| ID | 测试模块 | 测试项 | 预期结果 |
|----|---------|--------|---------|
| WB-01 | RelayClient 状态机 | DISCONNECTED → CONNECTING | 状态转换成功 |
| WB-02 | RelayClient 状态机 | CONNECTING → AUTHENTICATING | 认证成功后转换 |
| WB-03 | RelayClient 状态机 | AUTHENTICATING → HANDSHAKING | 握手成功后转换 |
| WB-04 | RelayClient 状态机 | HANDSHAKING → CONNECTED | 握手完成后转换 |
| WB-05 | RelayClient 状态机 | 任意状态 → ERROR → DISCONNECTED | 错误时回退并自动重连 |
| WB-06 | RelayClient 状态机 | 非法转换 | 拒绝转换，保持原状态或报错 |
| WB-07 | RelayClient | 连接失败自动重连 | onFailure 后 3 秒触发 scheduleReconnect |
| WB-08 | RelayClient | 心跳超时 | 25s 应用层 ping 防止 relay 60s 超时 |
| WB-09 | RelayClient | 用户退出不重连 | intentionalDisconnect=true 时不触发 scheduleReconnect |
| WB-09 | ChatViewModel | 协程取消 | onCleared() 时所有协程取消 |
| WB-10 | claude-cli.js | stdout 解析 | 正确区分 chat/permission/choice |
| WB-11 | claude-cli.js | ESC 写入 | 收到 interrupt 写入 \x1b |
| WB-12 | claude-cli.js | 进程崩溃 | 自动重启，恢复 session |

### 3.6 黑盒测试（P1）

| ID | 测试项 | 步骤 | 预期结果 |
|----|--------|------|---------|
| BB-01 | UI 元素定位 | 自动化测试通过 testTag 定位 | 所有元素可定位 |
| BB-02 | 输入框交互 | 点击输入框 → 键盘弹出 | 键盘正常弹出 |
| BB-03 | 消息列表滚动 | 快速上下滚动 | 流畅，无卡顿 |
| BB-04 | 状态栏颜色 | 已连接/断开/连接中 | 绿/红/黄对应显示 |
| BB-05 | 停止按钮显示 | Claude 响应中 | 显示红色停止按钮 |
| BB-06 | 停止按钮隐藏 | Claude 响应完成 | 停止按钮变为发送按钮 |
| BB-07 | 对话框关闭 | 审批对话框弹出 → 点击外部 | 不关闭（必须选择） |
| BB-08 | 横屏显示 | 旋转屏幕 | 界面适配正确 |

### 3.7 边界测试（P2）

| ID | 测试项 | 前置条件 | 步骤 | 预期结果 |
|----|--------|---------|------|---------|
| BD-01 | 网络超慢 | 模拟 2G 网络 | 发送消息 | 最终发送成功或超时提示 |
| BD-02 | 网络频繁切换 | WiFi ↔ 4G 切换 | 连续切换 10 次 | 每次自动重连成功 |
| BD-03 | 大量消息 | 100 条消息 | 快速发送 | 不崩溃，排队处理 |
| BD-04 | Mac 长时间离线 | Mac 离线 1 小时 | 手机发送消息 | 消息暂存，无丢失 |
| BD-05 | Claude 超长回复 | 回复 >10000 字 | 接收回复 | 完整显示，无截断 |
| BD-06 | 低内存 | 模拟内存不足 | 切其他大 App → 回来 | App 不崩溃，数据恢复 |

### 3.8 压力测试（P2）

| ID | 测试项 | 步骤 | 预期结果 |
|----|--------|------|---------|
| ST-01 | 频繁重连 | 断网 → 连网 重复 50 次 | 每次重连成功，无崩溃 |
| ST-02 | 连续发送 | 连续发送 100 条消息 | 全部发送成功，无丢消息 |
| ST-03 | 长时间运行 | App 连续运行 8 小时 | 内存不泄漏，连接稳定 |
| ST-04 | 频繁模式切换 | Auto ↔ Default ↔ Plan 重复 20 次 | 每次切换成功，CLI 正常重启 |

---

## 第四部分：需要记录的其他内容

### 4.1 项目目录结构

```
/Users/alex/MyChat/
├── relay/                    # 云中继服务器 (Node.js)
│   ├── package.json
│   ├── server.js             # HTTP + WebSocket 服务器
│   ├── router.js             # 消息路由
│   ├── auth.js               # 用户认证 (bcrypt)
│   └── crypto.js             # ECDH/AES-256-GCM
│
├── agent/                    # Mac 桌面客户端 (Node.js)
│   ├── package.json
│   ├── agent.js              # 主程序
│   ├── crypto.js             # 加密模块
│   ├── claude-cli.js         # CLI 进程管理
│   ├── store.js              # SQLite 存储
│   └── com.mychat.agent.plist # launchd 配置
│
├── app/                      # Android App (Kotlin + Compose)
│   ├── build.gradle.kts
│   └── src/main/java/com/mychat/
│       ├── MyChatApp.kt
│       ├── MainActivity.kt
│       ├── di/AppModule.kt
│       ├── log/AppLogger.kt, CrashHandler.kt
│       ├── notification/NotificationHelper.kt
│       ├── data/api/RelayClient.kt, RelayProtocol.kt
│       ├── data/crypto/ECDHCrypto.kt, AESCipher.kt
│       ├── data/db/AppDatabase.kt, MessageDao.kt, MessageEntity.kt
│       ├── data/repository/ChatRepository.kt
│       ├── ui/ChatScreen.kt, ChatViewModel.kt, components/, theme/
│       └── util/KeystoreHelper.kt
│
└── docs/design.md            # 本文档
```

### 4.2 通信协议完整定义

| 消息类型 | 方向 | 内容 |
|---------|------|------|
| auth | 客户端 → 中继 | {username, password} |
| auth_ok | 中继 → 客户端 | {} |
| auth_fail | 中继 → 客户端 | {reason} |
| key_init | 手机 → Mac | {publicKey} |
| key_response | Mac → 手机 | {publicKey} |
| chat_message | 手机 → Mac | {content} |
| chat_reply | Mac → 手机 | {content} |
| chat_complete | Mac → 手机 | {done:true} |
| set_mode | 手机 → Mac | {mode:"auto"/"default"/"plan"} |
| mode_changed | Mac → 手机 | {mode} |
| permission_request | Mac → 手机 | {action, details} |
| permission_response | 手机 → Mac | {result:"approve"/"deny"} |
| choice_request | Mac → 手机 | {options:[]} |
| choice_response | 手机 → Mac | {selected:index} |
| interrupt | 手机 → Mac | {} |
| device_status | 中继 → 手机 | {device:"desktop", online:boolean} |
| query_device_status | 手机 → 中继 | {} |
| ping | 双向 | {} |
| pong | 双向 | {} |
| upload_crash_log | 手机 → Mac | {logContent} |
| crash_log_received | Mac → 手机 | {} |

### 4.3 UI testTag 对照表

| tag 名称 | UI 元素 |
|---------|--------|
| status_bar | 顶部连接状态栏 |
| message_list | 消息列表 |
| chat_input | 输入框 |
| send_button | 发送按钮 |
| stop_button | 停止按钮 |
| mode_selector | 模式选择器 |
| permission_dialog | 审批对话框 |
| permission_approve | 允许按钮 |
| permission_deny | 拒绝按钮 |
| choice_dialog | 选择对话框 |
| choice_option_{index} | 选项第 N 项 |
| settings_button | 设置按钮 |
| clear_history_button | 清空历史按钮 |
| logout_button | 退出登录按钮 |
| message_bubble_{id} | 消息气泡 |
| message_retry_{id} | 消息重试按钮 |

### 4.4 开发计划

| Phase | 内容 |
|-------|------|
| Phase 1 | relay/ 中继服务器（认证 + 转发 + 心跳） |
| Phase 2 | agent/ Mac 客户端（CLI 交互 + 权限拦截） |
| Phase 3 | app/ Android App（界面 + 状态机 + 加密） |
| Phase 4 | 集成测试 + 部署配置 |

---

## 第五部分：重大经验教训

### 5.1 老项目 ClaudeChat 的教训

#### 教训 1：Singleton ViewModel 导致内存泄漏

**问题**：老项目 ChatViewModel 使用静态 `_instance` 单例，Activity 销毁后对象无法释放。

**后果**：内存泄漏，后台切回前台时访问已销毁的 Activity 上下文，导致崩溃。

**解决**：新项目使用 Hilt + ViewModelProvider，ViewModel 与 Activity 生命周期绑定。

#### 教训 2：手写 Job 管理导致协程失控

**问题**：老项目手动管理多个 Job 变量（streamingJob, dbCollectionJob, reconnectJob），onCleared() 时未完全取消。

**后果**：协程在 ViewModel 销毁后继续运行，访问空对象导致崩溃。

**解决**：新项目使用 Kotlin structuredConcurrency，协程自动随作用域取消。

#### 教训 3：数据库无事务导致数据损坏

**问题**：老项目数据库插入/更新操作无 @Transaction 包裹。

**后果**：操作中途失败（如网络中断）留下脏数据，下次启动读取异常数据崩溃。

**解决**：新项目所有数据库操作 @Transaction 包裹，失败自动回滚。

#### 教训 4：fallbackToDestructiveMigration 导致数据丢失

**问题**：老项目 Room 使用 fallbackToDestructiveMigration()，迁移失败直接删库。

**后果**：用户升级 App 版本后所有聊天记录丢失。

**解决**：新项目编写正确的 Migration 策略，迁移失败时备份旧数据。

#### 教训 5：加密失败静默丢弃消息

**问题**：老项目加密失败时只打日志，用户无感知。

**后果**：用户以为消息发送了，实际没发，造成困惑。

**解决**：新项目加密失败时提示用户"发送失败，请重试"。

#### 教训 6：双编码 Bug（跨平台加密）

**问题**：老项目 relay.js 对消息双重 JSON 编码，Android 端只解码一次，导致解密失败。

**后果**：Android 端连接永远失败，日志显示 `[object Object] is not valid JSON`。

**根因**：Node.js-to-Node.js 测试时两端都有同样 bug，互相抵消。Android 端没有 bug，所以暴露了问题。

**教训**：跨平台加密模块必须在两端都测试，单端测试可能隐藏 bug。

#### 教训 7：状态混乱无状态机

**问题**：老项目连接状态用多个布尔变量表示（isConnecting, isConnected, isHandshaking），无状态机约束。

**后果**：可能出现 "正在连接" 和 "已连接" 同时为 true 的非法状态，UI 显示混乱，行为异常。

**解决**：新项目使用密封类状态机，严格定义状态转换，非法转换直接报错。

#### 教训 8：无超时导致"永远转圈"

**问题**：老项目连接握手阶段无超时，服务器无响应时 UI 永远显示"连接中"。

**后果**：用户无法判断是网络问题还是 App 问题，体验极差。

**解决**：新项目每个阶段都有超时（45s/10s/15s），超时后报错并重试。

#### 教训 9：Logger EPIPE 无限循环 — 日志爆炸吞噬磁盘 (2026-05-03)

**问题**：ClaudeChat 的 `agent-client.js` 守护进程日志文件 `claudechat-2026-05-03.log` 在一天内增长到 **22GB**，磁盘空间被迅速耗尽。

**根因**：`Logger._log()` (`server/logger.js`) 在写日志时调用 `console.error()` 输出到 stderr。当进程的 stderr 管道已关闭（终端退出、launchd 重定向丢失等），`console.error()` 触发 `EPIPE` 错误。该错误被 `process.on('uncaughtException')` 捕获并调用 `log.error()`，形成无限递归：

```
log.error() → console.error() → EPIPE → uncaughtException → log.error() → ...
```

每条错误堆栈被逐字符编码为 JSON（`{"0":"E","1":"r",...}`），每条约 800 字节，以每秒数千条的速度写入，一天膨胀至 22GB。

**加剧因素**：
- `Logger._log` 中 `fs.appendFileSync` 用 try-catch 包裹了，但 `console.error` 调用在 try-catch 范围之外，不受保护
- `agent-client.js` 的 `uncaughtException` 处理器无条件记录所有异常，未过滤 EPIPE 等可忽略错误
- `--send-file` 模式的进程卡死占 97.9% CPU，是同一问题的表现

**解决**：
1. `console.*` 调用必须包裹 try-catch，防止 EPIPE 触发异常
2. `process.on('uncaughtException')` 应过滤 EPIPE 错误，不记录直接忽略
3. 日志文件加大小限制（如单文件最大 100MB），超出后停止写入或轮转
4. 守护进程不应依赖 stderr/stdout 输出，应改为纯文件日志

**教训**：永远不要假设 `console.*` 调用是安全的。在守护进程中，任何 I/O 操作都可能因管道关闭而抛出 EPIPE。日志系统本身的错误处理必须独立于它所使用的输出通道。**日志系统必须是故障隔离的——不能因为记录错误而引发更多错误。**

### 5.2 设计决策总结

| 决策 | 理由 |
|------|------|
| 单对话模式 | 简化状态管理，避免老项目会话切换竞态问题 |
| CLI `-p` 模式而非交互模式 | 非TTY环境下交互模式会卡住退出；`-p` 模式稳定可靠，配合 `--resume` 保持上下文 |
| cwd = ~ 而非固定目录 | Claude 可访问 Mac 任意位置，不受限制 |
| 状态机驱动连接 | 严格状态约束，杜绝非法状态 |
| 自动重连 + 应用层心跳 | 3秒自动重连 + 25秒 ping，实现 7×24 稳定连接 |
| 三端独立存储 | 避免同步复杂性，各端数据自治 |
| 中继不存储消息 | 极简设计，离线消息手机端暂存 |
| 所有 UI 元素带 testTag | 支持自动化测试，定位元素便捷 |
| 崩溃日志上传到 Mac | 手机端不便调试，日志汇总到 Mac 端排查 |

### 5.3 简化决策（单用户场景）

以下需求因单用户个人使用场景而简化或移除，减少约 30% 边缘场景处理代码：

| 简化/移除的需求 | 理由 |
|----------------|------|
| 消息去重 (messageId) | 单用户1对1通信，ACK丢包概率极低，已有重连重发机制覆盖 |
| 消息大小校验 | 聊天场景不会发超大文本，只调大WS帧限制即可 |
| 审批超时倒计时 | 个人App，对话框放着不操作CLI等一下也没问题 |
| ECDH单独重试3次 | 已有整体重连逻辑，ECDH失败回到 DISCONNECTED 即可 |
| Mac休眠/唤醒监听 | 网络自然断开，已有断连/重连机制自动生效 |
| Claude CLI未安装检测 | CLI未安装 → agent启动失败 → 手机显示"PC离线"，已被覆盖 |
| 优雅停机2s延迟 | 个人App，立即断开即可，手机端已有重连逻辑 |
| 中继地址可配置 | 单用户固定部署，地址不变 |
| 日志单文件大小限制 | 2026-05-03 日志膨胀至 22GB 证明按天滚动不够，必须加单文件上限（如 100MB） |
| 系统消息气泡 | 状态栏 + Snackbar 替代，更简单直观 |

### 5.4 待修复问题

| 问题 | 描述 | 优先级 | 状态 |
|------|------|--------|------|
| App 切后台未收到回复 | App 切出去后，PC 端回复了，但 App 端没有收到通知或消息 | P0 | 待修复 |

### 5.5 后期扩展注意事项

| 扩展功能 | 设计预留 | 后期实现注意 |
|---------|---------|-------------|
| 图片发送 | contentType="image" 预留 | 需处理大文件分块传输 |
| 文件传输 | MessageEntity 预留 | 需考虑传输中断恢复 |
| 多会话 | conversationId 预留 | 需解决 Mac 端多 session 管理 |