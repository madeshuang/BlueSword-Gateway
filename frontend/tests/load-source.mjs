import fs from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

export function loadSource(path, names, globals = {}) {
  let source = stripTypeScriptTypes(fs.readFileSync(new URL(path, import.meta.url), 'utf8'))
    .replace(/^import .* from .*$/gm, '').replace(/^export /gm, '')
  if (path === '../src/store.ts' || path === '../src/bridge.ts') {
    source = stripTypeScriptTypes(fs.readFileSync(new URL('../src/uuid.ts', import.meta.url), 'utf8')).replace(/^export /gm, '') + '\n' + source
  }
  return vm.runInNewContext(source + `\n;({${names.join(',')}})`, {
    Date, Map, Set, Float32Array, AbortController, crypto, console, ...globals,
  })
}
