// Package errorpages holds the Opfield pages nginx answers with when nginx itself ends a request (a denied client, a
// missing page, an upstream it cannot reach, a request it refuses), so a visitor never sees nginx's own plain pages.
//
// The pages live once per node, in an http-level file of variables (Config, written by the daemon). Each server Opfield
// renders hands the codes to one named location that answers with the variable for the response status:
//
//	error_page 400 401 403 ... @opfield_error;
//	location @opfield_error { default_type text/html; return 200 $opfield_error_page; }
//
// `return 200` there keeps the status of the error: nginx sends a response that error_page produced with the
// original code unless error_page names another (`=code`). nginx answers 494-497 with 400; their pages say what went
// wrong, so each has a named location and variable of its own.
//
// 400, 414 and 505 can end a request whose request line nginx could not read (505: ngx_http_process_request_line
// finalizes an unsupported HTTP version before it processes the URI), which has no URI; nginx cannot hand such a
// request to a named location (it answers 500), so these go to an internal location with a reserved path
// (RequestLinePath) instead. A request for that path from outside gets the 404 page.
//
// The locations allow every client and ask for no password: a client the server's own access rules deny gets the 403
// page, not nginx's plain one.
//
// error_page applies only to responses nginx generates. A proxied application's own error responses pass through
// unchanged because proxy_intercept_errors stays off.
package errorpages

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// The console palette (packages/backend/src/lib/brand-palette.ts): paper in light, graphite in dark.
const (
	paperPage     = "#f3f2ef"
	paperInk      = "#141414"
	paperStone    = "#64635f"
	graphitePage  = "#141414"
	graphiteInk   = "#f3f2ef"
	graphiteStone = "#8f8e89"
)

// PageColorVariables are the colours of every static Opfield page, light and dark.
const PageColorVariables = ":root{--page:" + paperPage + ";--ink:" + paperInk + ";--stone:" + paperStone + "}@media(prefers-color-scheme:dark){:root{--page:" + graphitePage + ";--ink:" + graphiteInk + ";--stone:" + graphiteStone + "}}"

const brandingFooter = `<div class="footer">Powered by <a href="https://opfield.dev" rel="noopener noreferrer">Opfield</a></div>`

// Page is one error page: the code nginx ends the request with and what the visitor reads.
type Page struct {
	Code    int
	Heading string
	Message string
}

// Pages are the codes the routes hand to the Opfield pages. Kept in step with OPFIELD_ERROR_PAGE_CODES and
// OPFIELD_SPECIAL_ERROR_PAGE_CODES in packages/backend/src/modules/proxy/nginx-error-pages.ts.
var Pages = []Page{
	{400, "Bad request", "The server could not understand this request."},
	{401, "Sign-in required", "This page needs a valid sign-in. Check the credentials and try again."},
	{403, "Access denied", "You do not have permission to open this page."},
	{404, "Page not found", "The requested host or page is not available."},
	{405, "Method not allowed", "This page does not accept the request method that was used."},
	{408, "Request timed out", "The request took too long to arrive. Please try again."},
	{413, "Request too large", "The request is larger than this page accepts."},
	{414, "Address too long", "The requested address is longer than the server accepts."},
	{429, "Too many requests", "Too many requests were sent in a short time. Please wait a moment and try again."},
	{500, "Internal error", "The server could not complete this request. Please try again later."},
	{501, "Not implemented", "The server does not support what this request asks for."},
	{502, "Service unreachable", "The service behind this address cannot be reached right now. Please try again later."},
	{503, "Service unavailable", "The service is temporarily unavailable. Please try again later."},
	{504, "Service timed out", "The service behind this address did not answer in time. Please try again later."},
	{505, "HTTP version not supported", "The server does not support the HTTP version this request used."},
}

// V2Codes are the codes of Pages that came with nginx_error_pages_v2; the server blocks of earlier daemons do not name
// them (UpgradeServerDirectives).
var V2Codes = []int{501, 505}

// SpecialPages are the codes nginx answers with status 400; each page says what was wrong with the request.
var SpecialPages = []Page{
	{494, "Request header too large", "A request header or cookie is larger than the server accepts. Clearing the cookies of this site may help."},
	{495, "Certificate not accepted", "The client certificate sent with this request could not be verified."},
	{496, "Certificate required", "This page needs a client certificate, and none was sent."},
	{497, "HTTPS required", "A plain HTTP request was sent to the HTTPS port. Open the address with https:// instead."},
}

// sentStatus is the status line code nginx sends for an error code.
func sentStatus(code int) int {
	if code >= 494 && code <= 497 {
		return 400
	}
	return code
}

