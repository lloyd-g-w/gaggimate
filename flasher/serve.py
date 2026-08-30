#!/usr/bin/env python3
"""Local web flasher for GaggiMate nightly firmware.

Serves a small website (ESP Web Tools based) that flashes GaggiMate
controller/display/headless firmware pulled from the project's GitHub
"nightly" release. Uses only the Python standard library.

Usage:
    python3 serve.py [--port 8000] [--repo lloyd-g-w/gaggimate]
                      [--tag nightly] [--bind 127.0.0.1] [--offline]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

FLASHER_DIR = Path(__file__).resolve().parent
CACHE_DIR = FLASHER_DIR / "cache"
META_PATH = CACHE_DIR / "meta.json"

BOOT_APP0_NAME = "boot_app0.bin"
BOOT_APP0_SIZE = 8192  # 0x2000 bytes, matches the otadata partition size.

# otadata reset image: forces the bootloader to (re)select the freshly
# flashed app at 0x10000 instead of a stale OTA slot pointer left over
# from a previous install.
OTADATA_OFFSET = 0xE000

# Known release assets this tool understands, keyed by logical target.
# Each entry lists (asset_name, flash_offset) pairs in flashing order.
ASSET_LAYOUT = {
    "controller": [
        ("board-bootloader.bin", 0x0),
        ("board-partitions.bin", 0x8000),
        ("board-firmware.bin", 0x10000),
    ],
    "display": [
        ("display-bootloader.bin", 0x0),
        ("display-partitions.bin", 0x8000),
        ("display-firmware.bin", 0x10000),
        ("display-filesystem.bin", 0xC90000),
    ],
    "headless": [
        ("display-headless-bootloader.bin", 0x0),
        ("display-headless-partitions.bin", 0x8000),
        ("display-headless-firmware.bin", 0x10000),
        ("display-headless-filesystem.bin", 0xC90000),
    ],
    "headless-t8": [
        ("display-headless-t8-bootloader.bin", 0x0),
        ("display-headless-t8-partitions.bin", 0x8000),
        ("display-headless-t8-firmware.bin", 0x10000),
    ],
}

TARGET_NAMES = {
    "controller": "GaggiMate Controller",
    "display": "GaggiMate Display (LilyGo T-RGB)",
    "headless": "GaggiMate Headless (T-RGB class board)",
    "headless-t8": "GaggiMate Headless (LilyGo T8-S3, fork)",
}

# All firmware asset names we ever expect to see in the release, used as an
# allowlist for /firmware/<name> and to know what to download.
KNOWN_ASSET_NAMES = sorted(
    {name for parts in ASSET_LAYOUT.values() for name, _ in parts} | {"version.txt"}
)

ALLOWED_FIRMWARE_NAMES = set(KNOWN_ASSET_NAMES) | {BOOT_APP0_NAME}

# Explicit allowlist of extra static files servable from flasher/ itself
# (e.g. a favicon dropped next to index.html). Everything else in this
# directory, notably serve.py and README.md, must never be served over
# HTTP -- this is not a general static file server.
STATIC_ASSET_TYPES = {
    "favicon.ico": "image/x-icon",
    "favicon.png": "image/png",
}


class SyncError(Exception):
    pass


def ensure_boot_app0() -> None:
    """Create (or repair) the locally generated otadata-reset image.

    The file must be exactly BOOT_APP0_SIZE bytes of 0xFF. It is never
    downloaded; content is verified so a corrupted or foreign file is
    atomically regenerated.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / BOOT_APP0_NAME
    expected = b"\xff" * BOOT_APP0_SIZE
    if path.exists():
        try:
            if path.read_bytes() == expected:
                return
        except OSError:
            pass
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as f:
        f.write(expected)
    os.replace(tmp, path)


def load_meta() -> dict:
    if META_PATH.exists():
        try:
            return json.loads(META_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_meta(meta: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = META_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, indent=2, sort_keys=True))
    os.replace(tmp, META_PATH)


def github_headers() -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "gaggimate-flasher/1.0",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def http_get_json(url: str, timeout: float = 10.0) -> dict:
    req = urllib.request.Request(url, headers=github_headers())
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_download(url: str, dest: Path, timeout: float = 30.0) -> int:
    req = urllib.request.Request(url, headers=github_headers())
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    size = 0
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(tmp, "wb") as out:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            out.write(chunk)
            size += len(chunk)
    os.replace(tmp, dest)
    return size


