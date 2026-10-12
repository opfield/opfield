import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";
import { Notice } from "@/components/common/Notice";
import { SwitchCard } from "@/components/common/SwitchCard";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DATABASE_TYPE_LABELS, KEY_VALUE_TYPE_DESCRIPTION } from "@/lib/database-type";
import type {
  ClickHouseDatabaseConfig,
  DatabaseConnection,
  DatabaseType,
  PostgresDatabaseConfig,
  RedisDatabaseConfig,
} from "@/types";

const CONNECTION_FIELDS_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export interface DatabaseConnectionDraft {
  name: string;
  description: string;
  tags: string;
  manualSizeLimitMb: string;
  interactiveQueryBudgetSeconds: string;
  type: DatabaseType;
  connectionMethod: "credentials" | "uri";
  connectionString: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslEnabled: boolean;
  db: string;
  tlsEnabled: boolean;
  tlsVerifyCertificate: boolean;
  tlsCaCertificate: string;
  hasStoredPassword?: boolean;
  /** Saved verification state of an existing connection. */
  savedTlsVerifyCertificate?: boolean;
  savedTlsCaCertificate?: string;
}

/** Whether the connection being edited negotiates TLS, from its fields or its URI. */
export function draftUsesTls(draft: DatabaseConnectionDraft) {
  if (draft.connectionMethod === "uri") {
    try {
      const url = new URL(draft.connectionString.trim());
      if (draft.type === "postgres") {
        return ["require", "verify-ca", "verify-full"].includes(
          url.searchParams.get("sslmode") ?? ""
        );
      }
      return url.protocol === (draft.type === "clickhouse" ? "https:" : "rediss:");
    } catch {
      return false;
    }
  }
  return draft.type === "postgres" ? draft.sslEnabled : draft.tlsEnabled;
}

/**
 * Turning verification off, or trusting a different CA, on a verified
 * connection could send the saved password to an unverified server. The
 * backend requires the password again for that change.
 */
export function tlsVerificationWeakened(draft: DatabaseConnectionDraft) {
  if (!draft.hasStoredPassword || draft.savedTlsVerifyCertificate !== true) return false;
  if (!draftUsesTls(draft)) return false;
  if (!draft.tlsVerifyCertificate) return true;
  const ca = draft.tlsCaCertificate.trim();
  return ca !== "" && ca !== (draft.savedTlsCaCertificate ?? "").trim();
}

function tlsVerificationPayload(draft: DatabaseConnectionDraft) {
  return {
    tlsVerifyCertificate: draft.tlsVerifyCertificate,
    tlsCaCertificate: draft.tlsCaCertificate.trim() || null,
  };
}

