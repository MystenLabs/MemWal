import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SuiService } from './sui/sui.service';
import { WalrusService } from './walrus/walrus.service';
import { CachedWalrusService } from './walrus/cached-walrus.service';
import { SealService } from './seal/seal.service';
import { SessionKeyService } from './seal/session-key.service';
import { SealController } from './seal/seal.controller';
import { SessionController } from './seal/session.controller';
import { TimelockController } from './seal/timelock.controller';
import { AllowlistController } from './seal/allowlist.controller';
import { RoleController } from './seal/role.controller';
import { AnalyticsController } from './seal/analytics.controller';
import { GeminiService } from './gemini/gemini.service';
import { LocalStorageService } from './local-storage/local-storage.service';
import { StorageService } from './storage/storage.service';
import { DemoStorageService } from './demo-storage/demo-storage.service';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [
    SealController,
    SessionController,
    TimelockController,
    AllowlistController,
    RoleController,
    AnalyticsController
  ],
  providers: [
    SuiService,
    WalrusService,
    CachedWalrusService,
    SealService,
    SessionKeyService,
    GeminiService,
    LocalStorageService,
    StorageService,
    DemoStorageService,
  ],
  exports: [
    SuiService,
    WalrusService,
    CachedWalrusService,
    SealService,
    SessionKeyService,
    GeminiService,
    LocalStorageService,
    StorageService,
    DemoStorageService,
  ]
})
export class InfrastructureModule {}