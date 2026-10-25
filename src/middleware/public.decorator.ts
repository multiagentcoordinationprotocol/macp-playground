import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Exempts a route from `ApiKeyGuard`. Reserved for routes that disclose nothing — today only the
 * `/healthz` liveness probe, which the image's own Docker HEALTHCHECK calls without a key.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
