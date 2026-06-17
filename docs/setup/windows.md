# Windows setup

## Requirements

- [Node.js](https://nodejs.org/) **18+** (LTS recommended)
- Git (optional) or download the [release zip](https://github.com/surgeon13/t.bot/releases)

## Install

**PowerShell** (project folder):

```powershell
cd D:\path\to\t.bot
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

Or manually:

```powershell
npm install
copy config.example.json config.json
notepad config.json
```

Edit `url`, `username`, `password`.

## Run

```powershell
npm run gui
```

The dashboard opens at **http://127.0.0.1:3733** automatically.

Development with hot reload:

```powershell
npm run gui:dev
```

Stop a stuck GUI on port 3733:

```powershell
npm run gui:stop
```

## Environment variables (cmd)

```cmd
set PORT=3734
set OPEN_BROWSER=0
npm run gui
```

## Release zip

1. Download `t.bot-v<version>.zip` from [Releases](https://github.com/surgeon13/t.bot/releases)  
2. Unzip to e.g. `D:\t.game\t.bot`  
3. Run `scripts\install.ps1` or `npm install`  
4. `npm run gui`

Do **not** commit `config.json` or copy it into the zip when sharing.
