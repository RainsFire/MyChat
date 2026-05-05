package com.mychat.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mychat.data.api.ConnectionState
import com.mychat.ui.components.ChatInputBar
import com.mychat.ui.components.MessageBubble
import com.mychat.ui.components.StatusBar

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    viewModel: ChatViewModel = hiltViewModel(),
    onLogout: () -> Unit = {}
) {
    val messages by viewModel.messages.collectAsState()
    val connectionState by viewModel.connectionState.collectAsState()
    val desktopOnline by viewModel.desktopOnline.collectAsState()
    val currentMode by viewModel.currentMode.collectAsState()
    val isResponding by viewModel.isResponding.collectAsState()
    val permissionRequest by viewModel.permissionRequest.collectAsState()
    val choiceRequest by viewModel.choiceRequest.collectAsState()
    var showSettings by remember { mutableStateOf(false) }

    val listState = rememberLazyListState()
    var hasScrolledToBottom by remember { mutableStateOf(false) }

    // 初次加载：瞬间跳到底部；新消息：平滑滚动
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            if (!hasScrolledToBottom) {
                listState.scrollToItem(messages.size - 1)
                hasScrolledToBottom = true
            } else {
                listState.animateScrollToItem(messages.size - 1)
            }
        }
    }

    // 键盘弹收时即时滚动，避免与系统键盘动画冲突产生卡顿
    val density = LocalDensity.current
    val imeBottom = WindowInsets.ime.getBottom(density)

    LaunchedEffect(imeBottom) {
        if (messages.isNotEmpty()) {
            listState.scrollToItem(messages.size - 1)
        }
    }

    Scaffold(
        modifier = Modifier.imePadding(),
        topBar = {
            Surface(
                color = MaterialTheme.colorScheme.background
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .statusBarsPadding(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    StatusBar(
                        connectionState = connectionState,
                        desktopOnline = desktopOnline,
                        currentMode = currentMode,
                        onModeChange = { viewModel.setMode(it) },
                        modifier = Modifier.weight(1f)
                    )
                    IconButton(
                        onClick = { showSettings = true },
                        modifier = Modifier.testTag("settings_button")
                    ) {
                        Icon(Icons.Filled.Settings, contentDescription = "设置")
                    }
                }
            }
        },
        bottomBar = {
            Surface(
                color = MaterialTheme.colorScheme.background
            ) {
                ChatInputBar(
                    isResponding = isResponding,
                    onSend = { viewModel.sendMessage(it) },
                    onStop = { viewModel.sendInterrupt() },
                    modifier = Modifier.navigationBarsPadding()
                )
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            if (messages.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = when (connectionState) {
                            is ConnectionState.Connected -> if (desktopOnline) "发送消息开始对话" else "等待 Claude 上线..."
                            is ConnectionState.Disconnected -> "未连接"
                            is ConnectionState.Error -> "连接失败，请重试"
                            else -> "连接中..."
                        },
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f)
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .testTag("message_list"),
                    contentPadding = PaddingValues(vertical = 8.dp)
                ) {
                    items(messages, key = { it.id }) { message ->
                        MessageBubble(message = message)
                    }
                }
            }
        }
    }

    // 权限请求对话框
    permissionRequest?.let { req ->
        AlertDialog(
            onDismissRequest = {},
            modifier = Modifier.testTag("permission_dialog"),
            title = { Text("权限请求") },
            text = {
                Column {
                    Text("操作: ${req.action}")
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(req.details)
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.sendPermissionResponse(true)
                    },
                    modifier = Modifier.testTag("permission_approve")
                ) {
                    Text("允许")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        viewModel.sendPermissionResponse(false)
                    },
                    modifier = Modifier.testTag("permission_deny")
                ) {
                    Text("拒绝")
                }
            }
        )
    }

    // 选择对话框
    choiceRequest?.let { req ->
        AlertDialog(
            onDismissRequest = {},
            modifier = Modifier.testTag("choice_dialog"),
            title = { Text("请选择") },
            text = {
                Column {
                    req.options.forEachIndexed { index, option ->
                        TextButton(
                            onClick = { viewModel.sendChoiceResponse(index) },
                            modifier = Modifier.testTag("choice_option_$index")
                        ) {
                            Text(option)
                        }
                    }
                }
            },
            confirmButton = {}
        )
    }

    // 设置对话框
    if (showSettings) {
        AlertDialog(
            onDismissRequest = { showSettings = false },
            title = { Text("设置") },
            text = {
                Column {
                    OutlinedButton(
                        onClick = {
                            viewModel.clearHistory()
                            showSettings = false
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("clear_history_button")
                    ) {
                        Text("清空聊天记录")
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = {
                            viewModel.logout()
                            showSettings = false
                            onLogout()
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("logout_button")
                    ) {
                        Text("退出登录")
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showSettings = false }) {
                    Text("关闭")
                }
            }
        )
    }
}