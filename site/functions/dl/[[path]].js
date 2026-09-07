const VERSION = '1.23.2';

const TARGETS = {
  'mac-arm64': `ShipChamber-${VERSION}-mac-arm64.dmg`,
  'mac-x64': `ShipChamber-${VERSION}-mac-x64.dmg`,
  'mac-arm64-zip': `ShipChamber-${VERSION}-mac-arm64.zip`,
  'mac-x64-zip': `ShipChamber-${VERSION}-mac-x64.zip`,
  'win-x64': `ShipChamber-${VERSION}-win-x64.exe`,
  'win-arm64': `ShipChamber-${VERSION}-win-arm64.exe`,
  'linux-x64': `ShipChamber-${VERSION}-linux-x86_64.AppImage`,
  'linux-arm64': `ShipChamber-${VERSION}-linux-arm64.AppImage`,
  'vscode': `shipchamber-${VERSION}.vsix`,
  'web': `shipchamber-web-${VERSION}.tgz`,
};

const TYPES = {
  yml: 'text/yaml',
  blockmap: 'application/octet-stream',
  dmg: 'application/x-apple-diskimage',
  zip: 'application/zip',
  exe: 'application/vnd.microsoft.portable-executable',
  AppImage: 'application/octet-stream',
  vsix: 'application/zip',
  tgz: 'application/gzip',
};

export async function onRequestGet({ params, env }) {
  const target = Array.isArray(params.path) ? params.path.join('/') : params.path;
  if (target === 'version') {
    return new Response(JSON.stringify({ version: VERSION, targets: Object.keys(TARGETS) }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    });
  }
  // electron-updater generic feed: /dl/update/latest*.yml plus the files those manifests name.
  const updateFile = target.startsWith('update/') ? decodeURIComponent(target.slice('update/'.length)) : null;
  const file = updateFile
    ? (/^[\w.@+-]+$/.test(updateFile) && (updateFile.endsWith('.yml') || Object.values(TARGETS).includes(updateFile) || updateFile.endsWith('.blockmap')) ? updateFile : null)
    : TARGETS[target];
  if (!file) return new Response('Not found', { status: 404 });
  const object = await env.DOWNLOADS.get(`v${VERSION}/${file}`);
  if (updateFile && file.endsWith('.yml')) {
    if (!object) return new Response('Not found', { status: 404 });
    return new Response(object.body, {
      headers: { 'content-type': 'text/yaml', 'cache-control': 'public, max-age=300' },
    });
  }
  if (!object) return new Response('Build not available yet', { status: 404 });
  const ext = file.split('.').pop();
  return new Response(object.body, {
    headers: {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="${file}"`,
      'cache-control': 'public, max-age=3600',
      etag: object.httpEtag,
    },
  });
}
