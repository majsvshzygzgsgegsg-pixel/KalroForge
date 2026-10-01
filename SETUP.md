# KairoForge setup

This page is the quick setup guide for running KairoForge from the GitHub project.

## 1. Clone and install

```sh
git clone https://github.com/majsvshzygzgsgegsg-pixel/KalroForge.git
cd KalroForge
corepack enable
pnpm install
```

## 2. Open KairoForge from the project folder

Run any one of these while your terminal is inside the `KalroForge` folder:

```sh
pnpm run kairoforge
pnpm run web
pnpm run open
pnpm run kf
pnpm run launch
pnpm run start:kairoforge
./scripts/kairoforge
./scripts/open-kairoforge.sh
./scripts/start-kairoforge
```

The launcher prints a secure URL like:

```text
http://127.0.0.1:3080/?token=YOUR_TOKEN
```

Open the full token URL. If you open only `http://127.0.0.1:3080/`, the app may look disconnected or stale.

## 3. Open KairoForge from anywhere

Install the shortcuts once:

```sh
cd KalroForge
pnpm run install:command
```

After that, these commands work from any folder:

```sh
kairoforge
kf
kairoforge-open
```

## 4. Phone / LAN access

Start KairoForge normally and use the printed LAN URL, for example:

```text
http://192.168.1.184:3080/?token=YOUR_TOKEN
```

Your phone and computer must be on the same Wi‑Fi network. If macOS asks, allow incoming network connections.

## 5. Useful options

Use another port:

```sh
KAIROFORGE_PORT=3090 pnpm run kairoforge
```

Only bind to this computer:

```sh
KAIROFORGE_HOST=127.0.0.1 pnpm run kairoforge
```

## 6. Build and check before publishing

```sh
pnpm run build
git status --short
git push origin master
```

Do not commit local private files, chat exports, tokens, or secrets.
