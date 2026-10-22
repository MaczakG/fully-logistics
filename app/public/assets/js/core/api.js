/* API client. Every call returns parsed JSON or throws FL.ApiError { status, code, message, fields }.
   fields maps request field names to Hungarian messages (FL.ui.showErrors puts them on the form).

     const { items } = await FL.api.get('/api/orders', { status: 'new' });
     await FL.api.post('/api/orders', data);
     await FL.api.upload('/api/products/import', file, { preview: 1 });
     await FL.api.download('/api/history/export', { from, to });   // saves the file */
(() => {
  'use strict';
  const FL = window.FL;

  class ApiError extends Error {
    constructor(status, code, message, fields) {
      super(message);
      this.status = status;
      this.code = code;
      this.fields = fields || null;
    }
  }
  FL.ApiError = ApiError;

  async function request(method, path, { body, query, form } = {}) {
    const headers = { accept: 'application/json', 'x-requested-with': 'fl-app' };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path + FL.qs(query), { method, headers, body: payload, credentials: 'same-origin' });
    } catch {
      throw new ApiError(0, 'network', 'Nem sikerült elérni a szervert. Ellenőrizd az internetkapcsolatot.');
    }
    if (res.status === 401 && FL.app && FL.app.onUnauthorized && !path.startsWith('/api/auth/')) FL.app.onUnauthorized();
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      if (!res.ok) throw new ApiError(res.status, 'http', `A szerver hibával válaszolt (${res.status}).`);
      return res;
    }
    const data = await res.json();
    if (!res.ok) {
      const e = data.error || {};
      if (e.code === 'password_change_required' && FL.app && FL.app.requirePasswordChange) FL.app.requirePasswordChange();
      throw new ApiError(res.status, e.code || 'error', e.message || 'Hiba történt.', e.fields);
    }
    return data;
  }

  async function download(path, query) {
    const res = await fetch(path + FL.qs(query), { headers: { 'x-requested-with': 'fl-app' }, credentials: 'same-origin' });
    if (!res.ok) {
      let msg = `A letöltés nem sikerült (${res.status}).`;
      try { msg = (await res.json()).error.message || msg; } catch { /* not JSON */ }
      throw new ApiError(res.status, 'download', msg);
    }
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/) || cd.match(/filename="([^"]+)"/);
    FL.downloadBlob(await res.blob(), m ? decodeURIComponent(m[1]) : 'letoltes');
  }

  FL.api = {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body, query) => request('POST', path, { body: body || {}, query }),
    put: (path, body) => request('PUT', path, { body: body || {} }),
    patch: (path, body) => request('PATCH', path, { body: body || {} }),
    del: (path, query) => request('DELETE', path, { query }),
    upload: (path, file, fields = {}) => {
      const form = new FormData();
      form.append('file', file);
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      return request('POST', path, { form });
    },
    download,
    // URL for links that open a document directly (labels, invoices, contracts).
    documentUrl: (id, inline = false) => `/api/documents/${id}${inline ? '?inline=1' : ''}`,
  };
})();
