package access

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// The route's sign-in page: nginx proxies /_opfield/access/ of a protected route to /ui/ of the access socket, and the
// daemon asks Opfield over its control channel (AccessSignIn). The visitor never reaches Opfield.
const (
	signInPrefix         = "/_opfield/access/"
	signInPagePath       = signInPrefix + "sign-in"
	signOutPath          = signInPrefix + "sign-out"
	startPathPrefix      = signInPrefix + "start/"
	providerCallbackPath = signInPrefix + "provider-callback"
	// CSRFCookie pairs with the hidden field of the page's forms (__Host- on / over HTTPS, see flowCookieName).
	CSRFCookie = "opfield_access_csrf"
	// signInTimeout bounds one question to Opfield; the socket's write timeout is longer.
	signInTimeout = 8 * time.Second
	maxFormBytes  = 16 << 10
	// maxStateCookieLength keeps the state cookie within what every browser stores.
	maxStateCookieLength = 3800
)

// The messages the page shows when Opfield cannot be asked or does not say why.
const (
	messageUnavailable      = "Sign-in is unavailable right now. Try again in a moment."
	messageSignInFailed     = "Sign-in did not complete. Try again or choose another sign-in method."
	messageWrongCredentials = "The username or password is not correct."
	messageWrongShared      = "The password is not correct."
	messageExpired          = "This page expired. Try again."
	messageOtherBrowser     = "This sign-in did not start in this browser. Try again."
	messageNoMethods        = "This site does not sign visitors in here."
)

// signInClient wraps the client so it can be swapped atomically.
type signInClient struct{ pb.AccessSignInClient }

// SetSignInClient gives the sign-in page the client of the daemon's control channel; nil while there is none.
func (s *Server) SetSignInClient(client pb.AccessSignInClient) {
	if client == nil {
		s.signIn.Store(nil)
		return
	}
	s.signIn.Store(&signInClient{client})
}

func (s *Server) signInClient() pb.AccessSignInClient {
	if client := s.signIn.Load(); client != nil {
		return client.AccessSignInClient
	}
	return nil
}

// serveSignInUI serves the sign-in page and its actions.
func (s *Server) serveSignInUI(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	header.Set("Cache-Control", "no-store")
	// The provider callback's URL carries the authorization code.
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
	get := r.Method == http.MethodGet || r.Method == http.MethodHead
	switch rest := strings.TrimPrefix(r.URL.Path, "/ui/"); {
	case rest == "sign-in" && get:
		s.serveSignInPage(w, r)
	case rest == "sign-in" && r.Method == http.MethodPost:
		s.servePasswordSignIn(w, r)
	case strings.HasPrefix(rest, "start/") && get:
		s.serveStartProvider(w, r, strings.TrimPrefix(rest, "start/"))
	case rest == "provider-callback" && get:
		s.serveProviderCallback(w, r)
	case rest == "sign-out" && r.Method == http.MethodPost:
		s.serveSignOut(w, r)
	case rest == "callback" && get:
		// Tokens of sign-ins started on a sign-in domain of older releases.
		s.serveCallback(w, r)
	case rest == "sign-in" || rest == "provider-callback" || rest == "sign-out" || rest == "callback" || strings.HasPrefix(rest, "start/"):
		w.WriteHeader(http.StatusMethodNotAllowed)
	default:
		http.NotFound(w, r)
	}
}

// signInReturnPath is the page a visitor goes back to after signing in: a path on this host, never one of Opfield's
// own paths (the sign-in page would only send them back here).
func signInReturnPath(value string) string {
	value = safeReturnPath(value)
	clean, _, _ := strings.Cut(value, "?")
	if unescaped, err := url.PathUnescape(clean); err == nil {
		clean = unescaped
	}
	clean = path.Clean(clean)
	if clean == "/_opfield" || strings.HasPrefix(clean, "/_opfield/") {
		return "/"
	}
	return value
}

// signInTarget is the protected route and the visitor nginx describes.
func signInTarget(r *http.Request, host string) *pb.AccessSignInTarget {
	userAgent := r.UserAgent()
	if len(userAgent) > 512 {
		userAgent = userAgent[:512]
	}
	return &pb.AccessSignInTarget{
		ListId:    r.Header.Get(ListHeader),
		Host:      host,
		ClientIp:  strings.TrimSpace(r.Header.Get(ClientIPHeader)),
		UserAgent: userAgent,
	}
}

