// Simulates the shell's module loader: registers the bundle handoff and
// runs the factory with require stubs, then checks the exported surface.
const captured = {}
globalThis.window = {
  __ModuleLoader__: {
    load: (handoff) => { captured[handoff.id] = handoff },
  },
}
await import('../lib/client.js')
const handoff = captured['dsh-workspace-time-travel']
if (!handoff) {
  console.error('FAIL: bundle did not register its handoff')
  process.exit(1)
}
const requireStub = (id) => {
  if (id === 'react') return { useState: () => {}, useEffect: () => {}, useRef: () => {}, createElement: () => {}, Fragment: null }
  if (id === 'react/jsx-runtime') return { jsx: () => {}, jsxs: () => {}, Fragment: null }
  throw new Error('unexpected require: ' + id)
}
const mod = handoff.factory(requireStub)
const keys = Object.keys(mod).sort().join(',')
console.log('factory exports:', keys)
if (typeof mod.apply !== 'function' || !Array.isArray(mod.inject) || mod.inject[0] !== 'slots') {
  console.error('FAIL: bad export surface')
  process.exit(1)
}
console.log('VERIFY OK')
