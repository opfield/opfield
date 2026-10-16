package docker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

const composeSidecarEntrypoint = "/docker-compose"

type composeStage struct {
	directory string
}

func stageComposeInput(request composeRequest) (*composeStage, func(), error) {
	if len(request.composeYAML) == 0 {
		return nil, func() {}, nil
	}
	directory, err := os.MkdirTemp("", "opfield-compose-")
	if err != nil {
		return nil, nil, fmt.Errorf("create private compose staging directory: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	if err := os.Chmod(directory, 0o700); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("secure compose staging directory: %w", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "compose.yaml"), request.composeYAML, 0o600); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("write staged compose file: %w", err)
	}
	return &composeStage{directory: directory}, cleanup, nil
}

func (c *Client) runComposeSidecar(ctx context.Context, image, socketPath string, stage *composeStage, args, env []string) error {
	binds := []string{socketPath + ":/var/run/docker.sock"}
	if stage != nil {
		binds = append(binds, stage.directory+":/opfield-compose:ro")
	}
	created, err := c.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config: &container.Config{
			Image:      image,
			Entrypoint: []string{composeSidecarEntrypoint},
			Cmd:        args,
			Env:        env,
			Labels: helperContainerLabels(helperKindComposeSidecar, map[string]string{
				"net.opfield.compose.sidecar": "true",
			}),
		},
		HostConfig: &container.HostConfig{Binds: binds, AutoRemove: false},
	})
	if err != nil {
		return fmt.Errorf("create compose sidecar: %w", err)
	}
	containerID := created.ID
	defer func() {
		_, _ = c.cli.ContainerRemove(context.Background(), containerID, client.ContainerRemoveOptions{Force: true})
	}()
	if _, err := c.cli.ContainerStart(ctx, containerID, client.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start compose sidecar: %w", err)
	}
	wait := c.cli.ContainerWait(ctx, containerID, client.ContainerWaitOptions{})
	select {
	case result := <-wait.Result:
		if result.Error != nil {
			return fmt.Errorf("wait for compose sidecar: %s", result.Error.Message)
		}
		if result.StatusCode != 0 {
			stdout, stderr, logErr := readContainerLogs(ctx, c, containerID, composeErrorDetailLimit)
			if logErr == nil {
				detail := strings.TrimSpace(stderr)
				if detail == "" {
					detail = strings.TrimSpace(string(stdout))
				}
				if detail != "" {
					return &composeSidecarCommandError{detail: detail}
				}
			}
			return errors.New("compose sidecar exited unsuccessfully")
		}
		return nil
	case err := <-wait.Error:
		return fmt.Errorf("wait for compose sidecar: %w", err)
	case <-ctx.Done():
		_, _ = c.cli.ContainerStop(context.Background(), containerID, client.ContainerStopOptions{})
		return ctx.Err()
	}
}
