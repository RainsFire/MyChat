package com.mychat.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.mychat.data.api.ConnectionState

@Composable
fun StatusBar(
    connectionState: ConnectionState,
    desktopOnline: Boolean,
    currentMode: String,
    onModeChange: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var showModeMenu by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .testTag("status_bar"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .background(
                            when (connectionState) {
                                is ConnectionState.Connected -> Color(0xFF4CAF50)
                                is ConnectionState.Error -> Color(0xFFE53935)
                                else -> Color(0xFFFFC107)
                            },
                            CircleShape
                        )
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = when (connectionState) {
                        is ConnectionState.Disconnected -> "未连接"
                        is ConnectionState.Connecting -> "连接中..."
                        is ConnectionState.Authenticating -> "认证中..."
                        is ConnectionState.Handshaking -> "握手中..."
                        is ConnectionState.Connected -> if (desktopOnline) "已连接 · Claude 在线" else "已连接 · Claude 离线"
                        is ConnectionState.Error -> "错误: ${connectionState.message}"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                )
            }

            Box {
                TextButton(
                    onClick = { showModeMenu = true },
                    modifier = Modifier.testTag("mode_selector"),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)
                ) {
                    Text(
                        text = when (currentMode) {
                            "auto" -> "Auto"
                            "plan" -> "Plan"
                            else -> "Default"
                        },
                        style = MaterialTheme.typography.labelSmall
                    )
                }
                DropdownMenu(
                    expanded = showModeMenu,
                    onDismissRequest = { showModeMenu = false }
                ) {
                    listOf("auto" to "Auto", "default" to "Default", "plan" to "Plan").forEach { (mode, label) ->
                        DropdownMenuItem(
                            text = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(label, style = MaterialTheme.typography.bodyMedium)
                                    if (mode == currentMode) {
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(14.dp))
                                    }
                                }
                            },
                            onClick = {
                                onModeChange(mode)
                                showModeMenu = false
                            }
                        )
                    }
                }
            }
        }
}