// providerCallbackURL is where a provider sends the visitor back: the route's own provider callback.
func providerCallbackURL(r *http.Request, host string) string {
	scheme := "http"
	if secureRequest(r) {
		scheme = "https"
	}
	return scheme + "://" + host + providerCallbackPath
}

// serveSignInPage shows the sign-in methods of the list, or a form step (?step=password, ?step=shared).
func (s *Server) serveSignInPage(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	returnTo := signInReturnPath(query.Get("r"))
	req := s.evaluate(r)
	if req == nil || req.host == "" {
		s.renderUnavailable(w, r, "", http.StatusServiceUnavailable)
		return
	}
	// A visitor the list lets in, or one it asks for basic authentication, goes back to the page.
	if req.decision == Allow || req.decision == Basic {
		redirectSeeOther(w, returnTo)
		return
	}
	if signedIn := signedInIdentity(req); signedIn != nil {
		s.renderDenied(w, r, req.host, returnTo, signedIn)
		return
	}
	if req.decision == Deny {
		s.renderNotice(w, r, req.host, "You don't have access to this site", "Ask the owner of "+req.host+" to let you in.", http.StatusForbidden)
		return
	}
	s.renderMethods(w, r, req.host, returnTo, pageState{step: query.Get("step")}, http.StatusOK)
}

// signedInIdentity is the identity of the visitor's access cookie when the list accepts its sign-in method but its
// rules turn the visitor away; nil when the visitor should simply sign in.
func signedInIdentity(req *request) *Identity {
	if req.decision == Allow || req.source != SourceCookie || req.identity == nil || !req.list.usable(req.identity) {
		return nil
	}
	return req.identity
}

// servePasswordSignIn checks the username and password form or the shared password form.
func (s *Server) servePasswordSignIn(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	returnTo := signInReturnPath(r.PostForm.Get("r"))
	kind := r.PostForm.Get("kind")
	if kind != MethodPassword && kind != MethodShared {
		kind = ""
	}
	username := r.PostForm.Get("username")
	if kind != MethodPassword || len(username) > 256 {
		username = ""
	}
	password := r.PostForm.Get("password")
	req := s.evaluate(r)
	if req == nil || req.host == "" {
		s.renderUnavailable(w, r, "", http.StatusServiceUnavailable)
		return
	}
	state := pageState{step: kind, username: username}
	if !validCSRF(r) {
		state.message = messageExpired
		s.renderMethods(w, r, req.host, returnTo, state, http.StatusForbidden)
		return
	}
	if kind == "" || password == "" || len(password) > 1024 || (kind == MethodPassword && strings.TrimSpace(username) == "") {
		state.message = "Enter the username and password."
		if kind == MethodShared {
			state.message = "Enter the password."
		}
		s.renderMethods(w, r, req.host, returnTo, state, http.StatusBadRequest)
		return
	}
	client := s.signInClient()
	if client == nil {
		state.message = messageUnavailable
		s.renderMethods(w, r, req.host, returnTo, state, http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), signInTimeout)
	defer cancel()
	reply, err := client.Password(ctx, &pb.AccessSignInPasswordRequest{Target: signInTarget(r, req.host), Kind: kind, Username: username, Password: password})
	if err != nil {
		s.warn("access sign-in could not be checked with Opfield", "host", req.host, "error", err)
		state.message = messageUnavailable
		s.renderMethods(w, r, req.host, returnTo, state, http.StatusBadGateway)
		return
	}
	if reply.GetAllowed() && s.finishSignIn(w, r, req.host, reply.GetToken(), returnTo) {
		return
	}
	state.message = replyMessage(reply.GetMessage(), messageWrongCredentials)
	if kind == MethodShared && reply.GetMessage() == "" {
		state.message = messageWrongShared
	}
	s.renderMethods(w, r, req.host, returnTo, state, replyStatus(reply.GetAllowed(), reply.GetErrorCode()))
}

// methodKeyPattern is a method key a start link may carry.
var methodKeyPattern = regexp.MustCompile(`^(opfield|idp:[A-Za-z0-9._-]{1,128})$`)

