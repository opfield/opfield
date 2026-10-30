package access

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T, synced bool) (*Server, *Store, func(Claims) string) {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	command, key := testPolicy(t)
	if synced {
		if _, err := store.Apply(command); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(store)
	server.now = func() time.Time { return testNow }
	server.rand = bytes.NewReader(bytes.Repeat([]byte{7}, 64))
	return server, store, func(claims Claims) string { return signToken(t, key, claims) }
}

func accessRequest(path, list, clientIP string, header http.Header) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://access"+path, nil)
	for name, values := range header {
		r.Header[name] = values
	}
	r.Header.Set(ListHeader, list)
	r.Header.Set(HostHeader, testHost)
	r.Header.Set(ClientIPHeader, clientIP)
	r.Header.Set(URIHeader, "/reports?q=1")
	r.Header.Set(SecureHeader, "on")
	return r
}

func serve(server *Server, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, r)
	return w
}

func TestCheck(t *testing.T) {
	server, _, sign := testServer(t, true)
	cookie := func(token string) http.Header {
		return http.Header{"Cookie": {TokenCookie + "=" + token}}
	}
	foreign := testClaims("lena@gmail.com")
	cases := []struct {
		name   string
		list   string
		ip     string
		header http.Header
		status int
	}{
		{"unknown list fails closed", "33333333-3333-4333-8333-333333333333", "203.0.113.9", nil, http.StatusServiceUnavailable},
		{"skip range", testListID, "10.0.40.7", nil, http.StatusOK},
		{"not signed in", testListID, "203.0.113.9", nil, http.StatusUnauthorized},
		{"signed in and included", testListID, "203.0.113.9", cookie(sign(testClaims("lena@acme.dev"))), http.StatusOK},
		{"signed in, not included: sign-in page", testListID, "203.0.113.9", cookie(sign(foreign)), http.StatusUnauthorized},
		{"service token", testListID, "203.0.113.9", http.Header{ServiceTokenIDHeader: {"ci.client"}, ServiceTokenSecretHeader: {"token-secret"}}, http.StatusOK},
		{"wrong service token secret", testListID, "203.0.113.9", http.Header{ServiceTokenIDHeader: {"ci.client"}, ServiceTokenSecretHeader: {"nope"}}, http.StatusUnauthorized},
		{"service token on a list without its rule", testBasicID, "203.0.113.9", http.Header{ServiceTokenIDHeader: {"ci.client"}, ServiceTokenSecretHeader: {"token-secret"}}, http.StatusForbidden},
		{"basic without credentials", testBasicID, "203.0.113.9", nil, http.StatusUnauthorized},
		{"basic with credentials", testBasicID, "203.0.113.9", http.Header{"Authorization": {basicHeader("lena", "s3cret")}}, http.StatusOK},
		{"basic with a wrong password", testBasicID, "203.0.113.9", http.Header{"Authorization": {basicHeader("lena", "wrong")}}, http.StatusUnauthorized},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if w := serve(server, accessRequest("/check", c.list, c.ip, c.header)); w.Code != c.status {
				t.Fatalf("status %d, want %d", w.Code, c.status)
			}
		})
	}

	token := sign(testClaims("lena@acme.dev"))
	w := serve(server, accessRequest("/check", testListID, "203.0.113.9", cookie(token)))
	if w.Header().Get(AssertionHeader) != token || w.Header().Get(EmailHeader) != "lena@acme.dev" || w.Header().Get(UserHeader) != "Lena Novak" {
		t.Fatalf("identity headers: %v", w.Header())
	}
	w = serve(server, accessRequest("/check", testBasicID, "203.0.113.9", http.Header{"Authorization": {basicHeader("lena", "s3cret")}}))
	if w.Header().Get(AssertionHeader) != "" || w.Header().Get(UserHeader) != "lena" {
		t.Fatalf("basic identity headers: %v", w.Header())
	}
}

func TestCheckWithoutPolicyFailsClosed(t *testing.T) {
	server, _, _ := testServer(t, false)
	for _, path := range []string{"/check", "/challenge", "/callback"} {
		if w := serve(server, accessRequest(path, testListID, "10.0.40.7", nil)); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status %d", path, w.Code)
		}
	}
}

