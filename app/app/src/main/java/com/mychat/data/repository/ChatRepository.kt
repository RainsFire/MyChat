package com.mychat.data.repository

import com.mychat.data.api.ConnectionState
import com.mychat.data.api.RelayClient
import com.mychat.data.api.RelayEvent
import com.mychat.data.db.MessageDao
import com.mychat.data.db.MessageEntity
import com.mychat.log.AppLogger
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

class ChatRepository(
    private val messageDao: MessageDao,
    private val relayClient: RelayClient
) {
    private val tag = "ChatRepository"

    private val _messages = MutableStateFlow<List<MessageEntity>>(emptyList())
    val messages: StateFlow<List<MessageEntity>> = _messages

    val connectionState: StateFlow<ConnectionState> = relayClient.state
    val desktopOnline: StateFlow<Boolean> = relayClient.desktopOnline

    private var currentMode = "default"

    private val _relayEvents = MutableSharedFlow<RelayEvent>(extraBufferCapacity = 64)
    val relayEvents: SharedFlow<RelayEvent> = _relayEvents

    init {
        relayClient.setOnEventListener { event ->
            handleEvent(event)
            _relayEvents.tryEmit(event)
        }
    }

    /**
     * 连接中继服务器
     */
    fun connect(url: String, username: String, password: String) {
        relayClient.connect(url, username, password)
    }

    /**
     * 断开连接
     */
    fun disconnect() {
        relayClient.disconnect()
    }

    /**
     * 发送聊天消息
     */
    suspend fun sendMessage(content: String) {
        // 写入数据库 (pending)
        val id = messageDao.insert(
            MessageEntity(
                role = "user",
                content = content,
                status = "pending",
                createdAt = System.currentTimeMillis()
            )
        )
        refreshMessages()

        // 发送
        if (relayClient.state.value is ConnectionState.Connected) {
            relayClient.sendChatMessage(content)
            messageDao.updateStatus(id, "sent")
            refreshMessages()
        }

        AppLogger.i(tag, "发送消息: ${content.take(30)}...")
    }

    /**
     * 发送权限响应
     */
    fun sendPermissionResponse(approved: Boolean) {
        relayClient.sendPermissionResponse(approved)
    }

    /**
     * 发送选择响应
     */
    fun sendChoiceResponse(selected: Int) {
        relayClient.sendChoiceResponse(selected)
    }

    /**
     * 发送中断
     */
    fun sendInterrupt() {
        relayClient.sendInterrupt()
    }

    /**
     * 切换模式
     */
    fun setMode(mode: String) {
        currentMode = mode
        relayClient.sendSetMode(mode)
        AppLogger.i(tag, "切换模式: $mode")
    }

    fun getCurrentMode(): String = currentMode

    /**
     * 清空聊天记录
     */
    suspend fun clearHistory() {
        messageDao.deleteAll()
        refreshMessages()
        AppLogger.i(tag, "聊天记录已清空")
    }

    /**
     * 加载历史消息
     */
    suspend fun loadMessages() {
        refreshMessages()
    }

    /**
     * 连接恢复后发送 pending 消息
     */
    suspend fun flushPendingMessages() {
        val pending = messageDao.getPendingMessages()
        for (msg in pending) {
            relayClient.sendChatMessage(msg.content)
            messageDao.updateStatus(msg.id, "sent")
        }
        if (pending.isNotEmpty()) refreshMessages()
    }

    /**
     * 查询设备状态
     */
    fun queryDeviceStatus() {
        relayClient.queryDeviceStatus()
    }

    fun sendPing() {
        relayClient.sendPing()
    }

    private fun handleEvent(event: RelayEvent) {
        when (event) {
            is RelayEvent.ChatReply -> {
                // ChatReply 在 ViewModel 中处理（收集后写入数据库）
                AppLogger.d(tag, "收到回复: ${event.content.take(30)}...")
            }
            is RelayEvent.ChatComplete -> {
                AppLogger.d(tag, "回复完成")
            }
            is RelayEvent.PermissionRequest -> {
                AppLogger.d(tag, "权限请求: ${event.action}")
            }
            is RelayEvent.ChoiceRequest -> {
                AppLogger.d(tag, "选择请求: ${event.options}")
            }
            is RelayEvent.ModeChanged -> {
                currentMode = event.mode
                AppLogger.d(tag, "模式已切换: ${event.mode}")
            }
            is RelayEvent.CrashLogReceived -> {
                AppLogger.d(tag, "崩溃日志已接收")
            }
        }
    }

    private suspend fun refreshMessages() {
        _messages.value = messageDao.getRecent()
    }

    suspend fun saveAssistantMessage(content: String) {
        messageDao.insert(
            MessageEntity(
                role = "assistant",
                content = content,
                status = "delivered",
                createdAt = System.currentTimeMillis()
            )
        )
        refreshMessages()
    }
}