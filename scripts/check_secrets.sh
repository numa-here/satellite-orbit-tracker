#!/usr/bin/env bash
# Pre-commit secret scan helper.
# Ensures .env and backend/cache/ are not tracked, runs gitleaks if available,
# otherwise runs a lightweight pattern fallback over tracked files.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STATUS=0

echo "==> Checking that secrets/cache are not tracked"
for path in .env backend/cache; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "POLICY VIOLATION: $path is tracked in Git and must be removed" >&2
    STATUS=1
  fi
done

if command -v gitleaks >/dev/null 2>&1; then
  echo "==> Running gitleaks protect"
  if ! gitleaks protect --source "$REPO_ROOT" --verbose >/tmp/gitleaks.out 2>&1; then
    cat /tmp/gitleaks.out >&2 || true
    echo "POLICY VIOLATION: gitleaks detected potential secrets" >&2
    STATUS=1
  fi
else
  echo "==> gitleaks not installed; running pattern fallback"
  tracked="$(git ls-files | grep -v '^\.env.example$' | grep -v '^scripts/check_secrets\.sh$' || true)"
  if [ -n "$tracked" ] && printf '%s\n' "$tracked" | xargs -r grep -lEi \
      'AKIA[0-9A-Z]{16}|sk_live_[0-9A-Za-z]{24,}|ghp_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{40,}' >/dev/null 2>&1; then
    echo "POLICY VIOLATION: possible secret-like strings found in tracked files:" >&2
    printf '%s\n' "$tracked" | xargs -r grep -nEi \
      'AKIA[0-9A-Z]{16}|sk_live_[0-9A-Za-z]{24,}|ghp_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{40,}' >&2 || true
    STATUS=1
  fi
fi

if [ "$STATUS" -ne 0 ]; then
  echo "==> Secret scan FAILED" >&2
else
  echo "==> Secret scan passed"
fi
exit "$STATUS"