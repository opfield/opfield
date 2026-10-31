package pages

import (
	"strings"
	"testing"
)

// earlierPreviewAccessBlock is the access block the 2.13.0 daemon wrote into a protected preview: a challenge that sent
// visitors to the sign-in domain and no sign-in location on the preview itself.
const earlierPreviewAccessBlock = `    auth_request /_opfield/access/check;
    error_page 401 = @opfield_access_challenge;
    location = /_opfield/access/check {
        internal;
        auth_request off;
        proxy_pass http://unix:/run/nginx-daemon/access.sock:/check;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Opfield-Access-List "0f8b6c1e-5d3a-4b7f-9c2e-1a2b3c4d5e6f";
        proxy_set_header X-Opfield-Access-Host $host;
        proxy_set_header X-Opfield-Access-Client-Ip $remote_addr;
        proxy_set_header X-Opfield-Access-Uri $request_uri;
        proxy_set_header X-Opfield-Access-Secure $https;
    }
    location = /_opfield/access/callback {
        auth_request off;
        access_log off;
        proxy_pass http://unix:/run/nginx-daemon/access.sock:/callback;
        proxy_set_header X-Opfield-Access-Host $host;
        proxy_set_header X-Opfield-Access-Secure $https;
    }
    location @opfield_access_challenge {
        auth_request off;
        rewrite ^ /challenge break;
        proxy_pass http://unix:/run/nginx-daemon/access.sock;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Opfield-Access-List "0f8b6c1e-5d3a-4b7f-9c2e-1a2b3c4d5e6f";
        proxy_set_header X-Opfield-Access-Host $host;
        proxy_set_header X-Opfield-Access-Client-Ip $remote_addr;
        proxy_set_header X-Opfield-Access-Uri $request_uri;
        proxy_set_header X-Opfield-Access-Secure $https;
    }
`

func TestEarlierPreviewAccessBlockGetsTheSignInLocation(t *testing.T) {
	before := "server {\n    listen 443 ssl;\n    server_name a.pages.example.com;\n" + earlierPreviewAccessBlock +
		"    location / {\n        try_files $uri $uri/ =404;\n    }\n}\n"
	after, changed := upgradePreviewAccess(before)
	if !changed {
		t.Fatal("an earlier access block was left as it was")
	}
	want := strings.Join(previewAccessCheckDirectives("0f8b6c1e-5d3a-4b7f-9c2e-1a2b3c4d5e6f"), "\n") + "\n"
	if !strings.Contains(after, want) {
		t.Fatalf("the access block is not the current one:\n%s", after)
	}
	for _, kept := range []string{"server_name a.pages.example.com;", "try_files $uri $uri/ =404;"} {
		if !strings.Contains(after, kept) {
			t.Fatalf("%q is gone:\n%s", kept, after)
		}
	}
	if strings.Count(after, "auth_request /_opfield/access/check;") != 1 {
		t.Fatalf("the check is not there exactly once:\n%s", after)
	}
	if again, changedAgain := upgradePreviewAccess(after); changedAgain || again != after {
		t.Fatal("a current preview was changed again")
	}
}

func TestPreviewWithoutAccessCheckIsLeftAlone(t *testing.T) {
	plain := "server {\n    listen 443 ssl;\n    allow 10.0.0.0/8;\n    deny all;\n}\n"
	if got, changed := upgradePreviewAccess(plain); changed || got != plain {
		t.Fatal("a preview without an access check was changed")
	}
}
