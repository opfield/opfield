package builder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

func prepareJobDirectory(jobDir string) error {
	// A daemon restart can leave the checkout for an expired build lease behind.
	// Retried attempts reuse the build ID, so always recreate the workspace before
	// initializing Git instead of inheriting a partial repository from the old process.
	if err := os.RemoveAll(jobDir); err != nil {
		return err
	}
	return os.MkdirAll(jobDir, 0o700)
}

func (m *Manager) checkout(ctx context.Context, command *pb.DockerBuildCommand, jobDir string) error {
	credential := checkoutCredential{Username: "oauth2", Password: string(command.GetCheckoutCredential())}
	if len(command.GetCheckoutCredential()) == 0 {
		return errors.New("checkout credential is required")
	}
	_ = json.Unmarshal(command.GetCheckoutCredential(), &credential)
	if credential.Username == "" || credential.Password == "" || strings.ContainsAny(credential.Username, "\r\n") || strings.ContainsAny(credential.Password, "\r\n") {
		return errors.New("checkout credential is invalid")
	}
	env := append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS="+m.askpass,
		"OPFIELD_GIT_USERNAME="+credential.Username, "OPFIELD_GIT_PASSWORD="+credential.Password,
	)
	for _, step := range [][]string{
		{"git", "init", "--quiet", jobDir},
		{"git", "-C", jobDir, "remote", "add", "origin", command.GetRepositoryUrl()},
		{"git", "-C", jobDir, "-c", "credential.helper=", "fetch", "--quiet", "--depth=1", "origin", command.GetRef()},
		{"git", "-C", jobDir, "checkout", "--quiet", "--detach", command.GetCommitSha()},
	} {
		if err := m.runCommand(ctx, command.GetBuildId(), "", env, step[0], step[1:]...); err != nil {
			return err
		}
	}
	output, err := exec.CommandContext(ctx, "git", "-C", jobDir, "rev-parse", "HEAD").Output()
	if err != nil || strings.TrimSpace(string(output)) != command.GetCommitSha() {
		return errors.New("checked out commit does not match the requested SHA")
	}
	return nil
}

// imageStoreOutputOption keeps the pushed result out of the builder's containerd image store. The containerd worker
// stores every exported image by default, and nothing prunes that store: BuildKit cache cleanup does not own it.
const imageStoreOutputOption = ",store=false"

func (m *Manager) build(ctx context.Context, command *pb.DockerBuildCommand, jobDir, metadataPath, imageRef string) error {
	contextDir, err := containedPath(jobDir, command.GetContextPath())
	if err != nil {
		return err
	}
	dockerfileAbsolute, err := containedPath(jobDir, command.GetDockerfilePath())
	if err != nil {
		return err
	}
	contextInfo, err := os.Stat(contextDir)
	if err != nil || !contextInfo.IsDir() {
		return fmt.Errorf("build context %q is not an accessible directory in the checked-out commit; set Build context relative to the repository root", command.GetContextPath())
	}
	dockerfileInfo, err := os.Stat(dockerfileAbsolute)
	if err != nil || !dockerfileInfo.Mode().IsRegular() {
		return fmt.Errorf("Dockerfile %q is not an accessible file in the checked-out commit; set Dockerfile to its path relative to the repository root (for example apps/api/Dockerfile)", command.GetDockerfilePath())
	}
	args := []string{"--addr", "unix://" + m.config.BuildkitSocket, "build", "--frontend", "dockerfile.v0",
		"--local", "context=" + contextDir, "--local", "dockerfile=" + filepath.Dir(dockerfileAbsolute),
		"--opt", "filename=" + filepath.Base(dockerfileAbsolute), "--opt", "platform=" + command.GetPlatform(),
		"--metadata-file", metadataPath,
		"--output", "type=image,name=" + imageRef + ",push=true" + imageStoreOutputOption,
	}
	keys := make([]string, 0, len(command.GetBuildArgs()))
	for key := range command.GetBuildArgs() {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(key) {
			return errors.New("invalid build argument name")
		}
		args = append(args, "--opt", "build-arg:"+key+"="+command.GetBuildArgs()[key])
	}
	secretDir := ""
	if len(command.GetBuildSecrets()) > 0 {
		secretDir, err = os.MkdirTemp(m.workspace, ".opfield-build-secrets-")
		if err != nil {
			return fmt.Errorf("create Build Secret directory: %w", err)
		}
		if err := os.Chmod(secretDir, 0o700); err != nil {
			_ = os.RemoveAll(secretDir)
			return fmt.Errorf("protect Build Secret directory: %w", err)
		}
		defer secureRemoveAll(secretDir)
		secretNames := make([]string, 0, len(command.GetBuildSecrets()))
		for name := range command.GetBuildSecrets() {
			secretNames = append(secretNames, name)
		}
		sort.Strings(secretNames)
		for _, name := range secretNames {
			path := filepath.Join(secretDir, name)
			if err := os.WriteFile(path, command.GetBuildSecrets()[name], 0o600); err != nil {
				return fmt.Errorf("write Build Secret %s: %w", name, err)
			}
			args = append(args, "--secret", "id="+name+",src="+path)
		}
	}
	return m.runCommand(ctx, command.GetBuildId(), jobDir, os.Environ(), "buildctl", args...)
}

