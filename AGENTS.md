# AGENTS.md

## Role

Act as a senior backend developer when working in this repository. Favor careful code reading, production-minded tradeoffs, and clear explanations of how and why the service behaves as it does.

## Repository Context

This repository is the Phenix / CREDEBL SSI Platform backend. It is a NestJS monorepo with:

- `apps/api-gateway`: public HTTP API gateway.
- `apps/marketplace`: Microsoft Azure Marketplace integration microservice.
- Other domain microservices under `apps/`: `user`, `organization`, `ledger`, `connection`, `issuance`, `verification`, `agent-service`, `agent-provisioning`, `cloud-wallet`, `notification`, `webhook`, `geo-location`, and `utility`.
- Shared libraries under `libs/`, including Prisma, common constants, NATS config, response helpers, storage helpers, and shared interfaces.

Current branch context when this file was created: `feat/marketplace-billing`.

## Architecture Notes

The API gateway exposes REST endpoints and forwards most domain work to microservices over NATS. Domain microservices consume `@MessagePattern({ cmd: ... })` commands, run business logic in services, and persist through repositories using Prisma/Postgres.

Typical request flow:

```text
Client -> API Gateway Controller -> Gateway Service -> NATS command
  -> Domain Microservice Controller -> Domain Service -> Repository / external API
  -> response over NATS -> HTTP response
```

NATS configuration is centralized in `libs/common/src/nats.config.ts`. Service name constants and Marketplace command names are in `libs/common/src/common.constant.ts`.

## Marketplace Context

The marketplace work implements a Microsoft Azure Marketplace transactable SaaS integration:

- Customer buys Phenix ID Platform in Azure Marketplace.
- Microsoft redirects to Studio with a purchase token.
- Studio calls `POST /marketplace/subscriptions/resolve`.
- Backend resolves the token with Microsoft Fulfillment API.
- Backend creates or reuses an onboarding session.
- User links account, links or creates an organization, then activates the subscription.
- Microsoft lifecycle webhooks arrive at `POST /marketplace/webhook`.
- Entitlements gate paid features.
- Completed SSI usage is aggregated and submitted to Microsoft Metering API for overage billing.

Important backend files:

- `apps/api-gateway/src/marketplace/marketplace.controller.ts`
- `apps/api-gateway/src/marketplace/marketplace.service.ts`
- `apps/api-gateway/src/marketplace/guards/marketplace-entitlement.guard.ts`
- `apps/api-gateway/src/marketplace/decorators/requires-marketplace-feature.decorator.ts`
- `apps/marketplace/src/marketplace.service.ts`
- `apps/marketplace/src/marketplace.controller.ts`
- `apps/marketplace/src/repositories/marketplace.repository.ts`
- `apps/marketplace/src/services/microsoft-marketplace.client.ts`
- `apps/marketplace/src/services/publisher-token.service.ts`
- `apps/marketplace/src/services/webhook.service.ts`
- `apps/marketplace/src/services/metering.service.ts`
- `apps/marketplace/src/services/entitlement.service.ts`
- `apps/marketplace/src/services/reconciliation.service.ts`
- `libs/prisma-service/prisma/migrations/20260512120000_marketplace_billing/migration.sql`

Marketplace database tables added by the migration:

- `marketplace_subscription`
- `marketplace_onboarding_session`
- `marketplace_plan`
- `marketplace_usage_event`
- `billing_usage_event`
- `marketplace_webhook_event`
- `marketplace_operation`

Seeded plan IDs:

- `starter`
- `business`
- `enterprise`

## Billing Model

The current implementation is completion-based billing.

Internal billing event mapping:

```text
issuance_completed     -> issuance_txn
verification_completed -> verification_txn
schema_created         -> schema_create
```

Billing events are recorded from:

- `apps/api-gateway/src/issuance/issuance.controller.ts`
- `apps/api-gateway/src/verification/verification.controller.ts`
- `apps/api-gateway/src/schema/schema.controller.ts`

Metering aggregation runs in `apps/marketplace/src/services/metering.service.ts` every 10 minutes when `MARKETPLACE_METERING_ENABLED=true`.

## Issuer And Verifier API Context

All public issuer and verifier APIs use the standard response envelope:

```json
{
  "statusCode": 201,
  "message": "string",
  "data": {}
}
```

Important issuer files:

- `apps/api-gateway/src/issuance/issuance.controller.ts`
- `apps/api-gateway/src/issuance/issuance.service.ts`
- `apps/api-gateway/src/issuance/dtos/issuance.dto.ts`
- `apps/api-gateway/src/issuance/dtos/multi-connection.dto.ts`
- `apps/issuance/src/issuance.controller.ts`
- `apps/issuance/src/issuance.service.ts`

Issuer connected credential offer:

