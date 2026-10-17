package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// SeaweedFS IAM (embedded in the S3 port, AWS IAM query API signed with the
// static root identity). One Opfield key owns one IAM user ("principal") with
// a single inline policy; revocation deletes the whole principal, which also
// removes any extra keys the key holder minted for itself through the
// self-service IAM actions.
const (
	seaweedfsIAMRegion         = "us-east-1"
	seaweedfsIAMVersion        = "2010-05-08"
	seaweedfsInlinePolicyName  = legacycompat.SeaweedFSPolicyName
	seaweedfsIAMRequestTimeout = 15 * time.Second
	seaweedfsKeyConfirmTimeout = 10 * time.Second
	seaweedfsIAMMaxPages       = 100
	seaweedfsPolicyMaxBytes    = 64 * 1024
)

var (
	seaweedfsPrincipalPattern       = regexp.MustCompile(`^gw-[A-Za-z0-9][A-Za-z0-9_-]{0,60}$`)
	seaweedfsCallerAccessKeyPattern = regexp.MustCompile(`^[A-Za-z0-9]{4,128}$`)
	seaweedfsPolicyBucketPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	// Actions SeaweedFS 4.47 maps to bucket-scoped permissions. It rejects
	// s3:ListBucketMultipartUploads and s3:ListMultipartUploadParts outright
	// (MalformedPolicyDocument), so they are not admitted here either.
	seaweedfsAllowedPolicyActions = map[string]struct{}{
		"s3:GetBucketLocation":    {},
		"s3:ListBucket":           {},
		"s3:GetObject":            {},
		"s3:PutObject":            {},
		"s3:DeleteObject":         {},
		"s3:AbortMultipartUpload": {},
	}
)

type seaweedfsIAMClient struct {
	endpoint  string
	accessKey string
	secretKey string
	client    *http.Client
	now       func() time.Time
}

type seaweedfsIAMError struct {
	Status  int
	Code    string
	Message string
}

func (e *seaweedfsIAMError) Error() string {
	return fmt.Sprintf("SeaweedFS IAM %s: %s (HTTP %d)", e.Code, e.Message, e.Status)
}

func isSeaweedFSNoSuchEntity(err error) bool {
	var iamErr *seaweedfsIAMError
	return errors.As(err, &iamErr) && (iamErr.Code == "NoSuchEntity" || iamErr.Status == http.StatusNotFound)
}

func (m *managedStorageManager) seaweedfsIAMClientFor(ctx context.Context, record managedStorageRecord) (*seaweedfsIAMClient, error) {
	endpoint, err := m.privateEndpoint(ctx, record)
	if err != nil {
		return nil, err
	}
	transport, scheme, err := m.seaweedfsTransport(record)
	if err != nil {
		return nil, err
	}
	accessKey, secretKey, err := m.readSeaweedFSRootCredentials(record)
	if err != nil {
		return nil, fmt.Errorf("read managed storage root identity: %w", err)
	}
	return &seaweedfsIAMClient{
		endpoint:  scheme + "://" + endpoint,
		accessKey: accessKey,
		secretKey: secretKey,
		client:    &http.Client{Transport: transport, Timeout: seaweedfsIAMRequestTimeout},
		now:       time.Now,
	}, nil
}

