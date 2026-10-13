/** The managed inference core's Docker objects next to the Compose-managed Opfield app. */
export interface CoreLayout {
  project: string;
  network: string;
  opfieldAlias: string;
  containerName: string;
  stateVolume: string;
  secretVolume: string;
}

const CORE_NAME_SUFFIX = '-inference';
// legacy-name: `<project>-inference-core` container and volumes of cores installed before 2.12.1 (under the project
// `gateway` before the host move) — remove once every installation reports none
const LEGACY_CORE_NAME_SUFFIX = '-inference-core';

/**
 * The core's Docker layout. A new core is `<project>-inference` with its `-state` and `-secrets` volumes, labelled
 * with the Compose project. An installed core keeps the names the state row stores and the project its objects are
 * labelled with (the one in its names): the host move gives the app a new project and network, never a new core.
 */
export function inferenceCoreLayout(
  project: string,
  network: string,
  opfieldAlias: string,
  stored?: { containerName?: string | null; stateVolumeName?: string | null; secretVolumeName?: string | null } | null
): CoreLayout {
  const storedBase = stored?.stateVolumeName?.endsWith('-state')
    ? stored.stateVolumeName.slice(0, -'-state'.length)
    : (stored?.containerName ?? null);
  if (storedBase) {
    const owner = [LEGACY_CORE_NAME_SUFFIX, CORE_NAME_SUFFIX].find((suffix) => storedBase.endsWith(suffix));
    return {
      project: owner ? storedBase.slice(0, -owner.length) : project,
      network,
      opfieldAlias,
      containerName: stored?.containerName ?? storedBase,
      stateVolume: stored?.stateVolumeName ?? `${storedBase}-state`,
      secretVolume: stored?.secretVolumeName ?? `${storedBase}-secrets`,
    };
  }
  const base = `${project}${CORE_NAME_SUFFIX}`;
  return {
    project,
    network,
    opfieldAlias,
    containerName: base,
    stateVolume: `${base}-state`,
    secretVolume: `${base}-secrets`,
  };
}