- Endpoint: `POST /orgs/:orgId/credentials/offer?credentialType=indy|jsonld`
- Marketplace feature gate: `issuance`
- NATS command: `send-credential-create-offer`
- Indy requires `credentialDefinitionId` and `credentialData[].attributes`.
- JSON-LD requires `credentialData[].credential` and `credentialData[].options`.
- The service validates required schema attributes before calling the agent.
- Response `data` is an array of per-recipient results. Top-level status may be `201` for all success, `206` for partial success, or `400` for all failed.

Typical connected issuer payload:

```json
{
  "credentialDefinitionId": "string",
  "comment": "string",
  "protocolVersion": "v1",
  "autoAcceptCredential": "always",
  "credentialData": [
    {
      "connectionId": "uuid",
      "attributes": [
        {
          "name": "string",
          "value": "string",
          "isRequired": false
        }
      ],
      "credential": {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiableCredential"],
        "issuer": {
          "id": "did"
        },
        "issuanceDate": "2019-10-12T07:20:50.52Z",
        "credentialSubject": {}
      },
      "options": {
        "proofType": "Ed25519Signature2018",
        "proofPurpose": "assertionMethod"
      }
    }
  ]
}
```

Typical connected issuer response:

```json
{
  "statusCode": 201,
  "message": "Credential offer created successfully",
  "data": [
    {
      "statusCode": 201,
      "message": "Credential offer created successfully",
      "data": {
        "id": "string",
        "state": "string",
        "connectionId": "string",
        "threadId": "string",
        "protocolVersion": "string"
      }
    }
  ]
}
```

Issuer out-of-band credential offer:

- Endpoint: `POST /orgs/:orgId/credentials/oob/offer?credentialType=indy|jsonld`
- NATS command: `send-credential-create-offer-oob`
- Does not require an existing `connectionId`.
- If `isShortenUrl=true`, the invitation URL is stored through `store-object-return-url`, replaced with the shortened URL, and `deepLinkURL` is added.
- If `reuseConnection=true`, the service may reuse an existing `invitationDid` for the org.

Typical issuer OOB payload:

```json
{
  "credentialDefinitionId": "string",
  "attributes": [
    {
      "name": "string",
      "value": "string"
    }
  ],
  "comment": "string",
  "protocolVersion": "v1",
  "goalCode": "string",
  "parentThreadId": "string",
  "willConfirm": true,
  "autoAcceptCredential": "always",
  "isShortenUrl": true,
  "reuseConnection": true
}
```

Typical issuer OOB response:

```json
{
  "statusCode": 201,
  "message": "Credential offer created successfully",
  "data": {
    "invitationUrl": "string",
    "deepLinkURL": "string"
  }
}
```

Issuer OOB email offer:

- Endpoint: `POST /orgs/:orgId/credentials/oob/email?credentialType=indy|jsonld`
- NATS command: `out-of-band-credential-offer`
- Sends one or more OOB credential offers by email.
- Response `data` is usually `true` when all emails are sent.

Important verifier files:

- `apps/api-gateway/src/verification/verification.controller.ts`
- `apps/api-gateway/src/verification/verification.service.ts`
- `apps/api-gateway/src/verification/dto/request-proof.dto.ts`
- `apps/api-gateway/src/verification/dto/webhook-proof.dto.ts`
- `apps/verification/src/verification.controller.ts`
- `apps/verification/src/verification.service.ts`

Verifier connected proof request:

- Endpoint: `POST /orgs/:orgId/proofs?requestType=indy|presentationExchange`
- Marketplace feature gate: `verification`
- NATS command: `send-proof-request`
- Indy requires `proofFormats.indy.attributes`.
- Presentation Exchange requires `presentationDefinition`.
- The gateway rejects duplicate requested attribute names for Indy.
- The microservice transforms the request into the agent proof request format and calls `agent-send-proof-request`.

Typical connected verifier payload:

```json
{
  "connectionId": "uuid",
  "comment": "string",
  "protocolVersion": "v1",
  "goalCode": "string",
  "parentThreadId": "string",
  "willConfirm": true,
  "autoAcceptProof": "never",
  "proofFormats": {
    "indy": {
      "attributes": [
        {
          "attributeName": "name",
          "condition": ">=",
          "value": "18",
          "credDefId": "string",
          "schemaId": "string"
        }
      ]
    }
  },
  "presentationDefinition": {
    "id": "string",
    "name": "string",
    "purpose": "string",
    "input_descriptors": [
      {
        "id": "string",
        "schema": [
          {
            "uri": "string"
          }
        ],
        "constraints": {
          "fields": [
            {
              "path": ["$.field"]
            }
          ]
        }
      }
    ]
  }
}
```

Typical connected verifier response:

```json
{
  "statusCode": 201,
  "message": "Proof request sent successfully",
  "data": {
    "id": "string",
    "state": "string",
    "connectionId": "string",
    "threadId": "string"
  }
}
```

