package swha

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Topology is what the master's /dir/status says.
type Topology struct {
	// Nodes maps each registered volume server URL to its volume ids.
	Nodes map[string][]uint32
	// MaxVolumeID is the highest volume id on any registered server.
	MaxVolumeID uint32
}

// ParseTopology reads the master's /dir/status answer.
func ParseTopology(raw []byte) (Topology, error) {
	var status struct {
		Topology struct {
			DataCenters []struct {
				Racks []struct {
					DataNodes []struct {
						URL       string `json:"Url"`
						VolumeIDs string `json:"VolumeIds"`
					} `json:"DataNodes"`
				} `json:"Racks"`
			} `json:"DataCenters"`
		} `json:"Topology"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return Topology{}, fmt.Errorf("decode SeaweedFS topology: %w", err)
	}
	topology := Topology{Nodes: map[string][]uint32{}}
	for _, dc := range status.Topology.DataCenters {
		for _, rack := range dc.Racks {
			for _, node := range rack.DataNodes {
				ids, err := parseVolumeIDs(node.VolumeIDs)
				if err != nil {
					return Topology{}, err
				}
				topology.Nodes[node.URL] = append(topology.Nodes[node.URL], ids...)
				for _, id := range ids {
					topology.MaxVolumeID = max(topology.MaxVolumeID, id)
				}
			}
		}
	}
	return topology, nil
}

// parseVolumeIDs reads SeaweedFS's compact id list (" 1 3-5 ", commas too).
func parseVolumeIDs(raw string) ([]uint32, error) {
	var ids []uint32
	for _, token := range strings.FieldsFunc(raw, func(r rune) bool { return r == ' ' || r == ',' }) {
		low, high, isRange := strings.Cut(token, "-")
		a, err := strconv.ParseUint(low, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("volume id %q: %w", token, err)
		}
		b := a
		if isRange {
			if b, err = strconv.ParseUint(high, 10, 32); err != nil || b < a {
				return nil, fmt.Errorf("volume id range %q is invalid", token)
			}
		}
		if b-a > 1<<20 {
			return nil, fmt.Errorf("volume id range %q is too large", token)
		}
		for id := a; id <= b; id++ {
			ids = append(ids, uint32(id))
		}
	}
	return ids, nil
}

// Registered reports whether url is a registered volume server.
func (t Topology) Registered(url string) bool {
	_, ok := t.Nodes[url]
	return ok
}

// volumeStatus is the part of the master's /vol/status answer the repair needs.
type volumeStatus struct {
	ID               uint32          `json:"Id"`
	Collection       string          `json:"Collection"`
	ReplicaPlacement json.RawMessage `json:"ReplicaPlacement"`
}

// extraCopies reads a replica placement as SeaweedFS encodes it: an object
// ({"node":1} with omitted zero counts, or the Go field names) or "001".
func extraCopies(raw json.RawMessage) (int, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, true
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if len(text) != 3 {
			return 0, false
		}
		total := 0
		for _, r := range text {
			if r < '0' || r > '9' {
				return 0, false
			}
			total += int(r - '0')
		}
		return total, true
	}
	var counts map[string]int
	if json.Unmarshal(raw, &counts) != nil {
		return 0, false
	}
	total := 0
	for _, count := range counts {
		total += count
	}
	return total, true
}

// singleCopyVolumes lists the volumes created with replication 000 (one copy),
// the throw-away volumes of the id gate left out.
func singleCopyVolumes(raw []byte) ([]uint32, error) {
	var status struct {
		Volumes struct {
			DataCenters map[string]map[string]map[string][]volumeStatus `json:"DataCenters"`
		} `json:"Volumes"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return nil, fmt.Errorf("decode SeaweedFS volume status: %w", err)
	}
	seen := map[uint32]bool{}
	var ids []uint32
	for _, racks := range status.Volumes.DataCenters {
		for _, nodes := range racks {
			for _, volumes := range nodes {
				for _, volume := range volumes {
					copies, known := extraCopies(volume.ReplicaPlacement)
					if seen[volume.ID] || volume.Collection == bumpCollection || !known || copies != 0 {
						continue
					}
					seen[volume.ID] = true
					ids = append(ids, volume.ID)
				}
			}
		}
	}
	return ids, nil
}

// collectionVolumes lists the volumes of collection on the volume server node
// from the master's /vol/status answer.
func collectionVolumes(raw []byte, node, collection string) ([]uint32, error) {
	var status struct {
		Volumes struct {
			DataCenters map[string]map[string]map[string][]volumeStatus `json:"DataCenters"`
		} `json:"Volumes"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return nil, fmt.Errorf("decode SeaweedFS volume status: %w", err)
	}
	var ids []uint32
	for _, racks := range status.Volumes.DataCenters {
		for _, nodes := range racks {
			for url, volumes := range nodes {
				if url != node {
					continue
				}
				for _, volume := range volumes {
					if volume.Collection == collection {
						ids = append(ids, volume.ID)
					}
				}
			}
		}
	}
	return ids, nil
}
