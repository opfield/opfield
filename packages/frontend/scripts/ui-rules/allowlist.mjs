// Files allowed to break one UI rule, each with the reason. A stale entry fails the check.
const DENSE_ROW_ACTION = "row action inside a dense table or list row";
const LOG_TIMESTAMP = "log viewer: log lines show exact timestamps (design corrections #19)";

export const ALLOWLIST = [
  {
    rule: "button-default-size",
    file: "src/components/docker/availability/AvailabilityOperationsPanel.tsx",
    reason: DENSE_ROW_ACTION,
  },
  {
    rule: "button-default-size",
    file: "src/components/ai/AIToolCallBlock.tsx",
    reason: "artifact link chip in the AI transcript, sized by its own className",
  },
  {
    rule: "button-default-size",
    file: "src/components/terminal/TerminalConsole.tsx",
    reason: "pop-out button floating over the terminal output",
  },
  {
    rule: "dialog-footer-right",
    file: "src/components/access/AccessDialogFooter.tsx",
    reason: "the Review N scopes link sits on the left of the access dialogs' footer (permissions rework)",
  },
  { rule: "shared-date-format", file: "src/pages/DockerLogsPopout.tsx", reason: LOG_TIMESTAMP },
  {
    rule: "shared-date-format",
    file: "src/pages/docker-detail/LogsTab.tsx",
    reason: LOG_TIMESTAMP,
  },
  {
    rule: "shared-date-format",
    file: "src/pages/logging/LoggingExplorer.tsx",
    reason: LOG_TIMESTAMP,
  },
  {
    rule: "shared-date-format",
    file: "src/pages/logging/LoggingEventDetailsDialog.tsx",
    reason: LOG_TIMESTAMP,
  },
  {
    rule: "shared-date-format",
    file: "src/components/ui/health-bars.tsx",
    reason: "bar tooltip carries the exact time of its bucket (design corrections #19)",
  },
  {
    rule: "shared-date-format",
    file: "src/components/docker/availability/AvailabilityLeaseSummaryRows.tsx",
    reason: "absolute failover deadline inside a sentence",
  },
];
