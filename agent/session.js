/**
 * 会话持久化模块
 * 将 Claude CLI session_id 持久化到 ~/.mychat/session.json
 */

const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(process.env.HOME, '.mychat', process.env.MYCHAT_ENV || '');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

class Session {
  constructor() {
    this.sessionId = null;
    this.createdAt = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        this.sessionId = data.sessionId || null;
        this.createdAt = data.createdAt || null;
        if (this.sessionId) {
          console.log(`[SESSION] 恢复会话: ${this.sessionId.slice(0, 8)}... (创建于 ${new Date(this.createdAt).toLocaleString()})`);
        }
      }
    } catch (e) {
      console.log(`[SESSION] 读取会话文件失败: ${e.message}`);
    }
  }

  save(sessionId) {
    if (!sessionId) return;
    this.sessionId = sessionId;
    if (!this.createdAt) {
      this.createdAt = Date.now();
    }
    try {
      if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
      }
      fs.writeFileSync(SESSION_FILE, JSON.stringify({
        sessionId: this.sessionId,
        createdAt: this.createdAt
      }, null, 2));
      console.log(`[SESSION] 保存会话: ${sessionId.slice(0, 8)}...`);
    } catch (e) {
      console.error(`[SESSION] 保存失败: ${e.message}`);
    }
  }

  clear() {
    this.sessionId = null;
    this.createdAt = null;
    try {
      if (fs.existsSync(SESSION_FILE)) {
        fs.unlinkSync(SESSION_FILE);
      }
      console.log('[SESSION] 会话已清除');
    } catch (e) {
      console.error(`[SESSION] 清除失败: ${e.message}`);
    }
  }

  hasSession() {
    return this.sessionId !== null;
  }

  getStatus() {
    return {
      hasSession: this.hasSession(),
      sessionId: this.sessionId,
      createdAt: this.createdAt
    };
  }
}

module.exports = Session;
