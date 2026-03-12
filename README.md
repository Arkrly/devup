<!-- prettier-ignore -->
<div align="center">

# tunnelup

*Universal dev server + Cloudflare tunnel launcher*

[![Node.js](https://img.shields.io/badge/Node.js->=18-3c873a?style=flat-square)](https://nodejs.org)

[Features](#features) • [Installation](#installation) • [Quick Start](#quick-start) • [Usage](#usage) • [Configuration](#configuration) • [Supported Frameworks](#supported-frameworks)

</div>

`tunnelup` automatically detects your project type, starts your development server, and creates a Cloudflare tunnel to expose it to the internet. Perfect for sharing local development builds with teammates or testing webhooks.

## Features

- **Auto-detection** - Automatically detects Next.js, Vite, Expo, Remix, Python/FastAPI, Django, Go, Docker Compose, Rust, and more
- **Cloudflare Tunnels** - Instantly create public URLs to share your local development server
- **Multi-service Support** - Run multiple services simultaneously, each with its own tunnel
- **Zero Config** - Works out of the box with smart defaults; optional configuration file for full control
- **Port Detection** - Automatically detects the port your dev server is running on

## Installation

```bash
npm install -g tunnelup
```

You also need to install `cloudflared`:

```bash
# macOS
brew install cloudflared

# Linux (Arch)
yay -S cloudflared

# Other platforms
# See https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

## Quick Start

```bash
# Just run in your project directory
tunnelup

# Or initialize a config file first
tunnelup init
```

## Usage

```bash
# Start dev server with tunnel (auto-detect project type)
tunnelup

# Override port
tunnelup -p 8080

# Override dev command
tunnelup -c "npm run dev"

# Initialize configuration file
tunnelup init
```

## Configuration

Create a `tunnelup.config.json` in your project root:

```json
{
  "services": [
    {
      "name": "web",
      "port": 3000,
      "cmd": "npm run dev",
      "cwd": "."
    },
    {
      "name": "api",
      "port": 4000,
      "cmd": "uv run uvicorn main:app --reload",
      "cwd": "./api"
    }
  ]
}
```

### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `services` | array | Array of services to start |
| `services[].name` | string | Service name for display |
| `services[].port` | number | Expected port number |
| `services[].cmd` | string | Dev command to run |
| `services[].cwd` | string | Working directory (default: `.`) |

## Supported Frameworks

`tunnelup` automatically detects and configures these frameworks:

| Framework | Detected By | Default Command |
|-----------|-------------|-----------------|
| Next.js | `package.json` + `next` dependency | `npm run dev` |
| Vite | `vite.config.js/ts` | `npm run dev` |
| Expo | `expo` dependency | `npm run dev` |
| Remix | `remix` dependency | `npm run dev` |
| Node.js | `package.json` + `dev` script | `npm run dev` |
| Python FastAPI | `pyproject.toml` + `fastapi` | `uv run uvicorn main:app --reload` |
| Django | `manage.py` | `python manage.py runserver` |
| Go | `go.mod` | `go run .` |
| Docker Compose | `docker-compose.yml` | `docker compose up` |
| Rust | `Cargo.toml` | `cargo run` |
| Maven (Spring Boot) | `pom.xml` | `mvn spring-boot:run` |
| Gradle (Spring Boot) | `build.gradle` | `./gradlew bootRun` |

## How It Works

1. **Detection** - Scans your project for configuration files to identify the framework
2. **Port Discovery** - Monitors network ports to find the one your dev server opens
3. **Server Start** - Runs your dev command and waits for the server to be ready
4. **Tunnel Creation** - Launches Cloudflare tunnel to expose your local server
5. **URL Display** - Shows the public URL where your app is accessible

## Requirements

- Node.js 18+
- cloudflared (installed and authenticated with `cloudflared tunnel login`)

> [!NOTE]
> If you're not authenticated with Cloudflare, run `cloudflared tunnel login` before using `tunnelup`.
