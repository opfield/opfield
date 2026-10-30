package access

import (
	"crypto/rand"
	"crypto/subtle"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// The headers nginx adds to every request it sends the access socket.
const (
	ListHeader     = "X-Opfield-Access-List"
	HostHeader     = "X-Opfield-Access-Host"
	ClientIPHeader = "X-Opfield-Access-Client-Ip"
	URIHeader      = "X-Opfield-Access-Uri"
	SecureHeader   = "X-Opfield-Access-Secure"
	// SchemeHeader is the scheme of the visitor's request ($scheme), sent with the sign-in page's requests.
	SchemeHeader = "X-Opfield-Access-Scheme"
)

// The headers /check answers an allowed request with; nginx hands them to the upstream.
const (
	AssertionHeader = "X-Opfield-Access-Assertion"
	EmailHeader     = "X-Opfield-Access-Email"
	UserHeader      = "X-Opfield-Access-User"
)

// The cookies of the sign-in flow. Over HTTPS each one is named with the __Host- prefix (Secure, Path=/, no Domain),
// so a sibling subdomain cannot set or shadow it; plain-HTTP routes keep the bare names.
const (
	TokenCookie = "opfield_access"
	// StateCookie is the state of a provider sign-in the sign-in page started (<state>|<return path>), and the
	// nonce of a sign-in on a sign-in domain of older releases (bare name, on /).
	StateCookie = "opfield_access_state"
	// stateMaxAge is how long a sign-in may take.
	stateMaxAge = 600
	// hostCookiePrefix makes the browser refuse the cookie unless it is Secure, on / and without a Domain.
	hostCookiePrefix = "__Host-"
)

// flowCookieName is the name a cookie of the sign-in flow has on this request.
func flowCookieName(r *http.Request, name string) string {
	if secureRequest(r) {
		return hostCookiePrefix + name
	}
	return name
}

// flowCookiePath is the path of the sign-in page's own cookies (CSRF, provider state): __Host- cookies must be on /.
func flowCookiePath(r *http.Request) string {
	if secureRequest(r) {
		return "/"
	}
	return signInPrefix
}

// setFlowCookie sets (maxAge > 0, or 0 for a session cookie) or expires (maxAge < 0) a cookie of the sign-in flow under
// the name and with the attributes this request's scheme calls for.
func setFlowCookie(w http.ResponseWriter, r *http.Request, name, value, path string, maxAge int, sameSite http.SameSite) {
	http.SetCookie(w, &http.Cookie{
		Name:     flowCookieName(r, name),
		Value:    value,
		Path:     path,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   secureRequest(r),
		SameSite: sameSite,
	})
}

// setAccessCookie makes the token the route's access cookie. Over HTTPS a bare access cookie of an earlier release
// is expired, so only the __Host- one remains.
func setAccessCookie(w http.ResponseWriter, r *http.Request, token string, maxAge int) {
	setFlowCookie(w, r, TokenCookie, token, "/", maxAge, http.SameSiteLaxMode)
	if secureRequest(r) && hasCookie(r, TokenCookie) {
		http.SetCookie(w, &http.Cookie{Name: TokenCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode})
	}
}

// clearAccessCookies ends the visitor's sign-in on this route: the access cookie under both names.
func clearAccessCookies(w http.ResponseWriter, r *http.Request) {
	setFlowCookie(w, r, TokenCookie, "", "/", -1, http.SameSiteLaxMode)
	if secureRequest(r) {
		http.SetCookie(w, &http.Cookie{Name: TokenCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode})
	}
}

// accessTokens are the access cookies the request carries: the __Host- ones first, then bare ones (set over HTTP, or
// over HTTPS by an earlier release), so a bare cookie a sibling subdomain set never shadows the visitor's own.
func accessTokens(r *http.Request) []string {
	var prefixed, bare []string
	for _, cookie := range r.Cookies() {
		switch cookie.Name {
		case hostCookiePrefix + TokenCookie:
			prefixed = append(prefixed, cookie.Value)
		case TokenCookie:
			bare = append(bare, cookie.Value)
		}
	}
	return append(prefixed, bare...)
}

func hasCookie(r *http.Request, name string) bool {
	for _, cookie := range r.Cookies() {
		if cookie.Name == name {
			return true
		}
	}
	return false
}

// Server answers nginx's requests on the access socket.
type Server struct {
	store *Store
	basic *basicVerifier
	now   func() time.Time
	rand  io.Reader
	// signIn asks Opfield about the sign-in page's sign-ins; nil while the daemon has no control session.
	signIn atomic.Pointer[signInClient]
	warn   func(string, ...any)
}

// NewServer answers from the store's policy.
func NewServer(store *Store) *Server {
	return &Server{store: store, basic: newBasicVerifier(), now: time.Now, rand: rand.Reader, warn: func(string, ...any) {}}
}

// SetLogger reports sign-ins Opfield could not be asked about.
func (s *Server) SetLogger(logger interface{ Warn(string, ...any) }) {
	if logger != nil {
		s.warn = logger.Warn
	}
}

// Handler serves GET /check, /challenge and /callback for nginx, and the route's sign-in page under /ui/ (nginx
// proxies /_opfield/access/ of a protected route there).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/check", s.serveCheck)
	mux.HandleFunc("/challenge", s.serveChallenge)
	mux.HandleFunc("/callback", s.serveCallback)
	mux.HandleFunc("/ui/", s.serveSignInUI)
	return mux
}

