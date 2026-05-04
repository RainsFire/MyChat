package com.mychat.data.db

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "messages")
data class MessageEntity(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    val role: String,           // "user" | "assistant"
    val content: String,
    val contentType: String = "text",
    val status: String,         // "pending" | "sent" | "delivered" | "failed"
    val createdAt: Long
)