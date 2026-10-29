package access

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// The headers nginx adds to every request it sends the access socket.
const (
	ListHeader     = "X-Opfield-Access-List"
	HostHeader     = "X-Opfield-Access-Host"
	ClientIPHeader = "X-Opfield-Access-Client-Ip"
	URIHeader      = "X-Opfield-Access-Uri"
	SecureHeader   = "X-Opfield-Access-Secure"
)

// The headers /check answers an allowed request with; nginx hands them to the upstream.
const (
	AssertionHeader = "X-Opfield-Access-Assertion"
	EmailHeader     = "X-Opfield-Access-Email"
	UserHeader      = "X-Opfield-Access-User"
)

// The cookies of the sign-in flow.
const (
	TokenCookie = "opfield_access"
	StateCookie = "opfield_access_state"
	// stateMaxAge is how long a sign-in may take.
	stateMaxAge = 600
)

// Server answers nginx's requests on the access socket.
type Server struct {
	store *Store
	basic *basicVerifier
	now   func() time.Time
	rand  io.Reader
}

// NewServer answers from the store's policy.
func NewServer(store *Store) *Server {
	return &Server{store: store, basic: newBasicVerifier(), now: time.Now, rand: rand.Reader}
}

// Handler serves GET /check, /challenge and /callback.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/check", s.serveCheck)
	mux.HandleFunc("/challenge", s.serveChallenge)
	mux.HandleFunc("/callback", s.serveCallback)
	return mux
}

// request is one request nginx asks about.
type request struct {
	policy   *Policy
	list     *List
	host     string
	client   netip.Addr
	identity *Identity
	source   Source
	// token is the access token the identity came from (cookie identities).
	token    string
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
		for _, cookie := range r.Cookies() {
			if cookie.Name != TokenCookie {
				continue
			}
			if claims, err := policy.VerifyToken(cookie.Value, req.host, now); err == nil {
				identity := claims.Identity
				req.identity, req.source, req.token = &identity, SourceCookie, cookie.Value
				break
			}
		}
	}
	req.decision = Evaluate(list, req.client, req.identity, req.source)
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

// serveChallenge is the visitor's answer after a 401 from /check: the sign-in redirect with the state cookie, or the
// basic authentication challenge.
func (s *Server) serveChallenge(w http.ResponseWriter, r *http.Request) {
	req := s.evaluate(r)
	if req == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
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

func (s *Server) redirectToSignIn(w http.ResponseWriter, r *http.Request, req *request) {
	if req.policy.SignInOrigin == "" || req.host == "" {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	nonce := make([]byte, 32)
	if _, err := io.ReadFull(s.rand, nonce); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	state := base64.RawURLEncoding.EncodeToString(nonce)
	http.SetCookie(w, &http.Cookie{
		Name:     StateCookie,
		Value:    state,
		Path:     "/",
		MaxAge:   stateMaxAge,
		HttpOnly: true,
		Secure:   secureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})
	location := req.policy.SignInOrigin + "/access/sign-in?list=" + url.QueryEscape(req.list.ID) +
		"&host=" + url.QueryEscape(req.host) + "&n=" + url.QueryEscape(state) +
		"&r=" + url.QueryEscape(safeReturnPath(r.Header.Get(URIHeader)))
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusFound)
}

// serveCallback takes the token the sign-in page issued for this host: valid and carrying the nonce of the visitor's
// state cookie, it becomes the access cookie and the visitor goes back to the page they asked for.
func (s *Server) serveCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
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
	state, err := r.Cookie(StateCookie)
	if err != nil || claims.Nonce == "" || subtle.ConstantTimeCompare([]byte(state.Value), []byte(claims.Nonce)) != 1 {
		http.Error(w, "The sign-in link is not for this browser. Open the page again to sign in.", http.StatusBadRequest)
		return
	}
	secure := secureRequest(r)
	http.SetCookie(w, &http.Cookie{
		Name:     TokenCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   int(max(claims.ExpiresAt-now.Unix(), 1)),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{Name: StateCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
	w.Header().Set("Location", safeReturnPath(query.Get("r")))
	w.WriteHeader(http.StatusFound)
}

func secureRequest(r *http.Request) bool {
	return r.Header.Get(SecureHeader) == "on"
}

// safeReturnPath keeps a return target on the same host: a path starting with one slash, else "/".
func safeReturnPath(value string) string {
	if !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.HasPrefix(value, "/\\") ||
		strings.ContainsAny(value, "\r\n\t\\") || len(value) > 8192 {
		return "/"
	}
	return value
}
