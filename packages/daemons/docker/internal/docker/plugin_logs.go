package docker

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"io"
	"strings"
	"sync"
)

type logStreamOwnerKey struct {
	plugin      *DockerPlugin
	containerID string
}

type logStreamOwner struct {
	ctx    context.Context
	cancel context.CancelFunc
}

// Keep private ownership even when a shared-map user removes its cancel entry
// before invoking it. Entries exist only until their current stream finishes.
var logStreamOwners sync.Map // logStreamOwnerKey -> logStreamOwner

// isLogFollowStop reports whether a logs command asks to stop the container's
// follow stream: a non-follow request with a negative tail. The gateway sends it
// when the last viewer leaves; older daemons read 100 lines for it instead.
func isLogFollowStop(cmd *pb.DockerLogsCommand) bool {
	return !cmd.Follow && cmd.TailLines < 0
}

func (p *DockerPlugin) handleLogsCommand(cmd *pb.DockerLogsCommand, result *pb.CommandResult) {
	if isLogFollowStop(cmd) {
		p.stopLogStream(cmd.ContainerId)
		result.Detail = `{"streaming":false}`
		return
	}

	ctx := context.Background()
	if p.sessionCtx != nil {
		ctx = p.sessionCtx
	}

	tail := int(cmd.TailLines)
	if tail <= 0 && !cmd.Follow {
		tail = 100
	}

	// If follow mode and we have a writer, start streaming
	if cmd.Follow && p.writer != nil {
		streamCtx, streamCancel := context.WithCancel(ctx)
		// Register before opening the reader: overlapping opens must cancel
		// the earlier attempt, not leave two untracked follow streams alive.
		p.registerLogStream(streamCtx, streamCancel, cmd.ContainerId)

		reader, err := p.client.ContainerLogsFollow(streamCtx, cmd.ContainerId, tail, cmd.Timestamps, cmd.Since)
		if err != nil {
			p.releaseLogStream(streamCtx, streamCancel, cmd.ContainerId)
			result.Success = false
			result.Error = err.Error()
			return
		}
		if err := streamCtx.Err(); err != nil {
			reader.Close()
			p.releaseLogStream(streamCtx, streamCancel, cmd.ContainerId)
			result.Success = false
			result.Error = err.Error()
			return
		}

		// Start streaming goroutine
		go p.streamLogs(streamCtx, streamCancel, cmd.ContainerId, reader)

		// Return immediately acknowledging the stream started
		data, _ := json.Marshal(map[string]bool{"streaming": true})
		result.Detail = string(data)
		return
	}

	// Non-follow mode: fetch logs once
	readCtx, cancel := context.WithTimeout(ctx, dockerLogsCommandTimeout)
	defer cancel()
	lines, err := p.client.ContainerLogs(readCtx, cmd.ContainerId, tail, cmd.Timestamps, cmd.Since, cmd.Until)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}

	data, err := json.Marshal(lines)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("marshal logs: %v", err)
		return
	}
	result.Detail = string(data)
}

