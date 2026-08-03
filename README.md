# Answer-first Interview Assistant v0.2.14

Windows 11用の面接支援オーバーレイです。Google Meet、Zoom、Webexなどの会議とは独立して動作し、PCで再生される相手の音声を連続的に取り込みます。

この版では、最新質問だけの表示、重複音声の削減、日本語ガイドの固定表示、回答本文を消さない更新、API使用量のローカル記録、固定Cheat sheetの説明追加、Stop後の更新停止を行っています。

## MVPでできること

- 常に手前に表示される半透明オーバーレイ
- Windowsの公式キャプチャ除外機能による共有画面保護
- 相手の最新質問だけの英語原文表示（手動スクロール不要）
- 履歴書、募集要項、想定問答などを根拠にした回答候補
- Interviewer表示直後から回答をストリーミング表示
- Interviewer表示から最初の回答表示までの実測時間
- 回答から抽出した、そのまま使える完成済みフレーズ
- 固定表示できるCheat sheet
- 面接終了後のMarkdown議事録
- Phrase Memoryへ将来取り込めるJSONエクスポート
- APIキーのWindows暗号化保存
- このアプリから発生したAPIリクエスト数とResponses APIのトークン使用量の表示
- 音声チャンクをアプリ内に保存しない設計

## 重要な制約

- 共有画面保護はWindowsの `WDA_EXCLUDEFROMCAPTURE` を利用します。Google Meet、Zoom、Webexの共有方式やバージョンによって挙動が異なる可能性があるため、**本番前に必ず共有プレビューと別端末で確認してください**。
- MVPはWindows 11のシステム音声を対象にしています。Bluetooth機器、仮想オーディオ機器、企業端末のポリシーによって音声取得ができない場合があります。
- 音声は連続録音し、通常は約2秒の短い窓を0.5秒だけ重ねて約1.5秒ごとに文字起こしします。短い質問や発話の終わりに残った音声は、約0.8秒の無音後に追加送信します。v0.2.3より同じ音声の再送を減らし、結果の順序は保持します。
- Interviewerには現在の質問だけを表示し、過去の発話を画面上で積み上げません。面接後のNotes作成用には、質問と回答の履歴をアプリ内で保持します。
- `tell me about yourself`、`walk me through your resume`などの典型的な面接質問は、認識できた時点で通常より早く回答準備へ進みます。
- 無音、短すぎる認識結果、`You are ChatGPT...`などの典型的な誤認識は回答処理へ渡しません。
- Interviewer欄へ文字が出た後は、Your Answerを完成まで待たずに逐次表示します。最初の回答文字は1秒以内を目標にし、画面右上に`Started 0.8s`のように実測値を表示します。回線やAPIの混雑に左右されるため、1秒以内を常に保証するものではありません。
- 回答速度とコストを抑えるため、AIには最新の質問と直前2問までの文脈を送ります。Candidate information全体から質問に関係する部分だけを絞り、回答の根拠は登録情報に限定します。
- 同時翻訳はMVPから外しています。画面に出る英語回答を、そのまま発話できることを優先します。
- PDFやWordファイルの直接取込は未対応です。初期版ではテキストを貼り付けるか、`.txt`、`.md`、`.csv`、`.json`を読み込んでください。
- 録音、文字起こし、リアルタイムAI支援が会議・面接のルール上許可されていることを利用者自身で確認してください。

## Windows 11でのインストール（推奨）

GitHub Releasesから`Interview-Overlay-Setup-0.2.14-x64.exe`をダウンロードし、最初の1回だけ実行します。以後はアプリが起動時に新版を確認し、バックグラウンドでダウンロードします。更新準備が整うと再起動するか確認します。

MVP段階ではコード署名を行っていないため、初回にWindows SmartScreenの警告が表示される場合があります。

## 開発環境での起動

Node.js 22以降をインストールしてから、PowerShellでこのフォルダを開きます。

```powershell
npm install
npm start
```

初回起動時にSettingsが開きます。

1. OpenAI API keyを入力します。
2. Candidate informationに履歴書、募集要項、想定質問、実績などを貼り付けます。
3. `Test connection`を押します。
4. `Save settings`を押します。
5. 必要なら`Cheat sheet`に自己紹介、主要実績、転職理由、逆質問などを登録します。
6. Zoomなどの会議を開始し、Interview Overlayで`Start interview`を押します。

## Windows用インストーラーの作成

Windows上のPowerShellで次を実行します。

```powershell
npm install
npm run dist:win
```

生成物は`dist`フォルダに作られます。GitHubへ`v0.2.14`のようなタグをpushすると、GitHub Actionsがテスト後にSetup.exeと自動更新用ファイルをReleaseへ公開します。

## ショートカット

- `Ctrl + Shift + H`: オーバーレイを隠す／再表示する
- `Ctrl + Shift + T`: マウス操作を背面の会議画面へ通す／解除する

## Phrase Memory連携

v0.2.5では、面接中の回答と完成済みフレーズを`Export for Phrase Memory`からJSONに出力できます。これは直接同期ではなく、将来のAPIまたはWeb連携に置き換えられる共通契約です。

出力はPhrase Memoryの既存レコードに合わせて、`japanese`、`scene`、`spoken`、`written`、`chunks`、`createdAt`、`status`、`source`を含みます。現時点では日本語入力がないため、`japanese`は空欄になる場合があります。

Click-throughを有効にすると画面上のボタンを押せなくなります。`Ctrl + Shift + T`で解除できます。

Click-throughは「オーバーレイをクリックできなくして、背面のMeet/Zoom/Webexを操作できるようにする」機能です。オンの間はアプリ画面をクリックしても反応しません。解除は必ず`Ctrl + Shift + T`で行います。

タスクバーにはアイコンを出さない設定にしています。オーバーレイを隠した後に戻す場合は`Ctrl + Shift + H`を使ってください。

## 推奨する実機テスト

1. Google Meetで「画面全体」を共有し、別アカウント・別端末からオーバーレイが見えないことを確認する。
2. Zoom、Webexでも同じ確認を行う。
3. PCスピーカー、USBヘッドセット、Bluetoothイヤホンで文字起こしを比較する。
4. 英語の質問を10件読み上げ、原文、回答候補、完成済みフレーズの正確さと`Started`の時間を記録する。
5. 回答候補に、候補者情報にない実績や数字が混ざっていないことを確認する。

## 使用モデル

- 文字起こし: `gpt-transcribe`
- 回答候補・フレーズ抽出・議事録: `gpt-5.6-sol`（reasoning effort: low）

モデル名はSettingsから変更できます。

## API使用量について

Settingsの`API usage from this app`には、このアプリが起動してから記録したリクエスト数、Responses APIの入力・出力トークン数、音声文字起こしのリクエスト数を表示します。v0.2.3より前の利用分はアプリ内には記録されません。

正確なドル額は、Settingsの`Open OpenAI Usage dashboard`からOpenAIのUsage画面で確認してください。音声文字起こしはトークン合計には含まれません。
