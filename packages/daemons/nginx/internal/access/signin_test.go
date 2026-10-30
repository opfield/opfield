package access

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// fakeSignIn answers the sign-in page as Opfield would and remembers what it was asked.
type fakeSignIn struct {
	methods  []*pb.AccessSignInMethod
	password *pb.AccessSignInReply
	start    *pb.AccessSignInStartReply
	finish   *pb.AccessSignInReply
	err      error

	passwordRequest *pb.AccessSignInPasswordRequest
	startRequest    *pb.AccessSignInStartRequest
	finishRequest   *pb.AccessSignInFinishRequest
}

func (f *fakeSignIn) Context(_ context.Context, _ *pb.AccessSignInContextRequest, _ ...grpc.CallOption) (*pb.AccessSignInContextReply, error) {
	return &pb.AccessSignInContextReply{Methods: f.methods}, f.err
}

func (f *fakeSignIn) Password(_ context.Context, in *pb.AccessSignInPasswordRequest, _ ...grpc.CallOption) (*pb.AccessSignInReply, error) {
	f.passwordRequest = in
	return f.password, f.err
}

func (f *fakeSignIn) StartProvider(_ context.Context, in *pb.AccessSignInStartRequest, _ ...grpc.CallOption) (*pb.AccessSignInStartReply, error) {
	f.startRequest = in
	return f.start, f.err
}

func (f *fakeSignIn) FinishProvider(_ context.Context, in *pb.AccessSignInFinishRequest, _ ...grpc.CallOption) (*pb.AccessSignInReply, error) {
	f.finishRequest = in
	return f.finish, f.err
}

func signInServer(t *testing.T) (*Server, *fakeSignIn, func(Claims) string) {
	t.Helper()
	server, _, sign := testServer(t, true)
	server.rand = rand.Reader
	fake := &fakeSignIn{methods: []*pb.AccessSignInMethod{
		{Key: "opfield", Kind: "opfield", Label: "Opfield"},
		{Key: "idp:g1", Kind: "idp", Label: "Google"},
		{Key: "password", Kind: "password", Label: "Username"},
	}}
	server.SetSignInClient(fake)
	return server, fake, sign
}

// uiRequest is a request nginx sends from /_opfield/access/ of the protected route.
func uiRequest(method, target string, form url.Values, cookies ...*http.Cookie) *http.Request {
	var r *http.Request
	if form != nil {
		r = httptest.NewRequest(method, "http://access"+target, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		r = httptest.NewRequest(method, "http://access"+target, nil)
	}
	r.Header.Set(ListHeader, testListID)
	r.Header.Set(HostHeader, testHost)
	r.Header.Set(ClientIPHeader, "203.0.113.9")
	r.Header.Set(SchemeHeader, "https")
	r.Header.Set("User-Agent", "Firefox")
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	return r
}

func responseCookies(w *httptest.ResponseRecorder) map[string]*http.Cookie {
	cookies := map[string]*http.Cookie{}
	for _, cookie := range w.Result().Cookies() {
		cookies[cookie.Name] = cookie
	}
	return cookies
}

func TestSignInPage(t *testing.T) {
	server, _, sign := signInServer(t)
	w := serve(server, uiRequest(http.MethodGet, "/ui/sign-in?r=%2Freports%3Fq%3D1", nil))
	body := w.Body.String()
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") ||
		!strings.Contains(w.Header().Get("Content-Security-Policy"), "script-src 'nonce-") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("page %d %v", w.Code, w.Header())
	}
	for _, want := range []string{"<h1>app.example.com</h1>", "Sign in with Opfield", "Sign in with Google", "Sign in with username", `name="r" value="/reports?q=1"`} {
		if !strings.Contains(body, want) {
			t.Errorf("page is missing %q", want)
		}
	}
	csrf := responseCookies(w)[hostCookiePrefix+CSRFCookie]
	if csrf == nil || !csrf.HttpOnly || !csrf.Secure || csrf.SameSite != http.SameSiteStrictMode || csrf.Path != "/" || csrf.Domain != "" ||
		!strings.Contains(body, `name="csrf" value="`+csrf.Value+`"`) {
		t.Fatalf("csrf cookie %+v", csrf)
	}

	// A visitor the list lets in goes back to the page.
	allowed := &http.Cookie{Name: hostCookiePrefix + TokenCookie, Value: sign(testClaims("lena@acme.dev"))}
	if w := serve(server, uiRequest(http.MethodGet, "/ui/sign-in?r=%2Freports", nil, allowed)); w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/reports" {
		t.Fatalf("signed in: %d %v", w.Code, w.Header())
	}
	// A signed-in visitor the list turns away is told so and may use another account.
	refused := &http.Cookie{Name: TokenCookie, Value: sign(testClaims("lena@gmail.com"))}
	w = serve(server, uiRequest(http.MethodGet, "/ui/sign-in", nil, refused))
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "lena@gmail.com") || !strings.Contains(w.Body.String(), "Use another account") {
		t.Fatalf("denied: %d", w.Code)
	}
	// Steps without JS.
	if w := serve(server, uiRequest(http.MethodGet, "/ui/sign-in?step=password", nil)); !strings.Contains(w.Body.String(), `data-step="password" data-title="Sign in to continue">`) {
		t.Fatal("?step=password must show the username form")
	}

	server.SetSignInClient(nil)
	if w := serve(server, uiRequest(http.MethodGet, "/ui/sign-in", nil)); w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), messageUnavailable) {
		t.Fatalf("without a control session: %d", w.Code)
	}
	// Only the page's own paths are served under /ui/.
	for _, path := range []string{"/ui/check", "/ui/challenge", "/ui/"} {
		if w := serve(server, uiRequest(http.MethodGet, path, nil)); w.Code != http.StatusNotFound {
			t.Errorf("%s: %d", path, w.Code)
		}
	}
}

