/**
 * Literals of the product names before Opfield that installations, nodes, relays and clients released earlier still
 * read or send. Every other place uses the Opfield names; code that must recognise or send one of these values imports
 * it from here. Each constant names what reads it. Do not change a value: it is a contract with something already
 * running. Pure constants only (no imports): the update Worker and the frontend bundle this file too.
 */

// Update feed (update Worker, installers, updaters of installed releases)

/** Path namespace of the update feed that installed releases up to 2.12.2 request (`/<namespace>/releases`, ...). */
export const LEGACY_UPDATE_NAMESPACE = 'gateway';
/** Component and package name of the app release in the update feed, requested by installed releases up to 2.12.2. */
export const LEGACY_APP_UPDATE_COMPONENT = 'gateway';
/** Release asset of the signed app image manifest; the updater of every installed release downloads it by this name. */
export const LEGACY_APP_IMAGE_MANIFEST_ASSET = 'gateway-image.update.json';
/** Kind of the signed app image manifest, verified by the updater of every installed release. */
export const LEGACY_APP_IMAGE_MANIFEST_KIND = 'gateway-image';
/** Installer checksum list that setup commands and wrappers of releases before 2.12.1 download. */
export const LEGACY_INSTALLER_CHECKSUMS_ASSET = 'gateway-daemon-installers.sha256';
/** First release line of inference core builds (`vX.Y.Z-<line>.N`), still served and ordered by the update Worker. */
export const LEGACY_CORE_RELEASE_LINE = 'wiolett';
/** Key id of signed update manifests and of the license endpoints document, checked by every installed release. */
export const LEGACY_UPDATE_KEY_ID = 'wiolett-update-v1';
