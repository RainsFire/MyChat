package com.mychat

import android.app.Application
import com.mychat.di.AppModule
import com.mychat.log.AppLogger
import com.mychat.log.CrashHandler
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class MyChatApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AppLogger.init(this)
        CrashHandler.install(this)
        AppLogger.i("MyChatApp", "Application started")
    }
}