func TestPasswordSignIn(t *testing.T) {
	server, fake, sign := signInServer(t)
	page := serve(server, uiRequest(http.MethodGet, "/ui/sign-in", nil))
	csrf := responseCookies(page)[hostCookiePrefix+CSRFCookie]
	form := func(token string) url.Values {
		return url.Values{"kind": {"password"}, "username": {"lena"}, "password": {"pw"}, "r": {"/reports?q=1"}, "csrf": {token}}
	}

	// No CSRF pair: Opfield is not asked.
	w := serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form(csrf.Value)))
	if w.Code != http.StatusForbidden || fake.passwordRequest != nil || !strings.Contains(w.Body.String(), messageExpired) {
		t.Fatalf("without the csrf cookie: %d", w.Code)
	}
	// Over HTTPS a bare CSRF cookie (one a sibling subdomain can set) does not count.
	tossed := &http.Cookie{Name: CSRFCookie, Value: csrf.Value}
	if w := serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form(csrf.Value), tossed)); w.Code != http.StatusForbidden || fake.passwordRequest != nil {
		t.Fatalf("with a bare csrf cookie over https: %d", w.Code)
	}

	fake.password = &pb.AccessSignInReply{Allowed: false, ErrorCode: "ACCESS_SIGN_IN_FAILED", Message: "Wrong username or password"}
	w = serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form(csrf.Value), csrf))
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "Wrong username or password") || !strings.Contains(w.Body.String(), `value="lena"`) {
		t.Fatalf("refused: %d", w.Code)
	}
	target := fake.passwordRequest.GetTarget()
	if target.GetListId() != testListID || target.GetHost() != testHost || target.GetClientIp() != "203.0.113.9" || target.GetUserAgent() != "Firefox" ||
		fake.passwordRequest.GetKind() != "password" || fake.passwordRequest.GetUsername() != "lena" || fake.passwordRequest.GetPassword() != "pw" {
		t.Fatalf("request %+v", fake.passwordRequest)
	}

	fake.password = &pb.AccessSignInReply{Allowed: false, ErrorCode: "ACCESS_RATE_LIMITED", Message: "Too many attempts"}
	if w := serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form(csrf.Value), csrf)); w.Code != http.StatusTooManyRequests {
		t.Fatalf("rate limited: %d", w.Code)
	}

	token := sign(testClaims("lena@acme.dev"))
	fake.password = &pb.AccessSignInReply{Allowed: true, Token: token}
	w = serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form(csrf.Value), csrf))
	access := responseCookies(w)[hostCookiePrefix+TokenCookie]
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/reports?q=1" ||
		access == nil || access.Value != token || access.Path != "/" || access.Domain != "" || !access.HttpOnly || !access.Secure || access.MaxAge != 3600 {
		t.Fatalf("allowed: %d %v %+v", w.Code, w.Header(), access)
	}
	if responseCookies(w)[TokenCookie] != nil {
		t.Fatal("no bare access cookie to expire, none set")
	}
	// The bare access cookie of an earlier release is expired once the __Host- one is set.
	legacy := &http.Cookie{Name: TokenCookie, Value: sign(testClaims("lena@gmail.com"))}
	w = serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form(csrf.Value), csrf, legacy))
	if expired := responseCookies(w)[TokenCookie]; expired == nil || expired.MaxAge >= 0 || expired.Path != "/" {
		t.Fatalf("bare access cookie not expired: %+v", expired)
	}

	// A token for another host never becomes the cookie.
	other := testClaims("lena@acme.dev")
	other.Audience = "other.example.com"
	fake.password = &pb.AccessSignInReply{Allowed: true, Token: sign(other)}
	w = serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form(csrf.Value), csrf))
	if w.Code != http.StatusBadGateway || responseCookies(w)[hostCookiePrefix+TokenCookie] != nil {
		t.Fatalf("token of another host: %d", w.Code)
	}

	// A return path to another site goes to /.
	bad := form(csrf.Value)
	bad.Set("r", "//evil.example/")
	fake.password = &pb.AccessSignInReply{Allowed: true, Token: token}
	if w := serve(server, uiRequest(http.MethodPost, "/ui/sign-in", bad, csrf)); w.Header().Get("Location") != "/" {
		t.Fatalf("return to another site: %v", w.Header())
	}

	fake.err = errors.New("unavailable")
	if w := serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form(csrf.Value), csrf)); w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), messageUnavailable) {
		t.Fatalf("Opfield unreachable: %d", w.Code)
	}
}

