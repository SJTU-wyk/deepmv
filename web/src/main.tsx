import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import Home from './pages/Home';
import Search from './pages/Search';
import Detail from './pages/Detail';
import Player from './pages/Player';
import Collections from './pages/Collections';
import CollectionDetail from './pages/CollectionDetail';
import Sources from './pages/Sources';
import './styles.css';

const router = createBrowserRouter([
  { path: '/play', element: <Player /> },
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'search', element: <Search /> },
      { path: 'collections', element: <Collections /> },
      { path: 'collections/:id', element: <CollectionDetail /> },
      { path: 'detail/:source/:id', element: <Detail /> },
      { path: 'sources', element: <Sources /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);