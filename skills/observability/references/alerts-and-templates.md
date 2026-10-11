# Alerts and notification templates

## Alert rules

An alert rule has:

- `category`: `node`, `container`, `build`, `compose`, `proxy`, `pages`, `gateway`, `logging`, `integration`, `certificate`, `security`, `database_postgres`, `database_clickhouse`, or `database_redis` (key-value stores);
- `gateway` watches Opfield itself: threshold metrics `host_cpu`, `host_memory`, `host_disk`, `process_memory`, `event_loop_delay`, `api_error_rate`, `api_latency_p95`, `postgres_latency`, `postgres_pool_waiting`, `redis_latency`, and stateful events `postgres.unavailable`, `redis.unavailable`, `container.unhealthy`, `job.failing`, `outbound.unavailable` (Opfield lost outbound connectivity: none of the webhook hosts or two public endpoints can be reached; a built-in rule) besides the relay and license events. Proxy host health alerts explained by a firing node `offline` alert for their node, or by `outbound.unavailable` when Opfield's own probe got no answer, are folded under it: not sent separately to a webhook that gets that alert, and resolved with it. A `postgres.unavailable` alert is sent straight to its webhooks while Postgres is down and recorded once it is back;
- `type`: `threshold` (`metric`, `operator`, `thresholdValue`, `durationSeconds`, `fireThresholdPercent`, `resolveAfterSeconds`, `resolveThresholdPercent`) or `event` (`eventPattern`);
- `resourceIds`: the resources in scope; empty means every matching resource;
- `severity`, a Handlebars message template (`messageTemplate`, sent when the alert fires), a resolve message template (`resolveMessageTemplate`, sent when it resolves; empty uses Opfield's text for the rule, such as "Proxy host example.com is back online after 13m 2s.", never the firing message; recovery events `online` and `health.online` are sent once and close quietly, without a resolve), and `cooldownSeconds` (default 900).

`GET /api/notifications/alert-rules/categories` is the authoritative list of each category's metrics, events, and template variables. Read it before writing a rule or template instead of guessing field names.

## Webhooks

A webhook has a URL, method, a Handlebars body template (Discord, Slack, Telegram, generic JSON, and plain-text presets), custom headers, and optional HMAC-SHA256 signing. Each webhook sends its notifications one at a time in order; while its target cannot be reached (network/DNS error, timeout, 5xx) the whole webhook pauses and resumes in order, and a 429 pauses it for the time the target asks. A firing that could not go out because the target was unreachable is not sent once its alert resolved, and neither is that resolve (delivery status `superseded`, shown as Not sent, with the reason in `error`); a rate-limited (429) webhook still gets both, in order. `list_webhook_deliveries` and `get_delivery_stats` show results; `test_webhook` sends a test.

Webhook URLs and headers often embed credentials. `notifications:webhooks:manage` reveals them; never repeat them in chat, and never ask the user to paste a signing secret or token URL into chat. Let the user enter those in the Console.

## Template variables

Variables are namespaced: `{{notification.*}}`, `{{alert.*}}`, `{{resource.*}}`, `{{metric.*}}`, `{{node.*}}`, `{{certificate.*}}`, `{{state.*}}`, `{{event.*}}`, `{{operation.*}}`, `{{failure.*}}`, `{{details.*}}`, `{{fired.*}}`, `{{resolution.*}}`, and `{{gateway.url}}`. Legacy flat names such as `alert_name`, `severity`, or `value` are not aliases and render empty without an error.

Helpers:

- comparison: `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `and`, `or`, `not`;
- formatting: `round`, `uppercase`, `lowercase`, `truncate`, `json`, `default`, `coalesce`, `join`;
- math: `math`, `percent`;
- time: `formatDuration`, `timeago`, `dateformat`;
- text: `pluralize`.

## Scopes

`notifications:alerts:view|manage` and `notifications:webhooks:view|manage` (manage also reveals URLs and headers and implies view).
