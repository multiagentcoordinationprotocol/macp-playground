import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LlmBudgetService, LlmUsageReport } from '../llm-budget/llm-budget.service';

@ApiTags('llm-usage')
@Controller('llm-usage')
export class LlmUsageController {
  constructor(private readonly budget: LlmBudgetService) {}

  /** Requires the API key like every route but /healthz. Global counts only, never per-IP data. */
  @Get()
  @ApiOperation({ summary: 'LLM launch limits and global usage for the current UTC day and month.' })
  usage(): Promise<LlmUsageReport> {
    return this.budget.usage();
  }
}
