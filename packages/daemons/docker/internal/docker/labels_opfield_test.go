package docker

import (
	"bytes"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestLabelKeysMapBothWays(t *testing.T) {
	for opfield, legacy := range map[string]string{
		"net.opfield.deployment.id":               "wiolett.gateway.deployment.id",
		"net.opfield.managed":                     "wiolett.gateway.managed",
		"net.opfield.managed-volume":              "com.wiolett.gateway.managed-volume",
		"net.opfield.managed-volume-origin":       "com.wiolett.gateway.managed-volume-origin",
		"net.opfield.managed-volume-storage-kind": "com.wiolett.gateway.managed-volume-storage-kind",
	} {
		if got := legacyLabelKey(opfield); got != legacy {
			t.Fatalf("legacyLabelKey(%s) = %s", opfield, got)
		}
		if got := opfieldLabelKey(legacy); got != opfield {
			t.Fatalf("opfieldLabelKey(%s) = %s", legacy, got)
		}
	}
	for _, other := range []string{"com.docker.compose.project", "app", "net.wiolett.gateway.managed", "org.example.wiolett.gateway.x"} {
		if legacyLabelKey(other) != "" || opfieldLabelKey(other) != "" {
			t.Fatalf("%s is no managed label", other)
		}
	}
}

func TestLabelValueReadsEitherKey(t *testing.T) {
	if labelValue(map[string]string{"wiolett.gateway.managed-database.id": "db1"}, managedDatabaseLabel) != "db1" {
		t.Fatal("pre-Opfield key not read")
	}
	if labelValue(map[string]string{"wiolett.gateway.managed-database.id": "old", managedDatabaseLabel: "new"}, managedDatabaseLabel) != "new" {
		t.Fatal("the Opfield key wins")
	}
	if !hasLegacyLabels(map[string]string{"com.wiolett.gateway.managed-volume": "true"}) || hasLegacyLabels(map[string]string{managedVolumeLabel: "true"}) {
		t.Fatal("hasLegacyLabels")
	}
	normalized := withOpfieldLabels(map[string]string{"wiolett.gateway.deployment.id": "d", "app": "x"})
	if normalized[deploymentIDLabel] != "d" || normalized["wiolett.gateway.deployment.id"] != "d" || normalized["app"] != "x" {
		t.Fatalf("withOpfieldLabels = %v", normalized)
	}
	if cleaned := withoutLegacyLabels(normalized); len(cleaned) != 2 || cleaned[deploymentIDLabel] != "d" {
		t.Fatalf("withoutLegacyLabels = %v", cleaned)
	}
}

// Before the start is confirmed the launcher can roll back to a daemon that reads
// only the old keys: creates write both. Afterwards only the Opfield keys, and a
// recreate converts old keys.
func TestCreateLabelsFollowTheConfirmation(t *testing.T) {
	labels := map[string]string{deploymentIDLabel: "d", "wiolett.gateway.availability.policy": "p", "app": "x"}
	before := labelsForCreate(labels, false)
	for _, key := range []string{deploymentIDLabel, "wiolett.gateway.deployment.id", availabilityPolicyLabel, "wiolett.gateway.availability.policy", "app"} {
		if _, ok := before[key]; !ok {
			t.Fatalf("unconfirmed create lacks %s: %v", key, before)
		}
	}
	after := labelsForCreate(labels, true)
	if len(after) != 3 || after[deploymentIDLabel] != "d" || after[availabilityPolicyLabel] != "p" || after["app"] != "x" {
		t.Fatalf("confirmed create = %v", after)
	}
}

type recordedTransport struct {
	requests []*http.Request
	bodies   []string
	respond  func(*http.Request) (int, string)
}

func (r *recordedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	body := ""
	if request.Body != nil {
		data, _ := io.ReadAll(request.Body)
		body = string(data)
	}
	r.requests = append(r.requests, request)
	r.bodies = append(r.bodies, body)
	code, out := r.respond(request)
	return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(out)), Request: request}, nil
}

