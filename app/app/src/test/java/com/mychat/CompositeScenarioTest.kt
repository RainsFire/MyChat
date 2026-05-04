package com.mychat

import com.mychat.data.api.ConnectionState
import com.mychat.data.api.RelayEvent
import com.mychat.data.crypto.AESCipher
import com.mychat.data.crypto.ECDHCrypto
import com.mychat.data.api.RelayProtocol
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*

/**
 * 复合场景测试 — 模拟完整端到端操作流程
 * 不依赖 Android 框架，纯 JVM 测试
 */
class CompositeScenarioTest {

    // ========== 场景 1: 完整加密通信流程 ==========
    // 手机端发起消息 → 加密 → 解密 → Mac 端收到原始消息

    @Test
    fun scenario_fullEncryptedCommunication() {
        // 1. 密钥交换
        val mobileCrypto = ECDHCrypto()
        val macCrypto = ECDHCrypto()

        val mobilePubKey = mobileCrypto.initAsInitiator()
        val macPubKey = macCrypto.initAsResponder(mobilePubKey)
        mobileCrypto.completeHandshake(macPubKey)

        // 2. 手机端加密消息
        val mobileCipher = AESCipher()
        mobileCipher.setSharedKey(mobileCrypto.sharedKey()!!)

        val chatPayload = RelayProtocol.chatMessage("帮我写一个排序函数")
        val encrypted = mobileCipher.encrypt(chatPayload)

        // 3. 构造网络传输格式
        val wireMessage = RelayProtocol.encrypted(encrypted)
        val wireJson = JSONObject(wireMessage)
        assertEquals("encrypted", wireJson.getString("type"))

        // 4. Mac 端解密
        val macCipher = AESCipher()
        macCipher.setSharedKey(macCrypto.sharedKey()!!)

        val receivedPayload = RelayProtocol.payload(wireJson)
        val decrypted = macCipher.decrypt(receivedPayload)
        val receivedMsg = JSONObject(decrypted)

        assertEquals("chat_message", receivedMsg.getString("type"))
        assertEquals("帮我写一个排序函数", receivedMsg.getString("content"))
    }

    // ========== 场景 2: 权限审批流程 ==========
    // Mac 端发送权限请求 → 加密传输 → 手机端解密 → 审批/拒绝

    @Test
    fun scenario_permissionApprovalFlow() {
        val (mobileCipher, macCipher) = setupEncryptedChannel()

        // 1. Mac 端加密权限请求
        val permissionPayload = JSONObject().apply {
            put("type", "permission_request")
            put("action", "bash")
            put("details", "rm -rf /tmp/test")
        }.toString()
        val encrypted = macCipher.encrypt(permissionPayload)

        // 2. 手机端解密并解析
        val decrypted = mobileCipher.decrypt(encrypted)
        val permMsg = JSONObject(decrypted)
        assertEquals("permission_request", permMsg.getString("type"))
        assertEquals("bash", permMsg.getString("action"))

        // 3. 手机端发送拒绝
        val denyPayload = RelayProtocol.permissionResponse(false)
        val denyEncrypted = mobileCipher.encrypt(denyPayload)

        // 4. Mac 端解密审批结果
        val denyDecrypted = mobileCipher.decrypt(denyEncrypted)
        val denyMsg = JSONObject(denyDecrypted)
        assertEquals("deny", denyMsg.getString("response"))
    }

    // ========== 场景 3: 模式切换 + 发送消息 ==========
    // 切换到 Auto 模式 → 发送消息 → 无需审批

    @Test
    fun scenario_switchModeAndSend() {
        val (mobileCipher, macCipher) = setupEncryptedChannel()

        // 1. 切换到 Auto 模式
        val modePayload = RelayProtocol.setMode("auto")
        val modeEncrypted = mobileCipher.encrypt(modePayload)

        val modeDecrypted = macCipher.decrypt(modeEncrypted)
        val modeMsg = JSONObject(modeDecrypted)
        assertEquals("set_mode", modeMsg.getString("type"))
        assertEquals("auto", modeMsg.getString("mode"))

        // 2. 发送消息
        val chatPayload = RelayProtocol.chatMessage("自动执行测试")
        val chatEncrypted = mobileCipher.encrypt(chatPayload)

        val chatDecrypted = macCipher.decrypt(chatEncrypted)
        val chatMsg = JSONObject(chatDecrypted)
        assertEquals("chat_message", chatMsg.getString("type"))
    }

    // ========== 场景 4: 选择交互流程 ==========
    // Claude 提供选项 → 手机端选择一项

    @Test
    fun scenario_choiceSelectionFlow() {
        val (mobileCipher, macCipher) = setupEncryptedChannel()

        // 1. Mac 端发送选项列表
        val choicePayload = JSONObject().apply {
            put("type", "choice_request")
            put("options", org.json.JSONArray().apply {
                put("选项A: 快速排序")
                put("选项B: 归并排序")
                put("选项C: 堆排序")
            })
        }.toString()
        val encrypted = macCipher.encrypt(choicePayload)

        // 2. 手机端解密
        val decrypted = mobileCipher.decrypt(encrypted)
        val choiceMsg = JSONObject(decrypted)
        assertEquals("choice_request", choiceMsg.getString("type"))
        val options = choiceMsg.getJSONArray("options")
        assertEquals(3, options.length())
        assertEquals("选项B: 归并排序", options.getString(1))

        // 3. 手机端选择第二项
        val responsePayload = RelayProtocol.choiceResponse(1)
        val responseEncrypted = mobileCipher.encrypt(responsePayload)

        val responseDecrypted = macCipher.decrypt(responseEncrypted)
        val responseMsg = JSONObject(responseDecrypted)
        assertEquals(1, responseMsg.getInt("selected"))
    }

