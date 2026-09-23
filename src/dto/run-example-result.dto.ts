import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CompileLaunchResultDto } from './compile-launch-result.dto';

class ControlPlaneRunDto {
  @ApiProperty()
  runId!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiPropertyOptional()
  traceId?: string;

  @ApiProperty({ example: 'queued' })
  status!: string;
}

class HostedAgentDto {
  @ApiProperty()
  participantId!: string;

  @ApiProperty()
  agentRef!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  role!: string;

  @ApiProperty({ example: 'langgraph' })
  framework!: string;

  @ApiProperty()
  transportIdentity!: string;

  @ApiProperty()
  entrypoint!: string;

  @ApiProperty()
  bootstrapStrategy!: string;

  @ApiProperty()
  bootstrapMode!: string;

  @ApiProperty({ example: 'bootstrapped' })
  status!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  participantMetadata?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String] })
  notes?: string[];
}

export class RunExampleResultDto {
  @ApiProperty({ type: CompileLaunchResultDto })
  compiled!: CompileLaunchResultDto;

  @ApiProperty({ type: [HostedAgentDto] })
  hostedAgents!: HostedAgentDto[];

  @ApiPropertyOptional()
  sessionId?: string;

  @ApiPropertyOptional({
    type: ControlPlaneRunDto,
    description:
      'Present only when MACP_CONTROL_PLANE_URL is configured and the CP-1 POST /runs submission succeeded. ' +
      'Absent when unconfigured or on any submission failure — CP-1 registration is best-effort and never blocks bootstrap.'
  })
  controlPlaneRun?: ControlPlaneRunDto;
}
