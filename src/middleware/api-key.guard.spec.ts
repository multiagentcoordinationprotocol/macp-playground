import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard';
import { Public } from './public.decorator';
import { AppConfigService } from '../config/app-config.service';

class OpenController {
  @Public()
  open(): void {}

  closed(): void {}
}

function createMockContext(
  headers: Record<string, string> = {},
  handler: (...args: unknown[]) => unknown = OpenController.prototype.closed
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => OpenController,
    switchToHttp: () => ({
      getRequest: () => ({ headers })
    })
  } as unknown as ExecutionContext;
}

const reflector = new Reflector();

describe('ApiKeyGuard', () => {
  it('should allow all requests when no API keys are configured', () => {
    const config = { authApiKeys: [] } as unknown as AppConfigService;
    const guard = new ApiKeyGuard(config, reflector);

    expect(guard.canActivate(createMockContext())).toBe(true);
  });

  it('should allow requests with a valid API key', () => {
    const config = { authApiKeys: ['key-1', 'key-2'] } as unknown as AppConfigService;
    const guard = new ApiKeyGuard(config, reflector);

    expect(guard.canActivate(createMockContext({ 'x-api-key': 'key-1' }))).toBe(true);
  });

  it('should reject requests with an invalid API key', () => {
    const config = { authApiKeys: ['key-1'] } as unknown as AppConfigService;
    const guard = new ApiKeyGuard(config, reflector);

    expect(() => guard.canActivate(createMockContext({ 'x-api-key': 'wrong' }))).toThrow(UnauthorizedException);
  });

  it('should reject requests with no API key header when keys are required', () => {
    const config = { authApiKeys: ['key-1'] } as unknown as AppConfigService;
    const guard = new ApiKeyGuard(config, reflector);

    expect(() => guard.canActivate(createMockContext())).toThrow(UnauthorizedException);
  });

  it('should allow a @Public() route without an API key even when keys are required', () => {
    const config = { authApiKeys: ['key-1'] } as unknown as AppConfigService;
    const guard = new ApiKeyGuard(config, reflector);

    expect(guard.canActivate(createMockContext({}, OpenController.prototype.open))).toBe(true);
  });
});
