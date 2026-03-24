#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPECTED_DIR="$HOME/.pi/agent"

# Verify we're in the right place
if [ "$SCRIPT_DIR" != "$EXPECTED_DIR" ]; then
  echo "⚠️  This repo should be cloned to ~/.pi/agent/"
  echo "   Current location: $SCRIPT_DIR"
  echo "   Expected: $EXPECTED_DIR"
  echo ""
  echo "   Run: git clone git@github.com:yzlin/supa-pi $EXPECTED_DIR"
  exit 1
fi

echo "Setting up supa-pi at $EXPECTED_DIR"
echo ""

# Create settings.json if it doesn't exist
if [ ! -f "$EXPECTED_DIR/settings.json" ]; then
  echo "Creating settings.json..."
  cat > "$EXPECTED_DIR/settings.json" << 'EOF'
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "xhigh",
  "packages": [
    "npm:@tintinweb/pi-subagents",
    "npm:@tintinweb/pi-tasks",
    "npm:pi-mcp-adapter",
    "npm:pi-rewind",
    "npm:lsp-pi",
    "npm:pi-powerline-footer",
    "npm:@ogulcancelik/pi-ghostty-theme-sync",
    "npm:pi-web-access",
    "npm:glimpseui",
    "npm:pi-skill-palette",
    "npm:claude-agent-sdk-pi",
    "npm:pi-anycopy",
    "npm:pi-rtk"
  ],
  "hideThinkingBlock": false,
  "workingVibe": "zen",
  "workingVibeModel": "openai-codex/gpt-5.4-mini"
}
EOF
else
  echo "settings.json already exists — skipping creation"
  echo "Make sure your packages list includes:"
  echo '  "npm:@tintinweb/pi-subagents"'
  echo '  "npm:@tintinweb/pi-tasks"'
  echo '  "npm:pi-mcp-adapter"'
  echo '  "npm:pi-rewind"'
  echo '  "npm:lsp-pi"'
  echo '  "npm:pi-powerline-footer"'
  echo '  "npm:@ogulcancelik/pi-ghostty-theme-sync"'
  echo '  "npm:pi-web-access"'
  echo '  "npm:glimpseui"'
  echo '  "npm:pi-skill-palette"'
  echo '  "npm:pi-btw"'
  echo '  "npm:claude-agent-sdk-pi"'
  echo ""
fi

# Install packages
echo "Installing packages..."
pi install npm:@tintinweb/pi-subagents 2>/dev/null || echo "  @tintinweb/pi-subagents already installed"
pi install npm:@tintinweb/pi-tasks 2>/dev/null || echo "  @tintinweb/pi-tasks already installed"
pi install npm:pi-mcp-adapter 2>/dev/null || echo "  pi-mcp-adapter already installed"
pi install npm:pi-rewind 2>/dev/null || echo "  pi-rewind already installed"
pi install npm:lsp-pi 2>/dev/null || echo "  lsp-pi already installed"
pi install npm:pi-powerline-footer 2>/dev/null || echo "  pi-powerline-footer already installed"
pi install npm:@ogulcancelik/pi-ghostty-theme-sync 2>/dev/null || echo "  pi-ghostty-theme-sync already installed"
pi install npm:pi-web-access 2>/dev/null || echo "  pi-web-access already installed"
pi install npm:glimpseui 2>/dev/null || echo "  glimpseui already installed"
pi install npm:pi-skill-palette 2>/dev/null || echo "  pi-skill-palette already installed"
pi install npm:pi-btw 2>/dev/null || echo "  pi-btw already installed"
pi install npm:claude-agent-sdk-pi 2>/dev/null || echo "  claude-agent-sdk-pi already installed"
echo ""

echo "✅ Setup complete!"
echo ""
echo "Restart pi to pick up all changes."
