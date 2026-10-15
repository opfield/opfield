// Package pgext is the managed PostgreSQL extension catalog of the docker
// daemon: the curated extensions Opfield offers (and the only ones the daemon
// runs DDL for), the catalog versions with their official and Opfield images,
// and the pinned downloadable extension bundles. The three manifests under
// catalog/ are the single source of truth; the controller keeps copies that its
// tests compare with them.
package pgext

import (
	"embed"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"
)

//go:embed catalog/extensions.json catalog/versions.json catalog/bundles.json
var catalogFiles embed.FS

// Deliveries of an extension.
const (
	DeliveryContrib = "contrib" // in the official image
	DeliveryBaked   = "baked"   // in Opfield's image
	DeliveryBundle  = "bundle"  // downloaded into the database's volume
)

// Image kinds.
const (
	ImageOpfield  = "opfield"
	ImageOfficial = "official"
	ImageOther    = "other"
)

// DatabaseNamePlaceholder in a preload library setting is replaced by the
// instance's application database.
const DatabaseNamePlaceholder = "{databaseName}"

var (
	extensionNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,62}$`)
	digestPattern        = regexp.MustCompile(`@(sha256:[a-f0-9]{64})$`)
	versionPattern       = regexp.MustCompile(`^[0-9]+\.[0-9]+$`)
	debianPattern        = regexp.MustCompile(`^[a-z]+$`)
	bundleVersionPattern = regexp.MustCompile(`^[0-9A-Za-z.]+$`)
	categories           = []string{"ai_search", "geo", "scheduling_partitioning", "observability_tuning", "data_types", "text_search", "foreign_data", "maintenance", "other"}
	allowedSettings      = map[string]bool{"cron.database_name": true}
	// Architectures bundles are built for (Docker's names, as runtime.GOARCH).
	Architectures = []string{"amd64", "arm64"}
)

// Extension is one curated extension.
type Extension struct {
	Name             string   `json:"name"`
	Category         string   `json:"category"`
	Description      string   `json:"description"`
	Delivery         string   `json:"delivery"`
	Bundle           *string  `json:"bundle"`
	PreloadLibraries []string `json:"preloadLibraries"`
	Notes            string   `json:"notes"`
}

// BundleID is the bundle the extension needs, or "".
func (e Extension) BundleID() string {
	if e.Bundle == nil {
		return ""
	}
	return *e.Bundle
}

// PreloadLibrary is a shared_preload_libraries entry an extension needs, with
// the server settings the daemon adds while it is loaded.
type PreloadLibrary struct {
	Name     string            `json:"name"`
	Delivery string            `json:"delivery"`
	Settings map[string]string `json:"settings"`
}

// Version is one catalog version.
type Version struct {
	Version string  `json:"version"`
	Major   string  `json:"major"`
	Debian  string  `json:"debian"`
	Base    string  `json:"base"`
	Image   *string `json:"image"`
}

// OpfieldImage is the version's Opfield image, or "" before the pin.
func (v Version) OpfieldImage() string {
	if v.Image == nil {
		return ""
	}
	return *v.Image
}

// Bundle is one pinned downloadable bundle build.
type Bundle struct {
	ID               string           `json:"id"`
	Version          string           `json:"version"`
	Major            string           `json:"major"`
	Debian           string           `json:"debian"`
	Reference        string           `json:"reference"`
	SizeBytes        map[string]int64 `json:"sizeBytes"`
	Provides         []string         `json:"provides"`
	PreloadLibraries []string         `json:"preloadLibraries"`
	Requires         []string         `json:"requires"`
}

// Dir is the bundle's directory name under <volume>/extensions/<id>/ on arch.
func (b Bundle) Dir(arch string) string {
	return fmt.Sprintf("%s-pg%s-%s-%s", b.Version, b.Major, b.Debian, arch)
}

type extensionsFile struct {
	SchemaVersion    int              `json:"schemaVersion"`
	AllowlistVersion int              `json:"allowlistVersion"`
	PreloadLibraries []PreloadLibrary `json:"preloadLibraries"`
	Extensions       []Extension      `json:"extensions"`
	NeverExposed     []string         `json:"neverExposed"`
}

type versionsFile struct {
	SchemaVersion int       `json:"schemaVersion"`
	Repository    string    `json:"repository"`
	Versions      []Version `json:"versions"`
}

type bundlesFile struct {
	SchemaVersion int      `json:"schemaVersion"`
	Bundles       []Bundle `json:"bundles"`
}

// ImageInfo describes a catalog image.
type ImageInfo struct {
	Kind    string
	Version Version
}

// Catalog is the parsed, validated set of manifests.
type Catalog struct {
	allowlistVersion int
	extensions       []Extension
	byName           map[string]Extension
	libraries        []PreloadLibrary
	libraryByName    map[string]PreloadLibrary
	neverExposed     []string
	versions         []Version
	byDigest         map[string]ImageInfo
	bundles          []Bundle
}

var (
	defaultOnce    sync.Once
	defaultCatalog *Catalog
	defaultErr     error
)

// Default is the catalog compiled into the daemon. The manifests are validated
// by the package tests, so an error here means a broken build.
func Default() (*Catalog, error) {
	defaultOnce.Do(func() {
		read := func(name string) []byte {
			data, err := catalogFiles.ReadFile("catalog/" + name)
			if err != nil {
				defaultErr = err
			}
			return data
		}
		extensions, versions, bundles := read("extensions.json"), read("versions.json"), read("bundles.json")
		if defaultErr == nil {
			defaultCatalog, defaultErr = Parse(extensions, versions, bundles)
		}
	})
	return defaultCatalog, defaultErr
}

// Digest is the sha256 digest of a digest-pinned reference, or "".
func Digest(reference string) string {
	match := digestPattern.FindStringSubmatch(strings.TrimSpace(reference))
	if match == nil {
		return ""
	}
	return match[1]
}

// AllowlistVersion identifies the curated list.
func (c *Catalog) AllowlistVersion() int { return c.allowlistVersion }

// Extensions are the curated extensions in manifest order.
func (c *Catalog) Extensions() []Extension { return slices.Clone(c.extensions) }

// Extension finds a curated extension.
func (c *Catalog) Extension(name string) (Extension, bool) {
	extension, ok := c.byName[name]
	return extension, ok
}

// Names are the curated extension names in manifest order.
func (c *Catalog) Names() []string {
	names := make([]string, 0, len(c.extensions))
	for _, extension := range c.extensions {
		names = append(names, extension.Name)
	}
	return names
}

// NeverExposed are names the curated list must never contain.
func (c *Catalog) NeverExposed() []string { return slices.Clone(c.neverExposed) }

// PreloadLibrary finds a listed preload library.
func (c *Catalog) PreloadLibrary(name string) (PreloadLibrary, bool) {
	library, ok := c.libraryByName[name]
	return library, ok
}

// Versions are the catalog versions in manifest order.
func (c *Catalog) Versions() []Version { return slices.Clone(c.versions) }

// Debian is the Debian release of a major's catalog images, or "".
func (c *Catalog) Debian(major string) string {
	for _, version := range c.versions {
		if version.Major == major {
			return version.Debian
		}
	}
	return ""
}

// PostgresImages are every accepted catalog image reference: each version's
// official base and, once pinned, its Opfield image.
func (c *Catalog) PostgresImages() []string {
	var images []string
	for _, version := range c.versions {
		images = append(images, version.Base)
		if image := version.OpfieldImage(); image != "" {
			images = append(images, image)
		}
	}
	return images
}

// Image describes the catalog image with reference's digest (any repository
// name: the digest is the content); Kind is ImageOther when it is none.
func (c *Catalog) Image(reference string) ImageInfo {
	if info, ok := c.byDigest[Digest(reference)]; ok {
		return info
	}
	return ImageInfo{Kind: ImageOther}
}

// Bundle finds the pinned build of a bundle for a major and Debian release.
func (c *Catalog) Bundle(id, major, debian string) (Bundle, bool) {
	for _, bundle := range c.bundles {
		if bundle.ID == id && bundle.Major == major && bundle.Debian == debian {
			return bundle, true
		}
	}
	return Bundle{}, false
}

// Bundles are every pinned bundle build.
func (c *Catalog) Bundles() []Bundle { return slices.Clone(c.bundles) }

// BundleIDs are the ids extensions.json names, sorted.
func (c *Catalog) BundleIDs() []string {
	seen := map[string]bool{}
	var ids []string
	for _, extension := range c.extensions {
		if id := extension.BundleID(); id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	return ids
}

// BundleClosure resolves bundle ids to their builds for a major and Debian
// release, with every bundle they require, required ones first. An id that is
// unknown or has no build is an error naming it.
func (c *Catalog) BundleClosure(ids []string, major, debian string) ([]Bundle, error) {
	known := map[string]bool{}
	for _, id := range c.BundleIDs() {
		known[id] = true
	}
	var out []Bundle
	added := map[string]bool{}
	var visit func(id string, depth int) error
	visit = func(id string, depth int) error {
		if added[id] {
			return nil
		}
		if !known[id] {
			return fmt.Errorf("bundle %s is not in the catalog", id)
		}
		if depth > len(known) {
			return fmt.Errorf("bundle %s requires itself", id)
		}
		bundle, ok := c.Bundle(id, major, debian)
		if !ok {
			return &BundleUnavailableError{ID: id, Major: major, Debian: debian}
		}
		for _, required := range bundle.Requires {
			if err := visit(required, depth+1); err != nil {
				return err
			}
		}
		added[id] = true
		out = append(out, bundle)
		return nil
	}
	for _, id := range ids {
		if err := visit(id, 0); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// BundleUnavailableError: a known bundle has no pinned build for a major and
// Debian release.
type BundleUnavailableError struct {
	ID, Major, Debian string
}

func (e *BundleUnavailableError) Error() string {
	return fmt.Sprintf("bundle %s has no build for PostgreSQL %s on Debian %s", e.ID, e.Major, e.Debian)
}

// CanonicalPreload deduplicates preload libraries and puts them in the
// manifest's load order; an unlisted library is an error naming it.
func (c *Catalog) CanonicalPreload(libraries []string) ([]string, error) {
	wanted := map[string]bool{}
	for _, library := range libraries {
		library = strings.TrimSpace(library)
		if _, ok := c.libraryByName[library]; !ok {
			return nil, fmt.Errorf("preload library %q is not one Opfield offers", library)
		}
		wanted[library] = true
	}
	var out []string
	for _, library := range c.libraries {
		if wanted[library.Name] {
			out = append(out, library.Name)
		}
	}
	return out, nil
}

// PreloadSettings are the server settings the daemon adds for canonical
// preload libraries, with the database name filled in.
func (c *Catalog) PreloadSettings(libraries []string, databaseName string) map[string]string {
	settings := map[string]string{}
	for _, name := range libraries {
		for key, value := range c.libraryByName[name].Settings {
			settings[key] = strings.ReplaceAll(value, DatabaseNamePlaceholder, databaseName)
		}
	}
	return settings
}
