package com.mychat

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mychat.notification.NotificationHelper
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NotificationHelperTest {

    private lateinit var context: Context

    @Before
    fun setup() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        NotificationHelper.createChannel(context)
    }

    // ========== 通知渠道配置 ==========

    @Test
    fun chatReplyChannel_importanceHigh() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = manager.getNotificationChannel("chat_reply")
        assertNotNull("chat_reply 渠道应存在", channel)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel?.importance)
        assertTrue("应启用振动", channel?.shouldVibrate() == true)
        assertEquals(Notification.VISIBILITY_PUBLIC, channel?.lockscreenVisibility)
    }

    @Test
    fun foregroundChannel_importanceMin() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = manager.getNotificationChannel("chat_foreground")
        assertNotNull("chat_foreground 渠道应存在", channel)
        assertEquals(NotificationManager.IMPORTANCE_MIN, channel?.importance)
        assertFalse("不应显示 badge", channel?.canShowBadge() == true)
        assertFalse("不应振动", channel?.shouldVibrate() == true)
        assertEquals(Notification.VISIBILITY_PUBLIC, channel?.lockscreenVisibility)
    }

    // ========== 前台服务通知构建 ==========

    @Test
    fun foregroundNotification_correctProperties() {
        val notification = NotificationHelper.buildForegroundNotification(context)

        assertTrue("应为常驻通知", notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertNotNull("应有 contentIntent", notification.contentIntent)
    }

    @Test
    fun foregroundNotification_correctId() {
        assertEquals(1000, NotificationHelper.FOREGROUND_NOTIFICATION_ID)
    }
}