func (m *Manager) buildPages(ctx context.Context, command *pb.DockerBuildCommand, jobDir, metadataPath, imageRef string) error {
	controlDir, err := os.MkdirTemp(m.workspace, ".opfield-pages-control-")
	if err != nil {
		return fmt.Errorf("create managed Pages build directory: %w", err)
	}
	if err := os.Chmod(controlDir, 0o700); err != nil {
		_ = os.RemoveAll(controlDir)
		return fmt.Errorf("protect managed Pages build directory: %w", err)
	}
	defer secureRemoveAll(controlDir)
	dockerfilePath := filepath.Join(controlDir, "Dockerfile")
	dockerfile, err := renderPagesDockerfile(command)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dockerfilePath, []byte(dockerfile), 0o600); err != nil {
		return fmt.Errorf("write managed Pages Dockerfile: %w", err)
	}
	args := []string{"--addr", "unix://" + m.config.BuildkitSocket, "build", "--frontend", "dockerfile.v0",
		"--local", "context=" + jobDir, "--local", "dockerfile=" + controlDir,
		"--opt", "filename=" + filepath.Base(dockerfilePath), "--opt", "platform=" + command.GetPlatform(),
		"--metadata-file", metadataPath,
		"--output", "type=image,name=" + imageRef + ",push=true,compression=gzip,force-compression=true,oci-mediatypes=true" + imageStoreOutputOption,
	}
	keys := make([]string, 0, len(command.GetBuildArgs()))
	for key := range command.GetBuildArgs() {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		args = append(args, "--opt", "build-arg:"+key+"="+command.GetBuildArgs()[key])
	}
	secretDir := ""
	if len(command.GetBuildSecrets()) > 0 {
		secretDir, err = os.MkdirTemp(m.workspace, ".opfield-build-secrets-")
		if err != nil {
			return fmt.Errorf("create Build Secret directory: %w", err)
		}
		if err := os.Chmod(secretDir, 0o700); err != nil {
			_ = os.RemoveAll(secretDir)
			return fmt.Errorf("protect Build Secret directory: %w", err)
		}
		defer secureRemoveAll(secretDir)
		secretNames := make([]string, 0, len(command.GetBuildSecrets()))
		for name := range command.GetBuildSecrets() {
			secretNames = append(secretNames, name)
		}
		sort.Strings(secretNames)
		for _, name := range secretNames {
			path := filepath.Join(secretDir, name)
			if err := os.WriteFile(path, command.GetBuildSecrets()[name], 0o600); err != nil {
				return fmt.Errorf("write Build Secret %s: %w", name, err)
			}
			args = append(args, "--secret", "id="+name+",src="+path)
		}
	}
	return m.runCommand(ctx, command.GetBuildId(), jobDir, os.Environ(), "buildctl", args...)
}

func renderPagesDockerfile(command *pb.DockerBuildCommand) (string, error) {
	manager := command.GetPackageManager()
	version := command.GetPackageManagerVersion()
	setup := ""
	install := ""
	run := ""
	switch manager {
	case "npm":
		install = "if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci; else npm install; fi"
		run = "npm run " + shellQuote(command.GetBuildScript())
	case "pnpm":
		if version == "" {
			version = "10"
		}
		setup = "corepack enable && corepack prepare " + shellQuote("pnpm@"+version) + " --activate && "
		install = "if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi"
		run = "pnpm run " + shellQuote(command.GetBuildScript())
	case "yarn":
		if version == "" {
			version = "4"
		}
		setup = "corepack enable && corepack prepare " + shellQuote("yarn@"+version) + " --activate && "
		install = "if [ -f yarn.lock ]; then yarn install --immutable; else yarn install; fi"
		run = "yarn run " + shellQuote(command.GetBuildScript())
	default:
		return "", errors.New("unsupported Pages package manager")
	}
	variableNames := make([]string, 0, len(command.GetBuildArgs()))
	for name := range command.GetBuildArgs() {
		variableNames = append(variableNames, name)
	}
	sort.Strings(variableNames)
	secretNames := make([]string, 0, len(command.GetBuildSecrets()))
	for name := range command.GetBuildSecrets() {
		secretNames = append(secretNames, name)
	}
	sort.Strings(secretNames)
	lines := []string{
		"FROM docker.io/library/node:" + command.GetNodeVersion() + "-bookworm-slim AS build",
		"WORKDIR /workspace",
		"COPY . .",
		"WORKDIR /workspace/" + command.GetApplicationRoot(),
	}
	for _, name := range variableNames {
		lines = append(lines, "ARG "+name, "ENV "+name+"=${"+name+"}")
	}
	mounts := make([]string, 0, len(secretNames))
	exports := make([]string, 0, len(secretNames))
	for _, name := range secretNames {
		mounts = append(mounts, "--mount=type=secret,id="+name+",required=true")
		exports = append(exports, "export "+name+"=\"$(cat /run/secrets/"+name+")\"")
	}
	runPrefix := "RUN"
	if len(mounts) > 0 {
		runPrefix += " " + strings.Join(mounts, " ")
	}
	commands := []string{"set -eu"}
	commands = append(commands, exports...)
	commands = append(commands, setup+install, run)
	lines = append(lines, runPrefix+" "+strings.Join(commands, "; "))
	lines = append(lines,
		"FROM scratch AS pages",
		"COPY --from=build /workspace/"+command.GetApplicationRoot()+"/"+command.GetArtifactDirectory()+"/ /",
	)
	return strings.Join(lines, "\n") + "\n", nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