func (m *managedStorageManager) handleSeaweedFSIAM(ctx context.Context, action string, record managedStorageRecord, input managedStorageCommand) (string, error) {
	if input.IAM == nil {
		return "", errors.New("managed storage IAM request is required")
	}
	if managedStorageIAMActions[action] != input.IAM.Action {
		return "", errors.New("managed storage IAM action mismatch")
	}
	iam := *input.IAM
	// Validate before contacting the cluster so a malformed request never
	// leaves partial IAM state behind.
	switch action {
	case "iam_create_key":
		if _, err := validateSeaweedFSCreateKey(iam, time.Now()); err != nil {
			return "", err
		}
	case "iam_list_keys":
		if iam.Principal != "" && !seaweedfsPrincipalPattern.MatchString(iam.Principal) {
			return "", errors.New("managed storage IAM principal is invalid")
		}
	case "iam_remove_key":
		if iam.Principal == "" && iam.TargetAccessKey == "" {
			return "", errors.New("managed storage IAM principal or access key is required")
		}
		if iam.Principal != "" && !seaweedfsPrincipalPattern.MatchString(iam.Principal) {
			return "", errors.New("managed storage IAM principal is invalid")
		}
		if iam.TargetAccessKey != "" && !managedStorageKeyPattern.MatchString(iam.TargetAccessKey) && !seaweedfsCallerAccessKeyPattern.MatchString(iam.TargetAccessKey) {
			return "", errors.New("managed storage IAM access key is invalid")
		}
	case "iam_update_policy":
		if err := validateSeaweedFSPolicyUpdate(iam); err != nil {
			return "", err
		}
	}
	client, err := m.seaweedfsIAMClientFor(ctx, record)
	if err != nil {
		return "", err
	}
	switch action {
	case "iam_create_key":
		return client.createKey(ctx, iam)
	case "iam_list_keys":
		return client.listKeys(ctx, iam.Principal)
	case "iam_remove_key":
		return client.removeKey(ctx, iam)
	case "iam_update_policy":
		return client.updatePolicy(ctx, iam)
	}
	return "", errors.New("unsupported managed storage IAM action")
}

func validateSeaweedFSPolicyUpdate(iam managedStorageIAM) error {
	if !seaweedfsPrincipalPattern.MatchString(iam.Principal) {
		return errors.New("managed storage IAM principal is invalid")
	}
	return validateSeaweedFSPolicy(iam.Policy)
}

type seaweedfsCreateKeyPlan struct {
	Policy    string
	ExpiresAt *time.Time
}

func validateSeaweedFSCreateKey(iam managedStorageIAM, now time.Time) (seaweedfsCreateKeyPlan, error) {
	var plan seaweedfsCreateKeyPlan
	if !seaweedfsPrincipalPattern.MatchString(iam.Principal) {
		return plan, errors.New("managed storage IAM principal must match gw-<id> (letters, digits, '_' or '-', at most 64 characters)")
	}
	if len(iam.Name) > 128 {
		return plan, errors.New("managed storage IAM name is too long")
	}
	if err := validateSeaweedFSPolicy(iam.Policy); err != nil {
		return plan, err
	}
	plan.Policy = iam.Policy
	if iam.ExpiresAt != "" {
		expiry, err := time.Parse(time.RFC3339, iam.ExpiresAt)
		if err != nil || !expiry.After(now) {
			return plan, errors.New("managed storage IAM expiration must be a future RFC 3339 time")
		}
		plan.ExpiresAt = &expiry
		// An expiring key is a SeaweedFS service account; SeaweedFS generates
		// its credentials, so caller-chosen ones are ignored (the response is
		// authoritative).
		return plan, nil
	}
	if (iam.TargetAccessKey == "") != (iam.TargetSecretKey == "") {
		return plan, errors.New("managed storage IAM access key and secret must be supplied together")
	}
	if iam.TargetAccessKey != "" && !seaweedfsCallerAccessKeyPattern.MatchString(iam.TargetAccessKey) {
		return plan, errors.New("managed storage IAM access key must be 4-128 letters or digits")
	}
	if iam.TargetSecretKey != "" && (len(iam.TargetSecretKey) < 8 || len(iam.TargetSecretKey) > 128) {
		return plan, errors.New("managed storage IAM secret key must be 8-128 characters")
	}
	return plan, nil
}

type seaweedfsStringList []string

func (l *seaweedfsStringList) UnmarshalJSON(raw []byte) error {
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		*l = []string{single}
		return nil
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		return errors.New("expected a string or a list of strings")
	}
	*l = list
	return nil
}