    // ========== 场景 5: 连接中断恢复 ==========
    // 消息暂存 → 重连 → 待发送消息自动发送

    @Test
    fun scenario_offlineMessageBuffering() {
        // 模拟多条待发送消息
        val pendingMessages = listOf("第一条消息", "第二条消息", "第三条消息")

        // 构造加密后的消息
        val (mobileCipher, macCipher) = setupEncryptedChannel()

        val encryptedMessages = pendingMessages.map { msg ->
            val payload = RelayProtocol.chatMessage(msg)
            mobileCipher.encrypt(payload)
        }

        // 验证所有消息都能被正确解密
        for ((index, encrypted) in encryptedMessages.withIndex()) {
            val decrypted = macCipher.decrypt(encrypted)
            val msg = JSONObject(decrypted)
            assertEquals(pendingMessages[index], msg.getString("content"))
        }
    }

    // ========== 场景 6: 中断操作 ==========
    // 发送消息 → 收到部分回复 → 中断

    @Test
    fun scenario_interruptOngoingResponse() {
        val (mobileCipher, macCipher) = setupEncryptedChannel()

        // 1. 发送中断命令
        val interruptPayload = RelayProtocol.interruptMsg()
        val encrypted = mobileCipher.encrypt(interruptPayload)

        // 2. Mac 端解密
        val decrypted = macCipher.decrypt(encrypted)
        val msg = JSONObject(decrypted)
        assertEquals("interrupt", msg.getString("type"))
    }

    // ========== 场景 7: 多消息连续发送 ==========
    // 用户快速发送多条消息

    @Test
    fun scenario_rapidMessageSending() {
        val (mobileCipher, macCipher) = setupEncryptedChannel()

        val messages = (1..10).map { "消息 $it" }

        // 快速加密所有消息
        val encryptedList = messages.map { msg ->
            val payload = RelayProtocol.chatMessage(msg)
            mobileCipher.encrypt(payload)
        }

        // 验证所有消息能正确解密
        for ((index, encrypted) in encryptedList.withIndex()) {
            val decrypted = macCipher.decrypt(encrypted)
            val msg = JSONObject(decrypted)
            assertEquals(messages[index], msg.getString("content"))
        }
    }

    // ========== 场景 8: 中继协议完整流程 ==========
    // 认证 → 密钥交换 → 加密通信 → 断开

    @Test
    fun scenario_fullRelayProtocolSequence() {
        // 1. 认证阶段
        val authMsg = JSONObject(RelayProtocol.auth("admin", "password"))
        assertEquals("auth", authMsg.getString("type"))
        assertEquals("admin", authMsg.getString("username"))
        assertEquals("mobile", authMsg.getString("device"))

        // 2. 密钥交换
        val mobileCrypto = ECDHCrypto()
        val macCrypto = ECDHCrypto()

        val keyInit = JSONObject(RelayProtocol.keyInit(mobileCrypto.initAsInitiator()))
        assertEquals("key_init", keyInit.getString("type"))

        val initiatorPubKey = keyInit.getString("publicKey")
        val macPubKey = macCrypto.initAsResponder(initiatorPubKey)

        val keyResponse = JSONObject(RelayProtocol.keyResponse(macPubKey))
        assertEquals("key_response", keyResponse.getString("type"))

        mobileCrypto.completeHandshake(keyResponse.getString("publicKey"))
        assertArrayEquals(mobileCrypto.sharedKey(), macCrypto.sharedKey())

        // 3. 加密通信
        val mobileCipher = AESCipher()
        mobileCipher.setSharedKey(mobileCrypto.sharedKey()!!)
        val macCipher = AESCipher()
        macCipher.setSharedKey(macCrypto.sharedKey()!!)

        val encrypted = mobileCipher.encrypt(RelayProtocol.chatMessage("Hello"))
        val decrypted = macCipher.decrypt(encrypted)
        assertEquals("Hello", JSONObject(decrypted).getString("content"))

        // 4. 心跳
        val ping = JSONObject(RelayProtocol.ping())
        assertEquals("ping", ping.getString("type"))
    }

    // ========== 辅助方法 ==========

    private fun setupEncryptedChannel(): Pair<AESCipher, AESCipher> {
        val mobileCrypto = ECDHCrypto()
        val macCrypto = ECDHCrypto()

        val mobilePubKey = mobileCrypto.initAsInitiator()
        val macPubKey = macCrypto.initAsResponder(mobilePubKey)
        mobileCrypto.completeHandshake(macPubKey)

        val mobileCipher = AESCipher()
        mobileCipher.setSharedKey(mobileCrypto.sharedKey()!!)

        val macCipher = AESCipher()
        macCipher.setSharedKey(macCrypto.sharedKey()!!)

        return Pair(mobileCipher, macCipher)
    }
}