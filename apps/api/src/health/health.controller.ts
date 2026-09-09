import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  status(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
