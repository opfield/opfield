package docker

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/opfield/opfield/docker-daemon/internal/pgext"
	"golang.org/x/sys/unix"
)

const (
	testOpfieldPostgres17 = "ghcr.io/opfield/opfield/postgres@sha256:" + "9999999999999999999999999999999999999999999999999999999999999999"
	testOfficialPostgres  = "docker.io/library/postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d"
)

// withTestPostgresCatalog swaps in the real curated list with an Opfield image
// pinned for 17.10 and postgis/pgrouting bundles for PostgreSQL 17.
func withTestPostgresCatalog(t *testing.T) *pgext.Catalog {
	t.Helper()
	read := func(name string) []byte {
		data, err := os.ReadFile(filepath.Join("..", "pgext", "catalog", name))
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	versions := strings.Replace(string(read("versions.json")),
		`"base": "`+testOfficialPostgres+`", "image": null`,
		`"base": "`+testOfficialPostgres+`", "image": "`+testOpfieldPostgres17+`"`, 1)
	bundles := `{"schemaVersion":1,"bundles":[
 {"id":"postgis","version":"3.6.4","major":"17","debian":"trixie","reference":"ghcr.io/example/postgres-ext/postgis@sha256:` + strings.Repeat("1", 64) + `","sizeBytes":{"amd64":200000000,"arm64":190000000},"provides":["postgis"],"preloadLibraries":[],"requires":[]},
 {"id":"pgrouting","version":"4.0.1","major":"17","debian":"trixie","reference":"ghcr.io/example/postgres-ext/pgrouting@sha256:` + strings.Repeat("2", 64) + `","sizeBytes":{"amd64":4000000,"arm64":3900000},"provides":["pgrouting"],"preloadLibraries":[],"requires":["postgis"]}]}`
	catalog, err := pgext.Parse(read("extensions.json"), []byte(versions), []byte(bundles))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(setPostgresExtensionCatalog(catalog))
	return catalog
}

// The daemon's PostgreSQL allow-list is the catalog's, and every official base
// is a mirrored third-party image listed in config/third-party-images.json
// under its catalog version (the controller catalog agrees with the same file
// in its own test).
func TestPostgresCatalogAgreement(t *testing.T) {
	catalog, err := pgext.Default()
	if err != nil {
		t.Fatal(err)
	}
	want := catalog.PostgresImages()
	var got []string
	for image := range curatedManagedDatabaseImages["postgres"] {
		got = append(got, image)
	}
	slices.Sort(want)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("curated PostgreSQL images = %v, catalog = %v", got, want)
	}
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "config", "third-party-images.json"))
	if err != nil {
		t.Fatal(err)
	}
	var mirrors struct {
		Images []struct {
			Name   string `json:"name"`
			Tag    string `json:"tag"`
			Source string `json:"source"`
		} `json:"images"`
	}
	if err := json.Unmarshal(data, &mirrors); err != nil {
		t.Fatal(err)
	}
	for _, version := range catalog.Versions() {
		if _, ok := thirdPartyMirroredImages[version.Base]; !ok {
			t.Errorf("base of %s is not a mirrored third-party image", version.Version)
		}
		if !slices.ContainsFunc(mirrors.Images, func(image struct {
			Name   string `json:"name"`
			Tag    string `json:"tag"`
			Source string `json:"source"`
		}) bool {
			return image.Name == "postgres" && image.Tag == version.Version && image.Source == version.Base
		}) {
			t.Errorf("config/third-party-images.json has no postgres:%s = %s", version.Version, version.Base)
		}
	}
}

func postgresExtensionCommand(image string, libraries, bundles []string) managedDatabaseCommand {
	return managedDatabaseCommand{
		Type: "postgres", Image: image, DatabaseName: "app",
		PostgresConfig: &managedPostgresConfig{SharedPreloadLibraries: libraries, ExtensionBundles: bundles},
	}
}

func TestValidatePostgresExtensionConfig(t *testing.T) {
	withTestPostgresCatalog(t)
	for name, tc := range map[string]struct {
		input managedDatabaseCommand
		code  string
	}{
		"contrib library on the official image": {postgresExtensionCommand(testOfficialPostgres, []string{"pg_stat_statements"}, nil), ""},
		"baked library on the official image":   {postgresExtensionCommand(testOfficialPostgres, []string{"pg_cron"}, nil), extensionNeedsImageUpdateCode},
		"bundle on the official image":          {postgresExtensionCommand(testOfficialPostgres, nil, []string{"postgis"}), extensionNeedsImageUpdateCode},
		"baked library on our image":            {postgresExtensionCommand(testOpfieldPostgres17, []string{"pg_cron", "pg_stat_statements"}, nil), ""},
		"bundle on our image":                   {postgresExtensionCommand(testOpfieldPostgres17, nil, []string{"pgrouting"}), ""},
		"unknown library":                       {postgresExtensionCommand(testOpfieldPostgres17, []string{"auto_explain"}, nil), extensionNotAllowedCode},
		"unknown bundle":                        {postgresExtensionCommand(testOpfieldPostgres17, nil, []string{"timescaledb"}), extensionNotAllowedCode},
	} {
		err := validatePostgresExtensionConfig(tc.input)
		switch {
		case tc.code == "" && err != nil:
			t.Errorf("%s: %v", name, err)
		case tc.code != "" && (err == nil || !strings.HasPrefix(err.Error(), tc.code+":")):
			t.Errorf("%s: err = %v, want %s", name, err, tc.code)
		}
	}
}

