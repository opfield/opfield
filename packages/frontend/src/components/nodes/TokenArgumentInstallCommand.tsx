import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";

/**
 * The setup command with the token as --token and a plain `sudo bash`, as before 2.13, under the main command: for a
 * host whose sudo refuses to keep OPFIELD_NODE_TOKEN.
 */
export function TokenArgumentInstallCommand({ command }: { command: string | undefined }) {
  if (!command) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        If sudo on the host refuses to keep OPFIELD_NODE_TOKEN, run this instead: it passes the
        token as --token, where other local users can see it while the installer runs.
      </p>
      <CopyCodeBlock
        label="Command with --token"
        value={command}
        copyValue={command.replace(/\s*\\\n\s*/g, " ")}
        className="[&>p]:hidden"
        codeClassName="min-h-0"
      />
    </div>
  );
}
