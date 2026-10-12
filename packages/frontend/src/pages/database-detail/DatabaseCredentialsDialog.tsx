import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { ContentLoading } from "@/components/common/ContentLoading";
import { CopyButton } from "@/components/common/CopyButton";
import { DownloadButton } from "@/components/common/DownloadButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { DatabaseConnection } from "@/types";

type RevealedCredentials = Record<string, unknown>;

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function managedConnectionUri(
  database: DatabaseConnection,
  credentials: RevealedCredentials
): string | null {
  const host = database.managed?.endpointHost;
  const port = database.managed?.publishedPort;
  const username = stringValue(credentials.username) ?? database.username;
  const password = stringValue(credentials.password);
  if (!host || port == null || !username || !password) return null;

  if (database.type === "postgres") {
    const target = stringValue(credentials.databaseName) ?? database.databaseName ?? "";
    return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(target)}${database.managed?.tlsEnabled ? "?sslmode=verify-full" : ""}`;
  }
  if (database.type === "clickhouse") {
    const target = stringValue(credentials.databaseName) ?? database.databaseName ?? "";
    return `${database.managed?.tlsEnabled ? "https" : "http"}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/?database=${encodeURIComponent(target)}`;
  }
  const db = stringValue(credentials.database) ?? "0";
  return `${database.managed?.tlsEnabled ? "rediss" : "redis"}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db)}`;
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

export function DatabaseCredentialsDialog({
  database,
  credentials,
  loading,
  open,
  onOpenChange,
}: {
  database: DatabaseConnection;
  credentials: RevealedCredentials | null;
  loading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const managed = database.managed;
  const connectionUri = credentials
    ? (stringValue(credentials.connectionString) ??
      (managed ? managedConnectionUri(database, credentials) : null))
    : null;
  const host = managed ? managed.endpointHost : (stringValue(credentials?.host) ?? database.host);
  const port = managed
    ? managed.publishedPort == null
      ? null
      : String(managed.publishedPort)
    : (stringValue(credentials?.port) ?? String(database.port));
  const target =
    stringValue(credentials?.databaseName) ??
    stringValue(credentials?.database) ??
    database.databaseName ??
    null;
  const username = stringValue(credentials?.username) ?? database.username;
  const password = stringValue(credentials?.password);
  const caCertificate = stringValue(credentials?.caCertificate);
  const caFingerprint = stringValue(credentials?.caFingerprint);
  const caFilename = `${database.name.trim().replace(/[<>:"/\\|?*]/g, "-") || "database"}-ca.pem`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{managed ? "Direct-Access Credentials" : "Stored Credentials"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ContentLoading loading={loading} />
          {loading ? null : credentials ? (
            <>
              {connectionUri && <CredentialField label="Connection URI" value={connectionUri} />}
              {host && <CredentialField label="Host" value={host} />}
              {port && <CredentialField label="Port" value={port} />}
              {target && <CredentialField label="Database" value={target} />}
              {username && <CredentialField label="Username" value={username} />}
              {password && <CredentialField label="Password" value={password} sensitive />}
              {database.type === "clickhouse" && managed?.publishedNativePort != null && (
                <CredentialField
                  label="Native TCP Port"
                  value={String(managed.publishedNativePort)}
                />
              )}
              {caFingerprint && (
                <CredentialField label="CA fingerprint (SHA-256)" value={caFingerprint} />
              )}
              {caCertificate && (
                <CredentialField
                  label="CA certificate"
                  value={caCertificate}
                  downloadFilename={caFilename}
                />
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
