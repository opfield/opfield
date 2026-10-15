import type { Dispatch, SetStateAction } from "react";
import { CodeEditor } from "@/components/ui/code-editor";
import { envTextErrorLines, parseEnvText } from "../docker-detail/EnvTextDialog";
import { type SecretRow, SecretsSection } from "../docker-detail/SecretsSection";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Secrets typed here are new: no stored secret is ever deleted from this step.
const NO_DELETED_SECRETS: Dispatch<SetStateAction<Map<string, string>>> = () => undefined;

/** `NAME=value` lines as a record (the step blocks invalid or repeated names). */
export function deployEnvironmentRecord(text: string): Record<string, string> {
  return Object.fromEntries(parseEnvText(text).map(({ key, value }) => [key, value]));
}

/** The secret rows as a record; rows left empty are skipped. */
export function deploySecretsRecord(rows: SecretRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value])
  );
}

/**
 * What blocks the step: env lines that are invalid, repeated or name a secret, and secret rows whose name is
 * missing (with a value), invalid, repeated or also a variable.
 */
export function deployEnvironmentErrors(envText: string, secretRows: SecretRow[]) {
  const secretNames = secretRows.map((row) => row.key.trim());
  const envNames = new Set(Object.keys(deployEnvironmentRecord(envText)));
  const envLines = new Set(envTextErrorLines(envText));
  envText.split("\n").forEach((line, index) => {
    const separator = line.indexOf("=");
    if (separator > 0 && secretNames.includes(line.slice(0, separator))) envLines.add(index + 1);
  });
  const secretRowErrors = new Set<number>();
  secretRows.forEach((row, index) => {
    const name = row.key.trim();
    if (!name) {
      if (row.value) secretRowErrors.add(index);
      return;
    }
    if (
      !VARIABLE_NAME.test(name) ||
      envNames.has(name) ||
      secretNames.indexOf(name) !== secretNames.lastIndexOf(name)
    ) {
      secretRowErrors.add(index);
    }
  });
  return { envLines: [...envLines].sort((a, b) => a - b), secretRows: secretRowErrors };
}

/**
 * The Environment step of a container created from a repository: its variables and secrets, saved with it and
 * applied when its first build creates and starts it. Secrets use the Secrets editor of the Environment tab.
 */
export function DockerDeployEnvironmentStep({
  envText,
  onEnvTextChange,
  secretRows,
  onSecretRowsChange,
}: {
  envText: string;
  onEnvTextChange: (value: string) => void;
  secretRows: SecretRow[];
  onSecretRowsChange: Dispatch<SetStateAction<SecretRow[]>>;
}) {
  const errors = deployEnvironmentErrors(envText, secretRows);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Environment variables</label>
        <CodeEditor
          value={envText}
          onChange={onEnvTextChange}
          language="env"
          errorLines={errors.envLines}
          height="160px"
          minHeight="120px"
        />
        <p className="text-xs text-muted-foreground">One NAME=value per line.</p>
      </div>
      <SecretsSection
        canManageSecrets
        maskNewValues
        secretRows={secretRows}
        setSecretRows={onSecretRowsChange}
        setDeletedSecrets={NO_DELETED_SECRETS}
        duplicateSecretIndices={errors.secretRows}
        invalidKeyPattern={VARIABLE_NAME}
        description="Encrypted at rest — injected as env vars when the first build starts the container"
      />
    </div>
  );
}
