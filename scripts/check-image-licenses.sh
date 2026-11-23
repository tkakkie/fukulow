#!/usr/bin/env bash
# #807: the image must ship the project license texts (with the copyright notice) and the generated
# third-party notices at /usr/share/licenses/fukulow/. Usage: <image> | --dir <extracted directory>.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" = "--dir" ]; then
  dir="${2:?usage: check-image-licenses.sh <image> | --dir <directory>}"
else
  image="${1:?usage: check-image-licenses.sh <image> | --dir <directory>}"
  out="$(mktemp -d)"
  container="$(docker create "$image")"
  trap 'docker rm -f "$container" >/dev/null; rm -rf "$out"' EXIT
  docker cp "$container:/usr/share/licenses/fukulow" "$out/fukulow"
  dir="$out/fukulow"
fi
fail() { echo "image licenses (#807): $1" >&2; exit 1; }
for file in LICENSE-MIT LICENSE-APACHE; do
  cmp -s "$root/$file" "$dir/$file" || fail "$file is missing or differs from the repository copy"
done
notice="$dir/THIRD-PARTY-NOTICES.txt"
[ -s "$notice" ] || fail "THIRD-PARTY-NOTICES.txt is missing or empty"
grep -q 'Copyright (c) 2026 tkakkie and the fukulow contributors' "$notice" || fail "notice lacks the project copyright"
grep -Eq '^Rust crates \([1-9][0-9]*\):$' "$notice" || fail "notice lists no Rust crates"
grep -Eq '^npm packages in the web bundle \([1-9][0-9]*\):$' "$notice" || fail "notice lists no npm packages"
echo "image licenses: LICENSE-MIT, LICENSE-APACHE and THIRD-PARTY-NOTICES.txt ($(wc -c < "$notice" | tr -d ' ') bytes) present"
