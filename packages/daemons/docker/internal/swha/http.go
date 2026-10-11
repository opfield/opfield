package swha

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	httpTimeout    = 3 * time.Second
	responseLimit  = 8 << 20
	heartbeatDir   = "/.gateway/hb/"
	heartbeatLimit = 64
	growTimeout    = time.Minute
)

type dialFunc func(ctx context.Context) (net.Conn, error)

// request sends one HTTP request over dial and returns the body and status.
func request(ctx context.Context, dial dialFunc, method, path, token string, body io.Reader) ([]byte, int, error) {
	return requestWithin(ctx, httpTimeout, dial, method, path, token, body)
}

func requestWithin(ctx context.Context, timeout time.Duration, dial dialFunc, method, path, token string, body io.Reader) ([]byte, int, error) {
	transport := &http.Transport{
		DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return dial(ctx) },
		DisableKeepAlives: true,
		Proxy:             nil,
	}
	defer transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "http://member"+path, body)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := (&http.Client{Transport: transport}).Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit))
	return data, resp.StatusCode, err
}

func getOK(ctx context.Context, dial dialFunc, path string) ([]byte, error) {
	data, status, err := request(ctx, dial, http.MethodGet, path, "", nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("GET %s answered HTTP %d", path, status)
	}
	return data, nil
}

// readHeartbeat returns the newest metadata heartbeat a filer holds (0 when it
// holds none yet).
func readHeartbeat(ctx context.Context, dial dialFunc) (int64, error) {
	data, status, err := request(ctx, dial, http.MethodGet, heartbeatDir+"?limit="+strconv.Itoa(heartbeatLimit), "", nil)
	if err != nil {
		return 0, err
	}
	if status == http.StatusNotFound {
		return 0, nil
	}
	if status != http.StatusOK {
		return 0, fmt.Errorf("filer heartbeat listing answered HTTP %d", status)
	}
	names, err := heartbeatNames(data)
	if err != nil {
		return 0, err
	}
	if len(names) == 0 {
		return 0, nil
	}
	return names[len(names)-1], nil
}

// heartbeatNames are the heartbeat entries of a filer directory listing, sorted.
func heartbeatNames(listing []byte) ([]int64, error) {
	var parsed struct {
		Entries []struct {
			FullPath string `json:"FullPath"`
		} `json:"Entries"`
	}
	if err := json.Unmarshal(listing, &parsed); err != nil {
		return nil, fmt.Errorf("decode filer listing: %w", err)
	}
	var out []int64
	for _, entry := range parsed.Entries {
		name := entry.FullPath[strings.LastIndex(entry.FullPath, "/")+1:]
		if value, err := strconv.ParseInt(name, 10, 64); err == nil && value > 0 {
			out = append(out, value)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

// writeHeartbeat creates the heartbeat entry ns (an empty file: metadata only,
// no volume data) and removes the older ones.
func writeHeartbeat(ctx context.Context, dial dialFunc, token string, ns int64, older []int64) error {
	_, status, err := request(ctx, dial, http.MethodPut, heartbeatDir+strconv.FormatInt(ns, 10), token, http.NoBody)
	if err != nil {
		return err
	}
	if status/100 != 2 {
		return fmt.Errorf("filer heartbeat write answered HTTP %d", status)
	}
	for _, old := range older {
		if old >= ns {
			continue
		}
		_, status, err := request(ctx, dial, http.MethodDelete, heartbeatDir+strconv.FormatInt(old, 10), token, nil)
		if err != nil {
			return err
		}
		if status/100 != 2 && status != http.StatusNotFound {
			return fmt.Errorf("filer heartbeat cleanup answered HTTP %d", status)
		}
	}
	return nil
}

// growVolumes asks the master for count throw-away volumes on dataNode.
func growVolumes(ctx context.Context, dial dialFunc, dataNode string, count uint32) error {
	path := "/vol/grow?collection=" + bumpCollection + "&replication=000&count=" + strconv.Itoa(int(count)) + "&dataNode=" + dataNode
	data, status, err := requestWithin(ctx, growTimeout, dial, http.MethodGet, path, "", nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("volume grow answered HTTP %d: %s", status, strings.TrimSpace(string(data)))
	}
	var answer struct {
		Count int    `json:"count"`
		Error string `json:"error"`
	}
	if json.Unmarshal(data, &answer) == nil && answer.Error != "" {
		return errors.New("volume grow: " + answer.Error)
	}
	return nil
}
