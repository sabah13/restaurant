// ============= supabase-bridge.js (CLEAN, FINAL) =============
// Requires: a Supabase client at window.supabase (create it in <head>).
// Safe, side-effect free helpers + small bridge used by Admin pages.

(() => {
  if (!window.supabase) {
    console.warn('[supabase-bridge] Supabase client is missing. Add it in <head> first.');
  }
})();

/* =====================================================
   LocalStorage helpers (safe JSON)
===================================================== */
const LS = {
  get(k, def){ try{ return JSON.parse(localStorage.getItem(k)) ?? def; }catch{ return def; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} }
};
const nowISO = () => new Date().toISOString();

/* Tiny event helper (same-tab re-render trigger) */
function fireSyncedEvent(){
  try { document.dispatchEvent(new Event('sb:admin-synced')); } catch {}
}

/* =====================================================
   PUBLIC (no auth required): catalog for front site
===================================================== */
export async function syncPublicCatalogToLocal(){
  const sb = window.supabase;
  if (!sb) return;

  const cats = await sb.from('categories').select('id,name,sort').order('sort',{ascending:true});
  if (cats.error) throw cats.error;

  const items = await sb.from('menu_items')
    .select('id,name,"desc",price,img,cat_id,available,fresh,rating_avg,rating_count,created_at')
    .eq('available', true)
    .order('created_at', {ascending:false});
  if (items.error) throw items.error;

  const adapted = (items.data||[]).map(it => ({
    id: it.id,
    name: it.name,
    desc: it.desc ?? it["desc"] ?? '',
    price: Number(it.price)||0,
    img: it.img || '',
    cat_id: it.cat_id || null,
    available: !!it.available,
    fresh: !!it.fresh,
    rating_avg: Number(it.rating_avg)||0,
    rating_count: Number(it.rating_count)||0,
    created_at: it.created_at
  }));

  LS.set('categories', cats.data||[]);
  LS.set('menuItemsVisible', adapted);
  return { categories: cats.data||[], items: adapted };
}

/* =====================================================
   AUTH / ADMIN GUARDS
===================================================== */
async function isCurrentUserAdminRPC(uid){
  const sb = window.supabase;
  try{
    const { data, error } = await sb.rpc('is_admin', { u: uid });
    if (error) return false;
    return !!data;
  }catch{ return false; }
}

async function probeAdminBySelect(){
  const sb = window.supabase;
  try{
    const r = await sb.from('reservations').select('id').limit(1);
    return !r.error;
  }catch{ return false; }
}

/**
 * Ensures there's an authenticated session AND that user is admin.
 * Redirects to loginUrl if not. Returns true if ok, false if redirected.
 */
export async function requireAdminOrRedirect(loginUrl = 'login.html'){
  const sb = window.supabase;
  if (!sb) return false;

  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user?.id) { try{ location.href = loginUrl; }catch{} return false; }

  const uid = session.user.id;
  const ok = (await isCurrentUserAdminRPC(uid)) || (await probeAdminBySelect());
  if (!ok) { try{ location.href = loginUrl; }catch{} return false; }
  return true;
}

/* =====================================================
   ADMIN SYNC: pull server data into LS for UI
   (This page only needs reservations, but we keep it modular)
===================================================== */
export async function syncAdminDataToLocal(){
  const sb = window.supabase;
  if (!sb) return;

  // reservations
  const rs = await sb.from('reservations')
    .select('id,name,phone,date,people,status,notes,table_no,duration_minutes')
    .order('date', { ascending: true });
  if (rs.error) throw rs.error;

  const reservations = (rs.data||[]).map(r => ({
    id: r.id,
    name: r.name,
    phone: r.phone || '',
    date: r.date,                 // ISO
    people: Number(r.people)||1,
    status: r.status || 'new',
    notes: r.notes || '',
    table: r.table_no || '',
    duration: Number(r.duration_minutes)||90,
    updatedAt: nowISO()
  }));

  LS.set('reservations', reservations);

  // optional small “kpi” counts for dashboards could be added here if other pages use them
  fireSyncedEvent();
  return { reservations };
}

/* =====================================================
   RESERVATIONS CRUD
===================================================== */

/**
 * Create reservation (anon/public allowed by policy). 
 * @param {Object} payload - {name, phone, iso, people, kind, table, notes, duration_minutes}
 */
export async function createReservationSB({name, phone, iso, people, kind='table', table='', notes='', duration_minutes=90}){
  const sb = window.supabase;
  if (!sb) return;

  // Insert without select (anon policy allows insert; return may be blocked for anon)
  const ins = await sb.from('reservations').insert([{
    name, phone, date: iso, people, kind, table_no: table, duration_minutes, notes
  }]);
  if (ins.error) throw ins.error;

  // Optimistic local append (temporary id; caller typically calls syncAdminDataToLocal next)
  const list = LS.get('reservations', []);
  const optimistic = {
    id: 'tmp_'+Date.now(),
    name, phone, date: iso, people,
    status: 'new', notes: notes||'',
    table: table||'', duration: Number(duration_minutes)||90,
    updatedAt: nowISO()
  };
  list.unshift(optimistic);
  LS.set('reservations', list);
  fireSyncedEvent();
  return true;
}

/**
 * Update reservation by id (admin only via RLS).
 * fields can include: name, phone, date (ISO), people, status, notes, table_no, duration_minutes
 */
export async function updateReservationSB(id, fields = {}){
  const sb = window.supabase;
  if (!sb) return;

  const up = await sb
    .from('reservations')
    .update(fields)
    .eq('id', id)
    .select('id,name,phone,date,people,status,notes,table_no,duration_minutes')
    .single();
  if (up.error) throw up.error;

  // Update local cache
  const list = LS.get('reservations', []);
  const i = list.findIndex(r => String(r.id) === String(id));
  if (i >= 0) {
    const f = fields || {};
    const patch = {};
    if ('name' in f) patch.name = f.name;
    if ('phone' in f) patch.phone = f.phone;
    if ('date' in f) patch.date = f.date;
    if ('people' in f) patch.people = f.people;
    if ('status' in f) patch.status = f.status;
    if ('notes' in f) patch.notes = f.notes;
    if ('table_no' in f) patch.table = f.table_no;                 // map
    if ('duration_minutes' in f) patch.duration = f.duration_minutes; // map
    list[i] = { ...list[i], ...patch, updatedAt: nowISO() };
    LS.set('reservations', list);
    fireSyncedEvent();
  }
  return up.data;
}

/**
 * Optional: delete reservation (admin only).
 */
export async function deleteReservationSB(id){
  const sb = window.supabase;
  if (!sb) return;
  const del = await sb.from('reservations').delete().eq('id', id);
  if (del.error) throw del.error;

  const list = LS.get('reservations', []);
  const next = list.filter(r => String(r.id)!==String(id));
  LS.set('reservations', next);
  fireSyncedEvent();
  return true;
}

/* =====================================================
   Expose bridge to window (for pages that use window.supabaseBridge)
===================================================== */
try{
  window.LS = window.LS || LS;
  window.supabaseBridge = Object.assign({}, window.supabaseBridge || {}, {
    syncPublicCatalogToLocal,
    requireAdminOrRedirect,
    syncAdminDataToLocal,
    createReservationSB,
    updateReservationSB,
    deleteReservationSB
  });
}catch{}
