import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { envValidationOptions, envValidationSchema } from './env.validation';

/**
 * Global configuration module. Validates the environment at boot via Joi and
 * exposes AppConfigService everywhere. Importing this is what makes the app
 * fail fast on a missing/invalid required variable.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
      validationSchema: envValidationSchema,
      validationOptions: envValidationOptions,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
