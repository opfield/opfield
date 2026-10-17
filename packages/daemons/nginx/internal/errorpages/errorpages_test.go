package errorpages

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPagesAreSelfContainedAndFitOneNginxToken(t *testing.T) {
	for _, page := range append(append([]Page{}, Pages...), SpecialPages...) {
		for _, branded := range []bool{true, false} {
			html := HTML(page, branded)
			// nginx reads a config token into a 4 KiB buffer, and "$" would start a variable.
			if len(html) >= 4000 {
				t.Fatalf("page %d is %d bytes", page.Code, len(html))
			}
			if strings.ContainsAny(html, "$'") {
				t.Fatalf("page %d holds $ or '", page.Code)
			}
			if strings.Contains(html, "http://") || strings.Contains(html, "<link") || strings.Contains(html, "<script") || strings.Contains(html, "src=") {
				t.Fatalf("page %d loads an external asset", page.Code)
			}
			if strings.Contains(html, "Powered by") != branded {
				t.Fatalf("page %d branding = %v", page.Code, !branded)
			}
		}
	}
	if !strings.Contains(HTML(SpecialPages[0], true), "Error 400") {
		t.Fatal("494 must name the status nginx sends (400)")
	}
}

func TestConfigDefinesEveryVariableTheDirectivesUse(t *testing.T) {
	config := Config()
	for _, code := range []int{0, 494, 495, 496, 497} {
		for _, branded := range []bool{true, false} {
			if !strings.Contains(config, " "+Variable(code, branded)+" {") {
				t.Fatalf("config lacks %s", Variable(code, branded))
			}
		}
	}
	directives := strings.Join(ServerDirectives(404), "\n")
	if strings.Contains(directives, " 404 ") {
		t.Fatal("an excepted code is still handed to the pages")
	}
	if !strings.Contains(directives, "error_page 400 414 "+RequestLinePath+";") || !strings.Contains(directives, "location = "+RequestLinePath+" {\n        internal;") {
		t.Fatalf("400 and 414 must go to the internal path:\n%s", directives)
	}
	if dir := os.Getenv("OPFIELD_NGINX_RENDER_DIR"); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "00-opfield-error-pages.conf"), []byte(config), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
