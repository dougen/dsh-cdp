/**
 * Cross-browser CDP endpoint discovery.
 *
 * Chromium browsers expose their debug endpoint in two different ways, and the
 * plugin must handle both because neither covers every case:
 *
 *   1. A `DevToolsActivePort` file at the user-data-dir root. Written when the
 *      browser picks its own port (`--remote-debugging-port=0`) and in the
 *      approval-mode flow (chrome://inspect "Allow remote debugging"). It holds
 *      the port on line 1 and the browser-level WebSocket path on line 2.
 *
 *   2. An HTTP `/json/version` endpoint. Served for an explicit non-zero
 *      `--remote-debugging-port`, where Chromium deliberately does NOT write
 *      the port file. Some builds (ungoogled-chromium, Helium) disable these
 *      HTTP routes entirely, so this path can never be the only mechanism.
 *
 * No browser here is Chrome-specific: the catalog is plain data, and a caller
 * can extend it through plugin config.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, platform as osPlatform } from 'node:os'
import { connect as netConnect } from 'node:net'

/** Port file name every Chromium browser writes at its user-data-dir root. */
export const PORT_FILE = 'DevToolsActivePort'

/**
 * Known Chromium browsers. `dir` is the user-data directory that holds
 * `DevToolsActivePort`; `exe` is only used to print an accurate launch hint.
 * Paths are templated so the table stays readable.
 *
 * Opera is the shape that catches people out: its data directory has no
 * `User Data` segment, so a generic `<brand>\User Data` rule misses it.
 */
