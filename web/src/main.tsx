import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const root = document.getElementById('root')
if (root) {
	// 不用 StrictMode：它的双次挂载会触发 useEffect 清理，导致开发模式下连接被误断开
	createRoot(root).render(<App />)
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
	window.addEventListener('load', () => {
		navigator.serviceWorker.register('/sw.js').catch(() => {})
	})
}
