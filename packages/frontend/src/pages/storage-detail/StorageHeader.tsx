import {
  EllipsisVertical,
  KeyRound,
  Pin,
  RefreshCw,
  RotateCw,
  Settings,
  Trash2,
} from "lucide-react";
import { AppMembershipLink } from "@/components/apps/AppMembership";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ObjectStorageConnection } from "@/types";
import { formatHealthStatusLabel, formatProviderLabel, HEALTH_BADGE } from "./shared";

interface StorageHeaderProps {
  storage: ObjectStorageConnection;
  healthStatus: ObjectStorageConnection["healthStatus"];
  canEdit: boolean;
  canRestart: boolean;
  canRetry: boolean;
  canReveal: boolean;
  canDelete: boolean;
  /** Why Remove is disabled (the storage's app environment is isolated by the kill switch); null enables it. */
  removeDisabledReason?: string | null;
  onOpenPin: () => void;
  onBack: () => void;
  onTest: () => void;
  onOpenSettings: () => void;
  onRestart: () => void;
  onRetry: () => void;
  onRevealCredentials: () => void;
  onRemove: () => void;
}

export function StorageHeader({
  storage,
  healthStatus,
  canEdit,
  canRestart,
  canRetry,
  canReveal,
  canDelete,
  removeDisabledReason = null,
  onOpenPin,
  onBack,
  onTest,
  onOpenSettings,
  onRestart,
  onRetry,
  onRevealCredentials,
  onRemove,
}: StorageHeaderProps) {
  const menuItems = (
    <>
      {canEdit && (
        <DropdownMenuItem onClick={onOpenSettings}>
          <Settings className="h-3.5 w-3.5 mr-2" />
          Settings
        </DropdownMenuItem>
      )}
      {canRestart && (
        <DropdownMenuItem onClick={onRestart}>
          <RefreshCw className="h-3.5 w-3.5 mr-2" />
          Restart storage
        </DropdownMenuItem>
      )}
      {canRetry && (
        <DropdownMenuItem onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5 mr-2" />
          Retry provisioning
        </DropdownMenuItem>
      )}
      {(canEdit || canRestart || canRetry) && (canReveal || canDelete) && <DropdownMenuSeparator />}
      {canReveal && (
        <DropdownMenuItem onClick={onRevealCredentials}>
          <KeyRound className="h-3.5 w-3.5 mr-2" />
          Reveal credentials
        </DropdownMenuItem>
      )}
      {canReveal && canDelete && <DropdownMenuSeparator />}
      {canDelete && (
        <DropdownMenuItem
          onClick={onRemove}
          disabled={removeDisabledReason !== null}
          title={removeDisabledReason ?? undefined}
          className="text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          Remove
        </DropdownMenuItem>
      )}
    </>
  );

  const endpointLabel = storage.endpoint || formatProviderLabel(storage.provider);

  return (
    <PageHeader
      className="shrink-0"
      leading={<PageBackButton onClick={onBack} />}
      title={storage.name}
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
            {formatProviderLabel(storage.provider)}
          </Badge>
        </>
      }
      description={
        <span className="break-all">
          {endpointLabel}
          {storage.region ? ` · ${storage.region}` : ""}
          {storage.defaultBucket ? ` · ${storage.defaultBucket}` : ""}
          {storage.app ? (
            <>
              {" · "}
              <AppMembershipLink app={storage.app} />
            </>
          ) : null}
        </span>
      }
      actions={
        <>
          <div className="hidden items-center gap-2 sm:flex">
            <Button variant="outline" size="icon" onClick={onOpenPin} aria-label="Pin storage">
              <Pin className="h-4 w-4" />
            </Button>
            {canEdit && (
              <Button variant="outline" onClick={onTest}>
                <RefreshCw className="h-4 w-4" />
                Test
              </Button>
            )}
            {(canEdit || canRestart || canRetry || canReveal || canDelete) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More storage actions">
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <div className="ml-auto flex shrink-0 sm:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Storage actions">
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onOpenPin}>
                  <Pin className="h-3.5 w-3.5 mr-2" />
                  Pin
                </DropdownMenuItem>
                {canEdit && (
                  <DropdownMenuItem onClick={onTest}>
                    <RefreshCw className="h-3.5 w-3.5 mr-2" />
                    Test
                  </DropdownMenuItem>
                )}
                {(canEdit || canRestart || canRetry || canReveal || canDelete) && (
                  <DropdownMenuSeparator />
                )}
                {menuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      }
    />
  );
}