// validateSeaweedFSPolicy admits only the policy shape the Opfield SeaweedFS
// policy builder produces: Allow statements over per-bucket (or all-bucket)
// object read/write/delete and bucket listing. Anything else, including
// s3:ListAllMyBuckets and wildcard or admin actions, is rejected.
func validateSeaweedFSPolicy(raw string) error {
	if raw == "" {
		return errors.New("managed storage IAM policy is required")
	}
	if len(raw) > seaweedfsPolicyMaxBytes {
		return errors.New("managed storage IAM policy is too large")
	}
	var document struct {
		Version   string `json:"Version"`
		Statement []struct {
			Effect   string              `json:"Effect"`
			Action   seaweedfsStringList `json:"Action"`
			Resource seaweedfsStringList `json:"Resource"`
		} `json:"Statement"`
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("managed storage IAM policy is invalid: %w", err)
	}
	if document.Version != "2012-10-17" || len(document.Statement) == 0 || len(document.Statement) > 16 {
		return errors.New("managed storage IAM policy must have version 2012-10-17 and 1-16 statements")
	}
	for _, statement := range document.Statement {
		if statement.Effect != "Allow" {
			return errors.New("managed storage IAM policy statements must allow")
		}
		if len(statement.Action) == 0 || len(statement.Resource) == 0 {
			return errors.New("managed storage IAM policy statements need actions and resources")
		}
		for _, action := range statement.Action {
			if action == "s3:ListAllMyBuckets" {
				return errors.New("managed storage IAM policy must not grant s3:ListAllMyBuckets (SeaweedFS already lists only permitted buckets)")
			}
			if _, ok := seaweedfsAllowedPolicyActions[action]; !ok {
				return fmt.Errorf("managed storage IAM policy action %q is not allowed", action)
			}
		}
		for _, resource := range statement.Resource {
			if !validSeaweedFSPolicyResource(resource) {
				return fmt.Errorf("managed storage IAM policy resource %q is not allowed", resource)
			}
		}
	}
	return nil
}

func validSeaweedFSPolicyResource(resource string) bool {
	path, ok := strings.CutPrefix(resource, "arn:aws:s3:::")
	if !ok {
		return false
	}
	bucket, object, hasObject := strings.Cut(path, "/")
	if hasObject && object != "*" {
		return false
	}
	return bucket == "*" || seaweedfsPolicyBucketPattern.MatchString(bucket)
}

