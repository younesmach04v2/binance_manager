import React from 'react'
import ReactDOM from 'react-dom/client'
import { createRemoteApi } from './lib/remoteApi'
import './styles.css'

// Install the remote transport before any page module reads window.api.
window.api = createRemoteApi('android')

void import('./App').then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})

// If the user enabled the built-in server on this phone, bring it back (foreground service + Node engine) and reconnect.
void import('./lib/embedded').then((m) => m.ensureEmbeddedRunning())
