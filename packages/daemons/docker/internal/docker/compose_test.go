package docker

import (
	"context"
	"errors"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/docker-daemon/internal/config"
	"gopkg.in/yaml.v3"
)

type fakeComposeSidecar struct {
	mu      sync.Mutex
	calls   int
	started chan struct{}
	release chan struct{}
}

func (f *fakeComposeSidecar) run(ctx context.Context, _ composeRequest) error {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.started != nil {
		select {
		case f.started <- struct{}{}:
		default:
		}
	}
	if f.release != nil {
		select {
		case <-f.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (f *fakeComposeSidecar) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func newTestComposeExecutor(sidecar composeSidecar) *composeExecutor {
	return &composeExecutor{
		sidecar:   sidecar,
		timeout:   time.Second,
		active:    make(map[string]*composeOperation),
		completed: make(map[string]composeOperationResult),
	}
}

func validComposeCommand(action, operationID string) *pb.DockerComposeCommand {
	command := &pb.DockerComposeCommand{
		Action: action, OperationId: operationID, ProjectId: "project-1", ProjectName: "example",
	}
	if action != "cancel" && action != "delete_volumes" {
		command.RevisionId = "revision-1"
		command.ConfigDigest = strings.Repeat("a", 64)
		command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n")
		command.NormalizedModelJson = "{}"
	}
	return command
}

func TestComposeExecutorDoesNotDoubleExecuteSameOperation(t *testing.T) {
	sidecar := &fakeComposeSidecar{}
	executor := newTestComposeExecutor(sidecar)
	command := validComposeCommand("apply", "operation-1")
	if _, err := executor.handle(command); err != nil {
		t.Fatalf("first operation: %v", err)
	}
	if _, err := executor.handle(command); err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
	if got := sidecar.callCount(); got != 1 {
		t.Fatalf("sidecar calls = %d, want 1", got)
	}
}

func TestComposeExecutorRejectsConflictingActiveOperation(t *testing.T) {
	sidecar := &fakeComposeSidecar{started: make(chan struct{}, 1), release: make(chan struct{})}
	executor := newTestComposeExecutor(sidecar)
	firstDone := make(chan error, 1)
	go func() { _, err := executor.handle(validComposeCommand("apply", "operation-1")); firstDone <- err }()
	<-sidecar.started
	if _, err := executor.handle(validComposeCommand("apply", "operation-2")); err == nil || !strings.Contains(err.Error(), "conflicting") {
		t.Fatalf("conflicting operation error = %v", err)
	}
	close(sidecar.release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first operation: %v", err)
	}
}

func TestComposeExecutorCancelTargetsMatchingOperation(t *testing.T) {
	sidecar := &fakeComposeSidecar{started: make(chan struct{}, 1), release: make(chan struct{})}
	executor := newTestComposeExecutor(sidecar)
	firstDone := make(chan error, 1)
	go func() { _, err := executor.handle(validComposeCommand("apply", "operation-1")); firstDone <- err }()
	<-sidecar.started
	if _, err := executor.handle(validComposeCommand("cancel", "operation-2")); err == nil || !strings.Contains(err.Error(), "no active") {
		t.Fatalf("mismatched cancel error = %v", err)
	}
	if _, err := executor.handle(validComposeCommand("cancel", "operation-1")); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if err := <-firstDone; err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("first operation error = %v", err)
	}
	if _, err := executor.handle(validComposeCommand("cancel", "operation-1")); err == nil || !strings.Contains(err.Error(), "no active") {
		t.Fatalf("cancel of a finished operation error = %v", err)
	}
}

// After an update the daemon renews its control session while an Apply runs; the Apply finishes and its result is
// delivered on the next session (O-2).
func TestComposeOperationSurvivesTheEndOfItsSession(t *testing.T) {
	sidecar := &fakeComposeSidecar{started: make(chan struct{}, 1), release: make(chan struct{})}
	plugin := &DockerPlugin{composeExecutor: newTestComposeExecutor(sidecar)}
	done := make(chan error, 1)
	go func() {
		_, err := plugin.composeExecutor.handle(validComposeCommand("apply", "operation-1"))
		done <- err
	}()
	<-sidecar.started
	plugin.OnSessionEnd()
	close(sidecar.release)
	if err := <-done; err != nil {
		t.Fatalf("apply across the session end: %v", err)
	}
}

func TestComposeExecutorRefusesOperationWhoseCancelArrivedFirst(t *testing.T) {
	sidecar := &fakeComposeSidecar{}
	executor := newTestComposeExecutor(sidecar)
	// Concurrent dispatch can deliver the cancel before its operation starts.
	if _, err := executor.handle(validComposeCommand("cancel", "operation-1")); err != nil {
		t.Fatalf("early cancel: %v", err)
	}
	if _, err := executor.handle(validComposeCommand("apply", "operation-1")); err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("operation after early cancel error = %v", err)
	}
	if got := sidecar.callCount(); got != 0 {
		t.Fatalf("sidecar calls = %d, want 0", got)
	}
	// A retry of the same operation stays refused; other operations still run.
	if _, err := executor.handle(validComposeCommand("apply", "operation-1")); err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("retried operation error = %v", err)
	}
	if _, err := executor.handle(validComposeCommand("apply", "operation-2")); err != nil {
		t.Fatalf("unrelated operation: %v", err)
	}
}

