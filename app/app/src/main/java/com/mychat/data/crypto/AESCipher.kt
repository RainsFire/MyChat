package com.mychat.data.crypto

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.util.Base64

class AESCipher {
    private var key: ByteArray? = null

    companion object {
        private const val ALGORITHM = "AES"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_LENGTH = 16 // GCM auth tag
        private const val IV_LENGTH = 12   // GCM 推荐 IV
        private const val KEY_LENGTH = 32  // AES-256
    }

    fun setSharedKey(sharedKey: ByteArray?) {
        if (sharedKey == null || sharedKey.size != KEY_LENGTH) {
            throw IllegalArgumentException("密钥长度必须为 32 bytes")
        }
        key = sharedKey
    }

    /**
     * 加密 JSON 字符串
     * @return Base64 编码 (IV + ciphertext + authTag)
     */
    fun encrypt(jsonStr: String): String {
        if (key == null) throw IllegalStateException("密钥未设置")

        val iv = ByteArray(IV_LENGTH).also {
            java.security.SecureRandom().nextBytes(it)
        }

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, ALGORITHM), GCMParameterSpec(TAG_LENGTH * 8, iv))

        val ciphertext = cipher.doFinal(jsonStr.toByteArray(Charsets.UTF_8))

        // 组合: IV (12) + ciphertext (含 authTag)
        return Base64.getEncoder().encodeToString(iv + ciphertext)
    }

    /**
     * 解密 Base64 数据
     * @return JSON 字符串
     */
    fun decrypt(encrypted: String): String {
        if (key == null) throw IllegalStateException("密钥未设置")

        val combined = Base64.getDecoder().decode(encrypted)

        val iv = combined.copyOfRange(0, IV_LENGTH)
        val ciphertextWithTag = combined.copyOfRange(IV_LENGTH, combined.size)

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, ALGORITHM), GCMParameterSpec(TAG_LENGTH * 8, iv))

        val plaintext = cipher.doFinal(ciphertextWithTag)
        return String(plaintext, Charsets.UTF_8)
    }

    fun reset() {
        key = null
    }
}