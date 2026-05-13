import { useState } from 'react';
import type { AppProfile } from '../types';
import { formatErrorMessage } from '../utils/errors';

type Props = {
  profile: AppProfile;
  onSave: (profile: AppProfile) => Promise<void>;
};

export function ProfileBinding({ profile, onSave }: Props) {
  const [buyerName, setBuyerName] = useState(profile.buyerName);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [message, setMessage] = useState('');

  async function save() {
    try {
      await onSave({ ...profile, buyerName: buyerName.trim(), displayName: displayName.trim() || profile.email });
      setMessage('账号绑定已保存');
    } catch (error) {
      console.error(error);
      setMessage(`保存失败：${formatErrorMessage(error)}`);
    }
  }

  return (
    <section className="panel compact-panel">
      <div className="section-heading">
        <div>
          <h2>账号采购人绑定</h2>
          <p>系统会用“采购人”匹配这里绑定的登录邮箱，自动分配个人采购订单。</p>
        </div>
      </div>
      <div className="record-form">
        <label>显示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>登录邮箱<input value={profile.email} readOnly /></label>
        <label>采购人<input value={buyerName} onChange={(event) => setBuyerName(event.target.value)} placeholder="例如：张三" /></label>
        <div className="form-actions">
          <button className="primary" type="button" onClick={save}>保存绑定</button>
        </div>
      </div>
      {message && <div className="inline-notice">{message}</div>}
    </section>
  );
}
