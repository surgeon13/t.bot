# Linux setup (Debian / Ubuntu)

## Install

```bash
git clone https://github.com/surgeon13/t.bot.git
cd t.bot
bash scripts/install.sh
```

`install.sh` installs Playwright system libraries (via `apt` on Debian/Ubuntu and
derivatives such as Mint, Pop!_OS and Kali) and runs `npm install`.

Package names are resolved per release, so Ubuntu **24.04+** and Debian **13+**
— where several libs were renamed with a `t64` suffix — are handled
automatically. If a library is unavailable, the script says so and the install
continues; a missing lib shows up later as a browser launch error.

Running non-interactively (CI, `npm run setup` from a script) answers the apt
and Node prompts with their defaults instead of hanging.

### Node.js 18+ not installed?

```bash
bash scripts/install-node-linux.sh
bash scripts/install.sh
```

Or install from [nodejs.org](https://nodejs.org/) / your distro package manager.

## Configure

```bash
cp config.example.json config.json
nano config.json
```

Set `url`, `username`, `password`. **`headless: true`** is fine for servers without a display.

## Run

```bash
npm run gui
```

Headless server (SSH, no browser tab):

```bash
OPEN_BROWSER=0 npm run gui
```

Remote dashboard via SSH tunnel:

```bash
# on your PC
ssh -L 3733:127.0.0.1:3733 user@your-server
```

Then open **http://127.0.0.1:3733**.

## Other distros (Fedora, Arch, …)

Install Node 18+ and Playwright’s [Linux dependencies](https://playwright.dev/docs/library#system-requirements) for your distro, then:

```bash
cd t.bot
npm install
```

Use `npx playwright install-deps` if available for your package manager.
