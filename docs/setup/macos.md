# macOS setup

## Install

```bash
git clone https://github.com/surgeon13/t.bot.git
cd t.bot
bash scripts/install.sh
```

Requires **Node.js 18+**. Install via [nodejs.org](https://nodejs.org/) or Homebrew:

```bash
brew install node
```

Then:

```bash
bash scripts/install.sh
```

## Configure

```bash
cp config.example.json config.json
nano config.json   # or open in your editor
```

Set `url`, `username`, `password`.

**Optional:** install Google Chrome for better headless video support — t.bot tries Chrome when `"browserChannel": true` (default).

## Run

```bash
npm run gui
```

Opens **http://127.0.0.1:3733** in your default browser.

Skip auto-open:

```bash
OPEN_BROWSER=0 npm run gui
```

## Dev

```bash
npm run gui:dev
```