def sync_release(repo: str, tag: str, log=print) -> "tuple[dict, list[str]]":
    """Fetch release metadata and download any missing/changed assets.

    Returns (meta, failures): the updated meta dict plus a list of
    per-asset download failure descriptions. Raises SyncError if the API
    call itself fails (no cache to fall back to is handled by the caller).
    """
    api_url = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    try:
        release = http_get_json(api_url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        raise SyncError(f"could not reach GitHub API: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SyncError(f"unexpected GitHub API response: {exc}") from exc

    if "assets" not in release:
        message = release.get("message", "unknown error")
        raise SyncError(f"GitHub API error for {repo}@{tag}: {message}")

    meta = load_meta()
    # Never trust cached asset records from a different repo/tag: a manifest
    # must not be assembled from binaries belonging to another release.
    if (meta.get("repo"), meta.get("tag")) != (repo, tag):
        meta["assets"] = {}
    meta.update(
        {
            "repo": repo,
            "tag": tag,
            "published_at": release.get("published_at"),
            "synced_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    )
    assets_meta = meta.setdefault("assets", {})

    # boot_app0.bin is deliberately excluded (KNOWN_ASSET_NAMES, not
    # ALLOWED_FIRMWARE_NAMES): it is always generated locally and a release
    # asset with that name must never overwrite it.
    remote_by_name = {a["name"]: a for a in release.get("assets", []) if a.get("name") in KNOWN_ASSET_NAMES}

    # Drop records for assets that are no longer part of the current release
    # so target_ready() cannot be satisfied by stale binaries.
    for stale in set(assets_meta) - set(remote_by_name):
        assets_meta.pop(stale, None)

    failures: list[str] = []
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    for name, asset in remote_by_name.items():
        dest = CACHE_DIR / name
        cached = assets_meta.get(name, {})
        needs_download = (
            not dest.exists()
            or cached.get("updated_at") != asset.get("updated_at")
            or cached.get("size") != asset.get("size")
        )
        if needs_download:
            log(f"  downloading {name} ({asset.get('size', 0)} bytes)...")
            try:
                size = http_download(asset["browser_download_url"], dest)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
                log(f"  ! failed to download {name}: {exc}")
                failures.append(f"{name}: {exc}")
                # Ensure a stale record cannot mark this asset as current.
                assets_meta.pop(name, None)
                continue
            assets_meta[name] = {
                "updated_at": asset.get("updated_at"),
                "size": size,
                "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        else:
            log(f"  cached    {name} ({cached.get('size', 0)} bytes)")

    version_path = CACHE_DIR / "version.txt"
    if version_path.exists():
        try:
            meta["version"] = version_path.read_text().strip()
        except OSError:
            meta["version"] = None
    else:
        meta["version"] = None

    save_meta(meta)
    return meta, failures


def target_ready(meta: dict, target: str) -> bool:
    assets_meta = meta.get("assets", {})
    for name, _offset in ASSET_LAYOUT[target]:
        if name not in assets_meta:
            return False
        if not (CACHE_DIR / name).exists():
            return False
    return (CACHE_DIR / BOOT_APP0_NAME).exists()


def build_manifest(meta: dict, target: str) -> dict:
    parts = [{"path": f"/firmware/{BOOT_APP0_NAME}", "offset": OTADATA_OFFSET}]
    for name, offset in ASSET_LAYOUT[target]:
        parts.append({"path": f"/firmware/{name}", "offset": offset})
    parts.sort(key=lambda p: p["offset"])
    return {
        "name": TARGET_NAMES[target],
        "version": meta.get("version") or "unknown",
        "new_install_prompt_erase": True,
        "builds": [
            {
                "chipFamily": "ESP32-S3",
                "parts": parts,
            }
        ],
    }


def build_status(meta: dict, offline: bool, error: str | None, repo: str, tag: str) -> dict:
    assets_meta = meta.get("assets", {})
    assets = {}
    for name in KNOWN_ASSET_NAMES:
        cached = (CACHE_DIR / name).exists()
        info = assets_meta.get(name, {})
        assets[name] = {
            "size": info.get("size"),
            "updated_at": info.get("updated_at"),
            "cached": cached,
        }
    return {
        "repo": repo,
        "tag": tag,
        "version": meta.get("version"),
        "published_at": meta.get("published_at"),
        "synced_at": meta.get("synced_at"),
        "offline": offline,
        "ready": {target: target_ready(meta, target) for target in ASSET_LAYOUT},
        "assets": assets,
        "error": error,
    }


class FlasherState:
    """Shared, lock-protected server state (repo/tag/offline flag + meta)."""

    def __init__(self, repo: str, tag: str, offline: bool):
        self.repo = repo
        self.tag = tag
        self.offline = offline
        self.lock = threading.Lock()
        self.last_error: str | None = None
        self.cache_mismatch: str | None = None
        self.meta = load_meta()
        # A cache written for a different repo/tag must never be served for
        # the currently configured one (offline mode included).
        cached_repo, cached_tag = self.meta.get("repo"), self.meta.get("tag")
        if self.meta and (cached_repo, cached_tag) != (repo, tag) and cached_repo is not None:
            self.cache_mismatch = (
                f"cached firmware belongs to {cached_repo}@{cached_tag}, "
                f"not {repo}@{tag}; run without --offline to re-sync"
            )
            self.meta = {}

    def refresh(self, log=print) -> dict:
        with self.lock:
            if self.offline:
                if self.cache_mismatch:
                    self.last_error = self.cache_mismatch
                elif not any(target_ready(self.meta, t) for t in ASSET_LAYOUT):
                    self.last_error = (
                        f"offline mode: no cached firmware for {self.repo}@{self.tag}; "
                        "run once without --offline to download it"
                    )
                else:
                    self.last_error = None
                return build_status(self.meta, self.offline, self.last_error, self.repo, self.tag)
            try:
                self.meta, failures = sync_release(self.repo, self.tag, log=log)
                self.cache_mismatch = None
                if failures:
                    self.last_error = (
                        "sync incomplete, some assets failed to download "
                        "(serving cached copies where available): " + "; ".join(failures)
                    )
                    log(f"  ! {self.last_error}")
                else:
                    self.last_error = None
            except SyncError as exc:
                self.last_error = str(exc)
                log(f"  ! sync failed, using cache: {exc}")
            return build_status(self.meta, self.offline, self.last_error, self.repo, self.tag)

    def status(self) -> dict:
        with self.lock:
            return build_status(self.meta, self.offline, self.last_error, self.repo, self.tag)

    def manifest(self, target: str) -> dict | None:
        if target not in ASSET_LAYOUT:
            return None
        with self.lock:
            return build_manifest(self.meta, target)


def make_handler(state: FlasherState):
    class Handler(BaseHTTPRequestHandler):
        server_version = "GaggiMateFlasher/1.0"

        def log_message(self, fmt, *args):  # quieter default logging
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass

        def _send_text(self, text: str, status: HTTPStatus = HTTPStatus.OK, content_type="text/plain"):
            body = text.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass

        def _send_file(self, path: Path, content_type: str, cache_control: str | None = None):
            try:
                data = path.read_bytes()
            except OSError:
                self._send_text("Not found", HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            if cache_control:
                self.send_header("Cache-Control", cache_control)
            self.end_headers()
            try:
                self.wfile.write(data)
            except BrokenPipeError:
                pass

        def _safe_static_path(self, rel_name: str) -> Path | None:
            """Resolve rel_name under FLASHER_DIR, rejecting traversal."""
            candidate = (FLASHER_DIR / rel_name).resolve()
            try:
                candidate.relative_to(FLASHER_DIR.resolve())
            except ValueError:
                return None
            return candidate

        def do_GET(self):  # noqa: N802 (http.server naming convention)
            parsed = urlsplit(self.path)
            path = unquote(parsed.path)

            if path == "/" or path == "/index.html":
                self._send_file(FLASHER_DIR / "index.html", "text/html; charset=utf-8")
                return

            if path == "/api/status":
                self._send_json(state.status())
                return

            if path.startswith("/manifests/") and path.endswith(".json"):
                target = path[len("/manifests/"):-len(".json")]
                manifest = state.manifest(target)
                if manifest is None:
                    self._send_json({"error": f"unknown target '{target}'"}, HTTPStatus.NOT_FOUND)
                    return
                self._send_json(manifest)
                return

            if path.startswith("/api/"):
                # Any other /api/* GET is a JSON 404, not plain text.
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return

            if path.startswith("/firmware/"):
                name = path[len("/firmware/"):]
                if "/" in name or ".." in name or name not in ALLOWED_FIRMWARE_NAMES:
                    self._send_text("Not found", HTTPStatus.NOT_FOUND)
                    return
                file_path = CACHE_DIR / name
                if not file_path.is_file():
                    self._send_text("Not found", HTTPStatus.NOT_FOUND)
                    return
                self._send_file(file_path, "application/octet-stream", "no-store")
                return

            # Fall back to serving a small allowlist of static assets that
            # may live directly inside flasher/ (e.g. a favicon). This is
            # intentionally NOT a general static file server: source files
            # like serve.py/README.md must never be served over HTTP.
            rel_name = path.lstrip("/")
            if rel_name in STATIC_ASSET_TYPES:
                safe_path = self._safe_static_path(rel_name)
                if (
                    safe_path is not None
                    and safe_path.is_file()
                    and safe_path.parent == FLASHER_DIR.resolve()
                ):
                    self._send_file(safe_path, STATIC_ASSET_TYPES[rel_name])
                    return

            self._send_text("Not found", HTTPStatus.NOT_FOUND)

        def do_POST(self):  # noqa: N802
            parsed = urlsplit(self.path)
            path = unquote(parsed.path)

            if path == "/api/refresh":
                status = state.refresh(log=lambda msg: print(msg, flush=True))
                self._send_json(status)
                return

            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--repo", default="lloyd-g-w/gaggimate")
    parser.add_argument("--tag", default="nightly")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--offline", action="store_true", help="skip GitHub sync, serve cached firmware only")
    args = parser.parse_args()

    ensure_boot_app0()

    state = FlasherState(repo=args.repo, tag=args.tag, offline=args.offline)

    if args.offline:
        print(f"[flasher] offline mode: serving cached firmware from {CACHE_DIR}")
    else:
        print(f"[flasher] syncing {args.repo}@{args.tag} from GitHub...")
    status = state.refresh(log=print)
    if status.get("error"):
        print(f"[flasher] warning: {status['error']}")
    print(f"[flasher] version: {status.get('version')!r}, ready targets: "
          f"{[t for t, ok in status.get('ready', {}).items() if ok]}")

    handler_cls = make_handler(state)
    httpd = ThreadingHTTPServer((args.bind, args.port), handler_cls)
    print(f"[flasher] serving on http://{args.bind}:{args.port} (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[flasher] shutting down...")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