// A client over its budget is told to wait (429), never that sign-in is unavailable: as a refusal in the reply, and
// as RESOURCE_EXHAUSTED (Opfield's answer to Context, which has no refusal field).
func TestSignInRateLimited(t *testing.T) {
	server, fake, _ := signInServer(t)
	csrf := responseCookies(serve(server, uiRequest(http.MethodGet, "/ui/sign-in", nil)))[hostCookiePrefix+CSRFCookie]
	form := url.Values{"kind": {"password"}, "username": {"lena"}, "password": {"pw"}, "csrf": {csrf.Value}}
	limited := func(name string, w *httptest.ResponseRecorder) {
		t.Helper()
		if w.Code != http.StatusTooManyRequests || !strings.Contains(w.Body.String(), messageRateLimited) || strings.Contains(w.Body.String(), messageUnavailable) {
			t.Fatalf("%s: %d", name, w.Code)
		}
	}
	fake.password = &pb.AccessSignInReply{Allowed: false, ErrorCode: "ACCESS_RATE_LIMITED", Message: "Too many attempts. Wait a minute and try again."}
	limited("password refusal", serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form, csrf)))
	fake.start = &pb.AccessSignInStartReply{ErrorCode: "ACCESS_RATE_LIMITED", Message: "Too many attempts. Wait a minute and try again."}
	limited("start refusal", serve(server, uiRequest(http.MethodGet, "/ui/start/idp:g1", nil)))

	fake.err = status.Error(codes.ResourceExhausted, "Too many requests, please try again later")
	limited("page", serve(server, uiRequest(http.MethodGet, "/ui/sign-in", nil)))
	limited("password call", serve(server, uiRequest(http.MethodPost, "/ui/sign-in", form, csrf)))
	limited("start call", serve(server, uiRequest(http.MethodGet, "/ui/start/idp:g1", nil)))

	// Other failures keep their own statuses.
	fake.err = status.Error(codes.PermissionDenied, "Enrolled nginx node required")
	if w := serve(server, uiRequest(http.MethodGet, "/ui/sign-in", nil)); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), messageUnavailable) {
		t.Fatalf("node refused: %d", w.Code)
	}
	fake.err = status.Error(codes.Unavailable, "Sign-in is unavailable")
	if w := serve(server, uiRequest(http.MethodGet, "/ui/sign-in", nil)); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("Opfield unavailable: %d", w.Code)
	}
	fake.err = nil
	for code, want := range map[string]int{"ACCESS_DENIED": 403, "ACCESS_METHOD_NOT_OFFERED": 404, "ACCESS_SIGN_IN_EXPIRED": 400, "ACCESS_SIGN_IN_FAILED": 401} {
		fake.start = &pb.AccessSignInStartReply{ErrorCode: code, Message: "No."}
		if w := serve(server, uiRequest(http.MethodGet, "/ui/start/idp:g1", nil)); w.Code != want {
			t.Errorf("%s: %d, want %d", code, w.Code, want)
		}
	}
}

