package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	gwstream "github.com/opfield/opfield/daemon-shared/stream"
	"google.golang.org/grpc"
)

const migrationChunkBytes = 1024 * 1024

// errMigrationStreamClosed: Opfield ended the stream with no transfer on it,
// as it does when the daemon or Opfield restarts, the control session moves
// (a daemon or relay update), or a newer stream of the node replaces it. The
// daemon opens it again; that is no failure.
var errMigrationStreamClosed = errors.New("migration transfer stream closed by Opfield")

type migrationIncomingArtifact struct {
	migrationID string
	artifactID  string
	offset      int64
	file        *os.File
	writer      io.WriteCloser
	// guard stops a spool file write below the node's disk reserve (nil for a live archive stream).
	guard *migrationSpoolGuard
}

func (a *migrationIncomingArtifact) close() error {
	if a.file != nil {
		return a.file.Close()
	}
	if a.writer != nil {
		return a.writer.Close()
	}
	return nil
}

func (a *migrationIncomingArtifact) write(data []byte) (int, error) {
	if a.file != nil {
		if a.guard != nil {
			if err := a.guard.admit(len(data)); err != nil {
				return 0, err
			}
		}
		return a.file.Write(data)
	}
	if a.writer != nil {
		return a.writer.Write(data)
	}
	return 0, io.ErrClosedPipe
}

