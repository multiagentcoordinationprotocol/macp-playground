import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags
} from '@nestjs/swagger';
import { ExampleRunService } from '../launch/example-run.service';
import { RunExampleRequestDto } from '../dto/run-example-request.dto';
import { RunExampleResultDto } from '../dto/run-example-result.dto';
import { RunExampleResult } from '../contracts/launch';

@ApiTags('examples')
@Controller('examples')
export class ExamplesController {
  constructor(private readonly exampleRunService: ExampleRunService) {}

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
      'Auth-service JWT minting failed (AUTH_MINT_FAILED, MACP_AUTH_MODE=jwt only). ' +
      'Note: a CP-1 POST /runs submission failure never produces this response — it is best-effort ' +
      'and non-fatal, surfaced only by the absence of `controlPlaneRun` on a 201 response.'
  })
  async run(@Body() body: RunExampleRequestDto): Promise<RunExampleResult> {
    return this.exampleRunService.run(body);
  }
}