func basicHeader(username, password string) string {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.SetBasicAuth(username, password)
	return r.Header.Get("Authorization")
}

func TestChallenge(t *testing.T) {
	server, _, _ := testServer(t, true)
	// The visitor goes to the route's own sign-in page on the same host; no cookie is set.
	w := serve(server, accessRequest("/challenge", testListID, "203.0.113.9", nil))
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/_opfield/access/sign-in?r=%2Freports%3Fq%3D1" || len(w.Result().Cookies()) != 0 {
		t.Fatalf("challenge %d %v", w.Code, w.Header())
	}
	// Opfield's own paths are never a page to return to.
	r := accessRequest("/challenge", testListID, "203.0.113.9", nil)
	r.Header.Set(URIHeader, "/_opfield/access/sign-in?r=%2F")
	if w := serve(server, r); w.Header().Get("Location") != "/_opfield/access/sign-in?r=%2F" {
		t.Fatalf("challenge of an Opfield path: %v", w.Header())
	}

	w = serve(server, accessRequest("/challenge", testBasicID, "203.0.113.9", nil))
	if w.Code != http.StatusUnauthorized || w.Header().Get("WWW-Authenticate") != `Basic realm="app.example.com", charset="UTF-8"` {
		t.Fatalf("basic challenge %d %v", w.Code, w.Header())
	}
}

func TestCallback(t *testing.T) {
	server, _, sign := testServer(t, true)
	claims := testClaims("lena@acme.dev")
	claims.Nonce = "nonce-1"
	token := sign(claims)
	callback := func(token, returnTo, state string) *httptest.ResponseRecorder {
		r := accessRequest("/callback?t="+url.QueryEscape(token)+"&r="+url.QueryEscape(returnTo), "", "", nil)
		if state != "" {
			r.AddCookie(&http.Cookie{Name: StateCookie, Value: state})
		}
		return serve(server, r)
	}

	w := callback(token, "/reports?q=1", "nonce-1")
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/reports?q=1" ||
		w.Header().Get("Referrer-Policy") != "no-referrer" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("callback %d %v", w.Code, w.Header())
	}
	cookies := map[string]*http.Cookie{}
	for _, cookie := range w.Result().Cookies() {
		cookies[cookie.Name] = cookie
	}
	access, state := cookies[hostCookiePrefix+TokenCookie], cookies[StateCookie]
	if access == nil || access.Value != token || !access.HttpOnly || !access.Secure || access.Path != "/" || access.MaxAge != 3600 {
		t.Fatalf("access cookie %+v", access)
	}
	if state == nil || state.MaxAge >= 0 {
		t.Fatalf("state cookie not cleared: %+v", state)
	}

	for returnTo, want := range map[string]string{"//evil.example": "/", "https://evil.example/": "/", "/\\evil": "/", "": "/", "/" + strings.Repeat("a", 4096): "/"} {
		if w := callback(token, returnTo, "nonce-1"); w.Header().Get("Location") != want {
			t.Errorf("return %q went to %q", returnTo, w.Header().Get("Location"))
		}
	}
	other := testClaims("lena@acme.dev")
	other.Audience = "other.example.com"
	other.Nonce = "nonce-1"
	for name, w := range map[string]*httptest.ResponseRecorder{
		"no state cookie":     callback(token, "/", ""),
		"another state":       callback(token, "/", "nonce-2"),
		"token without non":   callback(sign(testClaims("lena@acme.dev")), "/", "nonce-1"),
		"token of other host": callback(sign(other), "/", "nonce-1"),
	} {
		if w.Code != http.StatusBadRequest || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") || len(w.Result().Cookies()) != 0 {
			t.Errorf("%s: %d %v", name, w.Code, w.Header())
		}
	}
}