// serveStartProvider starts an Opfield or identity provider sign-in: the state goes into a short-lived cookie (on the
// sign-in page's path over HTTP, __Host- on / over HTTPS), and the visitor to the provider.
func (s *Server) serveStartProvider(w http.ResponseWriter, r *http.Request, key string) {
	returnTo := signInReturnPath(r.URL.Query().Get("r"))
	req := s.evaluate(r)
	if req == nil || req.host == "" {
		s.renderUnavailable(w, r, "", http.StatusServiceUnavailable)
		return
	}
	if !methodKeyPattern.MatchString(key) {
		s.renderMethods(w, r, req.host, returnTo, pageState{failed: true, message: messageSignInFailed}, http.StatusNotFound)
		return
	}
	client := s.signInClient()
	if client == nil {
		s.renderMethods(w, r, req.host, returnTo, pageState{failed: true, message: messageUnavailable}, http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), signInTimeout)
	defer cancel()
	reply, err := client.StartProvider(ctx, &pb.AccessSignInStartRequest{Target: signInTarget(r, req.host), MethodKey: key, CallbackUrl: providerCallbackURL(r, req.host)})
	if err != nil {
		s.warn("access sign-in could not be started with Opfield", "host", req.host, "error", err)
		s.renderMethods(w, r, req.host, returnTo, pageState{failed: true, message: messageUnavailable}, http.StatusBadGateway)
		return
	}
	if reply.GetErrorCode() != "" || !validState(reply.GetState()) || !validAuthorizeURL(reply.GetAuthorizeUrl()) {
		if reply.GetErrorCode() == "" {
			s.warn("Opfield started an access sign-in without a usable state or authorization URL", "host", req.host)
		}
		s.renderMethods(w, r, req.host, returnTo, pageState{failed: true, message: replyMessage(reply.GetMessage(), messageSignInFailed)}, replyStatus(false, reply.GetErrorCode()))
		return
	}
	value := reply.GetState() + "|" + base64.RawURLEncoding.EncodeToString([]byte(returnTo))
	if len(value) > maxStateCookieLength {
		// A page too long to keep: the visitor returns to the start page.
		value = reply.GetState() + "|" + base64.RawURLEncoding.EncodeToString([]byte("/"))
	}
	setFlowCookie(w, r, StateCookie, value, flowCookiePath(r), stateMaxAge, http.SameSiteLaxMode)
	w.Header().Set("Location", reply.GetAuthorizeUrl())
	w.WriteHeader(http.StatusFound)
}

// validState accepts an opaque state that fits a cookie as is.
func validState(state string) bool {
	if state == "" || len(state) > 512 {
		return false
	}
	for _, c := range state {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~') {
			return false
		}
	}
	return true
}

func validAuthorizeURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.Host != "" && parsed.User == nil &&
		!strings.ContainsAny(value, "\r\n")
}

// startedSignIn finds the state cookie of the sign-in this callback finishes and the page to return to.
func startedSignIn(r *http.Request, state string) (string, bool) {
	if !validState(state) {
		return "", false
	}
	name := flowCookieName(r, StateCookie)
	for _, cookie := range r.Cookies() {
		if cookie.Name != name {
			continue
		}
		cookieState, encoded, ok := strings.Cut(cookie.Value, "|")
		if !ok || subtle.ConstantTimeCompare([]byte(cookieState), []byte(state)) != 1 {
			continue
		}
		returnTo, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			return "/", true
		}
		return signInReturnPath(string(returnTo)), true
	}
	return "", false
}