// streamLogs reads from a Docker log follow stream and sends chunks back
// via the gRPC stream writer as CommandResult messages.
func (p *DockerPlugin) streamLogs(ctx context.Context, cancel context.CancelFunc, containerID string, reader io.ReadCloser) {
	defer func() {
		reader.Close()
		p.releaseLogStream(ctx, cancel, containerID)
		p.logger.Info("log stream ended", "container", containerID)
	}()

	header := make([]byte, 8)
	buf := make([]byte, 0, 16384)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Read Docker multiplexed log header (8 bytes)
		_, err := io.ReadFull(reader, header)
		if err != nil {
			// Natural EOF ends the current stream; cancellation of an older
			// reader must never end the replacement's backend handler.
			endMsg, _ := json.Marshal(map[string]interface{}{
				"type":        "log_stream",
				"containerId": containerID,
				"lines":       []string{},
				"ended":       true,
			})
			p.sendLogStream(ctx, containerID, string(endMsg))
			return
		}

		size := binary.BigEndian.Uint32(header[4:8])
		if size == 0 {
			continue
		}
		if size > maxDockerLogLineBytes {
			p.logger.Warn("log stream frame exceeds safety limit", "container", containerID, "bytes", size)
			return
		}

		// Read the payload
		if cap(buf) < int(size) {
			buf = make([]byte, size)
		} else {
			buf = buf[:size]
		}
		_, err = io.ReadFull(reader, buf)
		if err != nil {
			return
		}

		// Parse payload into lines
		var lines []string
		scanner := bufio.NewScanner(strings.NewReader(string(buf)))
		scanner.Buffer(make([]byte, 0, 64*1024), maxDockerLogLineBytes)
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				lines = append(lines, line)
			}
		}
		if err := scanner.Err(); err != nil {
			p.logger.Warn("log stream scanner failed", "container", containerID, "error", err)
			return
		}

		if len(lines) == 0 {
			continue
		}

		// Send lines as a CommandResult with log_stream type
		streamMsg, _ := json.Marshal(map[string]interface{}{
			"type":        "log_stream",
			"containerId": containerID,
			"lines":       lines,
		})

		if err := p.sendLogStream(ctx, containerID, string(streamMsg)); err != nil {
			p.logger.Debug("log stream send failed", "container", containerID, "error", err)
			return
		}
	}
}

func (p *DockerPlugin) registerLogStream(ctx context.Context, cancel context.CancelFunc, containerID string) {
	p.logStreamMu.Lock()
	defer p.logStreamMu.Unlock()
	key := logStreamOwnerKey{p, containerID}
	if previous, ok := logStreamOwners.Load(key); ok {
		previous.(logStreamOwner).cancel()
	}
	if previous := p.logStreamCancel[containerID]; previous != nil {
		previous()
	}
	logStreamOwners.Store(key, logStreamOwner{ctx, cancel})
	p.logStreamCancel[containerID] = cancel
}

func (p *DockerPlugin) releaseLogStream(ctx context.Context, cancel context.CancelFunc, containerID string) {
	p.logStreamMu.Lock()
	key := logStreamOwnerKey{p, containerID}
	if owner, ok := logStreamOwners.Load(key); ok && owner.(logStreamOwner).ctx == ctx {
		delete(p.logStreamCancel, containerID)
		logStreamOwners.Delete(key)
	}
	p.logStreamMu.Unlock()
	cancel()
}

func (p *DockerPlugin) sendLogStream(ctx context.Context, containerID, detail string) error {
	p.logStreamMu.Lock()
	if err := ctx.Err(); err != nil {
		p.logStreamMu.Unlock()
		return err
	}
	owner, ok := logStreamOwners.Load(logStreamOwnerKey{p, containerID})
	if !ok || owner.(logStreamOwner).ctx != ctx {
		p.logStreamMu.Unlock()
		return context.Canceled
	}
	writer := p.writer
	p.logStreamMu.Unlock()
	if writer == nil {
		return nil
	}
	// Network backpressure must not block replacement, stop, or session cleanup.
	// Recheck after releasing ownership; already in-flight sends cannot be undone.
	if err := ctx.Err(); err != nil {
		return err
	}
	return writer.Send(&pb.DaemonMessage{
		Payload: &pb.DaemonMessage_CommandResult{
			CommandResult: &pb.CommandResult{
				CommandId: "log_stream:" + containerID,
				Success:   true,
				Detail:    detail,
			},
		},
	})
}

// stopLogStream cancels a running log stream for the given container.
func (p *DockerPlugin) stopLogStream(containerID string) {
	p.logStreamMu.Lock()
	if cancel, ok := p.logStreamCancel[containerID]; ok {
		cancel()
		delete(p.logStreamCancel, containerID)
	}
	p.logStreamMu.Unlock()
}

// handleConfigPush processes a config push from the gateway, updating the
// allowlist and storing registry credentials.
