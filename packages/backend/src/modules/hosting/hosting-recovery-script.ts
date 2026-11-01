import { LEGACY_RELAY_SUPERVISOR } from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';
import { shellArgument } from './hosting-bootstrap.js';

const SERVICES: Record<string, string> = {
  nginx: 'nginx-daemon',
  docker: 'docker-daemon',
  builder: 'docker-daemon',
  databases: 'docker-daemon',
  storage: 'docker-daemon',
  monitoring: 'monitoring-daemon',
  relay: 'opfield-relay-supervisor',
};

// legacy-name: the legacy relay supervisor unit — a relay installed before 2.12.1 keeps running under it until its next
// start. The new unit refuses to start while the old one is enabled, and a moved relay keeps the old unit file, disabled,
// until its cleanup; remove once every relay reports none.
const LEGACY_SERVICES: Record<string, string> = { 'opfield-relay-supervisor': LEGACY_RELAY_SUPERVISOR };
export function hostingRecoveryScript(roles: string[]): string {
  const services = [...new Set(roles.map((role) => SERVICES[role]))];
  if (!services.length || services.some((service) => !service))
    throw new AppError(
      409,
      'HOSTING_RECOVERY_UNSUPPORTED',
      'No known service restart is available for these node roles'
    );
  const candidates = services.map((service) => [LEGACY_SERVICES[service as string], service].filter(Boolean).join(':'));
  return `#!/bin/bash
set -eu
unit_exists() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl cat "$1" >/dev/null 2>&1
  else
    [ -e "/etc/init.d/$1" ]
  fi
}
# The old unit still owns the host while it runs or is enabled: the new unit's guard refuses to start then.
unit_in_charge() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active --quiet "$1" || systemctl is-enabled --quiet "$1"
  else
    rc-service "$1" status >/dev/null 2>&1 || ls /etc/runlevels/*/"$1" >/dev/null 2>&1
  fi
}
for names in ${candidates.map(shellArgument).join(' ')}; do
  service=\${names##*:}
  legacy=\${names%%:*}
  if [ "$legacy" != "$service" ] && unit_exists "$legacy" && { unit_in_charge "$legacy" || ! unit_exists "$service"; }; then
    service=$legacy
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart "$service"
  elif command -v rc-service >/dev/null 2>&1; then
    rc-service "$service" restart
  else
    echo 'No supported service manager; refusing VM reboot or reinstall' >&2
    exit 1
  fi
done
`;
}
