import { ArchiveRestore, ArrowLeft, ArrowRight, Loader2, Sparkles, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChoiceCard } from "@/components/common/ChoiceCard";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { Notice } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/progress-bar";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { SetupNetworkFields } from "./SetupNetworkStep";
import { SetupRequestError, setupRequest, setupUploadChunk } from "./setup-request";
import {
  initialRestoreAddress,
  isRestoreAddressValid,
  nextChunkRange,
  percentOf,
  RESTORE_FILE_EXTENSION,
  type RestoreExportSummary,
  restoreAddressChanges,
  restoredLoginUrl,
  restoreWaitOutcome,
  resumeOffsetAfterFailure,
  type SetupRestoreView,
  uploadFingerprint,
  uploadStartOffset,
} from "./setup-restore-model";
import type { NetworkDraft } from "./setup-wizard-model";

const UPLOAD_MARKER_KEY = "gateway:setup-restore-upload";
const RESTORE_URL_KEY = "gateway:setup-restore-public-url";
/** A secret of this browser: after a managed source's restore it fetches the owner's password link, once. */
const OWNER_LINK_CLAIM_KEY = "gateway:setup-restore-owner-link-claim";
const OWNER_LINK_COMMAND = "docker compose exec app node dist/cli/owner-password-link.js";

interface OwnerPasswordLink {
  email: string;
  url: string;
  expiresAt: string;
}

function newOwnerLinkClaim(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
const VERIFY_POLL_MS = 1_000;
const RESTORE_POLL_MS = 3_000;
const CHUNK_ATTEMPTS = 3;

type RestoreStep =
  | "loading"
  | "file"
  | "passphrase"
  | "address"
  | "restoring"
  | "owner-link"
  | "failed";

interface UploadMarker {
  fingerprint: string;
  size: number;
}

function readMarker(): UploadMarker | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(UPLOAD_MARKER_KEY) ?? "null");
    return value && typeof value.fingerprint === "string" && typeof value.size === "number"
      ? value
      : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** "Set up a new installation" or "Restore from an export", shown once the setup code is accepted. */
export function SetupStartChoice({
  onNew,
  onRestore,
}: {
  onNew: () => void;
  onRestore: () => void;
}) {
  return (
    <section className="space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Set up Opfield</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Start a new installation, or move an existing one here from its configuration export.
        </p>
      </div>
      <div className="space-y-2">
        <ChoiceCard
          icon={Sparkles}
          title="Set up a new installation"
          description="Choose the address, sign-in methods and the first administrator."
          trailing={<ArrowRight className="h-4 w-4 text-muted-foreground" />}
          onClick={onNew}
        />
        <ChoiceCard
          icon={ArchiveRestore}
          title="Restore from an export"
          description={`Upload a ${RESTORE_FILE_EXTENSION} file made in Settings of another Opfield.`}
          trailing={<ArrowRight className="h-4 w-4 text-muted-foreground" />}
          onClick={onRestore}
        />
      </div>
    </section>
  );
}

function ExportSummaryPanel({
  summary,
  currentVersion,
}: {
  summary: RestoreExportSummary;
  currentVersion: string;
}) {
  return (
    <PanelShell title="Export" description="Checked with its passphrase">
      <div className="divide-y divide-border">
        <DetailRow label="Made" value={formatDateTime(summary.createdAt)} />
        <DetailRow
          label="Version"
          value={
            summary.gatewayVersion === currentVersion
              ? summary.gatewayVersion
              : `${summary.gatewayVersion} (this host runs ${currentVersion})`
          }
        />
        <DetailRow
          label="From"
          value={<span className="font-mono">{summary.sourcePublicUrl ?? "Unknown"}</span>}
        />
        <DetailRow
          label="Includes"
          value={
            <span className="flex flex-wrap justify-end gap-1.5">
              <Badge variant="secondary">Configuration</Badge>
              {summary.includes.registry ? (
                <Badge variant="secondary">Registry images</Badge>
              ) : null}
              {summary.includes.logs ? <Badge variant="secondary">Logs</Badge> : null}
            </span>
          }
        />
      </div>
    </PanelShell>
  );
}

