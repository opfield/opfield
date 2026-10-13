// Package gpu discovers physical Linux GPUs and represents their
// capability-aware telemetry. It deliberately contains no Docker API types:
// Docker-specific device mapping stays in the Docker daemon, after the
// selection has been resolved against this inventory.
package gpu

import pb "github.com/opfield/opfield/daemon-shared/opfieldv1"

type Vendor string

const (
	VendorNVIDIA Vendor = "nvidia"
	VendorAMD    Vendor = "amd"
	VendorIntel  Vendor = "intel"
)

// Metrics use pointers so zero remains a valid value and unavailable data is
// never serialized as a fabricated zero. The corresponding proto report
// lists every populated metric in AvailableMetrics.
type Metrics struct {
	UtilizationPercent   *float64
	MemoryTotalBytes     *int64
	MemoryUsedBytes      *int64
	TemperatureCelsius   *float64
	PowerWatts           *float64
	PowerLimitWatts      *float64
	Throttled            *bool
	ECCCorrectedErrors   *int64
	ECCUncorrectedErrors *int64
	Health               *string
}

// Device keeps the private host details required by the Docker daemon next to
// the safe node-facing inventory. DevicePaths and GroupIDs are never accepted
// from an Opfield request; they are derived from the selected discovered ID.
type Device struct {
	ID                string
	Vendor            Vendor
	Model             string
	PCIAddress        string
	RenderNode        string
	Index             int32
	Attachable        bool
	UnavailableReason string
	Partitioned       bool
	RuntimeID         string
	DevicePaths       []string
	GroupIDs          []string
	Metrics           Metrics
}

func (d Device) ToProto() *pb.GpuDevice {
	p := &pb.GpuDevice{
		Id:                d.ID,
		Vendor:            string(d.Vendor),
		Model:             d.Model,
		PciAddress:        d.PCIAddress,
		RenderNode:        d.RenderNode,
		DeviceIndex:       d.Index,
		Attachable:        d.Attachable,
		UnavailableReason: d.UnavailableReason,
		Partitioned:       d.Partitioned,
		AvailableMetrics:  make([]string, 0, 9),
	}
	if value := d.Metrics.UtilizationPercent; value != nil {
		p.UtilizationPercent = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "utilization_percent")
	}
	if value := d.Metrics.MemoryTotalBytes; value != nil {
		p.MemoryTotalBytes = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "memory_total_bytes")
	}
	if value := d.Metrics.MemoryUsedBytes; value != nil {
		p.MemoryUsedBytes = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "memory_used_bytes")
	}
	if value := d.Metrics.TemperatureCelsius; value != nil {
		p.TemperatureCelsius = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "temperature_celsius")
	}
	if value := d.Metrics.PowerWatts; value != nil {
		p.PowerWatts = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "power_watts")
	}
	if value := d.Metrics.PowerLimitWatts; value != nil {
		p.PowerLimitWatts = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "power_limit_watts")
	}
	if value := d.Metrics.Throttled; value != nil {
		p.Throttled = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "throttled")
	}
	if value := d.Metrics.ECCCorrectedErrors; value != nil {
		p.EccCorrectedErrors = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "ecc_corrected_errors")
	}
	if value := d.Metrics.ECCUncorrectedErrors; value != nil {
		p.EccUncorrectedErrors = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "ecc_uncorrected_errors")
	}
	if value := d.Metrics.Health; value != nil {
		p.Health = *value
		p.AvailableMetrics = append(p.AvailableMetrics, "health")
	}
	return p
}

func Float64(value float64) *float64 { return &value }
func Int64(value int64) *int64       { return &value }
func Bool(value bool) *bool          { return &value }
func String(value string) *string    { return &value }
