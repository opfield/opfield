package access

import (
	"bytes"
	"context"
	_ "embed"
	"html/template"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// The sign-in page: one template with its CSS and JS inline (the page loads nothing else), styled like Opfield's own
// sign-in. Without JS every step is a plain form or link (?step=password); with it the steps switch in place.
var (
	//go:embed signin_page.html
	signInPageHTML string
	//go:embed signin_page.css
	signInPageCSS string
	//go:embed signin_page.js
	signInPageJS string

	signInPageTemplate = template.Must(template.New("sign-in").Funcs(template.FuncMap{
		"css": func() template.CSS { return template.CSS(signInPageCSS) },
		"js":  func() template.JS { return template.JS(signInPageJS) },
	}).Parse(signInPageHTML))
)

// The steps of the page.
const (
	stepMethods  = "methods"
	stepPassword = MethodPassword
	stepShared   = MethodShared
	stepDenied   = "denied"
	stepNotice   = "notice"
)

// SignInPage is what the page shows.
type SignInPage struct {
	// Nonce allows the inline style and script (Content-Security-Policy).
	Nonce string
	// Host is the protected route's host: the page's title.
	Host string
	// Step is the step shown first: methods, password, shared, denied or notice.
	Step string
	// Methods are the list's methods in its order; the first is the primary button.
	Methods []SignInMethod
	// Error is shown in a toast; Failed (a provider sign-in) titles it "Sign-in failed".
	Error  string
	Failed bool
	// Username is kept after a failed username sign-in.
	Username string
	CSRF     string
	// Return is the page the visitor goes back to (r).
	Return string
	// Account is who a signed-in visitor without access is (step denied).
	Account string
	// Subtitle and Notice are the text of step notice (Notice may be empty when Error says it).
	Subtitle string
	Notice   string
}

// SignInMethod is one button of the methods step: key opfield, password, shared or idp:<id>, and its label.
type SignInMethod struct {
	Key   string
	Kind  string
	Label string
}

// pageMethod is a method as the template renders it.
type pageMethod struct {
	Label   string
	Icon    string
	Href    string
	Step    string
	Primary bool
}

type pageView struct {
	SignInPage
	Subtitle    string
	Buttons     []pageMethod
	HasPassword bool
	HasShared   bool
	// Other: the form steps offer a way back to the methods.
	Other    bool
	Action   string
	SignOut  string
	BackHref string
	// The error toast (Opfield's sonner toast): the error, or "Sign-in failed" with the error below it.
	ToastTitle       string
	ToastDescription string
}

func (p SignInPage) has(kind string) bool {
	for _, method := range p.Methods {
		if method.Kind == kind {
			return true
		}
	}
	return false
}

// RenderSignInPage renders the page.
func RenderSignInPage(page SignInPage) ([]byte, error) {
	returnQuery := "r=" + url.QueryEscape(page.Return)
	view := pageView{
		SignInPage:  page,
		HasPassword: page.has(MethodPassword),
		HasShared:   page.has(MethodShared),
		Other:       len(page.Methods) > 1,
		Action:      signInPagePath,
		SignOut:     signOutPath,
		BackHref:    signInPagePath + "?" + returnQuery,
	}
	for index, method := range page.Methods {
		button := pageMethod{Label: "Sign in with " + method.Label, Icon: "login", Primary: index == 0}
		switch method.Kind {
		case MethodOpfield:
			button.Icon = "opfield"
			button.Href = startPathPrefix + MethodOpfield + "?" + returnQuery
		case MethodPassword:
			button.Label, button.Icon, button.Step = "Sign in with username", "user", stepPassword
			button.Href = signInPagePath + "?step=" + stepPassword + "&" + returnQuery
		case MethodShared:
			button.Label, button.Icon, button.Step = "Enter shared password", "key", stepShared
			button.Href = signInPagePath + "?step=" + stepShared + "&" + returnQuery
		default:
			button.Href = startPathPrefix + url.PathEscape(method.Key) + "?" + returnQuery
		}
		view.Buttons = append(view.Buttons, button)
	}
	if page.Error != "" {
		view.ToastTitle = page.Error
		if page.Failed {
			view.ToastTitle, view.ToastDescription = "Sign-in failed", page.Error
		}
	}
	view.Subtitle = stepSubtitle(view.Step, page.Subtitle)
	var out bytes.Buffer
	if err := signInPageTemplate.Execute(&out, view); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func stepSubtitle(step, notice string) string {
	switch step {
	case stepShared:
		return "Enter the password to continue"
	case stepDenied:
		return "You don't have access to this site"
	case stepNotice:
		return notice
	default:
		return "Sign in to continue"
	}
}

// pageState is what a page shown after an action says.
type pageState struct {
	step     string
	message  string
	failed   bool
	username string
}

// methodKeyReply is a method key Opfield may answer with.
var methodKeyReply = regexp.MustCompile(`^(opfield|password|shared|idp:[A-Za-z0-9._-]{1,128})$`)

// renderMethods asks Opfield for the list's methods and shows the methods step or the form step state names.
func (s *Server) renderMethods(w http.ResponseWriter, r *http.Request, host, returnTo string, state pageState, status int) {
	client := s.signInClient()
	if client == nil {
		s.renderUnavailable(w, r, host, http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), signInTimeout)
	defer cancel()
	reply, err := client.Context(ctx, &pb.AccessSignInContextRequest{Target: signInTarget(r, host)})
	if err != nil {
		message, code := callFailure(err)
		if code == http.StatusTooManyRequests {
			s.writePage(w, r, SignInPage{Host: host, Step: stepNotice, Subtitle: "Too many sign-in attempts", Error: message}, code)
			return
		}
		s.warn("access sign-in methods could not be read from Opfield", "host", host, "error", err)
		s.renderUnavailable(w, r, host, code)
		return
	}
	var methods []SignInMethod
	for _, method := range reply.GetMethods() {
		label := strings.TrimSpace(headerValue(method.GetLabel()))
		if !methodKeyReply.MatchString(method.GetKey()) || label == "" || len(label) > 100 {
			continue
		}
		kind := method.GetKind()
		switch {
		case method.GetKey() == MethodOpfield, method.GetKey() == MethodPassword, method.GetKey() == MethodShared:
			kind = method.GetKey()
		case strings.HasPrefix(method.GetKey(), methodIdPPrefix):
			kind = "idp"
		}
		methods = append(methods, SignInMethod{Key: method.GetKey(), Kind: kind, Label: label})
	}
	if len(methods) == 0 {
		s.renderNotice(w, r, host, "You don't have access to this site", messageNoMethods, http.StatusForbidden)
		return
	}
	page := SignInPage{Host: host, Methods: methods, Return: returnTo, Username: state.username, Error: state.message, Failed: state.failed}
	page.Step = stepMethods
	if (state.step == stepPassword || state.step == stepShared) && page.has(state.step) {
		page.Step = state.step
	} else if len(methods) == 1 && (methods[0].Kind == MethodPassword || methods[0].Kind == MethodShared) {
		// A list with only a form opens it right away.
		page.Step = methods[0].Kind
	}
	s.writePage(w, r, page, status)
}

// renderDenied tells a signed-in visitor the list does not let them in, and offers another account.
func (s *Server) renderDenied(w http.ResponseWriter, r *http.Request, host, returnTo string, identity *Identity) {
	account := identity.Email
	if account == "" {
		account = displayName(identity)
	}
	s.writePage(w, r, SignInPage{Host: host, Step: stepDenied, Return: returnTo, Account: headerValue(account)}, http.StatusForbidden)
}

func (s *Server) renderNotice(w http.ResponseWriter, r *http.Request, host, subtitle, notice string, status int) {
	s.writePage(w, r, SignInPage{Host: host, Step: stepNotice, Subtitle: subtitle, Notice: notice}, status)
}

// renderUnavailable says sign-in cannot be done now (no policy, no control session, Opfield unreachable).
func (s *Server) renderUnavailable(w http.ResponseWriter, r *http.Request, host string, status int) {
	if host == "" {
		host = NormalizeHost(r.Header.Get(HostHeader))
	}
	if host == "" {
		host = "Sign in"
	}
	s.writePage(w, r, SignInPage{Host: host, Step: stepNotice, Subtitle: "Sign-in is unavailable", Error: messageUnavailable}, status)
}

func (s *Server) writePage(w http.ResponseWriter, r *http.Request, page SignInPage, status int) {
	nonce, err := s.randomToken(16)
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	page.Nonce = nonce
	if page.Step != stepNotice {
		if page.CSRF, err = s.ensureCSRF(w, r); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
	}
	body, err := RenderSignInPage(page)
	if err != nil {
		s.warn("access sign-in page could not be rendered", "error", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	header := w.Header()
	header.Set("Content-Type", "text/html; charset=utf-8")
	header.Set("Content-Security-Policy", "default-src 'none'; style-src 'nonce-"+nonce+"'; script-src 'nonce-"+nonce+"'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
