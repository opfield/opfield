package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/go-connections/sockets"
	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/daemon-shared/leasefence"
	"github.com/opfield/opfield/daemon-shared/leasewatchdog"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

// Labels of managed objects are net.opfield.<name>. Pre-Opfield daemons wrote
// the pre-2.12.1 label keys (legacycompat);
// containers, networks and volumes cannot be relabelled in place, so those
// keys stay until an object is recreated for its own reasons (a deploy, an
// update), never just to rename it.
//
// The daemon handles both in one place, the HTTP transport of its Docker
// client (labelTransport):
//   - every label map Docker returns (inspect and list of containers,
//     networks, volumes, images) also gets the Opfield key of each
//     pre-Opfield one it has, so code reads only the Opfield keys;
//   - a list filtered by an Opfield label is also run with the pre-Opfield key
//     and the results are merged (a Docker label filter cannot say "or");
//   - a create converts pre-Opfield keys to Opfield ones; until this start is
//     confirmed it writes both, since the launcher may still roll back to a
//     daemon that reads only the old keys.
//
// Docker events carry container labels as attributes: those reads go through
// labelValue. The Compose sidecar talks to Docker directly; see
// composeLabelKeys.
const (
	labelPrefix = "net.opfield."
	// legacy-name: legacycompat.LabelPrefix* and legacycompat.ComLabelPrefixmanaged-volume* labels — remove once every node reports none
	legacyLabelPrefix       = legacycompat.LabelPrefix
	legacyVolumeLabelPrefix = legacycompat.ComLabelPrefix + "managed-volume"
)

// legacyLabelKey is the pre-Opfield key of an Opfield label key ("" for any
// other key).
func legacyLabelKey(key string) string {
	rest, ok := strings.CutPrefix(key, labelPrefix)
	if !ok || rest == "" {
		return ""
	}
	if strings.HasPrefix(rest, "managed-volume") {
		return legacycompat.ComLabelPrefix + rest
	}
	return legacyLabelPrefix + rest
}

// opfieldLabelKey is the Opfield key of a pre-Opfield label key ("" for any
// other key).
func opfieldLabelKey(key string) string {
	if strings.HasPrefix(key, legacyVolumeLabelPrefix) {
		return labelPrefix + strings.TrimPrefix(key, legacycompat.ComLabelPrefix)
	}
	if rest, ok := strings.CutPrefix(key, legacyLabelPrefix); ok && rest != "" {
		return labelPrefix + rest
	}
	return ""
}

// isLegacyLabelKey reports whether key is a pre-Opfield managed label.
func isLegacyLabelKey(key string) bool { return opfieldLabelKey(key) != "" }

// labelValue reads an Opfield label from labels that may carry it under its
// pre-Opfield key only (event attributes, maps not read through the client).
func labelValue(labels map[string]string, key string) string {
	value, _ := labelLookup(labels, key)
	return value
}

func labelLookup(labels map[string]string, key string) (string, bool) {
	if value, ok := labels[key]; ok {
		return value, true
	}
	if legacy := legacyLabelKey(key); legacy != "" {
		value, ok := labels[legacy]
		return value, ok
	}
	return "", false
}

// hasLegacyLabels reports whether an object still carries pre-Opfield labels.
func hasLegacyLabels(labels map[string]string) bool {
	for key := range labels {
		if isLegacyLabelKey(key) {
			return true
		}
	}
	return false
}

// withOpfieldLabels returns labels with the Opfield key of every pre-Opfield
// one added (an Opfield key already present wins), or labels itself when there
// is nothing to add.
func withOpfieldLabels(labels map[string]string) map[string]string {
	var out map[string]string
	for key, value := range labels {
		next := opfieldLabelKey(key)
		if next == "" {
			continue
		}
		if _, ok := labels[next]; ok {
			continue
		}
		if out == nil {
			out = make(map[string]string, len(labels)+4)
			for k, v := range labels {
				out[k] = v
			}
		}
		out[next] = value
	}
	if out == nil {
		return labels
	}
	return out
}

