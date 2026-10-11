package kvha

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

// conn is a minimal RESP2 client: commands as arrays of bulk strings,
// replies as simple strings, errors, integers, bulk strings and arrays.
type conn struct {
	net.Conn
	r *bufio.Reader
}

func newConn(c net.Conn, timeout time.Duration) *conn {
	_ = c.SetDeadline(time.Now().Add(timeout))
	return &conn{Conn: c, r: bufio.NewReader(c)}
}

// errorReply is an error the server answered.
type errorReply string

func (e errorReply) Error() string { return string(e) }

func (c *conn) do(args ...string) (any, error) {
	var b strings.Builder
	b.WriteString("*" + strconv.Itoa(len(args)) + "\r\n")
	for _, arg := range args {
		b.WriteString("$" + strconv.Itoa(len(arg)) + "\r\n" + arg + "\r\n")
	}
	if _, err := io.WriteString(c.Conn, b.String()); err != nil {
		return nil, err
	}
	return c.read()
}

func (c *conn) read() (any, error) {
	line, err := c.r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return nil, errors.New("empty reply")
	}
	switch line[0] {
	case '+':
		return line[1:], nil
	case '-':
		return nil, errorReply(line[1:])
	case ':':
		return strconv.ParseInt(line[1:], 10, 64)
	case '$':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(c.r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		out := make([]any, 0, n)
		for range n {
			item, err := c.read()
			if err != nil {
				return nil, err
			}
			out = append(out, item)
		}
		return out, nil
	}
	return nil, fmt.Errorf("unexpected reply %q", line)
}

func (c *conn) str(args ...string) (string, error) {
	reply, err := c.do(args...)
	if err != nil {
		return "", err
	}
	s, ok := reply.(string)
	if !ok {
		return "", fmt.Errorf("unexpected reply to %s", args[0])
	}
	return s, nil
}

func (c *conn) strings(args ...string) ([]string, error) {
	reply, err := c.do(args...)
	if err != nil {
		return nil, err
	}
	items, ok := reply.([]any)
	if !ok {
		return nil, fmt.Errorf("unexpected reply to %s", args[0])
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		s, _ := item.(string)
		out = append(out, s)
	}
	return out, nil
}

// parseInfo reads an INFO section into key/value pairs.
func parseInfo(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if ok {
			out[key] = value
		}
	}
	return out
}

// replicaInfo is one "slaveN:ip=...,port=...,state=...,offset=...,lag=..." line.
type replicaInfo struct {
	IP     string
	State  string
	Offset int64
	Lag    int64
}

func parseReplicas(info map[string]string) []replicaInfo {
	var out []replicaInfo
	for key, value := range info {
		if !strings.HasPrefix(key, "slave") {
			continue
		}
		if _, err := strconv.Atoi(strings.TrimPrefix(key, "slave")); err != nil {
			continue
		}
		replica := replicaInfo{}
		for _, field := range strings.Split(value, ",") {
			k, v, _ := strings.Cut(field, "=")
			switch k {
			case "ip":
				replica.IP = v
			case "state":
				replica.State = v
			case "offset":
				replica.Offset, _ = strconv.ParseInt(v, 10, 64)
			case "lag":
				replica.Lag, _ = strconv.ParseInt(v, 10, 64)
			}
		}
		out = append(out, replica)
	}
	return out
}
