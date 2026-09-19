# RFC: agmsg の OS（platform）層

これは RFC である。設計への意見を求める文書であって、決定の記録ではない。決まったことは従来どおり ADR に落ちる。実装の前に公開する。

対象は公開リポジトリ [joelmitz/agmsg](https://github.com/joelmitz/agmsg)。上流 [fujibee/agmsg](https://github.com/fujibee/agmsg) へは RFC / Issue で提案する。恒久文書の置き場は本ファイル。

対象エージェントは type 軸の全部である。少なくとも **claude-code / codex / grok-build / antigravity**。Windows の呼び方を Codex だけが知っている、という偏りを解消するのが目的の一つである。

**この版（2026-09-19）は、codex-win-herdr の設計レビューを四度反映した。** 直前の PASS 後 NIT 2 点（「誰が何を持つか」の固定パスは探索順の説明であり正本は `platform_bash_exe`、`AGMSG_GIT_BASH` と既定候補の入力形式と失敗条件）を書いた。

## きっかけ

Windows native のホスト（PowerShell）から agmsg の bash スクリプトを叩くとき、裸の `bash` は Git Bash ではなく WSL の `WindowsApps\bash.exe` になり得る。その bash の `"$(pwd)"` は `/mnt/c/Users/...` になり、join がそれをプロジェクト path として保存する。

これは grok-build 固有ではない。同じ PowerShell 経路は Codex 以外の type 全部に開いている。Codex だけが SKILL overlay で Git Bash を明示している。

## いまの軸と欠け

現行 driver は `scripts/drivers/<axis>/<name>`（ADR 0001 / 0002）。

| 軸 | 何を替えるか | OS か |
|---|---|---|
| `types` | CLI 契約（hook、spawn、monitor） | 違う |
| `terminals` | tmux / herdr / plain | 違う |
| `storage` | メッセージ店 | 違う |
| `partition` | チーム分割 | 違う |

OS 軸は無い。代わりに次へ散っている。

- `scripts/lib/compat.sh` が `uname` を `msys` / `macos` / `linux` の 3 値に潰す（WSL は `linux`、Cygwin は `msys`）
- `agmsg_normalize_project_path` は Git Bash の `/c/Users` だけ `C:/Users` にする。`/mnt/c` も `/cygdrive/c` も対象外
- SKILL の Git Bash 指示は **Codex overlay だけ**（下表）
- `hook_windows_wrap=yes` は type マニフェスト。Codex が hook を PowerShell 経由で走らせるためのもの。これは type のままでよい

SKILL は install 時に **type だけで**描画される（`scripts/lib/skill-render.sh`）。OS は入力に無い。同じ skill ツリーを Windows 席と WSL 席が読むので、install 時に「今の OS」を焼き込む方式は使えない。

### type overlay の偏り

共有 `SKILL.md` に `<!-- agmsg:slot shell-extra -->` がある。埋めるのは type template。

| type | `shell-extra` | 結果 |
|---|---|---|
| **codex** | あり。PowerShell では `C:\Program Files\Git\bin\bash.exe` を明示 | Windows の呼び方が SKILL に出る |
| **claude-code** | なし | 共有本文の `bash -lc` だけ。WSL shim に落ちる |
| **grok-build** | なし | 同上 |
| **antigravity** | なし | 同上 |
| その他（gemini / copilot / opencode / hermes / cursor） | なし | 同上 |

README の Windows 節も見出しが「Git Bash & Codex」で、hook の `commandWindows` は Codex 向け。インタラクティブな `"$(pwd)"` の注意は Codex 例だけ。claude-code / grok-build / antigravity が PowerShell から join する経路は、文書上も overlay 上も Git Bash に固定されていない。

Codex にだけあるもう一つの Windows 処理 `hook_windows_wrap` は、**CLI が hook を PowerShell で起動するか**という type 契約なので、platform に移さない。移す対象は「ホストが Windows native のとき、どの bash でスクリプトを走らせ、どの綴りでプロジェクト path を書くか」だけ。それは type に依存しない。

## 置き方: 検出する層であり、切り替えプラグインではない

storage のように `agmsg platform switch windows` は無い。今いる OS は事実であって選択肢ではない。

**bundled-only の `platforms` 軸**にする。フォルダ規約は他軸に揃えるが、plugin trust / ユーザー選択の対象にはしない。ADR 0002 の「1軸1アクティブ・ユーザーが替える」モデルには載せない。

```
scripts/drivers/platforms/
  posix.sh       # 既定。linux 本体。macos / wsl が薄い差分で載る
  windows.sh     # Git Bash / MSYS2。差が大きい側
```

検出結果の名前は 4 つ。実装の中身は 2 系統。

| 検出名 | 系統 | 根拠 |
|---|---|---|
| `linux` | posix（既定） | `uname -s` が Linux かつ WSL でない |
| `wsl` | posix | `uname -r` に `microsoft` / `WSL` |
| `macos` | posix | `Darwin` |
| `windows` | windows | `MINGW*` / `MSYS*`（Git Bash / 単独 MSYS2） |

Cygwin（`CYGWIN*`）は v1 対象外。検出したら Git Bash を案内して拒否する。path が `/cygdrive/c` で、MSYS の `/c/` 正規化とは別規則が要る。README も Git Bash だけを文書化している。

## 誰が何を持つか

**platform が持つ（claude-code / codex / grok-build / antigravity ほか全 type 共通）**

1. bash の呼び方。Windows native のホストが使うパスの **正本は `platform_bash_exe` の探索順** である。下の「Git Bash の探索順」が実装契約。`C:/Program Files/Git/bin/bash.exe` はその候補の一例であり、唯一の固定パスではない。`WindowsApps\bash.exe`（WSL shim）は禁止。posix は今の bash でよい。
2. プロジェクト path の正本と variant。
   - windows: `C:/Users/me/project`
   - posix: `/home/me/project` など、来た POSIX path をそのまま（末尾スラッシュ程度だけ整える）
3. SKILL 共有本文の shell 節。**Codex overlay から出すのをやめる。**
4. pid / cmdline の読み方（いま `compat.sh` の msys 分岐）。WinPID と MSYS pid の対応は windows 側。

**type が持ち続ける**

- `hook_windows_wrap`（Codex: hook が PowerShell 経由だから）
- spawn フラグ、monitor、bridge、hooks ファイル loc
- delivery の 4 択文面など、CLI ごとの SKILL overlay

**terminal が持ち続ける**

- tmux / herdr / wt.exe / Terminal.app。plain の Darwin 分岐は端末の話なので、最初から platform に吸い上げない。

**WSL は Linux 互換環境**

path 正本は Linux の `/home/me/project`。`/mnt/c/Users/me/project` は Linux から見た Windows ディスクのマウント（9P。大量の小ファイル I/O では遅い）。**WSL 側で `/mnt/c` を `C:/` に正規化してはいけない。** Windows native 席と WSL 席が同一プロジェクトに潰れる。

macos の差は小さい。spawn の `.command`、plain の Terminal.app / iTerm、Homebrew。posix の上に数関数足す程度。

## ホスト OS とスクリプト OS を混ぜない

| | Windows native のエージェント | WSL 上のエージェント |
|---|---|---|
| ホスト | Win32 の claude / grok / agy など | Linux 側の同じ CLI |
| 呼ぶべき bash | Git Bash | WSL の `/usr/bin/bash` |
| join に渡す pwd | `/c/Users/...` → `C:/Users/...` | `/home/me/...` |

Windows ホストが WSL bash を呼ぶと、スクリプト側 `uname` は Linux なのに pwd は `/mnt/c` になる。このとき `platform_detect` は `wsl` で成功する。Git Bash 欠如の契約は **windows 系統に入ったあと** に効くので、この経路は通らない。`/mnt/c` は posix の正本として残り、join は登録しうる。

**v1 で防ぐ範囲:** 呼び出しが Git Bash を選んだ場合。共有 SKILL が Git Bash のフルパスを指定し、`platform_bash_exe` がそのパスを返し、join がそれを使う。結果の登録は `C:/Users/...` になる。

**v1 で防がない範囲:** Win32 の親が WSL bash を直接走らせた場合。detect は `wsl`、path は `/mnt/c/...` のまま。これは今回の欠如契約の対象外である。

**v1.1（任意）:** 親プロセスが Win32 なのにスクリプトが WSL なら、join を拒否して Git Bash を案内する。親走査は既存の type 検出と同じ系統。v1 の SKILL 固定だけではこの境界は閉じない。

## SKILL 本文

`shell-extra` を `scripts/drivers/types/codex/template.md` から外し、共有 `SKILL.md` の Shell requirement に OS 条件を書く。描画後の SKILL は claude-code / codex / grok-build / antigravity のどれでも同じ shell 節を持つ。

要点:

- PowerShell / cmd から `.sh` を直接叩くな。Windows native なら Git Bash のフルパス（**そのパスは `platform_bash_exe` の探索結果が正本**。SKILL に `C:/Program Files/Git/bin/bash.exe` を唯一の場所として焼き込まない）。`bash` だけは WSL shim になる。
- すでに Linux / mac / WSL の bash にいるなら、その bash でスクリプトを叩く。
- `"$(pwd)"` は **ホストと同じ OS の bash** で取る。Windows 席で WSL の pwd を渡さない。

install 時に OS を焼き込まない（WSL と Windows が同じ skill ツリーを読むため）。

README の「Windows: Git Bash & Codex」は「Windows: Git Bash」に直し、Codex の `commandWindows` は hook の話として残す。

## ABI

共通プロトコル（[docs/spec/driver-interface.md](../spec/driver-interface.md) §1）に揃える。`source` して `platform_*` を呼ぶ。他軸と同じ。

機械判定に使う値と、人間向けの説明は **別関数** にする。一方の stdout を他方の用途に使わない。

```
platform_check                  # 依存確認。windows で Git Bash が無いとき missing_deps
platform_detect                 # 機械判定。stdout は linux|wsl|macos|windows の 1 語だけ
platform_describe               # 人間向け。key=value。分岐に使わない
platform_canonical_project_path <path>
platform_project_path_variants <path>
platform_bash_exe               # windows は Git Bash の絶対パス、posix は bash
platform_skill_shell_notes      # 任意の人間向け補助。SKILL 本文の正本は共有 SKILL.md
```

`join.sh` / `whoami.sh` / `identities.sh` ほか、下の入口一覧は正規化をここに委譲する。呼び出し側に `MINGW*|MSYS*` を増やさない。

### `platform_check` と `platform_bash_exe`（失敗時は止まる）

共有 SKILL が Git Bash を案内しても、呼び出し側が従わない経路は残る。そのとき PATH 上の `bash`（WSL shim）へ黙って落ちてはいけない。

windows 系統:

- `platform_check` は下の探索で Git Bash が見つからないとき `missing_deps` を返し、非ゼロで終わる。PATH の `bash` を成功としない。
- `platform_bash_exe` は同じ探索の結果の絶対パスを stdout に出す。見つからなければ非ゼロで終わり、空文字も `bash` という名前だけも返さない。

**Git Bash の探索順（先に当たったファイルが勝つ）:**

1. 環境変数 `AGMSG_GIT_BASH` が、トリム後に非空なら、そのパスだけを見る。下の正規化と検証を通らなければ **そこで失敗** する。後続の既定位置へ落ちない。トリム後に空なら未設定と同じで、既定候補へ進む。
2. `C:/Program Files/Git/bin/bash.exe`
3. `C:/Program Files (x86)/Git/bin/bash.exe`
4. `%LOCALAPPDATA%/Programs/Git/bin/bash.exe`（ユーザーインストール）。`LOCALAPPDATA` が未設定または空ならこの候補は **飛ばす**（失敗にはしない）。ユーザー名を推測して埋めない。

候補パスの正規化（`AGMSG_GIT_BASH` も既定候補も同じ）:

- `\` を `/` にする（Windows 形式 `C:\Program Files\Git\bin\bash.exe` とスラッシュ形式を同一視）
- Git Bash のドライブ形式 `/c/Program Files/...` は `C:/Program Files/...` にする
- 正規化後は絶対パスでなければならない（`C:/` で始まる）。相対パスは採用しない。`AGMSG_GIT_BASH` が相対なら即失敗。既定候補はもともと絶対なので相対にはならない
- UNC（`//server/...`）は採用しない

各候補は次をすべて満たすときだけ採用する。満たさなければその候補は失敗である。

- 正規化後のパスが絶対である
- 通常ファイルとして存在する（ディレクトリ、壊れたリンク、開けないファイルは失敗）
- パスに `WindowsApps` を含まない（大小無視。WSL shim 拒否）
- `.exe` として開ける

PATH 上の名前 `bash` は候補に入れない。`uname` を走らせて Git Bash かどうか確かめることは v1 では要求しない。ファイルの存在と `WindowsApps` 除外で足りる。

posix 系統:

- `platform_check` は今の `bash` で足りれば `ok`。
- `platform_bash_exe` は `bash`（解決済みの絶対パスでもよい）。

`join.sh`、`spawn.sh`、`whoami.sh` は、windows 系統で check または bash_exe が失敗したら **そこで止まる**。registrations を書かない。WSL の `/usr/bin/bash` や `WindowsApps\bash.exe` へフォールバックしない。この停止は SKILL 文面ではなくスクリプト側の契約である。

### `platform_detect`（機械判定）

stdout は次の 4 値のどれか 1 語。終端改行のみ。呼び出し側は **この関数の戻りだけ** で分岐する。`platform_describe` の `name=` や `backend=` を `case` してはいけない。

**判定順（先に当たったものが勝つ）:**

1. `uname -s` が `CYGWIN*` → 拒否（非ゼロ、stderr に Git Bash を案内）。4 値のどれにもしない。`msys` にも畳まない。
2. `uname -s` が `MINGW*` または `MSYS*` → `windows`
3. `uname -s` が `Darwin*` → `macos`
4. `uname -s` が Linux（または上記以外）かつ `uname -r` が `microsoft` / `WSL` を含む（大小無視）→ `wsl`
5. それ以外 → `linux`

`uname` だけで足りるのは macos と windows（Git Bash / MSYS2）だけである。WSL と Cygwin 拒否は `uname -s` の 3 値畳みでは区別できない。

### `platform_describe`（人間向け）

他軸の `storage_describe` / `terminal_describe` と同じく key=value。doctor や status の表示用。**パースして分岐してはいけない。**

| キー | 値 | 機械判定か |
|---|---|---|
| `name` | 実装ファイル名。`posix` または `windows`（2 系統） | 違う。検出 4 値ではない |
| `backend` | 人間が読む一行（例: `Git Bash / MSYS2`、`WSL (Linux compatible)`） | 違う |
| `capabilities` | 空白区切りの能力名 | 違う |

`name` は「どの `.sh` を source したか」であり、`platform_detect` の 4 値ではない。posix 系統は `linux` / `wsl` / `macos` のどれでも `name=posix` になる。検出結果を describe に載せて呼び出し側がそれを読む、という逃げ道は作らない。検出結果が要るなら `platform_detect` を呼ぶ。

`platform_skill_shell_notes` は SKILL に載せる長文の下書きであり、こちらも分岐に使わない。正本は共有 `SKILL.md`。

### 既存 compat 3 値の互換期間

いま `_agmsg_detect_platform` は内部変数 `_agmsg_platform` を `msys` / `macos` / `linux` の 3 値にする。参照は `compat.sh` 内の pid / cmdline / stat 分岐が主である（`require-python3.sh` の同名関数は `uname -s` 生値を返す別物で、本節の対象外）。

`#1` で `platform_detect` を足したあと、3 値 API は **facade として残す。同じ変更で消さない。**

| `platform_detect` | facade が返す `_agmsg_platform` |
|---|---|
| `windows` | `msys` |
| `macos` | `macos` |
| `linux` | `linux` |
| `wsl` | `linux` |
| Cygwin（拒否） | 返さない。detect が先に失敗する |

この写像は v1 のあいだ不変である。WSL を 3 値側で `wsl` に増やさない。増やせば `case "$_agmsg_platform" in msys|macos|linux)` の既存呼び出しが黙って default に落ちる。

**維持する範囲:** `#1` `#2` `#3` を含む v1 一式。`#2` で pid / cmdline の msys 分岐を windows ドライバーへ移しても、facade 関数自体は残す。残呼び出しと既存 bats が 3 値のまま動くため。

**外してよい条件（v1 ではやらない）:**

1. in-tree で `_agmsg_platform` を読むのが facade 自身だけになった
2. その直前のリリースの CHANGELOG で 3 値を deprecated と書いた
3. テストが `platform_detect` の 4 値を正本に書き換わった

3 値は underscore 付きの内部 API なので、外部 plugin への約束ではない。それでも in-tree のテストと残呼び出しがあるあいだは、検出 4 値と同時に消さない。

Cygwin は互換対象に入れない。現行は `CYGWIN*` を `msys` に畳んでいるが、v1 は拒否へ変える。Git Bash / MSYS2 / Linux / macOS / WSL の 3 値写像だけを維持する。

## 保存する project path の正本と入口

正規化した path を **書く** 場所と、**照合する** 場所を分ける。join だけ直して他が生の pwd を保存すると、今回の事故が再発する。

正本の書き手は `join.sh` ただ一つである。登録レコードの `project` 欄に入る文字列は、`platform_canonical_project_path` を通した値だけにする。

**Windows 入力のバックスラッシュはスラッシュ化する。拒否しない。** `platform_canonical_project_path` は windows 系統で `\` を `/` に置き換えてから、既存のドライブ文字規則（`C:/Users/me/project`）を適用する。PowerShell の `C:\Users\me\project` も Git Bash の `C:/Users/me/project` も同じ正本になる。混ぜて残したり、`\` を見た瞬間に拒否したりしない。posix 系統は `\` を区切りと見なさず、来た文字をそのまま扱う。

| 入口 | 役割 | いまの関数 | `#1` でやること |
|---|---|---|---|
| `join.sh` | **保存の正本** | `agmsg_normalize_project_path` して registrations に書く | platform 正規化に委譲。書いた値が正本 |
| `spawn.sh` | 保存の手前 | 自分で normalize してから join する | 同じ API。join が最終的に書く |
| `whoami.sh` | 照合 | `agmsg_resolve_project` → `identities.sh` | 生 pwd を保存しない。照合だけ |
| `identities.sh` | 照合 | `agmsg_project_sql_in_list`（variant 展開） | 同じ。保存しない |
| `session-start.sh` | 照合 | `identities.sh` に PROJECT を渡す。自分では normalize しない | 渡す前に platform 正規化を通す |
| `peek.sh` | 照合 | normalize 同士の比較 | 同じ API。保存しない |
| `lib/resolve-project.sh` | 実装本体 | `canonical` + `normalize` + variants | normalize / variants を platform へ委譲 |
| Codex `_delivery.sh` | type 固有の照合 | `normalize(canonical())` | 同じ API。保存しない |

`actas-claim.sh` と Codex の session-start / record-session / bridge-launcher は `agmsg_canonical_path`（symlink 解決）を使う。これは filesystem identity であり、綴りの正規化ではない。platform の path 正本とは別物のままにする。

照合の variant が許す差は次だけである。

- ドライブ文字の大小（`C:` と `c:`）
- 末尾スラッシュの有無

**許さないこと:**

- WSL の `/mnt/c/Users/...` を `C:/Users/...` へ畳む
- Windows native の `C:/Users/...` と WSL の `/mnt/c/Users/...` を同一プロジェクトとみなす（同一物理ディレクトリでも、別環境として一致させない）
- Cygwin の `/cygdrive/c` を `C:/` へ畳む

回帰テストはこの 3 つを固定する。

## 段階

**#1 契約と検出（Codex 以外の Windows 経路を含む）**

- `scripts/drivers/platforms/posix.sh` と `windows.sh`
- 検出、path 正本、Git Bash パス
- 共有 SKILL.md に Git Bash 指示。`codex/template.md` の `shell-extra` を空に戻す
- 上表の入口が platform 正規化を使う。保存は `join.sh` だけ
- `compat.sh` の 3 値は facade として残す（写像は上表）
- README の Windows 節を type 非依存にする

これで claude-code / grok-build / antigravity / Codex の Windows 席はどれも `C:/Users/...` になる。WSL 席の `/home/me/...` は触らない。

`#1` だけで今回の path 事故を止める、という主張の範囲は次である。全 type の Windows native で Git Bash が選ばれ、**保存と照合の全経路**が platform API を通ること。join だけ、または SKILL 文面だけでは足りない。

**#2 compat の移動**

- pid / cmdline / uuid / sha256 の msys 分岐を windows ドライバーへ
- `compat.sh` は薄い facade にして既存呼び出しを壊さない（3 値はまだ残す）

**#3 端末・spawn の `uname` 直読みを減らす**

- `spawn.sh` の MSYS_GUARD と `.command`、`plain/ops.sh` の Darwin/MINGW は、端末軸が platform に「今 windows か macos か」を尋ねる形へ。吸い上げすぎない。

Cygwin 正式対応、`/mnt/c` → `C:/` 変換、platform の plugin 化はしない。3 値 API の削除もこの 3 段階には入れない。

## agmsgd との関係

[Discussion #1265](https://github.com/fujibee/agmsg/discussions/1265) の RFC は watcher と sync engine を 1 デーモンに畳む。path の正本も「どの bash で pwd を取るか」も対象外。デーモン導入後も、セッションをプロジェクトへ結ぶときにこの層が要る。先に足しても捨て作業にならない。

## 検証

- Windows native × 各 type（claude-code / codex / grok-build / antigravity）: Git Bash 経由 join → 登録が `C:/Users/...`。`whoami` が Windows path で exact match
- 同じマシンの WSL × 同じ type: join → `/home/me/...`。`C:/` とも `/mnt/c` とも一致しない
- `/mnt/c/Users/...` と `C:/Users/...` を variant 比較しても一致しない
- Cygwin は検出で拒否し、4 値のどれにもならない
- 回帰: Linux と mac の whoami / join が変わらない
- Codex overlay を空にしたあと、描画済み Codex SKILL にも Git Bash 節が残る（共有本文由来）
- claude-code / grok-build / antigravity の描画 SKILL に、初めて同じ Git Bash 節が出る
- `platform_detect` は 1 語、`platform_describe` の `name` は `posix|windows`。describe を `case` する呼び出しが in-tree に無い
- `#1` のあと `_agmsg_detect_platform` はまだ 3 値を返し、既存 `compat.sh` の bats が通る
- windows 系統で Git Bash が無い（またはテストがパスを外した）とき、`platform_check` と `platform_bash_exe` は非ゼロ。`join.sh` は registrations を書かずに終わる。PATH の `bash` へ落ちない
- windows 系統の `platform_canonical_project_path` は `C:\Users\me\project` を `C:/Users/me/project` にする。拒否しない。posix 系統は `\` を区切りにしない
- Git Bash 探索は `AGMSG_GIT_BASH`、`Program Files`、`Program Files (x86)`、`%LOCALAPPDATA%/Programs/Git` の順。`WindowsApps` と PATH の `bash` は採用しない。`AGMSG_GIT_BASH` が壊れていれば後続へ落ちず失敗する
- `AGMSG_GIT_BASH` は `C:\...`、`C:/...`、`/c/...` を同一視する。相対パスは失敗。`LOCALAPPDATA` 未設定ならユーザーインストール候補を飛ばす。ディレクトリや開けないファイルは失敗
- 「誰が何を持つか」や SKILL の Git Bash パスは探索順の説明であり、実装は `platform_bash_exe` だけを正本にする。固定の `C:/Program Files/Git/bin/bash.exe` 直書きで探索を省略しない
- v1: Git Bash 経由の Windows native join は `C:/Users/...`。Win32 親 + WSL bash の join 拒否は **検証しない**（v1.1 の範囲。v1 では detect が `wsl` になり `/mnt/c` を保持しうる）

## やらないこと

- type ごとに Git Bash 文をコピーする（Codex にだけあった状態へ戻すこと）
- WSL の `/mnt/c` を Windows 正本に畳む
- Cygwin を v1 の windows ドライバーに含める
- platform をユーザーが選ぶ plugin 軸にする
- `platform_describe` の出力を機械判定に使う
- `#1` と同時に compat 3 値を消す
- Git Bash が無いとき PATH の `bash`（WSL shim）へフォールバックする
- Windows 入力の `\` を拒否する（スラッシュ化が正）
- Git Bash の場所を `C:/Program Files/Git/bin/bash.exe` の単一例だけにする
- `AGMSG_GIT_BASH` の相対パスを受け入れる
- `LOCALAPPDATA` 未設定のときユーザー名を推測して埋める
- v1 で Win32 親 + WSL bash を拒否する（それは v1.1）
