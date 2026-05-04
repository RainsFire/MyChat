package com.mychat.data.api

import org.json.JSONObject

object RelayProtocol {

    // 连接阶段
    fun auth(username: String, password: String): String = JSONObject().apply {
        put("type", "auth")
        put("username", username)
        put("password", password)
        put("device", "mobile")
    }.toString()

    fun isAuthOk(msg: JSONObject): Boolean = msg.optString("type") == "auth_ok"
    fun isAuthFail(msg: JSONObject): Boolean = msg.optString("type") == "auth_fail"
    fun authFailReason(msg: JSONObject): String = msg.optString("reason", "认证失败")

    // 密钥交换
    fun keyInit(publicKey: String): String = JSONObject().apply {
        put("type", "key_init")
        put("publicKey", publicKey)
    }.toString()

    fun keyResponse(publicKey: String): String = JSONObject().apply {
        put("type", "key_response")
        put("publicKey", publicKey)
    }.toString()

    // 加密消息
    fun encrypted(payload: String): String = JSONObject().apply {
        put("type", "encrypted")
        put("payload", payload)
    }.toString()

    // 心跳
    fun ping(): String = JSONObject().apply { put("type", "ping") }.toString()

    // 查询设备状态
    fun queryDeviceStatus(): String = JSONObject().apply {
        put("type", "query_device_status")
    }.toString()

    // 内部加密 payload 构造
    fun chatMessage(content: String): String = JSONObject().apply {
        put("type", "chat_message")
        put("content", content)
    }.toString()

    fun permissionResponse(approved: Boolean): String = JSONObject().apply {
        put("type", "permission_response")
        put("response", if (approved) "approve" else "deny")
    }.toString()

    fun choiceResponse(selected: Int): String = JSONObject().apply {
        put("type", "choice_response")
        put("selected", selected)
    }.toString()

    fun interruptMsg(): String = JSONObject().apply {
        put("type", "interrupt")
    }.toString()

    fun setMode(mode: String): String = JSONObject().apply {
        put("type", "set_mode")
        put("mode", mode)
    }.toString()

    // 解析消息类型
    fun messageType(msg: JSONObject): String = msg.optString("type", "")

    // 解析 device_status
    fun deviceFromStatus(msg: JSONObject): String = msg.optString("device", "")
    fun isOnline(msg: JSONObject): Boolean = msg.optBoolean("online", false)

    // 解析 key_init / key_response
    fun publicKey(msg: JSONObject): String = msg.optString("publicKey", "")

    // 解析 encrypted payload
    fun payload(msg: JSONObject): String = msg.optString("payload", "")
}