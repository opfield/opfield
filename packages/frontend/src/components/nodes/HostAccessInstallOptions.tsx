import { SwitchCard } from "@/components/common/SwitchCard";
import type { HostAccessInstallOptions as Options } from "@/lib/node-host-access";

/**
 * Setup command options that turn host access off on the node being installed. The installer writes them to the
 * daemon config on the node, where Gateway cannot turn them back on.
 */
export function HostAccessInstallOptions({
  value,
  onChange,
  relay = false,
}: {
  value: Options;
  onChange: (value: Options) => void;
  /** The relay installer also offers protected mode. */
  relay?: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <SwitchCard
        checked={value.disableConsole}
        onCheckedChange={(disableConsole) => onChange({ ...value, disableConsole })}
        label="Disable host console"
        description="Adds --disable-console: no shell or console commands on this host from Opfield."
      />
      <SwitchCard
        checked={value.disableFiles}
        onCheckedChange={(disableFiles) => onChange({ ...value, disableFiles })}
        label="Disable host files"
        description="Adds --disable-files: no host file browsing or writes from Opfield. Disable both to remove host access."
      />
      {relay && (
        <SwitchCard
          checked={value.protectedMode === true}
          onCheckedChange={(protectedMode) => onChange({ ...value, protectedMode })}
          label="Protected relay"
          description="Adds --protected: no console, files, commands or host diagnostics from Opfield, for a relay on someone else's machine. Only the machine owner can turn it off."
        />
      )}
    </div>
  );
}
