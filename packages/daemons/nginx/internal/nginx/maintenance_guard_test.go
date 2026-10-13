package nginx

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestEnsureMaintenanceGuardConfigWritesTheSharedMapsOnce(t *testing.T) {
	dir := t.TempDir()
	previous, written, err := EnsureMaintenanceGuardConfig(dir)
	if err != nil || !written || previous != nil {
		t.Fatalf("first ensure: previous=%q written=%v err=%v", previous, written, err)
	}
	_, written, err = EnsureMaintenanceGuardConfig(dir)
	if err != nil || written {
		t.Fatalf("an unchanged file was written again: written=%v err=%v", written, err)
	}
	content, err := os.ReadFile(MaintenanceGuardConfigPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	// nginx's default variables_hash_bucket_size (64) takes variable names of up to 46 bytes.
	for _, match := range regexp.MustCompile(`map \S+ \$(\S+) \{`).FindAllStringSubmatch(string(content), -1) {
		if len(match[1]) > 46 {
			t.Fatalf("variable %s is too long for the default variables hash", match[1])
		}
	}
}

func TestEnsureMaintenanceGuardConfigReplacesAnOlderCopy(t *testing.T) {
	dir := t.TempDir()
	older := []byte("# an older copy\n")
	if err := os.WriteFile(MaintenanceGuardConfigPath(dir), older, 0o644); err != nil {
		t.Fatal(err)
	}
	previous, written, err := EnsureMaintenanceGuardConfig(dir)
	if err != nil || !written || string(previous) != string(older) {
		t.Fatalf("replacing an older copy: previous=%q written=%v err=%v", previous, written, err)
	}
}

// mapRule is one regular expression variant of an nginx map and its value.
type mapRule struct {
	pattern *regexp.Regexp
	value   string
}

// cookieMapRules reads the regular expression variants of the map that defines variable, in order.
func cookieMapRules(t *testing.T, variable string) []mapRule {
	t.Helper()
	start := strings.Index(maintenanceGuardConfig, " $"+variable+" {")
	if start < 0 {
		t.Fatalf("no map defines $%s", variable)
	}
	block := maintenanceGuardConfig[start:]
	block = block[:strings.Index(block, "\n}")]
	var rules []mapRule
	for _, match := range regexp.MustCompile(`"~(.+)" "(.*)";`).FindAllStringSubmatch(block, -1) {
		rules = append(rules, mapRule{pattern: regexp.MustCompile(match[1]), value: match[2]})
	}
	return rules
}

// applyMap evaluates a map the way nginx does: the first matching regular expression gives the value, with $n
// replaced by its capture (empty when the group took no part in the match); no match gives the default.
func applyMap(rules []mapRule, input string) string {
	for _, rule := range rules {
		match := rule.pattern.FindStringSubmatch(input)
		if match == nil {
			continue
		}
		return regexp.MustCompile(`\$(\d)`).ReplaceAllStringFunc(rule.value, func(group string) string {
			index := int(group[1] - '0')
			if index < len(match) {
				return match[index]
			}
			return ""
		})
	}
	return input
}

// TestMaintenanceCookieMapsLeaveNoEmptyOrLeadingSeparator: the upstream gets the request's cookies without Opfield's
// access cookies, wherever they stood, and never an empty name (a leading or doubled ";").
func TestMaintenanceCookieMapsLeaveNoEmptyOrLeadingSeparator(t *testing.T) {
	sig := cookieMapRules(t, "opfield_maintenance_cookie_sig")
	exp := cookieMapRules(t, "opfield_maintenance_cookie_stripped")
	if len(sig) == 0 || len(exp) == 0 {
		t.Fatal("the cookie maps have no rules")
	}
	const s, e = "opfield_maintenance_access_sig=S1g", "opfield_maintenance_access_exp=1700000000"
	for input, want := range map[string]string{
		s + "; " + e + "; mine=1":             "mine=1",
		s + "; mine=1; " + e:                  "mine=1",
		"mine=1; " + s + "; " + e:             "mine=1",
		e + "; " + s + "; mine=1":             "mine=1",
		"a=1; " + s + "; b=2; " + e + "; c=3": "a=1; b=2; c=3",
		"a=1;" + s + ";b=2;" + e:              "a=1;b=2",
		s + "; " + e:                          "",
		s:                                     "",
		"mine=1":                              "mine=1",
		"xopfield_maintenance_access_sig=1; mine=1": "xopfield_maintenance_access_sig=1; mine=1",
		"": "",
	} {
		if got := applyMap(exp, applyMap(sig, input)); got != want {
			t.Errorf("Cookie %q forwarded as %q, want %q", input, got, want)
		}
	}
}