func (p *DockerPlugin) RunMigrationStream(ctx context.Context, conn *grpc.ClientConn, nodeID string) {
	if !migrationStreamEnabled(p.cfg.Docker.Mode) {
		return
	}
	for ctx.Err() == nil {
		if err := p.runMigrationStream(ctx, conn, nodeID); err != nil && ctx.Err() == nil {
			switch {
			case errors.Is(err, errMigrationStreamClosed):
				p.logger.Info("migration transfer stream closed by Opfield, opening it again")
			case !errors.Is(err, io.EOF) && connector.PlannedDisconnect(err):
				// Opfield or the relay on the way stopped gracefully (an
				// update or restart). An EOF during a transfer stays a warning.
				p.logger.Info("migration transfer stream disconnected", "error", err)
			default:
				p.logger.Warn("migration transfer stream disconnected", "error", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func migrationStreamEnabled(mode string) bool {
	return mode != "databases" && mode != "storage" && mode != "builder"
}

func (p *DockerPlugin) runMigrationStream(ctx context.Context, conn *grpc.ClientConn, nodeID string) error {
	stream, err := connector.OpenMigrationTransferStream(ctx, conn)
	if err != nil {
		return fmt.Errorf("open migration transfer stream: %w", err)
	}
	if err := stream.Send(&pb.MigrationTransferMessage{Payload: &pb.MigrationTransferMessage_Hello{
		Hello: &pb.MigrationTransferHello{NodeId: nodeID, Capability: "docker_migration_v1", MaxChunkBytes: migrationChunkBytes},
	}}); err != nil {
		return fmt.Errorf("send migration stream hello: %w", err)
	}

	var incoming *migrationIncomingArtifact
	defer func() {
		if incoming != nil {
			_ = incoming.close()
		}
	}()
	for {
		control, err := stream.Recv()
		if err != nil {
			if errors.Is(err, io.EOF) && incoming == nil {
				return errMigrationStreamClosed
			}
			return err
		}
		switch payload := control.Payload.(type) {
		case *pb.MigrationTransferControl_Read:
			if incoming != nil {
				return fmt.Errorf("cannot read while artifact write is active")
			}
			if err := p.sendMigrationArtifact(stream, payload.Read); err != nil {
				_ = sendMigrationStreamError(stream, payload.Read.MigrationId, payload.Read.ArtifactId, err)
			}
		case *pb.MigrationTransferControl_Write:
			if incoming != nil {
				_ = incoming.close()
				incoming = nil
			}
			var f *os.File
			var writer io.WriteCloser
			var err error
			if payload.Write.Offset == 0 && p.archiveStreams != nil {
				writer, _ = p.archiveStreams.writer(payload.Write.MigrationId, payload.Write.ArtifactId)
			}
			if writer == nil {
				f, err = p.migrationStore.openWrite(payload.Write.MigrationId, payload.Write.ArtifactId, payload.Write.Offset)
			}
			if err != nil {
				_ = sendMigrationStreamError(stream, payload.Write.MigrationId, payload.Write.ArtifactId, err)
				continue
			}
			incoming = &migrationIncomingArtifact{
				migrationID: payload.Write.MigrationId,
				artifactID:  payload.Write.ArtifactId,
				offset:      payload.Write.Offset,
				file:        f,
				writer:      writer,
			}
			if f != nil {
				incoming.guard = p.migrationStore.guard(payload.Write.MigrationId, 0)
			}
			if err := sendMigrationAck(stream, incoming, false); err != nil {
				return err
			}
		case *pb.MigrationTransferControl_Chunk:
			if incoming == nil {
				_ = sendMigrationStreamError(stream, payload.Chunk.MigrationId, payload.Chunk.ArtifactId, fmt.Errorf("artifact write was not initialized"))
				continue
			}
			complete, err := receiveMigrationChunk(incoming, payload.Chunk)
			if err != nil {
				_ = sendMigrationStreamError(stream, incoming.migrationID, incoming.artifactID, err)
				_ = incoming.close()
				incoming = nil
				continue
			}
			if complete {
				if incoming.file != nil {
					if err := incoming.file.Sync(); err != nil {
						_ = sendMigrationStreamError(stream, incoming.migrationID, incoming.artifactID, fmt.Errorf("fsync migration artifact: %w", err))
						_ = incoming.close()
						incoming = nil
						continue
					}
				}
			}
			if err := sendMigrationAck(stream, incoming, complete); err != nil {
				return err
			}
			if complete {
				_ = incoming.close()
				incoming = nil
			}
		case *pb.MigrationTransferControl_Heartbeat:
			if err := p.migrationStore.heartbeat(payload.Heartbeat.MigrationId); err != nil {
				_ = sendMigrationStreamError(stream, payload.Heartbeat.MigrationId, "", err)
			}
		case *pb.MigrationTransferControl_Error:
			p.logger.Warn("Opfield aborted migration artifact transfer",
				"migration_id", payload.Error.MigrationId,
				"artifact_id", payload.Error.ArtifactId,
				"error", payload.Error.Message)
			if incoming != nil {
				_ = incoming.close()
				incoming = nil
			}
		case *pb.MigrationTransferControl_Ack:
			// Read acknowledgements are advisory. Resumption always starts from the
			// persisted offset supplied by Opfield on the next read request.
		default:
			return fmt.Errorf("unsupported migration transfer control")
		}
	}
}

func (p *DockerPlugin) sendMigrationArtifact(stream pb.MigrationTransfer_TransferClient, req *pb.MigrationArtifactRead) error {
	if req.Offset == 0 && p.archiveStreams != nil {
		if reader, ok := p.archiveStreams.reader(req.MigrationId, req.ArtifactId); ok {
			defer p.archiveStreams.remove(req.MigrationId, req.ArtifactId)
			defer reader.Close()
			return sendMigrationReader(stream, req, reader)
		}
	}
	f, size, err := p.migrationStore.openRead(req.MigrationId, req.ArtifactId, req.Offset)
	if err != nil {
		return err
	}
	defer f.Close()
	offset := req.Offset
	buf := make([]byte, migrationChunkBytes)
	for chunks := 0; ; chunks++ {
		if chunks%64 == 0 {
			// Reading changes no file time; the spool of a long transfer is in use all along.
			p.migrationStore.touch(req.MigrationId)
		}
		n, readErr := f.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			if err := stream.Send(&pb.MigrationTransferMessage{Payload: &pb.MigrationTransferMessage_Chunk{Chunk: &pb.MigrationArtifactChunk{
				MigrationId: req.MigrationId, ArtifactId: req.ArtifactId, Offset: offset, Data: chunk,
			}}}); err != nil {
				return fmt.Errorf("send migration artifact chunk: %w", err)
			}
			offset += int64(n)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return fmt.Errorf("read migration artifact: %w", readErr)
		}
	}
	if offset != size {
		return fmt.Errorf("migration artifact changed during transfer")
	}
	return stream.Send(&pb.MigrationTransferMessage{Payload: &pb.MigrationTransferMessage_Chunk{Chunk: &pb.MigrationArtifactChunk{
		MigrationId: req.MigrationId, ArtifactId: req.ArtifactId, Offset: offset, Eof: true,
	}}})
}

func sendMigrationReader(stream pb.MigrationTransfer_TransferClient, req *pb.MigrationArtifactRead, reader io.Reader) error {
	offset := req.Offset
	buf := make([]byte, migrationChunkBytes)
	for {
		n, readErr := reader.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			if err := stream.Send(&pb.MigrationTransferMessage{Payload: &pb.MigrationTransferMessage_Chunk{Chunk: &pb.MigrationArtifactChunk{
				MigrationId: req.MigrationId, ArtifactId: req.ArtifactId, Offset: offset, Data: chunk,
			}}}); err != nil {
				return fmt.Errorf("send archive image chunk: %w", err)
			}
			offset += int64(n)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return fmt.Errorf("read archive image: %w", readErr)
		}
	}
	return stream.Send(&pb.MigrationTransferMessage{Payload: &pb.MigrationTransferMessage_Chunk{Chunk: &pb.MigrationArtifactChunk{
		MigrationId: req.MigrationId, ArtifactId: req.ArtifactId, Offset: offset, Eof: true,
	}}})
}

func receiveMigrationChunk(incoming *migrationIncomingArtifact, chunk *pb.MigrationArtifactChunk) (bool, error) {
	if chunk.MigrationId != incoming.migrationID || chunk.ArtifactId != incoming.artifactID {
		return false, fmt.Errorf("artifact chunk identity mismatch")
	}
	if chunk.Offset != incoming.offset {
		return false, fmt.Errorf("artifact chunk offset mismatch: got %d, expected %d", chunk.Offset, incoming.offset)
	}
	if len(chunk.Data) > migrationChunkBytes {
		return false, fmt.Errorf("artifact chunk exceeds 1 MiB")
	}
	if chunk.Eof && len(chunk.Data) != 0 {
		return false, fmt.Errorf("EOF artifact chunk must not contain data")
	}
	if len(chunk.Data) > 0 {
		n, err := incoming.write(chunk.Data)
		if err != nil {
			return false, fmt.Errorf("write migration artifact: %w", err)
		}
		if n != len(chunk.Data) {
			return false, io.ErrShortWrite
		}
		incoming.offset += int64(n)
	}
	return chunk.Eof, nil
}

func sendMigrationAck(stream pb.MigrationTransfer_TransferClient, incoming *migrationIncomingArtifact, complete bool) error {
	return stream.Send(&pb.MigrationTransferMessage{Payload: &pb.MigrationTransferMessage_Ack{Ack: &pb.MigrationArtifactAck{
		MigrationId: incoming.migrationID, ArtifactId: incoming.artifactID, AcknowledgedOffset: incoming.offset, Complete: complete,
	}}})
}

func sendMigrationStreamError(stream pb.MigrationTransfer_TransferClient, migrationID, artifactID string, err error) error {
	return stream.Send(&pb.MigrationTransferMessage{Payload: &pb.MigrationTransferMessage_Error{Error: &pb.MigrationArtifactError{
		MigrationId: migrationID, ArtifactId: artifactID, Message: gwstream.ValidUTF8(err.Error()),
	}}})
}
