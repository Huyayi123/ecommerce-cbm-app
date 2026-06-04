import { useState } from 'react';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

type Props = {
  onAuthed: () => void | Promise<void>;
};

export function AuthPanel({ onAuthed }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!supabase) return;
    setLoading(true);
    setMessage('');

    const result = await supabase.auth.signInWithPassword({ email, password });

    if (result.error) {
      setLoading(false);
      setMessage(result.error.message);
      return;
    }

    try {
      setMessage('登录成功，正在加载数据...');
      await onAuthed();
    } catch (error) {
      console.error(error);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function sendPasswordReset() {
    if (!supabase || !email.trim()) {
      setMessage('请先填写邮箱。');
      return;
    }
    setLoading(true);
    setMessage('');
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (error) {
      console.error(error);
      setMessage(error.message);
      setLoading(false);
      return;
    }
    setMessage('重置密码邮件已发送，请从邮箱打开链接后设置新密码。');
    setLoading(false);
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
        <p>内部人员登录后即可共享 SKU、采购记录和在途库存。</p>
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
          {loading ? '处理中...' : '登录'}
        </button>
        <button type="button" onClick={sendPasswordReset} disabled={loading || !email}>
          忘记密码，发送重置邮件
        </button>
        <p className="muted-text">账号由内部管理员创建，请勿自行注册。</p>
      </div>
    </section>
  );
}
