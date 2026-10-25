import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../middleware/public.decorator';

@ApiTags('health')
@Controller()
export class HealthController {
  // Public so the image's Docker HEALTHCHECK (which sends no key) still passes when AUTH_API_KEYS is set.
  @Public()
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe. Never requires an API key.' })
  healthz() {
    return { ok: true, service: 'macp-playground' };
  }
}
