import { useState } from 'react';
import { supabase } from '../lib/supabase';

type Props = {
  onDone: () => void | Promise<void>;
};

export function PasswordResetPanel({ onDone }: Props) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!supabase) return;
    if (password.length < 6) {
      setMessage('密码至少需要 6 位。');
      return;
    }
    if (password !== confirmPassword) {
      setMessage('两次输入的密码不一致。');
      return;
    }

    setLoading(true);
    setMessage('');
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      console.error(error);
      setMessage(error.message);
      setLoading(false);
      return;
    }

    setMessage('密码已更新，请使用新密码重新登录。');
    await supabase.auth.signOut();
    await onDone();
    setLoading(false);
  }

  return (
    <section className="auth-shell">
      <div className="auth-card">
        <h1>设置新密码</h1>
        <p>请设置一个新的登录密码，保存后需要重新登录。</p>
        <label>
          新密码
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <label>
          确认新密码
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </label>
        {message && <div className="inline-notice">{message}</div>}
        <button className="primary" type="button" onClick={submit} disabled={loading || !password || !confirmPassword}>
          {loading ? '保存中...' : '保存新密码'}
        </button>
      </div>
    </section>
  );
}
