const ADMIN_PASSWORD = 'lagos123';

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

function checkAdmin(request) {
  return request.headers.get('X-Admin-Password') === ADMIN_PASSWORD;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // Upload
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

        const uploaded = [];
        for (let idx = 0; idx < files.length; idx++) {
          const file = files[idx];
          const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
          const id = crypto.randomUUID();
          const uploadedAt = Date.now().toString();
          const photoTakenAt = (lastModifieds[idx] || '').toString();
          const key = `pending/${uploadedAt}-${id}.${ext}`;
          await env.BUCKET.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || 'image/jpeg' },
            customMetadata: {
              name,
              note,
              email,
              location,
              status: 'pending',
              timestamp: uploadedAt,
              photoTakenAt,        // actual device timestamp of the photo
              originalName: file.name,
            },
          });
          uploaded.push(key);
        }

        return json({ success: true, count: uploaded.length });
      }

      // Gallery – approved photos only
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
          }));
        return json({ photos });
      }

      // Serve a photo
      if (path.startsWith('/photo/') && request.method === 'GET') {
        const key = decodeURIComponent(path.slice('/photo/'.length));
        const obj = await env.BUCKET.get(key);
        if (!obj) return new Response('Not found', { status: 404 });
        const headers = new Headers(cors);
        obj.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'public, max-age=31536000');
        return new Response(obj.body, { headers });
      }

      // Admin – list all photos
      if (path === '/admin/photos' && request.method === 'GET') {
        if (!checkAdmin(request)) return json({ error: 'Unauthorized' }, 401);
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
          status,
          timestamp: obj.customMetadata?.timestamp || '0',
        });
        const photos = [
          ...pending.objects.map(o => toMap(o, 'pending')),
          ...approved.objects.map(o => toMap(o, 'approved')),
        ].sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp));
        return json({ photos });
      }

      // Admin – approve photo (copy pending → approved, delete pending)
      if (path === '/admin/approve' && request.method === 'POST') {
        if (!checkAdmin(request)) return json({ error: 'Unauthorized' }, 401);
        const { key } = await request.json();
        const obj = await env.BUCKET.get(key);
        if (!obj) return json({ error: 'Not found' }, 404);
        const newKey = key.replace('pending/', 'approved/');
        const meta = obj.customMetadata || {};
        await env.BUCKET.put(newKey, obj.body, {
          httpMetadata: obj.httpMetadata,
          customMetadata: { ...meta, status: 'approved' },
        });
        await env.BUCKET.delete(key);
        return json({ success: true, newKey });
      }

      // Admin – delete photo
      if (path === '/admin/delete' && request.method === 'DELETE') {
        if (!checkAdmin(request)) return json({ error: 'Unauthorized' }, 401);
        const { key } = await request.json();
        await env.BUCKET.delete(key);
        return json({ success: true });
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
