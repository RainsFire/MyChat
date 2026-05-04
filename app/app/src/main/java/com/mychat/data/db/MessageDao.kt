package com.mychat.data.db

import androidx.room.*

@Dao
interface MessageDao {

    @Insert
    suspend fun insert(message: MessageEntity): Long

    @Update
    suspend fun update(message: MessageEntity)

    @Query("SELECT * FROM messages ORDER BY id ASC LIMIT :limit")
    suspend fun getRecent(limit: Int = 100): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE status = 'pending' ORDER BY id ASC")
    suspend fun getPendingMessages(): List<MessageEntity>

    @Query("UPDATE messages SET status = :status WHERE id = :id")
    suspend fun updateStatus(id: Long, status: String)

    @Query("DELETE FROM messages")
    suspend fun deleteAll()

    @Query("SELECT COUNT(*) FROM messages")
    suspend fun count(): Int
}