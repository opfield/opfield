import { CodeEditor } from "@/components/ui/code-editor";
import { envTextErrorLines, parseEnvText } from "../docker-detail/EnvTextDialog";

/** `NAME=value` lines as a record (the step blocks invalid or repeated names). */
export function deployEnvironmentRecord(text: string): Record<string, string> {
  return Object.fromEntries(parseEnvText(text).map(({ key, value }) => [key, value]));
}

/** 1-based lines of each field that are invalid, repeated, or name a variable the other field has too. */
export function deployEnvironmentErrorLines(envText: string, secretsText: string) {
  const envNames = new Set(Object.keys(deployEnvironmentRecord(envText)));
  const secretNames = new Set(Object.keys(deployEnvironmentRecord(secretsText)));
  const sharedLines = (text: string, other: Set<string>) =>
    text.split("\n").flatMap((line, index) => {
      const separator = line.indexOf("=");
      return separator > 0 && other.has(line.slice(0, separator)) ? [index + 1] : [];
    });
  const merge = (left: number[], right: number[]) =>
    [...new Set([...left, ...right])].sort((a, b) => a - b);
  return {
    env: merge(envTextErrorLines(envText), sharedLines(envText, secretNames)),
    secrets: merge(envTextErrorLines(secretsText), sharedLines(secretsText, envNames)),
  };
}

/**
 * The Environment step of a container created from a repository: its variables and secrets, saved with it and
 * applied when its first build creates and starts it.
 */
export function DockerDeployEnvironmentStep({
  envText,
  secretsText,
  onEnvTextChange,
  onSecretsTextChange,
}: {
  envText: string;
  secretsText: string;
  onEnvTextChange: (value: string) => void;
  onSecretsTextChange: (value: string) => void;
}) {
  const errors = deployEnvironmentErrorLines(envText, secretsText);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Environment variables</label>
        <CodeEditor
          value={envText}
          onChange={onEnvTextChange}
          language="env"
          errorLines={errors.env}
          height="160px"
          minHeight="120px"
        />
        <p className="text-xs text-muted-foreground">One NAME=value per line.</p>
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Secrets</label>
        <CodeEditor
          value={secretsText}
          onChange={onSecretsTextChange}
          language="env"
          errorLines={errors.secrets}
          height="120px"
          minHeight="96px"
        />
        <p className="text-xs text-muted-foreground">
          One NAME=value per line. Stored encrypted; a name is either a variable or a secret.
        </p>
      </div>
    </div>
  );
}
