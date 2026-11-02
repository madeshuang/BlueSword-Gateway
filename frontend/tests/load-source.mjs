import fs from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

export function loadSource(path, names, globals = {}) {
  const source = stripTypeScriptTypes(fs.readFileSync(new URL(path, import.meta.url), 'utf8'))
    .replace(/^import .* from .*$/gm, '').replace(/^export /gm, '')
  return vm.runInNewContext(source + `\n;({${names.join(',')}})`, {
    Date, Map, Set, Float32Array, AbortController, crypto, console, ...globals,
  })
}
