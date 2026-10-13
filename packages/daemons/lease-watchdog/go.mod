module github.com/opfield/opfield/lease-watchdog

go 1.24.4

replace github.com/opfield/opfield/daemon-shared => ../shared

require github.com/opfield/opfield/daemon-shared v0.0.0

require (
	github.com/creack/pty v1.1.24 // indirect
	github.com/google/uuid v1.6.0 // indirect
	golang.org/x/net v0.48.0 // indirect
	golang.org/x/sys v0.39.0 // indirect
	golang.org/x/text v0.32.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20251202230838-ff82c1b0f217 // indirect
	google.golang.org/grpc v1.79.3 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)
