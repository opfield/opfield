package pgext

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Parse reads and validates the three manifests.
func Parse(extensionsJSON, versionsJSON, bundlesJSON []byte) (*Catalog, error) {
	var ext extensionsFile
	var ver versionsFile
	var bun bundlesFile
	for _, item := range []struct {
		name string
		data []byte
		into any
	}{{"extensions.json", extensionsJSON, &ext}, {"versions.json", versionsJSON, &ver}, {"bundles.json", bundlesJSON, &bun}} {
		decoder := json.NewDecoder(strings.NewReader(string(item.data)))
		if err := decoder.Decode(item.into); err != nil {
			return nil, fmt.Errorf("%s: %w", item.name, err)
		}
	}
	c := &Catalog{
		allowlistVersion: ext.AllowlistVersion,
		byName:           map[string]Extension{},
		libraryByName:    map[string]PreloadLibrary{},
		byDigest:         map[string]ImageInfo{},
		neverExposed:     ext.NeverExposed,
	}
	if ext.SchemaVersion != 1 || ver.SchemaVersion != 1 || bun.SchemaVersion != 1 {
		return nil, errors.New("unsupported catalog schema version")
	}
	if ext.AllowlistVersion < 1 {
		return nil, errors.New("extensions.json: allowlistVersion must be positive")
	}
	for _, library := range ext.PreloadLibraries {
		if !extensionNamePattern.MatchString(library.Name) || c.libraryByName[library.Name].Name != "" {
			return nil, fmt.Errorf("extensions.json: preload library %q is invalid or repeated", library.Name)
		}
		if library.Delivery != DeliveryContrib && library.Delivery != DeliveryBaked && library.Delivery != DeliveryBundle {
			return nil, fmt.Errorf("extensions.json: preload library %s has an unknown delivery", library.Name)
		}
		for key := range library.Settings {
			if !allowedSettings[key] {
				return nil, fmt.Errorf("extensions.json: preload library %s sets %s, which the daemon does not own", library.Name, key)
			}
		}
		c.libraryByName[library.Name] = library
		c.libraries = append(c.libraries, library)
	}
	bundleIDs := map[string]bool{}
	for _, extension := range ext.Extensions {
		if !extensionNamePattern.MatchString(extension.Name) {
			return nil, fmt.Errorf("extensions.json: extension name %q is invalid", extension.Name)
		}
		if _, dup := c.byName[extension.Name]; dup {
			return nil, fmt.Errorf("extensions.json: extension %s is listed twice", extension.Name)
		}
		if slices.Contains(ext.NeverExposed, extension.Name) {
			return nil, fmt.Errorf("extensions.json: extension %s is never exposed", extension.Name)
		}
		if !slices.Contains(categories, extension.Category) {
			return nil, fmt.Errorf("extensions.json: extension %s has an unknown category", extension.Name)
		}
		if strings.TrimSpace(extension.Description) == "" {
			return nil, fmt.Errorf("extensions.json: extension %s has no description", extension.Name)
		}
		switch extension.Delivery {
		case DeliveryContrib, DeliveryBaked:
		case DeliveryBundle:
			if extension.BundleID() == "" {
				return nil, fmt.Errorf("extensions.json: bundle extension %s names no bundle", extension.Name)
			}
		default:
			return nil, fmt.Errorf("extensions.json: extension %s has an unknown delivery", extension.Name)
		}
		if extension.BundleID() != "" {
			bundleIDs[extension.BundleID()] = true
		}
		for _, library := range extension.PreloadLibraries {
			if _, ok := c.libraryByName[library]; !ok {
				return nil, fmt.Errorf("extensions.json: extension %s needs preload library %s, which is not listed", extension.Name, library)
			}
		}
		c.byName[extension.Name] = extension
		c.extensions = append(c.extensions, extension)
	}
	if ver.Repository == "" {
		return nil, errors.New("versions.json: repository is required")
	}
	seenVersions := map[string]bool{}
	for _, version := range ver.Versions {
		if !versionPattern.MatchString(version.Version) || seenVersions[version.Version] {
			return nil, fmt.Errorf("versions.json: version %q is invalid or repeated", version.Version)
		}
		seenVersions[version.Version] = true
		if !strings.HasPrefix(version.Version, version.Major+".") || !debianPattern.MatchString(version.Debian) {
			return nil, fmt.Errorf("versions.json: version %s has an invalid major or Debian release", version.Version)
		}
		for kind, reference := range map[string]string{ImageOfficial: version.Base, ImageOpfield: version.OpfieldImage()} {
			if reference == "" && kind == ImageOpfield {
				continue
			}
			digest := Digest(reference)
			if digest == "" {
				return nil, fmt.Errorf("versions.json: version %s has an image without a digest: %q", version.Version, reference)
			}
			if _, dup := c.byDigest[digest]; dup {
				return nil, fmt.Errorf("versions.json: digest %s is listed twice", digest)
			}
			c.byDigest[digest] = ImageInfo{Kind: kind, Version: version}
		}
		c.versions = append(c.versions, version)
	}
	for _, version := range c.versions {
		if c.Debian(version.Major) != version.Debian {
			return nil, fmt.Errorf("versions.json: PostgreSQL %s lists several Debian releases", version.Major)
		}
	}
	seenBundles := map[string]bool{}
	for _, bundle := range bun.Bundles {
		key := bundle.ID + "/" + bundle.Major + "/" + bundle.Debian
		if !bundleIDs[bundle.ID] || seenBundles[key] {
			return nil, fmt.Errorf("bundles.json: bundle %s is not used by an extension or repeated", key)
		}
		seenBundles[key] = true
		if !bundleVersionPattern.MatchString(bundle.Version) || Digest(bundle.Reference) == "" {
			return nil, fmt.Errorf("bundles.json: bundle %s has an invalid version or reference", key)
		}
		for _, arch := range Architectures {
			if bundle.SizeBytes[arch] <= 0 {
				return nil, fmt.Errorf("bundles.json: bundle %s has no size for %s", key, arch)
			}
		}
		for _, name := range bundle.Provides {
			if extension, ok := c.byName[name]; ok && extension.Delivery == DeliveryBundle && extension.BundleID() != bundle.ID {
				return nil, fmt.Errorf("bundles.json: bundle %s provides %s, which extensions.json gives bundle %s", key, name, extension.BundleID())
			}
		}
		for _, library := range bundle.PreloadLibraries {
			if _, ok := c.libraryByName[library]; !ok {
				return nil, fmt.Errorf("bundles.json: bundle %s preloads unlisted library %s", key, library)
			}
		}
		c.bundles = append(c.bundles, bundle)
	}
	for _, bundle := range c.bundles {
		for _, required := range bundle.Requires {
			if _, ok := c.Bundle(required, bundle.Major, bundle.Debian); !ok {
				return nil, fmt.Errorf("bundles.json: bundle %s/%s requires %s, which has no build for it", bundle.ID, bundle.Major, required)
			}
		}
	}
	return c, nil
}
