import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { CopyButton } from "@/components/common/CopyButton";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { DownloadButton } from "@/components/common/DownloadButton";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import type { ManagedObjectStorageCaCertificate, ManagedStorageEngine } from "@/types";

interface RevealedStorageCredentials {
  accessKey: string;
  secretKey: string;
}

function CredentialField({
  label,
  value,
  sensitive = false,
  downloadFilename,
}: {
  label: string;
  value: string;
  sensitive?: boolean;
  downloadFilename?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const showValue = !sensitive || revealed;

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <div className="flex border border-input bg-background">
        <Input
          aria-label={label}
          readOnly
          value={value}
          type={showValue ? "text" : "password"}
          className="border-0 bg-transparent font-mono focus-visible:ring-0"
        />
        {sensitive && (
          <Button
            variant="ghost"
            size="icon"
            className="relative shrink-0 rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
            title={revealed ? `Hide ${label}` : `Show ${label}`}
          >
            <Eye
              className={`absolute h-4 w-4 transition-all duration-200 ${revealed ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
            />
            <EyeOff
              className={`absolute h-4 w-4 transition-all duration-200 ${revealed ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
            />
          </Button>
        )}
        {downloadFilename && (
          <DownloadButton value={value} label={label} filename={downloadFilename} />
        )}
        <CopyButton value={value} label={label} className="border-l border-border" />
      </div>
    </div>
  );
}

function profileNameFor(connectionName: string): string {
  const slug = connectionName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "managed-storage";
}

const RCLONE_PROVIDERS: Record<ManagedStorageEngine, string> = {
  minio: "Minio",
  seaweedfs: "SeaweedFS",
};

const MASKED_SECRET = "********";

/** The quick start commands reference the downloaded CA by this name. */
export const STORAGE_CA_FILENAME = "storage-ca.pem";

interface QuickStartInput {
  profile: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  engine: ManagedStorageEngine;
  /** CA file for a TLS endpoint signed by the Gateway Storage CA. */
  caBundle?: string;
}

/** The CA endpoint answers 404/409 while the cluster has TLS off. */
function isTlsOffResponse(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 409);
}

/** AWS CLI profile with path-style addressing — managed storage has no per-bucket DNS. */
export function awsCliQuickStart({
  profile,
  endpoint,
  region,
  accessKey,
  secretKey,
  caBundle,
}: QuickStartInput): string {
  return [
    `aws configure set aws_access_key_id ${accessKey} --profile ${profile}`,
    `aws configure set aws_secret_access_key ${secretKey} --profile ${profile}`,
    `aws configure set region ${region} --profile ${profile}`,
    `aws configure set s3.addressing_style path --profile ${profile}`,
    `aws s3 ls --profile ${profile} --endpoint-url ${endpoint}${caBundle ? ` --ca-bundle ${caBundle}` : ""}`,
  ].join("\n");
}

/** rclone remote; `no_check_bucket` keeps bucket-scoped keys from failing on CreateBucket. */
export function rcloneQuickStart({
  profile,
  endpoint,
  region,
  accessKey,
  secretKey,
  engine,
  caBundle,
}: QuickStartInput): string {
  return [
    `rclone config create ${profile} s3 provider=${RCLONE_PROVIDERS[engine]} access_key_id=${accessKey} secret_access_key=${secretKey} endpoint=${endpoint} region=${region} force_path_style=true no_check_bucket=true`,
    `rclone lsd ${profile}:${caBundle ? ` --ca-cert ${caBundle}` : ""}`,
  ].join("\n");
}

export function StorageCredentialsDialog({
  managedId,
  endpoint,
  region,
  engine = "minio",
  tlsEnabled = false,
  publishedPort,
  connectionName,
  open,
  onOpenChange,
}: {
  managedId: string;
  endpoint: string | null;
  region?: string | null;
  /** Older backends omit the engine; those clusters are MinIO. */
  engine?: ManagedStorageEngine;
  /** Shows the Storage CA and adds it to the quick start. */
  tlsEnabled?: boolean;
  publishedPort: number;
  connectionName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [credentials, setCredentials] = useState<RevealedStorageCredentials | null>(null);
  const [loading, setLoading] = useState(false);
  // Cleared on close, so every opening waits for the revealed credentials.
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ca, setCa] = useState<ManagedObjectStorageCaCertificate | null>(null);
  const [caError, setCaError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      // Clear secrets from state as soon as the dialog closes so a stale
      // reopen can never flash a previous cluster's credentials, and a
      // fresh fetch always runs the next time the dialog is opened.
      setCredentials(null);
      setError(null);
      setCa(null);
      setCaError(null);
      setLoading(false);
      setSettled(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setCaError(null);
    void Promise.allSettled([
      api.revealManagedObjectStorageCredentials(managedId),
      tlsEnabled ? api.getManagedObjectStorageCaCertificate(managedId) : Promise.resolve(null),
    ]).then(([revealed, certificate]) => {
      if (cancelled) return;
      if (revealed.status === "fulfilled") {
        setCredentials(revealed.value);
      } else {
        const message =
          revealed.reason instanceof Error
            ? revealed.reason.message
            : "Failed to reveal credentials";
        setError(message);
        toast.error(message);
      }
      if (certificate.status === "fulfilled") {
        setCa(certificate.value);
      } else {
        setCa(null);
        if (!isTlsOffResponse(certificate.reason)) {
          setCaError(
            certificate.reason instanceof Error
              ? certificate.reason.message
              : "Failed to load the CA certificate"
          );
        }
      }
      setLoading(false);
      setSettled(true);
    });

    return () => {
      cancelled = true;
    };
  }, [open, managedId, tlsEnabled]);

  const resolvedEndpoint = endpoint || `http://<node-host>:${publishedPort}`;
  const quickStart = credentials
    ? {
        profile: profileNameFor(connectionName),
        endpoint: resolvedEndpoint,
        region: region || "us-east-1",
        accessKey: credentials.accessKey,
        secretKey: credentials.secretKey,
        engine,
        caBundle: ca ? STORAGE_CA_FILENAME : undefined,
      }
    : null;
  // The code blocks show the secret masked, like the Secret Key field; copying uses the real one.
  const maskedQuickStart = quickStart ? { ...quickStart, secretKey: MASKED_SECRET } : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Managed Storage Credentials</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ContentLoading loading={open && (loading || !settled)} />
          {open && (loading || !settled) ? null : error ? (
            <Notice tone="destructive" role="alert" title="Credentials could not be loaded">
              {error}
            </Notice>
          ) : credentials ? (
            <>
              {!endpoint && (
                <Notice tone="warning" title="No reachable S3 endpoint">
                  The storage node has no Service Address, so Gateway cannot show an address clients
                  can reach. Add one on the node, or replace &lt;node-host&gt; below with an address
                  that reaches the node.
                </Notice>
              )}
              <CredentialField label="S3 Endpoint" value={resolvedEndpoint} />
              <CredentialField label="Access Key" value={credentials.accessKey} />
              <CredentialField label="Secret Key" value={credentials.secretKey} sensitive />
              {ca && (
                <>
                  <CredentialField label="CA fingerprint (SHA-256)" value={ca.fingerprintSha256} />
                  <CredentialField
                    label="CA certificate"
                    value={ca.certificatePem}
                    downloadFilename={STORAGE_CA_FILENAME}
                  />
                </>
              )}
              {caError && (
                <p className="text-sm text-muted-foreground">
                  The CA certificate could not be loaded: {caError}
                </p>
              )}
              {quickStart && maskedQuickStart && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">Quick Start</p>
                  <CopyCodeBlock
                    label="AWS CLI"
                    value={awsCliQuickStart(maskedQuickStart)}
                    copyValue={awsCliQuickStart(quickStart)}
                    codeClassName="min-h-0 font-mono text-xs"
                  />
                  <CopyCodeBlock
                    label="rclone"
                    value={rcloneQuickStart(maskedQuickStart)}
                    copyValue={rcloneQuickStart(quickStart)}
                    codeClassName="min-h-0 font-mono text-xs"
                  />
                </div>
              )}
            </>
          ) : (
            <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
              Credentials are hidden.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
