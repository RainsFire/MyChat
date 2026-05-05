package com.mychat.notification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.mychat.MainActivity
import com.mychat.R

object NotificationHelper {
    private const val CHANNEL_ID = "chat_reply"
    private const val CHANNEL_NAME = "Chat Replies"
    private const val NOTIFICATION_ID_REPLY = 1001
    private const val NOTIFICATION_ID_PERMISSION = 1002
    private const val NOTIFICATION_ID_CHOICE = 1003

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Claude reply notifications"
                enableVibration(true)
            }
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    fun showReplyNotification(context: Context, preview: String) {
        if (!canPostNotifications(context)) return
        val pendingIntent = createPendingIntent(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Claude 回复完成")
            .setContentText(preview.take(100))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID_REPLY, notification)
    }

    fun showPermissionNotification(context: Context, action: String, details: String) {
        if (!canPostNotifications(context)) return
        val pendingIntent = createPendingIntent(context)
        val text = if (details.isNotEmpty()) "$action: $details" else action
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Claude 需要权限确认")
            .setContentText(text.take(100))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID_PERMISSION, notification)
    }

    fun showChoiceNotification(context: Context, options: List<String>) {
        if (!canPostNotifications(context)) return
        val pendingIntent = createPendingIntent(context)
        val text = options.joinToString(" / ")
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Claude 需要你的选择")
            .setContentText(text.take(100))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID_CHOICE, notification)
    }

    fun cancelPermissionNotification(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID_PERMISSION)
    }

    fun cancelChoiceNotification(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID_CHOICE)
    }

    fun cancelAll(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID_REPLY)
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID_PERMISSION)
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID_CHOICE)
    }

    private fun canPostNotifications(context: Context): Boolean {
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    private fun createPendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE
        )
    }
}
