/* eslint-disable camelcase */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@credebl/prisma-service';
import { ICreateWebhookUrl, IGetWebhookUrl } from '../interfaces/webhook.interfaces';
import { org_agents } from '@prisma/client';
import { IWebhookUrl } from '@credebl/common/interfaces/webhook.interface';
@Injectable()
export class WebhookRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger
  ) {}

  async registerWebhook(orgId: string, webhookUrl: string): Promise<ICreateWebhookUrl> {
    try {
      const agentInfo = this.prisma.org_agents.update({
        where: {
          orgId
        },
        data: {
          webhookUrl
        }
      });

      return agentInfo;
    } catch (error) {
      this.logger.error(`[registerWebhookUrl] - register webhook url details: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async getWebhookUrl(getWebhook: IWebhookUrl): Promise<IGetWebhookUrl> {
    try {

      const { tenantId, orgId } = getWebhook;
      const normalizedTenantId = this.normalizeTenantId(tenantId);
      let webhookUrlInfo;

      if ((undefined === normalizedTenantId || 'default' === normalizedTenantId) && orgId) {
        webhookUrlInfo = await this.prisma.org_agents.findFirstOrThrow({

          where: {
            orgId
          }
        });
      } else if (normalizedTenantId && 'default' !== normalizedTenantId) {
        webhookUrlInfo = await this.prisma.org_agents.findFirstOrThrow({

          where: {
            tenantId: normalizedTenantId
          }
        });
      }
      
      return webhookUrlInfo;
    } catch (error) {
      this.logger.error(`[getWebhookUrl] -  webhook url details: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  private normalizeTenantId(tenantId?: string): string | undefined {
    const normalizedTenantId = tenantId?.trim();

    if (!normalizedTenantId) {
      return undefined;
    }

    return normalizedTenantId.startsWith('tenant-') ? normalizedTenantId.slice('tenant-'.length) : normalizedTenantId;
  }

  async getOrganizationDetails(orgId: string): Promise<org_agents> {
    try {
      return this.prisma.org_agents.findUnique({
        where: {
          orgId
        }
      });
    } catch (error) {
      this.logger.error(`error: ${JSON.stringify(error)}`);
      throw error;
    }
  }
}