export function SetupRestoreFlow({
  csrfToken,
  suggestions,
  onBack,
}: {
  csrfToken: string;
  suggestions: { publicIps: string[]; localIps: string[] };
  onBack: () => void;
}) {
  const [step, setStep] = useState<RestoreStep>("loading");
  const [ownerLink, setOwnerLink] = useState<{ link: OwnerPasswordLink; signIn: string } | null>(
    null
  );
  const [view, setView] = useState<SetupRestoreView | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sentBytes, setSentBytes] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [checking, setChecking] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [network, setNetwork] = useState<NetworkDraft>({ grpcPublicTarget: "", grpcLocalIp: "" });
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<{ message: string; reload: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const localIpsRef = useRef(suggestions.localIps);
  localIpsRef.current = suggestions.localIps;

  const loadView = useCallback(() => setupRequest<SetupRestoreView>("/wizard/restore"), []);

  /** The screen a restore view belongs on when the flow opens or starts over. */
  const stepForView = useCallback((next: SetupRestoreView): RestoreStep => {
    if (next.state === "restoring") return "restoring";
    const outcome = restoreWaitOutcome(null, next);
    if (outcome.kind === "failed") {
      setFailure({ message: outcome.message, reload: false });
      return "failed";
    }
    const marker = readMarker();
    if (next.uploadedBytes > 0 && marker && marker.size === next.uploadedBytes) return "passphrase";
    return "file";
  }, []);

  useEffect(() => {
    let active = true;
    void loadView()
      .then((next) => {
        if (!active) return;
        setView(next);
        setPublicUrl(sessionStorage.getItem(RESTORE_URL_KEY) ?? "");
        setStep(stepForView(next));
      })
      .catch((error) => {
        if (!active) return;
        toast.error(errorMessage(error, "Failed to load the restore state"));
        setStep("file");
      });
    return () => {
      active = false;
      uploadAbort.current?.abort();
    };
  }, [loadView, stepForView]);

  const uploadFile = async (chosen: File) => {
    const fingerprint = uploadFingerprint(chosen);
    const marker = readMarker();
    let offset = uploadStartOffset({
      fileSize: chosen.size,
      serverBytes: view?.uploadedBytes ?? 0,
      sameFile: marker?.fingerprint === fingerprint,
    });
    sessionStorage.setItem(
      UPLOAD_MARKER_KEY,
      JSON.stringify({ fingerprint, size: chosen.size } satisfies UploadMarker)
    );
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUploading(true);
    setUploadError(null);
    setSentBytes(offset);
    let failures = 0;
    // Bytes the server confirmed for this file in this run; before that, what it holds may be
    // another file's, so a failed first chunk starts over from 0.
    let confirmed = offset > 0 ? offset : -1;
    try {
      for (
        let range = nextChunkRange(offset, chosen.size);
        range;
        range = nextChunkRange(offset, chosen.size)
      ) {
        const start = range.start;
        try {
          offset = await setupUploadChunk(
            start,
            chosen.slice(start, range.end),
            csrfToken,
            (sent) => setSentBytes(start + sent),
            controller.signal
          );
          failures = 0;
          confirmed = offset;
          setSentBytes(offset);
        } catch (error) {
          if (controller.signal.aborted) return;
          failures += 1;
          if (failures >= CHUNK_ATTEMPTS) throw error;
          // The server says where the file continues (a chunk may have landed in part).
          const current = await loadView().catch(() => null);
          offset = resumeOffsetAfterFailure({
            confirmed,
            serverBytes: current?.uploadedBytes ?? null,
            fileSize: chosen.size,
            chunkStart: start,
          });
          setSentBytes(offset);
          await wait(1_000 * failures);
        }
      }
      if (offset !== chosen.size)
        throw new Error("The server holds a different size than the file");
      const next = await loadView();
      setView(next);
      setPassphrase("");
      setStep("passphrase");
    } catch (error) {
      setUploadError(errorMessage(error, "The upload failed"));
    } finally {
      if (uploadAbort.current === controller) uploadAbort.current = null;
      setUploading(false);
    }
  };

  const discard = async () => {
    uploadAbort.current?.abort();
    try {
      const next = await setupRequest<SetupRestoreView>(
        "/wizard/restore",
        "DELETE",
        undefined,
        csrfToken
      );
      setView(next);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to remove the uploaded file"));
      return;
    }
    sessionStorage.removeItem(UPLOAD_MARKER_KEY);
    setFile(null);
    setSentBytes(0);
    setUploadError(null);
    setPassphrase("");
    setStep("file");
  };

  const checkExport = async () => {
    setChecking(true);
    try {
      setView(
        await setupRequest<SetupRestoreView>(
          "/wizard/restore/verify",
          "POST",
          { passphrase },
          csrfToken
        )
      );
    } catch (error) {
      toast.error(errorMessage(error, "Failed to check the export"));
      setChecking(false);
    }
  };

  // The check runs in the background: follow it until it settles.
  useEffect(() => {
    if (!checking) return;
    let active = true;
    const timer = window.setInterval(() => {
      void loadView()
        .then((next) => {
          if (!active) return;
          setView(next);
          if (next.state === "verifying") return;
          setChecking(false);
          if (next.state === "verified" && next.summary) {
            const initial = initialRestoreAddress(next.summary, localIpsRef.current);
            setPublicUrl(initial.publicUrl);
            setNetwork(initial.network);
            setStep("address");
          }
        })
        .catch(() => {});
    }, VERIFY_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [checking, loadView]);

  const startRestore = async () => {
    const ok = await confirm({
      title: "Restore this export",
      description:
        "Opfield stops, replaces its data with the export and starts again. This takes a few minutes; this page follows it and opens sign-in at the restored address.",
      confirmLabel: "Restore",
      variant: "default",
    });
    if (!ok) return;
    setStarting(true);
    try {
      const ownerLinkClaim = newOwnerLinkClaim();
      sessionStorage.setItem(OWNER_LINK_CLAIM_KEY, ownerLinkClaim);
      const next = await setupRequest<SetupRestoreView>(
        "/wizard/restore/start",
        "POST",
        {
          passphrase,
          publicUrl: publicUrl.trim(),
          grpcPublicTarget: network.grpcPublicTarget.trim(),
          grpcLocalIp: network.grpcLocalIp.trim(),
          ownerLinkClaim,
        },
        csrfToken
      );
      sessionStorage.setItem(RESTORE_URL_KEY, publicUrl.trim());
      setPassphrase("");
      setView(next);
      setStep("restoring");
    } catch (error) {
      toast.error(errorMessage(error, "Failed to start the restore"));
    } finally {
      setStarting(false);
    }
  };

  // The app stops and comes back during the restore: poll until it answers as set up or failed.
  useEffect(() => {
    if (step !== "restoring") return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const status = await setupRequest<{ state: "pending" | "complete"; publicUrl?: string }>(
          "/status"
        ).catch(() => null);
        let next: SetupRestoreView | null = null;
        let sessionLost = false;
        if (status?.state === "pending") {
          next = await loadView().catch((error) => {
            sessionLost = error instanceof SetupRequestError && error.status === 401;
            return null;
          });
        }
        if (!active) return;
        if (next) setView(next);
        const outcome = restoreWaitOutcome(status?.state ?? null, next);
        if (outcome.kind === "done") {
          const target = sessionStorage.getItem(RESTORE_URL_KEY) || status?.publicUrl || "";
          const signIn = target ? restoredLoginUrl(target) : "/login";
          // An export of an Opfield Cloud installation: the owner sets a password with a one-time link first.
          const claim = sessionStorage.getItem(OWNER_LINK_CLAIM_KEY);
          const link = claim
            ? await setupRequest<OwnerPasswordLink>("/restore/owner-link", "POST", { claim }).catch(
                () => null
              )
            : null;
          if (!active) return;
          sessionStorage.removeItem(RESTORE_URL_KEY);
          sessionStorage.removeItem(UPLOAD_MARKER_KEY);
          sessionStorage.removeItem(OWNER_LINK_CLAIM_KEY);
          if (link) {
            setOwnerLink({ link, signIn });
            setStep("owner-link");
            return;
          }
          window.location.assign(signIn);
          return;
        }
        if (outcome.kind === "failed") {
          setFailure({ message: outcome.message, reload: false });
          setStep("failed");
        } else if (sessionLost) {
          setFailure({
            message:
              "Opfield is back but the restore did not finish. Enter the setup code again to see why.",
            reload: true,
          });
          setStep("failed");
        }
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), RESTORE_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadView, step]);

  const tryAgain = async () => {
    if (failure?.reload) {
      window.location.reload();
      return;
    }
    try {
      const next = await loadView();
      setView(next);
      setFailure(null);
      const marker = readMarker();
      setStep(
        next.uploadedBytes > 0 && marker && marker.size === next.uploadedBytes
          ? "passphrase"
          : "file"
      );
    } catch {
      window.location.reload();
    }
  };

  if (step === "loading") {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (step === "owner-link" && ownerLink) {
    return (
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Opfield is restored</h2>
        <p className="text-sm text-muted-foreground">
          The export came from an Opfield Cloud installation, so sign-in with the Opfield account is
          off here and password sign-in is on. Set the password of the owner, {ownerLink.link.email}
          , with this one-time link (valid until {formatDateTime(ownerLink.link.expiresAt)}), then
          sign in.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <a href={ownerLink.link.url}>Set the owner's password</a>
          </Button>
          <Button variant="outline" asChild>
            <a href={ownerLink.signIn}>Go to sign-in</a>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          For a new link, run on the host:{" "}
          <code className="font-mono text-xs">{OWNER_LINK_COMMAND}</code>
        </p>
      </section>
    );
  }

  if (step === "restoring") {
    return (
      <section className="space-y-3 text-center">
        <h2 className="flex items-center justify-center gap-2 text-lg font-semibold">
          <Loader2 className="h-5 w-5 animate-spin" /> Restoring Opfield
        </h2>
        <p className="text-sm text-muted-foreground">
          {view?.restore?.step ?? "Starting the restore"}
        </p>
        <p className="text-sm text-muted-foreground">
          Opfield restarts on the way, so this page may lose it for a few minutes. Sign-in opens at
          the restored address when it is done.
        </p>
        <p className="text-sm text-muted-foreground">
          An export of an Opfield Cloud installation comes back with password sign-in; this page
          then shows the owner's one-time password link. If it does not, run on the host:{" "}
          <code className="font-mono text-xs">{OWNER_LINK_COMMAND}</code>
        </p>
      </section>
    );
  }

  if (step === "failed") {
    return (
      <section className="space-y-3">
        <Notice tone="destructive" title="The restore did not finish">
          {failure?.message ?? "The restore failed."}
        </Notice>
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button onClick={() => void tryAgain()}>Try again</Button>
        </div>
      </section>
    );
  }

  if (step === "file") {
    const total = file?.size ?? 0;
    const partial = !file && (view?.uploadedBytes ?? 0) > 0;
    return (
      <section className="space-y-3">
        <div className="text-center">
          <h2 className="text-lg font-semibold">Restore from an export</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the {RESTORE_FILE_EXTENSION} file. It is checked with its passphrase before
            anything changes.
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={RESTORE_FILE_EXTENSION}
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setFile(chosen);
            setUploadError(null);
            setSentBytes(0);
          }}
        />
        <PanelShell
          title="Export file"
          description="Uploaded in parts; an interrupted upload resumes"
        >
          <SettingsControlRow
            title={file ? file.name : "No file chosen"}
            description={
              file
                ? formatBytes(file.size)
                : partial
                  ? `${formatBytes(view?.uploadedBytes ?? 0)} of an earlier upload is here. Choose the same file to continue it.`
                  : "The file stays on this host only for the restore."
            }
          >
            <Button
              type="button"
              variant="outline"
              disabled={uploading}
              onClick={() => {
                if (!fileInputRef.current) return;
                fileInputRef.current.value = "";
                fileInputRef.current.click();
              }}
            >
              <Upload className="h-4 w-4" />
              {file ? "Replace" : "Choose file"}
            </Button>
          </SettingsControlRow>
          {file && (uploading || sentBytes > 0) ? (
            <div className="space-y-1.5 px-4 py-3">
              <div className="flex justify-between gap-3 text-sm text-muted-foreground">
                <span>{uploading ? "Uploading" : "Uploaded"}</span>
                <span>
                  {formatBytes(sentBytes)} of {formatBytes(total)}
                </span>
              </div>
              <ProgressBar value={percentOf(sentBytes, total)} aria-label="Upload progress" />
            </div>
          ) : null}
        </PanelShell>
        {uploadError ? (
          <Notice tone="destructive" title="The upload stopped">
            {uploadError}
          </Notice>
        ) : null}
        <div className="flex justify-center gap-2">
          <Button type="button" variant="outline" onClick={onBack} disabled={uploading}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          {partial ? (
            <Button type="button" variant="outline" onClick={() => void discard()}>
              Remove upload
            </Button>
          ) : null}
          <Button
            type="button"
            pending={uploading}
            disabled={!file || file.size === 0}
            onClick={() => file && void uploadFile(file)}
          >
            {uploadError ? "Resume upload" : "Upload"}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </section>
    );
  }

  if (step === "passphrase") {
    const verifying = checking || view?.state === "verifying";
    const invalid = !verifying && view?.state === "invalid" ? view.error : null;
    return (
      <section className="space-y-3">
        <div className="text-center">
          <h2 className="text-lg font-semibold">Export passphrase</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter the passphrase chosen when the export was made. The whole file is decrypted and
            checked.
          </p>
        </div>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (passphrase && !verifying) void checkExport();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label="Export passphrase"
            placeholder="Passphrase"
            value={passphrase}
            disabled={verifying}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          {verifying ? (
            <div className="space-y-1.5">
              <div className="flex justify-between gap-3 text-sm text-muted-foreground">
                <span>Checking the export</span>
                <span>
                  {formatBytes(view?.verifiedBytes ?? 0)} of {formatBytes(view?.uploadedBytes ?? 0)}
                </span>
              </div>
              <ProgressBar
                value={percentOf(view?.verifiedBytes ?? 0, view?.uploadedBytes ?? 0)}
                aria-label="Check progress"
              />
            </div>
          ) : null}
          {invalid ? (
            <Notice tone="destructive" title="The export cannot be restored">
              {invalid.message}
            </Notice>
          ) : null}
          <div className="flex justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={verifying}
              onClick={() => void discard()}
            >
              Choose another file
            </Button>
            <Button type="submit" pending={verifying} disabled={!passphrase}>
              Check export
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </section>
    );
  }

  // step === "address"
  const summary = view?.summary;
  if (!summary) return null;
  const changes = restoreAddressChanges(summary, publicUrl, network);
  const canRestore = isRestoreAddressValid(publicUrl, network) && Boolean(passphrase);
  return (
    <section className="space-y-3">
      <ExportSummaryPanel summary={summary} currentVersion={view.currentVersion} />
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canRestore) void startRestore();
        }}
      >
        <PanelShell title="Address" description="Where people and nodes reach this installation">
          <SettingsControlRow
            title="Public URL"
            description="The address people and identity providers use."
          >
            <Input
              type="url"
              required
              aria-label="Public URL"
              value={publicUrl}
              placeholder="https://opfield.example.com"
              disabled={starting}
              className="font-mono text-xs"
              onChange={(event) => setPublicUrl(event.target.value)}
            />
          </SettingsControlRow>
          <SetupNetworkFields
            busy={starting}
            network={network}
            publicUrl={publicUrl}
            suggestions={suggestions}
            setNetwork={setNetwork}
          />
        </PanelShell>
        {changes.publicUrl || changes.grpcPublicTarget ? (
          <Notice tone="warning" title="The address differs from the export">
            {changes.grpcPublicTarget
              ? `Nodes connect to ${summary.sourceGrpcPublicTarget}. They move here on their own if the old installation announced this address under Settings > General; otherwise point the old address here or set gateway.address on each node.`
              : "Update DNS, the identity provider callback and links that use the old address."}
          </Notice>
        ) : null}
        <div className="flex justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={starting}
            onClick={() => {
              setPassphrase("");
              setStep("passphrase");
            }}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button type="submit" pending={starting} disabled={!canRestore}>
            <ArchiveRestore className="h-4 w-4" />
            Restore
          </Button>
        </div>
      </form>
    </section>
  );
}
