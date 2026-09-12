<p align="center">
<img src="docs/assets/logo.png" alt="Logo" width="250px" />
<br />
  
[![](https://dcbadge.vercel.app/api/server/APw7rgPGPf)](https://discord.gg/APw7rgPGPf)
[![CC BY-NC-SA 4.0][cc-by-nc-sa-shield]][cc-by-nc-sa]
[![Sonar QG][sonar-shield]][sonar-url]
[![Sonar Violations][sonar-violations]][sonar-url]
[![Sonar Tech Debt][sonar-tech-debt]][sonar-url]


</p>

This project upgrades a Gaggia espresso machine with smart controls to improve your coffee-making experience. By adding a display and custom electronics, you can monitor and control the machine more easily.

<img src="docs/assets/gaggimate_poster.jpg" alt="Gaggia Classic Installation" width="500" />

## Features

- **Temperature Control**: Monitor the boiler temperature to ensure optimal brewing conditions.
- **Brew timer**: Set a target duration and run the brewing for the specific time.
- **Steam and Hot Water mode**: Control the pump and valve to run the respective task.
- **Safety Features**: Automatic shutoff if the system becomes unresponsive or overheats.
- **User Interface**: Simple, intuitive display to control and monitor the machine.

## Screenshots and Images

<img src="docs/assets/standby-screen.png" alt="Standby Screen" width="300px" />
<img src="docs/assets/brew-screen.png" alt="Brew Screen" width="300px" />
<img src="docs/assets/pcb_render.png" alt="PCB Render" width="300px" />

### How to buy

You can buy your kit on https://shop.gaggimate.eu/

## How It Works

The display allows you to control the espresso machine and see live temperature updates. If the machine becomes unresponsive or the temperature goes too high, it will automatically turn off for safety.

## Docs

The docs were moved to [https://gaggimate.eu/](https://gaggimate.eu/). You can find all sourcing and assembly information there.
Additional documentation for the WebSocket API can be found in [docs/websocket-api.yaml](docs/websocket-api.yaml).

### Fork additions

- **Web flasher** — flash the controller, display (LilyGo T-RGB), headless or LilyGo T8-S3 with the latest nightly from your browser: [lloyd-g-w.github.io/gaggimate/flash](https://lloyd-g-w.github.io/gaggimate/flash/) (or run it locally, see [flasher/README.md](flasher/README.md)).
- **LilyGo T8-S3 headless** build with SD-card storage (`display-headless-t8`).
- **Rotate display 180°** — Settings → General → Display, for upside-down mounted screens.
- **Hold brew button to flush** (momentary switches) — hold ≥ 1 s to flush until released; a short press brews as usual.
- **Discord shot feedback** — rate shots with reactions, add grind/dose/bean/notes by replying (optionally parsed by an AI model): [docs/discord-shot-feedback.md](docs/discord-shot-feedback.md). Two modes: run it on the display, or offload it to the **Gaggibot** container ([gaggibot/](gaggibot/)) so the ESP32 only uploads the shot and polls for the answers.


## License

This work is licensed under CC BY-NC-SA 4.0. To view a copy of this license, visit https://creativecommons.org/licenses/by-nc-sa/4.0/

[sonar-violations]: https://img.shields.io/sonar/blocker_violations/jniebuhr_gaggimate?server=https%3A%2F%2Fsonarcloud.io&style=for-the-badge
[sonar-shield]: https://img.shields.io/sonar/quality_gate/jniebuhr_gaggimate?server=https%3A%2F%2Fsonarcloud.io&style=for-the-badge
[sonar-tech-debt]: https://img.shields.io/sonar/tech_debt/jniebuhr_gaggimate?server=https%3A%2F%2Fsonarcloud.io&style=for-the-badge
[sonar-url]: https://sonarcloud.io/project/overview?id=jniebuhr_gaggimate
[cc-by-nc-sa]: http://creativecommons.org/licenses/by-nc-sa/4.0/
[cc-by-nc-sa-image]: https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png
[cc-by-nc-sa-shield]: https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg?style=for-the-badge
