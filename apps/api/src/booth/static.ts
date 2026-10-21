import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, isAbsolute } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/** 只公开已构建网页的入口和素材，不公开项目目录。 */
export function builtWeb(directory: string) {
  const root = realpathSync(directory);
  if (!statSync(join(root,"index.html")).isFile()) throw new Error("网页未构建，请先执行 pnpm build");
  const types: Record<string,string> = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
    ".css":"text/css; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg",
    ".jpeg":"image/jpeg", ".webp":"image/webp", ".ico":"image/x-icon", ".woff2":"font/woff2",
    ".mjs":"text/javascript; charset=utf-8",".onnx":"application/octet-stream",".wasm":"application/wasm" };
  return (req: IncomingMessage, res: ServerResponse, pathname: string): boolean => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let path: string;
    try { path = decodeURIComponent(pathname); } catch { return false; }
    if (["/","/index.html","/developer/speech","/developer/robot"].includes(path)) path = "/index.html";
    else if (!/^\/(assets|products)\//.test(path)) return false;
    if (path.includes("\\") || path.split("/").some(part=>part === ".." || part.startsWith("."))) return false;
    const type = types[extname(path).toLowerCase()]; if (!type) return false;
    try {
      const file = realpathSync(join(root,path));
      const inside = relative(root,file);
      if (inside.startsWith("..") || isAbsolute(inside) || !statSync(file).isFile()) return false;
      const body = readFileSync(file);
      res.writeHead(200,{"Content-Type":type,"Content-Length":body.length,"Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"});
      res.end(req.method === "HEAD" ? undefined : body); return true;
    } catch { return false; }
  };
}
