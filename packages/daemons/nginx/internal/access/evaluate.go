// Package access answers nginx's access checks (auth_request) for routes and Pages previews with an access list: the
// policy Opfield syncs (SyncAccessPolicyCommand), kept on disk so access keeps working while Opfield is unreachable,
// the decision every list makes, and the signed access tokens visitors carry in a cookie.
package access

import (
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"
)

// Decision is the answer for one request (contract, section Decision).
type Decision int

const (
	Deny Decision = iota
	Allow
	// Basic asks the visitor for basic authentication credentials.
	Basic
	// Redirect sends the visitor to the sign-in page.
	Redirect
)

func (d Decision) String() string {
	switch d {
	case Allow:
		return "allow"
	case Basic:
		return "basic"
	case Redirect:
		return "redirect"
	default:
		return "deny"
	}
}

// Source is where a request's identity came from.
type Source int

const (
	SourceCookie Source = iota
	SourceBasic
	SourceServiceToken
)

// Identity is a verified identity: the idn claims of an access token, a basic authentication user or a service token.
type Identity struct {
	Method string   `json:"m"`
	Sub    string   `json:"sub"`
	Email  string   `json:"em,omitempty"`
	Name   string   `json:"nm,omitempty"`
	Groups []string `json:"grp,omitempty"`
	List   string   `json:"lst,omitempty"`
}

// The identity methods.
const (
	MethodOpfield      = "opfield"
	MethodPassword     = "password"
	MethodBasic        = "basic"
	MethodShared       = "shared"
	MethodServiceToken = "service_token"
	methodIdPPrefix    = "idp:"
)

// The rule selectors.
const (
	SelectorEveryone     = "everyone"
	SelectorIP           = "ip"
	SelectorEmail        = "email"
	SelectorEmailDomain  = "email_domain"
	SelectorOpfieldUser  = "opfield_user"
	SelectorOpfieldGroup = "opfield_group"
	SelectorSSOGroup     = "sso_group"
	SelectorMethod       = "method"
	SelectorServiceToken = "service_token"
)

var selectors = []string{SelectorEveryone, SelectorIP, SelectorEmail, SelectorEmailDomain, SelectorOpfieldUser, SelectorOpfieldGroup, SelectorSSOGroup, SelectorMethod, SelectorServiceToken}

// RuleSpec is a rule as Opfield sends it.
type RuleSpec struct {
	Selector string   `json:"selector"`
	Values   []string `json:"values"`
}

// Rule is a validated rule; ip rules carry their parsed ranges.
type Rule struct {
	Selector string
	Values   []string
	ranges   []netip.Prefix
}

// List is the validated policy of one access list.
type List struct {
	ID            string
	SignInMethods []string
	skipRanges    []netip.Prefix
	Include       []Rule
	Require       []Rule
	Exclude       []Rule
	// users maps the usernames basic authentication accepts to their bcrypt hashes.
	users map[string]string
}

// ListSpec is a list as Opfield sends it, without the users.
type ListSpec struct {
	ID            string     `json:"id"`
	SignInMethods []string   `json:"signInMethods"`
	SkipIPRanges  []string   `json:"skipIpRanges"`
	IncludeRules  []RuleSpec `json:"includeRules"`
	RequireRules  []RuleSpec `json:"requireRules"`
	ExcludeRules  []RuleSpec `json:"excludeRules"`
}

// NewList validates a list.
func NewList(spec ListSpec) (*List, error) {
	if !validID(spec.ID) {
		return nil, errors.New("invalid access list id")
	}
	list := &List{ID: spec.ID}
	for _, method := range spec.SignInMethods {
		if !validMethod(method) {
			return nil, fmt.Errorf("access list %s: invalid sign-in method %q", spec.ID, method)
		}
		if !slices.Contains(list.SignInMethods, method) {
			list.SignInMethods = append(list.SignInMethods, method)
		}
	}
	var err error
	if list.skipRanges, err = parseRanges(spec.SkipIPRanges); err != nil {
		return nil, fmt.Errorf("access list %s: skip ranges: %w", spec.ID, err)
	}
	if list.Include, err = newRules(spec.IncludeRules); err != nil {
		return nil, fmt.Errorf("access list %s: include: %w", spec.ID, err)
	}
	if list.Require, err = newRules(spec.RequireRules); err != nil {
		return nil, fmt.Errorf("access list %s: require: %w", spec.ID, err)
	}
	if list.Exclude, err = newRules(spec.ExcludeRules); err != nil {
		return nil, fmt.Errorf("access list %s: exclude: %w", spec.ID, err)
	}
	return list, nil
}

func validMethod(method string) bool {
	switch method {
	case MethodOpfield, MethodPassword, MethodBasic, MethodShared:
		return true
	}
	provider, ok := strings.CutPrefix(method, methodIdPPrefix)
	return ok && validID(provider)
}

// validID accepts the ids Opfield gives lists, providers, tokens and keys: short, printable, no separators.
func validID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

