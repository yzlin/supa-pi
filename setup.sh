#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT_DIR="$HOME/.pi/agent"

link_dir_contents() {
  local source_dir="$1"
  local target_dir="$2"
  local label="$3"

  mkdir -p "$target_dir"

  if [ "$(cd "$source_dir" && pwd)" = "$(cd "$target_dir" && pwd)" ]; then
    echo "$label already live at $target_dir"
    return
  fi

  local linked_any=false
  local source_path
  for source_path in "$source_dir"/*; do
    if [ ! -e "$source_path" ]; then
      continue
    fi

    local name
    name="$(basename "$source_path")"
    local target_path="$target_dir/$name"

    if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]; then
      echo "  $label/$name already linked"
      continue
    fi

    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
      echo "  Skipping $label/$name — $target_path already exists"
      continue
    fi

    ln -s "$source_path" "$target_path"
    echo "  Linked $label/$name"
    linked_any=true
  done

  if [ "$linked_any" = false ]; then
    echo "  No $label entries needed linking"
  fi
}

# Verify we're in the right place
if [ "$SCRIPT_DIR" != "$PI_AGENT_DIR" ]; then
  echo "⚠️  This repo should be cloned to ~/.pi/agent/"
  echo "   Current location: $SCRIPT_DIR"
  echo "   Expected: $PI_AGENT_DIR"
  echo ""
  echo "   Run: git clone git@github.com:yzlin/supa-pi $PI_AGENT_DIR"
  exit 1
fi

echo "Setting up supa-pi at $PI_AGENT_DIR"
echo ""

# Create settings.json if it doesn't exist
if [ ! -f "$PI_AGENT_DIR/settings.json" ]; then
  echo "Creating settings.json..."
  cat > "$PI_AGENT_DIR/settings.json" << 'EOF'
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

echo "Linking skills..."
link_dir_contents "$SCRIPT_DIR/skills" "$PI_AGENT_DIR/skills" "skills"
echo ""

echo "Linking prompts..."
link_dir_contents "$SCRIPT_DIR/prompts" "$PI_AGENT_DIR/prompts" "prompts"
echo ""

echo "✅ Setup complete!"
echo ""
echo "Restart pi to pick up all changes."
