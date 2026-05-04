package com.mychat.ui

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.mychat.data.api.ConnectionState
import com.mychat.data.api.RelayEvent
import com.mychat.data.repository.ChatRepository
import com.mychat.data.store.CredentialStore
import com.mychat.log.AppLogger
import com.mychat.notification.NotificationHelper
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import javax.inject.Inject

@HiltViewModel
class ChatViewModel @Inject constructor(
    application: Application,
    private val repository: ChatRepository
) : AndroidViewModel(application) {

    val messages = repository.messages
    val connectionState = repository.connectionState
    val desktopOnline = repository.desktopOnline

    private val _currentMode = MutableStateFlow("default")
    val currentMode: StateFlow<String> = _currentMode

    private val _isResponding = MutableStateFlow(false)
    val isResponding: StateFlow<Boolean> = _isResponding

    private val _permissionRequest = MutableStateFlow<RelayEvent.PermissionRequest?>(null)
    val permissionRequest: StateFlow<RelayEvent.PermissionRequest?> = _permissionRequest

    private val _choiceRequest = MutableStateFlow<RelayEvent.ChoiceRequest?>(null)
    val choiceRequest: StateFlow<RelayEvent.ChoiceRequest?> = _choiceRequest

    private val replyBuffer = StringBuilder()
    private var heartbeatJob: Job? = null

    init {
        NotificationHelper.createChannel(application)
        loadMessages()
        listenEvents()
        startHeartbeat()
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = viewModelScope.launch {
            connectionState.collect { state ->
                if (state is ConnectionState.Connected) {
                    kotlinx.coroutines.delay(25_000)
                    if (connectionState.value is ConnectionState.Connected) {
                        repository.sendPing()
                    }
                }
            }
        }
    }

    fun connect(url: String, username: String, password: String) {
        repository.connect(url, username, password)
    }

    fun disconnect() {
        repository.disconnect()
    }

    fun sendMessage(content: String) {
        viewModelScope.launch {
            repository.sendMessage(content)
        }
    }

    fun sendPermissionResponse(approved: Boolean) {
        repository.sendPermissionResponse(approved)
        _permissionRequest.value = null
    }

    fun sendChoiceResponse(selected: Int) {
        repository.sendChoiceResponse(selected)
        _choiceRequest.value = null
    }

    fun sendInterrupt() {
        repository.sendInterrupt()
    }

    fun setMode(mode: String) {
        _currentMode.value = mode
        repository.setMode(mode)
    }

    fun logout() {
        CredentialStore.clearCredentials(getApplication<Application>())
        disconnect()
    }

    fun clearHistory() {
        viewModelScope.launch {
            repository.clearHistory()
        }
    }

    private fun loadMessages() {
        viewModelScope.launch {
            repository.loadMessages()
        }
    }

    private fun listenEvents() {
        viewModelScope.launch {
            repository.relayEvents.collect { event ->
                handleEvent(event)
            }
        }
    }

    private fun handleEvent(event: RelayEvent) {
        when (event) {
            is RelayEvent.ChatReply -> {
                _isResponding.value = true
                replyBuffer.append(event.content)
            }
            is RelayEvent.ChatComplete -> {
                _isResponding.value = false
                val content = replyBuffer.toString()
                if (content.isNotEmpty()) {
                    replyBuffer.clear()
                    viewModelScope.launch {
                        repository.saveAssistantMessage(content)
                    }
                    // App 在后台时弹通知
                    if (!isAppInForeground()) {
                        NotificationHelper.showReplyNotification(getApplication(), content)
                    }
                }
            }
            is RelayEvent.PermissionRequest -> {
                _permissionRequest.value = event
            }
            is RelayEvent.ChoiceRequest -> {
                _choiceRequest.value = event
            }
            is RelayEvent.ModeChanged -> {
                _currentMode.value = event.mode
            }
            is RelayEvent.CrashLogReceived -> {
                AppLogger.i("ChatViewModel", "崩溃日志已接收")
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun isAppInForeground(): Boolean {
        val app = getApplication<Application>()
        val am = app.getSystemService(android.content.Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
        val processes = am?.runningAppProcesses ?: return false
        return processes.any {
            it.processName == app.packageName && it.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
        }
    }
}