// HTML is the page for one code, with or without the "Powered by Opfield" footer.
func HTML(page Page, branded bool) string {
	footer := ""
	if branded {
		footer = brandingFooter
	}
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>` + page.Heading + `</title><style>` + PageColorVariables + `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--page);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:560px;text-align:center}.status{color:var(--stone);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}h1{margin:16px 0 0;font-size:clamp(40px,8vw,64px);line-height:1.05;font-weight:700;letter-spacing:-.04em}p.message{margin:20px auto 0;max-width:440px;color:var(--stone);font-size:15px;line-height:1.6}.footer{margin-top:48px;color:var(--stone);font-size:12px}.footer a{color:var(--ink);text-decoration:none}.footer a:hover{text-decoration:underline}</style></head><body><main><section><div class="status">Error ` + strconv.Itoa(sentStatus(page.Code)) + `</div><h1>` + page.Heading + `</h1><p class="message">` + page.Message + `</p></section>` + footer + `</main></body></html>`
}

// NotFoundHTML is the branded 404 page (Pages previews answer a missing page with it).
var NotFoundHTML = HTML(Pages[3], true)

// quote makes text one single-quoted nginx string. The pages hold no "$", so nginx reads no variable in them.
func quote(text string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(text) + "'"
}

// Variable is the name of the variable that holds the page(s): the map over $status for the codes in Pages, or the
// page of one code in SpecialPages.
func Variable(code int, branded bool) string {
	name := "$opfield_error_page"
	if code != 0 {
		name += "_" + strconv.Itoa(code)
	}
	if !branded {
		name += "_unbranded"
	}
	return name
}

// RequestLinePath is the internal location 400, 414 and 505 are handed to (see the package comment).
const RequestLinePath = "/.well-known/opfield-error"

// RequestLineCodes are the codes handed to RequestLinePath.
var RequestLineCodes = []int{400, 414, 505}

// Location is the named location the codes of Pages (code 0) or one code of SpecialPages are handed to.
func Location(code int) string {
	if code == 0 {
		return "@opfield_error"
	}
	return "@opfield_error_" + strconv.Itoa(code)
}

// Config is the http-level file of the page variables, branded and unbranded.
func Config() string {
	var b strings.Builder
	b.WriteString("# Managed by Opfield: the pages nginx answers with when it ends a request itself (auto-generated).\n")
	for _, branded := range []bool{true, false} {
		fmt.Fprintf(&b, "map $status %s {\n", Variable(0, branded))
		fmt.Fprintf(&b, "    default %s;\n", quote(HTML(Pages[9], branded)))
		for _, page := range Pages {
			fmt.Fprintf(&b, "    %d %s;\n", page.Code, quote(HTML(page, branded)))
		}
		b.WriteString("}\n")
		for _, page := range SpecialPages {
			fmt.Fprintf(&b, "map $pid %s {\n    default %s;\n}\n", Variable(page.Code, branded), quote(HTML(page, branded)))
		}
	}
	return b.String()
}

// ServerDirectives are the lines a server block Opfield's daemon writes needs for the pages, indented for the server
// level, without the codes in except (the server answers them itself). They use the variables of Config.
func ServerDirectives(except ...int) []string {
	return serverDirectives(false, except...)
}

// AccessCheckedServerDirectives are ServerDirectives for a server that checks access with auth_request: the pages
// answer without a second check.
func AccessCheckedServerDirectives(except ...int) []string {
	return serverDirectives(true, except...)
}

func serverDirectives(accessChecked bool, except ...int) []string {
	var named, requestLine []string
	for _, page := range Pages {
		switch {
		case slices.Contains(except, page.Code):
		case slices.Contains(RequestLineCodes, page.Code):
			requestLine = append(requestLine, strconv.Itoa(page.Code))
		default:
			named = append(named, strconv.Itoa(page.Code))
		}
	}
	var lines []string
	if len(named) > 0 {
		lines = append(lines, "    error_page "+strings.Join(named, " ")+" "+Location(0)+";")
	}
	if len(requestLine) > 0 {
		lines = append(lines, "    error_page "+strings.Join(requestLine, " ")+" "+RequestLinePath+";")
	}
	for _, page := range SpecialPages {
		lines = append(lines, fmt.Sprintf("    error_page %d %s;", page.Code, Location(page.Code)))
	}
	body := func(variable string) []string {
		lines := []string{"        allow all;", "        auth_basic off;"}
		if accessChecked {
			lines = append(lines, "        auth_request off;")
		}
		return append(lines, "        default_type text/html;", "        return 200 "+variable+";", "    }")
	}
	lines = append(lines, "    location "+Location(0)+" {")
	lines = append(lines, body(Variable(0, true))...)
	lines = append(lines, "    location = "+RequestLinePath+" {", "        internal;")
	lines = append(lines, body(Variable(0, true))...)
	for _, page := range SpecialPages {
		lines = append(lines, "    location "+Location(page.Code)+" {")
		lines = append(lines, body(Variable(page.Code, true))...)
	}
	return lines
}

// earlierPageLine is an error_page line of the pages: its codes and where they go.
var earlierPageLine = regexp.MustCompile(`(?m)^([ \t]*error_page )((?:[0-9]{3} )+)(` + regexp.QuoteMeta(Location(0)) + `|` + regexp.QuoteMeta(RequestLinePath) + `);$`)

// UpgradeServerDirectives gives the error_page lines of the pages in a server block an earlier daemon (or the
// installer) wrote the codes of V2Codes: 501 to the named location, 505 to RequestLinePath. A line that already names
// a code of V2Codes, and every other line, stays as it is; it reports whether anything changed.
func UpgradeServerDirectives(text string) (string, bool) {
	changed := false
	upgraded := earlierPageLine.ReplaceAllStringFunc(text, func(line string) string {
		match := earlierPageLine.FindStringSubmatch(line)
		var codes []int
		for _, field := range strings.Fields(match[2]) {
			code, _ := strconv.Atoi(field)
			if slices.Contains(V2Codes, code) {
				return line
			}
			codes = append(codes, code)
		}
		for _, code := range V2Codes {
			if slices.Contains(RequestLineCodes, code) == (match[3] == RequestLinePath) {
				codes = append(codes, code)
			}
		}
		slices.Sort(codes)
		fields := make([]string, len(codes))
		for index, code := range codes {
			fields[index] = strconv.Itoa(code)
		}
		changed = true
		return match[1] + strings.Join(fields, " ") + " " + match[3] + ";"
	})
	return upgraded, changed
}