func (c *seaweedfsIAMClient) createKey(ctx context.Context, iam managedStorageIAM) (string, error) {
	plan, err := validateSeaweedFSCreateKey(iam, c.now())
	if err != nil {
		return "", err
	}
	// A principal belongs to exactly one Opfield key: a retried create (for
	// example after a lost response) converges by discarding whatever the
	// previous attempt left behind.
	if err := c.removePrincipal(ctx, iam.Principal); err != nil {
		return "", fmt.Errorf("reset managed storage IAM principal: %w", err)
	}
	if err := c.call(ctx, "CreateUser", url.Values{"UserName": {iam.Principal}}, nil); err != nil {
		return "", err
	}
	abandon := func(cause error) (string, error) {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = c.removePrincipal(cleanupCtx, iam.Principal)
		return "", cause
	}
	if err := c.call(ctx, "PutUserPolicy", url.Values{"UserName": {iam.Principal}, "PolicyName": {seaweedfsInlinePolicyName}, "PolicyDocument": {plan.Policy}}, nil); err != nil {
		return abandon(err)
	}
	// SeaweedFS keeps inline policies of deleted users and re-attaches them
	// when a user of the same name is created again. Only the Opfield policy
	// may remain.
	names, err := c.listUserPolicies(ctx, iam.Principal)
	if err != nil {
		return abandon(err)
	}
	for _, name := range names {
		if name == seaweedfsInlinePolicyName {
			continue
		}
		if err := c.call(ctx, "DeleteUserPolicy", url.Values{"UserName": {iam.Principal}, "PolicyName": {name}}, nil); err != nil && !isSeaweedFSNoSuchEntity(err) {
			return abandon(err)
		}
	}
	result := map[string]string{"principal": iam.Principal}
	if plan.ExpiresAt != nil {
		params := url.Values{"ParentUser": {iam.Principal}, "Expiration": {strconv.FormatInt(plan.ExpiresAt.Unix(), 10)}}
		if iam.Name != "" {
			params.Set("Description", iam.Name)
		}
		var response struct {
			Result struct {
				ServiceAccount struct {
					AccessKeyID     string `xml:"AccessKeyId"`
					SecretAccessKey string `xml:"SecretAccessKey"`
					Expiration      string `xml:"Expiration"`
				} `xml:"ServiceAccount"`
			} `xml:"CreateServiceAccountResult"`
		}
		if err := c.call(ctx, "CreateServiceAccount", params, &response); err != nil {
			return abandon(err)
		}
		result["accessKey"] = response.Result.ServiceAccount.AccessKeyID
		result["secretKey"] = response.Result.ServiceAccount.SecretAccessKey
		result["expiresAt"] = plan.ExpiresAt.UTC().Format(time.RFC3339)
	} else {
		params := url.Values{"UserName": {iam.Principal}}
		if iam.TargetAccessKey != "" {
			params.Set("AccessKeyId", iam.TargetAccessKey)
			params.Set("SecretAccessKey", iam.TargetSecretKey)
		}
		var response struct {
			Result struct {
				AccessKey struct {
					AccessKeyID     string `xml:"AccessKeyId"`
					SecretAccessKey string `xml:"SecretAccessKey"`
				} `xml:"AccessKey"`
			} `xml:"CreateAccessKeyResult"`
		}
		if err := c.call(ctx, "CreateAccessKey", params, &response); err != nil {
			return abandon(err)
		}
		result["accessKey"] = response.Result.AccessKey.AccessKeyID
		result["secretKey"] = response.Result.AccessKey.SecretAccessKey
	}
	if result["accessKey"] == "" || result["secretKey"] == "" {
		return abandon(errors.New("SeaweedFS returned an incomplete access key"))
	}
	if err := c.confirmCredentials(ctx, result["accessKey"], result["secretKey"]); err != nil {
		return abandon(err)
	}
	result["accessKeyId"] = result["accessKey"]
	return jsonString(result)
}

// updatePolicy replaces the Opfield inline policy of an existing principal.
// The migration write freeze uses it to make a key read-only and to restore it
// afterwards; the principal's access keys and service accounts keep their ids,
// secrets and expiry. A missing principal is an error rather than being
// recreated: its keys would be gone. The static root identity is not an IAM
// user and cannot be addressed here.
func (c *seaweedfsIAMClient) updatePolicy(ctx context.Context, iam managedStorageIAM) (string, error) {
	if err := validateSeaweedFSPolicyUpdate(iam); err != nil {
		return "", err
	}
	if err := c.call(ctx, "GetUser", url.Values{"UserName": {iam.Principal}}, nil); err != nil {
		return "", err
	}
	if err := c.call(ctx, "PutUserPolicy", url.Values{"UserName": {iam.Principal}, "PolicyName": {seaweedfsInlinePolicyName}, "PolicyDocument": {iam.Policy}}, nil); err != nil {
		return "", err
	}
	return jsonString(map[string]string{"status": "updated", "principal": iam.Principal})
}

