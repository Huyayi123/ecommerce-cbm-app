import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  build: { target: ['chrome88', 'edge88', 'firefox114', 'safari16'] },
  plugins: [react()],
});
