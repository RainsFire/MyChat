/**
 * SQLite 聊天记录存储
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'data', process.env.MYCHAT_ENV || '');
const DB_PATH = path.join(DB_DIR, 'chat.db');

class Store {
  constructor() {
    fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'delivered',
        created_at INTEGER NOT NULL
      )
    `);
  }

  /**
   * 保存消息
   */
  saveMessage(role, content, status = 'delivered') {
    const stmt = this.db.prepare(
      'INSERT INTO messages (role, content, status, created_at) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(role, content, status, Date.now());
    return result.lastInsertRowid;
  }

  /**
   * 获取最近消息
   */
  getRecentMessages(limit = 100) {
    const stmt = this.db.prepare(
      'SELECT * FROM messages ORDER BY id DESC LIMIT ?'
    );
    return stmt.all(limit).reverse();
  }

  /**
   * 清空所有消息
   */
  clearAll() {
    this.db.exec('DELETE FROM messages');
  }

  /**
   * 关闭数据库
   */
  close() {
    this.db.close();
  }
}

module.exports = Store;
