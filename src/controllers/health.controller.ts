import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller()
export class HealthController {
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe.' })
  healthz() {
    return { ok: true, service: 'macp-playground' };
  }
}
