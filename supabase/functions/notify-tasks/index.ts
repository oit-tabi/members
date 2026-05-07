// supabase/functions/notify-tasks/index.ts
// ============================================================
// 毎朝8時に自動実行（Supabase Dashboard > Edge Functions > Schedule）
// Cron: "0 23 * * *" (UTC 23:00 = JST 8:00)
//
// 通知タイミング:
//   - タスク期限の 7日前・3日前・1日前・当日
//   - 企画部: 日程未定イベントがあれば毎週月曜に通知
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TASK_OFFSETS: Record<string, Record<string, number>> = {
  '飲み会系': { '日程・場所候補を出す': -21, '参加者確認・出欠集計': -14, '予約を取る': -10, '集金方法を決める': -7, 'SNS告知': -10, '当日集金・精算': 0 },
  '日帰り系': { '目的地・ルート候補を出す': -28, '予算案を作る': -21, '参加者確認・出欠集計': -21, '交通手段の手配': -14, '安全管理チェック': -3, 'SNS告知・写真投稿': -14, '集金・立替精算': 1, '活動記録をまとめる': 3 },
  '泊まり系': { '行先・宿候補を出す': -42, '詳細スケジュール作成': -28, '予算案を作る': -28, '参加者確認・出欠集計': -35, '宿・交通の予約': -28, '安全管理・緊急連絡先整理': -7, 'SNS告知・写真投稿': -21, '事前集金': -14, '当日精算': 0, '活動記録をまとめる': 3 },
}

async function sendLine(token: string, userId: string, text: string) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
  })
}

serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const lineToken = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const isMonday = today.getDay() === 1

  const { data: events } = await supabase.from('events').select('*')
  const { data: allTasks } = await supabase.from('tasks').select('*').eq('done', false)
  const { data: members } = await supabase.from('members').select('*')

  if (!events || !allTasks || !members) return new Response('no data')

  let sent = 0

  // ── 1. タスク期限リマインダ（役職別）──
  const notify: Record<string, string[]> = {}

  for (const task of allTasks) {
    const ev = events.find((e: any) => e.id === task.event_id)
    if (!ev?.date) continue

    const m = ev.date.match(/(\d{1,2})[\/\-.](\d{1,2})/)
    if (!m) continue

    const eventDate = new Date(today.getFullYear(), +m[1]-1, +m[2])
    if (eventDate < today) continue

    const offset = task.offset_days ?? TASK_OFFSETS[ev.type]?.[task.name]
    if (offset == null) continue

    const deadline = new Date(eventDate)
    deadline.setDate(deadline.getDate() + offset)
    deadline.setHours(0, 0, 0, 0)
    const daysLeft = Math.round((deadline.getTime() - today.getTime()) / 86400000)

    if (![7, 3, 1, 0].includes(daysLeft)) continue

    const urgency = daysLeft === 0 ? '🔴 【本日期限】' : daysLeft === 1 ? '🟠 【明日期限】' : `📋 【${daysLeft}日前】`
    const msg = `${urgency} ${ev.title}\n「${task.name}」\n期限: ${deadline.getMonth()+1}/${deadline.getDate()}（イベント: ${ev.date} 頃）`

    if (!notify[task.role]) notify[task.role] = []
    notify[task.role].push(msg)
  }

  for (const [role, msgs] of Object.entries(notify)) {
    const roleMembers = members.filter((m: any) => m.role === role && m.line_user_id && !m.banned)
    const text = `✈️ OIT旅サー タスクリマインダー\n\n` + msgs.join('\n\n')
    for (const member of roleMembers) {
      await sendLine(lineToken, member.line_user_id, text)
      sent++
    }
  }

  // ── 2. 企画部: 日程未定イベントのリマインダ（毎週月曜）──
  if (isMonday) {
    const undated = events.filter((ev: any) => !ev.date)
    if (undated.length > 0) {
      const planners = members.filter((m: any) => m.role === '企画' && m.line_user_id && !m.banned)
      const eventList = undated.map((ev: any) => `・${ev.title}（${ev.month}）`).join('\n')
      const text = `✈️ OIT旅サー 企画リマインダー\n\n以下のイベントの日程がまだ未設定です。スケジュールを立てましょう！\n\n${eventList}\n\nアプリから日程を入力してください。`
      for (const member of planners) {
        await sendLine(lineToken, member.line_user_id, text)
        sent++
      }
    }
  }

  return new Response(JSON.stringify({ sent, task_roles: Object.keys(notify), monday_reminder: isMonday }))
})
