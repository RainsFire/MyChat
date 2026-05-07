package com.mychat.data.api

import com.mychat.data.crypto.AESCipher
import com.mychat.data.crypto.ECDHCrypto
import com.mychat.log.AppLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

sealed class ConnectionState {
    data object Disconnected : ConnectionState()
    data object Connecting : ConnectionState()
    data object Authenticating : ConnectionState()
    data object Handshaking : ConnectionState()
    data object Connected : ConnectionState()
    data class Error(val message: String) : ConnectionState()
}

open class RelayClient {
    private val tag = "RelayClient"

    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private val ecdh = ECDHCrypto()
    private val aesCipher = AESCipher()

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    open val state: StateFlow<ConnectionState> = _state

    private val _desktopOnline = MutableStateFlow(false)
    open val desktopOnline: StateFlow<Boolean> = _desktopOnline

    // 收到的事件（解密后）
    private val _events = MutableStateFlow<RelayEvent?>(null)
    open val events: StateFlow<RelayEvent?> = _events

    private var onEventCallback: ((RelayEvent) -> Unit)? = null

    // 自动重连
    private var savedUrl: String = ""
    private var savedUsername: String = ""
    private var savedPassword: String = ""
    private var reconnectJob: java.util.Timer? = null
    private var intentionalDisconnect = false

    open fun setOnEventListener(callback: (RelayEvent) -> Unit) {
        onEventCallback = callback
    }

    open fun connect(url: String, username: String, password: String) {
        intentionalDisconnect = false
        reconnectJob?.cancel()
        reconnectJob = null

        if (_state.value is ConnectionState.Connecting ||
            _state.value is ConnectionState.Authenticating ||
            _state.value is ConnectionState.Connected
        ) return

        savedUrl = url
        savedUsername = username
        savedPassword = password

        _state.value = ConnectionState.Connecting
        AppLogger.i(tag, "连接: $url")

        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                AppLogger.i(tag, "WebSocket 已连接")
                _state.value = ConnectionState.Authenticating
                webSocket.send(RelayProtocol.auth(username, password))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                AppLogger.i(tag, "连接关闭: $code $reason")
                _state.value = ConnectionState.Disconnected
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                AppLogger.e(tag, "连接失败: ${t.message}")
                _state.value = ConnectionState.Error(t.message ?: "连接失败")
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (intentionalDisconnect) return
        if (savedUrl.isBlank()) return
        reconnectJob?.cancel()
        reconnectJob = java.util.Timer().also { timer ->
            timer.schedule(object : java.util.TimerTask() {
                override fun run() {
                    AppLogger.i(tag, "自动重连...")
                    connect(savedUrl, savedUsername, savedPassword)
                }
            }, 3000)
        }
    }

    private fun handleMessage(text: String) {
        val msg = try {
            JSONObject(text)
        } catch (e: Exception) { return }

        try {
            when (RelayProtocol.messageType(msg)) {
                "auth_ok" -> handleAuthOk()
                "auth_fail" -> handleAuthFail(msg)
                "key_init" -> handleKeyInit(msg)
                "key_response" -> handleKeyResponse(msg)
                "encrypted" -> handleEncrypted(msg)
                "device_status" -> handleDeviceStatus(msg)
                "pong" -> { /* heartbeat response */ }
            }
        } catch (e: Exception) {
            AppLogger.e(tag, "处理消息异常: type=${RelayProtocol.messageType(msg)}, error=${e.message}")
            e.printStackTrace()
        }
    }

    private fun handleAuthOk() {
        AppLogger.i(tag, "认证成功")
        _state.value = ConnectionState.Handshaking
        // 手机端发起密钥交换
        val pubKey = ecdh.initAsInitiator()
        webSocket?.send(RelayProtocol.keyInit(pubKey))
    }

    private fun handleAuthFail(msg: JSONObject) {
        val reason = RelayProtocol.authFailReason(msg)
        AppLogger.e(tag, "认证失败: $reason")
        _state.value = ConnectionState.Error(reason)
    }

    private fun handleKeyInit(msg: JSONObject) {
        val theirPubKey = RelayProtocol.publicKey(msg)
        val myPubKey = ecdh.initAsResponder(theirPubKey)
        aesCipher.setSharedKey(ecdh.sharedKey())
        webSocket?.send(RelayProtocol.keyResponse(myPubKey))
        _state.value = ConnectionState.Connected
        AppLogger.i(tag, "密钥交换完成 (responder)")
    }

    private fun handleKeyResponse(msg: JSONObject) {
        val theirPubKey = RelayProtocol.publicKey(msg)
        ecdh.completeHandshake(theirPubKey)
        aesCipher.setSharedKey(ecdh.sharedKey())
        _state.value = ConnectionState.Connected
        AppLogger.i(tag, "密钥交换完成 (initiator)")
        // 查询 desktop 状态
        webSocket?.send(RelayProtocol.queryDeviceStatus())
    }

