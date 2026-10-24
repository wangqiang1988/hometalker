import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: 'dist',
		target: 'es2022',
		sourcemap: false,
	},
	server: {
		host: true,
		proxy: {
			'/api': { target: 'http://127.0.0.1:8443', changeOrigin: true },
			'/ws': { target: 'ws://127.0.0.1:8443', ws: true },
		},
	},
})
