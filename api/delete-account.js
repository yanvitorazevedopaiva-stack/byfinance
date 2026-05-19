// api/delete-account.js — BY Finance: deleta usuário do Supabase Auth
// Requer SUPABASE_URL e SUPABASE_SERVICE_KEY nas variáveis de ambiente do Vercel

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  // Só aceita POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { user_id } = req.body || {};
  if (!user_id) {
    return res.status(400).json({ error: 'user_id obrigatório' });
  }

  try {
    // Deleta o usuário via Admin API do Supabase (requer service_role key)
    const response = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${user_id}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('Erro ao deletar usuário Supabase Auth:', err);
      return res.status(response.status).json({ error: err });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro interno delete-account:', err);
    return res.status(500).json({ error: err.message });
  }
}
