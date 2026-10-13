#!/usr/bin/env python3
"""Prepare Opfield Pages uploads: inspect one file, pack a site directory, read MCP-sized chunks."""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile

CHUNK_MAX = 1024 * 1024
SNIFF_BYTES = 1024
ENTRYPOINTS = ("index.html", "index.htm")
# Attribute values that a single-file upload cannot serve: anything that is not
# absolute, protocol-relative, a data/blob URI, an in-page anchor, or a scheme link.
REFERENCE_PATTERN = re.compile(r"""(?:src|href|srcset|poster|data)\s*=\s*["']([^"'#][^"']*)["']""", re.IGNORECASE)
NON_LOCAL_PREFIXES = ("http://", "https://", "//", "data:", "blob:", "mailto:", "tel:", "javascript:", "about:")


def fail(message: str) -> None:
    raise SystemExit(message)


def file_digest(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while block := handle.read(CHUNK_MAX):
            size += len(block)
            digest.update(block)
    return size, digest.hexdigest()


def detect_format(path: Path) -> str:
    """Mirror Opfield's detection: gzip magic bytes are an archive, leading markup is one HTML page."""
    with path.open("rb") as handle:
        head = handle.read(SNIFF_BYTES)
    if len(head) >= 2 and head[0] == 0x1F and head[1] == 0x8B:
        return "tar.gz"
    text = head.decode("utf-8", errors="replace").lstrip("﻿").lstrip()
    if text.startswith("<"):
        return "html"
    fail(f"Not a Pages artifact (expected a .tar.gz archive or an HTML file): {path}")
    return ""


def local_references(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    found: list[str] = []
    for match in REFERENCE_PATTERN.finditer(text):
        value = match.group(1).strip()
        if not value or value.lower().startswith(NON_LOCAL_PREFIXES) or value in found:
            continue
        found.append(value)
        if len(found) == 20:
            break
    return found


def inspect(path_arg: str) -> None:
    path = Path(path_arg).expanduser().resolve()
    if not path.is_file():
        fail(f"Pages artifact does not exist: {path}")
    size, sha256 = file_digest(path)
    if size < 1:
        fail("Pages artifact is empty")
    result = {"path": str(path), "size": size, "sha256": sha256, "format": detect_format(path)}
    if result["format"] == "html":
        # A single HTML upload publishes only index.html; these references would not resolve.
        result["localReferences"] = local_references(path)
    print(json.dumps(result))


def normalized_info(info: tarfile.TarInfo, executable: bool = False) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.mode = 0o755 if info.isdir() or executable else 0o644
    return info


def iter_entries(source: Path):
    for root, dirnames, filenames in os.walk(source, followlinks=False):
        dirnames.sort()
        filenames.sort()
        root_path = Path(root)
        for dirname in dirnames:
            path = root_path / dirname
            if path.is_symlink():
                fail(f"Refusing symlink in Pages artifact: {path}")
            yield path
        for filename in filenames:
            path = root_path / filename
            if path.is_symlink():
                fail(f"Refusing symlink in Pages artifact: {path}")
            if not path.is_file():
                fail(f"Refusing non-regular file in Pages artifact: {path}")
            yield path


def prepare(source_arg: str, output_arg: str) -> None:
    source = Path(source_arg).expanduser().resolve()
    if not source.is_dir():
        fail(f"Pages source directory does not exist: {source}")
    if not any((source / name).is_file() and not (source / name).is_symlink() for name in ENTRYPOINTS):
        fail(f"Pages source directory needs index.html or index.htm at its root: {source}")
    output = Path(output_arg).expanduser().resolve()
    if output == source or source in output.parents:
        fail("Pages archive output must be outside the source directory")
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".opfield-pages-", delete=False) as handle:
        temporary = Path(handle.name)
    file_count = 0
    try:
        with temporary.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    for path in iter_entries(source):
                        relative = path.relative_to(source).as_posix()
                        stat = path.stat()
                        info = normalized_info(
                            archive.gettarinfo(str(path), arcname=relative), executable=bool(stat.st_mode & 0o111)
                        )
                        if path.is_dir():
                            archive.addfile(info)
                        else:
                            file_count += 1
                            with path.open("rb") as item:
                                archive.addfile(info, item)
        if file_count == 0:
            fail("Pages source directory contains no files")
        temporary.replace(output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise

    size, sha256 = file_digest(output)
    if size < 1:
        fail("Pages archive is empty")
    print(json.dumps({
        "archive": str(output),
        "size": size,
        "sha256": sha256,
        "format": "tar.gz",
        "files": file_count,
    }))


def chunk(artifact_arg: str, offset: int, size: int) -> None:
    artifact = Path(artifact_arg).expanduser().resolve()
    if not artifact.is_file():
        fail(f"Pages artifact does not exist: {artifact}")
    total = artifact.stat().st_size
    if offset < 0 or offset > total:
        fail(f"Offset {offset} is outside artifact size {total}")
    if size < 1 or size > CHUNK_MAX:
        fail(f"Chunk size must be between 1 and {CHUNK_MAX}")
    with artifact.open("rb") as handle:
        handle.seek(offset)
        data = handle.read(size)
    next_offset = offset + len(data)
    print(json.dumps({
        "offset": offset,
        "nextOffset": next_offset,
        "eof": next_offset >= total,
        "contentBase64": base64.b64encode(data).decode("ascii"),
    }))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser(
        "inspect", help="Report size, SHA-256, and format of one file to upload as is (HTML page or .tar.gz)"
    )
    inspect_parser.add_argument("artifact")

    prepare_parser = subparsers.add_parser(
        "prepare", help="Pack a site directory with index.html at its root into a deterministic .tar.gz"
    )
    prepare_parser.add_argument("source")
    prepare_parser.add_argument("--output", required=True)

    chunk_parser = subparsers.add_parser("chunk", help="Read one base64-encoded MCP upload chunk")
    chunk_parser.add_argument("artifact")
    chunk_parser.add_argument("--offset", type=int, required=True)
    chunk_parser.add_argument("--size", type=int, default=CHUNK_MAX)

    args = parser.parse_args()
    if args.command == "inspect":
        inspect(args.artifact)
    elif args.command == "prepare":
        prepare(args.source, args.output)
    else:
        chunk(args.artifact, args.offset, args.size)


if __name__ == "__main__":
    main()
