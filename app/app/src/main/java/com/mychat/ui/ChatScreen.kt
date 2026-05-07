package com.mychat.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mychat.data.api.ConnectionState
import com.mychat.ui.components.ChatInputBar
import com.mychat.ui.components.MessageBubble
import com.mychat.ui.components.StatusBar
import java.io.ByteArrayOutputStream

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

    val context = LocalContext.current

    val imagePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            val base64 = compressImageToBase64(context, it)
            if (base64 != null) {
                viewModel.sendImageMessage(base64, "")
            }
        }
    }

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
                Column(modifier = Modifier.navigationBarsPadding()) {
                    // 权限请求内联条
                    permissionRequest?.let { req ->
                        PermissionBar(
                            action = req.action,
                            details = req.details,
                            onApprove = { viewModel.sendPermissionResponse(true) },
                            onDeny = { viewModel.sendPermissionResponse(false) }
                        )
                    }
                    // 选择请求内联条
                    choiceRequest?.let { req ->
                        ChoiceBar(
                            options = req.options,
                            onSelect = { viewModel.sendChoiceResponse(it) }
                        )
                    }
                    ChatInputBar(
                        isResponding = isResponding,
                        onSend = { viewModel.sendMessage(it) },
                        onStop = { viewModel.sendInterrupt() },
                        onImagePick = { imagePickerLauncher.launch("image/*") }
                    )
                }
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

@Composable
private fun PermissionBar(
    action: String,
    details: String,
    onApprove: () -> Unit,
    onDeny: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag("permission_dialog")
    ) {
        Text(
            text = if (details.isNotEmpty()) "$action: $details" else action,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 4.dp, bottom = 4.dp)
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(
                onClick = onApprove,
                modifier = Modifier.testTag("permission_approve"),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
            ) {
                Text("允许", color = MaterialTheme.colorScheme.primary)
            }
            TextButton(
                onClick = onDeny,
                modifier = Modifier.testTag("permission_deny"),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
            ) {
                Text("拒绝", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun ChoiceBar(
    options: List<String>,
    onSelect: (Int) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag("choice_dialog")
    ) {
        options.forEachIndexed { index, option ->
            TextButton(
                onClick = { onSelect(index) },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("choice_option_$index"),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
            ) {
                Text(
                    text = option,
                    color = MaterialTheme.colorScheme.primary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

private fun compressImageToBase64(context: android.content.Context, uri: Uri): String? {
    return try {
        val inputStream = context.contentResolver.openInputStream(uri) ?: return null
        val bitmap = BitmapFactory.decodeStream(inputStream)
        inputStream.close()
        if (bitmap == null) return null

        val maxDim = 1024
        var w = bitmap.width
        var h = bitmap.height
        if (w > maxDim || h > maxDim) {
            val scale = maxDim.toFloat() / maxOf(w, h)
            w = (w * scale).toInt()
            h = (h * scale).toInt()
        }
        val scaled = if (w != bitmap.width || h != bitmap.height) {
            Bitmap.createScaledBitmap(bitmap, w, h, true)
        } else {
            bitmap
        }

        val baos = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 70, baos)
        val bytes = baos.toByteArray()
        Base64.encodeToString(bytes, Base64.NO_WRAP)
    } catch (e: Exception) {
        null
    }
}