func TestLabelTransport(t *testing.T) {
	base := &recordedTransport{respond: func(request *http.Request) (int, string) {
		switch {
		case strings.HasSuffix(request.URL.Path, "/containers/json"):
			if strings.Contains(request.URL.Query().Get("filters"), "wiolett.gateway.managed-database.id") {
				return 200, `[{"Id":"old","Labels":{"wiolett.gateway.managed-database.id":"db1"},"SizeRw":9007199254740993},{"Id":"both","Labels":{"net.opfield.managed-database.id":"db1"}}]`
			}
			return 200, `[{"Id":"new","Labels":{"net.opfield.managed-database.id":"db1"}},{"Id":"both","Labels":{"net.opfield.managed-database.id":"db1"}}]`
		case strings.HasSuffix(request.URL.Path, "/json"):
			return 200, `{"Id":"c","Config":{"Labels":{"wiolett.gateway.deployment.id":"d","app":"<x>"}},"HostConfig":{"Memory":9007199254740993}}`
		default:
			return 201, `{"Id":"created"}`
		}
	}}
	confirmed := false
	transport := &labelTransport{base: base, confirmed: func() bool { return confirmed }}
	client := &http.Client{Transport: transport}

	filters, _ := json.Marshal(map[string]map[string]bool{"label": {managedDatabaseLabel + "=db1": true}})
	response, err := client.Get("http://docker/v1.47/containers/json?all=1&filters=" + url.QueryEscape(string(filters)))
	if err != nil {
		t.Fatal(err)
	}
	var listed []struct {
		ID     string            `json:"Id"`
		Labels map[string]string `json:"Labels"`
		SizeRw json.Number       `json:"SizeRw"`
	}
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, item := range listed {
		ids = append(ids, item.ID)
		if item.Labels[managedDatabaseLabel] != "db1" {
			t.Fatalf("%s not normalized: %v", item.ID, item.Labels)
		}
		if item.ID == "old" && item.SizeRw.String() != "9007199254740993" {
			t.Fatalf("number changed: %s", item.SizeRw)
		}
	}
	if !slices.Equal(ids, []string{"new", "both", "old"}) {
		t.Fatalf("merged list = %v", ids)
	}

	response, err = client.Get("http://docker/v1.47/containers/abc/json")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(data), `"net.opfield.deployment.id":"d"`) || !strings.Contains(string(data), `"<x>"`) || !strings.Contains(string(data), "9007199254740993") {
		t.Fatalf("inspect = %s", data)
	}

	create := func() map[string]string {
		body := `{"Image":"x","Labels":{"net.opfield.managed":"secure-link","wiolett.gateway.archive.id":"a"}}`
		response, err := client.Post("http://docker/v1.47/containers/create?name=x", "application/json", bytes.NewBufferString(body))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		var sent struct{ Labels map[string]string }
		if err := json.Unmarshal([]byte(base.bodies[len(base.bodies)-1]), &sent); err != nil {
			t.Fatal(err)
		}
		return sent.Labels
	}
	if sent := create(); len(sent) != 4 {
		t.Fatalf("unconfirmed create sent %v", sent)
	}
	confirmed = true
	if sent := create(); len(sent) != 2 || sent["net.opfield.archive.id"] != "a" || sent["net.opfield.managed"] != "secure-link" {
		t.Fatalf("confirmed create sent %v", sent)
	}
}

func TestComposeLabelFamilyOfALegacyProject(t *testing.T) {
	document := []byte("services:\n  web:\n    labels:\n      app: x\n      net.opfield.compose.managed: \"true\"\n      net.opfield.compose.project-id: p\n      net.opfield.compose.revision: r\n")
	out := string(composeYAMLWithLegacyLabels(document))
	if strings.Contains(out, "net.opfield.compose.") || !strings.Contains(out, "wiolett.gateway.compose.project-id: p") || !strings.Contains(out, "app: x") {
		t.Fatalf("legacy family:\n%s", out)
	}
}

