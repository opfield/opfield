package builder

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

var redactedValue = []byte("[REDACTED]")

type streamRedactor struct {
	secrets [][]byte
	keep    int
	pending []byte
	emit    func([]byte)
}

func newStreamRedactor(values []string, emit func([]byte)) *streamRedactor {
	redactor := &streamRedactor{emit: emit}
	seen := map[string]struct{}{}
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		redactor.secrets = append(redactor.secrets, []byte(value))
		if len(value)-1 > redactor.keep {
			redactor.keep = len(value) - 1
		}
	}
	return redactor
}

func (r *streamRedactor) Write(chunk []byte) (int, error) {
	length := len(chunk)
	if length == 0 {
		return 0, nil
	}
	r.pending = append(r.pending, chunk...)
	r.drain(false)
	return length, nil
}

func (r *streamRedactor) Flush() {
	r.drain(true)
	r.pending = nil
}

func (r *streamRedactor) drain(flush bool) {
	for len(r.pending) > 0 {
		safeLength := len(r.pending)
		if !flush {
			safeLength -= r.keep
			if safeLength <= 0 {
				return
			}
		}
		matchAt, matchLength := -1, 0
		for _, secret := range r.secrets {
			index := bytes.Index(r.pending, secret)
			if index >= 0 && (matchAt < 0 || index < matchAt || index == matchAt && len(secret) > matchLength) {
				matchAt, matchLength = index, len(secret)
			}
		}
		if matchAt >= 0 && (flush || matchAt < safeLength) {
			if matchAt > 0 {
				r.emit(append([]byte(nil), r.pending[:matchAt]...))
			}
			r.emit(redactedValue)
			r.pending = r.pending[matchAt+matchLength:]
			continue
		}
		r.emit(append([]byte(nil), r.pending[:safeLength]...))
		r.pending = r.pending[safeLength:]
		if !flush {
			return
		}
	}
}

func cleanupStaleSecretDirs(workspace string) error {
	matches, err := filepath.Glob(filepath.Join(workspace, ".opfield-build-secrets-*"))
	if err != nil {
		return err
	}
	// legacy-name: secret directories a pre-Opfield daemon left behind — remove once every node reports none
	legacy, err := filepath.Glob(filepath.Join(workspace, ".gateway-build-secrets-*"))
	matches = append(matches, legacy...)
	if err != nil {
		return err
	}
	for _, match := range matches {
		if err := secureRemoveAll(match); err != nil {
			return err
		}
	}
	return nil
}

func cleanupStaleJobDirs(workspace string) error {
	entries, err := os.ReadDir(workspace)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !buildIDPattern.MatchString(name) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(workspace, name)); err != nil {
			return err
		}
	}
	return nil
}

func secureRemoveAll(root string) error {
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		file, err := os.OpenFile(path, os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		zeroes := strings.NewReader(strings.Repeat("\x00", int(info.Size())))
		_, copyErr := file.ReadFrom(zeroes)
		syncErr := file.Sync()
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil {
			return syncErr
		}
		return closeErr
	})
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.RemoveAll(root)
}