// withoutLegacyLabels drops the pre-Opfield keys whose Opfield key is present.
func withoutLegacyLabels(labels map[string]string) map[string]string {
	out := make(map[string]string, len(labels))
	for key, value := range labels {
		if next := opfieldLabelKey(key); next != "" {
			if _, ok := labels[next]; ok {
				continue
			}
		}
		out[key] = value
	}
	return out
}

// labelsForCreate are the labels a create writes: Opfield keys only once the
// start is confirmed, both families before.
func labelsForCreate(labels map[string]string, confirmed bool) map[string]string {
	out := make(map[string]string, len(labels))
	for key, value := range labels {
		if next := opfieldLabelKey(key); next != "" {
			current, ok := labels[next]
			if !ok {
				out[next] = value
				current = value
			}
			if !confirmed {
				// The Opfield key is the one the daemon updates (a recreate
				// with a new image reference), so the old key gets its value.
				out[key] = current
			}
			continue
		}
		out[key] = value
		if !confirmed {
			if legacy := legacyLabelKey(key); legacy != "" {
				if _, ok := labels[legacy]; !ok {
					out[legacy] = value
				}
			}
		}
	}
	return out
}

var (
	dockerAPIVersionPrefix = `^(?:/v[0-9.]+)?`
	labelCreatePath        = regexp.MustCompile(dockerAPIVersionPrefix + `/(?:containers|networks|volumes)/create$`)
	labelListPath          = regexp.MustCompile(dockerAPIVersionPrefix + `/(?:containers/json|networks|volumes)$`)
	labelReadPath          = regexp.MustCompile(dockerAPIVersionPrefix + `/(?:containers/json|containers/[^/]+/json|networks|networks/[^/]+|volumes|volumes/[^/]+|images/.+/json)$`)
)

// labelTransport implements the label handling described at the top of this
// file around the Docker client's HTTP transport.
type labelTransport struct {
	base http.RoundTripper
	// confirmed reports whether this start is confirmed.
	confirmed func() bool
}

func newLabelTransport(base http.RoundTripper) *labelTransport {
	return &labelTransport{base: base, confirmed: lifecycle.StartConfirmed}
}

func (t *labelTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	switch {
	case request.Method == http.MethodPost && labelCreatePath.MatchString(request.URL.Path):
		if err := t.rewriteCreate(request); err != nil {
			return nil, err
		}
		return t.base.RoundTrip(request)
	case request.Method == http.MethodGet && labelListPath.MatchString(request.URL.Path):
		if legacy := legacyLabelFilterQuery(request.URL); legacy != "" {
			return t.mergedList(request, legacy)
		}
	}
	response, err := t.base.RoundTrip(request)
	if err != nil || request.Method != http.MethodGet || !labelReadPath.MatchString(request.URL.Path) {
		return response, err
	}
	return normalizeLabelResponse(response)
}

// rewriteCreate converts the top-level Labels of a create body.
func (t *labelTransport) rewriteCreate(request *http.Request) error {
	if request.Body == nil || request.Body == http.NoBody {
		return nil
	}
	body, err := io.ReadAll(request.Body)
	_ = request.Body.Close()
	if err != nil {
		return err
	}
	if rewritten, ok := createBodyWithLabels(body, t.confirmed()); ok {
		body = rewritten
	}
	request.Body = io.NopCloser(bytes.NewReader(body))
	request.ContentLength = int64(len(body))
	request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	if request.Header != nil {
		request.Header.Set("Content-Length", strconv.Itoa(len(body)))
	}
	return nil
}

func createBodyWithLabels(body []byte, confirmed bool) ([]byte, bool) {
	if !bytes.Contains(body, []byte(labelPrefix)) && !bytes.Contains(body, []byte(legacyLabelPrefix)) && !bytes.Contains(body, []byte(legacyVolumeLabelPrefix)) {
		return nil, false
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, false
	}
	raw, ok := document["Labels"]
	if !ok {
		return nil, false
	}
	var labels map[string]string
	if err := json.Unmarshal(raw, &labels); err != nil || len(labels) == 0 {
		return nil, false
	}
	encoded, err := json.Marshal(labelsForCreate(labels, confirmed))
	if err != nil {
		return nil, false
	}
	document["Labels"] = encoded
	rewritten, err := json.Marshal(document)
	if err != nil {
		return nil, false
	}
	return rewritten, true
}

