package com.mychat

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.mychat.data.db.AppDatabase
import com.mychat.data.db.MessageDao
import com.mychat.data.db.MessageEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.*

/**
 * UT-06: 插入消息
 * UT-07: 查询待发送
 * UT-08: 更新状态
 * UT-09: 事务完整性
 */
@RunWith(AndroidJUnit4::class)
class MessageDaoTest {

    private lateinit var database: AppDatabase
    private lateinit var dao: MessageDao

    @Before
    fun setup() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = database.messageDao()
    }

    @After
    fun teardown() {
        database.close()
    }

    // ========== UT-06: 插入消息 ==========

    @Test
    fun ut06_insertMessage_returnsId() = runTest {
        val id = dao.insert(
            MessageEntity(
                role = "user",
                content = "Hello",
                status = "pending",
                createdAt = System.currentTimeMillis()
            )
        )
        assertTrue("插入应返回正数 ID", id > 0)
    }

    @Test
    fun ut06_insertMultipleMessages_increasingIds() = runTest {
        val id1 = dao.insert(testMessage("msg1"))
        val id2 = dao.insert(testMessage("msg2"))
        val id3 = dao.insert(testMessage("msg3"))

        assertTrue(id1 < id2)
        assertTrue(id2 < id3)
    }

    // ========== UT-07: 查询待发送 ==========

    @Test
    fun ut07_getPendingMessages_returnsOnlyPending() = runTest {
        dao.insert(testMessage(status = "pending"))
        dao.insert(testMessage(status = "sent"))
        dao.insert(testMessage(status = "pending"))

        val pending = dao.getPendingMessages()
        assertEquals(2, pending.size)
        assertTrue(pending.all { it.status == "pending" })
    }

    @Test
    fun ut07_getPendingMessages_orderedByTime() = runTest {
        dao.insert(testMessage(content = "first", status = "pending", time = 100))
        dao.insert(testMessage(content = "second", status = "pending", time = 200))

        val pending = dao.getPendingMessages()
        assertEquals("first", pending[0].content)
        assertEquals("second", pending[1].content)
    }

    @Test
    fun ut07_noPendingMessages_returnsEmpty() = runTest {
        dao.insert(testMessage(status = "sent"))
        dao.insert(testMessage(status = "delivered"))

        val pending = dao.getPendingMessages()
        assertTrue(pending.isEmpty())
    }

    // ========== UT-08: 更新状态 ==========

    @Test
    fun ut08_updateStatus_fromPendingToSent() = runTest {
        val id = dao.insert(testMessage(status = "pending"))
        dao.updateStatus(id, "sent")

        val messages = dao.getRecent(10)
        assertEquals("sent", messages.find { it.id == id }?.status)
    }

    @Test
    fun ut08_updateStatus_multipleTransitions() = runTest {
        val id = dao.insert(testMessage(status = "pending"))

        dao.updateStatus(id, "sent")
        assertEquals("sent", dao.getRecent(1).first().status)

        dao.updateStatus(id, "delivered")
        assertEquals("delivered", dao.getRecent(1).first().status)
    }

    @Test
    fun ut08_updateStatus_failed() = runTest {
        val id = dao.insert(testMessage(status = "pending"))
        dao.updateStatus(id, "failed")

        assertEquals("failed", dao.getRecent(1).first().status)
    }

    // ========== UT-09: 事务完整性 ==========

    @Test
    fun ut09_deleteAll_clearsEverything() = runTest {
        dao.insert(testMessage())
        dao.insert(testMessage())
        dao.insert(testMessage())

        assertEquals(3, dao.count())
        dao.deleteAll()
        assertEquals(0, dao.count())
    }

    @Test
    fun ut09_getRecent_returnsInAscOrder() = runTest {
        dao.insert(testMessage(content = "oldest", time = 100))
        dao.insert(testMessage(content = "middle", time = 200))
        dao.insert(testMessage(content = "newest", time = 300))

        val messages = dao.getRecent(10)
        // getRecent 返回 ASC（时间正序）
        assertEquals("oldest", messages[0].content)
        assertEquals("newest", messages[2].content)
    }

    @Test
    fun ut09_getRecent_respectsLimit() = runTest {
        for (i in 1..50) {
            dao.insert(testMessage(content = "msg$i", time = i.toLong()))
        }

        val messages = dao.getRecent(10)
        assertEquals(10, messages.size)
    }

    @Test
    fun ut09_count_returnsCorrectCount() = runTest {
        assertEquals(0, dao.count())
        dao.insert(testMessage())
        assertEquals(1, dao.count())
        dao.insert(testMessage())
        assertEquals(2, dao.count())
        dao.deleteAll()
        assertEquals(0, dao.count())
    }

    // ========== 辅助方法 ==========

    private fun testMessage(
        content: String = "test",
        role: String = "user",
        status: String = "pending",
        time: Long = System.currentTimeMillis()
    ) = MessageEntity(
        role = role,
        content = content,
        status = status,
        createdAt = time
    )
}