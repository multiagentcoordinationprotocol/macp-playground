import { Body, Controller, Post, Req } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse
} from '@nestjs/swagger';
import { AppConfigService } from '../config/app-config.service';
import { ExampleRunService } from '../launch/example-run.service';
import { ClientIpRequest, resolveClientIp } from '../llm-budget/client-ip';
import { RunExampleRequestDto } from '../dto/run-example-request.dto';
import { RunExampleResultDto } from '../dto/run-example-result.dto';
import { RunExampleResult } from '../contracts/launch';

@ApiTags('examples')
@Controller('examples')
export class ExamplesController {
  constructor(
    private readonly exampleRunService: ExampleRunService,
    private readonly config: AppConfigService
  ) {}

  @Post('run')
  @ApiOperation({
    summary:
      'Compile a showcase scenario, resolve/bootstrap example agents, and optionally submit the run to the control plane.'
  })
  @ApiBody({ type: RunExampleRequestDto })
  @ApiCreatedResponse({ type: RunExampleResultDto })
  @ApiBadRequestResponse({ description: 'Invalid scenario ref, missing example agent, or validation failure.' })
  @ApiBadGatewayResponse({
    description:
      'Auth-service JWT minting failed (AUTH_MINT_FAILED — minting is unconditional; there is no ' +
      'static-token mode to fall back to), or an agent whose ' +
      'bootstrap mode requires a real attach (`mode: "attached"`) failed to spawn or stay up ' +
      '(AGENT_ATTACH_FAILED). Note: a CP-1 POST /runs submission failure never produces this response — it is ' +
      'best-effort and non-fatal, surfaced only by the absence of `controlPlaneRun` on a 201 response.'
  })
  @ApiTooManyRequestsResponse({
    description:
      'An LLM launch limit was hit and LLM_LIMIT_ACTION=reject (LLM_LIMIT_EXCEEDED). With the default ' +
      '`fallback` the launch runs with deterministic agents instead, marked in `compiled.scenarioMeta.agentExecutionFallback`.'
  })
  async run(@Body() body: RunExampleRequestDto, @Req() req: ClientIpRequest): Promise<RunExampleResult> {
    const { ip } = resolveClientIp(req, this.config.authApiKeys ?? [], this.config.trustedProxyHops ?? 0);
    return this.exampleRunService.run(body, ip);
  }
}
