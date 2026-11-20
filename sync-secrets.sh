#!/usr/bin/env bash
set -euo pipefail

SECRET_FILE="${1:-functions/.secret.local}"

if [[ ! -f "$SECRET_FILE" ]]; then
  echo "File not found: $SECRET_FILE" >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip empty lines and comments
  [[ -z "${line// }" || "$line" =~ ^[[:space:]]*# ]] && continue

  key="${line%%=*}"
  value="${line#*=}"

  # Trim surrounding quotes if present
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"

  echo "Updating secret: $key"
  printf '%s' "$value" | firebase functions:secrets:set "$key" --data-file=- --force
done < "$SECRET_FILE"
