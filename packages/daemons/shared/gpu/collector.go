package gpu

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	stdexec "os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	nvidiaInventoryQuery = "uuid,index,name,pci.bus_id,mig.mode.current,compute_mode"
	nvidiaTelemetryQuery = "uuid,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw,power.limit,ecc.errors.corrected.aggregate.total,ecc.errors.uncorrected.aggregate.total,clocks_throttle_reasons.active"
)

var pciAddressPattern = regexp.MustCompile(`(?i)([0-9a-f]{4,8}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])`)

type commandRunner func(context.Context, string, ...string) ([]byte, error)
type intelSampler func(context.Context, string) ([]byte, error)

// Collector is intentionally rooted in normal Linux host interfaces. Vendor
// CLI tools are optional telemetry enrichments; device discovery and direct
// device readiness do not require Opfield to install anything on the host.
type Collector struct {
	run          commandRunner
	glob         func(string) ([]string, error)
	readFile     func(string) ([]byte, error)
	stat         func(string) (os.FileInfo, error)
	evalSymlinks func(string) (string, error)
	sampleIntel  intelSampler
	logger       *slog.Logger
}

func NewCollector(logger *slog.Logger) *Collector {
	return &Collector{
		run:          runCommand,
		glob:         filepath.Glob,
		readFile:     os.ReadFile,
		stat:         os.Stat,
		evalSymlinks: filepath.EvalSymlinks,
		sampleIntel:  sampleIntelGPU,
		logger:       logger,
	}
}

func newCollector(run commandRunner, glob func(string) ([]string, error), readFile func(string) ([]byte, error), stat func(string) (os.FileInfo, error), evalSymlinks func(string) (string, error), sampleIntel intelSampler) *Collector {
	return &Collector{run: run, glob: glob, readFile: readFile, stat: stat, evalSymlinks: evalSymlinks, sampleIntel: sampleIntel}
}

// Collect returns a full node-local inventory. It never returns fabricated
// metrics: fields are populated only by an observed vendor or sysfs source.
func (c *Collector) Collect(ctx context.Context) []Device {
	devices := c.discoverDRMDevices()
	nvidia := c.collectNVIDIA(ctx)
	devices = mergeNVIDIA(devices, nvidia)
	c.collectIntelTelemetry(ctx, devices)
	sort.Slice(devices, func(i, j int) bool { return devices[i].ID < devices[j].ID })
	return devices
}

// Resolve accepts only node-discovered device IDs. This is the daemon-side
// boundary that prevents Opfield API callers from supplying host paths.
func (c *Collector) Resolve(ctx context.Context, ids []string) ([]Device, error) {
	if len(ids) == 0 {
		return []Device{}, nil
	}
	known := make(map[string]Device)
	for _, device := range c.Collect(ctx) {
		known[device.ID] = device
	}
	seen := make(map[string]struct{}, len(ids))
	resolved := make([]Device, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, fmt.Errorf("GPU device ID is required")
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, fmt.Errorf("GPU device %q was selected more than once", id)
		}
		seen[id] = struct{}{}
		device, ok := known[id]
		if !ok {
			return nil, fmt.Errorf("GPU device %q is not available on this node", id)
		}
		if device.Partitioned {
			return nil, fmt.Errorf("GPU device %q uses an unsupported partitioned or virtualized mode", id)
		}
		if !device.Attachable {
			reason := device.UnavailableReason
			if reason == "" {
				reason = "GPU is not ready for container attachment"
			}
			return nil, fmt.Errorf("GPU device %q is unavailable: %s", id, reason)
		}
		resolved = append(resolved, device)
	}
	return resolved, nil
}

// ApplyNVIDIAContainerRuntimeReadiness lets the Docker daemon add the one
// Docker-specific prerequisite that the monitoring daemon cannot know.
func ApplyNVIDIAContainerRuntimeReadiness(devices []Device, available bool) []Device {
	if available {
		return devices
	}
	for index := range devices {
		if devices[index].Vendor != VendorNVIDIA || !devices[index].Attachable {
			continue
		}
		devices[index].Attachable = false
		devices[index].UnavailableReason = "NVIDIA Container Toolkit is not configured in Docker"
	}
	return devices
}