// Preload libraries start the server in load order with the settings they
// need, on single-node and member containers alike, and a change of them is a
// setting fixed at container creation.
func TestPostgresPreloadFlagsAndRecreate(t *testing.T) {
	withTestPostgresCatalog(t)
	input := postgresExtensionCommand(testOpfieldPostgres17, []string{"pg_cron", "pg_stat_kcache", "pg_stat_statements"}, nil)
	got := strings.Join(managedPostgresExtensionFlags(input), " ")
	want := "-c shared_preload_libraries=pg_stat_statements,pg_stat_kcache,pg_cron -c cron.database_name=app"
	if got != want {
		t.Fatalf("flags = %q, want %q", got, want)
	}
	if command := strings.Join(managedPostgresCommand(input), " "); !strings.Contains(command, want) || !strings.HasPrefix(command, "postgres ") {
		t.Fatalf("engine command %q", command)
	}
	if managedPostgresCommand(managedDatabaseCommand{Type: "postgres"}) != nil {
		t.Fatal("a database without settings keeps the image's command")
	}
	record := managedDatabaseRecord{Type: "postgres", PostgresPreloadLibraries: managedPostgresPreloadKey(input)}
	if managedDatabaseContainerSettingsChanged(record, input) {
		t.Fatal("the same preload libraries must not recreate the container")
	}
	if !managedDatabaseContainerSettingsChanged(record, postgresExtensionCommand(testOpfieldPostgres17, []string{"pg_stat_statements"}, nil)) {
		t.Fatal("other preload libraries must recreate the container")
	}
	squeeze := strings.Join(managedPostgresExtensionFlags(postgresExtensionCommand(testOpfieldPostgres17, []string{"pg_squeeze"}, nil)), " ")
	if squeeze != "-c shared_preload_libraries=pg_squeeze -c wal_level=logical" {
		t.Fatalf("pg_squeeze flags = %q", squeeze)
	}
}

type testBundleFile struct {
	path, content, target string
}

func testBundleArchive(t *testing.T, files []testBundleFile, extra func(*tar.Writer)) (*bytes.Buffer, pgBundleManifest) {
	t.Helper()
	manifest := pgBundleManifest{SchemaVersion: 1}
	var buf bytes.Buffer
	writer := tar.NewWriter(&buf)
	_ = writer.WriteHeader(&tar.Header{Name: "files/", Typeflag: tar.TypeDir, Mode: 0o755})
	for _, file := range files {
		if file.target != "" {
			_ = writer.WriteHeader(&tar.Header{Name: "files/" + file.path, Typeflag: tar.TypeSymlink, Linkname: file.target})
			manifest.Files = append(manifest.Files, pgBundleEntry{Path: file.path, Type: "symlink", Target: file.target})
			continue
		}
		sum := sha256.Sum256([]byte(file.content))
		_ = writer.WriteHeader(&tar.Header{Name: "files/" + file.path, Typeflag: tar.TypeReg, Mode: 0o4755, Size: int64(len(file.content))})
		_, _ = writer.Write([]byte(file.content))
		manifest.Files = append(manifest.Files, pgBundleEntry{Path: file.path, Type: "file", Size: int64(len(file.content)), Mode: "4755", SHA256: hex.EncodeToString(sum[:])})
		manifest.SizeBytes += int64(len(file.content))
	}
	if extra != nil {
		extra(writer)
	}
	_ = writer.Close()
	return &buf, manifest
}

var testBundleFiles = []testBundleFile{
	{path: "usr/lib/postgresql/17/lib/postgis-3.so", content: "ELF"},
	{path: "usr/share/postgresql/17/extension/postgis.control", content: "default_version = '3.6.4'"},
	{path: "usr/lib/x86_64-linux-gnu/libgeos.so.3.13.1", content: "geos"},
	{path: "usr/lib/x86_64-linux-gnu/libgeos.so", target: "libgeos.so.3.13.1"},
}

