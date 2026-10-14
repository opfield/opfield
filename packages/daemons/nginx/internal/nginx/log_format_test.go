package nginx

import (
	"strings"
	"testing"
)

// The nginx.conf of an Alpine node: the Opfield includes come before the injected log format.
const alpineNginxConf = `user nginx;
events {
    worker_connections 1024;
}
http {
    include /etc/nginx/mime.types;
    include /etc/nginx/opfield/stub_status.conf;
    include /etc/nginx/opfield/sites.include.conf;
    sendfile on;

    # Opfield daemon log format (auto-injected)
    log_format opfield_combined '$remote_addr - $remote_user [$time_local] '
    '"$request" $status $body_bytes_sent '
    '"$http_referer" "$http_user_agent" '
    '$upstream_response_time $request_time';
}
`

func TestLogFormatFirstMovesTheFormatAboveTheIncludes(t *testing.T) {
	next, ok := logFormatFirst(alpineNginxConf)
	if !ok {
		t.Fatal("format not ready after the move")
	}
	format := strings.Index(next, "log_format opfield_combined")
	include := strings.Index(next, "include /etc/nginx/mime.types")
	if format < 0 || include < 0 || format > include {
		t.Fatalf("format at %d, first include at %d:\n%s", format, include, next)
	}
	if strings.Count(next, "log_format opfield_combined") != 1 || !strings.Contains(next, "'$upstream_response_time $request_time';") {
		t.Fatalf("the definition was not moved whole:\n%s", next)
	}
	if again, _ := logFormatFirst(next); again != next {
		t.Fatalf("a second pass changed the file:\n%s", again)
	}
}

func TestLogFormatFirstLeavesAConfigInOrder(t *testing.T) {
	inOrder := "http {\n    log_format opfield_combined '$remote_addr' '$request_time';\n    include /etc/nginx/opfield/sites.include.conf;\n}\n"
	next, ok := logFormatFirst(inOrder)
	if !ok || next != inOrder {
		t.Fatalf("ok=%v, changed:\n%s", ok, next)
	}
}

func TestLogFormatFirstWithoutTheFormatIsNotReady(t *testing.T) {
	if _, ok := logFormatFirst("http {\n    include /etc/nginx/opfield/sites.include.conf;\n}\n"); ok {
		t.Fatal("ready without a format definition")
	}
}
