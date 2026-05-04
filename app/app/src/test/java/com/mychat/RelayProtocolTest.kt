package com.mychat

import com.mychat.data.api.RelayProtocol
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*

/**
 * UT-04: RelayProtocol JSON 解析
 * UT-05: 无效消息类型处理
 */
class RelayProtocolTest {

    // ========== UT-04: 消息构造与解析 ==========

    @Test
    fun ut04_authMessage_correctFormat() {
        val json = RelayProtocol.auth("admin", "pass123")
        val msg = JSONObject(json)

        assertEquals("auth", msg.getString("type"))
        assertEquals("admin", msg.getString("username"))
        assertEquals("pass123", msg.getString("password"))
        assertEquals("mobile", msg.getString("device"))
    }

    @Test
    fun ut04_keyInitMessage() {
        val json = RelayProtocol.keyInit("pubkey123")
        val msg = JSONObject(json)

        assertEquals("key_init", msg.getString("type"))
        assertEquals("pubkey123", msg.getString("publicKey"))
    }

    @Test
    fun ut04_keyResponseMessage() {
        val json = RelayProtocol.keyResponse("resppubkey456")
        val msg = JSONObject(json)

        assertEquals("key_response", msg.getString("type"))
        assertEquals("resppubkey456", msg.getString("publicKey"))
    }

    @Test
    fun ut04_encryptedMessage() {
        val json = RelayProtocol.encrypted("encrypted_payload_data")
        val msg = JSONObject(json)

        assertEquals("encrypted", msg.getString("type"))
        assertEquals("encrypted_payload_data", msg.getString("payload"))
    }

    @Test
    fun ut04_chatMessagePayload() {
        val json = RelayProtocol.chatMessage("Hello World")
        val msg = JSONObject(json)

        assertEquals("chat_message", msg.getString("type"))
        assertEquals("Hello World", msg.getString("content"))
    }

    @Test
    fun ut04_permissionResponse_approve() {
        val json = RelayProtocol.permissionResponse(true)
        val msg = JSONObject(json)

        assertEquals("permission_response", msg.getString("type"))
        assertEquals("approve", msg.getString("response"))
    }

    @Test
    fun ut04_permissionResponse_deny() {
        val json = RelayProtocol.permissionResponse(false)
        val msg = JSONObject(json)

        assertEquals("deny", msg.getString("response"))
    }

    @Test
    fun ut04_choiceResponse() {
        val json = RelayProtocol.choiceResponse(2)
        val msg = JSONObject(json)

        assertEquals("choice_response", msg.getString("type"))
        assertEquals(2, msg.getInt("selected"))
    }

    @Test
    fun ut04_interruptMessage() {
        val json = RelayProtocol.interruptMsg()
        val msg = JSONObject(json)

        assertEquals("interrupt", msg.getString("type"))
    }

    @Test
    fun ut04_setModeMessage() {
        val modes = listOf("auto", "default", "plan")
        for (mode in modes) {
            val json = RelayProtocol.setMode(mode)
            val msg = JSONObject(json)
            assertEquals("set_mode", msg.getString("type"))
            assertEquals(mode, msg.getString("mode"))
        }
    }

    @Test
    fun ut04_pingPongMessages() {
        val ping = JSONObject(RelayProtocol.ping())
        assertEquals("ping", ping.getString("type"))
    }

    @Test
    fun ut04_queryDeviceStatus() {
        val json = JSONObject(RelayProtocol.queryDeviceStatus())
        assertEquals("query_device_status", json.getString("type"))
    }

    // ========== 消息解析 ==========

    @Test
    fun ut04_messageType_parsing() {
        assertEquals("auth_ok", RelayProtocol.messageType(JSONObject("""{"type":"auth_ok"}""")))
        assertEquals("auth_fail", RelayProtocol.messageType(JSONObject("""{"type":"auth_fail","reason":"test"}""")))
        assertEquals("encrypted", RelayProtocol.messageType(JSONObject("""{"type":"encrypted","payload":"x"}""")))
        assertEquals("device_status", RelayProtocol.messageType(JSONObject("""{"type":"device_status","device":"desktop","online":true}""")))
    }

    @Test
    fun ut04_authResultParsing() {
        val okMsg = JSONObject("""{"type":"auth_ok"}""")
        assertTrue(RelayProtocol.isAuthOk(okMsg))
        assertFalse(RelayProtocol.isAuthFail(okMsg))

        val failMsg = JSONObject("""{"type":"auth_fail","reason":"密码错误"}""")
        assertFalse(RelayProtocol.isAuthOk(failMsg))
        assertTrue(RelayProtocol.isAuthFail(failMsg))
        assertEquals("密码错误", RelayProtocol.authFailReason(failMsg))
    }

    @Test
    fun ut04_deviceStatusParsing() {
        val msg = JSONObject("""{"type":"device_status","device":"desktop","online":true}""")
        assertEquals("desktop", RelayProtocol.deviceFromStatus(msg))
        assertTrue(RelayProtocol.isOnline(msg))

        val offlineMsg = JSONObject("""{"type":"device_status","device":"mobile","online":false}""")
        assertEquals("mobile", RelayProtocol.deviceFromStatus(offlineMsg))
        assertFalse(RelayProtocol.isOnline(offlineMsg))
    }

    @Test
    fun ut04_publicKeyParsing() {
        val msg = JSONObject("""{"type":"key_init","publicKey":"abc123"}""")
        assertEquals("abc123", RelayProtocol.publicKey(msg))
    }

    @Test
    fun ut04_payloadParsing() {
        val msg = JSONObject("""{"type":"encrypted","payload":"encrypted_data_here"}""")
        assertEquals("encrypted_data_here", RelayProtocol.payload(msg))
    }

    // ========== UT-05: 无效消息处理 ==========

    @Test
    fun ut05_emptyMessageType() {
        val msg = JSONObject("""{"foo":"bar"}""")
        assertEquals("", RelayProtocol.messageType(msg))
    }

    @Test
    fun ut05_missingFields_returnsDefaults() {
        val emptyMsg = JSONObject("""{}""")
        assertEquals("", RelayProtocol.deviceFromStatus(emptyMsg))
        assertFalse(RelayProtocol.isOnline(emptyMsg))
        assertEquals("", RelayProtocol.publicKey(emptyMsg))
        assertEquals("", RelayProtocol.payload(emptyMsg))
        assertEquals("认证失败", RelayProtocol.authFailReason(emptyMsg)) // 默认值
    }
}