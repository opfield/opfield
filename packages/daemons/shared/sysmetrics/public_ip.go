package sysmetrics

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	publicIPRequestTimeout       = 3 * time.Second
	publicIPVerifyInterval       = 15 * time.Minute
	publicIPFullRefreshInterval  = 6 * time.Hour
	publicIPFullRefreshJitter    = 30 * time.Minute
	publicIPMaxSamples           = 10
	publicIPMaxResponseBodyBytes = 128
)

var defaultPublicIPProviders = []string{
	"https://api64.ipify.org",
	"https://ifconfig.me/ip",
	"https://checkip.amazonaws.com",
}

var nonPublicAddressPrefixes = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
}

type publicIPFetcher func(context.Context, string) (netip.Addr, error)

// PublicIPDetector periodically samples independent external services and
// caches the public egress addresses observed for the host.
type PublicIPDetector struct {
	mu        sync.RWMutex
	addresses []string
	providers []string
	fetch     publicIPFetcher
}

func NewPublicIPDetector() *PublicIPDetector {
	return &PublicIPDetector{
		providers: append([]string(nil), defaultPublicIPProviders...),
		fetch:     fetchPublicIPAddress,
	}
}

func (d *PublicIPDetector) Addresses() []string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return append([]string(nil), d.addresses...)
}

// Run performs discovery immediately, then verifies the cached set
// periodically. A full sample replaces the cache only when at least one
// provider succeeds, preserving the last successful result during outages.
func (d *PublicIPDetector) Run(ctx context.Context) {
	d.refresh(ctx)

	verifyTicker := time.NewTicker(publicIPVerifyInterval)
	defer verifyTicker.Stop()

	fullRefreshTimer := time.NewTimer(nextPublicIPFullRefreshDelay())
	defer fullRefreshTimer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-verifyTicker.C:
			d.verify(ctx)
		case <-fullRefreshTimer.C:
			d.refresh(ctx)
			fullRefreshTimer.Reset(nextPublicIPFullRefreshDelay())
		}
	}
}

func (d *PublicIPDetector) verify(ctx context.Context) {
	observed := d.sample(ctx, 1)
	if len(observed) == 0 {
		return
	}

	known := make(map[string]struct{})
	for _, address := range d.Addresses() {
		known[address] = struct{}{}
	}
	for _, address := range observed {
		if _, exists := known[address]; !exists {
			d.refresh(ctx)
			return
		}
	}
}

func (d *PublicIPDetector) refresh(ctx context.Context) {
	addresses := d.sample(ctx, publicIPMaxSamples)
	if len(addresses) == 0 {
		return
	}

	d.mu.Lock()
	d.addresses = addresses
	d.mu.Unlock()
}

func (d *PublicIPDetector) sample(ctx context.Context, samplesPerProvider int) []string {
	unique := make(map[string]struct{})

	for range samplesPerProvider {
		results := make(chan netip.Addr, len(d.providers))
		var wg sync.WaitGroup
		for _, provider := range d.providers {
			wg.Add(1)
			go func(url string) {
				defer wg.Done()
				address, err := d.fetch(ctx, url)
				if err == nil && isPublicIPAddress(address) {
					results <- address.Unmap()
				}
			}(provider)
		}
		wg.Wait()
		close(results)

		for address := range results {
			unique[address.String()] = struct{}{}
		}
	}

	addresses := make([]string, 0, len(unique))
	for address := range unique {
		addresses = append(addresses, address)
	}
	slices.Sort(addresses)
	return addresses
}

func fetchPublicIPAddress(ctx context.Context, url string) (netip.Addr, error) {
	requestCtx, cancel := context.WithTimeout(ctx, publicIPRequestTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, url, nil)
	if err != nil {
		return netip.Addr{}, err
	}
	request.Header.Set("Accept", "text/plain")
	request.Header.Set("Cache-Control", "no-cache")
	request.Header.Set("User-Agent", "Opfield-Daemon/public-ip-discovery")

	transport := &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
		DialContext: (&net.Dialer{
			Timeout: publicIPRequestTimeout,
		}).DialContext,
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{
		Transport: transport,
		Timeout:   publicIPRequestTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("public IP provider redirect rejected")
		},
	}

	response, err := client.Do(request)
	if err != nil {
		return netip.Addr{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return netip.Addr{}, fmt.Errorf("public IP provider returned HTTP %d", response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, publicIPMaxResponseBodyBytes+1))
	if err != nil {
		return netip.Addr{}, err
	}
	if len(body) > publicIPMaxResponseBodyBytes {
		return netip.Addr{}, errors.New("public IP provider response is too large")
	}

	address, err := netip.ParseAddr(strings.TrimSpace(string(body)))
	if err != nil {
		return netip.Addr{}, fmt.Errorf("invalid public IP provider response: %w", err)
	}
	address = address.Unmap()
	if !isPublicIPAddress(address) {
		return netip.Addr{}, errors.New("public IP provider returned a non-public address")
	}
	return address, nil
}

func isPublicIPAddress(address netip.Addr) bool {
	if !address.IsValid() ||
		!address.IsGlobalUnicast() ||
		address.IsPrivate() ||
		address.IsLoopback() ||
		address.IsLinkLocalUnicast() ||
		address.IsUnspecified() {
		return false
	}
	for _, prefix := range nonPublicAddressPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func mergePublicIPAddresses(groups ...[]string) []string {
	unique := make(map[string]struct{})
	for _, group := range groups {
		for _, address := range group {
			unique[address] = struct{}{}
		}
	}
	result := make([]string, 0, len(unique))
	for address := range unique {
		result = append(result, address)
	}
	slices.Sort(result)
	return result
}

func nextPublicIPFullRefreshDelay() time.Duration {
	return publicIPFullRefreshInterval - publicIPFullRefreshJitter +
		time.Duration(rand.Int64N(int64(2*publicIPFullRefreshJitter)+1))
}
