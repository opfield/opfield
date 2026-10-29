package access

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

const (
	testListID  = "11111111-1111-4111-8111-111111111111"
	testBasicID = "22222222-2222-4222-8222-222222222222"
	testHost    = "app.example.com"
	testKeyID   = "key-1"
)

var testNow = time.Unix(1_800_000_000, 0)

// testPolicy is a policy with one signing key, a sign-in list, a basic-only list and a service token; the private key
// signs the test's tokens.
func testPolicy(t *testing.T) (*pb.SyncAccessPolicyCommand, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("s3cret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	secret := sha256.Sum256([]byte("token-secret"))
	return &pb.SyncAccessPolicyCommand{
		Revision:     7,
		SignInOrigin: "https://access.example.net",
		Keys:         []*pb.AccessVerificationKey{{KeyId: testKeyID, PublicKey: public}},
		Lists: []*pb.AccessListPolicy{
			{
				Id:            testListID,
				SignInMethods: []string{"opfield", "idp:g1"},
				SkipIpRanges:  []string{"10.0.40.0/24"},
				IncludeRules: []*pb.AccessRule{
					{Selector: "email_domain", Values: []string{"acme.dev"}},
					{Selector: "service_token", Values: []string{"tok-ci"}},
				},
			},
			{
				Id:             testBasicID,
				SignInMethods:  []string{"basic"},
				IncludeRules:   []*pb.AccessRule{{Selector: "everyone"}},
				BasicAuthUsers: []*pb.AccessListUser{{Username: "lena", BcryptHash: string(hash)}},
			},
		},
		RevokedSessions: []*pb.AccessRevokedSession{
			{SessionId: "sess-revoked", ExpiresAtUnix: testNow.Add(time.Hour).Unix()},
			{SessionId: "sess-old", ExpiresAtUnix: testNow.Add(-time.Hour).Unix()},
		},
		ServiceTokens: []*pb.AccessServiceToken{{Id: "tok-ci", ClientId: "ci.client", SecretSha256: hex.EncodeToString(secret[:])}},
	}, private
}

func signToken(t *testing.T, key ed25519.PrivateKey, claims Claims) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := ed25519.Sign(key, []byte("opfield-access-v1."+encoded))
	return "v1." + encoded + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func testClaims(email string) Claims {
	return Claims{
		KeyID: testKeyID, SessionID: "sess-1", Audience: testHost,
		IssuedAt: testNow.Add(-time.Minute).Unix(), ExpiresAt: testNow.Add(time.Hour).Unix(),
		Identity: Identity{Method: "idp:g1", Sub: "g-1", Email: email, Name: "Lena Novak"},
	}
}

func TestVerifyToken(t *testing.T) {
	command, key := testPolicy(t)
	policy, err := NewPolicy(command, testNow)
	if err != nil {
		t.Fatal(err)
	}
	token := signToken(t, key, testClaims("lena@acme.dev"))
	claims, err := policy.VerifyToken(token, "App.Example.com:443", testNow)
	if err != nil || claims.Identity.Email != "lena@acme.dev" {
		t.Fatalf("valid token refused: %v", err)
	}

	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	expired := testClaims("lena@acme.dev")
	expired.ExpiresAt = testNow.Unix()
	revoked := testClaims("lena@acme.dev")
	revoked.SessionID = "sess-revoked"
	unknownKey := testClaims("lena@acme.dev")
	unknownKey.KeyID = "key-gone"
	tampered := token[:len(token)-4] + "AAAA"
	cases := map[string]struct{ token, host string }{
		"another host":      {token, "evil.example.com"},
		"expired":           {signToken(t, key, expired), testHost},
		"revoked session":   {signToken(t, key, revoked), testHost},
		"unknown key":       {signToken(t, key, unknownKey), testHost},
		"foreign signature": {signToken(t, otherKey, testClaims("lena@acme.dev")), testHost},
		"tampered":          {tampered, testHost},
		"no version":        {token[3:], testHost},
		"garbage":           {"v1.x.y", testHost},
	}
	for name, c := range cases {
		if _, err := policy.VerifyToken(c.token, c.host, testNow); err == nil {
			t.Errorf("%s: token accepted", name)
		}
	}
	// A session revoked after it expired is no longer kept.
	if _, kept := policy.revoked["sess-old"]; kept {
		t.Error("expired revocation kept")
	}
}
