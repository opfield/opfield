package docker

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// A slot's image VOLUME the user manages in Opfield (an adopted anonymous volume, a database row only) or that an
// Opfield config names is kept when the slot is replaced or an Availability placement is removed.
func TestKeptVolumesSurviveSlotReplaceAndPlacementRemoval(t *testing.T) {
	stateDir := t.TempDir()
	setup := func(t *testing.T) (*fakeVolumeEngine, *DockerPlugin) {
		engine := slotEngine(t)
		cli := engine.client()
		cli.keptVolumes = newKeptVolumes(keptVolumesPath(stateDir))
		plugin := &DockerPlugin{client: cli, envStore: NewEnvStore(t.TempDir())}
		plugin.useLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
		return engine, plugin
	}

	_, plugin := setup(t)
	result := &pb.CommandResult{Success: true}
	plugin.handleVolumeCommand(&pb.DockerVolumeCommand{Action: "keep", Content: []byte(`{"names":["` + hexVolume("a") + `"]}`)}, result)
	if !result.Success || result.Detail != `{"kept":1}` {
		t.Fatalf("keep = %+v", result)
	}

	t.Run("slot replace", func(t *testing.T) {
		// A new client reads the persisted set: the daemon restarted since Opfield sent it.
		engine, plugin := setup(t)
		if err := plugin.client.removeContainerByName(context.Background(), "app-blue", true); err != nil {
			t.Fatal(err)
		}
		if got := engine.removed("containers"); !slices.Equal(got, []string{"app-blue"}) {
			t.Fatalf("removed containers = %v", got)
		}
		if got := engine.removed("volumes"); len(got) != 0 {
			t.Fatalf("removed volumes = %v, want the kept one to stay", got)
		}
	})

	t.Run("placement removal", func(t *testing.T) {
		engine, plugin := setup(t)
		result := &pb.CommandResult{Success: true}
		plugin.handleContainerCommand(&pb.DockerContainerCommand{Action: "remove", ContainerId: "slot-id", Force: true, ConfigJson: `{"removeAnonymousVolumes":true}`}, result)
		if !result.Success {
			t.Fatal(result.Error)
		}
		if got := engine.removed("volumes"); len(got) != 0 {
			t.Fatalf("removed volumes = %v, want the kept one to stay", got)
		}
	})

	t.Run("an emptied set removes it again", func(t *testing.T) {
		engine, plugin := setup(t)
		result := &pb.CommandResult{Success: true}
		plugin.handleVolumeCommand(&pb.DockerVolumeCommand{Action: "keep", Content: []byte(`{"names":[]}`)}, result)
		if !result.Success {
			t.Fatal(result.Error)
		}
		if err := plugin.client.removeContainerByName(context.Background(), "app-blue", true); err != nil {
			t.Fatal(err)
		}
		if got := engine.removed("volumes"); !slices.Equal(got, []string{hexVolume("a")}) {
			t.Fatalf("removed volumes = %v", got)
		}
	})
}

func TestKeptVolumesRejectAMalformedSetAndKeepThePreviousOne(t *testing.T) {
	path := filepath.Join(t.TempDir(), keptVolumesFile)
	kept := newKeptVolumes(path)
	if _, err := kept.replace([]byte(`{"names":["` + hexVolume("b") + `"]}`)); err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{`not json`, `{}`} {
		if _, err := kept.replace([]byte(content)); err == nil {
			t.Fatalf("replace(%q) accepted", content)
		}
	}
	if !newKeptVolumes(path).has(hexVolume("b")) || !kept.has(hexVolume("b")) {
		t.Fatal("the previous set was lost")
	}
	var none *keptVolumes
	if none.has(hexVolume("b")) {
		t.Fatal("a nil set keeps nothing")
	}
}
