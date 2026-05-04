package com.mychat.data.store

import android.content.Context
import android.content.SharedPreferences

object CredentialStore {
    private const val PREFS_NAME = "mychat_credentials"
    private const val KEY_URL = "relay_url"
    private const val KEY_USERNAME = "username"
    private const val KEY_PASSWORD = "password"
    private const val KEY_AUTO_LOGIN = "auto_login"

    private const val DEFAULT_URL = "ws://121.41.103.157:9090"
    private const val DEFAULT_USERNAME = "admin"

    private fun getPrefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    fun saveCredentials(
        context: Context,
        url: String,
        username: String,
        password: String,
        autoLogin: Boolean = true
    ) {
        getPrefs(context).edit().apply {
            putString(KEY_URL, url)
            putString(KEY_USERNAME, username)
            putString(KEY_PASSWORD, password)
            putBoolean(KEY_AUTO_LOGIN, autoLogin)
            apply()
        }
    }

    fun getUrl(context: Context): String {
        return getPrefs(context).getString(KEY_URL, DEFAULT_URL) ?: DEFAULT_URL
    }

    fun getUsername(context: Context): String {
        return getPrefs(context).getString(KEY_USERNAME, DEFAULT_USERNAME) ?: DEFAULT_USERNAME
    }

    fun getPassword(context: Context): String {
        return getPrefs(context).getString(KEY_PASSWORD, "") ?: ""
    }

    fun isAutoLogin(context: Context): Boolean {
        return getPrefs(context).getBoolean(KEY_AUTO_LOGIN, false)
    }

    fun hasCredentials(context: Context): Boolean {
        val prefs = getPrefs(context)
        return prefs.contains(KEY_URL) &&
               prefs.contains(KEY_USERNAME) &&
               prefs.contains(KEY_PASSWORD) &&
               prefs.getString(KEY_PASSWORD, "")?.isNotEmpty() == true
    }

    fun clearCredentials(context: Context) {
        getPrefs(context).edit().clear().apply()
    }
}