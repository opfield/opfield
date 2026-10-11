import { RefreshCw, ServerCog } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useScrollToNavigationTarget } from "@/hooks/use-scroll-to-navigation-target";
import { isDevForceUpdatesEnabled } from "@/lib/dev-force-updates";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useUpdateStore } from "@/stores/update";

interface UpdateSectionProps {
  canUpdate: boolean;
}

export function UpdateSection({ canUpdate }: UpdateSectionProps) {
  const {
    status: updateStatus,
    isChecking,
    checkForUpdates,
    triggerUpdate,
    triggerRelayUpdate,
    abandonRelayUpdate,
    fetchStatus,
  } = useUpdateStore();
  const [abandoningRelayUpdate, setAbandoningRelayUpdate] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseNotesSource, setReleaseNotesSource] = useState<"gateway" | "relay">("gateway");
  const [releaseNotesList, setReleaseNotesList] = useState<string[] | null>(null);
  const [releaseVersions, setReleaseVersions] = useState<string[] | null>(null);
  const [releaseNotesLoading, setReleaseNotesLoading] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(updateStatus !== null);

  // Fetch status on mount
  useEffect(() => {
    void fetchStatus().finally(() => setInitialLoadComplete(true));
  }, [fetchStatus]);

  const navigationHighlighted = useScrollToNavigationTarget("system-updates", initialLoadComplete, {
    block: "center",
    highlightDurationMs: 2200,
  });

  useContentLoading(!initialLoadComplete);
  if (!initialLoadComplete) return null;

  const handleCheckUpdate = async () => {
    await checkForUpdates();
    const s = useUpdateStore.getState().status;
    if (s?.updateAvailable && s.relay?.updateAvailable) {
      toast.info(`Opfield ${s.latestVersion} and Relay ${s.relay.latestVersion} are available`);
    } else if (s?.updateAvailable) {
      toast.info(`Opfield update available: ${s.latestVersion}`);
    } else if (s?.relay?.updateAvailable) {
      toast.info(`Relay update available: ${s.relay.latestVersion}`);
    } else {
      toast.success("Already up to date");
    }
  };

  const handleGatewayUpdate = async () => {
    if (!updateStatus) return;
    const gatewayUpdate = updateStatus.updateAvailable && Boolean(updateStatus.latestVersion);
    if (!gatewayUpdate || !updateStatus.latestVersion) return;
    const ok = await confirm({
      title: "Update Opfield",
      description: `Update Opfield from ${updateStatus.currentVersion} to ${updateStatus.latestVersion}? The application will restart automatically.`,
      confirmLabel: "Update",
    });
    if (!ok) return;
    if (isDevForceUpdatesEnabled()) {
      toast.info("Local update preview only");
      return;
    }
    triggerUpdate(updateStatus.latestVersion);
  };

  const handleRelayUpdate = async () => {
    if (!updateStatus?.relay?.updateAvailable || !updateStatus.relay.latestVersion) return;
    const ok = await confirm({
      title: "Update Relay Pool",
      description: `Update the Relay Pool from ${updateStatus.relay.currentVersion} to ${updateStatus.relay.latestVersion}? Multi-host pools drain and verify one instance at a time. A single-host pool has a short maintenance interruption.`,
      confirmLabel: "Update",
    });
    if (!ok) return;
    if (isDevForceUpdatesEnabled()) {
      toast.info("Local update preview only");
      return;
    }
    triggerRelayUpdate(updateStatus.relay.latestVersion);
  };

  const relayOperation = updateStatus?.relay?.operation ?? null;
  // A paused rollout keeps a relay drained until an operator retries or abandons it.
  const relayOperationAbandonable = Boolean(
    relayOperation &&
      (relayOperation.abandonable ??
        (relayOperation.status === "updating" || relayOperation.runState === "paused"))
  );

  const handleAbandonRelayUpdate = async () => {
    const ok = await confirm({
      title: "Abandon Relay Pool Update?",
      description:
        "Opfield fails this update run and returns the relays it drained to service. Relays that already updated keep the new version.",
      confirmLabel: "Abandon update",
      variant: "destructive",
    });
    if (!ok) return;
    setAbandoningRelayUpdate(true);
    try {
      await abandonRelayUpdate();
      toast.success("Relay Pool update abandoned");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to abandon the Relay Pool update"
      );
    } finally {
      setAbandoningRelayUpdate(false);
    }
  };

  const gatewayUpdateAvailable = Boolean(
    updateStatus?.updateAvailable && updateStatus.latestVersion
  );
  const relayRolloutRunning = relayOperation?.status === "updating";
  // While a rollout runs, the panel shows the rollout, not another update offer.
  const relayUpdateAvailable = Boolean(
    updateStatus?.relay?.updateAvailable && updateStatus.relay.latestVersion && !relayRolloutRunning
  );
  const showRelayPanel = relayUpdateAvailable || relayOperationAbandonable;
  const anyUpdateAvailable = gatewayUpdateAvailable || relayUpdateAvailable;
  const activeReleaseNotes =
    releaseNotesSource === "gateway"
      ? updateStatus?.releaseNotes
      : updateStatus?.relay?.releaseNotes;

  return (
    <>
      {gatewayUpdateAvailable && (
        <PanelShell
          icon={<RefreshCw className="h-4 w-4 text-warning-text" />}
          id="system-updates"
          title={<span className="text-warning-text">Opfield Update Available</span>}
          description="An Opfield update is ready to install"
          className={cn("xl:col-span-2", navigationHighlighted && "navigation-target-ripple")}
          dirty
          actions={
            <>
              {updateStatus?.releaseNotes && (
                <Button
                  variant="outline"
                  onClick={async () => {
                    setReleaseNotesSource("gateway");
                    setReleaseVersions(null);
                    setReleaseNotesList(null);
                    // Set with the open state, so the dialog waits for the full list
                    // instead of showing the latest notes and then replacing them.
                    setReleaseNotesLoading(true);
                    setReleaseNotesOpen(true);
                    try {
                      const all = await api.getAllReleaseNotes();
                      if (all.length > 0) {
                        setReleaseVersions(all.map((r) => r.version));
                        setReleaseNotesList(all.map((r) => r.notes));
                      }
                    } catch {
                      // Fallback: just show the cached latest release notes
                    } finally {
                      setReleaseNotesLoading(false);
                    }
                  }}
                >
                  Release notes
                </Button>
              )}
              {canUpdate && (
                <Button onClick={handleGatewayUpdate} variant="warning">
                  Update Opfield to {updateStatus?.latestVersion}
                </Button>
              )}
            </>
          }
        >
          <div className="divide-y divide-border">
            <DetailRow
              label="Opfield"
              value={`${updateStatus?.currentVersion} → ${updateStatus?.latestVersion}`}
            />
          </div>
        </PanelShell>
      )}

      {showRelayPanel && (
        <PanelShell
          icon={<RefreshCw className="h-4 w-4 text-warning-text" />}
          id={gatewayUpdateAvailable ? undefined : "system-updates"}
          title={
            <span className="text-warning-text">
              {relayUpdateAvailable
                ? "Relay Pool Update Available"
                : relayRolloutRunning
                  ? "Relay Pool Updating"
                  : "Relay Pool Update"}
            </span>
          }
          description={
            relayUpdateAvailable
              ? "A signed Relay release is ready for a one-instance-at-a-time rollout"
              : relayRolloutRunning
                ? "Relays update one at a time while Opfield stays usable"
                : "A Relay Pool rollout has not finished"
          }
          className={cn(
            "xl:col-span-2",
            !gatewayUpdateAvailable && navigationHighlighted && "navigation-target-ripple"
          )}
          dirty
          actions={
            <>
              {updateStatus?.relay.releaseNotes && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setReleaseNotesSource("relay");
                    setReleaseNotesList(null);
                    setReleaseVersions(null);
                    setReleaseNotesOpen(true);
                  }}
                >
                  Release notes
                </Button>
              )}
              {canUpdate && relayOperationAbandonable && (
                <Button
                  variant="outline"
                  onClick={() => void handleAbandonRelayUpdate()}
                  pending={abandoningRelayUpdate}
                >
                  Abandon update
                </Button>
              )}
              {canUpdate && relayUpdateAvailable && (
                <Button onClick={handleRelayUpdate} variant="warning">
                  Update Relay Pool to {updateStatus?.relay.latestVersion}
                </Button>
              )}
            </>
          }
        >
          <div className="divide-y divide-border">
            {relayUpdateAvailable && (
              <DetailRow
                label="Relay Pool"
                value={`${updateStatus?.relay.currentVersion} → ${updateStatus?.relay.latestVersion}`}
              />
            )}
            {relayOperation && (
              <DetailRow
                label="Rollout"
                value={
                  relayOperation.status === "updating"
                    ? `Updating to ${relayOperation.targetVersion}`
                    : `${relayOperation.runState === "paused" ? "Paused" : "Failed"}: ${
                        relayOperation.error ?? "instance update failed"
                      }`
                }
              />
            )}
          </div>
        </PanelShell>
      )}

      {/* About */}
      <PanelShell
        icon={<ServerCog className="h-4 w-4" />}
        title="About"
        description="Application info and updates"
        actions={
          canUpdate ? (
            <Button onClick={handleCheckUpdate} pending={isChecking}>
              <RefreshCw className="h-4 w-4" />
              Check for updates
            </Button>
          ) : null
        }
      >
        <div className="border-b border-border p-4">
          <div className="flex items-center gap-4">
            <img src="/android-chrome-192x192.png" alt="Opfield" className="h-10 w-10" />
            <div>
              <p className="text-sm font-semibold">Opfield</p>
              <p className="text-xs text-muted-foreground">Infrastructure control plane</p>
            </div>
          </div>
        </div>
        <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
          <DetailRow label="Opfield version" value={updateStatus?.currentVersion ?? "..."} />
          <DetailRow label="Relay version" value={updateStatus?.relay.currentVersion ?? "..."} />
          <DetailRow
            label="Status"
            value={
              anyUpdateAvailable ? (
                <Badge variant="warning">Update available</Badge>
              ) : (
                <Badge variant="success">Up to date</Badge>
              )
            }
          />
        </div>
      </PanelShell>

      {/* Release Notes Dialog */}
      <Dialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Release Notes</DialogTitle>
          </DialogHeader>
          <ReleaseNotesBody
            loading={releaseNotesLoading}
            notesList={releaseNotesList}
            versions={releaseVersions}
            fallbackNotes={activeReleaseNotes}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReleaseNotesBody({
  loading,
  notesList,
  versions,
  fallbackNotes,
}: {
  loading: boolean;
  notesList: string[] | null;
  versions: string[] | null;
  fallbackNotes: string | null | undefined;
}) {
  useContentLoading(loading);
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      {(notesList ?? [fallbackNotes]).filter(Boolean).map((notes, i) => (
        <div key={i}>
          {notesList && notesList.length > 1 && (
            <h3 className="text-base font-semibold mt-0">{versions?.[i]}</h3>
          )}
          <Markdown>{notes ?? ""}</Markdown>
        </div>
      ))}
    </div>
  );
}
