---
{
  "id": "8irxtjyz",
  "file_name": "8irxtjyz_gateway_notification_template",
  "tags": [
    "notifications",
    "opfield",
    "templates",
    "webhooks"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1783070851927,
  "updated_at": 1791851291837
}
---
Opfield notification templates use one canonical nested render context across alert messages, webhook dispatch, webhook preview, presets and frontend help (`packages/backend/src/modules/notifications/notification-templates.ts`, `notification-dispatcher.service.ts`).

- Supported namespaced variable families: notification.*, alert.*, resource.*, metric.*, node.*, health.*, certificate.*, state.*, event.*, fired.*, resolution.*, and gateway.*. Helpers: coalesce plus the existing formatting helpers.
- Historical flat variables (value, data_value, resourceName, fired_at, fired_duration and similar) are intentionally excluded from the generated context.
- Container lifecycle events put the real Docker containerId into resource.id when present; resource.key remains the alert state/dedupe key.
- Webhook preview must build its context with NotificationDispatcherService.getGatewayUrl(), exactly like real dispatch.
- The notification catalog and EventBus mappings (`notification-catalog.ts`, `notification-event-mappings.ts`) must stay in sync with frontend help. The July 2026 test commands for this area referenced files removed by the 2026-09-29 light-suite cut; verify with backend typecheck and frontend build.
