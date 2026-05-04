package com.mychat

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.mychat.data.store.CredentialStore
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import javax.inject.Inject
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 聊天界面测试 — 验证登录前不可见聊天元素
 * 登录后的完整测试需要集成测试环境
 */
@RunWith(AndroidJUnit4::class)
@HiltAndroidTest
class ChatScreenTest {

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

    // ========== 登录前：聊天元素不可见 ==========

    @Test
    fun beforeLogin_chatInputNotVisible() {
        composeRule.onNodeWithTag("chat_input").assertDoesNotExist()
    }

    @Test
    fun beforeLogin_messageListNotVisible() {
        composeRule.onNodeWithTag("message_list").assertDoesNotExist()
    }

    @Test
    fun beforeLogin_statusBarNotVisible() {
        composeRule.onNodeWithTag("status_bar").assertDoesNotExist()
    }

    @Test
    fun beforeLogin_settingsButtonNotVisible() {
        composeRule.onNodeWithTag("settings_button").assertDoesNotExist()
    }

    // ========== MockRelayClient 行为验证 ==========

    @Test
    fun relayClient_canSimulateConnection() {
        mockRelayClient.simulateConnected()
        assert(mockRelayClient.state.value is com.mychat.data.api.ConnectionState.Connected)
    }

    @Test
    fun relayClient_canSimulateAuthFailure() {
        mockRelayClient.simulateAuthFail("测试错误")
        val state = mockRelayClient.state.value
        assert(state is com.mychat.data.api.ConnectionState.Error)
        assert((state as com.mychat.data.api.ConnectionState.Error).message == "测试错误")
    }

    @Test
    fun relayClient_canSimulateDisconnection() {
        mockRelayClient.simulateConnected()
        mockRelayClient.simulateDisconnected()
        assert(mockRelayClient.state.value is com.mychat.data.api.ConnectionState.Disconnected)
    }

    @Test
    fun relayClient_canCaptureSentMessages() {
        mockRelayClient.simulateConnected()
        mockRelayClient.sendChatMessage("Hello")
        assert(mockRelayClient.getCapturedMessages().contains("Hello"))
    }
}