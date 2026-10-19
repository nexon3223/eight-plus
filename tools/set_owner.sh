#!/bin/bash
# Point every repo URL at your GitHub account before publishing:  tools/set_owner.sh <github-user>
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <github-user>"; exit 1; }
cd "$(dirname "$0")/.."
grep -rl "YOUR_GITHUB_USER" --exclude-dir=.git --exclude-dir=.dev . | xargs sed -i.bak "s/YOUR_GITHUB_USER/$1/g"
find . -name "*.bak" -not -path "./.git/*" -delete
echo "repo URLs now point at github.com/$1/eight-plus"
