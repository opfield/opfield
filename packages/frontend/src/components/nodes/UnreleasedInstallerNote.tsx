/** An unreleased Gateway build has no release installers, so its setup commands use main: say so beside them. */
export function UnreleasedInstallerNote({ installerRelease }: { installerRelease: string | null }) {
  if (installerRelease) return null;
  return (
    <p className="text-xs text-muted-foreground">
      This Opfield build is not a release, so the command runs the installer from the main branch
      without a checksum check.
    </p>
  );
}
