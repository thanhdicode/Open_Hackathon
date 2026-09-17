import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import Provider from './lib/query/Provider'
import { ErrorBoundary } from './components/error-boundary'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Provider>
        <App />
      </Provider>
    </ErrorBoundary>
  </React.StrictMode>,
)