function isValidPort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function hasValidConnectionUri(type: DatabaseType, value: string) {
  try {
    const url = new URL(value.trim());
    if (!url.hostname || !url.username || !url.password) return false;
    if (type === "postgres") {
      return (
        ["postgres:", "postgresql:"].includes(url.protocol) &&
        decodeURIComponent(url.pathname.replace(/^\//, "")).trim().length > 0
      );
    }
    if (type === "clickhouse") {
      return (
        ["http:", "https:"].includes(url.protocol) &&
        (url.searchParams.get("database")?.trim().length ?? 0) > 0
      );
    }
    const db = Number(url.pathname.replace(/^\//, "") || "0");
    return (
      ["redis:", "rediss:"].includes(url.protocol) && Number.isInteger(db) && db >= 0 && db <= 15
    );
  } catch {
    return false;
  }
}

export function canCreateDatabase(draft: DatabaseConnectionDraft) {
  if (!draft.name.trim()) return false;
  if (draft.connectionMethod === "uri") {
    return hasValidConnectionUri(draft.type, draft.connectionString);
  }
  if (!draft.host.trim() || !isValidPort(draft.port) || draft.password.length === 0) return false;
  if (draft.type === "redis") {
    const db = Number(draft.db);
    return Number.isInteger(db) && db >= 0 && db <= 15;
  }
  return Boolean(draft.database.trim() && draft.username.trim());
}

export function draftFromConnection(
  connection?: DatabaseConnection | null
): DatabaseConnectionDraft {
  if (!connection) {
    return {
      name: "",
      description: "",
      tags: "",
      manualSizeLimitMb: "",
      interactiveQueryBudgetSeconds: "300",
      type: "postgres",
      connectionMethod: "credentials",
      connectionString: "",
      host: "",
      port: "5432",
      database: "",
      username: "",
      password: "",
      sslEnabled: false,
      db: "0",
      tlsEnabled: false,
      tlsVerifyCertificate: true,
      tlsCaCertificate: "",
      hasStoredPassword: false,
    };
  }

  const tlsVerification = {
    tlsVerifyCertificate: connection.tlsVerifyCertificate ?? true,
    tlsCaCertificate: connection.tlsCaCertificate ?? "",
    savedTlsVerifyCertificate: connection.tlsVerifyCertificate ?? true,
    savedTlsCaCertificate: connection.tlsCaCertificate ?? "",
  };

  if (connection.type === "postgres") {
    const config = connection.config as PostgresDatabaseConfig;
    return {
      name: connection.name,
      description: connection.description ?? "",
      tags: connection.tags.join(", "),
      manualSizeLimitMb:
        connection.manualSizeLimitMb != null ? String(connection.manualSizeLimitMb) : "",
      interactiveQueryBudgetSeconds: String(connection.interactiveQueryBudgetSeconds ?? 300),
      type: "postgres",
      connectionMethod: "credentials",
      connectionString: "",
      host: config.host,
      port: String(config.port),
      database: config.database,
      username: config.username,
      password: "",
      sslEnabled: config.sslEnabled,
      db: "0",
      tlsEnabled: false,
      ...tlsVerification,
      hasStoredPassword: connection.hasStoredPassword,
    };
  }

  if (connection.type === "clickhouse") {
    const config = connection.config as ClickHouseDatabaseConfig;
    return {
      name: connection.name,
      description: connection.description ?? "",
      tags: connection.tags.join(", "),
      manualSizeLimitMb: "",
      interactiveQueryBudgetSeconds: String(connection.interactiveQueryBudgetSeconds ?? 300),
      type: "clickhouse",
      connectionMethod: "credentials",
      connectionString: "",
      host: config.host,
      port: String(config.port),
      database: config.database,
      username: config.username,
      password: "",
      sslEnabled: false,
      db: "0",
      tlsEnabled: config.tlsEnabled,
      ...tlsVerification,
      hasStoredPassword: connection.hasStoredPassword,
    };
  }

  const config = connection.config as RedisDatabaseConfig;
  return {
    name: connection.name,
    description: connection.description ?? "",
    tags: connection.tags.join(", "),
    manualSizeLimitMb: "",
    interactiveQueryBudgetSeconds: "300",
    type: "redis",
    connectionMethod: "credentials",
    connectionString: "",
    host: config.host,
    port: String(config.port),
    database: "",
    username: config.username ?? "",
    password: "",
    sslEnabled: false,
    db: String(config.db),
    tlsEnabled: config.tlsEnabled,
    ...tlsVerification,
    hasStoredPassword: connection.hasStoredPassword,
  };
}

export function buildDatabasePayload(draft: DatabaseConnectionDraft): Record<string, unknown> {
  const tags = draft.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (draft.type === "postgres") {
    return {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      tags,
      manualSizeLimitMb:
        draft.manualSizeLimitMb.trim() === "" ? null : Number(draft.manualSizeLimitMb),
      interactiveQueryBudgetSeconds: Number(draft.interactiveQueryBudgetSeconds),
      type: "postgres",
      config: {
        ...(draft.connectionMethod === "uri"
          ? { connectionString: draft.connectionString.trim() }
          : {
              ...(draft.host.trim() ? { host: draft.host.trim() } : {}),
              ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
              ...(draft.database.trim() ? { database: draft.database.trim() } : {}),
              ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
              ...(draft.password !== "" ? { password: draft.password } : {}),
              sslEnabled: draft.sslEnabled,
            }),
        ...tlsVerificationPayload(draft),
      },
    };
  }

  if (draft.type === "clickhouse") {
    return {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      tags,
      type: "clickhouse",
      interactiveQueryBudgetSeconds: Number(draft.interactiveQueryBudgetSeconds),
      config: {
        ...(draft.connectionMethod === "uri"
          ? { connectionString: draft.connectionString.trim() }
          : {
              ...(draft.host.trim() ? { host: draft.host.trim() } : {}),
              ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
              ...(draft.database.trim() ? { database: draft.database.trim() } : {}),
              ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
              ...(draft.password !== "" ? { password: draft.password } : {}),
              tlsEnabled: draft.tlsEnabled,
            }),
        ...tlsVerificationPayload(draft),
      },
    };
  }

  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    tags,
    type: "redis",
    config: {
      ...(draft.connectionMethod === "uri"
        ? { connectionString: draft.connectionString.trim() }
        : {
            ...(draft.host.trim() ? { host: draft.host.trim() } : {}),
            ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
            ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
            ...(draft.password !== "" ? { password: draft.password } : {}),
            db: Number(draft.db || "0"),
            tlsEnabled: draft.tlsEnabled,
          }),
      ...tlsVerificationPayload(draft),
    },
  };
}

export function DatabaseConnectionForm({
  draft,
  onChange,
  disableType = false,
  mode = "full",
  folderField,
}: {
  draft: DatabaseConnectionDraft;
  onChange: (next: DatabaseConnectionDraft) => void;
  disableType?: boolean;
  mode?: "full" | "metadata";
  /** The create dialog's Folder field: shares a row with the connection method. */
  folderField?: ReactNode;
}) {
  const set = <K extends keyof DatabaseConnectionDraft>(
    key: K,
    value: DatabaseConnectionDraft[K]
  ) => onChange({ ...draft, [key]: value });
  const metadataOnly = mode === "metadata";

  return (
    <div className="space-y-3">
      <div className={`grid gap-3 ${metadataOnly ? "md:grid-cols-1" : "md:grid-cols-2"}`}>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Name</label>
          <Input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={
              draft.type === "postgres"
                ? "Primary Postgres"
                : draft.type === "clickhouse"
                  ? "Analytics ClickHouse"
                  : "Application cache"
            }
          />
        </div>
        {!metadataOnly && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Type</label>
            <Select
              value={draft.type}
              onValueChange={(value) =>
                onChange({
                  ...draft,
                  type: value as DatabaseType,
                  port: value === "postgres" ? "5432" : value === "clickhouse" ? "8123" : "6379",
                  connectionString: "",
                  host: "",
                  database: "",
                  username: "",
                  password: "",
                  db: "0",
                  manualSizeLimitMb: value === "postgres" ? draft.manualSizeLimitMb : "",
                  sslEnabled: false,
                  tlsEnabled: false,
                  tlsVerifyCertificate: true,
                  tlsCaCertificate: "",
                })
              }
              disabled={disableType}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="postgres">Postgres</SelectItem>
                <SelectItem value="clickhouse">ClickHouse</SelectItem>
                <SelectItem value="redis" description={KEY_VALUE_TYPE_DESCRIPTION}>
                  {DATABASE_TYPE_LABELS.redis}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <label className="text-sm font-medium">Description</label>
            <Input
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Optional description"
            />
          </div>
          <div className="min-w-0 space-y-1.5">
            <label className="text-sm font-medium">Tags</label>
            <Input
              placeholder="team, red:production, green:analytics"
              value={draft.tags}
              onChange={(e) => set("tags", e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Use color:name for colored tags. Supported colors: blue, red, green, yellow, purple, pink,
          orange, gray.
        </p>
      </div>

      {metadataOnly && draft.type !== "redis" && (
        <div className={`grid gap-3 ${draft.type === "postgres" ? "md:grid-cols-2" : ""}`}>
          {draft.type === "postgres" && (
            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium">Size Limit (MB)</label>
              <Input
                type="number"
                min="1"
                step="1"
                placeholder="Optional"
                value={draft.manualSizeLimitMb}
                onChange={(e) => set("manualSizeLimitMb", e.target.value)}
              />
            </div>
          )}
          <div className="min-w-0 space-y-1.5">
            <label htmlFor="database-interactive-query-budget" className="text-sm font-medium">
              Interactive query budget
            </label>
            <Input
              id="database-interactive-query-budget"
              type="number"
              min="30"
              max="600"
              step="1"
              value={draft.interactiveQueryBudgetSeconds}
              onChange={(event) => set("interactiveQueryBudgetSeconds", event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Total execution budget for one SQL Console run, shared dynamically between statements
              (30–600 seconds).
            </p>
          </div>
        </div>
      )}

      {!metadataOnly && (
        <>
          <div className={`grid gap-3 ${folderField ? "md:grid-cols-2" : ""}`}>
            {folderField}
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="database-connection-method" className="text-sm font-medium">
                Connection method
              </label>
              <Select
                value={draft.connectionMethod}
                onValueChange={(value) =>
                  set("connectionMethod", value as DatabaseConnectionDraft["connectionMethod"])
                }
              >
                <SelectTrigger id="database-connection-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="credentials">Credentials</SelectItem>
                  <SelectItem value="uri">Connection URI</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="relative overflow-hidden">
            <AnimatePresence initial={false} mode="popLayout">
              {draft.connectionMethod === "uri" ? (
                <motion.div
                  key={`uri-${draft.type}`}
                  {...CONNECTION_FIELDS_ANIMATION}
                  className="space-y-1.5 overflow-hidden"
                >
                  <label htmlFor="database-connection-uri" className="text-sm font-medium">
                    Connection URI
                  </label>
                  <Input
                    id="database-connection-uri"
                    placeholder={
                      draft.type === "postgres"
                        ? "postgresql://user:password@host:5432/database"
                        : draft.type === "clickhouse"
                          ? "https://user:password@clickhouse.example.com:8443?database=analytics"
                          : "redis://:password@host:6379/0"
                    }
                    value={draft.connectionString}
                    onChange={(e) => set("connectionString", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Include credentials and the TLS scheme in the URI.
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key={`credentials-${draft.type}`}
                  {...CONNECTION_FIELDS_ANIMATION}
                  className="space-y-3 overflow-hidden"
                >
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px]">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Host</label>
                      <Input
                        value={draft.host}
                        onChange={(e) => set("host", e.target.value)}
                        placeholder={
                          draft.type === "postgres"
                            ? "db.example.com"
                            : draft.type === "clickhouse"
                              ? "clickhouse.example.com"
                              : "redis.example.com"
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Port</label>
                      <Input value={draft.port} onChange={(e) => set("port", e.target.value)} />
                    </div>
                  </div>

                  {draft.type !== "redis" ? (
                    <>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Database</label>
                          <Input
                            value={draft.database}
                            onChange={(e) => set("database", e.target.value)}
                            placeholder={draft.type === "postgres" ? "app" : "analytics"}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Username</label>
                          <Input
                            value={draft.username}
                            onChange={(e) => set("username", e.target.value)}
                            placeholder={draft.type === "postgres" ? "gateway" : "default"}
                          />
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2 md:items-center">
                        <div className="min-w-0 space-y-1.5">
                          <label className="text-sm font-medium">Password</label>
                          <Input
                            type="password"
                            placeholder={
                              draft.hasStoredPassword
                                ? "Leave blank to keep current password"
                                : "Enter password"
                            }
                            value={draft.password}
                            onChange={(e) => set("password", e.target.value)}
                          />
                          {draft.hasStoredPassword && draft.password === "" && (
                            <Badge variant="secondary">Existing password preserved</Badge>
                          )}
                        </div>

                        <SwitchCard
                          label="TLS / SSL"
                          description={
                            draft.type === "postgres"
                              ? "Require TLS for the Postgres connection"
                              : "Use HTTPS for the ClickHouse connection"
                          }
                          checked={draft.type === "postgres" ? draft.sslEnabled : draft.tlsEnabled}
                          onCheckedChange={(checked) =>
                            draft.type === "postgres"
                              ? set("sslEnabled", checked)
                              : set("tlsEnabled", checked)
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px]">
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Username</label>
                          <Input
                            value={draft.username}
                            onChange={(e) => set("username", e.target.value)}
                            placeholder="default (optional)"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Logical database</label>
                          <Input
                            value={draft.db}
                            onChange={(e) => set("db", e.target.value)}
                            placeholder="0"
                          />
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2 md:items-center">
                        <div className="min-w-0 space-y-1.5">
                          <label className="text-sm font-medium">Password</label>
                          <Input
                            type="password"
                            placeholder={
                              draft.hasStoredPassword
                                ? "Leave blank to keep current password"
                                : "Enter password"
                            }
                            value={draft.password}
                            onChange={(e) => set("password", e.target.value)}
                          />
                          {draft.hasStoredPassword && draft.password === "" && (
                            <Badge variant="secondary">Existing password preserved</Badge>
                          )}
                        </div>

                        <SwitchCard
                          label="TLS"
                          description="Use TLS when connecting to the server"
                          checked={draft.tlsEnabled}
                          onCheckedChange={(checked) => set("tlsEnabled", checked)}
                        />
                      </div>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </>
      )}

      {draftUsesTls(draft) && (
        <DatabaseTlsVerificationFields
          draft={draft}
          onChange={onChange}
          confirmPassword={metadataOnly}
        />
      )}
    </div>
  );
}

function DatabaseTlsVerificationFields({
  draft,
  onChange,
  confirmPassword,
}: {
  draft: DatabaseConnectionDraft;
  onChange: (next: DatabaseConnectionDraft) => void;
  confirmPassword: boolean;
}) {
  const set = <K extends keyof DatabaseConnectionDraft>(
    key: K,
    value: DatabaseConnectionDraft[K]
  ) => onChange({ ...draft, [key]: value });

  return (
    <div className="space-y-3">
      <SwitchCard
        label="Verify server certificate"
        description="Check the certificate chain and that it was issued for this host"
        checked={draft.tlsVerifyCertificate}
        onCheckedChange={(checked) => set("tlsVerifyCertificate", checked)}
      />

      {draft.tlsVerifyCertificate ? (
        <div className="space-y-1.5">
          <label htmlFor="database-tls-ca-certificate" className="text-sm font-medium">
            CA certificate
          </label>
          <Textarea
            id="database-tls-ca-certificate"
            rows={4}
            className="font-mono text-xs"
            placeholder="-----BEGIN CERTIFICATE-----"
            value={draft.tlsCaCertificate}
            onChange={(event) => set("tlsCaCertificate", event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Optional. PEM certificates of a private CA, trusted instead of the public CA bundle.
          </p>
        </div>
      ) : (
        <Notice tone="warning" title="The server identity is not checked">
          Traffic is encrypted, but anyone on the network path can impersonate this database and
          capture its credentials.
        </Notice>
      )}

      {confirmPassword && tlsVerificationWeakened(draft) && (
        <div className="space-y-1.5">
          <label htmlFor="database-tls-password-confirmation" className="text-sm font-medium">
            Database password
          </label>
          <Input
            id="database-tls-password-confirmation"
            type="password"
            placeholder="Re-enter the password to confirm this change"
            value={draft.password}
            onChange={(event) => set("password", event.target.value)}
          />
        </div>
      )}
    </div>
  );
}
