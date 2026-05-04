/**
 * ECDH P-256 + AES-256-GCM 加密模块
 * 用于手机端和 Mac 端之间的端到端加密通信
 */

const crypto = require('crypto');

// 加密算法配置
const EC_CURVE = 'prime256v1';       // P-256 曲线
const AES_ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;                 // GCM 推荐 12 字节
const AUTH_TAG_LENGTH = 16;          // GCM 认证标签 16 字节
const KEY_LENGTH = 32;                // AES-256 需要 32 字节密钥

/**
 * 生成 ECDH 密钥对
 * @returns {{privateKey: string, publicKey: string}} Base64 编码的密钥
 */
function generateKeyPair() {
  const ecdh = crypto.createECDH(EC_CURVE);
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey('base64'),
    publicKey: ecdh.getPublicKey('base64', 'compressed')
  };
}

/**
 * 从 Base64 恢复 ECDH 对象
 * @param {string} privateKey Base64 编码的私钥
 * @returns {crypto.ECDH}
 */
function restoreECDH(privateKey) {
  const ecdh = crypto.createECDH(EC_CURVE);
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64'));
  return ecdh;
}

/**
 * 计算共享密钥
 * @param {string} myPrivateKey 我的私钥 (Base64)
 * @param {string} theirPublicKey 对方公钥 (Base64)
 * @returns {Buffer} 32 字节的共享密钥
 */
function computeSharedKey(myPrivateKey, theirPublicKey) {
  const ecdh = restoreECDH(myPrivateKey);
  const shared = ecdh.computeSecret(Buffer.from(theirPublicKey, 'base64'));
  // ECDH 输出可能不是 32 字节，用 SHA-256 哈希确保长度
  return crypto.createHash('sha256').update(shared).digest();
}

/**
 * 加密 JSON 对象
 * @param {Object} data 要加密的数据
 * @param {Buffer} key 共享密钥
 * @returns {string} Base64 编码的加密数据 (IV + ciphertext + authTag)
 */
function encryptJson(data, key) {
  const plaintext = JSON.stringify(data);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  // 组合: IV (12) + ciphertext + authTag (16)
  const combined = Buffer.concat([iv, ciphertext, authTag]);
  return combined.toString('base64');
}

/**
 * 解密 Base64 数据
 * @param {string} encrypted Base64 编码的加密数据
 * @param {Buffer} key 共享密钥
 * @returns {Object} 解密后的 JSON 对象
 */
function decryptJson(encrypted, key) {
  const combined = Buffer.from(encrypted, 'base64');

  // 解析: IV (12) + ciphertext + authTag (16)
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (e) {
    throw new Error('解密失败: ' + e.message);
  }
}

/**
 * CryptoHelper 类 - 管理单个连接的加密状态
 */
class CryptoHelper {
  constructor() {
    this.privateKey = null;
    this.publicKey = null;
    this.sharedKey = null;
    this.ready = false;
  }

  /**
   * 初始化密钥对（手机端发起握手时调用）
   */
  initAsInitiator() {
    const keys = generateKeyPair();
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
    return this.publicKey;
  }

  /**
   * 作为响应者处理握手（Mac 端收到 key_init 时调用）
   * @param {string} initiatorPublicKey 发起者的公钥
   */
  initAsResponder(initiatorPublicKey) {
    const keys = generateKeyPair();
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
    this.sharedKey = computeSharedKey(this.privateKey, initiatorPublicKey);
    this.ready = true;
    return this.publicKey;
  }

  /**
   * 完成握手（手机端收到 key_response 时调用）
   * @param {string} responderPublicKey 响应者的公钥
   */
  completeHandshake(responderPublicKey) {
    this.sharedKey = computeSharedKey(this.privateKey, responderPublicKey);
    this.ready = true;
  }

  /**
   * 加密消息
   */
  encrypt(data) {
    if (!this.ready) throw new Error('加密未就绪，请先完成握手');
    return encryptJson(data, this.sharedKey);
  }

  /**
   * 解密消息
   */
  decrypt(payload) {
    if (!this.ready) throw new Error('加密未就绪，请先完成握手');
    return decryptJson(payload, this.sharedKey);
  }

  /**
   * 重置状态
   */
  reset() {
    this.privateKey = null;
    this.publicKey = null;
    this.sharedKey = null;
    this.ready = false;
  }
}

module.exports = {
  generateKeyPair,
  computeSharedKey,
  encryptJson,
  decryptJson,
  CryptoHelper
};