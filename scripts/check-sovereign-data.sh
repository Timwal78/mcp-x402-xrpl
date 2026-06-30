#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SOVEREIGN DATA ENFORCEMENT — ScriptMasterLabs
#
# Scans source files for any pattern that indicates synthetic, fake, demo,
# placeholder, or hardcoded trading data being returned from an API handler.
#
# EXIT 1 if violations found — blocks commit and CI.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

VIOLATIONS=0
SCAN_DIRS=("src")
EXTENSIONS=("ts" "js" "mjs" "cjs")

# Build file list
FILES=()
for dir in "${SCAN_DIRS[@]}"; do
  [[ -d "$dir" ]] || continue
  for ext in "${EXTENSIONS[@]}"; do
    while IFS= read -r f; do
      FILES+=("$f")
    done < <(find "$dir" -name "*.${ext}" 2>/dev/null)
  done
done

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No source files found — skipping sovereign data check."
  exit 0
fi

# ── Forbidden patterns ────────────────────────────────────────────────────────
# Format: "PATTERN|DESCRIPTION"
# Patterns use extended regex (grep -E)
PATTERNS=(
  # Hardcoded trading signal objects returned from handlers
  "signal:[[:space:]]*['\"]?(BUY|SELL|HOLD)['\"]?[,}].*reasoning:|reasoning:.*['\"]RSI|MACD|Social velocity|Exchange outflows|coiling|breakout|Liquidity thin['\"]"
  # Hardcoded confidence scores in response objects
  "confidence:[[:space:]]*0\.[0-9]{2,}"
  # Hardcoded squeeze scan fields
  "squeeze:[[:space:]]*(true|false),[[:space:]]"
  # Hardcoded entry/target/stopLoss trading levels
  "entry:[[:space:]]*[0-9]+\.[0-9]+,[[:space:]]*target[12]:"
  # Mock/fake/demo/placeholder/simulation as code intent markers
  "(\/\/|#)[[:space:]]*(mock|fake|demo|placeholder|simul|hardcoded|synthetic|dummy|stub)[[:space:]]"
  # Hardcoded agent council arrays with fake agents
  "agent:[[:space:]]*['\"]QUANT_ALPHA['\"]|agent:[[:space:]]*['\"]RISK_SENTINEL['\"]|agent:[[:space:]]*['\"]MACRO_ORACLE['\"]|agent:[[:space:]]*['\"]SENTIMENT_AI['\"]|agent:[[:space:]]*['\"]CHAIN_ANALYST['\"]|agent:[[:space:]]*['\"]VOLUME_HAWK['\"]|agent:[[:space:]]*['\"]BREAKOUT_BOT['\"]"
  # res.json() returning hardcoded consensus strings
  "consensus:[[:space:]]*['\"]BUY \([0-9]\/[0-9]\)['\"]"
  # Hardcoded riskReward ratios
  "riskReward:[[:space:]]*[0-9]+\.[0-9]"
  # String values that declare data is fake
  "['\"][[:space:]]*(mock|fake|demo|placeholder|simulation|synthetic|dummy)[[:space:]]*['\"]"
)

echo "──────────────────────────────────────────────────────────────────────"
echo "  SOVEREIGN DATA ENFORCEMENT SCAN"
echo "  Repo: $(basename "$PWD")  |  Files: ${#FILES[@]}"
echo "──────────────────────────────────────────────────────────────────────"

for file in "${FILES[@]}"; do
  for pattern in "${PATTERNS[@]}"; do
    matches=$(grep -nE "$pattern" "$file" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
      echo -e "${RED}VIOLATION${NC} in ${YELLOW}${file}${NC}:"
      while IFS= read -r line; do
        echo "  $line"
      done <<< "$matches"
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
done

echo "──────────────────────────────────────────────────────────────────────"
if [[ $VIOLATIONS -gt 0 ]]; then
  echo -e "${RED}BLOCKED: ${VIOLATIONS} sovereign data violation(s) detected.${NC}"
  echo ""
  echo "  All API handlers MUST proxy to SQUEEZEOS_UPSTREAM_URL."
  echo "  No hardcoded signals, confidence scores, or fabricated trading data"
  echo "  may be returned behind any payment gate — ever."
  echo ""
  echo "  Fix violations before committing."
  exit 1
else
  echo "  PASS — no sovereign data violations found."
  exit 0
fi
