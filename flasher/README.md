# GaggiMate Nightly Flasher

A tiny, locally hosted website that flashes GaggiMate controller/display
firmware straight from your browser using [ESP Web Tools](https://esphome.github.io/esp-web-tools/)
and Web Serial. It pulls the latest firmware from this fork's `nightly`
GitHub release, so it always matches whatever the last push to `master`
built.

## Prerequisites

- Python 3.8+ (standard library only, no `pip install` needed).
- Chrome or Edge (Web Serial support). Firefox/Safari are not supported by
  ESP Web Tools.
- A USB cable to the device you want to flash.

## Usage

```sh
python3 flasher/serve.py
```

Then open <http://localhost:8000> in Chrome or Edge.

On startup the server syncs the `nightly` release from
`https://github.com/lloyd-g-w/gaggimate/releases/tag/nightly`, downloading
any firmware files that changed since the last run into `flasher/cache/`.
Once synced, each of the four cards on the page (Controller, Display,
Headless, Headless T8-S3) gets an **Install** button. Click it, pick the
serial port for your device, and follow the prompts.

Useful CLI flags:

```sh
python3 flasher/serve.py --port 8080          # use a different port
python3 flasher/serve.py --bind 0.0.0.0        # let other devices on your LAN reach it
python3 flasher/serve.py --repo you/your-fork --tag nightly   # point at a different fork/tag
python3 flasher/serve.py --offline             # skip GitHub, just serve whatever is already cached
```

## GitHub Pages

This same site is also deployed automatically to GitHub Pages on every push
to `master` (via `.github/workflows/build-nightly.yml`), so most people
never need to run anything locally:

**<https://lloyd-g-w.github.io/gaggimate/flash/>**

It works the same way as the local server, except firmware readiness and
version info come from static files next to it on Pages (`../nightly/`)
instead of a local sync, and the "Refresh from GitHub" button becomes
"Re-check files" (it just re-checks what's already published, since
GitHub Pages has no backend to trigger a download from).

**One-time setup for a fork** (skip if already enabled): go to the repo's
**Settings → Pages**, set *Source* to **Deploy from a branch**, pick branch
`gh-pages` and folder `/ (root)`, then **Save**. The next push to `master`
populates `gh-pages:/flash/` and `gh-pages:/nightly/` automatically.

Use the **local server** below instead when you want it to work offline
once firmware is cached, want to point at a different fork/tag, or don't
want to depend on GitHub Pages being enabled.

## What each target is

| Card | Hardware | Notes |
| --- | --- | --- |
| Controller | GaggiMate controller board | Pump/valve/sensor firmware. |
| Display — LilyGo T-RGB | Standard GaggiMate touchscreen | Includes the embedded web UI filesystem image. |
| Headless | T-RGB class board, no screen | Includes the web UI filesystem image; access the UI over Wi-Fi. |
| Headless — LilyGo T8-S3 (fork) | T8-S3 headless build from this fork | Uses an SD card instead of a filesystem partition; no filesystem image is flashed. |

Every install also (re)writes an all-`0xFF` 8 KB image at the `otadata`
partition offset (`0xE000`). This resets the bootloader's OTA slot pointer
so the freshly flashed firmware boots immediately, even if the device
previously had OTA updates applied.

## How nightly firmware gets built

`.github/workflows/build-nightly.yml` runs on every push to `master`. It
builds all four firmware variants with PlatformIO and updates the `nightly`
GitHub release (a rolling prerelease) with the new binaries and a
`version.txt`. This tool just mirrors that release locally so you can flash
over USB — no separate build step needed on your machine.

## Offline mode

`--offline` skips the GitHub API call entirely and serves whatever is
already in `flasher/cache/`. Useful if GitHub is unreachable, you've hit an
API rate limit, or you're working somewhere without internet access. The
page will show which targets are ready based on what's cached.

## Cache location

Downloaded firmware and sync metadata live in `flasher/cache/` (gitignored).
Delete that directory to force a full re-download.

## Troubleshooting

- **GitHub API rate limit / "could not reach GitHub API" errors**: set a
  `GITHUB_TOKEN` environment variable (a plain classic or fine-grained token
  with no special scopes is enough for reading public release metadata)
  before running `serve.py`. This raises the unauthenticated 60
  requests/hour limit substantially.
- **Device not detected / no serial port listed**: on Linux, add your user
  to the `dialout` group (`sudo usermod -aG dialout $USER`, then log out and
  back in) or check your distro's udev rules for USB-serial adapters. Try
  holding the `BOOT` button on the board while plugging in the USB cable.
- **Install button greyed out / card says "Not ready"**: the firmware for
  that target hasn't been downloaded yet. Click "Refresh from GitHub", or
  check the server's terminal output for download errors.
