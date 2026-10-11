package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/updateauth"
)

func main() {
	if len(os.Args) < 2 {
		die("usage: update-trust <keygen|sign> [options]")
	}
	switch os.Args[1] {
	case "keygen":
		keygen(os.Args[2:])
	case "sign":
		sign(os.Args[2:])
	default:
		die("unknown command %q", os.Args[1])
	}
}

func keygen(args []string) {
	fs := flag.NewFlagSet("keygen", flag.ExitOnError)
	outDir := fs.String("out-dir", "", "directory for private.pem, public.pem, and private.pem.b64")
	must(fs.Parse(args))
	if *outDir == "" {
		die("--out-dir is required")
	}

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	must(err)
	must(os.MkdirAll(*outDir, 0o700))

	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	must(err)
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	must(err)

	privatePEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER})
	publicPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})

	must(os.WriteFile(filepath.Join(*outDir, "private.pem"), privatePEM, 0o600))
	must(os.WriteFile(filepath.Join(*outDir, "public.pem"), publicPEM, 0o644))
	must(os.WriteFile(filepath.Join(*outDir, "private.pem.b64"), []byte(base64.StdEncoding.EncodeToString(privatePEM)), 0o600))
}

func sign(args []string) {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	kind := fs.String("kind", "", "gateway-image, relay-image, daemon-binary, or witness-binary")
	component := fs.String("component", "", "witness component (witness-binary)")
	out := fs.String("out", "", "output signed manifest path")
	version := fs.String("version", "", "version")
	tag := fs.String("tag", "", "release tag")
	daemonType := fs.String("daemon-type", "", "daemon type")
	arch := fs.String("arch", "", "architecture")
	artifactName := fs.String("artifact-name", "", "artifact name")
	downloadURL := fs.String("download-url", "", "download URL")
	sha256Hex := fs.String("sha256", "", "binary SHA256")
	image := fs.String("image", "", "Opfield image repository")
	digest := fs.String("digest", "", "Opfield image digest")
	secureLinkConnectorImage := fs.String("secure-link-connector-image", "", "digest-pinned secure-link connector image reference")
	relayProtocolMajor := fs.Int("relay-protocol-major", 0, "standalone relay protocol major")
	minGatewayVersion := fs.String("min-gateway-version", "", "minimum compatible Opfield version")
	commitSHA := fs.String("git-commit-sha", "", "Git commit SHA")
	pipelineID := fs.String("git-pipeline-id", "", "GitLab pipeline ID")
	must(fs.Parse(args))

	if *out == "" {
		die("--out is required")
	}

	privateKey := loadPrivateKeyFromEnv()
	createdAt := time.Now().UTC().Format(time.RFC3339)

	var payload any
	switch *kind {
	case "daemon-binary":
		required(map[string]string{
			"--version":       *version,
			"--tag":           *tag,
			"--daemon-type":   *daemonType,
			"--arch":          *arch,
			"--artifact-name": *artifactName,
			"--download-url":  *downloadURL,
			"--sha256":        *sha256Hex,
		})
		payload = updateauth.DaemonManifestPayload{
			Kind:          "daemon-binary",
			Version:       *version,
			Tag:           *tag,
			DaemonType:    *daemonType,
			Arch:          *arch,
			ArtifactName:  *artifactName,
			DownloadURL:   *downloadURL,
			SHA256:        strings.ToLower(*sha256Hex),
			CreatedAt:     createdAt,
			GitCommitSHA:  *commitSHA,
			GitPipelineID: *pipelineID,
		}
	case updateauth.WitnessBinaryKind:
		required(map[string]string{
			"--component":     *component,
			"--version":       *version,
			"--arch":          *arch,
			"--artifact-name": *artifactName,
			"--download-url":  *downloadURL,
			"--sha256":        *sha256Hex,
		})
		payload = updateauth.WitnessManifestPayload{
			Kind:         updateauth.WitnessBinaryKind,
			Component:    *component,
			Version:      *version,
			Arch:         *arch,
			ArtifactName: *artifactName,
			DownloadURL:  *downloadURL,
			SHA256:       strings.ToLower(*sha256Hex),
			CreatedAt:    createdAt,
			GitCommitSHA: *commitSHA,
		}
	case "gateway-image":
		required(map[string]string{
			"--version": *version,
			"--tag":     *tag,
			"--image":   *image,
			"--digest":  *digest,
		})
		payloadMap := map[string]any{
			"kind":          "gateway-image",
			"version":       *version,
			"tag":           *tag,
			"image":         *image,
			"digest":        *digest,
			"imageRef":      fmt.Sprintf("%s@%s", *image, *digest),
			"createdAt":     createdAt,
			"gitCommitSha":  *commitSHA,
			"gitPipelineId": *pipelineID,
		}
		if *secureLinkConnectorImage != "" {
			payloadMap["secureLinkConnectorImage"] = *secureLinkConnectorImage
		}
		payload = payloadMap
	case "relay-image":
		required(map[string]string{
			"--version":                     *version,
			"--tag":                         *tag,
			"--image":                       *image,
			"--digest":                      *digest,
			"--min-gateway-version":         *minGatewayVersion,
			"--secure-link-connector-image": *secureLinkConnectorImage,
		})
		if *relayProtocolMajor < 1 {
			die("--relay-protocol-major must be positive")
		}
		payload = map[string]any{
			"kind":                     "relay-image",
			"version":                  *version,
			"tag":                      *tag,
			"image":                    *image,
			"digest":                   *digest,
			"imageRef":                 fmt.Sprintf("%s@%s", *image, *digest),
			"protocolMajor":            *relayProtocolMajor,
			"minGatewayVersion":        *minGatewayVersion,
			"secureLinkConnectorImage": *secureLinkConnectorImage,
			"createdAt":                createdAt,
			"gitCommitSha":             *commitSHA,
			"gitPipelineId":            *pipelineID,
		}
	default:
		die("--kind must be gateway-image, relay-image, daemon-binary, or witness-binary")
	}

	payloadBytes, err := json.Marshal(payload)
	must(err)
	envelope := updateauth.SignPayload(privateKey, payloadBytes)
	outputBytes, err := json.MarshalIndent(envelope, "", "  ")
	must(err)
	outputBytes = append(outputBytes, '\n')
	must(os.WriteFile(*out, outputBytes, 0o644))
}

func loadPrivateKeyFromEnv() ed25519.PrivateKey {
	encoded := os.Getenv("UPDATE_SIGNING_PRIVATE_KEY_PEM_B64")
	if encoded == "" {
		die("UPDATE_SIGNING_PRIVATE_KEY_PEM_B64 is required")
	}
	privatePEM, err := base64.StdEncoding.DecodeString(encoded)
	must(err)
	block, _ := pem.Decode(privatePEM)
	if block == nil {
		die("private key PEM is invalid")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	must(err)
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		die("private key is not Ed25519")
	}
	return privateKey
}

func required(values map[string]string) {
	for name, value := range values {
		if value == "" {
			die("%s is required", name)
		}
	}
}

func must(err error) {
	if err != nil {
		die("%v", err)
	}
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
