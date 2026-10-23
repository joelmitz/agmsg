#!/usr/bin/env bats

# bundle全体を起動し、取得元と失敗時の既存bundle保持を確認する。
# gitだけを隔離stubにする。fetch成功時はarchiveまでの到達を記録する。
setup() {
  export BUNDLE_FIXTURE_ROOT="$BATS_TEST_TMPDIR/bundle-fixture"
  mkdir -p "$BUNDLE_FIXTURE_ROOT/app/scripts" "$BUNDLE_FIXTURE_ROOT/bin" "$BUNDLE_FIXTURE_ROOT/app/src-tauri/resources/agmsg-core"
  cp "$BATS_TEST_DIRNAME/../app/scripts/bundle-core.sh" "$BUNDLE_FIXTURE_ROOT/app/scripts/bundle-core.sh"
  printf 'v1.5.1\n' > "$BUNDLE_FIXTURE_ROOT/app/AGMSG_CORE_REF"
  printf 'existing-bundle\n' > "$BUNDLE_FIXTURE_ROOT/app/src-tauri/resources/agmsg-core/keep"
  export BUNDLE_FETCH_LOG="$BUNDLE_FIXTURE_ROOT/git-args"
  export BUNDLE_FETCH_STATUS=42
  cat > "$BUNDLE_FIXTURE_ROOT/bin/git" <<'GIT'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$BUNDLE_FETCH_LOG"
if [ "$1" = fetch ]; then exit "$BUNDLE_FETCH_STATUS"; fi
# archive到達を非ゼロで終了し、実際のbundle生成は行わない。
if [ "$1" = archive ]; then exit 43; fi
exit 44
GIT
  chmod +x "$BUNDLE_FIXTURE_ROOT/bin/git"
  export PATH="$BUNDLE_FIXTURE_ROOT/bin:$PATH"
}

@test "bundle-core: upstream pin tag is fetched independently of fork origin" {
  run bash "$BUNDLE_FIXTURE_ROOT/app/scripts/bundle-core.sh"
  [ "$status" -eq 42 ]
  expected=$(printf '%s\n' fetch https://github.com/fujibee/agmsg.git tag v1.5.1 --no-tags)
  [ "$(cat "$BUNDLE_FETCH_LOG")" = "$expected" ]
}

@test "bundle-core: missing tag fetch fails before archive or existing bundle removal" {
  run bash "$BUNDLE_FIXTURE_ROOT/app/scripts/bundle-core.sh"
  [ "$status" -eq 42 ]
  [ "$(cat "$BUNDLE_FIXTURE_ROOT/app/src-tauri/resources/agmsg-core/keep")" = existing-bundle ]
  run grep -x archive "$BUNDLE_FETCH_LOG"
  [ "$status" -eq 1 ]
}

@test "bundle-core: successful fetch proceeds to archive of the committed pin" {
  export BUNDLE_FETCH_STATUS=0
  run bash "$BUNDLE_FIXTURE_ROOT/app/scripts/bundle-core.sh"
  # archiveの非ゼロに続きtarも空入力で失敗するため、pipelineは非ゼロを要求する。
  [ "$status" -ne 0 ]
  run grep -A 1 -x archive "$BUNDLE_FETCH_LOG"
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'archive\nv1.5.1')" ]
}
