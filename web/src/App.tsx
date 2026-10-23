import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useState } from 'react';

export default function App() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const keyword = q.trim();
    if (!keyword) return;
    navigate('/search?q=' + encodeURIComponent(keyword));
  };
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink className="brand" to="/">
          <span className="brand-mark">D</span>
          DeepMV<small>4K</small>
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>推荐</NavLink>
          <NavLink to="/collections" className={({ isActive }) => (isActive ? 'active' : '')}>片单精选</NavLink>
          <NavLink to="/search?q=" className={({ isActive }) => (isActive ? 'active' : '')}>搜索</NavLink>
          <NavLink to="/sources" className={({ isActive }) => (isActive ? 'active' : '')}>播放源</NavLink>
        </nav>
        <form className="topbar-search" onSubmit={submit}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索影片 / 剧集，如 奥本海默、霸王别姬" />
          <button className="btn primary" type="submit">搜索</button>
        </form>
      </header>
      <Outlet />
      <footer className="footer">
        DeepMV · 自定义规则驱动的影视聚合客户端 · 数据来自公开采集接口，仅供本地学习与个人测试
      </footer>
    </div>
  );
}
