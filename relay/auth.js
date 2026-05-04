/**
 * 用户认证模块
 * bcrypt 密码验证，内存维护已认证的 token
 */

const crypto = require('crypto');

class AuthService {
  constructor() {
    // 用户凭证 { username: hashedPassword }
    this.users = new Map();
    // 活跃 token { token: { username, createdAt } }
    this.tokens = new Map();
  }

  /**
   * 注册用户（首次部署时调用）
   * @param {string} username
   * @param {string} password
   */
  addUser(username, hashedPassword) {
    this.users.set(username, hashedPassword);
  }

  /**
   * 验证用户凭证
   * @param {string} username
   * @param {string} password 明文密码
   * @returns {boolean}
   */
  async verify(username, password) {
    const hashed = this.users.get(username);
    if (!hashed) return false;

    const bcrypt = require('bcrypt');
    return bcrypt.compare(password, hashed);
  }

  /**
   * 创建认证 token
   * @param {string} username
   * @returns {string} token
   */
  createToken(username) {
    const token = crypto.randomBytes(32).toString('hex');
    this.tokens.set(token, { username, createdAt: Date.now() });
    return token;
  }

  /**
   * 验证 token 有效性
   * @param {string} token
   * @returns {string|null} username 或 null
   */
  validateToken(token) {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    return entry.username;
  }

  /**
   * 删除 token（断开连接时）
   * @param {string} token
   */
  revokeToken(token) {
    this.tokens.delete(token);
  }
}

module.exports = AuthService;