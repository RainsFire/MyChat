/**
 * Claude CLI 进程管理
 * 每条消息用 claude -p "text" --output-format stream-json --verbose
 * 非交互模式，适合 pipe 环境
 */

const { spawn } = require('child_process');
const Session = require('./session');

class ClaudeCLI {
  constructor(onReply, onComplete, onPermissionRequest, onChoiceRequest) {
    this.process = null;
    this.session = new Session();
    this.onReply = onReply;
    this.onComplete = onComplete;
    this.onPermissionRequest = onPermissionRequest;
    this.onChoiceRequest = onChoiceRequest;
    this.mode = 'default';
    this.outputBuffer = '';
    this.isResponding = false;
    this._pendingText = null;
    this._retryCount = 0;
  }

  start() {}

  sendMessage(text) {
    this._kill();
    this.isResponding = true;
    this._pendingText = text;
    this._retryCount = 0;
    this.outputBuffer = '';
    this._startCli(text);
  }

  _startCli(text) {
    const args = ['-p', text, '--output-format', 'stream-json', '--verbose'];
    if (this.mode === 'auto') {
      args.push('--dangerously-skip-permissions');
    }
    if (this.session.sessionId) {
      args.push('--resume', this.session.sessionId);
      console.log(`[CLI] 恢复会话: ${this.session.sessionId.slice(0, 8)}...`);
    } else {
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
      // 检测上下文窗口溢出错误
      if (t.includes('context window') || t.includes('context limit') || t.includes('max_tokens')) {
        this._contextOverflowDetected = true;
      }
    });

    this.process.on('close', (code) => {
      console.log(`[CLI] 进程退出: code=${code}`);
      this.process = null;
      if (this.isResponding) {
        if (code !== 0 && this._retryCount < 2 && this._pendingText) {
          // CLI 异常退出，可能是上下文溢出，重置会话重试
          console.log(`[CLI] 异常退出(code=${code})，重置会话并重试(${this._retryCount + 1}/2)`);
          this.session.clear();
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
    if (this.mode === mode) return;
    this.mode = mode;
    console.log(`[CLI] 切换模式: ${mode}`);
  }

  resetSession() {
    this.session.clear();
    console.log('[CLI] 会话已重置，下一条消息将开始新会话');
  }

  respondPermission(approved) {
    console.log(`[CLI] 权限响应(忽略): ${approved ? '允许' : '拒绝'}`);
  }

  respondChoice(index) {
    console.log(`[CLI] 选择响应(忽略): ${index}`);
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
    if (msg.type === 'assistant') {
      if (msg.message && msg.message.content) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              this.onReply(block.text);
            } else if (block.type === 'tool_use') {
              // 不发送工具调用信息到 app
            }
          }
        }
      }
      if (msg.session_id) this.session.save(msg.session_id);
    } else if (msg.type === 'result') {
      if (msg.session_id) this.session.save(msg.session_id);
      this._finishResponse();
    } else if (msg.type === 'system') {
      if (msg.session_id) this.session.save(msg.session_id);
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