// legacyLabelFilterQuery is the raw query of the same list with every Opfield
// label filter written with its pre-Opfield key, or "" when the request
// filters by no Opfield label.
func legacyLabelFilterQuery(target *url.URL) string {
	query := target.Query()
	raw := query.Get("filters")
	if raw == "" {
		return ""
	}
	var filters map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &filters); err != nil {
		return ""
	}
	labelFilter, ok := filters["label"]
	if !ok {
		return ""
	}
	// The client sends {"label":{"key=value":true}}; older forms are a list.
	var asSet map[string]bool
	var asList []string
	changed := false
	rename := func(term string) string {
		key, value, hasValue := strings.Cut(term, "=")
		legacy := legacyLabelKey(key)
		if legacy == "" {
			return term
		}
		changed = true
		if hasValue {
			return legacy + "=" + value
		}
		return legacy
	}
	var encoded []byte
	if json.Unmarshal(labelFilter, &asSet) == nil {
		next := make(map[string]bool, len(asSet))
		for term, enabled := range asSet {
			next[rename(term)] = enabled
		}
		encoded, _ = json.Marshal(next)
	} else if json.Unmarshal(labelFilter, &asList) == nil {
		next := make([]string, 0, len(asList))
		for _, term := range asList {
			next = append(next, rename(term))
		}
		encoded, _ = json.Marshal(next)
	} else {
		return ""
	}
	if !changed {
		return ""
	}
	filters["label"] = encoded
	rewritten, err := json.Marshal(filters)
	if err != nil {
		return ""
	}
	query.Set("filters", string(rewritten))
	return query.Encode()
}

// mergedList runs a list with its Opfield label filter and again with the
// pre-Opfield one and returns the union (by Id, or Name for volumes).
func (t *labelTransport) mergedList(request *http.Request, legacyQuery string) (*http.Response, error) {
	first, err := t.base.RoundTrip(request)
	if err != nil || first.StatusCode != http.StatusOK {
		return first, err
	}
	legacyRequest := request.Clone(request.Context())
	legacyURL := *request.URL
	legacyURL.RawQuery = legacyQuery
	legacyRequest.URL = &legacyURL
	second, err := t.base.RoundTrip(legacyRequest)
	if err != nil {
		_ = first.Body.Close()
		return nil, err
	}
	defer second.Body.Close()
	firstBody, err := io.ReadAll(first.Body)
	_ = first.Body.Close()
	if err != nil {
		return nil, err
	}
	if second.StatusCode != http.StatusOK {
		return replaceBody(first, firstBody)
	}
	secondBody, err := io.ReadAll(second.Body)
	if err != nil {
		return nil, err
	}
	merged, ok := mergeListBodies(firstBody, secondBody)
	if !ok {
		merged = firstBody
	}
	if normalized, ok := normalizeLabelJSON(merged); ok {
		merged = normalized
	}
	return replaceBody(first, merged)
}

func replaceBody(response *http.Response, body []byte) (*http.Response, error) {
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Del("Content-Length")
	response.Header.Set("Content-Length", strconv.Itoa(len(body)))
	response.TransferEncoding = nil
	return response, nil
}

