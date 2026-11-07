import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppConfigService } from '../config/app-config.service';
import { ClientIpRequest, resolveClientIp } from './client-ip';

/**
 * The global request throttle, keyed on the resolved client IP rather than the socket peer. Behind
 * Railway and the ui-console proxy the socket peer is the same for every user, which made the
 * per-client limit a single shared one.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  @Inject(AppConfigService) private readonly appConfig!: AppConfigService;

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return resolveClientIp(
      req as unknown as ClientIpRequest,
      this.appConfig.authApiKeys ?? [],
      this.appConfig.trustedProxyHops ?? 0
    ).ip;
  }
}