// serveProviderCallback finishes a provider sign-in this browser started.
func (s *Server) serveProviderCallback(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	req := s.evaluate(r)
	if req == nil || req.host == "" {
		s.renderUnavailable(w, r, "", http.StatusServiceUnavailable)
		return
	}
	state := query.Get("state")
	returnTo, started := startedSignIn(r, state)
	if !started {
		s.renderMethods(w, r, req.host, "/", pageState{failed: true, message: messageOtherBrowser}, http.StatusBadRequest)
		return
	}
	setFlowCookie(w, r, StateCookie, "", flowCookiePath(r), -1, http.SameSiteLaxMode)
	client := s.signInClient()
	if client == nil {
		s.renderMethods(w, r, req.host, returnTo, pageState{failed: true, message: messageUnavailable}, http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), signInTimeout)
	defer cancel()
	reply, err := client.FinishProvider(ctx, &pb.AccessSignInFinishRequest{
		Target:      signInTarget(r, req.host),
		State:       state,
		Code:        limit(query.Get("code"), 4096),
		Error:       limit(query.Get("error"), 256),
		CallbackUrl: providerCallbackURL(r, req.host),
	})
	if err != nil {
		s.warn("access sign-in could not be finished with Opfield", "host", req.host, "error", err)
		s.renderMethods(w, r, req.host, returnTo, pageState{failed: true, message: messageUnavailable}, http.StatusBadGateway)
		return
	}
	if reply.GetAllowed() && s.finishSignIn(w, r, req.host, reply.GetToken(), returnTo) {
		return
	}
	s.renderMethods(w, r, req.host, returnTo, pageState{failed: true, message: replyMessage(reply.GetMessage(), messageSignInFailed)}, replyStatus(reply.GetAllowed(), reply.GetErrorCode()))
}

// serveSignOut ends the visitor's sign-in on this route ("Use another account"): the route's access cookie is expired
// under both names, and the sign-in page then shows the methods.
func (s *Server) serveSignOut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	returnTo := signInReturnPath(r.PostForm.Get("r"))
	if validCSRF(r) {
		clearAccessCookies(w, r)
	}
	redirectSeeOther(w, signInPagePath+"?r="+url.QueryEscape(returnTo))
}

// finishSignIn turns the token Opfield issued into the route's access cookie, as /callback does, and sends the
// visitor back; false when the token is not one this node accepts for the host.
func (s *Server) finishSignIn(w http.ResponseWriter, r *http.Request, host, token, returnTo string) bool {
	now := s.now()
	claims, err := s.store.Policy().VerifyToken(token, host, now)
	if err != nil {
		s.warn("Opfield signed a visitor in with a token this node does not accept", "host", host, "error", err)
		return false
	}
	setAccessCookie(w, r, token, int(max(claims.ExpiresAt-now.Unix(), 1)))
	redirectSeeOther(w, returnTo)
	return true
}

func redirectSeeOther(w http.ResponseWriter, location string) {
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusSeeOther)
}

// replyMessage is Opfield's sentence for the page, or the fallback.
func replyMessage(message, fallback string) string {
	message = strings.TrimSpace(headerValue(message))
	if message == "" || len(message) > 300 {
		return fallback
	}
	return message
}

// replyStatus is the status of a page that shows a refused sign-in.
func replyStatus(allowed bool, code string) int {
	switch {
	case allowed:
		// Allowed with a token this node does not accept.
		return http.StatusBadGateway
	case code == "ACCESS_RATE_LIMITED":
		return http.StatusTooManyRequests
	case code == "ACCESS_DENIED":
		return http.StatusForbidden
	default:
		return http.StatusUnauthorized
	}
}

func limit(value string, length int) string {
	if len(value) > length {
		return value[:length]
	}
	return value
}

// csrfPattern is a token ensureCSRF issues.
var csrfPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// ensureCSRF returns the visitor's CSRF token, issuing one when the request has none.
func (s *Server) ensureCSRF(w http.ResponseWriter, r *http.Request) (string, error) {
	name := flowCookieName(r, CSRFCookie)
	for _, cookie := range r.Cookies() {
		if cookie.Name == name && csrfPattern.MatchString(cookie.Value) {
			return cookie.Value, nil
		}
	}
	token, err := s.randomToken(32)
	if err != nil {
		return "", err
	}
	setFlowCookie(w, r, CSRFCookie, token, flowCookiePath(r), 0, http.SameSiteStrictMode)
	return token, nil
}

// validCSRF reports whether the form's token is the visitor's cookie.
func validCSRF(r *http.Request) bool {
	token := r.PostForm.Get("csrf")
	return csrfPattern.MatchString(token) && hasCookieValue(r, flowCookieName(r, CSRFCookie), token)
}

func (s *Server) randomToken(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := io.ReadFull(s.rand, buffer); err != nil {
		return "", errors.New("no randomness for the sign-in page")
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}
