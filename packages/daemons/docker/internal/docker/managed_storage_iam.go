package docker

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/minio/madmin-go/v3"
	"github.com/minio/minio-go/v7/pkg/credentials"
	mobyclient "github.com/moby/moby/client"
)

func (m *managedStorageManager) handleIAM(ctx context.Context, action string, record managedStorageRecord, input managedStorageCommand) (string, error) {
	if input.IAM == nil || input.RootCredentials.AccessKey == "" || input.RootCredentials.SecretKey == "" {
		return "", errors.New("managed storage IAM credentials are required")
	}
	if managedStorageIAMActions[action] != input.IAM.Action {
		return "", errors.New("managed storage IAM action mismatch")
	}
	endpoint, err := m.privateEndpoint(ctx, record)
	if err != nil {
		return "", err
	}
	opts := &madmin.Options{Creds: credentials.NewStaticV4(input.RootCredentials.AccessKey, input.RootCredentials.SecretKey, "")}
	if input.TLS != nil {
		transport, err := managedStorageTLSTransport(input.TLS)
		if err != nil {
			return "", err
		}
		opts.Secure = true
		opts.Transport = transport
	}
	client, err := madmin.NewWithOptions(endpoint, opts)
	if err != nil {
		return "", fmt.Errorf("create managed storage IAM client: %w", err)
	}
	switch action {
	case "iam_create_key":
		if input.IAM.Name != "" && len(input.IAM.Name) > 128 {
			return "", errors.New("managed storage IAM name is too long")
		}
		if input.IAM.TargetAccessKey != "" && !managedStorageKeyPattern.MatchString(input.IAM.TargetAccessKey) {
			return "", errors.New("managed storage IAM access key is invalid")
		}
		var policy json.RawMessage
		if input.IAM.Policy != "" && (len(input.IAM.Policy) > 64*1024 || json.Unmarshal([]byte(input.IAM.Policy), &policy) != nil) {
			return "", errors.New("managed storage IAM policy is invalid")
		}
		request := madmin.AddServiceAccountReq{AccessKey: input.IAM.TargetAccessKey, SecretKey: input.IAM.TargetSecretKey, Name: input.IAM.Name, Policy: policy}
		if input.IAM.ExpiresAt != "" {
			expiry, err := time.Parse(time.RFC3339, input.IAM.ExpiresAt)
			if err != nil {
				return "", errors.New("managed storage IAM expiration is invalid")
			}
			request.Expiration = &expiry
		}
		created, err := client.AddServiceAccount(ctx, request)
		if err != nil {
			return "", err
		}
		return jsonString(map[string]string{"accessKey": created.AccessKey, "secretKey": created.SecretKey})
	case "iam_list_keys":
		listed, err := client.ListServiceAccounts(ctx, input.RootCredentials.AccessKey)
		if err != nil {
			return "", err
		}
		keys := make([]string, 0, len(listed.Accounts))
		for _, account := range listed.Accounts {
			keys = append(keys, account.AccessKey)
		}
		sort.Strings(keys)
		return jsonString(map[string]any{"accessKeys": keys})
	case "iam_remove_key":
		if !managedStorageKeyPattern.MatchString(input.IAM.TargetAccessKey) {
			return "", errors.New("managed storage IAM access key is invalid")
		}
		if err := client.DeleteServiceAccount(ctx, input.IAM.TargetAccessKey); err != nil {
			return "", err
		}
		return `{"status":"deleted"}`, nil
	case "iam_update_policy":
		return updateMinIOServiceAccountPolicy(ctx, client, input.IAM)
	}
	return "", errors.New("unsupported managed storage IAM action")
}

// managedStorageIAMActions maps each daemon IAM action to the action its
// payload must name, so a payload built for one action is never run as another.
var managedStorageIAMActions = map[string]string{
	"iam_create_key":    "create_key",
	"iam_list_keys":     "list_keys",
	"iam_remove_key":    "remove_key",
	"iam_update_policy": "update_policy",
}

type minioServiceAccountUpdater interface {
	UpdateServiceAccount(ctx context.Context, accessKey string, opts madmin.UpdateServiceAccountReq) error
}

// updateMinIOServiceAccountPolicy replaces the inline policy of one service
// account of the root user: an Opfield access key or a workload-link key. The
// migration write freeze uses it to make such keys read-only and to restore
// them afterwards; the key keeps its id, secret and expiry. The root user has
// no inline policy and cannot be addressed here, so it keeps full access.
func updateMinIOServiceAccountPolicy(ctx context.Context, client minioServiceAccountUpdater, iam *managedStorageIAM) (string, error) {
	if iam == nil || !managedStorageKeyPattern.MatchString(iam.TargetAccessKey) {
		return "", errors.New("managed storage IAM access key is invalid")
	}
	// An empty policy would mean "inherit the root user's full access".
	var policy json.RawMessage
	if iam.Policy == "" || len(iam.Policy) > 64*1024 || json.Unmarshal([]byte(iam.Policy), &policy) != nil || !strings.HasPrefix(strings.TrimSpace(iam.Policy), "{") {
		return "", errors.New("managed storage IAM policy is invalid")
	}
	if err := client.UpdateServiceAccount(ctx, iam.TargetAccessKey, madmin.UpdateServiceAccountReq{NewPolicy: policy}); err != nil {
		return "", err
	}
	return `{"status":"updated"}`, nil
}

func (m *managedStorageManager) privateEndpoint(ctx context.Context, record managedStorageRecord) (string, error) {
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil && !isNotFoundErr(err) {
		return "", dockerUnansweredError{message: "managed storage container is unavailable", cause: err}
	}
	if err != nil || inspect.Container.Config == nil || inspect.Container.State == nil || !inspect.Container.State.Running {
		return "", errors.New("managed storage container is unavailable")
	}
	if inspect.Container.Config.Labels[managedStorageLabel] != record.ID || inspect.Container.Config.Labels[managedStorageMemberLabel] != strconv.Itoa(record.MemberIndex) {
		return "", errors.New("managed storage container identity is invalid")
	}
	endpoint := inspect.Container.NetworkSettings.Networks[record.NetworkName]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return "", errors.New("managed storage private network is unavailable")
	}
	return net.JoinHostPort(endpoint.IPAddress.String(), "9000"), nil
}

func (m *managedStorageManager) dial(ctx context.Context, storageID string) (net.Conn, error) {
	if !managedStorageIDPattern.MatchString(storageID) {
		return nil, errors.New("managed storage id must be a UUID")
	}
	// Without the manager lock, which commands hold for their whole run: relay
	// connections must not wait behind a lifecycle operation. Records are
	// replaced atomically, and privateEndpoint verifies the container live.
	record, err := m.loadRecord(storageID)
	if err != nil || record.Removed {
		return nil, errors.New("managed storage record not found")
	}
	// dockerd names the container's address; while it does not answer, the
	// last address it named is used (B-26).
	key := record.ContainerID + "\x00" + record.NetworkName + "\x00" + record.ID + "\x00" + strconv.Itoa(record.MemberIndex)
	endpoint, err := m.dialTargets.get(ctx, key, func(ctx context.Context) (string, error) {
		return m.privateEndpoint(ctx, record)
	})
	if err != nil {
		return nil, err
	}
	return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", endpoint)
}

func managedStorageTLSTransport(input *managedStorageTLS) (*http.Transport, error) {
	if input == nil || input.CAPEM == "" || input.ServerName == "" {
		return nil, errors.New("managed storage TLS configuration is incomplete")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(input.CAPEM)) {
		return nil, errors.New("managed storage CA PEM is invalid")
	}
	return &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: input.ServerName}}, nil
}
