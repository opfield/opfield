MODULE := github.com/opfield/opfield/nginx-daemon
SHARED_MODULE := github.com/opfield/opfield/daemon-shared
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
export VERSION
PROTO_DIR := ../../../proto
SHARED_OUT_DIR := ../shared/opfieldv1
BINARY := bin/nginx-daemon

.PHONY: all build test lint clean proto trust-anchor

all: proto build

trust-anchor:
	../../../scripts/sync-update-trust-anchor.sh

proto:
	@mkdir -p $(SHARED_OUT_DIR)
	@mkdir -p ../shared/relayv1
	protoc \
		--proto_path=$(PROTO_DIR) \
		--go_out=$(SHARED_OUT_DIR) \
		--go_opt=module=$(SHARED_MODULE)/opfieldv1 \
		--go-grpc_out=$(SHARED_OUT_DIR) \
		--go-grpc_opt=module=$(SHARED_MODULE)/opfieldv1 \
		opfield/v1/nginx-daemon.proto
	protoc \
		--proto_path=$(PROTO_DIR) \
		--go_out=../shared/relayv1 \
		--go_opt=module=$(SHARED_MODULE)/relayv1 \
		--go-grpc_out=../shared/relayv1 \
		--go-grpc_opt=module=$(SHARED_MODULE)/relayv1 \
		relay/v1/relay.proto

build: trust-anchor
	CGO_ENABLED=0 go build -ldflags "-s -w -X $(MODULE)/internal/daemon.Version=$$VERSION" -o $(BINARY) ./cmd/nginx-daemon

test: trust-anchor
	go test ./...

lint: trust-anchor
	go vet ./...

clean:
	rm -rf bin/
