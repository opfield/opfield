//go:build !linux

package docker

// Loop devices are a Linux feature; elsewhere no device is ever owned.
func loopBackingIdentity(string) (uint64, uint64, bool) { return 0, 0, false }

func loopSetAutoclear(string) error { return nil }
