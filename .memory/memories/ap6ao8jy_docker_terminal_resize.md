---
{
  "id": "ap6ao8jy",
  "file_name": "ap6ao8jy_docker_terminal_resize",
  "tags": [
    "console",
    "docker",
    "resize",
    "terminal",
    "websocket",
    "xterm"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1784716244464,
  "updated_at": 1791851385443
}
---
Opfield Docker container console resize contract: browser xterm rows/cols must be synchronized to the backing Docker exec TTY. The frontend sends dimensions on WebSocket open, xterm onResize, and the backend connected message. The backend accepts and stores valid early resize frames before authentication/exec creation, passes the latest size into the create command, and reapplies it after receiving the exec ID. For DockerExecCommand, the protobuf field container_id contains the container ID for create but must contain the Docker exec session ID for resize; the daemon resize handler searches sessions by exec ID. Passing the container ID causes resize to be silently ignored and produces shell/xterm width mismatch, which manifests as premature line wrapping and cursor jumps while typing long commands. Relevant verification: backend docker-exec.ws tests, frontend terminal-resize tests, backend typecheck, frontend production build.
