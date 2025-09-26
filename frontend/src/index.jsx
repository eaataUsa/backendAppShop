import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import '@shopify/polaris/build/esm/styles.css';
import { AppProvider } from '@shopify/polaris';

ReactDOM.createRoot(document.getElementById('root')).render(
  <AppProvider>
    <App />
  </AppProvider>
);
