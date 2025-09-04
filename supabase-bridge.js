// ============= supabase-bridge.js (SAFE PACK) =============
// Requires: a Supabase client at window.supabase (create it in <head>).

(() => {
  if (!window.supabase) {
    console.warn('Supabase client is missing. Add it in <head> first.');
  }
})();

// LocalStorage helpers
const LS = {
  get(k, def){ try{ return JSON.parse(localStorage.getItem(k)) ?? def; }catch{ return def; } },
  set(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
};

// ---------- Public: fetch categories & visible menu ----------
export async function syncPublicCatalogToLocal(){
  const sb = window.supabase;
  const cats = await sb.from('categories').select('*').order('sort', {ascending:true});
  if (cats.error) throw cats.error;

  const items = await sb.from('menu_items')
    .select('id,name,"desc",price,img,cat_id,available,fresh,rating_avg,rating_count')
    .eq('available', true)
    .order('created_at', {ascending:false});
  if (items.error) throw items.error;

  const adapted = (items.data||[]).map(it => ({
    id: it.id,
    name: it.name,
    desc: it["desc"],
    price: Number(it.price) || 0,
    img: it.img,
    catId: it.cat_id,
    fresh: !!it.fresh,
    rating: { avg: Number(it.rating_avg||0), count: Number(it.rating_count||0) }
  }));

  LS.set('categories', cats.data || []);
  LS.set('menuItems', adapted);
  return { categories: cats.data, items: adapted };
}

// ---------- Orders ----------
export async function createOrderSB({order_name, phone, table_no, notes, items}){
  const sb = window.supabase;
  const total = (items||[]).reduce((s,it)=> s + (Number(it.price)||0) * Number(it.qty||1), 0);

  const ins = await sb.from('orders')
    .insert([{ order_name, phone, table_no, notes, total }])
    .select()
    .single();
  if (ins.error) throw ins.error;
  const order = ins.data;

  const rows = (items||[]).map(it => ({
    order_id: order.id,
    item_id: it.id || null,
    name: it.name,
    price: Number(it.price)||0,
    qty: Number(it.qty)||1
  }));
  if (rows.length){
    const i2 = await sb.from('order_items').insert(rows);
    if (i2.error) throw i2.error;
  }

  // cache to LS for UI
  const old = LS.get('orders', []);
  const itemCount = (items||[]).reduce((s,it)=> s + Number(it.qty||1), 0);
  old.unshift({
    id: order.id,
    total,
    itemCount,
    createdAt: new Date().toISOString(),
    table: table_no,
    orderName: order_name,
    notes
  });
  LS.set('orders', old);
  return order;
}

// ---------- Reservations ----------
export async function createReservationSB({name, phone, iso, people, kind='table', table='', notes, duration_minutes=90}){
  const sb = window.supabase;
  const ins = await sb.from('reservations').insert([{
    name, phone, date: iso, people, kind, notes,
    duration_minutes, table_no: table
  }]).select().single();
  if (ins.error) throw ins.error;

  const r = ins.data;
  const list = LS.get('reservations', []);
  list.unshift({
    id: r.id, name: r.name, phone: r.phone, time: r.date,
    people: r.people, kind: r.kind, table: r.table_no || '',
    duration: r.duration_minutes || 90, notes: r.notes || '',
    createdAt: new Date().toISOString()
  });
  LS.set('reservations', list);
  return r;
}

export async function updateReservationSB(id, fields){
  const sb = window.supabase;
  const up = await sb.from('reservations').update(fields).eq('id', id).select().single();
  if (up.error) throw up.error;

  const list = LS.get('reservations', []);
  const i = list.findIndex(r => r.id === id);
  if (i >= 0) {
    const client = { ...fields };
    list[i] = { ...list[i], ...client, updatedAt: new Date().toISOString() };
    LS.set('reservations', list);
  }
  return up.data;
}

export async function deleteReservationSB(id){
  const sb = window.supabase;
  const del = await sb.from('reservations').delete().eq('id', id);
  if (del.error) throw del.error;
  const list = (LS.get('reservations', []) || []).filter(r => r.id !== id);
  LS.set('reservations', list);
  return true;
}

// ---------- Ratings ----------
export async function createRatingSB({item_id, stars}){
  const sb = window.supabase;
  const ins = await sb.from('ratings').insert([{ item_id, stars }]).select().single();
  if (ins.error) throw ins.error;
  return ins.data;
}

// ---------- Admin sync ----------
export async function syncAdminDataToLocal(){
  const sb = window.supabase;

  const cats = await sb.from('categories').select('*').order('sort', {ascending:true});
  if (cats.error) throw cats.error;

  const items = await sb.from('menu_items').select('*').order('created_at', {ascending:false});
  if (items.error) throw items.error;

  // Orders joined with items
  const orders = await sb.from('orders').select('id,order_name,phone,table_no,notes,total,created_at').order('created_at', {ascending:false});
  if (orders.error) throw orders.error;

  const orderIds = (orders.data||[]).map(o=>o.id);
  let orderItems = [];
  if (orderIds.length){
    const oi = await sb.from('order_items').select('*').in('order_id', orderIds);
    if (oi.error) throw oi.error;
    orderItems = oi.data || [];
  }

  // join items
  const adminOrders = (orders.data||[]).map(o=>{
    const its = orderItems.filter(oi => oi.order_id === o.id).map(oi => ({
      id: oi.item_id, name: oi.name, price: Number(oi.price)||0, qty: Number(oi.qty||1)
    }));
    const cnt = its.reduce((s,it)=> s + (Number(it.qty)||1), 0);
    return {
      id: o.id, items: its, itemCount: cnt,
      total: Number(o.total)||0,
      createdAt: o.created_at,
      table: o.table_no, orderName: o.order_name, notes: o.notes
    };
  });

  const ratings = await sb.from('ratings').select('*').order('created_at', {ascending:false});
  if (ratings.error) throw ratings.error;

  const reservations = await sb.from('reservations').select('*').order('date', {ascending:true});
  if (reservations.error) throw reservations.error;

  // adapt to your LS shapes
  LS.set('categories', cats.data || []);
  LS.set('menuItems', (items.data||[]).map(it => ({
    id: it.id, name: it.name, desc: it["desc"], price: Number(it.price)||0,
    img: it.img, catId: it.cat_id, fresh: !!it.fresh,
    rating: { avg: Number(it.rating_avg||0), count: Number(it.rating_count||0) },
    available: !!it.available
  })));
  LS.set('orders', adminOrders);

  LS.set('ratings', (ratings.data||[]).map(r => ({
    id: r.id, itemId: r.item_id, stars: r.stars, time: r.created_at
  })));

  LS.set('reservations', (reservations.data||[]).map(r => ({
    id: r.id, name: r.name, phone: r.phone, time: r.date,
    people: r.people, kind: r.kind, table: r.table_no || '',
    duration: r.duration_minutes || 90, notes: r.notes || ''
  })));

  // notifications: only orders for the admin drawer
  const notifOrders = adminOrders.map(o => ({
    id: `ord-${o.id}`,
    type: 'order',
    title: `طلب جديد #${o.id}`,
    message: `عدد العناصر: ${o.itemCount} | الإجمالي: ${o.total}`,
    time: o.createdAt,
    read: false
  }));
  LS.set('notifications', notifOrders);
  return true;
}

// ---------- Guard: admin-only pages ----------
export async function requireAdminOrRedirect(loginPath='login.html'){
  const sb = window.supabase;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace(loginPath); return null; }

  const uid = session.user?.id;
  if (!uid) { location.replace(loginPath); return null; }

  const me = await sb.from('admins').select('user_id').eq('user_id', uid).maybeSingle();
  if (me.error || !me.data) { location.replace(loginPath); return null; }
  return session;
}

// Expose to window for non-module scripts
window.supabaseBridge = {
  syncPublicCatalogToLocal,
  createOrderSB,
  createReservationSB,
  updateReservationSB,
  deleteReservationSB,
  createRatingSB,
  syncAdminDataToLocal,
  requireAdminOrRedirect
};