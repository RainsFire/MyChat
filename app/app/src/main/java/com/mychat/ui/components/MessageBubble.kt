package com.mychat.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mychat.data.db.MessageEntity
import dev.jeziellago.compose.markdowntext.MarkdownText

@Composable
fun MessageBubble(
    message: MessageEntity,
    modifier: Modifier = Modifier
) {
    val isUser = message.role == "user"
    val alignment = if (isUser) Arrangement.End else Arrangement.Start

    val bgColor = if (isUser) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.surfaceVariant
    }
    val textColor = if (isUser) {
        MaterialTheme.colorScheme.onPrimary
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    // 选择高亮色：与气泡背景形成强对比
    val selectionColors = if (isUser) {
        // 用户气泡（深蓝 primary 背景）→ 白色半透明高亮
        remember {
            TextSelectionColors(
                handleColor = Color.White,
                backgroundColor = Color(0x80FFFFFF) // 50% 白色
            )
        }
    } else {
        // 助手气泡（浅灰背景）→ 深蓝高亮
        remember {
            TextSelectionColors(
                handleColor = Color(0xFF007AFF),
                backgroundColor = Color(0x40007AFF) // 25% 蓝色
            )
        }
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 3.dp)
            .testTag("message_bubble_${message.id}"),
        horizontalArrangement = alignment
    ) {
        Box(
            modifier = Modifier
                .clip(
                    RoundedCornerShape(
                        topStart = 18.dp,
                        topEnd = 18.dp,
                        bottomStart = if (isUser) 18.dp else 4.dp,
                        bottomEnd = if (isUser) 4.dp else 18.dp
                    )
                )
                .background(bgColor)
                .padding(horizontal = 14.dp, vertical = 10.dp)
                .widthIn(max = 260.dp)
        ) {
            CompositionLocalProvider(LocalTextSelectionColors provides selectionColors) {
                SelectionContainer {
                if (isUser) {
                    Text(
                        text = message.content,
                        color = textColor,
                        style = MaterialTheme.typography.bodyMedium
                    )
                } else {
                    if (message.content.length > 20) {
                        val markdownContent = remember(message.content) { message.content }
                        MarkdownText(
                            markdown = markdownContent,
                            fontSize = 14.sp,
                            color = textColor,
                            style = androidx.compose.ui.text.TextStyle(
                                fontSize = 14.sp,
                                color = textColor,
                                fontFamily = FontFamily.Monospace,
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                    } else {
                        Text(
                            text = message.content,
                            color = textColor,
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
                }
            }
        }
    }
}
