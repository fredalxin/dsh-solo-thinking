#!/usr/bin/env bash
set -euo pipefail

REPO="fredalxin/dsh-solo-thinking"
PACKAGE="dsh-plugin-solo-thinking"
SIDEBAR_PACKAGE="dsh-better-sidebar"
SIDEBAR_VERSION="^0.12.1"
VERSION="latest"
PROFILE="web"
DRY_RUN=false

usage() {
  cat <<'EOF'
DSH Solo Thinking installer (includes Better Sidebar)

Usage: bash install.sh [version] [--profile <name>] [--dry-run]

  version            GitHub Release version, for example 0.1.19 or v0.1.19.
                     Defaults to the latest published release.
  --profile <name>   DSH profile to install into. Defaults to web.
  --dry-run          Print the resolved command without changing the profile.

The installer mounts dsh-better-sidebar first. Solo Thinking still works in
the full top tab if Better Sidebar is later removed.
EOF
}

die() {
  printf '[error] %s\n' "$*" >&2
  exit 1
}

curl_get() {
  curl --fail --silent --show-error --location \
    --retry 3 --retry-all-errors --retry-delay 2 \
    --connect-timeout 15 --max-time 120 "$@"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --profile)
      [ "$#" -ge 2 ] || die "--profile requires a value"
      PROFILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [ "$VERSION" = "latest" ] || die "only one version may be specified"
      VERSION="$1"
      shift
      ;;
  esac
done

command -v node >/dev/null 2>&1 || die "Node.js is required by DSH"
command -v curl >/dev/null 2>&1 || die "curl is required to resolve GitHub Releases"

if [ "$VERSION" = "latest" ]; then
  RELEASE_JSON="$(curl_get "https://api.github.com/repos/${REPO}/releases/latest")" \
    || die "unable to resolve the latest GitHub Release"
  TAG="$(printf '%s' "$RELEASE_JSON" | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk });
    process.stdin.on("end", () => {
      const tag = JSON.parse(input).tag_name;
      if (typeof tag !== "string" || tag.length === 0) process.exit(1);
      process.stdout.write(tag);
    });
  ')" || die "latest GitHub Release has no tag"
else
  TAG="v${VERSION#v}"
fi

RELEASE_VERSION="${TAG#v}"
ASSET="${PACKAGE}-${RELEASE_VERSION}.tgz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
CHECKSUM_URL="${URL}.sha256"

if command -v dsh >/dev/null 2>&1; then
  CLI=(dsh)
elif command -v npx >/dev/null 2>&1; then
  CLI=(npx -y --package @deepseek-ai/dsh dsh)
else
  die "dsh or npx is required; install DSH first"
fi

printf '[install] %s %s into DSH profile %s\n' "$PACKAGE" "$TAG" "$PROFILE"
printf '[install] source: %s\n' "$URL"

if [ "$DRY_RUN" = true ]; then
  printf '[dry-run] prepare the profile for node-pty/protobufjs builds\n'
  printf '[dry-run] install sidebar:'
  printf ' %q' "${CLI[@]}" plugin --profile "$PROFILE" add "${SIDEBAR_PACKAGE}@${SIDEBAR_VERSION}"
  printf '\n'
  printf '[dry-run] download %s and %s\n' "$URL" "$CHECKSUM_URL"
  printf '[dry-run] verify SHA-256, then run:'
  printf ' %q' "${CLI[@]}" plugin --profile "$PROFILE" add "<verified ${ASSET}>"
  printf '\n'
  exit 0
fi

DSH_ROOT="${DSH_HOME:-${HOME:?HOME is required}/.dsh}"
PROFILE_DIR="$DSH_ROOT/profiles/$PROFILE"
WORKSPACE_FILE="$PROFILE_DIR/pnpm-workspace.yaml"
[ -f "$WORKSPACE_FILE" ] || die "DSH profile $PROFILE is not initialized; run dsh --profile $PROFILE once, then retry"

node -e '
  const fs = require("fs");
  const file = process.argv[1];
  let text = fs.readFileSync(file, "utf8");
  const before = text;
  text = text.replace(/^(\s*)(node-pty|protobufjs):.*$/gm, "$1$2: true");
  if (!/^\s*allowBuilds:\s*$/m.test(text)) {
    text += "\nallowBuilds:\n  node-pty: true\n  protobufjs: true\n";
  } else {
    for (const name of ["node-pty", "protobufjs"]) {
      if (!new RegExp("^\\s*" + name + ":\\s*true\\s*$", "m").test(text)) {
        text = text.replace(/^(\s*allowBuilds:\s*)$/m, "$1\n  " + name + ": true");
      }
    }
  }
  if (!/^\s*-\s+dsh-better-sidebar\s*$/m.test(text)) {
    text = /^\s*minimumReleaseAgeExclude:\s*$/m.test(text)
      ? text.replace(/^(\s*minimumReleaseAgeExclude:\s*)$/m, "$1\n  - dsh-better-sidebar")
      : text + "\nminimumReleaseAgeExclude:\n  - dsh-better-sidebar\n";
  }
  if (text !== before) fs.writeFileSync(file, text);
' "$WORKSPACE_FILE"

printf '[install] mounting %s %s\n' "$SIDEBAR_PACKAGE" "$SIDEBAR_VERSION"
"${CLI[@]}" plugin --profile "$PROFILE" add "${SIDEBAR_PACKAGE}@${SIDEBAR_VERSION}"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-solo-thinking.XXXXXX")"
cleanup() {
  rm -f "$TEMP_DIR/$ASSET" "$TEMP_DIR/${ASSET}.sha256"
  rmdir "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

curl_get "$URL" -o "$TEMP_DIR/$ASSET"
curl_get "$CHECKSUM_URL" -o "$TEMP_DIR/${ASSET}.sha256"
(
  cd "$TEMP_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "${ASSET}.sha256"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "${ASSET}.sha256"
  else
    die "sha256sum or shasum is required to verify the Release asset"
  fi
)

"${CLI[@]}" plugin --profile "$PROFILE" add "$TEMP_DIR/$ASSET"
CONFIG="$("${CLI[@]}" --profile "$PROFILE" --dump-config)"
case "$CONFIG" in
  *"name: ${PACKAGE}"*) ;;
  *) die "installation completed but ${PACKAGE} is not mounted in the composed profile" ;;
esac
case "$CONFIG" in
  *"name: ${SIDEBAR_PACKAGE}"*) ;;
  *) die "installation completed but ${SIDEBAR_PACKAGE} is not mounted in the composed profile" ;;
esac

printf '[install] verified: %s and %s are mounted\n' "$PACKAGE" "$SIDEBAR_PACKAGE"
printf '[install] restart DSH, then hard-refresh the browser (Cmd/Ctrl+Shift+R)\n'