Verifier proof acceptance:

- Endpoint: `POST /orgs/:orgId/proofs/:proofId/verify`
- Marketplace feature gate: `verification`
- NATS command: `verify-presentation`
- No request body.
- Calls the agent accept-presentation endpoint and returns the agent proof presentation response.

Verifier out-of-band proof request:

- Endpoint: `POST /orgs/:orgId/proofs/oob?requestType=indy|presentationExchange`
- NATS command: `send-out-of-band-proof-request`
- Does not require an existing `connectionId`.
- If `emailId` is present, the service sends email invitations and response `data` is `true`.
- If `emailId` is omitted, response `data` is the invitation object.
- If `isShortenUrl=true`, the invitation URL is shortened through `store-object-return-url` and `deepLinkURL` is added.
- If `reuseConnection=true`, the service may reuse an existing `invitationDid` for the org.

Typical verifier OOB payload:

```json
{
  "comment": "string",
  "protocolVersion": "v1",
  "goalCode": "string",
  "parentThreadId": "string",
  "autoAcceptProof": "always",
  "proofFormats": {
    "indy": {
      "attributes": [
        {
          "attributeName": "name",
          "schemaId": "string",
          "credDefId": "string"
        }
      ]
    }
  },
  "presentationDefinition": {
    "id": "string",
    "input_descriptors": []
  },
  "isShortenUrl": true,
  "emailId": ["user@example.com"],
  "reuseConnection": true
}
```

Typical verifier OOB response without email:

```json
{
  "statusCode": 201,
  "message": "Proof request sent successfully",
  "data": {
    "invitationUrl": "string",
    "deepLinkURL": "string"
  }
}
```

Typical verifier OOB response with email:

```json
{
  "statusCode": 201,
  "message": "Proof request sent successfully",
  "data": true
}
```

Issuer and verifier webhooks:

- Issuance webhook: `POST /wh/:id/credentials`
- Verification webhook: `POST /wh/:orgId/proofs`
- Both are excluded from Swagger with `@ApiExcludeEndpoint()`.
- Issuance records marketplace usage when state is `done`, `issued`, or `credential_issued`.
- Verification records marketplace usage when `isVerified=true`, state is `verified`, or state is `done`.
- Usage events are recorded as `issuance_completed` and `verification_completed` for completion-based billing.
- If the tenant/org has a configured webhook URL, the gateway forwards the raw webhook payload to that external webhook.

## Entitlements

Feature gates use `@RequiresMarketplaceFeature(...)` plus `MarketplaceEntitlementGuard`.

Known feature keys:

- `schemaCreate`
- `credentialDefinitionCreate`
- `issuance`
- `bulkIssuance`
- `verification`
- `apiAccess`

If `MARKETPLACE_REQUIRED=false`, organizations without a marketplace subscription are allowed by default. If `MARKETPLACE_REQUIRED=true`, missing subscriptions block gated features.

## Production Readiness Notes

The Marketplace implementation is structurally complete, but keep these risks visible:

- `.env.sample` currently defaults `MARKETPLACE_ALLOW_LOCAL_MOCK=true`; this must be false in production.
- `.env.sample` currently defaults `MARKETPLACE_METERING_ENABLED=false`; this must be true in production for metered billing.
- `.env.sample` currently defaults `MARKETPLACE_RECONCILIATION_ENABLED=false`; this should be true in production for lifecycle drift correction.
- `.env.sample` currently defaults `MARKETPLACE_WEBHOOK_VALIDATE_JWT=false`; this must be true in production.
- `MARKETPLACE_CLIENT_SECRET` must come from a secret manager such as Azure Key Vault or deployment secrets, not plaintext config.
- `MeteringService.submitPendingUsage()` currently marks all batch-submitted usage events as `submitted`; Microsoft returns per-event outcomes and those should be parsed individually.
- The metering cron has no distributed lock. Multiple marketplace replicas could submit the same pending usage concurrently.
- Webhook `Reinstate` fetches the operation/subscription but does not currently patch operation acknowledgement back to Microsoft the same way `ChangePlan` and `ChangeQuantity` do.
- Onboarding session creation reuses an active session but is not wrapped in a transaction and has no unique constraint for concurrent duplicate token resolution.
- Confirm Studio legal routes are publicly accessible before Microsoft certification.
- Run a full Partner Center sandbox E2E flow before submission.

## Working Guidelines

- Prefer `rg` / `rg --files` for search.
- Do not revert user changes.
- Read existing patterns before editing.
- Keep Marketplace changes aligned with Microsoft SaaS Fulfillment and Metering API expectations.
- For production behavior, treat security, idempotency, webhook validation, billing correctness, and retry semantics as first-class concerns.
