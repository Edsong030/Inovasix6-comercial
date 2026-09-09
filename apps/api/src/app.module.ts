import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './config/app-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { ModulesModule } from './modules/modules.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'password',
          'passwordHash',
          'accessToken',
          'refreshToken',
          'refreshTokenHash',
          'JWT_ACCESS_SECRET',
          'JWT_REFRESH_SECRET',
          'DATABASE_URL',
          'REDIS_URL',
        ],
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    HealthModule,
    ModulesModule,
  ],
})
export class AppModule {}
