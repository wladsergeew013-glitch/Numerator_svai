import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const modules = path.join(root, 'frontend/node_modules');
const { build } = await import(pathToFileURL(path.join(modules, 'vite/dist/node/index.js')));
const { default: react } = await import(pathToFileURL(path.join(modules, '@vitejs/plugin-react/dist/index.js')));
await build({ configFile: false, root: path.join(root, 'tools/checks'), plugins: [react()],
  resolve: { alias: [
    { find: /^react$/, replacement: path.join(modules, 'react/index.js') },
    { find: /^react\/jsx-runtime$/, replacement: path.join(modules, 'react/jsx-runtime.js') },
    { find: /^react-dom$/, replacement: path.join(modules, 'react-dom/index.js') },
    { find: /^react-dom\/client$/, replacement: path.join(modules, 'react-dom/client.js') }
  ] },
  build: { outDir: path.join(root, 'tools/out/native-panels-runtime-ui'),
    rollupOptions: { input: path.join(root, 'tools/checks/native_panels_runtime.html') } } });