func TestComposePolicyRejectsBuildAndInjectsOwnershipLabels(t *testing.T) {
	command := validComposeCommand("apply", "operation-1")
	request, err := validateComposeCommand(command)
	if err != nil {
		t.Fatalf("validate accepted compose: %v", err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(request.composeYAML, &document); err != nil {
		t.Fatalf("parse normalized yaml: %v", err)
	}
	services := document["services"].(map[string]any)
	labels := services["web"].(map[string]any)["labels"].(map[string]any)
	if labels["net.opfield.compose.project-id"] != "project-1" {
		t.Fatalf("project ownership label = %#v", labels)
	}
	command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    build: .\n")
	if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "build") {
		t.Fatalf("build validation error = %v", err)
	}
}

func TestComposeServicesCarryTheirOwnConfigurationDigest(t *testing.T) {
	revisionLabels := func(command *pb.DockerComposeCommand) map[string]any {
		t.Helper()
		request, err := validateComposeCommand(command)
		if err != nil {
			t.Fatalf("validate accepted compose: %v", err)
		}
		var document map[string]any
		if err := yaml.Unmarshal(request.composeYAML, &document); err != nil {
			t.Fatalf("parse normalized yaml: %v", err)
		}
		labels := make(map[string]any)
		for name, service := range document["services"].(map[string]any) {
			labels[name] = service.(map[string]any)["labels"].(map[string]any)["net.opfield.compose.revision"]
		}
		return labels
	}
	command := validComposeCommand("apply", "operation-service-digests")
	command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n  worker:\n    image: busybox\n")
	web, worker := strings.Repeat("b", 64), strings.Repeat("c", 64)
	command.NormalizedModelJson = `{"services":{},"serviceConfigDigests":{"web":"` + web + `","worker":"` + worker + `"}}`
	// A revision that changes only web keeps worker's label (and Compose's config hash): only web is recreated.
	if got := revisionLabels(command); got["web"] != web || got["worker"] != worker {
		t.Fatalf("service revision labels = %#v", got)
	}

	// A service without a digest of its own, and an Opfield that sends none, label it with the revision digest.
	command.NormalizedModelJson = `{"serviceConfigDigests":{"web":"` + web + `"}}`
	if got := revisionLabels(command); got["web"] != web || got["worker"] != command.ConfigDigest {
		t.Fatalf("partial service revision labels = %#v", got)
	}
	command.NormalizedModelJson = "{}"
	if got := revisionLabels(command); got["web"] != command.ConfigDigest || got["worker"] != command.ConfigDigest {
		t.Fatalf("revision labels without service digests = %#v", got)
	}

	command.NormalizedModelJson = `{"serviceConfigDigests":{"web":"not-a-digest"}}`
	if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "configuration digest") {
		t.Fatalf("invalid service digest error = %v", err)
	}
}

