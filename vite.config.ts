/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 相对路径，兼容 GitHub Pages 子路径部署（如 /peg-solitaire/）
  base: './',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
