package pgext

import (
	"bufio"
	"os"
	"slices"
	"strings"
	"testing"
)

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// listIDs reads the first column of a build list (baked.list, bundles.list).
func listIDs(t *testing.T, path string) []string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var ids []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		ids = append(ids, fields[0])
	}
	return ids
}

const testBundles = `{"schemaVersion":1,"bundles":[
 {"id":"postgis","version":"3.6.4","major":"17","debian":"trixie","reference":"ghcr.io/example/postgres-ext/postgis@sha256:` + "1111111111111111111111111111111111111111111111111111111111111111" + `","sizeBytes":{"amd64":200000000,"arm64":190000000},"provides":["postgis","postgis_raster"],"preloadLibraries":[],"requires":[]},
 {"id":"pgrouting","version":"4.0.1","major":"17","debian":"trixie","reference":"ghcr.io/example/postgres-ext/pgrouting@sha256:` + "2222222222222222222222222222222222222222222222222222222222222222" + `","sizeBytes":{"amd64":4000000,"arm64":3900000},"provides":["pgrouting"],"preloadLibraries":[],"requires":["postgis"]}
]}`

func testCatalog(t *testing.T) *Catalog {
	t.Helper()
	catalog, err := Parse(mustRead(t, "catalog/extensions.json"), mustRead(t, "catalog/versions.json"), []byte(testBundles))
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestDefaultCatalogIsValid(t *testing.T) {
	catalog, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Versions()) != 10 {
		t.Fatalf("versions = %d, want the 10 catalog versions", len(catalog.Versions()))
	}
	for _, version := range catalog.Versions() {
		if info := catalog.Image(version.Base); info.Kind != ImageOfficial || info.Version.Version != version.Version {
			t.Fatalf("base of %s resolves to %+v", version.Version, info)
		}
	}
	if catalog.Image("docker.io/library/postgres@sha256:"+strings.Repeat("0", 64)).Kind != ImageOther {
		t.Fatal("an unknown digest must be another image")
	}
}

// The curated list, the build lists and the image follow the brief: baked
// extensions come from baked.list, bundle ids are bundles.list's, every
// library's delivery is its extension's, and the never-exposed names stay out.
func TestCatalogAgreesWithTheBuildLists(t *testing.T) {
	catalog, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	bundleIDs := listIDs(t, "../../../postgres-image/bundle/bundles.list")
	slices.Sort(bundleIDs)
	if got := catalog.BundleIDs(); !slices.Equal(got, bundleIDs) {
		t.Fatalf("bundle ids of extensions.json = %v, bundles.list = %v", got, bundleIDs)
	}
	baked := listIDs(t, "../../../postgres-image/image/baked.list")
	if len(baked) == 0 {
		t.Fatal("baked.list is empty")
	}
	for _, extension := range catalog.Extensions() {
		if extension.Delivery == DeliveryBaked && extension.BundleID() == "" && !slices.Contains(baked, extension.Name) &&
			!slices.Contains(baked, "pg"+extension.Name) && extension.Name != "h3_postgis" {
			t.Errorf("baked extension %s has no baked.list entry", extension.Name)
		}
		for _, library := range extension.PreloadLibraries {
			if other, ok := catalog.Extension(library); ok {
				lib, _ := catalog.PreloadLibrary(library)
				if lib.Delivery != other.Delivery {
					t.Errorf("preload library %s is %s, its extension is %s", library, lib.Delivery, other.Delivery)
				}
			}
		}
	}
	for _, name := range []string{"file_fdw", "adminpack", "pageinspect", "pg_surgery", "plperlu", "plpython3u", "xml2", "sepgsql", "timescaledb", "citus"} {
		if _, ok := catalog.Extension(name); ok {
			t.Errorf("%s must never be exposed", name)
		}
		if !slices.Contains(catalog.NeverExposed(), name) {
			t.Errorf("%s is missing from neverExposed", name)
		}
	}
}

func TestCanonicalPreloadOrdersAndRefuses(t *testing.T) {
	catalog := testCatalog(t)
	got, err := catalog.CanonicalPreload([]string{"pg_cron", "pg_stat_kcache", "pg_stat_statements", "pg_cron"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"pg_stat_statements", "pg_stat_kcache", "pg_cron"}; !slices.Equal(got, want) {
		t.Fatalf("canonical = %v, want %v", got, want)
	}
	if _, err := catalog.CanonicalPreload([]string{"auto_explain"}); err == nil {
		t.Fatal("an unlisted library must be refused")
	}
	settings := catalog.PreloadSettings([]string{"pg_stat_statements", "pg_cron"}, "app")
	if settings["cron.database_name"] != "app" || len(settings) != 1 {
		t.Fatalf("settings = %v", settings)
	}
}

func TestBundleClosureResolvesRequiresFirst(t *testing.T) {
	catalog := testCatalog(t)
	closure, err := catalog.BundleClosure([]string{"pgrouting"}, "17", "trixie")
	if err != nil {
		t.Fatal(err)
	}
	if len(closure) != 2 || closure[0].ID != "postgis" || closure[1].ID != "pgrouting" {
		t.Fatalf("closure = %+v", closure)
	}
	if closure[1].Dir("arm64") != "4.0.1-pg17-trixie-arm64" {
		t.Fatalf("dir = %s", closure[1].Dir("arm64"))
	}
	if _, err := catalog.BundleClosure([]string{"postgis"}, "16", "trixie"); err == nil {
		t.Fatal("a bundle without a build for the major must be refused")
	} else if _, ok := err.(*BundleUnavailableError); !ok {
		t.Fatalf("err = %v, want BundleUnavailableError", err)
	}
	if _, err := catalog.BundleClosure([]string{"timescaledb"}, "17", "trixie"); err == nil {
		t.Fatal("an unknown bundle must be refused")
	}
}

func TestParseRefusesBrokenManifests(t *testing.T) {
	extensions := mustRead(t, "catalog/extensions.json")
	versions := mustRead(t, "catalog/versions.json")
	cases := map[string][3]string{
		"never exposed listed": {strings.Replace(string(extensions), `"name": "vector"`, `"name": "file_fdw"`, 1), string(versions), `{"schemaVersion":1,"bundles":[]}`},
		"unknown library":      {strings.Replace(string(extensions), `"preloadLibraries": ["pg_cron"]`, `"preloadLibraries": ["auto_explain"]`, 1), string(versions), `{"schemaVersion":1,"bundles":[]}`},
		"repeated digest":      {string(extensions), strings.Replace(string(versions), "7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db", "3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a", 1), `{"schemaVersion":1,"bundles":[]}`},
		"bundle without size":  {string(extensions), string(versions), strings.Replace(testBundles, `"arm64":3900000`, `"arm64":0`, 1)},
		"unused bundle":        {string(extensions), string(versions), strings.Replace(testBundles, `"id":"pgrouting"`, `"id":"pgunknown"`, 1)},
	}
	for name, files := range cases {
		if _, err := Parse([]byte(files[0]), []byte(files[1]), []byte(files[2])); err == nil {
			t.Errorf("%s: parse succeeded", name)
		}
	}
}
