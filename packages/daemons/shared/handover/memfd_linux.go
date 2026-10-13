package handover

import (
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

// requiredSeals make the snapshot immutable: neither this process nor the one
// that reads it can change its bytes or size, or lift the seals.
const requiredSeals = unix.F_SEAL_SEAL | unix.F_SEAL_SHRINK | unix.F_SEAL_GROW | unix.F_SEAL_WRITE

// sealedFile writes data to a sealed memory file: it never touches a disk, and
// it goes to the next process through the launcher's keeper only.
func sealedFile(data []byte) (*os.File, error) {
	fd, err := unix.MemfdCreate("opfield-daemon-handover", unix.MFD_CLOEXEC|unix.MFD_ALLOW_SEALING)
	if err != nil {
		return nil, fmt.Errorf("create the handover memory file: %w", err)
	}
	file := os.NewFile(uintptr(fd), "opfield-daemon-handover")
	for written := 0; written < len(data); {
		n, err := unix.Write(fd, data[written:])
		if err != nil {
			_ = file.Close()
			return nil, fmt.Errorf("write the handover memory file: %w", err)
		}
		written += n
	}
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_ADD_SEALS, requiredSeals); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("seal the handover memory file: %w", err)
	}
	return file, nil
}

// readSealedFile reads a sealed memory file the previous process handed over.
func readSealedFile(file *os.File, limit int64) ([]byte, error) {
	raw, err := file.SyscallConn()
	if err != nil {
		return nil, err
	}
	var seals int
	var sealErr error
	var stat unix.Stat_t
	if err := raw.Control(func(fd uintptr) {
		if seals, sealErr = unix.FcntlInt(fd, unix.F_GET_SEALS, 0); sealErr == nil {
			sealErr = unix.Fstat(int(fd), &stat)
		}
	}); err != nil {
		return nil, err
	}
	if sealErr != nil {
		return nil, fmt.Errorf("inspect the handover memory file: %w", sealErr)
	}
	if seals&requiredSeals != requiredSeals {
		return nil, errors.New("handover: the snapshot is not sealed")
	}
	if stat.Size <= 0 || stat.Size > limit {
		return nil, fmt.Errorf("handover: snapshot of %d bytes", stat.Size)
	}
	data := make([]byte, stat.Size)
	if _, err := file.ReadAt(data, 0); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return data, nil
}
