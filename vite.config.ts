import { defineConfig } from 'vite';
export default defineConfig({build:{target:'es2022',rollupOptions:{output:{manualChunks:{three:['three']}}}},optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:5186,strictPort:true,proxy:{'/api':'http://127.0.0.1:8787','/ws':{target:'ws://127.0.0.1:8787',ws:true}}}});
