import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { takeInvitationFromLocation } from './invitation-secret';

const invitation = takeInvitationFromLocation(window.location, window.history);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App initialInvitation={invitation} /></React.StrictMode>,
);
