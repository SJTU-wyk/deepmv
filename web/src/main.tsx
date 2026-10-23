import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import './styles.css';

// 路由级代码分割：hls.js（约 500KB）只在进入播放页时才加载，
// 首页首屏因此少下载一半体积。
const Home = lazy(() => import('./pages/Home'));
const Search = lazy(() => import('./pages/Search'));
const Detail = lazy(() => import('./pages/Detail'));
const Player = lazy(() => import('./pages/Player'));
const Collections = lazy(() => import('./pages/Collections'));
const CollectionDetail = lazy(() => import('./pages/CollectionDetail'));
const Sources = lazy(() => import('./pages/Sources'));

const loading = <div className="loading">加载中…</div>;

const router = createBrowserRouter([
  { path: '/play', element: <Suspense fallback={loading}><Player /></Suspense> },
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Suspense fallback={loading}><Home /></Suspense> },
      { path: 'search', element: <Suspense fallback={loading}><Search /></Suspense> },
      { path: 'collections', element: <Suspense fallback={loading}><Collections /></Suspense> },
      { path: 'collections/:id', element: <Suspense fallback={loading}><CollectionDetail /></Suspense> },
      { path: 'detail/:source/:id', element: <Suspense fallback={loading}><Detail /></Suspense> },
      { path: 'sources', element: <Suspense fallback={loading}><Sources /></Suspense> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
