import {defineConfig} from 'vite';
import {memoboxSource} from './tools/memobox-branding.mjs';
export default defineConfig({plugins:process.env.WANX_CLIENT_PRODUCT==='memobox'?[{name:'memobox-product-copy',enforce:'pre',transform(source,id){if(id.includes('/node_modules/'))return;return memoboxSource(source,id.split('?')[0]);},transformIndexHtml(html){return memoboxSource(html,'index.html');}}]:[],base:'./',server:{host:'127.0.0.1',port:5178,strictPort:true,proxy:{'/api':'http://127.0.0.1:5179'}},build:{outDir:'dist/ui'}});
