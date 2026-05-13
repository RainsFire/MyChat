/**
 * Claude CLI 进程管理
 * 每条消息用 claude -p "text" --output-format stream-json --verbose
 * 非交互模式，适合 pipe 环境
 * CLI 内部自动管理上下文压缩
 */

const { spawn } = require('child_process');
const Session = require('./session');

class ClaudeCLI {
  constructor(onReply, onComplete, onPermissionRequest, onChoiceRequest, onSessionChange) {
    this.process = null;
    this.session = new Session();
    this.onReply = onReply;
    this.onComplete = onComplete;
    this.onPermissionRequest = onPermissionRequest || (() => {});
    this.onChoiceRequest = onChoiceRequest || (() => {});
    this.onSessionChange = onSessionChange || (() => {});
    this.mode = 'default';
    this.outputBuffer = '';
    this.isResponding = false;
    this._pendingText = null;
    this._retryCount = 0;
    this._contextOverflowDetected = false;
    this._resumeSessionId = null;  // Fix 2: 记录 --resume 使用的 session_id
  }

  start() {}

  sendMessage(text) {
    this._kill();
    this.isResponding = true;
    this._pendingText = text;
    this._retryCount = 0;
    this._contextOverflowDetected = false;
    this.outputBuffer = '';
    this._startCli(text);
  }