func TestProviderSignIn(t *testing.T) {
	server, fake, sign := signInServer(t)
	fake.start = &pb.AccessSignInStartReply{AuthorizeUrl: "https://accounts.google.com/o/oauth2/auth?state=abc", State: "state-1"}
	w := serve(server, uiRequest(http.MethodGet, "/ui/start/idp:g1?r=%2Freports%3Fq%3D1", nil))
	if w.Code != http.StatusFound || w.Header().Get("Location") != fake.start.AuthorizeUrl {
		t.Fatalf("start %d %v", w.Code, w.Header())
	}
	if fake.startRequest.GetMethodKey() != "idp:g1" || fake.startRequest.GetCallbackUrl() != "https://app.example.com/_opfield/access/provider-callback" {
		t.Fatalf("start request %+v", fake.startRequest)
	}
	state := responseCookies(w)[hostCookiePrefix+StateCookie]
	if state == nil || state.Value != "state-1|"+base64.RawURLEncoding.EncodeToString([]byte("/reports?q=1")) || state.Path != "/" || state.Domain != "" ||
		state.MaxAge != 600 || !state.HttpOnly || !state.Secure || state.SameSite != http.SameSiteLaxMode {
		t.Fatalf("state cookie %+v", state)
	}
	if w := serve(server, uiRequest(http.MethodGet, "/ui/start/evil%2Fkey", nil)); w.Code != http.StatusNotFound {
		t.Fatalf("unknown method key: %d", w.Code)
	}

	// A callback this browser did not start is refused without asking Opfield.
	w = serve(server, uiRequest(http.MethodGet, "/ui/provider-callback?state=state-1&code=c", nil))
	if w.Code != http.StatusBadRequest || fake.finishRequest != nil || !strings.Contains(w.Body.String(), "Sign-in failed") {
		t.Fatalf("callback without state cookie: %d", w.Code)
	}
	if w := serve(server, uiRequest(http.MethodGet, "/ui/provider-callback?state=state-2&code=c", nil, state)); w.Code != http.StatusBadRequest || fake.finishRequest != nil {
		t.Fatalf("callback of another state: %d", w.Code)
	}
	// Over HTTPS a bare state cookie (one a sibling subdomain can set) does not start a sign-in.
	tossed := &http.Cookie{Name: StateCookie, Value: state.Value}
	if w := serve(server, uiRequest(http.MethodGet, "/ui/provider-callback?state=state-1&code=c", nil, tossed)); w.Code != http.StatusBadRequest || fake.finishRequest != nil {
		t.Fatalf("callback with a bare state cookie over https: %d", w.Code)
	}

	fake.finish = &pb.AccessSignInReply{Allowed: false, ErrorCode: "ACCESS_SIGN_IN_FAILED", Message: "This account cannot sign in here."}
	w = serve(server, uiRequest(http.MethodGet, "/ui/provider-callback?state=state-1&code=c", nil, state))
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "Sign-in failed") || !strings.Contains(w.Body.String(), "This account cannot sign in here.") {
		t.Fatalf("refused callback: %d", w.Code)
	}
	if cleared := responseCookies(w)[hostCookiePrefix+StateCookie]; cleared == nil || cleared.MaxAge >= 0 || cleared.Path != "/" {
		t.Fatalf("state cookie not cleared: %+v", cleared)
	}

	token := sign(testClaims("lena@acme.dev"))
	fake.finish = &pb.AccessSignInReply{Allowed: true, Token: token}
	// An old sign-in domain state cookie on / may come along.
	old := &http.Cookie{Name: StateCookie, Value: "nonce-1"}
	w = serve(server, uiRequest(http.MethodGet, "/ui/provider-callback?state=state-1&code=the-code", nil, old, state))
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/reports?q=1" || responseCookies(w)[hostCookiePrefix+TokenCookie].Value != token {
		t.Fatalf("callback %d %v", w.Code, w.Header())
	}
	if fake.finishRequest.GetState() != "state-1" || fake.finishRequest.GetCode() != "the-code" ||
		fake.finishRequest.GetCallbackUrl() != "https://app.example.com/_opfield/access/provider-callback" {
		t.Fatalf("finish request %+v", fake.finishRequest)
	}
}

