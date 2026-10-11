package docker

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/protobuf/encoding/protojson"
)

const memberConfigVectorsPath = "../../../../../proto/testdata/availability-member-config-v1.json"

// The member configurations a node takes or refuses: the vectors are shared
// with the backend's mirror (services/availability-member-config.rules.ts),
// so Gateway never sends a configuration the node is bound to refuse (an
// automatic member without its set's lease policy looped a convert forever).
func TestAvailabilityMemberConfigVectors(t *testing.T) {
	data, err := os.ReadFile(memberConfigVectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name   string          `json:"name"`
			Config json.RawMessage `json:"config"`
			Error  *string         `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("no vectors")
	}
	for _, vector := range file.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			var config pb.AvailabilityMemberConfig
			if err := protojson.Unmarshal(vector.Config, &config); err != nil {
				t.Fatal(err)
			}
			err := memberConfigFromProto(&config).Validate()
			switch {
			case vector.Error == nil && err != nil:
				t.Fatalf("refused: %v", err)
			case vector.Error != nil && err == nil:
				t.Fatalf("accepted; want %q", *vector.Error)
			case vector.Error != nil && !strings.Contains(err.Error(), *vector.Error):
				t.Fatalf("refused with %q; want %q", err, *vector.Error)
			}
		})
	}
}