func newRules(specs []RuleSpec) ([]Rule, error) {
	rules := make([]Rule, 0, len(specs))
	for _, spec := range specs {
		if !slices.Contains(selectors, spec.Selector) {
			return nil, fmt.Errorf("unknown selector %q", spec.Selector)
		}
		if len(spec.Values) > 10000 {
			return nil, errors.New("too many rule values")
		}
		rule := Rule{Selector: spec.Selector, Values: slices.Clone(spec.Values)}
		if spec.Selector == SelectorIP {
			ranges, err := parseRanges(spec.Values)
			if err != nil {
				return nil, err
			}
			rule.ranges = ranges
		}
		rules = append(rules, rule)
	}
	return rules, nil
}

func parseRanges(values []string) ([]netip.Prefix, error) {
	ranges := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if strings.Contains(value, "/") {
			prefix, err := netip.ParsePrefix(value)
			if err != nil {
				return nil, fmt.Errorf("invalid range %q", value)
			}
			if prefix.Addr().Is4In6() {
				prefix = netip.PrefixFrom(prefix.Addr().Unmap(), max(prefix.Bits()-96, 0))
			}
			ranges = append(ranges, prefix.Masked())
			continue
		}
		addr, err := netip.ParseAddr(value)
		if err != nil {
			return nil, fmt.Errorf("invalid address %q", value)
		}
		addr = addr.Unmap().WithZone("")
		ranges = append(ranges, netip.PrefixFrom(addr, addr.BitLen()))
	}
	return ranges, nil
}

func inRanges(ranges []netip.Prefix, addr netip.Addr) bool {
	if !addr.IsValid() {
		return false
	}
	addr = addr.Unmap().WithZone("")
	for _, prefix := range ranges {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// Evaluate decides one request to a route with the list: client is the visitor's address, identity the verified
// identity the request presented (nil: none) and source where it came from.
func Evaluate(list *List, client netip.Addr, identity *Identity, source Source) Decision {
	for _, rule := range list.Exclude {
		if rule.Selector == SelectorIP && inRanges(rule.ranges, client) {
			return Deny
		}
	}
	if inRanges(list.skipRanges, client) {
		return Allow
	}
	// A cookie identity this list does not accept counts as none: the visitor signs in again. A service token or a
	// basic authentication user the request presented stays its identity, and is denied.
	if identity != nil && source == SourceCookie && !list.usable(identity) {
		identity = nil
	}
	if identity == nil {
		switch {
		case len(list.SignInMethods) == 0:
			return Deny
		case len(list.SignInMethods) == 1 && list.SignInMethods[0] == MethodBasic:
			return Basic
		default:
			return Redirect
		}
	}
	refused := Deny
	if source == SourceCookie {
		// The sign-in page tells a signed-in visitor that has no access.
		refused = Redirect
	}
	if !list.usable(identity) {
		return refused
	}
	for _, rule := range list.Exclude {
		if rule.Selector != SelectorIP && rule.matches(identity, client) {
			return refused
		}
	}
	for _, rule := range list.Require {
		if !rule.matches(identity, client) {
			return refused
		}
	}
	for _, rule := range list.Include {
		if rule.matches(identity, client) {
			return Allow
		}
	}
	return refused
}

// usable reports whether the list accepts an identity of its method at all.
func (l *List) usable(identity *Identity) bool {
	if identity.Method == MethodServiceToken {
		return slices.ContainsFunc(l.Include, func(rule Rule) bool { return rule.Selector == SelectorServiceToken })
	}
	if !slices.Contains(l.SignInMethods, identity.Method) {
		return false
	}
	switch identity.Method {
	case MethodPassword, MethodBasic, MethodShared:
		return identity.List == l.ID
	}
	return true
}

func (r Rule) matches(identity *Identity, client netip.Addr) bool {
	switch r.Selector {
	case SelectorEveryone:
		return true
	case SelectorIP:
		return inRanges(r.ranges, client)
	case SelectorEmail:
		return identity.Email != "" && slices.ContainsFunc(r.Values, func(value string) bool { return strings.EqualFold(value, identity.Email) })
	case SelectorEmailDomain:
		email := strings.ToLower(identity.Email)
		return email != "" && slices.ContainsFunc(r.Values, func(value string) bool {
			return value != "" && strings.HasSuffix(email, "@"+strings.ToLower(value))
		})
	case SelectorOpfieldUser:
		return identity.Method == MethodOpfield && slices.Contains(r.Values, identity.Sub)
	case SelectorOpfieldGroup:
		return identity.Method == MethodOpfield && anyIn(identity.Groups, r.Values)
	case SelectorSSOGroup:
		return strings.HasPrefix(identity.Method, methodIdPPrefix) && anyIn(identity.Groups, r.Values)
	case SelectorMethod:
		return slices.Contains(r.Values, identity.Method)
	case SelectorServiceToken:
		return identity.Method == MethodServiceToken && slices.Contains(r.Values, identity.Sub)
	}
	return false
}

func anyIn(have, want []string) bool {
	return slices.ContainsFunc(have, func(value string) bool { return slices.Contains(want, value) })
}
