package docker

import (
	"testing"

	"github.com/moby/moby/api/types/volume"
)

// Housekeeping sizes unused volumes from one disk-usage walk: every measured volume by name, unmeasured ones left out.
func TestVolumeSizesFromUsageKeepsMeasuredVolumes(t *testing.T) {
	sizes := volumeSizesFromUsage([]volume.Volume{
		{Name: "data", UsageData: &volume.UsageData{Size: 4096, RefCount: 0}},
		{Name: "empty", UsageData: &volume.UsageData{Size: 0, RefCount: 1}},
		{Name: "unmeasured", UsageData: &volume.UsageData{Size: -1, RefCount: -1}},
		{Name: "no-usage"},
		{Name: "", UsageData: &volume.UsageData{Size: 7}},
	})
	if len(sizes) != 2 || sizes["data"] != 4096 || sizes["empty"] != 0 {
		t.Fatalf("sizes = %v, want data=4096 and empty=0 only", sizes)
	}
}
