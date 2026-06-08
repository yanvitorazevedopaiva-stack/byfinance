const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const { chat_id, text } = req.body;
  if (!chat_id || !text) return res.status(400).json({ error: 'missing params' });

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' }),
    });
  } catch(e) {
    console.error('notify.js erro ao enviar Telegram:', e.message);
    return res.status(500).json({ error: e.message });
  }

  return res.status(200).json({ ok: true });
}