    private fun handleEncrypted(msg: JSONObject) {
        val payload = RelayProtocol.payload(msg)
        val decrypted = try {
            val jsonStr = aesCipher.decrypt(payload)
            JSONObject(jsonStr)
        } catch (e: Exception) {
            AppLogger.e(tag, "解密失败: ${e.message}")
            return
        }

        when (decrypted.optString("type")) {
            "chat_reply" -> {
                val content = decrypted.optString("content", "")
                emitEvent(RelayEvent.ChatReply(content))
            }
            "chat_complete" -> {
                emitEvent(RelayEvent.ChatComplete)
            }
            "permission_request" -> {
                val action = decrypted.optString("action", "")
                val details = decrypted.optString("details", "")
                emitEvent(RelayEvent.PermissionRequest(action, details))
            }
            "choice_request" -> {
                val options = decrypted.optJSONArray("options")?.let { arr ->
                    (0 until arr.length()).map { arr.getString(it) }
                } ?: emptyList()
                emitEvent(RelayEvent.ChoiceRequest(options))
            }
            "mode_changed" -> {
                val mode = decrypted.optString("mode", "default")
                emitEvent(RelayEvent.ModeChanged(mode))
            }
            "crash_log_received" -> {
                emitEvent(RelayEvent.CrashLogReceived)
            }
            "image_ack" -> {
                val success = decrypted.optBoolean("success", false)
                emitEvent(RelayEvent.ImageAck(success))
            }
        }
    }

    private fun handleDeviceStatus(msg: JSONObject) {
        val device = RelayProtocol.deviceFromStatus(msg)
        val online = RelayProtocol.isOnline(msg)
        if (device == "desktop") {
            val wasOnline = _desktopOnline.value
            _desktopOnline.value = online
            AppLogger.i(tag, "desktop ${if (online) "在线" else "离线"}")

            // Desktop 离线时，重置密钥状态（新 desktop 需要重新握手）
            if (!online && wasOnline && _state.value == ConnectionState.Connected) {
                AppLogger.i(tag, "desktop 离线，重置密钥状态")
                ecdh.reset()
                _state.value = ConnectionState.Handshaking
            }

            // Desktop 上线且密钥未就绪时，重新发起密钥交换
            if (online && _state.value == ConnectionState.Handshaking) {
                AppLogger.i(tag, "desktop 上线，重新发起密钥交换")
                val pubKey = ecdh.initAsInitiator()
                webSocket?.send(RelayProtocol.keyInit(pubKey))
            }
        }
    }

    // 发送操作
    open fun sendChatMessage(content: String) {
        if (!isConnected()) return
        val payload = aesCipher.encrypt(RelayProtocol.chatMessage(content))
        webSocket?.send(RelayProtocol.encrypted(payload))
    }

    open fun sendImageMessage(imageBase64: String, text: String) {
        if (!isConnected()) return
        val payload = aesCipher.encrypt(RelayProtocol.imageMessage(imageBase64, text))
        webSocket?.send(RelayProtocol.encrypted(payload))
    }

    open fun sendPermissionResponse(approved: Boolean) {
        if (!isConnected()) return
        val payload = aesCipher.encrypt(RelayProtocol.permissionResponse(approved))
        webSocket?.send(RelayProtocol.encrypted(payload))
    }

    open fun sendChoiceResponse(selected: Int) {
        if (!isConnected()) return
        val payload = aesCipher.encrypt(RelayProtocol.choiceResponse(selected))
        webSocket?.send(RelayProtocol.encrypted(payload))
    }

    open fun sendInterrupt() {
        if (!isConnected()) return
        val payload = aesCipher.encrypt(RelayProtocol.interruptMsg())
        webSocket?.send(RelayProtocol.encrypted(payload))
    }

    open fun sendSetMode(mode: String) {
        if (!isConnected()) return
        val payload = aesCipher.encrypt(RelayProtocol.setMode(mode))
        webSocket?.send(RelayProtocol.encrypted(payload))
    }

    open fun queryDeviceStatus() {
        if (!isConnected()) return
        webSocket?.send(RelayProtocol.queryDeviceStatus())
    }

    open fun sendPing() {
        if (!isConnected()) return
        webSocket?.send(RelayProtocol.ping())
    }

    open fun sendRaw(payload: String) {
        if (!isConnected()) return
        webSocket?.send(RelayProtocol.encrypted(payload))
    }

    open fun disconnect() {
        intentionalDisconnect = true
        reconnectJob?.cancel()
        reconnectJob = null
        webSocket?.close(1000, "用户退出")
        webSocket = null
        _state.value = ConnectionState.Disconnected
    }

    private fun isConnected(): Boolean = _state.value is ConnectionState.Connected

    private fun emitEvent(event: RelayEvent) {
        onEventCallback?.invoke(event)
    }
}

sealed class RelayEvent {
    data class ChatReply(val content: String) : RelayEvent()
    data object ChatComplete : RelayEvent()
    data class PermissionRequest(val action: String, val details: String) : RelayEvent()
    data class ChoiceRequest(val options: List<String>) : RelayEvent()
    data class ModeChanged(val mode: String) : RelayEvent()
    data object CrashLogReceived : RelayEvent()
    data class ImageAck(val success: Boolean) : RelayEvent()
}