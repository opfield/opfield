---
{
  "id": "hhw7f2ta",
  "file_name": "hhw7f2ta_seaweedfs_reader_cache",
  "tags": [
    "docker-daemon",
    "managed-storage",
    "performance",
    "seaweedfs"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1791573206135,
  "updated_at": 1791573206135
}
---
Managed SeaweedFS (pinned 4.47) lessons from the v2.11.4-rc.7 fixes (F-4b, F-7):
- Slow large S3 GETs (4-9 MB/s, also directly on the node, not Secure Link): 4.47's S3 GET prefetch (`ReaderCache.MaybeCache`) creates 4 new downloaders per 256 KiB ReadAt up to 256 downloaders, into a reader cache capped at 256 MiB (upstream regression #11380, 4.48 drops the cap and then OOMs at 768 MiB; with `-s3.readerCacheSizeMB` it still thrashes). With 4 MiB chunks prefetched chunks are evicted and refetched 80-120x. Fix in the daemon: `-filer.maxMB=1` (256 x 1 MiB fits the cap); only new uploads get small chunks. Concurrent small requests keep the downloader map full and hide the bug, so measure large GETs with no other traffic. Diagnose with /proc/<pid>/io rchar or the container cgroup io.stat loop-device reads vs bytes served.
- Memory: the engine container is charged for page cache of the loop disk and of the image file; GOMEMLIMIT must leave room (60 % of the limit; 85 % got OOM-killed). Judge OOM risk by cgroup anon + oom_kill, not memory.peak (page cache fills to the limit).
- Disk: images are sparse (mkfs/trim punch holes), so capacity checks must count promised (apparent) sizes; FITRIM returns deleted space; an ext4 that aborted its journal shows `emergency_ro` in mountinfo super options (kernel 6.17), mount options stay rw.
- Harness: run the weed release binary on CT 1138 under systemd-run with MemoryMax/CPUQuota; CT 1138 is ZFS without loop devices, so page-cache pressure of the stand cannot be reproduced there.
