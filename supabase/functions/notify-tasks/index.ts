// supabase/functions/notify-tasks/index.ts
// 毎朝8時に実行 Cron: "0 23 * * *" (UTC 23:00 = JST 8:00)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TASK_OFFSETS: Record<string, Record<string, number>> = {
  '飲み会系': { '日程・場所候補を出す': -21, '参加者確認・出欠集計': -14, '予約を取る': -10, '集金方法を決める': -7, 'SNS告知': -10, '当日集金・精算': 0 },
  '日帰り系': { '目的地・ルート候補を出す': -28, '予算案を作る': -21, '参加者確認・出欠集計': -21, '交通手段の手配': -14, '安全管理チェック': -3, 'SNS告知・写真投稿': -14, '集金・立替精算': 1, '活動記録をまとめる': 3 },
  '泊まり系': { '行先・宿候補を出す': -42, '詳細スケジュール作成': -28, '予算案を作る': -28, '参加者確認・出欠集計': -35, '宿・交通の予約': -28, '安全管理・緊急連絡先整理': -7, 'SNS告知・写真投稿': -21, '事前集金': -14, '当日精算': 0, '活動記録をまとめる': 3 },
}

// タスクの順序（前のグループが終わったか判定用）
const TASK_ORDER: Record<string, string[]> = {
  '飲み会系': ['企画', '渉外', '会計', '宣伝', '会計'],
  '日帰り系': ['企画', '渉外', '宣伝', '会計', '代表'],
  '泊まり系': ['企画', '渉外', '宣伝', '会計', '代表'],
}

async function sendLine(token: string, userId: string, text: string) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
  })
  return res.ok
}

async function alreadySent(supabase: any, userId: string, type: string, refId: string) {
  const { data } = await supabase
    .from('notifications_sent')
    .select('id')
    .eq('line_user_id', userId)
    .eq('type', type)
    .eq('ref_id', refId)
    .single()
  return !!data
}

async function markSent(supabase: any, userId: string, type: string, refId: string) {
  await supabase.from('notifications_sent').upsert({
    line_user_id: userId, type, ref_id: refId
  }, { onConflict: 'line_user_id,type,ref_id' })
}

serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const lineToken = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMonth = today.getMonth() + 1
  const todayDay = today.getDate()
  const nextMonth = todayMonth === 12 ? 1 : todayMonth + 1

  const { data: events } = await supabase.from('events').select('*')
  const { data: allTasks } = await supabase.from('tasks').select('*')
  const { data: members } = await supabase.from('members').select('*')

  if (!events || !allTasks || !members) return new Response('no data')

  let sent = 0

  // ============================================================
  // 通知1: タスク期限リマインダー（7日前・3日前・1日前・当日）
  // ============================================================
  const tasksByEvent: Record<string, any[]> = {}
  allTasks.forEach((t: any) => {
    if (!tasksByEvent[t.event_id]) tasksByEvent[t.event_id] = []
    tasksByEvent[t.event_id].push(t)
  })

  for (const task of allTasks.filter((t: any) => !t.done)) {
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
    const msg = `✈️ OIT旅サー タスクリマインダー\n\n${urgency} ${ev.title}\n「${task.name}」\n期限: ${deadline.getMonth()+1}/${deadline.getDate()}（イベント: ${ev.date} 頃）`
    const refId = `deadline-${task.id}-${daysLeft}days`

    const roleMembers = members.filter((mb: any) => mb.role === task.role && mb.line_user_id && !mb.banned && mb.notify !== false)
    for (const member of roleMembers) {
      if (await alreadySent(supabase, member.line_user_id, 'deadline', refId)) continue
      const ok = await sendLine(lineToken, member.line_user_id, msg)
      if (ok) { await markSent(supabase, member.line_user_id, 'deadline', refId); sent++ }
    }
  }

  // ============================================================
  // 通知2: 自分の番通知（前のタスクグループが完了 & 今月・来月に未完タスク）
  // ============================================================
  for (const ev of events) {
    const evTasks = tasksByEvent[ev.id] || []
    if (!evTasks.length) continue

    // イベントの月を取得
    const evMonthStr = ev.month?.replace('月', '')
    const evMonth = evMonthStr ? parseInt(evMonthStr) : null

    // 今月・来月のイベントのみ対象
    if (evMonth !== todayMonth && evMonth !== nextMonth) continue

    // タスクを役職グループ順にまとめる
    const roleOrder = TASK_ORDER[ev.type] || []
    const uniqueRoles = [...new Set(roleOrder)]

    for (let i = 0; i < uniqueRoles.length; i++) {
      const role = uniqueRoles[i]
      const myTasks = evTasks.filter((t: any) => t.role === role && !t.done)
      if (!myTasks.length) continue

      // 前のグループのタスクが全て完了しているか確認
      const prevRoles = uniqueRoles.slice(0, i)
      const prevTasksDone = prevRoles.every(prevRole =>
        evTasks.filter((t: any) => t.role === prevRole).every((t: any) => t.done)
      )
      if (!prevTasksDone && i > 0) continue

      // 担当メンバーに通知
      const roleMembers = members.filter((mb: any) => mb.role === role && mb.line_user_id && !mb.banned && mb.notify !== false)
      const taskNames = myTasks.map((t: any) => `・${t.name}`).join('\n')
      const msg = `✈️ OIT旅サー あなたの番です！\n\n【${ev.title}】\n\n以下のタスクをお願いします：\n${taskNames}\n${ev.date ? `\nイベント: ${ev.date} 頃` : ''}`
      const refId = `myturn-${ev.id}-${role}`

      for (const member of roleMembers) {
        if (await alreadySent(supabase, member.line_user_id, 'myturn', refId)) continue
        const ok = await sendLine(lineToken, member.line_user_id, msg)
        if (ok) { await markSent(supabase, member.line_user_id, 'myturn', refId); sent++ }
      }
    }
  }

  // ============================================================
  // 通知3: 毎月15日 - 来月の日程未定イベントを企画・代表・副代表に通知
  // ============================================================
  if (todayDay === 15) {
    const undatedNextMonth = events.filter((ev: any) => {
      if (ev.date) return false
      const mStr = ev.month?.replace('月', '')
      return mStr ? parseInt(mStr) === nextMonth : false
    })

    if (undatedNextMonth.length > 0) {
      const planners = members.filter((mb: any) =>
        ['代表','副代表','企画'].includes(mb.role) && mb.line_user_id && !mb.banned && mb.notify !== false
      )
      const eventList = undatedNextMonth.map((ev: any) => `・${ev.title}`).join('\n')
      const msg = `✈️ OIT旅サー 企画リマインダー\n\n来月（${nextMonth}月）のイベントの日程がまだ未定です。そろそろスケジュールを立てましょう！\n\n${eventList}\n\nアプリから日程を入力してください。`
      const refId = `planning-${today.getFullYear()}-${todayMonth}`

      for (const member of planners) {
        if (await alreadySent(supabase, member.line_user_id, 'planning', refId)) continue
        const ok = await sendLine(lineToken, member.line_user_id, msg)
        if (ok) { await markSent(supabase, member.line_user_id, 'planning', refId); sent++ }
      }
    }
  }

  // ============================================================
  // 通知4: 遅延通知（期限切れタスクがあれば代表・副代表に毎日通知）
  // ============================================================
  const overdueByEvent: Record<string, string[]> = {}

  for (const task of allTasks.filter((t: any) => !t.done)) {
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

    if (daysLeft >= 0) continue // 期限切れのみ

    const key = ev.title
    if (!overdueByEvent[key]) overdueByEvent[key] = []
    overdueByEvent[key].push(`・${task.name}（${task.role}・${Math.abs(daysLeft)}日超過）`)
  }

  if (Object.keys(overdueByEvent).length > 0) {
    // 遅延通知は代表1人だけ（最初に見つかった代表のみ）
    const leader = members.find((mb: any) =>
      mb.role === '代表' && mb.line_user_id && !mb.banned && mb.notify !== false
    )
    const leaders = leader ? [leader] : []
    const overdueList = Object.entries(overdueByEvent)
      .map(([evTitle, tasks]) => `【${evTitle}】\n${tasks.join('\n')}`)
      .join('\n\n')
    const msg = `✈️ OIT旅サー 遅延アラート\n\n期限を超過しているタスクがあります。\n\n${overdueList}\n\nアプリで確認してください。`
    const refId = `overdue-${today.getFullYear()}-${todayMonth}-${todayDay}`

    for (const member of leaders) {
      if (await alreadySent(supabase, member.line_user_id, 'overdue', refId)) continue
      const ok = await sendLine(lineToken, member.line_user_id, msg)
      if (ok) { await markSent(supabase, member.line_user_id, 'overdue', refId); sent++ }
    }
  }

  return new Response(JSON.stringify({ sent, today: `${todayMonth}/${todayDay}` }))
})