func TestBootUnitsGuardAndRetireTheLegacyOnes(t *testing.T) {
	var commands []string
	host := volumeImageBootHost{
		systemd: true, systemdDir: t.TempDir(), openrcDir: t.TempDir(), runlevels: t.TempDir(),
		run: func(name string, args ...string) error {
			commands = append(commands, name+" "+strings.Join(args, " "))
			return nil
		},
	}
	legacyPath := filepath.Join(host.systemdDir, legacyVolumeImageBootService+".service")
	if err := os.WriteFile(legacyPath, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installVolumeImageBootUnit(host, "/usr/local/bin/docker-daemon", "/var/lib/docker-daemon"); err != nil {
		t.Fatal(err)
	}
	unit, _ := os.ReadFile(filepath.Join(host.systemdDir, volumeImageBootService+".service"))
	if !strings.Contains(string(unit), "ConditionPathExists=!"+legacyPath) {
		t.Fatalf("new unit lacks the guard:\n%s", unit)
	}
	if _, err := os.Stat(legacyPath); err != nil || legacyBootUnits(host) != 1 {
		t.Fatal("the old unit stays until the start is confirmed")
	}
	host.confirmed, commands = true, nil
	if err := installVolumeImageBootUnit(host, "/usr/local/bin/docker-daemon", "/var/lib/docker-daemon"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacyPath); err == nil || legacyBootUnits(host) != 0 {
		t.Fatal("old unit not removed after the confirmation")
	}
	if !slices.Contains(commands, "systemctl disable --quiet "+legacyVolumeImageBootService+".service") {
		t.Fatalf("commands %v", commands)
	}

	host.systemd, host.openrc, commands = false, true, nil
	legacyScript := filepath.Join(host.openrcDir, legacyLinkListenerBootService)
	if err := os.WriteFile(legacyScript, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(host.runlevels, "boot"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(legacyScript, filepath.Join(host.runlevels, "boot", legacyLinkListenerBootService)); err != nil {
		t.Fatal(err)
	}
	if err := installLinkListenerBootUnit(host, "/usr/local/bin/docker-daemon", "/var/lib/docker-daemon"); err != nil {
		t.Fatal(err)
	}
	script, _ := os.ReadFile(filepath.Join(host.openrcDir, linkListenerBootService))
	if !strings.Contains(string(script), "if [ -e '"+legacyScript+"' ]; then") {
		t.Fatalf("OpenRC service lacks the guard:\n%s", script)
	}
	if _, err := os.Stat(legacyScript); err == nil || !slices.Contains(commands, "rc-update del "+legacyLinkListenerBootService+" boot") {
		t.Fatalf("old OpenRC service not retired: %v", commands)
	}
}

func TestStorageConnectorEnvironmentUnderBothNames(t *testing.T) {
	dir := "/var/lib/docker-daemon/storage-relay"
	legacy := []string{"GATEWAY_CONNECTOR_BINDING_ID=11111111-2222-4333-8444-555555555555", "GATEWAY_CONNECTOR_SOCKET=/run/gateway/storage-relay.sock", "GATEWAY_CONNECTOR_LISTEN=:9000"}
	current := []string{"OPFIELD_CONNECTOR_BINDING_ID=11111111-2222-4333-8444-555555555555", "OPFIELD_CONNECTOR_SOCKET=/run/opfield/storage-relay.sock", "OPFIELD_CONNECTOR_LISTEN=:9000",
		"GATEWAY_CONNECTOR_SOCKET=/run/opfield/storage-relay.sock"}
	if !validStorageConnectorInternalWorkload(current, []string{dir + ":/run/opfield:ro"}, dir) {
		t.Fatal("an Opfield connector")
	}
	if !validStorageConnectorInternalWorkload(legacy, []string{dir + ":/run/gateway:ro"}, dir) {
		t.Fatal("a connector of a pre-Opfield control plane stays valid")
	}
	if validStorageConnectorInternalWorkload(append(current, "GATEWAY_CONNECTOR_LISTEN=:9001"), []string{dir + ":/run/opfield:ro"}, dir) {
		t.Fatal("disagreeing values under both names must be refused")
	}
	if validStorageConnectorInternalWorkload(current, []string{dir + ":/run/gateway:ro"}, dir) {
		t.Fatal("socket path must match the mount")
	}
	if connectorEnvValue(current, "BINDING_ID") != "11111111-2222-4333-8444-555555555555" || connectorEnvValue(legacy, "BINDING_ID") != "11111111-2222-4333-8444-555555555555" {
		t.Fatal("binding id under either name")
	}
}

func TestSecureLinkConnectorEnvironmentShapes(t *testing.T) {
	control := "/var/lib/docker-daemon/secure-links"
	if !validSecureLinkConnectorEnv(secureLinkConnectorEnv(0), []string{control + ":" + secureLinkConnectorMount}, 0) {
		t.Fatal("this release's connector")
	}
	legacyEnv := []string{"GATEWAY_SECURE_LINK_SOCKET=/run/gateway/secure-link.sock", secureLinkConnectorPathEnv}
	if !validSecureLinkConnectorEnv(legacyEnv, []string{control + ":/run/gateway"}, 0) {
		t.Fatal("a connector created before Opfield stays valid (no recreate)")
	}
	if validSecureLinkConnectorEnv(legacyEnv, []string{control + ":" + secureLinkConnectorMount}, 0) {
		t.Fatal("old variable with the new mount")
	}
	if connectorControlMount(control+":/run/gateway", control) == "" || connectorControlMount(control+":/elsewhere", control) != "" {
		t.Fatal("connectorControlMount")
	}
}

func TestRegistryProxyCAWithThePreOpfieldNameIsReplacedOnce(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	identity, outcome, _, err := loadOrRenewRegistryProxyIdentity(dir, now)
	if err != nil || outcome != registryProxyIdentityCARegenerated {
		t.Fatalf("first identity %v %v", outcome, err)
	}
	block, _ := pem.Decode(identity.caPEM)
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil || ca.Subject.CommonName != registryProxyCAName {
		t.Fatalf("CA subject %v %v", ca.Subject, err)
	}
	if _, outcome, _, err := loadOrRenewRegistryProxyIdentity(dir, now); err != nil || outcome != registryProxyIdentityUnchanged {
		t.Fatalf("healthy identity: %v %v", outcome, err)
	}
	// A CA issued under the pre-Opfield name is not reused.
	ca.Subject.CommonName = "Gateway Registry Proxy CA"
	if registryProxyCAReusable(ca, now) {
		t.Fatal("an old-named CA must not be reused")
	}
}
