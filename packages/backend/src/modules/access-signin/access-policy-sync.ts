// Placeholder of the access policy sync (contract commit). B2 replaces the body: it pushes the full
// SyncAccessPolicyCommand to every nginx node advertising nginx_access_auth_v1, debounced.

/** Pushes the access policy to the nginx nodes after a change of access lists, keys, sessions or settings. */
export function scheduleAccessPolicySync(): void {}
