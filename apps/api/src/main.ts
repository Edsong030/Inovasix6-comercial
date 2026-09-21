import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { createGlobalValidationPipe } from './common/http/global-validation.pipe';
import { AppConfigService } from './config/app-config.service';
import { configureWhatsAppWebhookBodyParser } from './modules/whatsapp/webhook/whatsapp-webhook.http';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfigService);

  app.use(helmet());
  // Parses the HttpOnly refresh cookie used by /api/auth/refresh and logout.
  app.use(cookieParser());
  // Raw body for the WhatsApp webhook route only (Meta's signature is over the exact bytes). Must come
  // before init so it runs ahead of Nest's JSON parser; every other route keeps the default parser.
  configureWhatsAppWebhookBodyParser(app, config.whatsappCloud.enabled);
  app.enableCors({
    origin: config.webOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());

  // OpenAPI / Swagger — served at /api/docs. Bearer auth so protected routes can
  // be exercised from the UI. Does not alter any runtime behaviour.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Inovasix6 Comercial IA — API')
    .setDescription('Endpoints do backend multi-tenant (auth, dashboard, leads, pipelines).')
    .setVersion('1.0')
    .addBearerAuth()
    // Machine-to-machine credential of POST /api/conversations/inbound (keyId:secret).
    .addBasicAuth(
      { type: 'http', scheme: 'basic', description: 'Credencial de serviço: <KEY_ID>:<SERVICE_SECRET>' },
      'inbound-service',
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // Let Nest run onModuleDestroy / OnApplicationShutdown hooks (Prisma disconnect).
  app.enableShutdownHooks();

  await app.listen(config.apiPort);
}

void bootstrap();
