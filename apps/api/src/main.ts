import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

  // OpenAPI / Swagger — served at /api/docs. Bearer auth so protected routes can
  // be exercised from the UI. Does not alter any runtime behaviour.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Inovasix6 Comercial IA — API')
    .setDescription('Endpoints do backend multi-tenant (auth, dashboard, leads, pipelines).')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // Let Nest run onModuleDestroy / OnApplicationShutdown hooks (Prisma disconnect).
  app.enableShutdownHooks();

  await app.listen(config.apiPort);
}

void bootstrap();
