import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CalendarEventsController } from './calendar-events.controller';
import { CalendarEventsService } from './calendar-events.service';

@Module({
  imports: [AuthModule],
  controllers: [CalendarEventsController],
  providers: [CalendarEventsService],
  exports: [CalendarEventsService],
})
export class CalendarModule {}
