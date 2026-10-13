package relaybridge

import (
	"bytes"
	"context"
	"net"
	"sync"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// recordingStream keeps the data frames sent on it and ends the tunnel once
// the local side half-closed.
type recordingStream struct {
	mu        sync.Mutex
	frames    [][]byte
	halfClose chan struct{}
	once      sync.Once
}

func (s *recordingStream) Send(frame *relayv1.TunnelFrame) error {
	if data := frame.GetData(); data != nil {
		s.mu.Lock()
		s.frames = append(s.frames, data.Data)
		s.mu.Unlock()
	}
	if frame.GetHalfClose() != nil {
		s.once.Do(func() { close(s.halfClose) })
	}
	return nil
}

func (s *recordingStream) Recv() (*relayv1.TunnelFrame, error) {
	<-s.halfClose
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}}, nil
}

// A route whose frame limit is below the default read chunk gets frames within
// its limit: a bigger frame makes the peer end the tunnel.
func TestBridgeKeepsFramesWithinASmallFrameLimit(t *testing.T) {
	const maxFrame = 16 * 1024
	local, peer := net.Pipe()
	stream := &recordingStream{halfClose: make(chan struct{})}
	payload := bytes.Repeat([]byte{7}, 3*DefaultChunkBytes)
	go func() {
		_, _ = peer.Write(payload)
		_ = peer.Close()
	}()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = Bridge(context.Background(), local, stream, maxFrame, func() {})
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not end")
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	total := 0
	for _, frame := range stream.frames {
		if len(frame) > maxFrame {
			t.Fatalf("sent a %d byte frame over a %d byte limit", len(frame), maxFrame)
		}
		total += len(frame)
	}
	if total != len(payload) {
		t.Fatalf("sent %d bytes, want %d", total, len(payload))
	}
}
