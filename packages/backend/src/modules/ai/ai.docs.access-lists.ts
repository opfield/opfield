/** Topic access-lists: who may open a route or a Pages preview (the sign-in settings are topic access-sign-in). */
export const ACCESS_LIST_DOCS: Record<string, string> = {
  'access-lists': `# Access Lists

An access list decides who may open the routes and Pages previews it is attached to (accessListId), in the style of Cloudflare Access: visitors sign in on the Opfield sign-in page, scripts send a service token.

## How a Request Is Decided
1. An address in an Exclude rule with selector ip is denied
2. An address in skipIpRanges gets in without signing in (0.0.0.0/0 and ::/0: everyone)
3. Anyone else needs an identity: a service token (headers Opfield-Access-Client-Id and Opfield-Access-Client-Secret), HTTP basic credentials of a list user (only when basic is a method), or a sign-in
4. The identity must match no Exclude rule, every Require rule and at least one Include rule
- Without an identity: a list without signInMethods denies, a list whose only method is basic asks for basic credentials, any other list sends the browser to the sign-in page
- An empty list (no signInMethods, no skipIpRanges, no service token Include rule) lets nobody in; a create without any of these fields makes one. Everyone: skipIpRanges ["0.0.0.0/0", "::/0"]
- A signed-in visitor the rules turn away sees "no access" on the sign-in page; a service token or basic credentials that do not pass get 403

## Sign-in Methods (signInMethods)
- opfield: an account of this Opfield (rules opfield_user, opfield_group)
- password: a sign-in form for the list's users; basic: HTTP basic authentication with the same users (for scripts and old clients)
- shared: one password for every visitor (sharedPassword)
- idp:<providerId>: Google or an OIDC provider configured in the sign-in settings
- The sign-in page is a page of the protected route itself (\`/_opfield/access/sign-in\`, served by its ingress node); after signing in, a visitor stays signed in on that route for sessionTtlSeconds (null: the default of the sign-in settings). Sign-in settings, identity providers, service tokens and sessions: topic access-sign-in

## Rules (includeRules, requireRules, excludeRules)
- Each rule is { selector, values }; it matches when any value matches
- everyone (no values), ip (IP or CIDR, IPv4 or IPv6), email, email_domain (example.com, no @), opfield_user (user ids), opfield_group (permission group ids), sso_group (group names from the provider's groups claim), method (opfield, password, basic, shared, idp:<id>, service_token), service_token (service token ids)
- A list with sign-in methods needs at least one Include rule (everyone lets every signed-in visitor in)
- A service token gets in only through an Include rule service_token that names it

## Users and Passwords
- users: [{ username, password }] replaces the whole list; an existing user sent without password keeps theirs, a new user needs one
- sharedPassword: a string sets it, null clears it, omitted keeps it
- Responses carry usernames and sharedPasswordSet only; passwords are stored as bcrypt hashes

## Examples
- Office network only: { skipIpRanges: ["203.0.113.0/24"] }
- Team on SSO, except one contractor: { signInMethods: ["idp:<id>"], includeRules: [{ selector: "email_domain", values: ["example.com"] }], excludeRules: [{ selector: "email", values: ["contractor@example.com"] }] }
- Basic authentication from the office: { signInMethods: ["basic"], users: [...], includeRules: [{ selector: "everyone" }], requireRules: [{ selector: "ip", values: ["203.0.113.0/24"] }] }

## Tool Argument Shapes
- create_access_list and manage_access_list({ operation: "update", accessListId, ... }) take name, description and the fields above; an update keeps omitted fields, and an array replaces the whole array. create_access_list takes folderId for the destination access list folder (acl:create there is enough; omitted creates at the top level).
- Access lists live in folders like other resource lists (folderId, sortOrder): list_resource_folders and manage_resource_folder with resourceType access_lists (folder changes need acl:folders:manage; moving a list also needs acl:edit on it and on the destination). acl:view, acl:edit and acl:delete also take a folder (\`<scope>:folder/<folderId>\`), covering every list in it and its subfolders.
- The fields of lists before sign-in still work on their own (not mixed with the fields above), in the REST API and the tools: ipRules (ordered { type: allow|deny, value }, IP, CIDR or all; the first match wins, an address that matches none is denied, no rules lets everyone in), basicAuthEnabled and basicAuthUsers ([{ username, password }]). create_access_list also takes allowIps and denyIps (string arrays, added after ipRules as allow then deny rules); manage_access_list move_rule moves one of those rules
- Responses carry the legacy fields next to the fields above: ipRules and basicAuthEnabled (for a list that uses sign-in methods or identity rules: what nginx enforces of it by itself, i.e. excluded addresses denied, skip ranges allowed, everyone else denied), basicAuthUsers (usernames) and ipRuleWarnings (rules of ipRules that never match, shadowed with coveredByIndex, or deny rules with no effect; 0-based like move_rule)

## Usage
- One access list can be shared across multiple routes and Pages projects; a change applies to all of them
- Nodes check lists themselves, so access keeps working while Opfield is unreachable. A list of IP rules and basic authentication only (no other sign-in method, no service token) is rendered as nginx allow/deny and auth_basic on every node, so it also works while the node's nginx daemon is down; other lists are checked by the nginx daemon. A node whose nginx daemon is older denies every other sign-in until it is updated
- An access list cannot be deleted while a route or a Pages project uses it; detach it first`,
};
