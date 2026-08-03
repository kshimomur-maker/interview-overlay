# 初回登録（この1回だけ）

1. GitHub Desktopを開き、`File` → `Clone repository` → `URL`を選ぶ。
2. `https://github.com/kshimomur-maker/interview-overlay` を入力して `Clone`する。
3. このフォルダ内のファイルをすべて、Cloneした `interview-overlay` フォルダへコピーする。
4. GitHub Desktop左下のSummaryへ `Initial v0.2.14 release` と入力する。
5. `Commit to main`を押し、続いて`Push origin`を押す。
6. GitHubのActionsが完了したら、ReleasesからSetup.exeをダウンロードする。

Setup.exeを一度インストールすれば、次回以降のアプリ更新は自動で届きます。

## 注意

- `.github`フォルダも必ずコピーしてください。ここに自動ビルド設定があります。
- GitHub Actionsが同じバージョンを二度公開しないよう、今後の修正時は必ず`package.json`のversionを上げます。
