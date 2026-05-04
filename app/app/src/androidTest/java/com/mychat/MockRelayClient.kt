package com.mychat

import com.mychat.data.api.ConnectionState
import com.mychat.data.api.RelayClient
import com.mychat.data.api.RelayEvent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * 测试用 MockRelayClient，不连接真实服务器
 * 可编程地模拟各种连接状态和事件
 */
class MockRelayClient : RelayClient() {

    /** 自动完成连接流程（ChatCompositeTest 用）*/
    var autoConnect: Boolean = false

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    public override val state: StateFlow<ConnectionState> = _state

    private val _desktopOnline = MutableStateFlow(false)
    public override val desktopOnline: StateFlow<Boolean> = _desktopOnline

    private val _events = MutableStateFlow<RelayEvent?>(null)
    public override val events: StateFlow<RelayEvent?> = _events

    private var onEventCallback: ((RelayEvent) -> Unit)? = null
    private var capturedUrl: String? = null
    private var capturedUsername: String? = null
    private var capturedPassword: String? = null
    private var capturedMessages = mutableListOf<String>()
    private var pingCount = 0
    private var connectCount = 0
    private var intentionalDisconnect = false
    private var reconnectTimer: java.util.Timer? = null

    override fun connect(url: String, username: String, password: String) {
        intentionalDisconnect = false
        reconnectTimer?.cancel()
        reconnectTimer = null
        capturedUrl = url
        capturedUsername = username
        capturedPassword = password
        connectCount++
        _state.value = ConnectionState.Connecting
        _state.value = ConnectionState.Authenticating
        if (autoConnect) {
            _state.value = ConnectionState.Handshaking
            _state.value = ConnectionState.Connected
            _desktopOnline.value = true
        }
    }

    /** 模拟认证成功 → 连接完成 */
    fun simulateConnected() {
        _state.value = ConnectionState.Handshaking
        _state.value = ConnectionState.Connected
        _desktopOnline.value = true
    }

    /** 模拟认证失败 */
    fun simulateAuthFail(reason: String = "用户名或密码错误") {
        _state.value = ConnectionState.Error(reason)
    }

    override fun disconnect() {
        intentionalDisconnect = true
        reconnectTimer?.cancel()
        reconnectTimer = null
        _state.value = ConnectionState.Disconnected
        _desktopOnline.value = false
    }

    /** 模拟连接断开 */
    fun simulateDisconnected() {
        _state.value = ConnectionState.Disconnected
        _desktopOnline.value = false
        scheduleReconnect()
    }

    /** 模拟连接失败 */
    fun simulateConnectionFailed() {
        _state.value = ConnectionState.Error("连接失败")
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (intentionalDisconnect) return
        if (capturedUrl == null) return
        reconnectTimer?.cancel()
        reconnectTimer = java.util.Timer().also { timer ->
            timer.schedule(object : java.util.TimerTask() {
                override fun run() {
                    capturedUrl?.let { url ->
                        capturedUsername?.let { username ->
                            capturedPassword?.let { password ->
                                connect(url, username, password)
                            }
                        }
                    }
                }
            }, 3000)
        }
    }

    /** 模拟收到 Claude 回复 */
    fun simulateChatReply(content: String) {
        onEventCallback?.invoke(RelayEvent.ChatReply(content))
    }

    /** 模拟回复完成 */
    fun simulateChatComplete() {
        onEventCallback?.invoke(RelayEvent.ChatComplete)
    }

    /** 模拟收到权限请求 */
    fun simulatePermissionRequest(action: String, details: String) {
        onEventCallback?.invoke(RelayEvent.PermissionRequest(action, details))
    }

    /** 模拟收到选择请求 */
    fun simulateChoiceRequest(options: List<String>) {
        onEventCallback?.invoke(RelayEvent.ChoiceRequest(options))
    }

    /** 模拟模式切换 */
    fun simulateModeChanged(mode: String) {
        onEventCallback?.invoke(RelayEvent.ModeChanged(mode))
    }

    override fun sendChatMessage(content: String) {
        capturedMessages.add(content)
    }

    override fun sendPermissionResponse(approved: Boolean) {}
    override fun sendChoiceResponse(selected: Int) {}
    override fun sendInterrupt() {}
    override fun sendSetMode(mode: String) {}
    override fun queryDeviceStatus() {}
    override fun sendPing() { pingCount++ }
    override fun sendRaw(payload: String) {}

    override fun setOnEventListener(callback: (RelayEvent) -> Unit) {
        onEventCallback = callback
    }

    // 测试验证方法
    fun getCapturedUrl() = capturedUrl
    fun getCapturedUsername() = capturedUsername
    fun getCapturedPassword() = capturedPassword
    fun getCapturedMessages() = capturedMessages.toList()
    fun getPingCount() = pingCount
    fun getConnectCount() = connectCount

    /** 重置状态（每个测试前调用）*/
    fun reset() {
        _state.value = ConnectionState.Disconnected
        _desktopOnline.value = false
        onEventCallback = null
        capturedUrl = null
        capturedUsername = null
        capturedPassword = null
        capturedMessages.clear()
        pingCount = 0
        connectCount = 0
        intentionalDisconnect = false
        reconnectTimer?.cancel()
        reconnectTimer = null
    }
}
