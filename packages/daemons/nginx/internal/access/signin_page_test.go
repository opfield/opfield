package access

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var previewMethods = []SignInMethod{
	{Key: "opfield", Kind: "opfield", Label: "Opfield"},
	{Key: "idp:google", Kind: "idp", Label: "Google"},
	{Key: "password", Kind: "password", Label: "Username"},
	{Key: "shared", Kind: "shared", Label: "Shared password"},
}

// previewPages are the page's states, as the sign-in page shows them.
func previewPages() map[string]SignInPage {
	base := func(step string) SignInPage {
		return SignInPage{Nonce: "preview", Host: "grafana.acme.dev", Step: step, Methods: previewMethods, CSRF: strings.Repeat("c", 43), Return: "/d/overview?orgId=1"}
	}
	passwordError := base(stepPassword)
	passwordError.Username, passwordError.Error = "lena", "Wrong username or password"
	providerError := base(stepMethods)
	providerError.Failed, providerError.Error = true, messageSignInFailed
	single := base(stepShared)
	single.Methods = []SignInMethod{{Key: "shared", Kind: "shared", Label: "Shared password"}}
	return map[string]SignInPage{
		"methods":        base(stepMethods),
		"password":       base(stepPassword),
		"password-error": passwordError,
		"shared":         base(stepShared),
		"provider-error": providerError,
		"single-method":  single,
		"denied":         {Nonce: "preview", Host: "grafana.acme.dev", Step: stepDenied, Account: "lena@gmail.com", CSRF: strings.Repeat("c", 43), Return: "/"},
		"unavailable":    {Nonce: "preview", Host: "grafana.acme.dev", Step: stepNotice, Subtitle: "Sign-in is unavailable", Error: messageUnavailable},
	}
}

// TestWritePreview writes every state of the page to OPFIELD_SIGN_IN_PREVIEW_DIR, to look at in a browser.
func TestWritePreview(t *testing.T) {
	dir := os.Getenv("OPFIELD_SIGN_IN_PREVIEW_DIR")
	if dir == "" {
		t.Skip("OPFIELD_SIGN_IN_PREVIEW_DIR is not set")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, page := range previewPages() {
		body, err := RenderSignInPage(page)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name+".html"), body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRenderSignInPage(t *testing.T) {
	for name, page := range previewPages() {
		body, err := RenderSignInPage(page)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		html := string(body)
		for _, want := range []string{"<title>grafana.acme.dev</title>", `<style nonce="preview">`, `<script nonce="preview">`, "Protected by"} {
			if !strings.Contains(html, want) {
				t.Errorf("%s: missing %q", name, want)
			}
		}
		if strings.Contains(html, "ZgotmplZ") {
			t.Errorf("%s: a value was rejected by the template", name)
		}
	}
	html := func(name string) string {
		body, _ := RenderSignInPage(previewPages()[name])
		return string(body)
	}
	methods := html("methods")
	for _, want := range []string{
		`href="/_opfield/access/start/opfield?r=%2Fd%2Foverview%3ForgId%3D1" data-leave`,
		`href="/_opfield/access/start/idp:google?r=%2Fd%2Foverview%3ForgId%3D1" data-leave`,
		`href="/_opfield/access/sign-in?step=password&amp;r=%2Fd%2Foverview%3ForgId%3D1" data-goto="password"`,
		"Sign in with Opfield", "Sign in with Google", "Sign in with username", "Enter shared password",
		`<section class="step" data-step="password" data-title="Sign in to continue" hidden>`,
	} {
		if !strings.Contains(methods, want) {
			t.Errorf("methods: missing %q", want)
		}
	}
	if !strings.Contains(html("password-error"), `value="lena"`) || !strings.Contains(html("password-error"), "Wrong username or password") {
		t.Error("a failed username sign-in keeps the username and says why")
	}
	if strings.Contains(html("single-method"), "Other sign-in methods") || !strings.Contains(html("single-method"), "Enter the password to continue") {
		t.Error("a list with only the shared password opens its form without a way back")
	}
	if !strings.Contains(html("provider-error"), "Sign-in failed") {
		t.Error("a failed provider sign-in says so")
	}
	escaped := previewPages()["methods"]
	escaped.Host = `<script>alert(1)</script>`
	escaped.Return = `/"><script>`
	body, _ := RenderSignInPage(escaped)
	if strings.Contains(string(body), "<script>alert") || strings.Contains(string(body), `"><script>`) {
		t.Error("host and return path must be escaped")
	}
}