// freshSignInSeconds is how long after a sign-in a refused cookie identity is denied instead of sent to sign in again.
const freshSignInSeconds = 60

// request is one request nginx asks about.
type request struct {
	policy   *Policy
	list     *List
	host     string
	client   netip.Addr
	identity *Identity
	source   Source
	// token is the access token the identity came from and issuedAt its iat (cookie identities).
	token    string
	issuedAt int64
	decision Decision
}

// evaluate decides the request nginx describes; nil when the list is unknown or no policy was synced (fail closed).
func (s *Server) evaluate(r *http.Request) *request {
	policy := s.store.Policy()
	list, ok := policy.List(r.Header.Get(ListHeader))
	if !ok {
		return nil
	}
	now := s.now()
	req := &request{policy: policy, list: list, host: NormalizeHost(r.Header.Get(HostHeader))}
	if client, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get(ClientIPHeader))); err == nil {
		req.client = client
	}
	// The identity the request presents, first found: a service token, basic authentication credentials, the access
	// token cookie.
	if identity := policy.serviceTokenIdentity(r, now); identity != nil {
		req.identity, req.source = identity, SourceServiceToken
	} else if hasMethod(list, MethodBasic) {
		if identity := s.basic.identity(list, r, now); identity != nil {
			req.identity, req.source = identity, SourceBasic
		}
	}
	if req.identity == nil {
		for _, token := range accessTokens(r) {
			if claims, err := policy.VerifyToken(token, req.host, now); err == nil {
				identity := claims.Identity
				req.identity, req.source, req.token, req.issuedAt = &identity, SourceCookie, token, claims.IssuedAt
				break
			}
		}
	}
	req.decision = Evaluate(list, req.client, req.identity, req.source)
	// The sign-in page let this visitor in moments ago, yet the list refuses them here (the two saw different client
	// addresses, say): another sign-in redirect would only come back here, so the answer is a deny.
	if req.decision == Redirect && req.source == SourceCookie && req.identity != nil && now.Unix()-req.issuedAt < freshSignInSeconds {
		req.decision = Deny
	}
	return req
}

func hasMethod(list *List, method string) bool {
	for _, candidate := range list.SignInMethods {
		if candidate == method {
			return true
		}
	}
	return false
}

// serveCheck is nginx's auth_request: 200 allow (with the identity for the upstream), 401 sign-in or basic
// authentication needed (nginx then asks /challenge), 403 deny, 503 no policy for the list.
func (s *Server) serveCheck(w http.ResponseWriter, r *http.Request) {
	req := s.evaluate(r)
	if req == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	switch req.decision {
	case Allow:
		if identity := req.identity; identity != nil {
			if req.source == SourceCookie {
				w.Header().Set(AssertionHeader, req.token)
			}
			if identity.Email != "" {
				w.Header().Set(EmailHeader, headerValue(identity.Email))
			}
			w.Header().Set(UserHeader, headerValue(displayName(identity)))
		}
		w.WriteHeader(http.StatusOK)
	case Basic, Redirect:
		w.WriteHeader(http.StatusUnauthorized)
	default:
		// A signed-in visitor the list turns away goes through the challenge to the sign-in page's denied view,
		// where they can use another account; nginx would show its own 403 page.
		if signedInIdentity(req) != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusForbidden)
	}
}