// mergeListBodies unions two list responses: a JSON array of objects with Id
// (containers, networks) or {"Volumes": [...]} with Name.
func mergeListBodies(first, second []byte) ([]byte, bool) {
	mergeItems := func(a, b []json.RawMessage, idKey string) []json.RawMessage {
		seen := map[string]bool{}
		out := make([]json.RawMessage, 0, len(a)+len(b))
		for _, list := range [][]json.RawMessage{a, b} {
			for _, item := range list {
				var id map[string]json.RawMessage
				if json.Unmarshal(item, &id) != nil {
					out = append(out, item)
					continue
				}
				key := string(id[idKey])
				if key != "" && seen[key] {
					continue
				}
				seen[key] = true
				out = append(out, item)
			}
		}
		return out
	}
	var firstArray, secondArray []json.RawMessage
	if json.Unmarshal(first, &firstArray) == nil && json.Unmarshal(second, &secondArray) == nil {
		merged, err := json.Marshal(mergeItems(firstArray, secondArray, "Id"))
		return merged, err == nil
	}
	var firstObject, secondObject map[string]json.RawMessage
	if json.Unmarshal(first, &firstObject) != nil || json.Unmarshal(second, &secondObject) != nil {
		return nil, false
	}
	var firstVolumes, secondVolumes []json.RawMessage
	if json.Unmarshal(firstObject["Volumes"], &firstVolumes) != nil {
		firstVolumes = nil
	}
	if json.Unmarshal(secondObject["Volumes"], &secondVolumes) != nil {
		secondVolumes = nil
	}
	volumes, err := json.Marshal(mergeItems(firstVolumes, secondVolumes, "Name"))
	if err != nil {
		return nil, false
	}
	firstObject["Volumes"] = volumes
	merged, err := json.Marshal(firstObject)
	return merged, err == nil
}

func normalizeLabelResponse(response *http.Response) (*http.Response, error) {
	if response.StatusCode != http.StatusOK || response.Body == nil ||
		!strings.Contains(response.Header.Get("Content-Type"), "json") {
		return response, nil
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		return nil, err
	}
	if normalized, ok := normalizeLabelJSON(body); ok {
		body = normalized
	}
	return replaceBody(response, body)
}

// normalizeLabelJSON adds the Opfield key of every pre-Opfield label to each
// "Labels" object in a Docker response, keeping numbers exact.
func normalizeLabelJSON(body []byte) ([]byte, bool) {
	if !bytes.Contains(body, []byte(legacyLabelPrefix)) && !bytes.Contains(body, []byte(legacyVolumeLabelPrefix)) {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var document any
	if err := decoder.Decode(&document); err != nil {
		return nil, false
	}
	if !normalizeLabelsIn(document) {
		return nil, false
	}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(document); err != nil {
		return nil, false
	}
	return out.Bytes(), true
}

func normalizeLabelsIn(value any) bool {
	changed := false
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if key == "Labels" {
				if labels, ok := child.(map[string]any); ok {
					for labelKey, labelValue := range labels {
						next := opfieldLabelKey(labelKey)
						if next == "" {
							continue
						}
						if _, present := labels[next]; !present {
							labels[next] = labelValue
							changed = true
						}
					}
					continue
				}
			}
			if normalizeLabelsIn(child) {
				changed = true
			}
		}
	case []any:
		for _, child := range typed {
			if normalizeLabelsIn(child) {
				changed = true
			}
		}
	}
	return changed
}

// labelHTTPClient is the Docker client's HTTP client with labelTransport, for
// the same host and connection settings the client would use itself.
func labelHTTPClient(host string) (*http.Client, error) {
	hostURL, err := mobyclient.ParseHostURL(host)
	if err != nil {
		return nil, err
	}
	base := &http.Transport{MaxIdleConns: 6, IdleConnTimeout: 30 * time.Second}
	if err := sockets.ConfigureTransport(base, hostURL.Scheme, hostURL.Host); err != nil {
		return nil, err
	}
	return &http.Client{Transport: newLabelTransport(base), CheckRedirect: mobyclient.CheckRedirect}, nil
}

// Compose labels are part of the configuration hash Compose compares to decide
// whether a service is recreated. A project whose containers were labelled
// the pre-Opfield compose label keys keeps those keys, or its next
// revision would recreate every service, not only the changed ones; the keys
// change with a recreate the project's owner chooses (and the node reports the
// project among its legacy names until then).
const composeLabelNamespace = labelPrefix + "compose."