func TestExtractPostgresBundleFilesVerifies(t *testing.T) {
	archive, manifest := testBundleArchive(t, testBundleFiles, nil)
	dest := filepath.Join(t.TempDir(), "files")
	if err := extractPostgresBundleFiles(archive, dest, manifest); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dest, "usr/lib/postgresql/17/lib/postgis-3.so"))
	if err != nil || info.Mode().Perm() != 0o755 || info.Mode()&os.ModeSetuid != 0 {
		t.Fatalf("library mode %v, %v", info, err)
	}
	if target, err := os.Readlink(filepath.Join(dest, "usr/lib/x86_64-linux-gnu/libgeos.so")); err != nil || target != "libgeos.so.3.13.1" {
		t.Fatalf("link = %q, %v", target, err)
	}

	refused := map[string]func() (*bytes.Buffer, pgBundleManifest){
		"tampered file": func() (*bytes.Buffer, pgBundleManifest) {
			archive, manifest := testBundleArchive(t, testBundleFiles, nil)
			manifest.Files[0].SHA256 = strings.Repeat("0", 64)
			return archive, manifest
		},
		"file outside the manifest": func() (*bytes.Buffer, pgBundleManifest) {
			return testBundleArchive(t, testBundleFiles, func(writer *tar.Writer) {
				_ = writer.WriteHeader(&tar.Header{Name: "files/usr/lib/extra.so", Typeflag: tar.TypeReg, Mode: 0o644, Size: 1})
				_, _ = writer.Write([]byte("x"))
			})
		},
		"missing file": func() (*bytes.Buffer, pgBundleManifest) {
			archive, manifest := testBundleArchive(t, testBundleFiles, nil)
			manifest.Files = append(manifest.Files, pgBundleEntry{Path: "usr/lib/missing.so", Type: "file", Size: 1, Mode: "644", SHA256: strings.Repeat("0", 64)})
			return archive, manifest
		},
		"path outside usr": func() (*bytes.Buffer, pgBundleManifest) {
			return testBundleArchive(t, []testBundleFile{{path: "etc/ld.so.preload", content: "/evil.so"}}, nil)
		},
		"link out of the bundle": func() (*bytes.Buffer, pgBundleManifest) {
			return testBundleArchive(t, []testBundleFile{{path: "usr/lib/x86_64-linux-gnu/libc.so", target: "../../../etc/shadow"}}, nil)
		},
	}
	for name, build := range refused {
		archive, manifest := build()
		if err := extractPostgresBundleFiles(archive, filepath.Join(t.TempDir(), "files"), manifest); err == nil {
			t.Errorf("%s: extracted", name)
		}
	}
}

