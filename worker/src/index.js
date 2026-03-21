const ALLOWED_TYPES = new Set([
  'image/jpeg','image/jpg','image/png','image/gif',
  'image/webp','image/heic','image/heif',
  'video/mp4','video/quicktime','video/mov','video/webm','video/mpeg',
]);

// Android Chrome sometimes sends empty file.type — fall back to extension
const EXT_MIME = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
  webp:'image/webp', heic:'image/heic', heif:'image/heif',
  mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm',
  mpeg:'video/mpeg', m4v:'video/mp4', avi:'video/x-msvideo',
};
function resolveMime(file) {
  const t = (file.type || '').toLowerCase();
  if (t && ALLOWED_TYPES.has(t)) return t;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EXT_MIME[ext] || '';
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function checkAdmin(request, env) {
  const pw = request.headers.get('X-Admin-Password');
  return pw && pw === (env.ADMIN_PASSWORD || 'lagos123');
}

async function sha256hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // ── Upload ──────────────────────────────────────────────────────────
      if (path === '/upload' && request.method === 'POST') {
        const form = await request.formData();
        const name     = (form.get('name') || 'Anonymous').trim() || 'Anonymous';
        const note     = (form.get('note') || '').trim();
        const email    = (form.get('email') || '').trim();
        const location = (form.get('location') || '').trim();
        const files    = form.getAll('photos');
        let lastModifieds = [];
        try { lastModifieds = JSON.parse(form.get('lastModifieds') || '[]'); } catch {}

        if (!files.length) return json({ error: 'No files provided' }, 400);

        const uploaded   = [];
        const duplicates = [];
        const rejected   = [];

        for (let idx = 0; idx < files.length; idx++) {
          const file = files[idx];
          const mime = resolveMime(file);

          // Server-side MIME whitelist (rejects truly unknown types)
          if (!mime) {
            rejected.push(file.name);
            continue;
          }

          const bytes = await file.arrayBuffer();

          // 500 MB per-file hard cap (Cloudflare Worker body limit)
          if (bytes.byteLength > 500 * 1024 * 1024) {
            rejected.push(file.name);
            continue;
          }

          const hash    = await sha256hex(bytes);
          const hashKey = `hashes/${hash}`;

          // Duplicate check
          const existing = await env.BUCKET.head(hashKey);
          if (existing) { duplicates.push(file.name); continue; }

          const ext        = (file.name.split('.').pop() || 'jpg').toLowerCase();
          const id         = crypto.randomUUID();
          const uploadedAt = Date.now().toString();
          const photoTakenAt = (lastModifieds[idx] || '').toString();
          const key        = `pending/${uploadedAt}-${id}.${ext}`;

          await env.BUCKET.put(key, bytes, {
            httpMetadata: { contentType: mime },
            customMetadata: { name, note, email, location, status: 'pending',
              timestamp: uploadedAt, photoTakenAt, originalName: file.name, hash },
          });

          await env.BUCKET.put(hashKey, new Uint8Array(0), {
            customMetadata: { photoKey: key },
          });

          uploaded.push(key);
        }

        return json({ success: true, count: uploaded.length, duplicates, rejected });
      }

      // ── Gallery – approved only ─────────────────────────────────────────
      if (path === '/gallery' && request.method === 'GET') {
        const listed = await env.BUCKET.list({ prefix: 'approved/', include: ['customMetadata'] });
        const photos = listed.objects
          .sort((a, b) => parseInt(b.customMetadata?.timestamp || 0) - parseInt(a.customMetadata?.timestamp || 0))
          .map(obj => ({
            key: obj.key,
            url: `/photo/${encodeURIComponent(obj.key)}`,
            name: obj.customMetadata?.name || 'Anonymous',
            note: obj.customMetadata?.note || '',
            location: obj.customMetadata?.location || '',
            photoTakenAt: obj.customMetadata?.photoTakenAt || '',
            timestamp: obj.customMetadata?.timestamp || '',
          }));
        return json({ photos });
      }

      // ── Serve a photo ───────────────────────────────────────────────────
      if (path.startsWith('/photo/') && request.method === 'GET') {
        const key = decodeURIComponent(path.slice('/photo/'.length));

        // Block pending and hashes from public access
        if (key.startsWith('pending/') || key.startsWith('hashes/')) {
          if (!checkAdmin(request, env)) return new Response('Forbidden', { status: 403, headers: cors });
        }

        const obj = await env.BUCKET.get(key);
        if (!obj) return new Response('Not found', { status: 404, headers: cors });
        const headers = new Headers(cors);
        obj.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'public, max-age=31536000');
        return new Response(obj.body, { headers });
      }

      // ── Admin – list all photos ─────────────────────────────────────────
      if (path === '/admin/photos' && request.method === 'GET') {
        if (!checkAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const [pending, approved] = await Promise.all([
          env.BUCKET.list({ prefix: 'pending/', include: ['customMetadata'] }),
          env.BUCKET.list({ prefix: 'approved/', include: ['customMetadata'] }),
        ]);
        const toMap = (obj, status) => ({
          key: obj.key,
          url: `/photo/${encodeURIComponent(obj.key)}`,
          name: obj.customMetadata?.name || 'Anonymous',
          note: obj.customMetadata?.note || '',
          email: obj.customMetadata?.email || '',
          location: obj.customMetadata?.location || '',
          photoTakenAt: obj.customMetadata?.photoTakenAt || '',
          hash: obj.customMetadata?.hash || '',
          status,
          timestamp: obj.customMetadata?.timestamp || '0',
        });
        const photos = [
          ...pending.objects.map(o => toMap(o, 'pending')),
          ...approved.objects.map(o => toMap(o, 'approved')),
        ].sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp));
        return json({ photos });
      }

      // ── Admin – approve ─────────────────────────────────────────────────
      if (path === '/admin/approve' && request.method === 'POST') {
        if (!checkAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const { key } = await request.json();
        if (!key.startsWith('pending/')) return json({ error: 'Invalid key' }, 400);
        const obj = await env.BUCKET.get(key);
        if (!obj) return json({ error: 'Not found' }, 404);
        const newKey = key.replace('pending/', 'approved/');
        const meta   = obj.customMetadata || {};
        await env.BUCKET.put(newKey, obj.body, {
          httpMetadata: obj.httpMetadata,
          customMetadata: { ...meta, status: 'approved' },
        });
        await env.BUCKET.delete(key);
        if (meta.hash) {
          await env.BUCKET.put(`hashes/${meta.hash}`, new Uint8Array(0), {
            customMetadata: { photoKey: newKey },
          });
        }
        return json({ success: true, newKey });
      }

      // ── Admin – delete ──────────────────────────────────────────────────
      if (path === '/admin/delete' && request.method === 'DELETE') {
        if (!checkAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const { key } = await request.json();
        const obj  = await env.BUCKET.get(key);
        const hash = obj?.customMetadata?.hash;
        await env.BUCKET.delete(key);
        if (hash) await env.BUCKET.delete(`hashes/${hash}`);
        return json({ success: true });
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: 'Internal error' }, 500);
    }
  },
};