func (c *Collector) discoverDRMDevices() []Device {
	paths, err := c.glob("/sys/class/drm/renderD*")
	if err != nil {
		return nil
	}
	devices := make([]Device, 0, len(paths))
	for _, renderPath := range paths {
		renderName := filepath.Base(renderPath)
		if !strings.HasPrefix(renderName, "renderD") {
			continue
		}
		devicePath, err := c.evalSymlinks(filepath.Join(renderPath, "device"))
		if err != nil {
			continue
		}
		vendor, ok := vendorFromPCI(c.readTrim(filepath.Join(devicePath, "vendor")))
		if !ok {
			continue
		}
		pciAddress := c.pciAddress(devicePath)
		if pciAddress == "" {
			continue
		}
		index, _ := strconv.ParseInt(strings.TrimPrefix(renderName, "renderD"), 10, 32)
		renderNode := filepath.Join("/dev/dri", renderName)
		deviceID := fmt.Sprintf("%s:%s", vendor, pciAddress)
		device := Device{
			ID:         deviceID,
			Vendor:     vendor,
			Model:      modelLabel(vendor, c.readTrim(filepath.Join(devicePath, "device"))),
			PCIAddress: pciAddress,
			RenderNode: renderNode,
			Index:      int32(index),
			DevicePaths: []string{
				renderNode,
			},
			GroupIDs: c.deviceGroupIDs(renderNode),
		}
		switch vendor {
		case VendorNVIDIA:
			device.Attachable = false
			device.UnavailableReason = "NVIDIA driver tools are unavailable"
		case VendorAMD:
			if c.exists("/dev/kfd") {
				device.Attachable = true
				device.DevicePaths = append([]string{"/dev/kfd"}, device.DevicePaths...)
				device.GroupIDs = appendUnique(device.GroupIDs, c.deviceGroupIDs("/dev/kfd")...)
			} else {
				device.UnavailableReason = "AMD KFD device /dev/kfd is unavailable"
			}
		case VendorIntel:
			device.Attachable = true
		}
		c.collectSysfsMetrics(&device, devicePath)
		devices = append(devices, device)
	}
	return devices
}

func (c *Collector) collectNVIDIA(ctx context.Context) []Device {
	output, err := c.run(ctx, "nvidia-smi", "--query-gpu="+nvidiaInventoryQuery, "--format=csv,noheader,nounits")
	if err != nil {
		return nil
	}
	devices := parseNVIDIAInventory(output)
	if len(devices) == 0 {
		return nil
	}
	telemetry, err := c.run(ctx, "nvidia-smi", "--query-gpu="+nvidiaTelemetryQuery, "--format=csv,noheader,nounits")
	if err == nil {
		applyNVIDIATelemetry(devices, telemetry)
	}
	return devices
}

func parseNVIDIAInventory(output []byte) []Device {
	rows, err := csv.NewReader(bytes.NewReader(output)).ReadAll()
	if err != nil {
		return nil
	}
	devices := make([]Device, 0, len(rows))
	for _, row := range rows {
		if len(row) < 6 {
			continue
		}
		uuid := strings.TrimSpace(row[0])
		pciAddress := canonicalPCI(row[3])
		if uuid == "" || isUnavailable(uuid) || pciAddress == "" {
			continue
		}
		index, _ := strconv.ParseInt(strings.TrimSpace(row[1]), 10, 32)
		migMode := strings.ToLower(strings.TrimSpace(row[4]))
		computeMode := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(row[5]), " ", "_"))
		partitioned := migMode != "" && migMode != "disabled" && !isUnavailable(migMode)
		exclusive := strings.Contains(computeMode, "exclusive")
		attachable := !partitioned && !exclusive
		reason := ""
		if partitioned {
			reason = "NVIDIA MIG or partitioned mode is unsupported"
		}
		if exclusive {
			reason = "NVIDIA exclusive compute mode is unsupported"
		}
		device := Device{
			ID:                "nvidia:" + uuid,
			Vendor:            VendorNVIDIA,
			Model:             strings.TrimSpace(row[2]),
			PCIAddress:        pciAddress,
			Index:             int32(index),
			Attachable:        attachable,
			UnavailableReason: reason,
			Partitioned:       partitioned,
			RuntimeID:         uuid,
		}
		if attachable {
			device.Metrics.Health = String("healthy")
		} else {
			device.Metrics.Health = String("degraded")
		}
		devices = append(devices, device)
	}
	return devices
}

