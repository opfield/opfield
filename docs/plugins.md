# Plugin System

[Back to capabilities](capabilities.md)

The plugin system is a planned mechanism for extending Opfield with integrations and operational modules.

In development. The tentative target is no earlier than version 2.20; the release version and timing may change.

## Purpose

A plugin represents an extension to Opfield's capabilities. The plugin system will define how extensions attach to the application and interact with its core.

Its intended scope includes integrations with external systems and additional infrastructure-management operations. Specific extension points have not yet been defined.

## Architectural role

The plugin-loading mechanism belongs to Opfield's core. It is not a separate plan feature.

A plugin and an external API client serve different integration roles. An external client calls existing Opfield operations through REST API or MCP. A plugin is intended to extend the capabilities of the application itself. Existing integrations do not yet constitute a public plugin-system contract.

## Implementation state

Plugin loading and management are not implemented. The package format, core interfaces, permission model, and compatibility rules remain under design. An SDK and development and installation instructions will follow the definition of these contracts.

Integrations with current Opfield versions use REST API, OAuth, and MCP.
