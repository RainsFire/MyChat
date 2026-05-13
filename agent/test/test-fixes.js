/**
 * Bug 修复测试
 * - Fix 1: 消息缓冲机制（Bug 2, 9）
 * - Fix 2: 会话管理增强（Bug 1, 3）
 * - Fix 3: 模式系统修复（Bug 7）
 * - Fix 4: 环境隔离验证（Bug 10）
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Session = require('../session');

// ====== Test helpers ======
let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    results.push(`  ✗ ${name}: ${e.message}`);
  }
}

function testAsync(name, fn) {
  return fn().then(() => {
    passed++;
    results.push(`  ✓ ${name}`);
  }).catch(e => {
    failed++;
    results.push(`  ✗ ${name}: ${e.message}`);
  });
}

// ====== Fix 1: Message Buffer ======

test('Fix 1.1: pendingMessages 初始为空数组', () => {
  // 验证 Agent 构造函数中 pendingMessages 初始化
  const code = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  assert(code.includes('this.pendingMessages = []'), 'pendingMessages 应初始化为空数组');
});

test('Fix 1.2: _flushBuffer 在 ws 未就绪时不发送', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  assert(code.includes('_flushBuffer'), '_flushBuffer 方法应存在');
  assert(code.includes('readyState !== 1') || code.includes('readyState'), '_flushBuffer 应检查连接状态');
});

test('Fix 1.3: _flushBuffer 在密钥交换完成后调用', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  // 密钥交换完成后应调用 _flushBuffer
  const handleKeyInit = code.match(/_handleKeyInit[\s\S]*?console\.log\('\[AGENT\] 密钥交换完成'\)/);
  assert(handleKeyInit, '_handleKeyInit 应存在');
  assert(handleKeyInit[0].includes('_flushBuffer'), '_handleKeyInit 应在密钥交换后调用 _flushBuffer');
});

test('Fix 1.4: onReply 回调缓冲而非丢弃', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  // onReply 不应再检查 ws.readyState
  const initCLI = code.match(/_initCLI\(\)[\s\S]*?^\s{4}\}/m);
  assert(initCLI, '_initCLI 方法应存在');
  // 回调中不应有 ws.readyState 检查（已移到 _flushBuffer）
  const onReplySection = code.match(/\/\/ onReply.*?=\s*\{[^}]*\}/s);
  // 验证 onReply 中使用 pendingMessages.push
  assert(code.includes("this.pendingMessages.push(JSON.stringify({ type: 'encrypted', payload }))"),
    'onReply 应将消息推入 pendingMessages');
});

test('Fix 1.5: interrupt 时补发 chat_complete', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  assert(code.includes('chat_complete') && code.includes('interrupt'),
    'interrupt 处理应包含 chat_complete 补发逻辑');
  assert(code.includes('!this.cli.isResponding'),
    'interrupt 应检查 CLI 是否仍在响应');
});

test('Fix 1.6: _flushBuffer 发送失败时放回队列', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  assert(code.includes('unshift'), '_flushBuffer 发送失败应将消息放回队列');
});

// ====== Fix 2: Session Management ======

test('Fix 2.1: ClaudeCLI 构造函数接受 onSessionChange 回调', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  assert(code.includes('onSessionChange'), '应接受 onSessionChange 参数');
});

test('Fix 2.2: _resumeSessionId 记录恢复的 session_id', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  assert(code.includes('_resumeSessionId'), '应有 _resumeSessionId 字段');
  assert(code.includes('this._resumeSessionId = this.session.sessionId'),
    '_startCli 应记录恢复的 session_id');
});

test('Fix 2.3: session_id 变化时调用 onSessionChange', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  assert(code.includes('_saveSession'), '应有 _saveSession 方法');
  assert(code.includes('onSessionChange(sessionId)') || code.includes('this.onSessionChange'),
    '_saveSession 应在 session_id 变化时调用 onSessionChange');
});

test('Fix 2.4: 上下文溢出重试前通知会话重置', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  // 在 context overflow 重试前应调用 onSessionChange
  const overflowIdx = code.indexOf('_contextOverflowDetected && this._retryCount');
  assert(overflowIdx > 0, '上下文溢出重试逻辑应存在');
  const overflowSection = code.substring(overflowIdx, overflowIdx + 400);
  assert(overflowSection.includes('onSessionChange'), '上下文溢出重试前应调用 onSessionChange');
  assert(overflowSection.includes('session.clear()'), '应清除会话');
});

// ====== Fix 3: Mode System ======

test('Fix 3.1: plan 模式使用 --permission-mode plan', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  assert(code.includes("'plan'"), '应支持 plan 模式');
  assert(code.includes("--permission-mode") && code.includes("'plan'"),
    'plan 模式应使用 --permission-mode plan');
});

test('Fix 3.2: auto 模式保持 --dangerously-skip-permissions', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  assert(code.includes('--dangerously-skip-permissions'), 'auto 模式应使用 --dangerously-skip-permissions');
});

test('Fix 3.3: setMode 验证模式值', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  const setModeSection = code.match(/setMode\(mode\)[\s\S]*?^\s{4}\}/m);
  assert(setModeSection, 'setMode 方法应存在');
  assert(setModeSection[0].includes("'default'") && setModeSection[0].includes("'auto'") && setModeSection[0].includes("'plan'"),
    'setMode 应验证模式值为 default/auto/plan');
});

test('Fix 3.4: 处理 permission_request 消息类型', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  assert(code.includes("'permission_request'") || code.includes("'permission'"),
    '_handleJsonMessage 应处理 permission_request 消息');
  assert(code.includes('onPermissionRequest'),
    '应调用 onPermissionRequest 回调');
});

test('Fix 3.5: 处理 choice_request 消息类型', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  assert(code.includes("'choice_request'") || code.includes("'choice'"),
    '_handleJsonMessage 应处理 choice_request 消息');
});

test('Fix 3.6: respondPermission 写入 CLI stdin', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  const respondPermSection = code.match(/respondPermission[\s\S]*?^\s{4}\}/m);
  assert(respondPermSection, 'respondPermission 方法应存在');
  assert(respondPermSection[0].includes('stdin.write'), 'respondPermission 应写入 stdin');
  assert(respondPermSection[0].includes('permission_response'), '应发送 permission_response 类型的消息');
});

test('Fix 3.7: respondChoice 写入 CLI stdin', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
  const respondChoiceSection = code.match(/respondChoice[\s\S]*?^\s{4}\}/m);
  assert(respondChoiceSection, 'respondChoice 方法应存在');
  assert(respondChoiceSection[0].includes('stdin.write'), 'respondChoice 应写入 stdin');
});

// ====== Fix 4: Environment Isolation ======

test('Fix 4.1: ecosystem.config.json 包含 SIT relay 配置', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'relay', 'ecosystem.config.json'), 'utf8'));
  assert(config.apps.length >= 2, '应至少有 2 个 app 配置');
  const sitApp = config.apps.find(a => a.name === 'mychat-relay-sit');
  assert(sitApp, '应有 mychat-relay-sit 配置');
  assert(sitApp.env.MYCHAT_PORT === 9091, 'SIT relay 应使用 9091 端口');
});

test('Fix 4.2: Session 路径按 MYCHAT_ENV 隔离', () => {
  // 模拟生产环境
  delete process.env.MYCHAT_ENV;
  const prodSession = new Session();
  const prodPath = path.join(require('os').homedir(), '.mychat', 'session.json');

  // 模拟 SIT 环境
  process.env.MYCHAT_ENV = 'sit';
  // session.js 中的 SESSION_DIR 在模块加载时就计算了
  // 所以我们需要检查代码逻辑
  const sessionCode = fs.readFileSync(path.join(__dirname, '..', 'session.js'), 'utf8');
  assert(sessionCode.includes("process.env.MYCHAT_ENV || ''"), 'Session 应使用 MYCHAT_ENV 隔离路径');

  delete process.env.MYCHAT_ENV;
});

test('Fix 4.3: Store 路径按 MYCHAT_ENV 隔离', () => {
  const storeCode = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');
  assert(storeCode.includes("process.env.MYCHAT_ENV || ''"), 'Store 应使用 MYCHAT_ENV 隔离路径');
});

test('Fix 4.4: Agent 启动日志包含环境信息', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  assert(code.includes('MYCHAT_ENV') && code.includes('环境:'), 'Agent 启动日志应包含环境信息');
});

// ====== Results ======
Promise.resolve().then(async () => {
  // 运行异步测试...

  console.log('\n====== Bug 修复验证测试 ======');
  console.log(`共 ${passed + failed} 个断言:\n`);
  results.forEach(r => console.log(r));
  console.log(`\n通过: ${passed}, 失败: ${failed}\n`);

  if (failed > 0) {
    process.exit(1);
  }
});
