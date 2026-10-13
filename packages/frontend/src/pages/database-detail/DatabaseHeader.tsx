import {
  ArrowRightLeft,
  FileCode2,
  HardDrive,
  KeyRound,
  Pause,
  Pin,
  Play,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { AppMembershipLink } from "@/components/apps/AppMembership";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import {
  HEADER_ACTION_PRIORITY,
  type ResponsiveHeaderAction,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { databaseTypeLabel, managedDatabaseVersionLabel } from "@/lib/database-type";
import type { DatabaseConnection } from "@/types";
import { formatHealthStatusLabel, HEALTH_BADGE } from "./shared";

interface DatabaseHeaderProps {
  database: DatabaseConnection;
  healthStatus: DatabaseConnection["healthStatus"] | "paused";
  canEdit: boolean;
  canResize: boolean;
  canPause: boolean;
  canUnpause: boolean;
  canRestart: boolean;
  canConfigureClickHouse: boolean;
  canConfigureRedis: boolean;
  /** Shows "Move to Valkey" (a managed key-value store that still runs Redis). */
  canMoveToValkey: boolean;
  /** Why "Move to Valkey" is disabled (the store is not running or its app environment is isolated by the kill switch); null enables it. */
  moveToValkeyDisabledReason: string | null;
  canReveal: boolean;
  canRotateDirectCredentials: boolean;
  canRotateCertificate: boolean;
  canDelete: boolean;
  /** Why Remove is disabled (the store's app environment is isolated by the kill switch); null enables it. */
  removeDisabledReason?: string | null;
  onOpenPin: () => void;
  onBack: () => void;
  onTest: () => void;
  onOpenSettings: () => void;
  onOpenResize: () => void;
  onPause: () => void;
  onUnpause: () => void;
  onRestart: () => void;
  onConfigureClickHouse: () => void;
  onConfigureRedis: () => void;
  onMoveToValkey: () => void;
  onRevealCredentials: () => void;
  onRotateDirectCredentials: () => void;
  onRotateCertificate: () => void;
  onRemove: () => void;
}

export function DatabaseHeader({
  database,
  healthStatus,
  canEdit,
  canResize,
  canPause,
  canUnpause,
  canRestart,
  canConfigureClickHouse,
  canConfigureRedis,
  canMoveToValkey,
  moveToValkeyDisabledReason,
  canReveal,
  canRotateDirectCredentials,
  canRotateCertificate,
  canDelete,
  removeDisabledReason = null,
  onOpenPin,
  onBack,
  onTest,
  onOpenSettings,
  onOpenResize,
  onPause,
  onUnpause,
  onRestart,
  onConfigureClickHouse,
  onConfigureRedis,
  onMoveToValkey,
  onRevealCredentials,
  onRotateDirectCredentials,
  onRotateCertificate,
  onRemove,
}: DatabaseHeaderProps) {
  type HeaderAction = ResponsiveHeaderAction & { buttonLabel: string; iconOnly?: boolean };
  const headerActions: HeaderAction[] = [
    {
      id: "database:pin",
      label: "Pin database",
      buttonLabel: "Pin",
      iconOnly: true,
      icon: <Pin className="h-4 w-4" />,
      onClick: onOpenPin,
    },
    ...(canEdit
      ? [
          {
            id: "database:test",
            label: "Test database connection",
            buttonLabel: "Test",
            icon: <RefreshCw className="h-4 w-4" />,
            onClick: onTest,
          },
          {
            id: "database:settings",
            label: "Database settings",
            buttonLabel: "Settings",
            icon: <Settings className="h-4 w-4" />,
            onClick: onOpenSettings,
          },
        ]
      : []),
    ...(canResize
      ? [
          {
            id: "database:resize",
            label: "Resize database",
            buttonLabel: "Resize",
            icon: <HardDrive className="h-4 w-4" />,
            onClick: onOpenResize,
          },
        ]
      : []),
    ...(canConfigureClickHouse
      ? [
          {
            id: "database:configure-clickhouse",
            label: "Configure ClickHouse",
            buttonLabel: "Configure ClickHouse",
            icon: <FileCode2 className="h-4 w-4" />,
            onClick: onConfigureClickHouse,
          },
        ]
      : []),
    ...(canConfigureRedis
      ? [
          {
            id: "database:configure-redis",
            label: "Configure key-value store",
            buttonLabel: "Configure key-value store",
            icon: <SlidersHorizontal className="h-4 w-4" />,
            onClick: onConfigureRedis,
          },
        ]
      : []),
    ...(canMoveToValkey
      ? [
          {
            id: "database:move-to-valkey",
            label: "Move to Valkey",
            buttonLabel: "Move to Valkey",
            icon: <ArrowRightLeft className="h-4 w-4" />,
            onClick: onMoveToValkey,
            disabled: moveToValkeyDisabledReason !== null,
            disabledReason: moveToValkeyDisabledReason ?? undefined,
          },
        ]
      : []),
    ...(canPause || canUnpause
      ? [
          {
            id: canPause ? "database:pause" : "database:unpause",
            label: canPause ? "Pause database" : "Unpause database",
            buttonLabel: canPause ? "Pause" : "Unpause",
            icon: canPause ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />,
            onClick: canPause ? onPause : onUnpause,
            priority: HEADER_ACTION_PRIORITY.primary,
          },
        ]
      : []),
    ...(canRestart
      ? [
          {
            id: "database:restart",
            label: "Restart database",
            buttonLabel: "Restart",
            icon: <RefreshCw className="h-4 w-4" />,
            onClick: onRestart,
            priority: HEADER_ACTION_PRIORITY.primary,
          },
        ]
      : []),
    ...(canReveal
      ? [
          {
            id: "database:reveal-credentials",
            label: "Reveal database credentials",
            buttonLabel: "Reveal credentials",
            icon: <KeyRound className="h-4 w-4" />,
            onClick: onRevealCredentials,
            separatorBefore: true,
          },
        ]
      : []),
    ...(canRotateDirectCredentials
      ? [
          {
            id: "database:rotate-direct-credentials",
            label: "Rotate direct-access credentials",
            buttonLabel: "Rotate credentials",
            icon: <RefreshCw className="h-4 w-4" />,
            onClick: onRotateDirectCredentials,
          },
        ]
      : []),
    ...(canRotateCertificate
      ? [
          {
            id: "database:rotate-tls-certificate",
            label: "Rotate TLS certificate",
            buttonLabel: "Rotate TLS",
            icon: <RefreshCw className="h-4 w-4" />,
            onClick: onRotateCertificate,
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            id: "database:remove",
            label: "Remove database",
            buttonLabel: "Remove",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: onRemove,
            disabled: removeDisabledReason !== null,
            disabledReason: removeDisabledReason ?? undefined,
            destructive: true,
            separatorBefore: true,
          },
        ]
      : []),
  ];

  const managedTitle =
    database.type === "redis" ? "Managed key-value store ·" : `Managed ${database.type}`;

  return (
    <PageHeader
      className="shrink-0"
      leading={<PageBackButton onClick={onBack} />}
      title={database.name}
      badges={
        <>
          <Badge
            variant={HEALTH_BADGE[healthStatus] ?? "secondary"}
            size="inline"
            className="shrink-0"
          >
            {formatHealthStatusLabel(healthStatus)}
          </Badge>
          <Badge variant="secondary" size="inline" className="shrink-0">
            {databaseTypeLabel(database.type)}
          </Badge>
        </>
      }
      description={
        <span className="break-all">
          {database.managed
            ? `${managedTitle} ${managedDatabaseVersionLabel({ type: database.type, version: database.managed.version, engine: database.managed.engine })} · ${database.managed.publishedPort === null ? "Private · through relay" : `TCP ${database.managed.publishedPort}${database.type === "clickhouse" && database.managed.publishedNativePort != null ? ` · native ${database.managed.publishedNativePort}` : ""}`}`
            : `${database.host}:${database.port}${database.databaseName ? ` · ${database.databaseName}` : ""}`}
          {database.app ? (
            <>
              {" · "}
              <AppMembershipLink app={database.app} />
            </>
          ) : null}
        </span>
      }
      actions={
        <ResponsiveHeaderActions actions={headerActions}>
          {headerActions.map((headerAction) => (
            <Button
              key={headerAction.id}
              variant={headerAction.destructive ? "destructive" : "outline"}
              size={headerAction.iconOnly ? "icon" : "default"}
              aria-label={headerAction.iconOnly ? headerAction.label : undefined}
              disabled={headerAction.disabled}
              title={headerAction.disabled ? headerAction.disabledReason : undefined}
              onClick={headerAction.onClick}
            >
              {headerAction.icon}
              {!headerAction.iconOnly ? headerAction.buttonLabel : null}
            </Button>
          ))}
        </ResponsiveHeaderActions>
      }
    />
  );
}
