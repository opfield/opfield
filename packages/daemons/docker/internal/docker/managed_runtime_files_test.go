package docker

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// A storage engine whose staged runtime files were lost is not started (it
// would exit at once and be started again for ever) until a restart from
// Opfield brings the files back.
func TestStorageEngineWithLostRuntimeFilesWaitsForRestage(t *testing.T) {
	loops := newFakeLoops(t)
	root := t.TempDir()
	docker := &fakeEngineDocker{t: t, calls: &loops.calls, running: map[string]bool{"s1": false}, policy: map[string]string{}}
	m := &managedStorageManager{root: root, logger: slog.New(slog.DiscardHandler), loops: loops.host(), client: docker.client(),
		chown: func(string, int, int) error { return nil }}
	if err := os.MkdirAll(filepath.Join(root, "storage", "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	const id = "11111111-1111-4111-8111-111111111111"
	record := managedStorageRecord{
		ID: id, Engine: managedStorageEngineSeaweedFS, ContainerID: "s1", DesiredRunning: true, TLSEnabled: true,
		ImagePath: filepath.Join(root, "storage", "images", id+"-0.img"),
		MountPath: filepath.Join(root, "storage", "mounts", id+"-0"),
	}
	writeFile(t, record.ImagePath)
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	// The staged tree is sealed read-only.
	t.Cleanup(func() { _ = removeStagingTree(m.seaweedfsStagingDir(record)) })
	ctx := context.Background()

	err := m.startStoppedEngine(ctx, id, "")
	if err == nil || !strings.Contains(err.Error(), "config/s3.json") || !strings.Contains(err.Error(), "tls/private.key") {
		t.Fatalf("error = %v, want the missing runtime files named", err)
	}
	if slices.Contains(loops.calls, "start s1") {
		t.Fatal("engine started without its runtime files")
	}
	detail, err := m.marshalManagedStorageDetail(ctx, record, m.storageStatus(ctx, record))
	if err != nil {
		t.Fatal(err)
	}
	var inspected struct {
		Status         string   `json:"status"`
		RuntimeMissing []string `json:"runtimeMissing"`
	}
	if err := json.Unmarshal([]byte(detail), &inspected); err != nil {
		t.Fatal(err)
	}
	if inspected.Status != "stopped" || len(inspected.RuntimeMissing) != 6 {
		t.Fatalf("inspect = %s, want stopped with the six missing files", detail)
	}

	// A restart without settings (an older Opfield) cannot restage them.
	if _, err := m.handle(ctx, "restart", id, ""); err == nil || !strings.Contains(err.Error(), "runtime files are missing") {
		t.Fatalf("restart without settings: error = %v", err)
	}
	payload, _ := json.Marshal(map[string]any{
		"version": 2, "engine": managedStorageEngineSeaweedFS, "memberIndex": 0,
		"rootCredentials": map[string]string{"accessKey": "gateway-root", "secretKey": "root-secret-key"},
		"tls":             map[string]string{"certPem": "CERT", "keyPem": "KEY", "caPem": "CA", "serverName": "storage.test"},
	})
	if _, err := m.handle(ctx, "restart", id, string(payload)); err != nil {
		t.Fatal(err)
	}
	if missing := m.missingRuntimeFiles(record); len(missing) != 0 {
		t.Fatalf("still missing after the restart: %v", missing)
	}
	if !docker.running["s1"] {
		t.Fatal("engine not started after its runtime files were restaged")
	}
	accessKey, secretKey, err := m.readSeaweedFSRootCredentials(record)
	if err != nil || accessKey != "gateway-root" || secretKey != "root-secret-key" {
		t.Fatalf("staged root identity = %q/%q, %v", accessKey, secretKey, err)
	}
}

// A database engine whose TLS files were lost is not started until they are
// restaged from Opfield's settings.
func TestDatabaseEngineWithLostTLSFilesWaitsForRestage(t *testing.T) {
	previousChown := managedDatabaseChown
	managedDatabaseChown = func(string, int, int) error { return nil }
	t.Cleanup(func() { managedDatabaseChown = previousChown })
	loops := newFakeLoops(t)
	m := newTestDatabaseManager(t, loops)
	docker := &fakeEngineDocker{t: t, calls: &loops.calls, running: map[string]bool{"c1": false}, policy: map[string]string{}}
	m.client = docker.client()
	record := saveTestDatabase(t, m, "db1")
	record.Type, record.ContainerID, record.TLSEnabled = "postgres", "c1", true
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	if err := m.startStoppedEngine(ctx, "db1", "c1"); err == nil || !strings.Contains(err.Error(), "key.pem") {
		t.Fatalf("error = %v, want the missing TLS files named", err)
	}
	if docker.running["c1"] {
		t.Fatal("engine started without its TLS files")
	}
	input := managedDatabaseCommand{Type: "postgres", TLSEnabled: true, TLSCertificatePEM: "CERT", TLSPrivateKeyPEM: "KEY", TLSCACertificatePEM: "CA"}
	missing, err := m.restageRuntimeFiles(record, &input)
	if err != nil || len(missing) != 0 {
		t.Fatalf("restage: missing %v, error %v", missing, err)
	}
	if key, _ := os.ReadFile(filepath.Join(m.tlsDirectory(record), "key.pem")); string(key) != "KEY" {
		t.Fatalf("key.pem = %q", key)
	}
	if err := m.startStoppedEngine(ctx, "db1", "c1"); err != nil {
		t.Fatal(err)
	}
	if !docker.running["c1"] {
		t.Fatal("engine not started after its TLS files were restaged")
	}
}
