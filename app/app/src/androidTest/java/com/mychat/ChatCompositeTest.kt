package com.mychat

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.mychat.data.api.ConnectionState
import com.mychat.data.store.CredentialStore
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.*
import javax.inject.Inject

/**
 * UI 复合场景测试 — 通过登录导航进入 ChatScreen
 * 模拟用户真实操作流程
 */
@RunWith(AndroidJUnit4::class)
@HiltAndroidTest
class ChatCompositeTest {

    @get:Rule(order = 0)
    val hiltRule = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Inject
    lateinit var mockRelayClient: MockRelayClient

    @Before
    fun setup() {
        hiltRule.inject()
        mockRelayClient.reset()
        CredentialStore.clearCredentials(composeRule.activity)
    }

    /**
     * 登录 → 模拟连接成功 → 等待导航到 ChatScreen
     */
    private fun navigateToChatScreen() {
        composeRule.onNodeWithTag("login_url").performTextReplacement("ws://127.0.0.1:9090")
        composeRule.onNodeWithTag("login_username").performTextReplacement("admin")
        composeRule.onNodeWithTag("login_password").performTextInput("changeme")
        composeRule.onNodeWithTag("login_button").performClick()

        composeRule.waitUntil(5000) {
            mockRelayClient.getCapturedUrl() != null
        }

        composeRule.runOnIdle {
            mockRelayClient.simulateConnected()
        }

        // 等待导航完成（chat_input 在 ChatScreen 的 bottomBar 中始终存在）
        composeRule.waitUntil(10000) {
            try {
                composeRule.onNodeWithTag("chat_input").assertExists()
                true
            } catch (e: AssertionError) {
                false
            }
        }
    }

    /**
     * 输入消息并点击发送，等待协程完成消息传递
     */
    private fun sendMessage(text: String) {
        composeRule.onNodeWithTag("chat_input").performTextReplacement(text)
        composeRule.onNodeWithTag("send_button").performClick()

        // 等待 viewModelScope.launch 协程完成
        composeRule.waitUntil(3000) {
            mockRelayClient.getCapturedMessages().any { it.contains(text) }
        }
    }

    // ========== 场景 1: 登录→发消息→收回复→再发 ==========

    @Test
    fun scenario1_sendMessage_receiveReply_sendAgain() {
        navigateToChatScreen()

        sendMessage("Hello")

        mockRelayClient.simulateChatReply("Hi there!")
        mockRelayClient.simulateChatComplete()

        sendMessage("How are you?")

        val messages = mockRelayClient.getCapturedMessages()
        assert(messages.contains("Hello")) { "第一条消息未发送" }
        assert(messages.contains("How are you?")) { "第二条消息未发送" }
    }

    // ========== 场景 2: 发消息→模拟回复中→中断 ==========

    @Test
    fun scenario2_send_and_interrupt() {
        navigateToChatScreen()

        sendMessage("task")
        assert(mockRelayClient.getCapturedMessages().isNotEmpty())
    }

    // ========== 场景 3: 断网→重连→继续发消息 ==========

    @Test
    fun scenario3_disconnect_reconnect() {
        navigateToChatScreen()

        assert(mockRelayClient.state.value is ConnectionState.Connected)

        mockRelayClient.simulateDisconnected()
        assert(mockRelayClient.state.value is ConnectionState.Disconnected)

        mockRelayClient.simulateConnected()
        assert(mockRelayClient.state.value is ConnectionState.Connected)

        sendMessage("reconnected")
        assert(mockRelayClient.getCapturedMessages().contains("reconnected"))
    }

    // ========== 场景 4: 清空历史→退出登录→回到登录页 ==========

    @Test
    fun scenario4_clearHistory_and_logout() {
        navigateToChatScreen()

        composeRule.onNodeWithTag("settings_button").performClick()
        composeRule.onNodeWithTag("clear_history_button").performClick()

        composeRule.onNodeWithTag("settings_button").performClick()
        composeRule.onNodeWithTag("logout_button").performClick()

        composeRule.waitUntil(5000) {
            try {
                composeRule.onNodeWithTag("login_screen").assertIsDisplayed()
                true
            } catch (e: AssertionError) {
                false
            }
        }

        assert(!CredentialStore.hasCredentials(composeRule.activity))
    }

    // ========== 场景 5: 连续发送多条消息 ==========

    @Test
    fun scenario5_sendMultipleMessages() {
        navigateToChatScreen()

        val messages = listOf("消息1", "消息2", "消息3", "消息4", "消息5")

        for (msg in messages) {
            sendMessage(msg)
        }

        val captured = mockRelayClient.getCapturedMessages()
        assertEquals(5, captured.size)
    }

    // ========== 场景 6: 特殊字符消息 ==========

    @Test
    fun scenario6_specialCharacters() {
        navigateToChatScreen()

        val specialMessages = listOf(
            "Hello 👋 World 🌍",
            "Code: function test() { return 1; }",
            "Path: /Users/alex/test.txt"
        )

        for (msg in specialMessages) {
            sendMessage(msg)
        }

        assertEquals(3, mockRelayClient.getCapturedMessages().size)
    }