func TestSignOut(t *testing.T) {
	server, _, sign := signInServer(t)
	csrf := responseCookies(serve(server, uiRequest(http.MethodGet, "/ui/sign-in", nil)))[hostCookiePrefix+CSRFCookie]
	refused := &http.Cookie{Name: hostCookiePrefix + TokenCookie, Value: sign(testClaims("lena@gmail.com"))}
	legacy := &http.Cookie{Name: TokenCookie, Value: refused.Value}
	w := serve(server, uiRequest(http.MethodPost, "/ui/sign-out", url.Values{"r": {"/reports"}, "csrf": {csrf.Value}}, csrf, refused, legacy))
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/_opfield/access/sign-in?r=%2Freports" {
		t.Fatalf("sign-out %d %v", w.Code, w.Header())
	}
	// The route's access cookie goes under both names.
	for _, name := range []string{hostCookiePrefix + TokenCookie, TokenCookie} {
		if cleared := responseCookies(w)[name]; cleared == nil || cleared.MaxAge >= 0 || cleared.Path != "/" || cleared.Domain != "" || !cleared.Secure {
			t.Fatalf("%s not cleared: %+v", name, cleared)
		}
	}
	// Without the cookie the sign-in page shows the methods again.
	if w := serve(server, uiRequest(http.MethodGet, "/ui/sign-in?r=%2Freports", nil, csrf)); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Sign in with Google") ||
		strings.Contains(w.Body.String(), "Use another account") {
		t.Fatalf("after sign-out: %d", w.Code)
	}
	if w := serve(server, uiRequest(http.MethodPost, "/ui/sign-out", url.Values{"csrf": {csrf.Value}})); len(w.Result().Cookies()) != 0 {
		t.Fatal("sign-out without the csrf cookie must not clear the access cookie")
	}
}

// Plain-HTTP routes keep the bare cookie names: the CSRF and state cookies on the sign-in page's path.
func TestSignInCookiesOverHTTP(t *testing.T) {
	server, fake, sign := signInServer(t)
	plain := func(r *http.Request) *http.Request {
		r.Header.Del(SchemeHeader)
		r.Header.Set(SchemeHeader, "http")
		return r
	}
	csrf := responseCookies(serve(server, plain(uiRequest(http.MethodGet, "/ui/sign-in", nil))))[CSRFCookie]
	if csrf == nil || csrf.Secure || csrf.Path != "/_opfield/access/" {
		t.Fatalf("csrf cookie over http %+v", csrf)
	}
	token := sign(testClaims("lena@acme.dev"))
	fake.password = &pb.AccessSignInReply{Allowed: true, Token: token}
	form := url.Values{"kind": {"password"}, "username": {"lena"}, "password": {"pw"}, "csrf": {csrf.Value}}
	w := serve(server, plain(uiRequest(http.MethodPost, "/ui/sign-in", form, csrf)))
	if access := responseCookies(w)[TokenCookie]; w.Code != http.StatusSeeOther || access == nil || access.Value != token || access.Secure || access.Path != "/" {
		t.Fatalf("access cookie over http: %d %+v", w.Code, access)
	}
	fake.start = &pb.AccessSignInStartReply{AuthorizeUrl: "https://accounts.google.com/o/oauth2/auth", State: "state-1"}
	w = serve(server, plain(uiRequest(http.MethodGet, "/ui/start/idp:g1", nil)))
	if state := responseCookies(w)[StateCookie]; state == nil || state.Secure || state.Path != "/_opfield/access/" ||
		fake.startRequest.GetCallbackUrl() != "http://app.example.com/_opfield/access/provider-callback" {
		t.Fatalf("state cookie over http %+v", state)
	}
	w = serve(server, plain(uiRequest(http.MethodPost, "/ui/sign-out", url.Values{"csrf": {csrf.Value}}, csrf)))
	if cleared := responseCookies(w)[TokenCookie]; cleared == nil || cleared.MaxAge >= 0 || len(w.Result().Cookies()) != 1 {
		t.Fatalf("sign-out over http: %+v", w.Result().Cookies())
	}
}

func TestSignInReturnPath(t *testing.T) {
	for value, want := range map[string]string{
		"/reports?q=1":                  "/reports?q=1",
		"":                              "/",
		"//evil.example":                "/",
		"https://evil.example/":         "/",
		"/_opfield/access/sign-in":      "/",
		"/%5Fopfield/access/sign-in":    "/",
		"/a/../_opfield/access/x":       "/",
		"/_opfield":                     "/",
		"/_opfieldish":                  "/_opfieldish",
		"/" + strings.Repeat("a", 4096): "/",
	} {
		if got := signInReturnPath(value); got != want {
			t.Errorf("%q: %q, want %q", value, got, want)
		}
	}
}
