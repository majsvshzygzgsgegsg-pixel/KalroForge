#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${KAIROFORGE_BIN_DIR:-$HOME/bin}"

mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/kairoforge" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT_DIR"
exec node scripts/kairoforge-web.mjs "\$@"
SCRIPT

cat > "$BIN_DIR/kf" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT_DIR"
exec node scripts/kairoforge-web.mjs "\$@"
SCRIPT

cat > "$BIN_DIR/kairoforge-open" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT_DIR"
exec node scripts/kairoforge-web.mjs "\$@"
SCRIPT

chmod +x "$BIN_DIR/kairoforge" "$BIN_DIR/kf" "$BIN_DIR/kairoforge-open"

echo "Installed KairoForge commands:"
echo "  $BIN_DIR/kairoforge"
echo "  $BIN_DIR/kf"
echo "  $BIN_DIR/kairoforge-open"
echo
echo "If your shell cannot find them, add this to ~/.zshrc:"
echo "  export PATH=\"$BIN_DIR:\$PATH\""
