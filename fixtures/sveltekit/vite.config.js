import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  // A linked prebundle is a package. Development SSR loads its CJS closure
  // through Node; Wrangler bundles that same closure for production Workers.
  ssr: { external: ['@wga-fixture/google-workers'] },
  build: { sourcemap: true },
});
