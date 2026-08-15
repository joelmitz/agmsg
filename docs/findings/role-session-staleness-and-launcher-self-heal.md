# role-session レコードの陳腐化と、launcher の自己修復ループによる第三者救済

2026-08-16、babelbiblenet-v2 プロジェクトでの Issue #85（起動時 self-test・三層診断の実装）の
実運用検証中に見つけた現象の記録。実装コードの変更ではなく、運用上の知見のメモ。

## 発生した現象

1. herdr（外部のセッション復元ツール）が起動時に `codex resume --last` で以前の会話
   （thread A）を復元した
2. ユーザーが `/quit` でその会話を終了し、シェルへ戻ってから **resume 無しで素の
   `codex`** を起動した。これは新しい空の会話（thread B）になる
3. `codex --remote` で接続する既存の app-server・bridge（`codex-bridge.js`）は
   このユーザー操作を通じて**一度も再起動しなかった**（app-server・bridge は
   TUI クライアントとは別プロセス・別ライフサイクルで、共有・再利用される設計のため）
4. bridge は起動時に一度だけ `--thread <id>` を確定させ、以後プロセスが生きている
   間ずっとその thread に固定される（`ensureThread()` は起動時に1回しか呼ばれない）
5. 結果として、bridge は古い thread A に固定されたまま、ユーザーの画面には
   新しい thread B が表示され続ける状態になった（実測: agmsg 経由のテスト送信が
   thread A で処理され、画面上の thread B には一切表示されなかった）

## 診断ツールが検知できなかった理由

`codex-diagnose.sh`（Issue #85 で追加した三層診断）はこの不一致を **`MATCH`** と
誤診断した。原因は、診断の thread 層が「bridge の bound thread」と「role-session
レコードに記録された seat」を比較していたが、**この record 自体が古い thread A の
まま更新されていなかった**ため。診断はレコードとの一致だけを見ており、
「今実際に画面に見えている thread と一致しているか」を見ていなかった。

`--remote` 接続の codex セッションは `CODEX_THREAD_ID` を hook へ export せず
rollout も書かないため（既存コードのコメントに明記済み）、SessionStart 相当の
報告経路が無く、record を更新する契機が構造的に存在しない。

## 発見: launcher 自身に既に自己修復の仕組みがあった

`codex-bridge-launcher.sh` の主ループ（既に稼働中のプロセスとして常時ポーリングしている）は、
反復のたびに role-session レコードを読み直し、現在稼働中の bridge の bound thread と
比較している。

- 一致していれば何もしない（`poll_sleep; continue`）
- **不一致なら、既存の bridge を自ら `kill` し、レコードの thread で新しい bridge を
  起動し直す**（コード内コメント: "The role-session record is the sole thread
  authority"）

ポーリング間隔は `POLL_STEPS=(0.3 0.6 1.2 2)` 秒のバックオフで、定常状態では
最大2秒に1回。

## 第三者でなければできなかった理由

この現象に気づいた時点で、ユーザーは「ゾンビ thread（A）に実装作業をさせたくない。
理由は自分の画面（thread B）から進捗を監視できないから」と明確に述べた。

ここで重要なのは、**thread A 上で動いている codex 自身には、この状況を自力で
修復する手段が無い**という点である。

- thread A 上の codex は、自分がゾンビであること（画面に見えていないこと）を
  観測する方法を持たない（`herdr agent get codex` は agent_session を報告して
  おらず、diagnosis も MATCH と誤診断していたため、外形的な手がかりが無い）
- 仮に thread A 上の codex が role-session レコードを自分で書き換えたとしても、
  **launcher はその bridge プロセス自身を kill する**ため、書き換えた本人ごと
  終了させられる——自己終了を指示するタスクを自分に課すことになり、実行前提が壊れる
- そもそも thread A の出力はユーザーから見えないため、修復を試みた形跡も
  結果も確認できない

**外部（今回は別セッションの Claude）が、launcher のソースコードを読んで
「レコードを直せば launcher が自ら kill してくれる」という機構を理解し、
稼働中の launcher プロセスとは独立にレコードファイルだけを書き換えたことで、
launcher 自身の既存ポーリングループが数秒以内に正しく自己修復した。**

修復後の実測:

```
codex diagnosis: MATCH
thread: MATCH seat=<thread B> bridge=<thread B>
```

self-test の受信確認が実際に画面（thread B）上に表示されることも確認した。

## 示唆

- 三層診断（`codex-diagnose.sh`）の thread 層は、record との一致だけでなく、
  **record 自体の鮮度**（いつ最後に正当な経路で更新されたか）も判定材料に含めるべき
- `--remote` セッションで SessionStart 相当の報告経路が無い場合の record 更新手段が
  必要（Issue #85 の修正方針案 (2)(3) で議論済み: app-server の loaded thread の
  差分検知で新規出現 thread を候補にする案）
- launcher の自己修復ループ自体は正しく機能しており、**壊れていたのは
  「いつ・何を根拠にレコードを更新するか」の一段手前の判断**だった
