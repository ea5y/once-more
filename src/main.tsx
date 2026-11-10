import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/source-sans-3/300.css';
import '@fontsource/source-sans-3/400.css';
import App from './App';
import ExitConfirmation from './v1/ExitConfirmation';
import PersistedView from './v1/PersistedView';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{new URLSearchParams(location.search).has('v1') ? <PersistedView /> : <App />}<ExitConfirmation /></React.StrictMode>);
