MODULE := github.com/opfield/opfield/docker-daemon
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
export VERSION
BINARY := bin/docker-daemon

.PHONY: all build test lint clean trust-anchor

all: build

trust-anchor:
	../../../scripts/sync-update-trust-anchor.sh

build: trust-anchor
	CGO_ENABLED=0 go build -ldflags "-s -w -X main.Version=$$VERSION" -o $(BINARY) ./cmd/docker-daemon

test: trust-anchor
	go test ./...

lint: trust-anchor
	go vet ./...

clean:
	rm -rf bin/