func displayName(identity *Identity) string {
	switch {
	case identity.Name != "":
		return identity.Name
	case identity.Email != "":
		return identity.Email
	default:
		return identity.Sub
	}
}

// headerValue keeps a claim from breaking the header it goes into.
func headerValue(value string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, value)
}

// serveChallenge is the visitor's answer after a 401 from /check: the redirect to the route's sign-in page, or the
// basic authentication challenge.
func (s *Server) serveChallenge(w http.ResponseWriter, r *http.Request) {
	req := s.evaluate(r)
	if req == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if signedInIdentity(req) != nil {
		// The sign-in page shows the denied view and never sends the visitor back here.
		w.Header().Set("Location", signInPagePath+"?"+deniedParam+"=1&r="+url.QueryEscape(signInReturnPath(r.Header.Get(URIHeader))))
		w.WriteHeader(http.StatusFound)
		return
	}
	switch req.decision {
	case Basic:
		w.Header().Set("WWW-Authenticate", `Basic realm="`+strings.ReplaceAll(req.host, `"`, "")+`", charset="UTF-8"`)
		w.WriteHeader(http.StatusUnauthorized)
	case Redirect:
		s.redirectToSignIn(w, r, req)
	case Allow:
		// Allowed meanwhile (a cookie set by another tab): the visitor asks again.
		http.Redirect(w, r, safeReturnPath(r.Header.Get(URIHeader)), http.StatusFound)
	default:
		w.WriteHeader(http.StatusForbidden)
	}
}

// redirectToSignIn sends the visitor to the route's own sign-in page, on the same host, with the page they asked for.
func (s *Server) redirectToSignIn(w http.ResponseWriter, r *http.Request, req *request) {
	if req.host == "" {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Location", signInPagePath+"?r="+url.QueryEscape(signInReturnPath(r.Header.Get(URIHeader))))
	w.WriteHeader(http.StatusFound)
}

// serveCallback takes the token the sign-in page issued for this host: valid and carrying the nonce of the visitor's
// state cookie, it becomes the access cookie and the visitor goes back to the page they asked for.
func (s *Server) serveCallback(w http.ResponseWriter, r *http.Request) {
	// The callback URL carries the token: never cached, never sent on as a referrer.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	policy := s.store.Policy()
	if policy == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	query := r.URL.Query()
	token := query.Get("t")
	now := s.now()
	claims, err := policy.VerifyToken(token, r.Header.Get(HostHeader), now)
	if err != nil {
		http.Error(w, "The sign-in link is not valid. Open the page again to sign in.", http.StatusBadRequest)
		return
	}
	if claims.Nonce == "" || !hasCookieValue(r, StateCookie, claims.Nonce) {
		http.Error(w, "The sign-in link is not for this browser. Open the page again to sign in.", http.StatusBadRequest)
		return
	}
	setAccessCookie(w, r, token, int(max(claims.ExpiresAt-now.Unix(), 1)))
	// The nonce cookie of older releases has the bare name on /.
	http.SetCookie(w, &http.Cookie{Name: StateCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: secureRequest(r), SameSite: http.SameSiteLaxMode})
	w.Header().Set("Location", safeReturnPath(query.Get("r")))
	w.WriteHeader(http.StatusFound)
}

// hasCookieValue reports whether the request carries the cookie with this value (a browser sends a cookie of each
// path it was set for).
func hasCookieValue(r *http.Request, name, value string) bool {
	for _, cookie := range r.Cookies() {
		if cookie.Name == name && subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(value)) == 1 {
			return true
		}
	}
	return false
}

func secureRequest(r *http.Request) bool {
	return r.Header.Get(SecureHeader) == "on" || strings.EqualFold(r.Header.Get(SchemeHeader), "https")
}

// maxReturnPathLength bounds the page a visitor returns to, as the sign-in page does.
const maxReturnPathLength = 4096

// safeReturnPath keeps a return target on the same host: a path starting with one slash, else "/".
func safeReturnPath(value string) string {
	if !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.HasPrefix(value, "/\\") ||
		strings.ContainsAny(value, "\r\n\t\\") || len(value) > maxReturnPathLength {
		return "/"
	}
	return value
}