// A signed-in visitor the list turns away (denied outright, as a sign-in moments ago that the list refuses is, or
// refused by its rules) goes through the challenge to the sign-in page's denied view, never to nginx's 403 page; the
// page shows that view even if it would let the visitor in, so the two never send the visitor back and forth.
func TestSignedInRefusalShowsTheDeniedView(t *testing.T) {
	server, _, sign := signInServer(t)
	fresh := testClaims("lena@gmail.com")
	fresh.IssuedAt = testNow.Add(-10 * time.Second).Unix()
	deniedLink := "/_opfield/access/sign-in?denied=1&r=%2Freports%3Fq%3D1"
	// nginx proxies /_opfield/access/ to /ui/ of the socket.
	deniedPage := strings.Replace(deniedLink, signInPrefix, "/ui/", 1)
	for name, claims := range map[string]Claims{"fresh sign-in": fresh, "older sign-in": testClaims("lena@gmail.com")} {
		header := http.Header{"Cookie": {TokenCookie + "=" + sign(claims)}}
		if w := serve(server, accessRequest("/check", testListID, "203.0.113.9", header)); w.Code != http.StatusUnauthorized {
			t.Fatalf("%s /check: %d", name, w.Code)
		}
		if w := serve(server, accessRequest("/challenge", testListID, "203.0.113.9", header)); w.Code != http.StatusFound || w.Header().Get("Location") != deniedLink {
			t.Fatalf("%s /challenge: %d %v", name, w.Code, w.Header())
		}
		w := serve(server, uiRequest(http.MethodGet, deniedPage, nil, &http.Cookie{Name: TokenCookie, Value: sign(claims)}))
		body := w.Body.String()
		if w.Code != http.StatusForbidden || !strings.Contains(body, "You don&#39;t have access to this site") ||
			!strings.Contains(body, "lena@gmail.com") || !strings.Contains(body, "Use another account") {
			t.Fatalf("%s denied view: %d", name, w.Code)
		}
	}
	// The page the challenge sent a visitor to does not send them back, even when it would let them in.
	allowed := &http.Cookie{Name: hostCookiePrefix + TokenCookie, Value: sign(testClaims("lena@acme.dev"))}
	if w := serve(server, uiRequest(http.MethodGet, deniedPage, nil, allowed)); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "Use another account") {
		t.Fatalf("denied link, allowed visitor: %d %v", w.Code, w.Header())
	}
	// A visitor without a session (or with an invalid one) is still asked to sign in.
	for name, header := range map[string]http.Header{"no session": nil, "invalid session": {"Cookie": {TokenCookie + "=nope"}}} {
		if w := serve(server, accessRequest("/challenge", testListID, "203.0.113.9", header)); w.Code != http.StatusFound ||
			w.Header().Get("Location") != "/_opfield/access/sign-in?r=%2Freports%3Fq%3D1" {
			t.Fatalf("%s: %d %v", name, w.Code, w.Header())
		}
	}
}

// /check accepts the __Host- access cookie and the bare one of earlier releases; a bare cookie a sibling subdomain set
// never shadows the visitor's own __Host- one.
func TestCheckAcceptsBothAccessCookieNames(t *testing.T) {
	server, _, sign := testServer(t, true)
	allowed, foreign := sign(testClaims("lena@acme.dev")), sign(testClaims("lena@gmail.com"))
	for name, cookie := range map[string]string{
		"__Host- cookie":      hostCookiePrefix + TokenCookie + "=" + allowed,
		"bare cookie":         TokenCookie + "=" + allowed,
		"tossed bare cookie":  TokenCookie + "=" + foreign + "; " + hostCookiePrefix + TokenCookie + "=" + allowed,
		"tossed cookie first": TokenCookie + "=" + foreign + "; " + TokenCookie + "=x; " + hostCookiePrefix + TokenCookie + "=" + allowed,
	} {
		w := serve(server, accessRequest("/check", testListID, "203.0.113.9", http.Header{"Cookie": {cookie}}))
		if w.Code != http.StatusOK {
			t.Errorf("%s: %d", name, w.Code)
		}
	}
	// The refused identity alone is refused, so the cases above did not read it.
	if w := serve(server, accessRequest("/check", testListID, "203.0.113.9", http.Header{"Cookie": {TokenCookie + "=" + foreign}})); w.Code == http.StatusOK {
		t.Fatal("the foreign identity must be refused")
	}
}