func applyNVIDIATelemetry(devices []Device, output []byte) {
	rows, err := csv.NewReader(bytes.NewReader(output)).ReadAll()
	if err != nil {
		return
	}
	byRuntimeID := make(map[string]*Device, len(devices))
	for index := range devices {
		byRuntimeID[devices[index].RuntimeID] = &devices[index]
	}
	for _, row := range rows {
		if len(row) < 10 {
			continue
		}
		device := byRuntimeID[strings.TrimSpace(row[0])]
		if device == nil {
			continue
		}
		if value, ok := parseFloat(row[1]); ok {
			device.Metrics.UtilizationPercent = Float64(value)
		}
		if value, ok := parseInt(row[2]); ok {
			device.Metrics.MemoryTotalBytes = Int64(value * 1024 * 1024)
		}
		if value, ok := parseInt(row[3]); ok {
			device.Metrics.MemoryUsedBytes = Int64(value * 1024 * 1024)
		}
		if value, ok := parseFloat(row[4]); ok {
			device.Metrics.TemperatureCelsius = Float64(value)
		}
		if value, ok := parseFloat(row[5]); ok {
			device.Metrics.PowerWatts = Float64(value)
		}
		if value, ok := parseFloat(row[6]); ok {
			device.Metrics.PowerLimitWatts = Float64(value)
		}
		if value, ok := parseInt(row[7]); ok {
			device.Metrics.ECCCorrectedErrors = Int64(value)
		}
		if value, ok := parseInt(row[8]); ok {
			device.Metrics.ECCUncorrectedErrors = Int64(value)
		}
		throttle := strings.ToLower(strings.TrimSpace(row[9]))
		if throttle != "" && !isUnavailable(throttle) {
			device.Metrics.Throttled = Bool(strings.HasPrefix(throttle, "active") || throttle == "yes" || throttle == "true")
		}
	}
}

func mergeNVIDIA(existing []Device, nvidia []Device) []Device {
	byPCI := make(map[string]int, len(existing))
	for index := range existing {
		if existing[index].Vendor == VendorNVIDIA {
			byPCI[canonicalPCI(existing[index].PCIAddress)] = index
		}
	}
	for _, discovered := range nvidia {
		if index, ok := byPCI[canonicalPCI(discovered.PCIAddress)]; ok {
			discovered.RenderNode = existing[index].RenderNode
			discovered.GroupIDs = existing[index].GroupIDs
			existing[index] = discovered
			continue
		}
		existing = append(existing, discovered)
	}
	return existing
}

func (c *Collector) collectIntelTelemetry(ctx context.Context, devices []Device) {
	for index := range devices {
		if devices[index].Vendor != VendorIntel || devices[index].RenderNode == "" || c.sampleIntel == nil {
			continue
		}
		output, err := c.sampleIntel(ctx, devices[index].RenderNode)
		if err != nil {
			continue
		}
		if value, ok := parseIntelBusy(output); ok {
			devices[index].Metrics.UtilizationPercent = Float64(value)
		}
	}
}

func (c *Collector) collectSysfsMetrics(device *Device, devicePath string) {
	if value, ok := c.readInt64(filepath.Join(devicePath, "gpu_busy_percent")); ok {
		device.Metrics.UtilizationPercent = Float64(float64(value))
	}
	if value, ok := c.readInt64(filepath.Join(devicePath, "mem_info_vram_total")); ok {
		device.Metrics.MemoryTotalBytes = Int64(value)
	}
	if value, ok := c.readInt64(filepath.Join(devicePath, "mem_info_vram_used")); ok {
		device.Metrics.MemoryUsedBytes = Int64(value)
	}
	hwmons, _ := c.glob(filepath.Join(devicePath, "hwmon", "hwmon*"))
	for _, hwmon := range hwmons {
		if device.Metrics.TemperatureCelsius == nil {
			if value, ok := c.readInt64(filepath.Join(hwmon, "temp1_input")); ok {
				device.Metrics.TemperatureCelsius = Float64(float64(value) / 1000)
			}
		}
		if device.Metrics.PowerWatts == nil {
			if value, ok := c.readInt64(filepath.Join(hwmon, "power1_average")); ok {
				device.Metrics.PowerWatts = Float64(float64(value) / 1_000_000)
			}
		}
		if device.Metrics.PowerLimitWatts == nil {
			if value, ok := c.readInt64(filepath.Join(hwmon, "power1_cap")); ok {
				device.Metrics.PowerLimitWatts = Float64(float64(value) / 1_000_000)
			}
		}
	}
}

