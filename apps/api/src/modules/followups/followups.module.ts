import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowUpsController } from './followups.controller';
import { FollowUpsService } from './followups.service';

@Module({
  imports: [AuthModule],
  controllers: [FollowUpsController],
  providers: [FollowUpsService],
  exports: [FollowUpsService],
})
export class FollowupsModule {}
