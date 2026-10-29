package access

import (
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

// The decision vectors both evaluators (this one and Opfield's) must pass.
func TestDecisionVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "testdata", "access", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			Name     string    `json:"name"`
			List     ListSpec  `json:"list"`
			ClientIP string    `json:"clientIp"`
			Identity *Identity `json:"identity"`
			Source   string    `json:"source"`
			Expect   string    `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Cases) == 0 {
		t.Fatal("no vectors")
	}
	sources := map[string]Source{"": SourceCookie, "cookie": SourceCookie, "basic": SourceBasic, "service_token": SourceServiceToken}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			list, err := NewList(vector.List)
			if err != nil {
				t.Fatal(err)
			}
			source, ok := sources[vector.Source]
			if !ok {
				t.Fatalf("unknown source %q", vector.Source)
			}
			got := Evaluate(list, netip.MustParseAddr(vector.ClientIP), vector.Identity, source)
			if got.String() != vector.Expect {
				t.Fatalf("got %s, want %s", got, vector.Expect)
			}
		})
	}
}
