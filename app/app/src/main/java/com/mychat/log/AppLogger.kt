package com.mychat.log

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.*

object AppLogger {
    private const val MAX_BUFFER = 100
    private const val MAX_LOG_DAYS = 7

    private lateinit var logDir: File
    private val buffer = Collections.synchronizedList(mutableListOf<String>())
    private val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    private val timeFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun init(context: Context) {
        logDir = File(context.filesDir, "logs").also { it.mkdirs() }
        cleanOldLogs()
    }

    fun d(tag: String, msg: String) = write("DEBUG", tag, msg)
    fun i(tag: String, msg: String) = write("INFO", tag, msg)
    fun w(tag: String, msg: String) = write("WARN", tag, msg)
    fun e(tag: String, msg: String) = write("ERROR", tag, msg)

    fun e(tag: String, msg: String, throwable: Throwable) {
        val stackTrace = Log.getStackTraceString(throwable)
        write("ERROR", tag, "$msg\n$stackTrace")
    }

    private fun write(level: String, tag: String, msg: String) {
        val timestamp = timeFormat.format(Date())
        val line = "$timestamp $level/$tag: $msg"

        Log.println(when (level) {
            "DEBUG" -> Log.DEBUG
            "INFO" -> Log.INFO
            "WARN" -> Log.WARN
            "ERROR" -> Log.ERROR
            else -> Log.INFO
        }, tag, msg)

        buffer.add(line)
        if (buffer.size > MAX_BUFFER) buffer.removeAt(0)

        writeToFile(line)
    }

    private fun writeToFile(line: String) {
        try {
            val file = File(logDir, "${dateFormat.format(Date())}.log")
            FileWriter(file, true).use { it.appendLine(line) }
        } catch (_: Exception) { }
    }

    fun getBuffer(): List<String> = buffer.toList()

    fun getCrashLogs(): List<File> {
        return logDir.listFiles()?.filter { f ->
            f.name.endsWith(".log") && f.readLines().any { it.contains("CRASH") }
        } ?: emptyList()
    }

    private fun cleanOldLogs() {
        val cutoff = System.currentTimeMillis() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000L
        logDir.listFiles()?.forEach { f ->
            if (f.lastModified() < cutoff) f.delete()
        }
    }
}