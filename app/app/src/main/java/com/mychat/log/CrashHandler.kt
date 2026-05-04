package com.mychat.log

import android.content.Context
import com.mychat.MyChatApp

object CrashHandler : Thread.UncaughtExceptionHandler {
    private lateinit var app: MyChatApp
    private var defaultHandler: Thread.UncaughtExceptionHandler? = null

    fun install(app: MyChatApp) {
        this.app = app
        defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler(this)
    }

    override fun uncaughtException(thread: Thread, throwable: Throwable) {
        AppLogger.e("CRASH", "Unhandled exception", throwable)
        defaultHandler?.uncaughtException(thread, throwable)
    }
}