func TestCheckPostgresBundleManifestMatchesThePin(t *testing.T) {
	catalog := withTestPostgresCatalog(t)
	bundle, _ := catalog.Bundle("postgis", "17", "trixie")
	manifest := pgBundleManifest{SchemaVersion: 1, ID: "postgis", Version: "3.6.4", Major: "17", Debian: "trixie", Arch: "arm64",
		SizeBytes: 190000000, Files: []pgBundleEntry{{Path: "usr/lib/a.so", Type: "file"}}}
	if err := checkPostgresBundleManifest(manifest, bundle, "arm64"); err != nil {
		t.Fatal(err)
	}
	for name, edit := range map[string]func(*pgBundleManifest){
		"other arch":  func(m *pgBundleManifest) { m.Arch = "amd64" },
		"other major": func(m *pgBundleManifest) { m.Major = "16" },
		"other size":  func(m *pgBundleManifest) { m.SizeBytes++ },
		"no files":    func(m *pgBundleManifest) { m.Files = nil },
	} {
		changed := manifest
		edit(&changed)
		if err := checkPostgresBundleManifest(changed, bundle, "arm64"); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func statfsWith(blockSize int64, blocks, available uint64) func(string, *unix.Statfs_t) error {
	return func(_ string, stat *unix.Statfs_t) error {
		stat.Bsize = blockSize
		stat.Blocks, stat.Bfree, stat.Bavail = blocks, available, available
		return nil
	}
}

func TestInstallBundlesRefusesAFullVolume(t *testing.T) {
	withTestPostgresCatalog(t)
	previousStatfs, previousArch := managedDatabaseDiskStatfs, pgBundleArch
	t.Cleanup(func() { managedDatabaseDiskStatfs, pgBundleArch = previousStatfs, previousArch })
	pgBundleArch = "amd64"
	managedDatabaseDiskStatfs = statfsWith(4096, 100000, 50000) // about 200 MB free
	m := &managedDatabaseManager{}
	record := managedDatabaseRecord{ID: "db1", Type: "postgres", MountPath: t.TempDir()}
	_, err := m.installPostgresExtensionBundles(t.Context(), &record, postgresExtensionCommand(testOpfieldPostgres17, nil, []string{"pgrouting"}))
	if err == nil || !strings.HasPrefix(err.Error(), extensionNeedsStorageCode+": needs 211 MB, 195 MB free") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(record.MountPath, pgExtensionsDirName)); !os.IsNotExist(err) {
		t.Fatal("nothing may be written before the space check passes")
	}
}

func TestPostgresExtensionSQLErrorCodes(t *testing.T) {
	for stderr, code := range map[string]string{
		"psql:<stdin>:3: ERROR:  2BP01: cannot drop extension cube because other objects depend on it\nDETAIL:  extension earthdistance depends on extension cube\nHINT:  Use DROP ... CASCADE.\n": extensionHasDependentsCode,
		"ERROR:  25006: cannot execute CREATE EXTENSION in a read-only transaction\n":                                                                                                              extensionNotPrimaryCode,
		"ERROR:  55000: unrecognized configuration parameter\nDETAIL:  pg_cron can only be loaded via shared_preload_libraries\n":                                                                  extensionNeedsPreloadCode,
		"ERROR:  58P01: could not open extension control file \"/usr/share/postgresql/17/extension/postgis.control\"\n":                                                                            extensionNotAvailableCode,
		"ERROR:  42501: permission denied\n": extensionFailedCode,
		"psql: error: connection refused\n":  extensionFailedCode,
	} {
		if err := postgresExtensionSQLError(stderr); !strings.HasPrefix(err.Error(), code+":") {
			t.Errorf("%q -> %v, want %s", stderr, err, code)
		}
	}
	err := postgresExtensionSQLError("ERROR:  2BP01: cannot drop extension cube because other objects depend on it\nDETAIL:  extension earthdistance depends on extension cube\n")
	if !strings.Contains(err.Error(), "earthdistance depends on extension cube") {
		t.Fatalf("details are lost: %v", err)
	}
}

func TestPostgresExtensionStatus(t *testing.T) {
	catalog := withTestPostgresCatalog(t)
	v := func(value string) *string { return &value }
	postgis, _ := catalog.Extension("postgis")
	vector, _ := catalog.Extension("vector")
	trgm, _ := catalog.Extension("pg_trgm")
	for name, tc := range map[string]struct {
		got, want string
	}{
		"enabled":             {postgresExtensionStatus(vector, v("0.8.1"), v("0.8.1"), pgext.ImageOpfield, false, false), "enabled"},
		"update":              {postgresExtensionStatus(vector, v("0.8.1"), v("0.8.0"), pgext.ImageOpfield, false, false), "update_available"},
		"contrib on official": {postgresExtensionStatus(trgm, v("1.6"), nil, pgext.ImageOfficial, false, false), "available"},
		"baked on official":   {postgresExtensionStatus(vector, nil, nil, pgext.ImageOfficial, false, false), "needs_image_update"},
		"bundle pinned":       {postgresExtensionStatus(postgis, nil, nil, pgext.ImageOpfield, true, false), "needs_bundle"},
		"bundle installed":    {postgresExtensionStatus(postgis, v("3.6.4"), nil, pgext.ImageOpfield, true, true), "available"},
		"bundle not pinned":   {postgresExtensionStatus(postgis, nil, nil, pgext.ImageOpfield, false, false), "unavailable"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s: status %s, want %s", name, tc.got, tc.want)
		}
	}
}

func TestPostgresExtensionDDL(t *testing.T) {
	enable := postgresExtensionDDL(postgresExtensionApplyCommand{Action: "enable", Name: "uuid-ossp", ApplicationPrincipalName: "app_owner"}, []string{"uuid-ossp", "pg_cron"})
	for _, part := range []string{"RESET ROLE;", `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" CASCADE;`, "application_role text := 'app_owner'", "GRANT USAGE ON SCHEMA", "e.extname IN ('uuid-ossp', 'pg_cron')"} {
		if !strings.Contains(enable, part) {
			t.Errorf("enable script lacks %q:\n%s", part, enable)
		}
	}
	disable := postgresExtensionDDL(postgresExtensionApplyCommand{Action: "disable", Name: "cube", ApplicationPrincipalName: "app_owner"}, []string{"cube"})
	if !strings.Contains(disable, `DROP EXTENSION IF EXISTS "cube" RESTRICT;`) || strings.Contains(disable, "CASCADE") || strings.Contains(disable, "GRANT") {
		t.Fatalf("disable script:\n%s", disable)
	}
	if update := postgresExtensionDDL(postgresExtensionApplyCommand{Action: "update", Name: "vector"}, nil); !strings.Contains(update, `ALTER EXTENSION "vector" UPDATE;`) || strings.Contains(update, "GRANT") {
		t.Fatalf("update script:\n%s", update)
	}
}