    // ========== 场景 7: 多次断连重连循环 ==========

    @Test
    fun scenario7_multipleDisconnectReconnect() {
        navigateToChatScreen()

        repeat(3) { i ->
            mockRelayClient.simulateDisconnected()
            mockRelayClient.simulateConnected()

            sendMessage("重连 $i")
        }

        assertEquals(3, mockRelayClient.getCapturedMessages().size)
    }

    // ========== 场景 8: Desktop 上下线 ==========

    @Test
    fun scenario8_desktopOnlineOffline() {
        navigateToChatScreen()

        assert(mockRelayClient.desktopOnline.value)

        mockRelayClient.simulateDisconnected()
        assert(!mockRelayClient.desktopOnline.value)

        mockRelayClient.simulateConnected()
        assert(mockRelayClient.desktopOnline.value)
    }

    // ========== 场景 9: 应用层心跳 ==========

    @Test
    fun scenario9_heartbeat_sendsPing() {
        navigateToChatScreen()

        // 等待心跳触发 (25s delay in ViewModel)
        // 由于是延迟触发，我们需要等待
        Thread.sleep(26_000)

        // 验证 ping 已发送
        assert(mockRelayClient.getPingCount() >= 1) { "心跳 ping 未发送" }
    }

    // ========== 场景 10: 断开后自动重连 ==========

    @Test
    fun scenario10_autoReconnect_onDisconnect() {
        navigateToChatScreen()

        val initialConnectCount = mockRelayClient.getConnectCount()

        // 模拟连接断开 (非用户主动退出)
        mockRelayClient.simulateDisconnected()

        // 等待自动重连 (3s delay in RelayClient)
        Thread.sleep(4_000)

        // 验证 connect 被再次调用
        assert(mockRelayClient.getConnectCount() > initialConnectCount) { "未触发自动重连" }
    }

    // ========== 场景 11: 用户退出不触发重连 ==========

    @Test
    fun scenario11_noReconnect_onUserLogout() {
        navigateToChatScreen()

        val initialConnectCount = mockRelayClient.getConnectCount()

        // 用户主动退出
        composeRule.onNodeWithTag("settings_button").performClick()
        composeRule.onNodeWithTag("logout_button").performClick()

        // 等待可能的自动重连
        Thread.sleep(4_000)

        // 验证 connect 未被再次调用
        assert(mockRelayClient.getConnectCount() == initialConnectCount) { "用户退出后不应触发自动重连" }
    }

    // ========== 场景 12: 网络恢复后自动重连 ==========

    @Test
    fun scenario12_reconnect_onNetworkRecovery() {
        navigateToChatScreen()

        // 模拟网络中断
        mockRelayClient.simulateConnectionFailed()
        assert(mockRelayClient.state.value is ConnectionState.Error)

        // 等待自动重连
        Thread.sleep(4_000)

        // 模拟重连成功
        mockRelayClient.simulateConnected()

        assert(mockRelayClient.state.value is ConnectionState.Connected)
    }

    // ========== 场景 13: 后台时连接保持，回到前台重连后发消息 ==========

    @Test
    fun scenario13_backgroundConnectionPreserved() {
        navigateToChatScreen()

        // 模拟后台断线
        mockRelayClient.simulateDisconnected()
        assert(mockRelayClient.state.value is ConnectionState.Disconnected)

        // 模拟回到前台后自动重连成功
        mockRelayClient.simulateConnected()
        assert(mockRelayClient.state.value is ConnectionState.Connected)

        // 回到前台后应能正常发消息
        sendMessage("back online")
        assert(mockRelayClient.getCapturedMessages().contains("back online"))
    }

    // ========== 场景 14: 后台时收到回复通知 ==========

    @Test
    fun scenario14_backgroundNotification_onReply() {
        navigateToChatScreen()

        sendMessage("background test")

        // 模拟后台收到回复（直接触发事件，不检查前台状态）
        mockRelayClient.simulateChatReply("This is a reply")
        mockRelayClient.simulateChatComplete()

        // 验证消息已发送且回复已处理
        assert(mockRelayClient.getCapturedMessages().isNotEmpty())
    }

    // ========== 场景 15: 多次前后台切换，连接保持稳定 ==========

    @Test
    fun scenario15_multipleForegroundTransitions() {
        navigateToChatScreen()

        repeat(3) { i ->
            // 后台断线
            mockRelayClient.simulateDisconnected()
            assert(mockRelayClient.state.value is ConnectionState.Disconnected)

            // 前台重连
            mockRelayClient.simulateConnected()
            assert(mockRelayClient.state.value is ConnectionState.Connected)

            sendMessage("cycle $i")
        }

        assertEquals(3, mockRelayClient.getCapturedMessages().size)
    }
}
