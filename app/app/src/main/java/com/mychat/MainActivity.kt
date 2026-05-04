package com.mychat

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.mychat.data.api.ConnectionState
import com.mychat.data.store.CredentialStore
import com.mychat.ui.ChatScreen
import com.mychat.ui.ChatViewModel
import com.mychat.ui.LoginScreen
import com.mychat.ui.theme.MyChatTheme
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MyChatTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    MyChatNavHost()
                }
            }
        }
    }
}

@Composable
fun MyChatNavHost() {
    val navController = rememberNavController()
    val context = LocalContext.current
    val viewModel: ChatViewModel = hiltViewModel()
    val connectionState by viewModel.connectionState.collectAsState()

    val startDestination = if (CredentialStore.hasCredentials(context)) "chat" else "login"

    // 自动登录：如果有保存的凭证且当前未连接，尝试自动连接
    LaunchedEffect(startDestination) {
        if (startDestination == "chat") {
            val url = CredentialStore.getUrl(context)
            val username = CredentialStore.getUsername(context)
            val password = CredentialStore.getPassword(context)
            if (connectionState is ConnectionState.Disconnected) {
                viewModel.connect(url, username, password)
            }
        }
    }

    // 连接断开时跳回登录页（用户主动退出除外）
    LaunchedEffect(connectionState) {
        if (connectionState is ConnectionState.Disconnected &&
            navController.currentDestination?.route == "chat" &&
            !CredentialStore.hasCredentials(context)
        ) {
            navController.navigate("login") {
                popUpTo("chat") { inclusive = true }
            }
        }
    }

    NavHost(navController = navController, startDestination = startDestination) {
        composable("login") {
            LoginScreen(
                viewModel = viewModel,
                onLoginSuccess = {
                    navController.navigate("chat") {
                        popUpTo("login") { inclusive = true }
                    }
                }
            )
        }
        composable("chat") {
            ChatScreen(
                viewModel = viewModel,
                onLogout = {
                    navController.navigate("login") {
                        popUpTo("chat") { inclusive = true }
                    }
                }
            )
        }
    }
}