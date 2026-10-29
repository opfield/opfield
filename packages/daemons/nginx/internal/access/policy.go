package access

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// Policy is a validated SyncAccessPolicyCommand, ready for checks.
type Policy struct {
	Revision     uint64
	SignInOrigin string
	keys         map[string]ed25519.PublicKey
	lists        map[string]*List
	// revoked maps revoked session ids to when their tokens expire anyway.
	revoked map[string]int64
	// serviceTokens maps client ids to their tokens.
	serviceTokens map[string]serviceToken
}

type serviceToken struct {
	id           string
	secretSHA256 []byte
	expiresAt    int64
}

// The bounds of a policy: far above any real installation, low enough that a broken command cannot exhaust memory.
const (
	maxPolicyLists         = 100000
	maxPolicyKeys          = 64
	maxListUsers           = 10000
	maxPolicyServiceTokens = 100000
	maxPolicyRevoked       = 1000000
)

// NewPolicy validates a command. Revoked sessions that expired before now are dropped.
func NewPolicy(command *pb.SyncAccessPolicyCommand, now time.Time) (*Policy, error) {
	if command == nil {
		return nil, errors.New("access policy is required")
	}
	if len(command.Lists) > maxPolicyLists || len(command.Keys) > maxPolicyKeys || len(command.ServiceTokens) > maxPolicyServiceTokens || len(command.RevokedSessions) > maxPolicyRevoked {
		return nil, errors.New("access policy is too large")
	}
	origin, err := normalizeOrigin(command.SignInOrigin)
	if err != nil {
		return nil, err
	}
	policy := &Policy{
		Revision:      command.Revision,
		SignInOrigin:  origin,
		keys:          make(map[string]ed25519.PublicKey, len(command.Keys)),
		lists:         make(map[string]*List, len(command.Lists)),
		revoked:       make(map[string]int64, len(command.RevokedSessions)),
		serviceTokens: make(map[string]serviceToken, len(command.ServiceTokens)),
	}
	for _, key := range command.Keys {
		if !validID(key.KeyId) || len(key.PublicKey) != ed25519.PublicKeySize {
			return nil, errors.New("invalid access verification key")
		}
		if _, duplicate := policy.keys[key.KeyId]; duplicate {
			return nil, fmt.Errorf("duplicate access verification key %s", key.KeyId)
		}
		policy.keys[key.KeyId] = ed25519.PublicKey(append([]byte(nil), key.PublicKey...))
	}
	for _, spec := range command.Lists {
		list, err := newPolicyList(spec)
		if err != nil {
			return nil, err
		}
		if _, duplicate := policy.lists[list.ID]; duplicate {
			return nil, fmt.Errorf("duplicate access list %s", list.ID)
		}
		policy.lists[list.ID] = list
	}
	for _, session := range command.RevokedSessions {
		if session.SessionId == "" || len(session.SessionId) > 128 {
			return nil, errors.New("invalid revoked access session")
		}
		if session.ExpiresAtUnix > now.Unix() {
			policy.revoked[session.SessionId] = session.ExpiresAtUnix
		}
	}
	for _, token := range command.ServiceTokens {
		secret, err := hex.DecodeString(strings.ToLower(token.SecretSha256))
		if err != nil || len(secret) != 32 || !validID(token.Id) || token.ClientId == "" || len(token.ClientId) > 256 {
			return nil, errors.New("invalid access service token")
		}
		if _, duplicate := policy.serviceTokens[token.ClientId]; duplicate {
			return nil, errors.New("duplicate access service token client id")
		}
		policy.serviceTokens[token.ClientId] = serviceToken{id: token.Id, secretSHA256: secret, expiresAt: token.ExpiresAtUnix}
	}
	return policy, nil
}

func newPolicyList(spec *pb.AccessListPolicy) (*List, error) {
	rules := func(rules []*pb.AccessRule) []RuleSpec {
		specs := make([]RuleSpec, 0, len(rules))
		for _, rule := range rules {
			specs = append(specs, RuleSpec{Selector: rule.Selector, Values: rule.Values})
		}
		return specs
	}
	list, err := NewList(ListSpec{
		ID:            spec.Id,
		SignInMethods: spec.SignInMethods,
		SkipIPRanges:  spec.SkipIpRanges,
		IncludeRules:  rules(spec.IncludeRules),
		RequireRules:  rules(spec.RequireRules),
		ExcludeRules:  rules(spec.ExcludeRules),
	})
	if err != nil {
		return nil, err
	}
	if len(spec.BasicAuthUsers) > maxListUsers {
		return nil, fmt.Errorf("access list %s: too many users", spec.Id)
	}
	list.users = make(map[string]string, len(spec.BasicAuthUsers))
	for _, user := range spec.BasicAuthUsers {
		if user.Username == "" || len(user.Username) > 256 || strings.ContainsAny(user.Username, ":\r\n") {
			return nil, fmt.Errorf("access list %s: invalid username", spec.Id)
		}
		if _, err := bcrypt.Cost([]byte(user.BcryptHash)); err != nil {
			return nil, fmt.Errorf("access list %s: user %s has no bcrypt hash", spec.Id, user.Username)
		}
		list.users[user.Username] = user.BcryptHash
	}
	return list, nil
}

// normalizeOrigin accepts an http(s) origin without path, query or credentials ("" when none was set).
func normalizeOrigin(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" || strings.ContainsAny(value, " \t\r\n\"'<>\\") {
		return "", errors.New("invalid access sign-in origin")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// List returns the policy of a list.
func (p *Policy) List(id string) (*List, bool) {
	if p == nil {
		return nil, false
	}
	list, ok := p.lists[id]
	return list, ok
}
