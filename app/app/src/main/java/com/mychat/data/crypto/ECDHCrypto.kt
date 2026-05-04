package com.mychat.data.crypto

import java.math.BigInteger
import java.security.*
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.KeyAgreement
import java.util.Base64

class ECDHCrypto {
    private var keyPair: KeyPair? = null
    private var sharedKey: ByteArray? = null

    companion object {
        private const val ALGORITHM = "EC"
        private const val CURVE = "secp256r1"

        // P-256 曲线参数
        private val P = BigInteger("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF", 16)
        private val A = BigInteger("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFC", 16)
        private val B = BigInteger("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B", 16)
    }

    fun initAsInitiator(): String {
        val kpg = KeyPairGenerator.getInstance(ALGORITHM)
        kpg.initialize(ECGenParameterSpec(CURVE))
        keyPair = kpg.generateKeyPair()
        val compressed = compressPublicKey(keyPair!!.public.encoded)
        return Base64.getEncoder().encodeToString(compressed)
    }

    fun initAsResponder(initiatorPubKey: String): String {
        val kpg = KeyPairGenerator.getInstance(ALGORITHM)
        kpg.initialize(ECGenParameterSpec(CURVE))
        keyPair = kpg.generateKeyPair()

        val theirPubKeyBytes = Base64.getDecoder().decode(initiatorPubKey)
        val theirPubKey = decompressPublicKey(theirPubKeyBytes)
        computeSharedKey(theirPubKey)

        val compressed = compressPublicKey(keyPair!!.public.encoded)
        return Base64.getEncoder().encodeToString(compressed)
    }

    fun completeHandshake(responderPubKey: String) {
        val theirPubKeyBytes = Base64.getDecoder().decode(responderPubKey)
        val theirPubKey = decompressPublicKey(theirPubKeyBytes)
        computeSharedKey(theirPubKey)
    }

    private fun computeSharedKey(otherPubKey: PublicKey) {
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(keyPair!!.private)
        ka.doPhase(otherPubKey, true)
        val rawShared = ka.generateSecret()
        sharedKey = MessageDigest.getInstance("SHA-256").digest(rawShared)
    }

    fun sharedKey(): ByteArray? = sharedKey

    fun reset() {
        keyPair = null
        sharedKey = null
    }

    private fun compressPublicKey(encoded: ByteArray): ByteArray {
        // X.509 格式: 找到 0x04 (uncompressed marker) 后的 64 bytes
        var offset = -1
        for (i in encoded.indices) {
            if (encoded[i] == 0x04.toByte()) {
                offset = i + 1
                break
            }
        }
        if (offset < 0) throw IllegalArgumentException("Invalid public key format")

        val x = encoded.copyOfRange(offset, offset + 32)
        val y = encoded.copyOfRange(offset + 32, offset + 64)

        val prefix = if (y[31].toInt() and 1 == 0) 0x02 else 0x03
        return byteArrayOf(prefix.toByte()) + x
    }

    private fun decompressPublicKey(compressed: ByteArray): PublicKey {
        val prefix = compressed[0]
        val xBytes = compressed.copyOfRange(1, compressed.size)

        val yBytes = calculateY(xBytes, prefix)

        // 构造未压缩格式: 0x04 + x + y
        val uncompressed = ByteArray(1 + 32 + 32)
        uncompressed[0] = 0x04
        System.arraycopy(xBytes, 0, uncompressed, 1, 32)
        System.arraycopy(yBytes, 0, uncompressed, 33, 32)

        // X.509 头部
        val x509Header = byteArrayOf(
            0x30.toByte(), 0x59.toByte(),
            0x30.toByte(), 0x13.toByte(),
            0x06.toByte(), 0x07.toByte(), 0x2A.toByte(), 0x86.toByte(), 0x48.toByte(), 0xCE.toByte(), 0x3D.toByte(), 0x02.toByte(), 0x01.toByte(),
            0x06.toByte(), 0x08.toByte(), 0x2A.toByte(), 0x86.toByte(), 0x48.toByte(), 0xCE.toByte(), 0x3D.toByte(), 0x03.toByte(), 0x01.toByte(), 0x07.toByte(),
            0x03.toByte(), 0x42.toByte(), 0x00.toByte()
        )
        val fullEncoded = x509Header + uncompressed

        val keyFactory = KeyFactory.getInstance(ALGORITHM)
        return keyFactory.generatePublic(X509EncodedKeySpec(fullEncoded))
    }

    private fun calculateY(xBytes: ByteArray, prefix: Byte): ByteArray {
        val x = BigInteger(1, xBytes)

        // y² = x³ + ax + b (mod p)
        val rhs = x.modPow(BigInteger.valueOf(3), P)
            .add(A.multiply(x).mod(P))
            .add(B)
            .mod(P)

        // sqrt: y = rhs^((p+1)/4) mod p (P-256 特性)
        val y = rhs.modPow(P.add(BigInteger.ONE).divide(BigInteger.valueOf(4)), P)

        // 选择正确的 Y 值
        val needOdd = prefix == 0x03.toByte()
        val yIsOdd = y.testBit(0)

        val finalY = if (needOdd != yIsOdd) P.subtract(y) else y

        return bigIntegerTo32Bytes(finalY)
    }

    private fun bigIntegerTo32Bytes(value: BigInteger): ByteArray {
        val bytes = value.toByteArray()
        return when {
            bytes.size == 32 -> bytes
            bytes.size > 32 -> bytes.copyOfRange(bytes.size - 32, bytes.size)
            else -> {
                val result = ByteArray(32)
                System.arraycopy(bytes, 0, result, 32 - bytes.size, bytes.size)
                result
            }
        }
    }
}