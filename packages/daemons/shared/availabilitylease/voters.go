package availabilitylease

import (
	"fmt"
	"sort"
)

// policyConfig returns the current voter set of a policy (A18).
func (n *Node) policyConfig(policyID string) *VoterConfig {
	if manifest := n.manifests[policyID]; manifest != nil {
		return manifest.Voters
	}
	return nil
}

// configByEpoch returns a policy's voter config of an epoch, when known.
func (n *Node) configByEpoch(policyID string, epoch uint64) *VoterConfig {
	for _, config := range n.history[policyID] {
		if config.Epoch == epoch {
			return config
		}
	}
	return nil
}

// rememberVoters records a policy's voter config in its bounded history.
// It reports whether the epoch was new.
func (n *Node) rememberVoters(config *VoterConfig) bool {
	if config == nil || config.Epoch == 0 {
		return false
	}
	list := n.history[config.PolicyID]
	for i, known := range list {
		if known.Epoch == config.Epoch {
			list[i] = config
			return false
		}
	}
	list = append(list, config)
	sort.Slice(list, func(i, j int) bool { return list[i].Epoch < list[j].Epoch })
	for len(list) > configHistory {
		n.deletes = append(n.deletes, votersRecordName(config.PolicyID, list[0].Epoch))
		list = list[1:]
	}
	n.history[config.PolicyID] = list
	return true
}

func votersRecordName(policyID string, epoch uint64) string {
	return fmt.Sprintf("%s%s/%020d", prefixVoters, policyID, epoch)
}
