package docker

import "testing"

func TestOfficialConnectorReleaseTagAcceptsBothOrganizations(t *testing.T) {
	for _, image := range []string{
		"ghcr.io/opfield/opfield/secure-link-connector:v2.12.0-relay",
		"ghcr.io/the-square-labs/gateway/secure-link-connector:v2.12.0-rc.3-relay",
		"ghcr.io/the-square-labs/gateway/secure-link-connector:v2.11.5-relay",
		"ghcr.io/opfield/opfield/secure-link-connector:v2.12.0-rc.3-relay",
	} {
		if !officialConnectorReleaseTagPattern.MatchString(image) {
			t.Errorf("%s is an official connector release tag", image)
		}
	}
	for _, image := range []string{
		"ghcr.io/opfield/other/secure-link-connector:v2.12.0-relay",
		"ghcr.io/opfield/opfield/secure-link-connector:latest",
		"ghcr.io/example/gateway/secure-link-connector:v2.12.0-relay",
	} {
		if officialConnectorReleaseTagPattern.MatchString(image) {
			t.Errorf("%s is not an official connector release tag", image)
		}
	}
}
