/**
 * 消息路由模块
 * 管理每个用户的设备连接（手机 + Mac），互相转发消息
 */

class Router {
  constructor() {
    // 每个用户的设备连接 { username: { mobile: ws, desktop: ws } }
    this.connections = new Map();
  }

  /**
   * 注册设备连接
   * @param {string} username
   * @param {string} deviceType 'mobile' | 'desktop'
   * @param {WebSocket} ws
   */
  register(username, deviceType, ws) {
    if (!this.connections.has(username)) {
      this.connections.set(username, { mobile: null, desktop: null });
    }
    const devices = this.connections.get(username);

    // 如果同类型设备已连接，关闭旧连接
    if (devices[deviceType] && devices[deviceType] !== ws) {
      try {
        devices[deviceType].close(4000, '新连接取代');
      } catch (e) { /* ignore */ }
    }

    devices[deviceType] = ws;
    ws._mychatUsername = username;
    ws._mychatDevice = deviceType;
  }

  /**
   * 注销设备连接
   * @param {WebSocket} ws
   */
  unregister(ws) {
    const username = ws._mychatUsername;
    const deviceType = ws._mychatDevice;
    if (!username || !deviceType) return;

    const devices = this.connections.get(username);
    if (devices && devices[deviceType] === ws) {
      devices[deviceType] = null;
    }

    // 通知另一端设备离线
    const otherType = deviceType === 'mobile' ? 'desktop' : 'mobile';
    const otherWs = devices ? devices[otherType] : null;
    if (otherWs && otherWs.readyState === 1) {
      otherWs.send(JSON.stringify({
        type: 'device_status',
        device: deviceType,
        online: false
      }));
    }
  }

  /**
   * 转发消息到对端设备
   * @param {WebSocket} fromWs 发送方的 WebSocket
   * @param {Object} message 原始消息对象
   * @returns {boolean} 是否转发成功
   */
  forward(fromWs, message) {
    const username = fromWs._mychatUsername;
    const deviceType = fromWs._mychatDevice;
    if (!username || !deviceType) return false;

    const devices = this.connections.get(username);
    if (!devices) return false;

    const target = deviceType === 'mobile' ? 'desktop' : 'mobile';
    const targetWs = devices[target];

    if (!targetWs || targetWs.readyState !== 1) return false;

    targetWs.send(JSON.stringify(message));
    return true;
  }

  /**
   * 查询指定设备类型的在线状态
   * @param {WebSocket} requestWs 请求方的 WebSocket
   * @param {string} deviceType 查询的设备类型
   * @returns {{ online: boolean, count: number }}
   */
  getDeviceStatus(requestWs, deviceType) {
    const username = requestWs._mychatUsername;
    if (!username) return { online: false, count: 0 };

    const devices = this.connections.get(username);
    if (!devices) return { online: false, count: 0 };

    const targetWs = devices[deviceType];
    return {
      online: Boolean(targetWs && targetWs.readyState === 1),
      count: targetWs ? 1 : 0
    };
  }

  /**
   * 通知设备上线
   * @param {WebSocket} ws 上线的设备
   */
  notifyOnline(ws) {
    const username = ws._mychatUsername;
    const deviceType = ws._mychatDevice;
    if (!username || !deviceType) return;

    const devices = this.connections.get(username);

    // 通知对端设备：当前设备上线
    const otherType = deviceType === 'mobile' ? 'desktop' : 'mobile';
    const otherWs = devices ? devices[otherType] : null;

    if (otherWs && otherWs.readyState === 1) {
      otherWs.send(JSON.stringify({
        type: 'device_status',
        device: deviceType,
        online: true
      }));

      // 同时通知当前设备：对端已在线
      ws.send(JSON.stringify({
        type: 'device_status',
        device: otherType,
        online: true
      }));
    }
  }
}

module.exports = Router;