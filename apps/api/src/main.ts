import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfigService);

  app.use(helmet());
  // Parses the HttpOnly refresh cookie used by /api/auth/refresh and logout.
  app.use(cookieParser());
  app.enableCors({
    origin: config.webOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // Let Nest run onModuleDestroy / OnApplicationShutdown hooks (Prisma disconnect).
  app.enableShutdownHooks();

  await app.listen(config.apiPort);
}

void bootstrap();