  _startCli(text) {
    const args = ['-p', text, '--output-format', 'stream-json', '--verbose'];

    // Fix 3: 使用 --permission-mode 控制模式行为
    if (this.mode === 'plan') {
      args.push('--permission-mode', 'plan');
    } else if (this.mode === 'auto') {
      args.push('--dangerously-skip-permissions');
    } else {
      // default: 不跳过权限检查，CLI 会按默认规则处理
    }

    if (this.session.sessionId) {
      args.push('--resume', this.session.sessionId);
      this._resumeSessionId = this.session.sessionId;
      console.log(`[CLI] 恢复会话: ${this.session.sessionId.slice(0, 8)}...`);
    } else {
      this._resumeSessionId = null;
      console.log('[CLI] 开始新会话');
    }

    console.log(`[CLI] 启动: claude ${args.slice(0, 4).join(' ')}...`);

    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    this.process = spawn(claudeBin, args, {
      cwd: process.env.HOME,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` }
    });

    this.process.stdout.on('data', (data) => this._handleOutput(data));
    this.process.stderr.on('data', (data) => {
      const t = data.toString().trim();
      if (t.includes('Warning:')) return;
      console.error(`[CLI] stderr: ${t}`);
      if (t.includes('context window') || t.includes('context limit') || t.includes('max_tokens')) {
        this._contextOverflowDetected = true;
      }
    });

    this.process.on('close', (code) => {
      console.log(`[CLI] 进程退出: code=${code}`);
      this.process = null;
      if (this.isResponding) {
        if (code !== 0 && this._retryCount < 2 && this._pendingText) {
          console.log(`[CLI] 异常退出(code=${code})，保留会话重试(${this._retryCount + 1}/2)`);
          this._retryCount++;
          this.outputBuffer = '';
          this._startCli(this._pendingText);
          return;
        }
        this._pendingText = null;
        this._finishResponse();
      }
    });

    this.process.on('error', (err) => {
      console.error(`[CLI] 进程错误: ${err.message}`);
      this.process = null;
      this.onReply('[错误: CLI 启动失败]');
      this._finishResponse();
    });
  }

  interrupt() {
    this._kill();
    if (this.isResponding) {
      this.onReply('[已中断]');
      this._finishResponse();
    }
  }

  setMode(mode) {
    if (!['default', 'auto', 'plan'].includes(mode)) return;
    if (this.mode === mode) return;
    this.mode = mode;
    console.log(`[CLI] 切换模式: ${mode}`);
  }

  resetSession() {
    this.session.clear();
    console.log('[CLI] 会话已重置，下一条消息将开始新会话');
  }

  respondPermission(approved) {
    console.log(`[CLI] 权限响应: ${approved ? '允许' : '拒绝'}`);
    if (this.process && this.process.stdin.writable) {
      try {
        this.process.stdin.write(JSON.stringify({
          type: 'permission_response',
          approved: approved
        }) + '\n');
      } catch (e) {
        console.error(`[CLI] 写入权限响应失败: ${e.message}`);
      }
    }
  }

  respondChoice(index) {
    console.log(`[CLI] 选择响应: ${index}`);
    if (this.process && this.process.stdin.writable) {
      try {
        this.process.stdin.write(JSON.stringify({
          type: 'choice_response',
          index: index
        }) + '\n');
      } catch (e) {
        console.error(`[CLI] 写入选择响应失败: ${e.message}`);
      }
    }
  }

  stop() {
    this._kill();
  }

  _handleOutput(data) {
    const text = data.toString();
    this.outputBuffer += text;

    const lines = this.outputBuffer.split('\n');
    this.outputBuffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        this._handleJsonMessage(json);
      } catch (e) {
        this.onReply(line);
      }
    }
  }

  _handleJsonMessage(msg) {
    // Fix 3: 处理权限请求消息
    if (msg.type === 'permission_request' || msg.type === 'permission') {
      console.log(`[CLI] 权限请求: ${JSON.stringify(msg).slice(0, 200)}`);
      this.onPermissionRequest({
        action: msg.tool_name || msg.action || 'unknown',
        details: typeof msg.tool_input === 'string' ? msg.tool_input : JSON.stringify(msg.tool_input || msg.details || '')
      });
      return;
    }

    if (msg.type === 'choice_request' || msg.type === 'choice') {
      console.log(`[CLI] 选择请求: ${JSON.stringify(msg).slice(0, 200)}`);
      const options = msg.options || [];
      this.onChoiceRequest(options);
      return;
    }

    if (msg.type === 'assistant') {
      if (msg.message && msg.message.content) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              // 检测上下文溢出错误
              if (block.text && (
                block.text.includes('context window limit') ||
                block.text.includes('context limit') ||
                block.text.includes('max_tokens') ||
                block.text.includes('context window')
              )) {
                console.log(`[CLI] 检测到上下文溢出: ${block.text.slice(0, 80)}`);
                this._contextOverflowDetected = true;
              }
              this.onReply(block.text);
            }
          }
        }
      }
      if (msg.session_id) this._saveSession(msg.session_id);
    } else if (msg.type === 'result') {
      if (msg.session_id) this._saveSession(msg.session_id);
      // 流式输出中检测到上下文溢出，重置会话重试
      if (this._contextOverflowDetected && this._retryCount < 2 && this._pendingText) {
        console.log(`[CLI] 上下文溢出，重置会话并重试(${this._retryCount + 1}/2)`);
        this._contextOverflowDetected = false;
        // Fix 2: 通知会话重置
        this.onSessionChange('reset');
        this.session.clear();
        this._retryCount++;
        this.outputBuffer = '';
        this._kill();
        this._startCli(this._pendingText);
        return;
      }
      this._finishResponse();
    } else if (msg.type === 'system') {
      if (msg.session_id) this._saveSession(msg.session_id);
    }
  }

  /**
   * Fix 2: 保存 session_id 并检测变化
   */
  _saveSession(sessionId) {
    const prevId = this.session.sessionId;
    this.session.save(sessionId);
    // 检测 session_id 变化（非上下文溢出场景）
    if (this._resumeSessionId && sessionId !== this._resumeSessionId) {
      console.log(`[CLI] 会话 ID 变化: ${this._resumeSessionId.slice(0, 8)} → ${sessionId.slice(0, 8)}`);
      this._resumeSessionId = sessionId;
      this.onSessionChange(sessionId);
    }
  }

  _finishResponse() {
    this.isResponding = false;
    this.onComplete();
  }

  _kill() {
    if (this.process) {
      try { this.process.kill('SIGTERM'); } catch (e) {}
      this.process = null;
    }
  }
}

module.exports = ClaudeCLI;
