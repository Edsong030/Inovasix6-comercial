import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global provider for database access. Exported once so no module instantiates
 * its own PrismaClient.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
