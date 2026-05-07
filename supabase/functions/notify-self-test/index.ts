// supabase/functions/notify-self-test/index.ts
// 自分宛にテスト通知を送る

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { line_user_id, name } = await req.json()
    if (!line_user_id) throw new Error('line_user_id required')

    const lineToken = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!

    const now = new Date()
    const timeStr = `${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`

    const text = `✈️ OIT旅サー 通知テスト\n\n${name || 'メンバー'}さん、通知が正常に届いています！\n\n送信時刻: ${timeStr}\n\nこのメッセージはテスト送信です。`

    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineToken}` },
      body: JSON.stringify({ to: line_user_id, messages: [{ type: 'text', text }] }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`LINE API error: ${err}`)
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
