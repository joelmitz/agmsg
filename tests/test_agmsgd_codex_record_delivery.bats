#!/usr/bin/env bats
# agmsgd_codex_record_delivery.test.mjs の起動役。
#
# テスト本体は、実 HOME・既存の設定・実 agmsg に触れないよう、ここで作る一時
# ディレクトリの中だけで動く。ここは「本体のガードが通る環境を安全に作る」だけで、
# ガードは wrapper に依存しない独立の検査として本体の冒頭にある。
# signal は送らない。

setup() {
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) skip 'POSIX process groups and mkfifo are required' ;; esac
  ISO_PARENT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
  ISO_ROOT="$(mktemp -d "$ISO_PARENT/agmsg-codex-record-delivery.XXXXXXXX")"
  [ "$(cd "$ISO_ROOT" && pwd -P)" = "$ISO_ROOT" ] || { echo "isolation root is not a physical path: $ISO_ROOT" >&2; return 1; }
  ISO_TOKEN="$(umask 077; od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [ -n "$ISO_TOKEN" ] || { echo "could not generate the isolation token" >&2; return 1; }
  ( umask 077; printf '%s\n' "$ISO_TOKEN" > "$ISO_ROOT/.isolation-owner" ) || return 1
  mkdir -m 700 "$ISO_ROOT/home" "$ISO_ROOT/tmp" "$ISO_ROOT/xdg" || return 1
  mkdir -m 700 "$ISO_ROOT/xdg/config" "$ISO_ROOT/xdg/data" "$ISO_ROOT/xdg/cache" "$ISO_ROOT/xdg/state" "$ISO_ROOT/xdg/runtime" || return 1
}

teardown() {
  [ -n "${ISO_ROOT:-}" ] || return 0
  # 消す前に、作ったものと同じ場所であることを確かめ直す。満たさなければ消さずに失敗にする。
  if [ "$(dirname "$ISO_ROOT")" = "$ISO_PARENT" ] \
     && case "$(basename "$ISO_ROOT")" in agmsg-codex-record-delivery.*) true ;; *) false ;; esac \
     && [ ! -L "$ISO_ROOT" ] \
     && [ "$(cat "$ISO_ROOT/.isolation-owner" 2>/dev/null)" = "$ISO_TOKEN" ] \
     && [ "$ISO_ROOT" != "$HOME" ] && [ "$ISO_ROOT" != / ] && [ "$ISO_ROOT" != /tmp ]; then
    rm -rf -- "$ISO_ROOT"
  else
    echo "isolation root was not removed because it failed the ownership check: $ISO_ROOT" >&2
    return 1
  fi
}

@test "agmsgd Codex record-to-delivery chain" {
  run env -i PATH="$PATH" LANG="${LANG:-C}" \
    HOME="$ISO_ROOT/home" TMPDIR="$ISO_ROOT/tmp" \
    XDG_CONFIG_HOME="$ISO_ROOT/xdg/config" XDG_DATA_HOME="$ISO_ROOT/xdg/data" \
    XDG_CACHE_HOME="$ISO_ROOT/xdg/cache" XDG_STATE_HOME="$ISO_ROOT/xdg/state" \
    XDG_RUNTIME_DIR="$ISO_ROOT/xdg/runtime" \
    AGMSG_TEST_ISOLATION_ROOT="$ISO_ROOT" AGMSG_TEST_ISOLATION_PARENT="$ISO_PARENT" \
    AGMSG_TEST_ISOLATION_TOKEN="$ISO_TOKEN" \
    node --test "$BATS_TEST_DIRNAME/agmsgd_codex_record_delivery.test.mjs"
  echo "$output"
  [ "$status" -eq 0 ]
}
