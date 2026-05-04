package com.mychat.di

import android.content.Context
import com.mychat.data.api.RelayClient
import com.mychat.data.db.AppDatabase
import com.mychat.data.repository.ChatRepository
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): AppDatabase {
        return AppDatabase.getInstance(context)
    }

    @Provides
    @Singleton
    fun provideChatRepository(
        database: AppDatabase,
        relayClient: RelayClient
    ): ChatRepository {
        return ChatRepository(database.messageDao(), relayClient)
    }
}

@Module
@InstallIn(SingletonComponent::class)
object RelayClientModule {

    @Provides
    @Singleton
    fun provideRelayClient(): RelayClient {
        return RelayClient()
    }
}