const CATALOG = [
  {
    id: 'edge',
    name: 'Microsoft Edge',
    win: {
      dir: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
      exe: '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
    },
    mac: { dir: '~/Library/Application Support/Microsoft Edge', exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    linux: { dir: '~/.config/microsoft-edge', exe: 'microsoft-edge' },
  },
  {
    id: 'edge-beta',
    name: 'Microsoft Edge Beta',
    win: { dir: '%LOCALAPPDATA%\\Microsoft\\Edge Beta\\User Data', exe: '%ProgramFiles(x86)%\\Microsoft\\Edge Beta\\Application\\msedge.exe' },
    mac: { dir: '~/Library/Application Support/Microsoft Edge Beta', exe: '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta' },
    linux: { dir: '~/.config/microsoft-edge-beta', exe: 'microsoft-edge-beta' },
  },
  {
    id: 'edge-dev',
    name: 'Microsoft Edge Dev',
    win: { dir: '%LOCALAPPDATA%\\Microsoft\\Edge Dev\\User Data', exe: '%ProgramFiles(x86)%\\Microsoft\\Edge Dev\\Application\\msedge.exe' },
    mac: { dir: '~/Library/Application Support/Microsoft Edge Dev', exe: '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev' },
    linux: { dir: '~/.config/microsoft-edge-dev', exe: 'microsoft-edge-dev' },
  },
  {
    id: 'edge-canary',
    name: 'Microsoft Edge Canary',
    win: { dir: '%LOCALAPPDATA%\\Microsoft\\Edge SxS\\User Data', exe: '%LOCALAPPDATA%\\Microsoft\\Edge SxS\\Application\\msedge.exe' },
    mac: { dir: '~/Library/Application Support/Microsoft Edge Canary', exe: '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary' },
    linux: { dir: '~/.config/microsoft-edge-canary', exe: 'microsoft-edge-canary' },
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    win: { dir: '%LOCALAPPDATA%\\Google\\Chrome\\User Data', exe: '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe' },
    mac: { dir: '~/Library/Application Support/Google/Chrome', exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    linux: { dir: '~/.config/google-chrome', exe: 'google-chrome' },
  },
  {
    id: 'chrome-beta',
    name: 'Google Chrome Beta',
    win: { dir: '%LOCALAPPDATA%\\Google\\Chrome Beta\\User Data', exe: '%ProgramFiles%\\Google\\Chrome Beta\\Application\\chrome.exe' },
    mac: { dir: '~/Library/Application Support/Google/Chrome Beta', exe: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta' },
    linux: { dir: '~/.config/google-chrome-beta', exe: 'google-chrome-beta' },
  },
  {
    id: 'chrome-dev',
    name: 'Google Chrome Dev',
    win: { dir: '%LOCALAPPDATA%\\Google\\Chrome Dev\\User Data', exe: '%ProgramFiles%\\Google\\Chrome Dev\\Application\\chrome.exe' },
    mac: { dir: '~/Library/Application Support/Google/Chrome Dev', exe: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev' },
    linux: { dir: '~/.config/google-chrome-unstable', exe: 'google-chrome-unstable' },
  },
  {
    id: 'chrome-canary',
    name: 'Google Chrome Canary',
    win: { dir: '%LOCALAPPDATA%\\Google\\Chrome SxS\\User Data', exe: '%LOCALAPPDATA%\\Google\\Chrome SxS\\Application\\chrome.exe' },
    mac: { dir: '~/Library/Application Support/Google/Chrome Canary', exe: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary' },
    linux: { dir: '~/.config/google-chrome-canary', exe: 'google-chrome-canary' },
  },
  {
    id: 'brave',
    name: 'Brave',
    win: { dir: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data', exe: '%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' },
    mac: { dir: '~/Library/Application Support/BraveSoftware/Brave-Browser', exe: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    linux: { dir: '~/.config/BraveSoftware/Brave-Browser', exe: 'brave-browser' },
  },
  {
    id: 'brave-beta',
    name: 'Brave Beta',
    win: { dir: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser-Beta\\User Data', exe: '%ProgramFiles%\\BraveSoftware\\Brave-Browser-Beta\\Application\\brave.exe' },
    mac: { dir: '~/Library/Application Support/BraveSoftware/Brave-Browser-Beta', exe: '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta' },
    linux: { dir: '~/.config/BraveSoftware/Brave-Browser-Beta', exe: 'brave-browser-beta' },
  },
  {
    id: 'brave-nightly',
    name: 'Brave Nightly',
    win: { dir: '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser-Nightly\\User Data', exe: '%ProgramFiles%\\BraveSoftware\\Brave-Browser-Nightly\\Application\\brave.exe' },
    mac: { dir: '~/Library/Application Support/BraveSoftware/Brave-Browser-Nightly', exe: '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly' },
    linux: { dir: '~/.config/BraveSoftware/Brave-Browser-Nightly', exe: 'brave-browser-nightly' },
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    win: { dir: '%LOCALAPPDATA%\\Vivaldi\\User Data', exe: '%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe' },
    mac: { dir: '~/Library/Application Support/Vivaldi', exe: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi' },
    linux: { dir: '~/.config/vivaldi', exe: 'vivaldi' },
  },
  {
    id: 'opera',
    name: 'Opera',
    // No `User Data` segment: the data directory is the profile root itself.
    win: { dir: '%APPDATA%\\Opera Software\\Opera Stable', exe: '%LOCALAPPDATA%\\Programs\\Opera\\opera.exe' },
    mac: { dir: '~/Library/Application Support/com.operasoftware.Opera', exe: '/Applications/Opera.app/Contents/MacOS/Opera' },
    linux: { dir: '~/.config/opera', exe: 'opera' },
  },
  {
    id: 'opera-gx',
    name: 'Opera GX',
    win: { dir: '%APPDATA%\\Opera Software\\Opera GX Stable', exe: '%LOCALAPPDATA%\\Programs\\Opera GX\\opera.exe' },
    mac: { dir: '~/Library/Application Support/com.operasoftware.OperaGX', exe: '/Applications/Opera GX.app/Contents/MacOS/Opera GX' },
    linux: { dir: '~/.config/opera-gx', exe: 'opera-gx' },
  },
  {
    id: 'opera-beta',
    name: 'Opera Beta',
    win: { dir: '%APPDATA%\\Opera Software\\Opera Beta', exe: '%LOCALAPPDATA%\\Programs\\Opera Beta\\opera.exe' },
    mac: { dir: '~/Library/Application Support/com.operasoftware.OperaNext', exe: '/Applications/Opera Beta.app/Contents/MacOS/Opera' },
    linux: { dir: '~/.config/opera-beta', exe: 'opera-beta' },
  },
  {
    id: 'opera-developer',
    name: 'Opera Developer',
    win: { dir: '%APPDATA%\\Opera Software\\Opera Developer', exe: '%LOCALAPPDATA%\\Programs\\Opera Developer\\opera.exe' },
    mac: { dir: '~/Library/Application Support/com.operasoftware.OperaDeveloper', exe: '/Applications/Opera Developer.app/Contents/MacOS/Opera' },
    linux: { dir: '~/.config/opera-developer', exe: 'opera-developer' },
  },
  {
    id: 'chromium',
    name: 'Chromium',
    win: { dir: '%LOCALAPPDATA%\\Chromium\\User Data', exe: '%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe' },
    mac: { dir: '~/Library/Application Support/Chromium', exe: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    linux: { dir: '~/.config/chromium', exe: 'chromium' },
  },
  {
    id: 'arc',
    name: 'Arc',
    win: { dir: '%LOCALAPPDATA%\\Arc\\User Data', exe: '%LOCALAPPDATA%\\Arc\\Arc.exe' },
    mac: { dir: '~/Library/Application Support/Arc/User Data', exe: '/Applications/Arc.app/Contents/MacOS/Arc' },
    linux: { dir: '~/.config/arc', exe: 'arc' },
  },
  {
    id: 'thorium',
    name: 'Thorium',
    win: { dir: '%LOCALAPPDATA%\\Thorium\\User Data', exe: '%LOCALAPPDATA%\\Thorium\\Application\\thorium.exe' },
    mac: { dir: '~/Library/Application Support/Thorium', exe: '/Applications/Thorium.app/Contents/MacOS/Thorium' },
    linux: { dir: '~/.config/thorium', exe: 'thorium' },
  },
]

/** Expand `%VAR%` and a leading `~` in a templated path. */
function expandPath(template, env) {
  const withVars = template.replace(/%([^%]+)%/g, (whole, name) => {
    const value = env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()]
    return value ?? whole
  })
  if (withVars === '~') return homedir()
  if (withVars.startsWith('~/') || withVars.startsWith('~\\')) return join(homedir(), withVars.slice(2))
  return withVars
}

/** Resolve the catalog entry for the current (or given) platform. */
export function resolveBrowser(entry, { platform = osPlatform(), env = process.env } = {}) {
  const key = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'
  const block = entry[key]
  if (block === undefined) return undefined
  return {
    id: entry.id,
    name: entry.name,
    dataDir: expandPath(block.dir, env),
    exePath: expandPath(block.exe, env),
  }
}

/** Every catalog browser resolved for this platform, installed or not. */
export function listBrowsers({ platform, env, extraDirs = [] } = {}) {
  const resolved = []
  for (const entry of CATALOG) {
    const hit = resolveBrowser(entry, { platform, env })
    if (hit !== undefined) resolved.push(hit)
  }
  for (const dir of extraDirs) {
    const expanded = expandPath(dir, env ?? process.env)
    if (!resolved.some((b) => b.dataDir === expanded)) {
      resolved.push({ id: 'custom', name: 'Custom profile', dataDir: expanded, exePath: '' })
    }
  }
  return resolved
}

/**
 * Read and parse `DevToolsActivePort`.
 * @returns `{ port, wsPath, url, mtimeMs }`, or `undefined` when absent/invalid.
 */
export async function readActivePort(dataDir) {
  const file = join(dataDir, PORT_FILE)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const port = Number(lines[0])
  const wsPath = lines[1]
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  if (typeof wsPath !== 'string' || !wsPath.startsWith('/')) return undefined
  let mtimeMs
  try {
    mtimeMs = (await stat(file)).mtimeMs
  } catch {
    mtimeMs = undefined
  }
  return { port, wsPath, url: `ws://127.0.0.1:${port}${wsPath}`, mtimeMs }
}

/** True when something accepts TCP on the port. Distinguishes "closed" from "no HTTP". */
export function tcpProbe(port, { host = '127.0.0.1', timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port })
    const done = (result) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Query `/json/version` for a browser-level WebSocket URL.
 *
 * Useful only where the HTTP routes exist; ungoogled-chromium and Helium
 * disable them, and approval mode answers 404. A negative result therefore
 * means "try another route", never "no browser".
 */
export async function probeHttpVersion(port, { host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return undefined
    const body = await res.json()
    const url = body?.webSocketDebuggerUrl
    if (typeof url !== 'string' || !url.startsWith('ws')) return undefined
    return { url, browser: typeof body?.Browser === 'string' ? body.Browser : undefined, protocolVersion: body?.['Protocol-Version'] }
  } catch {
    return undefined
  }
}

/**
 * Discover CDP endpoints across every known browser.
 *
 * Route 1 (port files) is authoritative. Route 2 (HTTP on candidate ports)
 * only runs when requested, because its negative result is uninformative.
 *
 * @returns `{ candidates, browsers }` where each candidate carries the ws URL.
 */
export async function discover({
  platform,
  env,
  extraDirs = [],
  ports = [9222],
  includeHttp = true,
  explicitDataDir,
} = {}) {
  const browsers = listBrowsers({ platform, env, extraDirs })
  const candidates = []
  const seenDirs = new Set()

  const consider = (browser) => {
    if (browser === undefined || seenDirs.has(browser.dataDir)) return
    seenDirs.add(browser.dataDir)
    return browser
  }

  // An explicit data dir is tried first and on its own when given.
  const ordered = explicitDataDir !== undefined
    ? [{ id: 'custom', name: 'Configured profile', dataDir: explicitDataDir, exePath: '' }]
    : browsers

  for (const browser of ordered) {
    if (consider(browser) === undefined) continue
    const active = await readActivePort(browser.dataDir)
    const listening = await tcpProbe(active?.port ?? 0).catch(() => false)
    if (active !== undefined && listening) {
      candidates.push({
        browser,
        port: active.port,
        wsPath: active.wsPath,
        url: active.url,
        mtimeMs: active.mtimeMs,
        source: 'port-file',
        httpAvailable: await httpAvailable(active.port),
      })
    }
  }

  if (includeHttp) {
    for (const port of ports) {
      if (candidates.some((c) => c.port === port)) continue
      if (!(await tcpProbe(port))) continue
      const info = await probeHttpVersion(port)
      if (info === undefined) continue
      candidates.push({
        browser: { id: 'unknown', name: info.browser ?? 'Chromium browser', dataDir: '', exePath: '' },
        port,
        wsPath: new URL(info.url).pathname,
        url: info.url,
        mtimeMs: undefined,
        source: 'http',
        httpAvailable: true,
      })
    }
  }

  return { candidates, browsers }
}

/** Whether `/json/version` answers on this port (informational, for the panel). */
async function httpAvailable(port) {
  return (await probeHttpVersion(port, { timeoutMs: 800 })) !== undefined
}
