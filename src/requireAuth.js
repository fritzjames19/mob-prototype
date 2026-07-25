import { supabaseAuth } from './db.js';

// Every protected route expects: Authorization: Bearer <supabase access token>
// The frontend gets this token back from Supabase after login and just needs to attach it
// to every API call. We verify it server-side on every request — never trust a client-sent user id.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired token' });

  req.userId = data.user.id;
  next();
}
