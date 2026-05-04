package com.mychat

import com.mychat.data.api.RelayClient
import dagger.Module
import dagger.Provides
import dagger.hilt.components.SingletonComponent
import dagger.hilt.testing.TestInstallIn
import javax.inject.Singleton

/**
 * 测试用 Hilt Module，仅替换 RelayClient
 */
@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [com.mychat.di.RelayClientModule::class])
object TestRelayModule {

    @Provides
    @Singleton
    fun provideMockRelayClient(): MockRelayClient = MockRelayClient()

    @Provides
    @Singleton
    fun provideRelayClient(mock: MockRelayClient): RelayClient = mock
}