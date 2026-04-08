#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT_DIR="$HOME/.pi/agent"
PI_PACKAGES=(
  "npm:@tintinweb/pi-subagents"
  "npm:pi-mcp-adapter"
  "npm:pi-rewind"
  "npm:lsp-pi"
  "npm:pi-powerline-footer"
  "npm:pi-web-access"
  "npm:glimpseui"
  "npm:pi-skill-palette"
  "npm:claude-agent-sdk-pi"
  "npm:pi-anycopy"
  "npm:@plannotator/pi-extension"
  "../../dev/yzlin/pi-fzf"
  "npm:pi-tool-display"
  "npm:pi-promptsmith"
  "npm:pi-token-burden"
  "npm:@tintinweb/pi-tasks"
)

print_package_json_lines() {
  local index
  local last_index=$((${#PI_PACKAGES[@]} - 1))

  for index in "${!PI_PACKAGES[@]}"; do
    local suffix=","
    if [ "$index" -eq "$last_index" ]; then
      suffix=""
    fi

    printf '    "%s"%s\n' "${PI_PACKAGES[$index]}" "$suffix"
  done
}

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

link_file() {
  local source_path="$1"
  local target_path="$2"
  local label="$3"

  if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]; then
    echo "$label already linked"
    return
  fi

  if [ -e "$target_path" ] || [ -L "$target_path" ]; then
    echo "Skipping $label — $target_path already exists"
    return
  fi

  ln -s "$source_path" "$target_path"
  echo "Linked $label"
}

link_dir_section() {
  local label="$1"
  local source_dir="$2"
  local target_dir="$3"

  echo "Linking $label..."
  link_dir_contents "$source_dir" "$target_dir" "$label"
  echo ""
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
  {
    cat <<EOF
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "xhigh",
  "packages": [
EOF
    print_package_json_lines
    cat <<'EOF'
  ],
  "hideThinkingBlock": false,
  "workingVibe": "zen",
  "workingVibeModel": "openai-codex/gpt-5.4-mini"
}
EOF
  } > "$PI_AGENT_DIR/settings.json"
else
  echo "settings.json already exists — skipping creation"
  echo "Make sure your packages list includes:"

  for package in "${PI_PACKAGES[@]}"; do
    echo "  \"$package\""
  done

  echo ""
fi

# Install packages
echo "Installing packages..."
for package in "${PI_PACKAGES[@]}"; do
  pi install "$package" 2>/dev/null || echo "  $package already installed"
done

echo ""

link_dir_section "skills" "$SCRIPT_DIR/skills" "$PI_AGENT_DIR/skills"
link_dir_section "agents" "$SCRIPT_DIR/agents" "$PI_AGENT_DIR/agents"
link_dir_section "prompts" "$SCRIPT_DIR/prompts" "$PI_AGENT_DIR/prompts"
link_dir_section "rules" "$SCRIPT_DIR/rules" "$PI_AGENT_DIR/rules"

echo "Linking fzf.json..."
link_file "$SCRIPT_DIR/fzf.json" "$PI_AGENT_DIR/fzf.json" "fzf.json"
echo ""

echo "✅ Setup complete!"
echo ""
echo "Restart pi to pick up all changes."