func (c *Collector) pciAddress(devicePath string) string {
	if value := c.readTrim(filepath.Join(devicePath, "uevent")); value != "" {
		for _, line := range strings.Split(value, "\n") {
			if strings.HasPrefix(line, "PCI_SLOT_NAME=") {
				return canonicalPCI(strings.TrimPrefix(line, "PCI_SLOT_NAME="))
			}
		}
	}
	return canonicalPCI(devicePath)
}

func (c *Collector) readTrim(path string) string {
	value, err := c.readFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(value))
}

func (c *Collector) readInt64(path string) (int64, bool) {
	value := c.readTrim(path)
	if value == "" || isUnavailable(value) {
		return 0, false
	}
	parsed, err := strconv.ParseInt(strings.Fields(value)[0], 10, 64)
	return parsed, err == nil
}

func (c *Collector) exists(path string) bool {
	_, err := c.stat(path)
	return err == nil
}

func (c *Collector) deviceGroupIDs(path string) []string {
	info, err := c.stat(path)
	if err != nil {
		return nil
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	return []string{strconv.FormatUint(uint64(stat.Gid), 10)}
}

func vendorFromPCI(value string) (Vendor, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "0x10de":
		return VendorNVIDIA, true
	case "0x1002":
		return VendorAMD, true
	case "0x8086":
		return VendorIntel, true
	default:
		return "", false
	}
}

func modelLabel(vendor Vendor, deviceID string) string {
	name := strings.ToUpper(string(vendor)) + " GPU"
	if deviceID == "" {
		return name
	}
	return name + " (" + deviceID + ")"
}

func canonicalPCI(value string) string {
	match := pciAddressPattern.FindStringSubmatch(strings.ToLower(value))
	if len(match) != 2 {
		return ""
	}
	pci := match[1]
	if len(pci) == 16 {
		return pci[len(pci)-12:]
	}
	return pci
}

func appendUnique(values []string, additions ...string) []string {
	seen := make(map[string]struct{}, len(values)+len(additions))
	for _, value := range values {
		seen[value] = struct{}{}
	}
	for _, value := range additions {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

func parseFloat(raw string) (float64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || isUnavailable(raw) {
		return 0, false
	}
	value, err := strconv.ParseFloat(strings.Fields(raw)[0], 64)
	return value, err == nil
}

func parseInt(raw string) (int64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || isUnavailable(raw) {
		return 0, false
	}
	value, err := strconv.ParseInt(strings.Fields(raw)[0], 10, 64)
	return value, err == nil
}

func isUnavailable(value string) bool {
	value = strings.Trim(strings.ToLower(strings.TrimSpace(value)), "[]")
	return value == "n/a" || value == "na" || value == "unknown" || value == "not supported"
}

func runCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	timeoutCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return stdexec.CommandContext(timeoutCtx, name, args...).Output()
}

func sampleIntelGPU(ctx context.Context, renderNode string) ([]byte, error) {
	binary, err := stdexec.LookPath("intel_gpu_top")
	if err != nil {
		return nil, err
	}
	cmd := stdexec.Command(binary, "-J", "-d", "drm:"+renderNode, "-s", "250")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(550 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		_ = cmd.Process.Signal(os.Interrupt)
	case <-timer.C:
		// intel_gpu_top emits a complete JSON array on a clean interrupt.
		_ = cmd.Process.Signal(os.Interrupt)
	case err := <-done:
		if err != nil && stdout.Len() == 0 {
			return nil, err
		}
		return stdout.Bytes(), nil
	}
	select {
	case err := <-done:
		if err != nil && stdout.Len() == 0 {
			return nil, err
		}
		return stdout.Bytes(), nil
	case <-time.After(time.Second):
		_ = cmd.Process.Kill()
		<-done
		return nil, fmt.Errorf("intel_gpu_top did not exit after sampling")
	}
}

func parseIntelBusy(output []byte) (float64, bool) {
	var data any
	if err := json.Unmarshal(output, &data); err != nil {
		return 0, false
	}
	var maxBusy float64
	found := false
	var visit func(any, string)
	visit = func(value any, key string) {
		switch typed := value.(type) {
		case map[string]any:
			for nestedKey, nestedValue := range typed {
				visit(nestedValue, nestedKey)
			}
		case []any:
			for _, nested := range typed {
				visit(nested, key)
			}
		case float64:
			if strings.Contains(strings.ToLower(key), "busy") && typed >= 0 && typed <= 100 {
				if !found || typed > maxBusy {
					maxBusy = typed
				}
				found = true
			}
		}
	}
	visit(data, "")
	return maxBusy, found
}
