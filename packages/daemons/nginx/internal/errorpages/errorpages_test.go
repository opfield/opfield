package errorpages

import (
	"os"
	"path/filepath"
	"strconv"
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
	// 505 ends a request before nginx has its URI, like 400 and 414.
	if !strings.Contains(directives, "error_page 400 414 505 "+RequestLinePath+";") || !strings.Contains(directives, "location = "+RequestLinePath+" {\n        internal;") {
		t.Fatalf("400, 414 and 505 must go to the internal path:\n%s", directives)
	}
	if !strings.Contains(directives, "error_page 401 403 405 408 413 429 500 501 502 503 504 "+Location(0)+";") {
		t.Fatalf("501 must go to the named location:\n%s", directives)
	}
	for _, code := range []int{501, 505} {
		if !strings.Contains(config, "    "+strconv.Itoa(code)+" '") {
			t.Fatalf("config lacks the %d page", code)
		}
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

// A server block an earlier daemon (or the installer) wrote gets the codes of V2Codes; nothing else changes.
func TestUpgradeServerDirectives(t *testing.T) {
	old := "server {\n" + strings.Join(ServerDirectives(V2Codes...), "\n") + "\n}\n"
	if strings.Contains(old, "501") || strings.Contains(old, "505") {
		t.Fatal("the earlier directives name no 501 or 505")
	}
	upgraded, changed := UpgradeServerDirectives(old)
	if !changed || upgraded != "server {\n"+strings.Join(ServerDirectives(), "\n")+"\n}\n" {
		t.Fatalf("changed=%v:\n%s", changed, upgraded)
	}
	if again, changed := UpgradeServerDirectives(upgraded); changed || again != upgraded {
		t.Fatal("an upgraded server is left alone")
	}
	// A server that answers 404 itself (a preview) gets the codes too, and keeps answering 404 itself.
	own := strings.Join(ServerDirectives(append([]int{404}, V2Codes...)...), "\n") + "\n"
	upgraded, changed = UpgradeServerDirectives(own)
	if !changed || upgraded != strings.Join(ServerDirectives(404), "\n")+"\n" {
		t.Fatalf("changed=%v:\n%s", changed, upgraded)
	}
	// Other error_page lines (a project's own, the access challenge) are never touched.
	other := "    error_page 404 @opfield_pages_404;\n    error_page 401 = @opfield_access_challenge;\n    error_page 500 502 /custom.html;\n"
	if again, changed := UpgradeServerDirectives(other); changed || again != other {
		t.Fatal("other error_page lines are not rewritten")
	}
}
