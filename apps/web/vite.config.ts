import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {createRequire} from "node:module";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
const require=createRequire(import.meta.url);
const vadDirectory=dirname(require.resolve("@ricky0123/vad-web"));
const ortDirectory=dirname(require.resolve("onnxruntime-web/wasm"));
const speechAssets=new Map([
  ["silero_vad_v5.onnx",join(vadDirectory,"silero_vad_v5.onnx")],
  ["vad.worklet.bundle.min.js",join(vadDirectory,"vad.worklet.bundle.min.js")],
  ...["ort-wasm-simd-threaded.wasm","ort-wasm-simd-threaded.mjs"].map(name=>[name,join(ortDirectory,name)] as [string,string]),
]);

export default defineConfig({
  plugins: [react(),{
    name:"local-speech-assets",
    buildStart(){for(const [name,path] of speechAssets)this.emitFile({type:"asset",fileName:"assets/speech-vad/"+name,source:readFileSync(path)});},
    configureServer(server){server.middlewares.use((req,res,next)=>{
      const name=req.url?.split("?")[0]?.replace(/^\/assets\/speech-vad\//,"");
      const path=name?speechAssets.get(name):undefined;if(!path)return next();
      res.setHeader("Content-Type",name!.endsWith("wasm")?"application/wasm":name!.endsWith("onnx")?"application/octet-stream":"text/javascript");res.end(readFileSync(path));
    });},
  }],
  server: {
    port: 5173,
    proxy: {
      "/api": {target:process.env.VITE_API_TARGET ?? "http://127.0.0.1:4100",ws:true},
    },
  },
});
