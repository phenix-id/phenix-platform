import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MARKETPLACE_FEATURE_KEY, MarketplaceFeature } from '../decorators/requires-marketplace-feature.decorator';
import { MarketplaceService } from '../marketplace.service';

interface EntitlementResponse {
  features?: Record<string, boolean>;
  blockedReason?: string | null;
}

@Injectable()
export class MarketplaceEntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly marketplaceService: MarketplaceService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<MarketplaceFeature>(MARKETPLACE_FEATURE_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!feature) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const orgId = this.getOrgId(request);

    if (!orgId) {
      return true;
    }

    const entitlements = (await this.marketplaceService.getEntitlements(
      orgId,
      request.user?.id
    )) as EntitlementResponse;
    if (entitlements.features?.[feature]) {
      return true;
    }

    throw new ForbiddenException({
      code: entitlements.blockedReason || 'marketplace_feature_not_allowed',
      message: 'Marketplace subscription does not allow this action'
    });
  }

  private getOrgId(request): string | undefined {
    return (
      request.params?.orgId ||
      request.params?.organizationId ||
      request.body?.orgId ||
      request.body?.organizationId ||
      request.query?.orgId
    );
  }
}
