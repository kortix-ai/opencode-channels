#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# setup-e2e.sh — Automated E2E test environment setup for opencode-channels.
#
# Checks prerequisites, installs dependencies, and creates .env.test template.
#
# Usage:
#   chmod +x scripts/setup-e2e.sh
#   ./scripts/setup-e2e.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  opencode-channels — E2E Setup${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

ERRORS=0

# ── Check Node.js ────────────────────────────────────────────────────────────

echo -n "Checking Node.js... "
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v)
  echo -e "${GREEN}$NODE_VERSION${NC}"
else
  echo -e "${RED}NOT FOUND${NC}"
  echo "  Install Node.js 18+ from https://nodejs.org"
  ERRORS=$((ERRORS + 1))
fi

# ── Check pnpm ───────────────────────────────────────────────────────────────

echo -n "Checking pnpm... "
if command -v pnpm &>/dev/null; then
  PNPM_VERSION=$(pnpm -v)
  echo -e "${GREEN}v$PNPM_VERSION${NC}"
else
  echo -e "${RED}NOT FOUND${NC}"
  echo "  Install pnpm: npm install -g pnpm"
  ERRORS=$((ERRORS + 1))
fi

# ── Check ngrok ──────────────────────────────────────────────────────────────

echo -n "Checking ngrok... "
if command -v ngrok &>/dev/null; then
  echo -e "${GREEN}installed${NC}"
else
  echo -e "${YELLOW}NOT FOUND (optional)${NC}"
  echo "  Install ngrok for local dev: https://ngrok.com/download"
  echo "  Or use any public URL (Cloudflare Tunnel, server IP, etc.)"
fi

# ── Check OpenCode ───────────────────────────────────────────────────────────

echo -n "Checking OpenCode CLI... "
if command -v opencode &>/dev/null; then
  echo -e "${GREEN}installed${NC}"
else
  echo -e "${YELLOW}NOT FOUND (optional)${NC}"
  echo "  Install OpenCode: npm install -g @opencode-ai/cli"
  echo "  Or point OPENCODE_URL to a running instance"
fi

# ── Install dependencies ─────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}Installing dependencies...${NC}"
cd "$ROOT_DIR"
pnpm install

# ── Create .env.test template ────────────────────────────────────────────────

ENV_TEST="$ROOT_DIR/.env.test"

if [ -f "$ENV_TEST" ]; then
  echo ""
  echo -e "${GREEN}.env.test already exists${NC} — not overwriting."
  echo "  Edit it at: $ENV_TEST"
else
  echo ""
  echo -e "${CYAN}Creating .env.test template...${NC}"
  cat > "$ENV_TEST" <<'ENVEOF'
# opencode-channels E2E test configuration
# Fill in your values below.

# ── OpenCode Server ──────────────────────────────────────
# URL of your running OpenCode server
OPENCODE_URL=http://localhost:1707

# ── Slack Credentials ────────────────────────────────────
# Get these from https://api.slack.com/apps
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret

# Optional: Auto-configure Slack app URLs via Manifest API
# Get a config token: https://api.slack.com/authentication/config-tokens
SLACK_APP_ID=
SLACK_CONFIG_REFRESH_TOKEN=

# ── Server Settings ──────────────────────────────────────
PORT=3456
ENVEOF

  echo -e "${GREEN}Created .env.test${NC}"
  echo "  Edit it at: $ENV_TEST"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}  Setup incomplete — $ERRORS prerequisite(s) missing.${NC}"
  echo -e "${RED}  Fix the issues above and re-run this script.${NC}"
  exit 1
fi

echo -e "${GREEN}  Setup complete!${NC}"
echo ""
echo "  Next steps:"
echo "    1. Fill in your Slack credentials in .env.test"
echo "    2. Start OpenCode:  opencode serve --port 1707"
echo "    3. Expose port:     ngrok http 3456  (or use any public URL)"
echo "    4. Run E2E:         pnpm e2e:slack"
echo ""
echo "  Run unit tests:       pnpm test"
echo "  Run lint:             pnpm lint"
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
