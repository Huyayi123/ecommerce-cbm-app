import { useState } from 'react';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

type Props = {
  onAuthed: () => void | Promise<void>;
};

export function AuthPanel({ onAuthed }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!supabase) return;
    setLoading(true);
    setMessage('');

    const result =
      mode === 'sign-in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (result.error) {
      setLoading(false);
      setMessage(result.error.message);
      return;
    }

    try {
      setMessage(mode === 'sign-up' ? '注册成功，请按 Supabase 邮件设置确认策略登录。' : '登录成功，正在加载数据...');
      await onAuthed();
    } catch (error) {
      console.error(error);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <section className="auth-shell">
        <div className="auth-card">
          <h1>需要配置 Supabase</h1>
          <p>请先在 `.env.local` 中配置 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`，然后重启开发服务。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="auth-shell">
      <div className="auth-card">
        <h1>电商采购装柜工作台</h1>
        <p>登录后即可多人共享 SKU、采购记录和在途库存。</p>
        <label>
          邮箱
          <input value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          密码
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {message && <div className="inline-notice">{message}</div>}
        <button className="primary" type="button" onClick={submit} disabled={loading || !email || !password}>
          {loading ? '处理中...' : mode === 'sign-in' ? '登录' : '注册'}
        </button>
        <button type="button" onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
          {mode === 'sign-in' ? '没有账号，去注册' : '已有账号，去登录'}
        </button>
      </div>
    </section>
  );
}
