# Raspberry Pi setup

Tested flow for **Raspberry Pi 3B+ / 4 / 5** with **Raspberry Pi OS** (Debian-based). Pi **3B (1 GB RAM)** works in **headless** mode with extra swap; prefer **64-bit** Pi OS (`uname -m` → `aarch64`).

## 1. System packages + Node

```bash
cd ~
git clone https://github.com/surgeon13/t.bot.git
cd t.bot

# Installs apt deps, checks Node 18+, runs npm install
bash scripts/install.sh
```

If Node.js is missing, install Node 20 first:

```bash
bash scripts/install-node-linux.sh
bash scripts/install.sh
```

**Optional — extra swap on 1 GB Pi:**

```bash
bash scripts/setup-pi-swap.sh
```

## 2. Configure

```bash
cp config.example.json config.json
nano config.json
```

Recommended on Pi:

```json
{
  "headless": true,
  "browserChannel": false
}
```

- **`headless`** — no desktop needed  
- **`browserChannel: false`** — use Playwright Chromium (Google Chrome is usually not installed on Pi)

Copy an existing **`config.json`** from your PC if you already use t.bot.

## 3. Run the GUI

```bash
export OPEN_BROWSER=0
npm run gui
```

Check:

```bash
curl -s http://127.0.0.1:3733/api/health
```

## 4. Open the dashboard from your PC

The GUI binds to **localhost** by default. From your laptop:

```bash
ssh -L 3733:127.0.0.1:3733 pi@YOUR_PI_IP
```

Then open **http://127.0.0.1:3733** in your browser.

**LAN access (optional):** bind on all interfaces (only on a trusted home network):

```bash
export HOST=0.0.0.0
export OPEN_BROWSER=0
npm run gui
```

Open **http://YOUR_PI_IP:3733** from another device on the same network.

## 5. Run in background

```bash
cd ~/t.bot
export OPEN_BROWSER=0
nohup npm run gui > data/gui.out.log 2>&1 &
```

Stop:

```bash
npm run gui:stop
# or: pkill -f "node gui.js"
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `npm install` / Chromium fails on **32-bit** OS (`armv7l`) | Use **64-bit** Raspberry Pi OS, or see [troubleshooting.md](../troubleshooting.md) |
| Out of memory | Run `scripts/setup-pi-swap.sh`; close other apps |
| Slow first login | Normal on Pi 3 — wait 30–60 s |
| Port in use | `npm run gui:stop` then start again |

See also [linux.md](linux.md) and [troubleshooting.md](../troubleshooting.md).