func TestComposePolicyAcceptsManagedDatabaseExtraHosts(t *testing.T) {
	command := validComposeCommand("apply", "operation-managed-database")
	command.ComposeYaml = []byte(`services:
  web:
    image: nginx:alpine
    extra_hosts:
      db-internal: 172.28.0.1
`)
	if _, err := validateComposeCommand(command); err != nil {
		t.Fatalf("managed database extra_hosts validation error = %v", err)
	}
}

func TestComposePolicyRejectsVariableInterpolationInVolumeSources(t *testing.T) {
	for _, composeYAML := range []string{
		`services:
  web:
    image: nginx:alpine
    volumes:
      - ${HOST_PATH}:/sock:ro
volumes:
  ${HOST_PATH}: {}
`,
		`services:
  web:
    image: nginx:alpine
    volumes:
      - type: volume
        source: ${HOST_PATH}
        target: /sock
volumes:
  ${HOST_PATH}: {}
`,
	} {
		command := validComposeCommand("apply", "operation-volume-interpolation")
		command.Variables = map[string]string{"HOST_PATH": "/var/run/docker.sock"}
		command.ComposeYaml = []byte(composeYAML)
		if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "host bind") {
			t.Fatalf("volume interpolation validation error = %v", err)
		}
	}
}

func TestComposePolicyAcceptsOrdinaryResourceLimitsAndRejectsInvalidValues(t *testing.T) {
	command := validComposeCommand("apply", "operation-resources")
	command.ComposeYaml = []byte(`services:
  web:
    image: nginx:alpine
    cpus: 1.5
    cpu_shares: 512
    mem_limit: 768M
    mem_reservation: 256M
    memswap_limit: 1G
    pids_limit: 128
`)
	if _, err := validateComposeCommand(command); err != nil {
		t.Fatalf("resource limits rejected: %v", err)
	}

	command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    mem_limit: lots\n")
	if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "mem_limit") {
		t.Fatalf("invalid resource limit error = %v", err)
	}

	command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    deploy:\n      replicas: 2\n")
	if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "deploy") {
		t.Fatalf("deploy validation error = %v", err)
	}
}

func TestComposePolicyMatchesBackendNameResourceAndLabelSubset(t *testing.T) {
	command := validComposeCommand("apply", "operation-parity")
	command.ComposeYaml = []byte(`name: example
services:
  web:
    image: nginx:alpine
    labels:
      - app=web
volumes:
  data:
    driver: local
    labels:
      tier: persistent
networks:
  app:
    driver: bridge
    labels:
      - tier=internal
`)
	request, err := validateComposeCommand(command)
	if err != nil {
		t.Fatalf("backend-supported compose subset rejected: %v", err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(request.composeYAML, &document); err != nil {
		t.Fatalf("parse normalized yaml: %v", err)
	}
	labels := document["services"].(map[string]any)["web"].(map[string]any)["labels"].(map[string]any)
	if labels["app"] != "web" || labels["net.opfield.compose.managed"] != "true" {
		t.Fatalf("normalized labels = %#v", labels)
	}

	command.ComposeYaml = []byte("name: another\nservices:\n  web:\n    image: nginx:alpine\n")
	if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), "project_name") {
		t.Fatalf("mismatched document name error = %v", err)
	}
}

// The backend Compose policy tests run the same fixtures, so a document the
// backend accepts never fails daemon validation at apply, and vice versa.
func TestComposePolicyMatchesBackendParityFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "compose-policy-parity.yaml"))
	if err != nil {
		t.Fatalf("read parity fixtures: %v", err)
	}
	var fixtures struct {
		Cases []struct {
			Name        string `yaml:"name"`
			Valid       bool   `yaml:"valid"`
			DaemonError string `yaml:"daemonError"`
			YAML        string `yaml:"yaml"`
		} `yaml:"cases"`
	}
	if err := yaml.Unmarshal(raw, &fixtures); err != nil {
		t.Fatalf("parse parity fixtures: %v", err)
	}
	if len(fixtures.Cases) == 0 {
		t.Fatal("parity fixtures are empty")
	}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			command := validComposeCommand("apply", "operation-parity")
			command.ComposeYaml = []byte(fixture.YAML)
			_, err := validateComposeCommand(command)
			if fixture.Valid {
				if err != nil {
					t.Fatalf("backend-valid compose rejected: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("backend-invalid compose accepted")
			}
			if fixture.DaemonError == "" || !strings.Contains(err.Error(), fixture.DaemonError) {
				t.Fatalf("validation error = %q, want it to contain %q", err, fixture.DaemonError)
			}
		})
	}
}