// legacy-name: compose labels of pre-Opfield Compose projects — remove once every node reports none
const legacyComposeLabelNamespace = legacyLabelPrefix + "compose."

// withComposeLabelFamily writes the injected Compose labels of request with the
// pre-Opfield keys when the project's existing containers carry those.
func (c *Client) withComposeLabelFamily(ctx context.Context, request composeRequest) composeRequest {
	if len(request.composeYAML) == 0 || !bytes.Contains(request.composeYAML, []byte(composeLabelNamespace)) {
		return request
	}
	listed, err := c.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: make(mobyclient.Filters).Add("label", "com.docker.compose.project="+request.projectName),
	})
	if err != nil {
		return request
	}
	legacy := false
	for _, item := range listed.Items {
		if _, ok := item.Labels[legacyComposeLabelNamespace+"managed"]; ok {
			legacy = true
			break
		}
	}
	if !legacy {
		return request
	}
	request.composeYAML = composeYAMLWithLegacyLabels(request.composeYAML)
	return request
}

// composeYAMLWithLegacyLabels renames the three injected Compose label keys
// (user labels cannot use either reserved namespace).
func composeYAMLWithLegacyLabels(document []byte) []byte {
	for _, name := range []string{"managed", "project-id", "revision"} {
		document = bytes.ReplaceAll(document, []byte(composeLabelNamespace+name+":"), []byte(legacyComposeLabelNamespace+name+":"))
	}
	return document
}

// legacyNameScanInterval is how often the daemon recounts the objects still
// under pre-Opfield names (listing every container, network and volume).
const legacyNameScanInterval = 5 * time.Minute

// legacyNameScan caches the legacy name counts of the health report.
type legacyNameScan struct {
	mu      sync.Mutex
	at      time.Time
	running bool
	counts  map[string]uint32
}

// current returns the last counts and starts a recount when they are stale.
func (s *legacyNameScan) current(p *DockerPlugin) map[string]uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running && time.Since(s.at) >= legacyNameScanInterval {
		s.running = true
		go func() {
			counts := p.countLegacyNames(context.Background())
			s.mu.Lock()
			s.counts, s.at, s.running = counts, time.Now(), false
			s.mu.Unlock()
		}()
	}
	return s.counts
}

// countLegacyNames counts, by kind, what on this node still carries a
// pre-Opfield name: labelled containers, networks and volumes (each is
// relabelled when recreated), host units, paths and fstab entries.
func (p *DockerPlugin) countLegacyNames(ctx context.Context) map[string]uint32 {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	counts := map[string]uint32{}
	if p.client != nil && p.client.cli != nil && p.cfg.Docker.Mode != "builder" {
		if listed, err := p.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{All: true}); err == nil {
			for _, item := range listed.Items {
				if hasLegacyLabels(item.Labels) {
					counts["containers"]++
				}
			}
		}
		if listed, err := p.client.cli.NetworkList(ctx, mobyclient.NetworkListOptions{}); err == nil {
			for _, item := range listed.Items {
				if hasLegacyLabels(item.Labels) {
					counts["networks"]++
				}
			}
		}
		if listed, err := p.client.cli.VolumeList(ctx, mobyclient.VolumeListOptions{}); err == nil {
			for _, item := range listed.Items {
				if hasLegacyLabels(item.Labels) {
					counts["volumes"]++
				}
			}
		}
	}
	host := systemVolumeImageBootHost()
	counts["units"] += legacyBootUnits(host)
	for _, path := range []string{leasewatchdog.LegacySystemdUnitPath, leasewatchdog.LegacyOpenRCPath} {
		if _, err := os.Lstat(path); err == nil {
			counts["units"]++
		}
	}
	counts["units"] += legacyBuilderUnits()
	counts["paths"] += legacyBuilderPaths()
	if leasefence.Legacy() {
		counts["paths"]++
	}
	if p.volumeImages != nil {
		counts["fstab"] += p.volumeImages.legacyFstabEntries()
	}
	for kind, count := range counts {
		if count == 0 {
			delete(counts, kind)
		}
	}
	return counts
}
