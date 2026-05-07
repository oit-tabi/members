# OIT旅サー 活動管理アプリ

**バージョン: α版**  
**リポジトリ: https://github.com/oit-tabi/members**  
**公開URL: https://oit-tabi.github.io/members**

---

## 目次

1. [概要](#概要)
2. [システム構成](#システム構成)
3. [セットアップ手順](#セットアップ手順)
4. [データベース仕様](#データベース仕様)
5. [Edge Functions仕様](#edge-functions仕様)
6. [通知システム仕様](#通知システム仕様)
7. [フロントエンド仕様](#フロントエンド仕様)
8. [役職と権限](#役職と権限)
9. [運用ガイド](#運用ガイド)
10. [既知の問題（β版で改善予定）](#既知の問題β版で改善予定)

---

## 概要

OIT旅行サークルのメンバー専用活動管理Webアプリ。LINEアカウントで認証し、イベントの企画・タスク管理・準備スケジュール・LINE自動通知を一元管理する。

### 主な機能

- LINEログイン（LIFF）によるメンバー認証・自動登録
- イベント管理（年度別・日程順ソート）
- 役職別タスクフィルタリングと進捗管理
- イベント日程から逆算した準備タイムライン
- LINE Push通知（タスクリマインダー・順番通知・企画リマインダー・遅延アラート）
- 通知のオプトアウト機能
- メンバー一覧・役職変更

---

## システム構成

```
┌─────────────────────────────────────────┐
│  メンバーのスマホ（LINE）                  │
│  ↓ LIFFでアプリを開く                    │
│  ↓ LINE認証（userId取得）                │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│  GitHub Pages                           │
│  index.html（SPA）                      │
│  - HTML / CSS / Vanilla JS              │
│  - Supabase JS SDK                      │
│  - LINE LIFF SDK                        │
└──────────────┬──────────────────────────┘
               │ REST API / Edge Functions
┌──────────────▼──────────────────────────┐
│  Supabase（eozpsstfwwcjljpmbtir）        │
│  ├── PostgreSQL DB                      │
│  │   ├── members                        │
│  │   ├── events                         │
│  │   ├── tasks                          │
│  │   └── notifications_sent             │
│  ├── Edge Functions（Deno）             │
│  │   ├── line-auth                      │
│  │   ├── notify-tasks                   │
│  │   └── notify-self-test               │
│  └── pg_cron（毎朝8時JSTに実行）         │
└──────────────┬──────────────────────────┘
               │ Push Message API
┌──────────────▼──────────────────────────┐
│  LINE Messaging API                     │
│  （メンバーのLINEに通知を送信）           │
└─────────────────────────────────────────┘
```

### 使用サービス

| サービス | 用途 | プラン |
|------|------|------|
| GitHub Pages | フロントエンドホスティング | 無料（パブリックリポジトリ） |
| Supabase | DB・Edge Functions | 無料枠 |
| LINE LIFF | メンバー認証 | 無料 |
| LINE Messaging API | プッシュ通知 | 無料枠（月1000通まで） |

---

## セットアップ手順

### 1. GitHubリポジトリ

`oit-tabi` organizationの `members` リポジトリにファイルを配置し、GitHub Pages（Source: Deploy from a branch / main / root）を有効化。

公開URLは `https://oit-tabi.github.io/members` になる。

### 2. Supabaseプロジェクト作成

1. https://supabase.com でプロジェクト作成
2. Dashboard → SQL Editor で `supabase/schema.sql` を実行
3. Dashboard → Settings → API から以下を取得：
   - **Project URL** → `index.html`の`SUPABASE_URL`に設定
   - **Publishable key（anon）** → `index.html`の`SUPABASE_ANON_KEY`に設定

### 3. LINE Developers設定

#### LINEログインチャンネル
1. https://developers.line.biz でチャンネル作成（LINEログイン）
2. **Channel ID** → `index.html`の`LINE_CLIENT_ID`に設定
3. **Channel secret** → Supabaseの`LINE_CLIENT_SECRET`シークレットに設定
4. LINEログイン設定タブ → コールバックURL: `https://oit-tabi.github.io/members`
5. LIFFタブ → 追加（サイズ: Full、エンドポイント: `https://oit-tabi.github.io/members`）
6. **LIFF ID** → `index.html`の`LIFF_ID`に設定

#### Messaging APIチャンネル
1. https://manager.line.biz から公式アカウントのMessaging APIを有効化
2. LINE DevelopersでMessaging APIチャンネルを確認
3. チャンネルアクセストークン（長期）を発行
4. **アクセストークン** → Supabaseの`LINE_CHANNEL_ACCESS_TOKEN`シークレットに設定

### 4. Supabase Edge Functions

Dashboard → Edge Functions から以下を作成・デプロイ（JWT認証はOFF）：

| 関数名 | ファイル |
|------|------|
| `line-auth` | `supabase/functions/line-auth/index.ts` |
| `notify-tasks` | `supabase/functions/notify-tasks/index.ts` |
| `notify-self-test` | `supabase/functions/notify-self-test/index.ts` |

Secrets（Dashboard → Edge Functions → Secrets）に設定：

```
LINE_CLIENT_ID            = LINEログインのChannel ID
LINE_CLIENT_SECRET        = LINEログインのChannel secret
LINE_CHANNEL_ACCESS_TOKEN = Messaging APIのアクセストークン
```

### 5. 通知スケジュール設定

Dashboard → Database → Extensions で `pg_cron` を有効化後、SQL Editorで実行：

```sql
select cron.schedule(
  'notify-tasks-daily',
  '0 23 * * *',
  $$
  select net.http_post(
    url := 'https://eozpsstfwwcjljpmbtir.supabase.co/functions/v1/notify-tasks',
    headers := '{"Authorization": "Bearer YOUR_ANON_KEY", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
```

`0 23 * * *` はUTC 23:00 = JST 8:00。

### 6. index.htmlの設定値

`index.html`冒頭の設定ブロックを書き換える：

```javascript
const SUPABASE_URL      = 'https://eozpsstfwwcjljpmbtir.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_PUBLISHABLE_KEY';
const LINE_CLIENT_ID    = 'YOUR_CHANNEL_ID';
const APP_URL           = 'https://oit-tabi.github.io/members';
const LIFF_ID           = 'YOUR_LIFF_ID';
```

---

## データベース仕様

### membersテーブル

メンバーのホワイトリスト兼プロフィール。初回ログイン時に自動登録される。

| カラム | 型 | 説明 |
|------|------|------|
| id | uuid | PK（自動生成） |
| line_user_id | text | LINE userID（U + 32文字）。UNIQUE |
| name | text | LINEの表示名 |
| role | text | 役職。`代表/副代表/企画/渉外/会計/宣伝/一般` |
| banned | boolean | BANフラグ。trueにするとアクセス拒否 |
| notify | boolean | 通知フラグ。falseにすると全通知停止 |
| created_at | timestamptz | 登録日時 |

### eventsテーブル

年度別のイベント一覧。

| カラム | 型 | 説明 |
|------|------|------|
| id | uuid | PK（自動生成） |
| title | text | イベント名 |
| month | text | 開催月（例: `4月`） |
| type | text | 種別。`飲み会系/日帰り系/泊まり系` |
| date | text | 仮日程（例: `6/14`）。未定はnull |
| place | text | 場所（任意） |
| memo | text | メモ・予算（任意） |
| year | int | 年度（例: `2026`） |
| sort_order | int | 表示順 |
| created_at | timestamptz | 作成日時 |

### tasksテーブル

イベントに紐づくタスク一覧。

| カラム | 型 | 説明 |
|------|------|------|
| id | uuid | PK（自動生成） |
| event_id | uuid | FK → events.id（CASCADE DELETE） |
| name | text | タスク名 |
| role | text | 担当役職 |
| done | boolean | 完了フラグ |
| offset_days | int | イベント日からの期限オフセット（日数）。nullはデフォルト値を使用 |
| sort_order | int | 表示順 |
| created_at | timestamptz | 作成日時 |

### notifications_sentテーブル

通知の重複送信防止用ログ。

| カラム | 型 | 説明 |
|------|------|------|
| id | uuid | PK |
| line_user_id | text | 送信先のLINE userID |
| type | text | 通知種別。`deadline/myturn/planning/overdue` |
| ref_id | text | 通知の一意識別子 |
| sent_at | timestamptz | 送信日時 |

`(line_user_id, type, ref_id)` にUNIQUE制約。

---

## Edge Functions仕様

### line-auth

LINEログインのOAuth認証コードをLINE userIDに変換するプロキシ。フロントエンドから直接LINE APIを呼べないため中継している。

**エンドポイント**: `POST /functions/v1/line-auth`

**リクエスト**:
```json
{ "code": "OAuth認証コード", "redirect_uri": "コールバックURL" }
```

**レスポンス**:
```json
{ "userId": "Uxxxxxx", "displayName": "表示名", "pictureUrl": "アイコンURL" }
```

**処理フロー**:
1. LINEのトークンエンドポイントに`code`を送信してアクセストークンを取得
2. アクセストークンでLINEプロフィールAPIを呼び出してuserIDを取得
3. userIDをフロントエンドに返す

### notify-tasks

毎朝8時（JST）に自動実行される通知ハンドラ。4種類の通知を処理する。

**エンドポイント**: `POST /functions/v1/notify-tasks`

**処理フロー**:

```
1. events・tasks・membersを全件取得
2. 通知1（タスク期限リマインダー）
   - 未完了タスクの期限を計算
   - 7日前・3日前・1日前・当日に担当役職のメンバーに送信
   - notifications_sentで重複チェック
3. 通知2（自分の番通知）
   - 今月・来月のイベントが対象
   - タスクを役職グループ順にチェック
   - 前グループが全完了 & 自分のタスクが未完 → 送信
   - notifications_sentで重複チェック
4. 通知3（企画リマインダー）
   - 毎月15日のみ実行
   - 来月の日程未定イベントがあれば代表・副代表・企画に送信
5. 通知4（遅延アラート）
   - 期限切れ未完タスクを集計
   - 代表1人のみに毎日1回送信
```

**役職グループの順序**（`TASK_ORDER`定数で定義）:

| 種別 | 順序 |
|------|------|
| 飲み会系 | 企画 → 渉外 → 会計 → 宣伝 |
| 日帰り系 | 企画 → 渉外 → 宣伝 → 会計 → 代表 |
| 泊まり系 | 企画 → 渉外 → 宣伝 → 会計 → 代表 |

### notify-self-test

自分宛にテスト通知を送る。メンバーが通知設定を確認するために使用。

**エンドポイント**: `POST /functions/v1/notify-self-test`

**リクエスト**:
```json
{ "line_user_id": "Uxxxxxx", "name": "表示名" }
```

---

## 通知システム仕様

### タスクデフォルト期限オフセット

tasksテーブルの`offset_days`がnullの場合、以下のデフォルト値を使用（`TASK_OFFSETS`定数）。個別に変更した場合は`offset_days`に保存される。

**飲み会系**

| タスク | 役職 | オフセット |
|------|------|------|
| 日程・場所候補を出す | 企画 | -21日 |
| 参加者確認・出欠集計 | 渉外 | -14日 |
| 予約を取る | 渉外 | -10日 |
| 集金方法を決める | 会計 | -7日 |
| SNS告知 | 宣伝 | -10日 |
| 当日集金・精算 | 会計 | 0日 |

**日帰り系**

| タスク | 役職 | オフセット |
|------|------|------|
| 目的地・ルート候補を出す | 企画 | -28日 |
| 予算案を作る | 企画 | -21日 |
| 参加者確認・出欠集計 | 渉外 | -21日 |
| 交通手段の手配 | 渉外 | -14日 |
| 安全管理チェック | 渉外 | -3日 |
| SNS告知・写真投稿 | 宣伝 | -14日 |
| 集金・立替精算 | 会計 | +1日 |
| 活動記録をまとめる | 代表 | +3日 |

**泊まり系**

| タスク | 役職 | オフセット |
|------|------|------|
| 行先・宿候補を出す | 企画 | -42日 |
| 詳細スケジュール作成 | 企画 | -28日 |
| 予算案を作る | 企画 | -28日 |
| 参加者確認・出欠集計 | 渉外 | -35日 |
| 宿・交通の予約 | 渉外 | -28日 |
| 安全管理・緊急連絡先整理 | 渉外 | -7日 |
| SNS告知・写真投稿 | 宣伝 | -21日 |
| 事前集金 | 会計 | -14日 |
| 当日精算 | 会計 | 0日 |
| 活動記録をまとめる | 代表 | +3日 |

---

## フロントエンド仕様

### 技術スタック

- Vanilla JavaScript（フレームワークなし）
- Supabase JS SDK v2（CDN）
- LINE LIFF SDK v2（CDN）
- 単一HTMLファイル構成（CSS・JSをインライン）

### 主要な状態変数

```javascript
let dbClient       // Supabaseクライアント
let currentUser    // ログイン中ユーザー情報 { userId, displayName, pictureUrl, role, notify }
let events         // 現在の年度のイベント一覧
let tasks          // イベントIDをキーとしたタスクMap { event_id: [task, ...] }
let currentYear    // 表示中の年度（初期値: 2026）
let selectedRole   // フィルタ中の役職（'all' or 役職名）
```

### 主要な定数

```javascript
ROLE_COLORS        // 役職ごとの表示色 { 役職名: { bg, text } }
ALL_ROLES          // 全役職一覧（配列）
CAN_EDIT_SCHEDULE  // 編集権限を持つ役職 ['代表','副代表','企画']
TASK_TEMPLATES     // イベント種別ごとのタスクテンプレート
DEFAULT_EVENTS     // 新年度作成時のイベントテンプレート一覧
MONTHS             // 月の選択肢（配列）
MONTH_STYLE        // 月ごとの表示色
ROLE_PALETTE       // 役職選択モーダル用の色定義
```

### 認証フロー

```
1. liff.init() でLIFFを初期化
2. liff.isLoggedIn() がfalseなら liff.login() でLINE認証
3. liff.getProfile() でuserID・displayName取得
4. SupabaseのmembersテーブルでuserIDを検索
5. 未登録 → 役職選択モーダル → 自動登録
6. banned=true → アクセス拒否画面
7. 正常 → アプリ起動
```

LIFFが使えない環境（PCブラウザ等）ではlocalStorageのキャッシュを使用、なければLINE OAuthフロー（line-auth Edge Function経由）にフォールバック。

### タスクテンプレート自動挿入

`loadData`実行時、タスクが0件のイベントがあれば`autoInsertTasks`が自動的にテンプレートからタスクを挿入する。

### 年度切り替え

- 初期年度: `2026`（`currentYear`変数で管理）
- メニューの`+/-`ボタンで増減
- 切り替え後にイベントが0件なら`initYearWithTemplate`でテンプレートから自動作成
- 重複作成防止のため事前にDB確認あり

### 期限の計算

```
deadline = eventDate + offset_days
daysLeft = deadline - today
```

`offset_days`がnullの場合はタスク名をキーに`TASK_OFFSETS`定数のデフォルト値を参照。

---

## 役職と権限

| 役職 | イベント編集 | 期限変更 | タスク追加 | 通知 |
|------|------|------|------|------|
| 代表 | ✓ | ✓ | ✓ | 全通知 + 遅延アラート |
| 副代表 | ✓ | ✓ | ✓ | 全通知 |
| 企画 | ✓ | ✓ | ✓ | タスク + 企画リマインダー |
| 渉外 | ✗ | ✗ | ✓ | 担当タスクのみ |
| 会計 | ✗ | ✗ | ✓ | 担当タスクのみ |
| 宣伝 | ✗ | ✗ | ✓ | 担当タスクのみ |
| 一般 | ✗ | ✗ | ✓ | 担当タスクのみ |

権限チェックは定数`CAN_EDIT_SCHEDULE`で管理。現在はフロントエンドのみの制御。

---

## 運用ガイド

### メンバーの追加

初回アクセス時に自動登録される。役職は本人がアプリ内で設定する。

代表がSupabase Dashboard → Table Editor → membersテーブルで直接役職を変更することも可能。

### メンバーのBAN

Supabase Dashboard → Table Editor → membersテーブルで該当メンバーの`banned`を`true`に設定。

### 新年度の開始

メニューで年度を切り替えると、イベントが0件の場合テンプレートから自動作成される。

### 通知ログの確認

```sql
select * from notifications_sent order by sent_at desc limit 50;
```

### 通知スケジュールの確認・削除

```sql
-- 確認
select * from cron.job;

-- 削除して再設定したい場合
select cron.unschedule('notify-tasks-daily');
```

---

## 既知の問題（β版で改善予定）

### 機能
- **メンバー一覧のリアルタイム更新なし**：役職変更直後にメンバー一覧を開くと古い情報が表示される場合がある
- **通知テストの条件**：自分のLINE IDがmembersテーブルに正しく登録されていないと届かない
- **データ量増加による遅延**：年度をまたぐとタスクデータが増加し、読み込みが遅くなる可能性がある

### セキュリティ
- **RLSが緩い**：現在の設定では全認証済みユーザーが全データを読み書きできる。BANしても他人のデータを変更できる状態
- **フロントエンドのみの権限制御**：役職による編集制限はUI上のみで、DBレベルでは制限していない

### UX
- **タスクのチェックボックスが小さい**：スマホで操作しづらい場合がある
- **削除のundo機能なし**：誤って削除した場合に元に戻せない
