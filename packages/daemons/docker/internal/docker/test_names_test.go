package docker

import "testing"

// Tests run without a launcher, so new objects get the Opfield names; these name the objects of that family.
var (
	secureLinkConnectorName     = opfieldSecureLinkNames.connector
	secureLinkAnchorName        = opfieldSecureLinkNames.anchor
	secureLinkManagementNetwork = opfieldSecureLinkNames.network
	secureLinkConnectorSlots    = [len(secureLinkConnectorSockets)]struct{ name, socket string }{
		{name: secureLinkConnectorName, socket: secureLinkConnectorSockets[0]},
		{name: secureLinkConnectorName + "-next", socket: secureLinkConnectorSockets[1]},
		{name: secureLinkConnectorName + "-third", socket: secureLinkConnectorSockets[2]},
	}
)

func keeperWitnessName(id string) string { return keeperWitnessNames(id)[0] }

// withOpfieldNamesActive sets whether new objects get the Opfield names for one test.
func withOpfieldNamesActive(t *testing.T, active bool) {
	t.Helper()
	previous := opfieldNamesActive
	opfieldNamesActive = func() bool { return active }
	t.Cleanup(func() { opfieldNamesActive = previous })
}
