import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AgentProfileService } from '../catalog/agent-profile.service';
import { AgentProfileDto } from '../dto/agent-profile.dto';

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly agentProfileService: AgentProfileService) {}

  @Get()
  @ApiOperation({ summary: 'List all agent profiles with scenario coverage.' })
  async listAgents(): Promise<AgentProfileDto[]> {
    return this.agentProfileService.listProfiles();
  }

  @Get(':agentRef')
  @ApiOperation({ summary: 'Get a single agent profile by agentRef.' })
  @ApiParam({ name: 'agentRef', example: 'fraud-agent' })
  async getAgent(@Param('agentRef') agentRef: string): Promise<AgentProfileDto> {
    return this.agentProfileService.getProfile(agentRef);
  }
}
