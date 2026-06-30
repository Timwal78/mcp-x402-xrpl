#!/usr/bin/env bash
# Install sovereign data enforcement as a git pre-commit hook.
# Run once after cloning: bash scripts/install-hooks.sh
set -euo pipefail
HOOK=".git/hooks/pre-commit"
cat > "$HOOK" <<'HOOK_CONTENT'
#!/usr/bin/env bash
bash scripts/check-sovereign-data.sh
HOOK_CONTENT
chmod +x "$HOOK"
echo "Sovereign data pre-commit hook installed."
