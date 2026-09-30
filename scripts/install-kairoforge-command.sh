#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${KAIROFORGE_BIN_DIR:-$HOME/bin}"
PROFILE_FILE="${KAIROFORGE_PROFILE_FILE:-$HOME/.zshrc}"
MARKER="KAIROFORGE_GENERATED_LAUNCHER"

commands=(
  kairoforge
  kairoforge-web
  kairoforge-open
  kairoforge-launch
  kairoforge-start
  kforge
  forge
  kf
  kf-web
  kf-open
  web
  launch
)

mkdir -p "$BIN_DIR"

for command_name in "${commands[@]}"; do
  target="$BIN_DIR/$command_name"
  if [[ -e "$target" ]] && ! grep -q "$MARKER" "$target"; then
    if ! grep -Fq 'scripts/kairoforge-web.mjs "$@"' "$target"; then
      echo "Refusing to overwrite existing non-KairoForge command: $target" >&2
      echo "Move it first, or set KAIROFORGE_BIN_DIR to another folder." >&2
      exit 1
    fi
  fi
  cat > "$target" <<SCRIPT
#!/usr/bin/env bash
# $MARKER
set -euo pipefail
cd "$ROOT_DIR"
exec node scripts/kairoforge-web.mjs "\$@"
SCRIPT
  chmod +x "$target"
done

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  touch "$PROFILE_FILE"
  if ! grep -Fq "export PATH=\"$BIN_DIR:\$PATH\"" "$PROFILE_FILE"; then
    {
      echo
      echo "# KairoForge command shortcuts"
      echo "export PATH=\"$BIN_DIR:\$PATH\""
    } >> "$PROFILE_FILE"
  fi
fi

echo "Installed KairoForge commands in $BIN_DIR:"
for command_name in "${commands[@]}"; do
  echo "  $command_name"
done
echo
echo "Use any of these from any folder, for example:"
echo "  kairoforge"
echo "  kf"
echo "  web"
echo "  launch"
echo
echo "If your current terminal cannot find them yet, run:"
echo "  source \"$PROFILE_FILE\""
