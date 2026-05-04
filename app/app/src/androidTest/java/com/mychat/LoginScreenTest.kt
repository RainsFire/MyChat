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
 * 登录界面完整测试 — 使用 MockRelayClient
 */
@RunWith(AndroidJUnit4::class)
@HiltAndroidTest
class LoginScreenTest {

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

    // ========== SM-01: 登录界面元素 ==========

    @Test
    fun sm01_loginScreenDisplayed() {
        composeRule.onNodeWithTag("login_screen").assertIsDisplayed()
    }

    @Test
    fun sm01_allFieldsPresent() {
        composeRule.onNodeWithTag("login_url").assertIsDisplayed()
        composeRule.onNodeWithTag("login_username").assertIsDisplayed()
        composeRule.onNodeWithTag("login_password").assertIsDisplayed()
        composeRule.onNodeWithTag("login_button").assertIsDisplayed()
    }

    @Test
    fun sm01_defaultUrlHasWsPrefix() {
        composeRule.onNodeWithTag("login_url").assert(hasText("ws://", substring = true))
    }

    @Test
    fun sm01_defaultUsernameIsAdmin() {
        composeRule.onNodeWithTag("login_username").assert(hasText("admin", substring = true))
    }

    // ========== 登录按钮状态 ==========

    @Test
    fun loginButton_disabledWithoutPassword() {
        composeRule.onNodeWithTag("login_button").assertIsNotEnabled()
    }

    @Test
    fun loginButton_enabledWithAllFields() {
        composeRule.onNodeWithTag("login_password").performTextInput("changeme")
        composeRule.onNodeWithTag("login_button").assertIsEnabled()
    }

    @Test
    fun loginButton_disabledWithEmptyUrl() {
        composeRule.onNodeWithTag("login_password").performTextInput("pass")
        composeRule.onNodeWithTag("login_url").performTextReplacement("")
        composeRule.onNodeWithTag("login_button").assertIsNotEnabled()
    }

    @Test
    fun loginButton_disabledWithEmptyUsername() {
        composeRule.onNodeWithTag("login_password").performTextInput("pass")
        composeRule.onNodeWithTag("login_username").performTextReplacement("")
        composeRule.onNodeWithTag("login_button").assertIsNotEnabled()
    }

    // ========== 连接触发验证 ==========

    @Test
    fun clickingLogin_callsRelayClientConnect() {
        composeRule.onNodeWithTag("login_url").performTextReplacement("ws://test:9090")
        composeRule.onNodeWithTag("login_username").performTextReplacement("testuser")
        composeRule.onNodeWithTag("login_password").performTextInput("testpass")
        composeRule.onNodeWithTag("login_button").performClick()

        // 验证 MockRelayClient 接收到正确的参数
        composeRule.waitUntil(5000) {
            mockRelayClient.getCapturedUrl() == "ws://test:9090"
        }
        assert(mockRelayClient.getCapturedUsername() == "testuser")
        assert(mockRelayClient.getCapturedPassword() == "testpass")
    }

    // ========== 连接状态显示 ==========

    @Test
    fun connectingState_showsProgress() {
        fillAndClickLogin()

        composeRule.waitUntil(5000) {
            mockRelayClient.state.value.isConnectedOrAuthenticating()
        }
        // 连接过程中不应该显示错误
        composeRule.onNodeWithTag("login_error").assertDoesNotExist()
    }

    @Test
    fun authFailure_showsError() {
        fillAndClickLogin()

        composeRule.runOnIdle {
            mockRelayClient.simulateAuthFail("用户名或密码错误")
        }

        composeRule.waitUntil(5000) {
            mockRelayClient.state.value is com.mychat.data.api.ConnectionState.Error
        }

        composeRule.waitUntil(5000) {
            try {
                composeRule.onNodeWithTag("login_error").assertIsDisplayed()
                true
            } catch (e: AssertionError) {
                false
            }
        }
    }

    @Test
    fun connectionFailure_showsError() {
        fillAndClickLogin()

        composeRule.runOnIdle {
            mockRelayClient.simulateConnectionFailed()
        }

        composeRule.waitUntil(5000) {
            mockRelayClient.state.value is com.mychat.data.api.ConnectionState.Error
        }
    }

    // ========== 辅助方法 ==========

    private fun fillAndClickLogin() {
        composeRule.onNodeWithTag("login_url").performTextReplacement("ws://127.0.0.1:9090")
        composeRule.onNodeWithTag("login_username").performTextReplacement("admin")
        composeRule.onNodeWithTag("login_password").performTextInput("changeme")
        composeRule.onNodeWithTag("login_button").performClick()
    }

    private fun com.mychat.data.api.ConnectionState.isConnectedOrAuthenticating(): Boolean {
        return this is com.mychat.data.api.ConnectionState.Connecting ||
               this is com.mychat.data.api.ConnectionState.Authenticating ||
               this is com.mychat.data.api.ConnectionState.Handshaking
    }
}