// Project variables and secrets reach the sidecar's environment; the names its
// compose client reads itself are refused, and its own settings come last.
func TestComposeBindingsCannotReconfigureTheSidecarClient(t *testing.T) {
	for _, name := range []string{"DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "BUILDKIT_HOST", "COMPOSE_FILE", "PATH"} {
		variable := validComposeCommand("apply", "operation-env")
		variable.Variables = map[string]string{name: "tcp://203.0.113.1:2375"}
		if _, err := validateComposeCommand(variable); err == nil || !strings.Contains(err.Error(), "reserved") {
			t.Fatalf("variable %s: %v", name, err)
		}
		secret := validComposeCommand("apply", "operation-env")
		secret.Secrets = map[string]string{name: "value"}
		if _, err := validateComposeCommand(secret); err == nil || !strings.Contains(err.Error(), "reserved") {
			t.Fatalf("secret %s: %v", name, err)
		}
	}
	// Other DOCKER_* names are ordinary project variables.
	tag := validComposeCommand("apply", "operation-env")
	tag.Variables = map[string]string{"DOCKER_IMAGE_TAG": "1.2", "DOCKER_REGISTRY": "registry.example.test"}
	if _, err := validateComposeCommand(tag); err != nil {
		t.Fatalf("image tag and registry variables refused: %v", err)
	}
	env := composeSidecarEnvironment(composeRequest{variables: map[string]string{"TAG": "1"}, secrets: map[string]string{"TOKEN": "x"}})
	if len(env) != 3 || env[len(env)-1] != "DOCKER_HOST=unix:///var/run/docker.sock" {
		t.Fatalf("sidecar environment = %v, want the project bindings then DOCKER_HOST", env)
	}
}

// A project saved before the reserved network, label and variable rules is
// refused for every action that creates or starts containers, yet it can
// still be stopped and brought down, without its reserved bindings.
func TestReservedRulesBlockStartsButNotStopOrDown(t *testing.T) {
	legacy := func(action string) *pb.DockerComposeCommand {
		command := validComposeCommand(action, "operation-legacy-"+action)
		command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    labels:\n      " + legacycompat.SandboxLabel + ": \"true\"\n    networks: [outside]\nnetworks:\n  outside:\n    external: true\n    name: host\n")
		command.Variables = map[string]string{"DOCKER_HOST": "tcp://203.0.113.1:2375", "TAG": "1"}
		return command
	}
	for _, action := range []string{"apply", "pull_apply", composeActionPullCreate, "start", "restart"} {
		if _, err := validateComposeCommand(legacy(action)); err == nil {
			t.Fatalf("%s of a project with reserved labels, networks and variables accepted", action)
		}
	}
	for _, action := range []string{"stop", "down"} {
		request, err := validateComposeCommand(legacy(action))
		if err != nil {
			t.Fatalf("%s of a project saved before the reserved rules refused: %v", action, err)
		}
		env := composeSidecarEnvironment(request)
		if strings.Join(env, " ") != "TAG=1 DOCKER_HOST=unix:///var/run/docker.sock" {
			t.Fatalf("%s sidecar environment = %v, want the reserved binding dropped and DOCKER_HOST last", action, env)
		}
	}
	// Compose's own ownership labels stay refused for every action, as before.
	down := validComposeCommand("down", "operation-legacy-owned")
	down.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    labels:\n      com.docker.compose.project: other\n")
	if _, err := validateComposeCommand(down); err == nil {
		t.Fatal("down of a project that overrides Compose ownership labels accepted")
	}
}

