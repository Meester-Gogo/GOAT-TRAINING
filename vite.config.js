import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves project sites from /<repo>/, so assets must be prefixed.
// Set BASE_PATH in the workflow (or leave the default if your repo is named
// "goat-trail"). For a user/org site (<user>.github.io), set BASE_PATH="/".
export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || '/goat-trail/',
});
