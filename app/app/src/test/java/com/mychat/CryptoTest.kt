package com.mychat

import com.mychat.data.crypto.AESCipher
import com.mychat.data.crypto.ECDHCrypto
import org.junit.Test
import org.junit.Assert.*

/**
 * UT-01: ECDH 密钥交换 — 两端计算出相同共享密钥
 * UT-02: AES 加密解密 — 加密后解密得到原文
 * UT-03: AES 加密失败 — 无效密钥返回错误
 */
class CryptoTest {

    // ========== UT-01: ECDH 密钥交换 ==========

    @Test
    fun ut01_keyExchange_bothSidesComputeSameSharedKey() {
        val initiator = ECDHCrypto()
        val responder = ECDHCrypto()

        val initiatorPubKey = initiator.initAsInitiator()
        val responderPubKey = responder.initAsResponder(initiatorPubKey)
        initiator.completeHandshake(responderPubKey)

        val initiatorShared = initiator.sharedKey()
        val responderShared = responder.sharedKey()

        assertArrayEquals(initiatorShared, responderShared)
    }

    @Test
    fun ut01_keyExchange_produces32ByteKey() {
        val alice = ECDHCrypto()
        val bob = ECDHCrypto()

        val alicePub = alice.initAsInitiator()
        val bobPub = bob.initAsResponder(alicePub)
        alice.completeHandshake(bobPub)

        assertEquals(32, alice.sharedKey()!!.size)
    }

    @Test
    fun ut01_keyExchange_differentEachTime() {
        val shared1 = performKeyExchange()
        val shared2 = performKeyExchange()
        assertFalse("每次密钥交换应产生不同的共享密钥", shared1.contentEquals(shared2))
    }

    // ========== UT-02: AES 加密解密 ==========

    @Test
    fun ut02_encryptDecrypt_roundTrip() {
        val cipher = AESCipher()
        val key = performKeyExchange()
        cipher.setSharedKey(key)

        val plaintext = """{"type":"chat_message","content":"Hello Claude 👋"}"""
        val encrypted = cipher.encrypt(plaintext)
        val decrypted = cipher.decrypt(encrypted)

        assertEquals(plaintext, decrypted)
    }

    @Test
    fun ut02_encryptDecrypt_largeText() {
        val cipher = AESCipher()
        cipher.setSharedKey(performKeyExchange())

        val largeText = "A".repeat(10000)
        val encrypted = cipher.encrypt(largeText)
        val decrypted = cipher.decrypt(encrypted)

        assertEquals(largeText, decrypted)
    }

    @Test
    fun ut02_encrypt_producesDifferentCiphertext() {
        val cipher = AESCipher()
        cipher.setSharedKey(performKeyExchange())

        val plaintext = "same message"
        val encrypted1 = cipher.encrypt(plaintext)
        val encrypted2 = cipher.encrypt(plaintext)

        // IV 随机，每次加密结果不同
        assertNotEquals(encrypted1, encrypted2)
    }

    @Test
    fun ut02_encryptDecrypt_jsonPayload() {
        val cipher = AESCipher()
        cipher.setSharedKey(performKeyExchange())

        val payloads = listOf(
            """{"type":"chat_message","content":"test"}""",
            """{"type":"permission_response","response":"approve"}""",
            """{"type":"interrupt"}""",
            """{"type":"set_mode","mode":"auto"}"""
        )

        for (payload in payloads) {
            val encrypted = cipher.encrypt(payload)
            val decrypted = cipher.decrypt(encrypted)
            assertEquals("加解密失败: $payload", payload, decrypted)
        }
    }

    // ========== UT-03: 加密失败处理 ==========

    @Test(expected = Exception::class)
    fun ut03_decryptWithWrongKey_throwsError() {
        val cipher1 = AESCipher()
        val cipher2 = AESCipher()

        cipher1.setSharedKey(performKeyExchange())
        cipher2.setSharedKey(performKeyExchange()) // 不同的密钥

        val encrypted = cipher1.encrypt("secret message")
        cipher2.decrypt(encrypted) // 应该抛出异常
    }

    @Test(expected = Exception::class)
    fun ut03_decryptInvalidBase64_throwsError() {
        val cipher = AESCipher()
        cipher.setSharedKey(performKeyExchange())
        cipher.decrypt("not-valid-base64!!!")
    }

    @Test
    fun ut03_encryptBeforeKeyExchange_throwsError() {
        val cipher = AESCipher()
        try {
            cipher.encrypt("test")
            fail("应该在未设置密钥时抛出异常")
        } catch (e: Exception) {
            // 预期行为
        }
    }

    // ========== 辅助方法 ==========

    private fun performKeyExchange(): ByteArray {
        val alice = ECDHCrypto()
        val bob = ECDHCrypto()
        val alicePub = alice.initAsInitiator()
        val bobPub = bob.initAsResponder(alicePub)
        alice.completeHandshake(bobPub)
        return alice.sharedKey()!!
    }
}