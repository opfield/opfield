package docker

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Managed engines read a few files the daemon keeps outside their data image:
// a storage engine its staged root identity, configuration and TLS material,
// a database engine its TLS material. They are written from what Gateway sends
// with a create, update or restart, and a node that lost them (a filesystem
// repair after a crash moves them away) cannot write them again on its own.
// Such an engine is not started: it would only fail and be started again, for
// ever. Inspect reports the missing files, and Gateway answers with a restart
// that carries them; the daemon restages them before it starts the engine.

// missingFiles lists the names under dir that are not a non-empty regular file.
func missingFiles(dir string, names []string) []string {
	var missing []string
	for _, name := range names {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			missing = append(missing, name)
		}
	}
	return missing
}

func runtimeFilesMissingError(kind string, missing []string) error {
	return fmt.Errorf("%s runtime files are missing on the node (%s); Gateway restages them with a restart", kind, strings.Join(missing, ", "))
}

// missingRuntimeFiles lists the runtime files of a storage member that are
// not on disk, relative to the member's staging directory (SeaweedFS) or the
// storage directory (MinIO).
func (m *managedStorageManager) missingRuntimeFiles(record managedStorageRecord) []string {
	if record.engine() == managedStorageEngineSeaweedFS {
		names := []string{"config/s3.json", "config/security.toml", "config/master.toml"}
		if record.TLSEnabled {
			names = append(names, "tls/public.crt", "tls/private.key", "tls/ca.crt")
		}
		return missingFiles(m.seaweedfsStagingDir(record), names)
	}
	member := fmt.Sprintf("%s-%d", record.ID, record.MemberIndex)
	var names []string
	if record.TLSEnabled {
		names = append(names, "tls/"+member+"/public.crt", "tls/"+member+"/private.key", "tls/"+member+"/CAs/gateway-ca.crt")
	}
	if record.SFTPPort != 0 {
		names = append(names, "sftp/"+member+"/host-key")
	}
	return missingFiles(filepath.Join(m.root, "storage"), names)
}

// restageRuntimeFiles writes the runtime files a member lost from a
// create/update/restart payload and returns the ones still missing. Present
// files are left as they are; input may be nil (a payload without material).
func (m *managedStorageManager) restageRuntimeFiles(record managedStorageRecord, input *managedStorageCommand) ([]string, error) {
	missing := m.missingRuntimeFiles(record)
	if len(missing) == 0 || input == nil || (record.TLSEnabled && input.TLS == nil) {
		return missing, nil
	}
	if record.engine() == managedStorageEngineSeaweedFS {
		if input.RootCredentials.AccessKey == "" || input.RootCredentials.SecretKey == "" {
			return missing, nil
		}
		stage := m.stageSeaweedFS
		if record.Set != nil {
			stage = m.stageSeaweedFSSet
		}
		if _, err := stage(record, *input); err != nil {
			return missing, fmt.Errorf("restage managed storage runtime files: %w", err)
		}
	} else {
		if record.TLSEnabled {
			if _, err := m.stageTLS(record, *input.TLS); err != nil {
				return missing, fmt.Errorf("restage managed storage runtime files: %w", err)
			}
		}
		if record.SFTPPort != 0 && input.SFTP != nil {
			if _, err := m.stageSFTPHostKey(record, input.SFTP.HostKeyPEM); err != nil {
				return missing, fmt.Errorf("restage managed storage runtime files: %w", err)
			}
		}
	}
	m.logger.Info("restaged managed storage runtime files the node had lost", "id", record.ID, "files", strings.Join(missing, ", "))
	return m.missingRuntimeFiles(record), nil
}

// missingRuntimeFiles lists the TLS files of a database that are not on
// disk, relative to the database's TLS directory.
func (m *managedDatabaseManager) missingRuntimeFiles(record managedDatabaseRecord) []string {
	if !record.TLSEnabled {
		return nil
	}
	return missingFiles(m.tlsDirectory(record), []string{"ca.pem", "key.pem", "cert.pem"})
}

// restageRuntimeFiles writes the TLS files a database lost from a
// create/update/restart payload and returns the ones still missing. A
// certificate that differs from the recorded one is applied by the usual
// certificate reload afterwards.
func (m *managedDatabaseManager) restageRuntimeFiles(record managedDatabaseRecord, input *managedDatabaseCommand) ([]string, error) {
	missing := m.missingRuntimeFiles(record)
	if len(missing) == 0 || input == nil || !input.TLSEnabled || input.TLSCertificatePEM == "" || input.TLSPrivateKeyPEM == "" {
		return missing, nil
	}
	if err := writeManagedDatabaseTLS(m.tlsDirectory(record), *input); err != nil {
		return missing, err
	}
	m.logger.Info("restaged managed database TLS files the node had lost", "id", record.ID, "files", strings.Join(missing, ", "))
	return m.missingRuntimeFiles(record), nil
}
