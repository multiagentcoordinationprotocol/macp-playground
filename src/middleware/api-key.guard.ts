import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import { isValidApiKey } from './api-key';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly config: AppConfigService,
    private readonly reflector: Reflector
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const keys = this.config.authApiKeys;
    // No keys configured: open, for local development only. AppConfigService refuses to boot with
    // NODE_ENV=production and no AUTH_API_KEYS, so a deployed service never takes this branch.
    if (!keys || keys.length === 0) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    if (!isValidApiKey(request.headers['x-api-key'], keys)) {
      throw new UnauthorizedException('Invalid or missing API key');
    }

    return true;
  }
}
