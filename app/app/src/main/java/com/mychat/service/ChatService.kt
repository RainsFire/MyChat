package com.mychat.service

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.os.IBinder
import com.mychat.notification.NotificationHelper

class ChatService : Service() {

    override fun onCreate() {
        super.onCreate()
        val notification = NotificationHelper.buildForegroundNotification(this)
        startForeground(NotificationHelper.FOREGROUND_NOTIFICATION_ID, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_STOP = "com.mychat.action.STOP"
    }
}
