package daemon

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

const (
	pagesProbeBodyLimit         = 1024 * 1024
	pagesProbeExpectedBodyLimit = 64 * 1024
	pagesProbePathLimit         = 4096
)

var pagesProbeDomainPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)
var pagesProbeListenPattern = regexp.MustCompile("(?m)listen[ \\t]+([^;{}\\r\\n]+);")

type pagesProbeResult struct {
	OK         bool  `json:"ok"`
	HTTPStatus int   `json:"httpStatus,omitempty"`
	ResponseMs int64 `json:"responseMs,omitempty"`
}

func normalizePagesProbeDomain(value string) (string, error) {
	if strings.TrimSpace(value) != value {
		return "", errors.New("invalid Pages Route probe domain")
	}
	domain := strings.ToLower(strings.TrimSuffix(value, "."))
	if domain == "" || len(domain) > 253 || strings.Contains(domain, "..") ||
		strings.HasPrefix(domain, "*.") || !pagesProbeDomainPattern.MatchString(domain) {
		return "", errors.New("invalid Pages Route probe domain")
	}
	for _, label := range strings.Split(domain, ".") {
		if len(label) == 0 || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "", errors.New("invalid Pages Route probe domain")
		}
	}
	return domain, nil
}

func normalizePagesProbeListenAddress(token string) (string, bool) {
	host := ""
	portText := token
	if strings.HasPrefix(token, "[") {
		if separator := strings.LastIndex(token, "]:"); separator >= 0 {
			host = token[1:separator]
			portText = token[separator+2:]
		} else if strings.HasSuffix(token, "]") {
			host = strings.TrimSuffix(strings.TrimPrefix(token, "["), "]")
			portText = "80"
		}
	} else if colon := strings.LastIndexByte(token, ':'); colon >= 0 {
		host = token[:colon]
		portText = token[colon+1:]
	} else if net.ParseIP(token) != nil || token == "localhost" || token == "*" {
		host = token
		portText = "80"
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 || port > 65535 {
		return "", false
	}
	switch host {
	case "", "*", "0.0.0.0", "localhost":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	default:
		if net.ParseIP(host) == nil {
			return "", false
		}
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), true
}

func pagesProbeListenAddress(configContent []byte, tlsEnabled bool) (string, error) {
	lines := strings.Split(string(configContent), "\n")
	for index, line := range lines {
		if comment := strings.IndexByte(line, '#'); comment >= 0 {
			lines[index] = line[:comment]
		}
	}
	effectiveConfig := strings.Join(lines, "\n")
	for _, match := range pagesProbeListenPattern.FindAllStringSubmatchIndex(effectiveConfig, -1) {
		if start := match[0]; start > 0 && !strings.ContainsRune(" \t\r\n{};", rune(effectiveConfig[start-1])) {
			continue
		}
		fields := strings.Fields(effectiveConfig[match[2]:match[3]])
		if len(fields) == 0 {
			continue
		}
		hasTLS := false
		for _, option := range fields[1:] {
			if option == "ssl" {
				hasTLS = true
				break
			}
		}
		if hasTLS != tlsEnabled || strings.HasPrefix(fields[0], "unix:") {
			continue
		}
		if address, ok := normalizePagesProbeListenAddress(fields[0]); ok {
			return address, nil
		}
	}
	protocol := "HTTP"
	if tlsEnabled {
		protocol = "HTTPS"
	}
	return "", fmt.Errorf("Pages Route config has no usable %s listener", protocol)
}

func validatePagesProbeCommand(command *pb.ProbePagesRouteCommand) (string, *url.URL, time.Duration, error) {
	if command == nil || !secureLinkIDPattern.MatchString(command.RouteId) {
		return "", nil, 0, errors.New("invalid Pages Route probe")
	}
	domain, err := normalizePagesProbeDomain(command.Domain)
	if err != nil {
		return "", nil, 0, err
	}
	requestURL, err := url.ParseRequestURI(command.Path)
	if err != nil || len(command.Path) > pagesProbePathLimit || !strings.HasPrefix(command.Path, "/") || requestURL.IsAbs() || requestURL.Host != "" {
		return "", nil, 0, errors.New("Pages Route probe path must be a relative absolute-path reference")
	}
	if (command.ExpectedStatus != 0 && (command.ExpectedStatus < 100 || command.ExpectedStatus > 599)) ||
		len(command.ExpectedBody) > pagesProbeExpectedBodyLimit {
		return "", nil, 0, errors.New("invalid Pages Route probe expectation")
	}
	switch command.BodyMatchMode {
	case "", "includes", "exact", "starts_with", "ends_with":
	default:
		return "", nil, 0, errors.New("unsupported Pages Route probe body match mode")
	}
	timeout := time.Duration(command.TimeoutSeconds) * time.Second
	if command.TimeoutSeconds == 0 {
		timeout = 10 * time.Second
	} else if timeout < time.Second || timeout > 30*time.Second {
		return "", nil, 0, errors.New("Pages Route probe timeout must be between 1 and 30 seconds")
	}
	requestURL.Scheme = "http"
	if command.Tls {
		requestURL.Scheme = "https"
	}
	requestURL.Host = domain
	return domain, requestURL, timeout, nil
}

func probePagesRoute(
	command *pb.ProbePagesRouteCommand,
	dialContext func(context.Context, string, string) (net.Conn, error),
) (string, error) {
	domain, requestURL, timeout, err := validatePagesProbeCommand(command)
	if err != nil {
		return "", err
	}
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext:       dialContext,
		// The node-local probe verifies the configured nginx Route. Public trust
		// and certificate replica health are tracked by the TLS distribution path.
		TLSClientConfig: &tls.Config{ServerName: domain, InsecureSkipVerify: true}, // #nosec G402
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequest(http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return "", err
	}
	request.Host = domain
	started := time.Now()
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	passed := response.StatusCode >= 200 && response.StatusCode < 300
	if command.ExpectedStatus != 0 {
		passed = response.StatusCode == int(command.ExpectedStatus)
	}
	if passed && command.ExpectedBody != "" {
		body, err := io.ReadAll(io.LimitReader(response.Body, pagesProbeBodyLimit+1))
		if err != nil {
			return "", err
		}
		if len(body) > pagesProbeBodyLimit {
			return "", errors.New("Pages Route probe response is too large")
		}
		actual := string(body)
		switch command.BodyMatchMode {
		case "exact":
			passed = actual == command.ExpectedBody
		case "starts_with":
			passed = strings.HasPrefix(actual, command.ExpectedBody)
		case "ends_with":
			passed = strings.HasSuffix(actual, command.ExpectedBody)
		default:
			passed = strings.Contains(actual, command.ExpectedBody)
		}
	}
	detail, err := json.Marshal(pagesProbeResult{
		OK:         passed,
		HTTPStatus: response.StatusCode,
		ResponseMs: time.Since(started).Milliseconds(),
	})
	return string(detail), err
}

func (p *NginxPlugin) ProbePagesRoute(command *pb.ProbePagesRouteCommand) (string, error) {
	if p.pagesRuntime == nil || !p.pagesV1Available {
		return "", errors.New("Pages runtime is unavailable")
	}
	if command == nil || !secureLinkIDPattern.MatchString(command.RouteId) {
		return "", errors.New("invalid Pages Route probe")
	}
	configContent, err := nginx.ReadFile(p.mgr.ConfigPath(command.RouteId))
	if err != nil {
		return "", fmt.Errorf("read Pages Route config: %w", err)
	}
	if len(configContent) == 0 {
		return "", errors.New("Pages Route config is unavailable")
	}
	address, err := pagesProbeListenAddress(configContent, command.Tls)
	if err != nil {
		return "", err
	}
	dialer := &net.Dialer{}
	return probePagesRoute(command, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, address)
	})
}
