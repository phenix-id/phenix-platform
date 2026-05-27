import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { marketplace_plan, marketplace_subscription } from '@prisma/client';
import { MarketplaceRepository } from '../repositories/marketplace.repository';
import { MicrosoftMarketplaceClient } from './microsoft-marketplace.client';

const dimensionByEventType: Record<string, string> = {
  organization_setup_completed: 'setup_fee',
  issuance_completed: 'issuance_txn',
  verification_completed: 'verification_txn',
  schema_created: 'schema_create'
};

@Injectable()
export class MeteringService {
  private readonly logger = new Logger('MeteringService');

  constructor(
    private readonly marketplaceRepository: MarketplaceRepository,
    private readonly microsoftMarketplaceClient: MicrosoftMarketplaceClient
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async aggregateAndSubmitUsage(): Promise<void> {
    if (`${process.env.MARKETPLACE_METERING_ENABLED}`.toLowerCase() !== 'true') {
      return;
    }

    await this.aggregateUsage();
    await this.submitPendingUsage();
  }

  async aggregateUsage(): Promise<void> {
    const subscriptions = await this.marketplaceRepository.listActiveSubscriptions();

    for (const subscription of subscriptions) {
      await this.aggregateSubscriptionUsage(subscription);
    }
  }

  async submitPendingUsage(): Promise<void> {
    const pendingEvents = await this.marketplaceRepository.listPendingUsageEvents();

    if (!pendingEvents.length) {
      return;
    }

    const eligibleEvents = pendingEvents.filter(
      (event) => Date.now() - event.usageStartTime.getTime() <= 24 * 60 * 60 * 1000
    );
    const expiredEvents = pendingEvents.filter(
      (event) => Date.now() - event.usageStartTime.getTime() > 24 * 60 * 60 * 1000
    );

    for (const event of expiredEvents) {
      await this.marketplaceRepository.updateUsageEventStatus(event.id, 'expired', {
        message: 'Usage event is older than the Microsoft 24 hour submission window'
      });
    }

    if (!eligibleEvents.length) {
      return;
    }

    const response = await this.microsoftMarketplaceClient.submitBatchUsageEvents(
      eligibleEvents.map((event) => ({
        resourceId: event.subscription.marketplaceSubscriptionId,
        quantity: event.quantity,
        dimension: event.dimension,
        effectiveStartTime: event.usageStartTime.toISOString(),
        planId: event.subscription.planId
      }))
    );

    // Microsoft returns a per-event result array. Index i in result[] corresponds to
    // index i in the submitted batch. Status values: "Accepted" | "Duplicate" | "Error".
    const batchResult = response.data as {
      count?: number;
      result?: Array<{ status?: string; error?: { code?: string; message?: string } }>;
    };
    const results = batchResult?.result ?? [];

    for (let i = 0; i < eligibleEvents.length; i++) {
      const event = eligibleEvents[i];
      const eventResult = results[i];

      if (!eventResult) {
        this.logger.warn(`[submitPendingUsage] No result at index ${i} for event ${event.id} — marking failed`);
        await this.marketplaceRepository.updateUsageEventStatus(event.id, 'failed', {
          message: 'No per-event result in Microsoft batch response',
          requestId: response.requestId,
          correlationId: response.correlationId
        });
        continue;
      }

      const msStatus = (eventResult.status ?? '').toLowerCase();

      if (msStatus === 'accepted') {
        await this.marketplaceRepository.updateUsageEventStatus(event.id, 'submitted', {
          message: 'Accepted by Microsoft',
          requestId: response.requestId,
          correlationId: response.correlationId
        });
      } else if (msStatus === 'duplicate') {
        this.logger.warn(`[submitPendingUsage] Duplicate event ${event.id} — already accepted by Microsoft`);
        await this.marketplaceRepository.updateUsageEventStatus(event.id, 'duplicate', {
          message: 'Duplicate — already accepted by Microsoft in a prior submission',
          requestId: response.requestId,
          correlationId: response.correlationId
        });
      } else {
        const errorDetail = eventResult.error
          ? `${eventResult.error.code ?? 'UNKNOWN'}: ${eventResult.error.message ?? ''}`
          : JSON.stringify(eventResult);
        this.logger.error(`[submitPendingUsage] Microsoft rejected event ${event.id} — ${errorDetail}`);
        await this.marketplaceRepository.updateUsageEventStatus(event.id, 'failed', {
          message: `Microsoft rejected: ${errorDetail}`,
          requestId: response.requestId,
          correlationId: response.correlationId
        });
      }
    }
  }

  private async aggregateSubscriptionUsage(subscription: marketplace_subscription): Promise<void> {
    if (!subscription.orgId) {
      return;
    }

    const plan = await this.marketplaceRepository.getPlan(subscription.offerId, subscription.planId);
    const start =
      subscription.termStartDate || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const end = subscription.termEndDate || new Date();
    const sourceEvents = await this.marketplaceRepository.getBillableEventsForSubscription(subscription.id, start, end);
    const includedUsage = this.includedUsage(plan);
    const runningTotals: Record<string, number> = {};
    const hourlyOverage: Record<string, { quantity: number; sourceEventIds: string[]; dimension: string; hour: Date }> =
      {};

    for (const event of sourceEvents) {
      const dimension = dimensionByEventType[event.eventType];
      if (!dimension) {
        continue;
      }

      const previousTotal = runningTotals[dimension] || 0;
      runningTotals[dimension] = previousTotal + event.quantity;
      const included = includedUsage[dimension] || 0;

      if (runningTotals[dimension] <= included) {
        continue;
      }

      const billableQuantity = Math.min(event.quantity, runningTotals[dimension] - Math.max(previousTotal, included));

      const hour = new Date(event.occurredAt);
      hour.setUTCMinutes(0, 0, 0);
      const key = `${dimension}:${hour.toISOString()}`;

      hourlyOverage[key] = hourlyOverage[key] || { dimension, hour, quantity: 0, sourceEventIds: [] };
      hourlyOverage[key].quantity += billableQuantity;
      hourlyOverage[key].sourceEventIds.push(event.id);
    }

    for (const overage of Object.values(hourlyOverage)) {
      await this.marketplaceRepository.createOrUpdateUsageEvent({
        subscriptionId: subscription.id,
        orgId: subscription.orgId,
        dimension: overage.dimension,
        quantity: overage.quantity,
        usageStartTime: overage.hour,
        sourceEventIds: overage.sourceEventIds
      });
    }
  }

  private includedUsage(plan: marketplace_plan | null): Record<string, number> {
    return {
      setup_fee: 0,
      issuance_txn: plan?.includedIssuanceTransactions || 0,
      verification_txn: plan?.includedVerificationTransactions || 0,
      schema_create: plan?.includedSchemas || 0
    };
  }
}