func TestComposeSidecarCommandsPreservePullAndVolumesSemantics(t *testing.T) {
	apply, err := composeSidecarCommands(composeRequest{action: "apply"})
	if err != nil || len(apply) != 1 || strings.Join(apply[0], " ") != "up --detach --no-build --pull missing" {
		t.Fatalf("apply commands = %#v, %v", apply, err)
	}
	pullApply, err := composeSidecarCommands(composeRequest{action: "pull_apply"})
	if err != nil || len(pullApply) != 2 || pullApply[0][0] != "pull" || strings.Join(pullApply[1], " ") != "up --detach --no-build --pull never" {
		t.Fatalf("pull_apply commands = %#v, %v", pullApply, err)
	}
	down, err := composeSidecarCommands(composeRequest{action: "down"})
	if err != nil || strings.Contains(strings.Join(down[0], " "), "--volumes") {
		t.Fatalf("down commands = %#v, %v", down, err)
	}
	for _, action := range []string{"apply", "pull_apply"} {
		for _, noStart := range []bool{false, true} {
			commands, err := composeSidecarCommands(composeRequest{action: action, noStart: noStart, removeOrphans: true})
			if err != nil || !strings.HasSuffix(strings.Join(commands[len(commands)-1], " "), "--remove-orphans") {
				t.Fatalf("%s (noStart %v) with removeOrphans = %#v, %v", action, noStart, commands, err)
			}
		}
	}
}

func TestComposeSidecarUsesExplicitBinaryEntrypoint(t *testing.T) {
	if composeSidecarEntrypoint != "/docker-compose" {
		t.Fatalf("compose sidecar entrypoint = %q", composeSidecarEntrypoint)
	}
}

func TestComposeExecutionErrorsAreRedacted(t *testing.T) {
	if got := redactComposeExecutionError(errors.New("token=secret")); got.Error() != "docker compose operation failed" {
		t.Fatalf("redacted error = %q", got.Error())
	}
	if got := redactComposeExecutionError(context.Canceled); got.Error() != "docker compose operation canceled" {
		t.Fatalf("cancellation error = %q", got.Error())
	}
}

func TestComposeCommandErrorReturnsOnlyAllowlistedDiagnostic(t *testing.T) {
	err := redactComposeExecutionError(&composeSidecarCommandError{
		detail: "Bind for 0.0.0.0:8080 failed: port is already allocated; token=super-secret",
	})
	if got := err.Error(); got != "Docker Compose could not publish a host port because it is already in use. Change the published port and create a new revision." {
		t.Fatalf("unexpected detailed compose error: %q", got)
	}
	if strings.Contains(err.Error(), "super-secret") || strings.Contains(err.Error(), "8080") {
		t.Fatalf("allowlisted compose error leaked raw detail: %q", err.Error())
	}

	notApplied := redactComposeExecutionError(&composeSidecarCommandError{detail: `service "web" has no container to start`})
	if got := notApplied.Error(); !strings.Contains(got, "Apply it first") {
		t.Fatalf("a start without containers should say to apply first: %q", got)
	}

	generic := redactComposeExecutionError(&composeSidecarCommandError{
		detail: "multiline\nsecret value from user-authored yaml",
	})
	if got := generic.Error(); got != "docker compose operation failed" {
		t.Fatalf("unexpected generic compose error: %q", got)
	}
}

func TestComposeCapabilityRequiresInitializedExecutorAndGeneralProfile(t *testing.T) {
	plugin := &DockerPlugin{cfg: &config.Config{}}
	if containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, composeCapability) {
		t.Fatal("compose capability advertised without an initialized executor")
	}
	plugin.composeExecutor = &composeExecutor{}
	if !containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, composeCapability) {
		t.Fatal("compose capability missing with an initialized executor")
	}
	plugin.cfg.Docker.Mode = "databases"
	if containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, composeCapability) {
		t.Fatal("database profile advertised compose capability")
	}
	result := plugin.HandleCommand(&pb.OpfieldCommand{CommandId: "command-1", Payload: &pb.OpfieldCommand_DockerCompose{DockerCompose: validComposeCommand("apply", "operation-1")}})
	if result.Success || !strings.Contains(result.Error, "storage-profile") {
		t.Fatalf("database profile compose result = %#v", result)
	}
}

func containsCapability(capabilities []string, capability string) bool {
	for _, candidate := range capabilities {
		if candidate == capability {
			return true
		}
	}
	return false
}