type seaweedfsKeyView struct {
	AccessKey string `json:"accessKey"`
	Kind      string `json:"kind"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

type seaweedfsPrincipalView struct {
	Principal string             `json:"principal"`
	Keys      []seaweedfsKeyView `json:"keys"`
}

func (c *seaweedfsIAMClient) listKeys(ctx context.Context, principal string) (string, error) {
	principals := []string{principal}
	if principal == "" {
		users, err := c.listOpfieldPrincipals(ctx)
		if err != nil {
			return "", err
		}
		principals = users
	}
	views := make([]seaweedfsPrincipalView, 0, len(principals))
	all := []string{}
	for _, name := range principals {
		keys, err := c.principalKeys(ctx, name)
		if isSeaweedFSNoSuchEntity(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		for _, key := range keys {
			all = append(all, key.AccessKey)
		}
		views = append(views, seaweedfsPrincipalView{Principal: name, Keys: keys})
	}
	sort.Strings(all)
	sort.Slice(views, func(i, j int) bool { return views[i].Principal < views[j].Principal })
	return jsonString(map[string]any{"accessKeys": all, "principals": views})
}

func (c *seaweedfsIAMClient) removeKey(ctx context.Context, iam managedStorageIAM) (string, error) {
	principal := iam.Principal
	if principal == "" {
		owner, err := c.findPrincipalForKey(ctx, iam.TargetAccessKey)
		if err != nil {
			return "", err
		}
		principal = owner
	}
	if principal != "" {
		if err := c.removePrincipal(ctx, principal); err != nil {
			return "", err
		}
	}
	return `{"status":"deleted"}`, nil
}

func (c *seaweedfsIAMClient) findPrincipalForKey(ctx context.Context, accessKey string) (string, error) {
	principals, err := c.listOpfieldPrincipals(ctx)
	if err != nil {
		return "", err
	}
	for _, principal := range principals {
		keys, err := c.principalKeys(ctx, principal)
		if isSeaweedFSNoSuchEntity(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		for _, key := range keys {
			if key.AccessKey == accessKey {
				return principal, nil
			}
		}
	}
	return "", nil
}

// removePrincipal deletes an Opfield principal completely. SeaweedFS refuses to
// delete a user that still owns service accounts, and keeps inline policies of
// deleted users, so both are removed first. A missing user is success.
func (c *seaweedfsIAMClient) removePrincipal(ctx context.Context, principal string) error {
	if !seaweedfsPrincipalPattern.MatchString(principal) {
		return errors.New("managed storage IAM principal is invalid")
	}
	if err := c.call(ctx, "GetUser", url.Values{"UserName": {principal}}, nil); err != nil {
		if isSeaweedFSNoSuchEntity(err) {
			return nil
		}
		return err
	}
	accounts, err := c.listServiceAccounts(ctx, principal)
	if err != nil && !isSeaweedFSNoSuchEntity(err) {
		return err
	}
	for _, account := range accounts {
		if err := c.call(ctx, "DeleteServiceAccount", url.Values{"ServiceAccountId": {account.ID}}, nil); err != nil && !isSeaweedFSNoSuchEntity(err) {
			return err
		}
	}
	policies, err := c.listUserPolicies(ctx, principal)
	if err != nil && !isSeaweedFSNoSuchEntity(err) {
		return err
	}
	for _, name := range policies {
		if err := c.call(ctx, "DeleteUserPolicy", url.Values{"UserName": {principal}, "PolicyName": {name}}, nil); err != nil && !isSeaweedFSNoSuchEntity(err) {
			return err
		}
	}
	keys, err := c.listAccessKeys(ctx, principal)
	if err != nil && !isSeaweedFSNoSuchEntity(err) {
		return err
	}
	for _, key := range keys {
		if err := c.call(ctx, "DeleteAccessKey", url.Values{"UserName": {principal}, "AccessKeyId": {key}}, nil); err != nil && !isSeaweedFSNoSuchEntity(err) {
			return err
		}
	}
	if err := c.call(ctx, "DeleteUser", url.Values{"UserName": {principal}}, nil); err != nil && !isSeaweedFSNoSuchEntity(err) {
		return err
	}
	return nil
}

func (c *seaweedfsIAMClient) principalKeys(ctx context.Context, principal string) ([]seaweedfsKeyView, error) {
	keys, err := c.listAccessKeys(ctx, principal)
	if err != nil {
		return nil, err
	}
	views := make([]seaweedfsKeyView, 0, len(keys))
	for _, key := range keys {
		views = append(views, seaweedfsKeyView{AccessKey: key, Kind: "access_key"})
	}
	accounts, err := c.listServiceAccounts(ctx, principal)
	if err != nil {
		return nil, err
	}
	for _, account := range accounts {
		views = append(views, seaweedfsKeyView{AccessKey: account.AccessKey, Kind: "service_account", ExpiresAt: account.Expiration})
	}
	sort.Slice(views, func(i, j int) bool { return views[i].AccessKey < views[j].AccessKey })
	return views, nil
}

func (c *seaweedfsIAMClient) listOpfieldPrincipals(ctx context.Context) ([]string, error) {
	var principals []string
	err := c.paginate(ctx, "ListUsers", url.Values{}, func(body []byte) (string, bool, error) {
		var response struct {
			Result struct {
				Users       []struct{ UserName string } `xml:"Users>member"`
				IsTruncated bool                        `xml:"IsTruncated"`
				Marker      string                      `xml:"Marker"`
			} `xml:"ListUsersResult"`
		}
		if err := xml.Unmarshal(body, &response); err != nil {
			return "", false, err
		}
		for _, user := range response.Result.Users {
			if seaweedfsPrincipalPattern.MatchString(user.UserName) {
				principals = append(principals, user.UserName)
			}
		}
		return response.Result.Marker, response.Result.IsTruncated, nil
	})
	sort.Strings(principals)
	return principals, err
}

func (c *seaweedfsIAMClient) listAccessKeys(ctx context.Context, principal string) ([]string, error) {
	var keys []string
	err := c.paginate(ctx, "ListAccessKeys", url.Values{"UserName": {principal}}, func(body []byte) (string, bool, error) {
		var response struct {
			Result struct {
				Keys        []struct{ AccessKeyId string } `xml:"AccessKeyMetadata>member"`
				IsTruncated bool                           `xml:"IsTruncated"`
				Marker      string                         `xml:"Marker"`
			} `xml:"ListAccessKeysResult"`
		}
		if err := xml.Unmarshal(body, &response); err != nil {
			return "", false, err
		}
		for _, key := range response.Result.Keys {
			keys = append(keys, key.AccessKeyId)
		}
		return response.Result.Marker, response.Result.IsTruncated, nil
	})
	return keys, err
}

type seaweedfsServiceAccount struct {
	ID         string
	AccessKey  string
	Expiration string
}

func (c *seaweedfsIAMClient) listServiceAccounts(ctx context.Context, principal string) ([]seaweedfsServiceAccount, error) {
	var accounts []seaweedfsServiceAccount
	err := c.paginate(ctx, "ListServiceAccounts", url.Values{"ParentUser": {principal}}, func(body []byte) (string, bool, error) {
		var response struct {
			Result struct {
				Accounts []struct {
					ServiceAccountID string `xml:"ServiceAccountId"`
					ParentUser       string `xml:"ParentUser"`
					AccessKeyID      string `xml:"AccessKeyId"`
					Expiration       string `xml:"Expiration"`
				} `xml:"ServiceAccounts>member"`
				IsTruncated bool   `xml:"IsTruncated"`
				Marker      string `xml:"Marker"`
			} `xml:"ListServiceAccountsResult"`
		}
		if err := xml.Unmarshal(body, &response); err != nil {
			return "", false, err
		}
		for _, account := range response.Result.Accounts {
			// The filter is advisory on some versions; never act on another
			// principal's service account.
			if account.ParentUser != principal {
				continue
			}
			accounts = append(accounts, seaweedfsServiceAccount{ID: account.ServiceAccountID, AccessKey: account.AccessKeyID, Expiration: account.Expiration})
		}
		return response.Result.Marker, response.Result.IsTruncated, nil
	})
	return accounts, err
}

func (c *seaweedfsIAMClient) listUserPolicies(ctx context.Context, principal string) ([]string, error) {
	var names []string
	err := c.paginate(ctx, "ListUserPolicies", url.Values{"UserName": {principal}}, func(body []byte) (string, bool, error) {
		var response struct {
			Result struct {
				Names       []string `xml:"PolicyNames>member"`
				IsTruncated bool     `xml:"IsTruncated"`
				Marker      string   `xml:"Marker"`
			} `xml:"ListUserPoliciesResult"`
		}
		if err := xml.Unmarshal(body, &response); err != nil {
			return "", false, err
		}
		names = append(names, response.Result.Names...)
		return response.Result.Marker, response.Result.IsTruncated, nil
	})
	return names, err
}

func (c *seaweedfsIAMClient) paginate(ctx context.Context, action string, params url.Values, page func([]byte) (string, bool, error)) error {
	marker := ""
	for index := 0; index < seaweedfsIAMMaxPages; index++ {
		request := url.Values{}
		for name, values := range params {
			request[name] = values
		}
		if marker != "" {
			request.Set("Marker", marker)
		}
		body, err := c.do(ctx, action, request)
		if err != nil {
			return err
		}
		next, truncated, err := page(body)
		if err != nil {
			return fmt.Errorf("decode SeaweedFS %s response: %w", action, err)
		}
		if !truncated || next == "" || next == marker {
			return nil
		}
		marker = next
	}
	return fmt.Errorf("SeaweedFS %s returned too many pages", action)
}

func (c *seaweedfsIAMClient) call(ctx context.Context, action string, params url.Values, out any) error {
	body, err := c.do(ctx, action, params)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := xml.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode SeaweedFS %s response: %w", action, err)
	}
	return nil
}

func (c *seaweedfsIAMClient) do(ctx context.Context, action string, params url.Values) ([]byte, error) {
	form := url.Values{}
	for name, values := range params {
		form[name] = values
	}
	form.Set("Action", action)
	form.Set("Version", seaweedfsIAMVersion)
	payload := []byte(form.Encode())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"/", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
	hash := sigV4Hash(payload)
	request.Header.Set(sigV4ContentHashKey, hash)
	signSigV4(request, hash, c.accessKey, c.secretKey, seaweedfsIAMRegion, "iam", c.now())
	response, err := c.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("SeaweedFS %s request: %w", action, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("read SeaweedFS %s response: %w", action, err)
	}
	if response.StatusCode/100 != 2 {
		return nil, parseSeaweedFSIAMError(response.StatusCode, body)
	}
	return body, nil
}

// parseSeaweedFSIAMError understands both IAM (<ErrorResponse><Error>) and
// S3 (<Error>) error documents; authentication failures use the latter.
func parseSeaweedFSIAMError(status int, body []byte) error {
	var document struct {
		Nested struct {
			Code    string `xml:"Code"`
			Message string `xml:"Message"`
		} `xml:"Error"`
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	_ = xml.Unmarshal(body, &document)
	result := &seaweedfsIAMError{Status: status, Code: document.Code, Message: document.Message}
	if document.Nested.Code != "" {
		result.Code, result.Message = document.Nested.Code, document.Nested.Message
	}
	if result.Code == "" {
		result.Code = http.StatusText(status)
	}
	return result
}

// confirmCredentials waits until a new key authenticates: IAM changes reach
// the S3 authenticator through the filer's metadata subscription.
func (c *seaweedfsIAMClient) confirmCredentials(ctx context.Context, accessKey, secretKey string) error {
	deadline := time.Now().Add(seaweedfsKeyConfirmTimeout)
	var lastErr error
	for {
		status, err := c.listBucketsStatus(ctx, accessKey, secretKey)
		if err == nil && status == http.StatusOK {
			return nil
		}
		if err != nil {
			lastErr = err
		} else {
			lastErr = fmt.Errorf("ListBuckets returned HTTP %d", status)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("new managed storage access key did not authenticate: %w", lastErr)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (c *seaweedfsIAMClient) listBucketsStatus(ctx context.Context, accessKey, secretKey string) (int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint+"/", nil)
	if err != nil {
		return 0, err
	}
	request.Header.Set(sigV4ContentHashKey, sigV4EmptyBodyHash)
	signSigV4(request, sigV4EmptyBodyHash, accessKey, secretKey, seaweedfsIAMRegion, "s3", c.now())
	response, err := c.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024*1024))
	return response.StatusCode, nil
}
