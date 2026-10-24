package docker

import (
	"errors"
	"testing"
)

func TestDetachIsDoneWhenTheContainerOrNetworkIsGone(t *testing.T) {
	for _, message := range []string{
		"Error response from daemon: container 9468a2a0 is not connected to the network opfield-link-df2241dc",
		"Error response from daemon: network opfield-db-5511015e not found",
		"Error response from daemon: No such container: 9468a2a0",
	} {
		if !isDetachedErr(errors.New(message)) {
			t.Fatalf("%q should count as already detached", message)
		}
	}
	if isDetachedErr(errors.New("Error response from daemon: permission denied")) || isDetachedErr(nil) {
		t.Fatal("other failures are not a finished detach")
	}
}
