console.log('SCRIPT LOADED', new Date().toISOString());

// === Telegram ===
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

// === НАСТРОЙКИ ===
const MANAGER_USERNAME = 'FastSHIPmanager';
const ADMIN_IDS = [7866142145];

const SUPABASE_URL = 'https://xbjobhftqrudawlqctqo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1eXNfiQRiZUF-Qm6w3Rjfg_-kCIo8Nl';

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
    const u = tg.initDataUnsafe.user;
    currentUser = { id: u.id, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), username: u.username ? `@${u.username}` : 'нет username' };
}

let products = [];
let reviews = [];
let categories = [];
let cart = load('fs_cart', []);
let favorites = load('fs_favorites', []);
let orders = [];
let currentCategory = 'all';
let searchQuery = '';
let sortMode = 'default';
let selectedSizes = {};

function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function formatPrice(p) { return p.toLocaleString('ru-RU') + ' ₽'; }
function isAdmin() { return currentUser && ADMIN_IDS.includes(currentUser.id); }

// === ЗАГРУЗКА ДАННЫХ ===
async function loadData() {
    document.getElementById('productsGrid').innerHTML = '<p class="empty" style="grid-column:1/-1">Загрузка товаров...</p>';

    // 1. Загружаем категории
    const { data: c, error: cErr } = await db.from('categories').select('*').order('id');
    if (!cErr && c) {
        categories = c;
    } else {
        console.error('Ошибка загрузки категорий:', cErr);
        categories = [{name: 'Все', slug: 'all'}]; // Заглушка, чтобы не падало
    }
    renderCategories();

    // 2. Загружаем товары
    const { data: p } = await db.from('products').select('*').order('id');
    if (p) {
        products = p.map(x => ({
            id: x.id, name: x.name, price: x.price, oldPrice: x.old_price,
            category: x.category, emoji: x.emoji, image: x.image, badge: x.badge, 
            sizes: x.sizes, description: x.description
        }));
    }
    
    // 3. Загружаем отзывы
    const { data: r } = await db.from('reviews').select('*');
    if (r) {
        reviews = r.map(x => ({ id: x.id, productId: x.product_id, author: x.author, stars: x.stars, text: x.text, date: x.date }));
    }

    // 4. Загружаем заказы (если админ)
    if (isAdmin()) {
        const { data: o } = await db.from('orders').select('*').order('id', { ascending: false });
        if (o) {
            orders = o.map(x => ({ id: x.order_code, items: x.items, total: x.total, status: x.status, date: x.date, user: { id: x.user_id, name: x.user_name, username: x.user_username } }));
        }
    }
    
    renderProducts();
    updateCounts();
}

// === РЕНДЕР КАТЕГОРИЙ ===
function renderCategories() {
    const container = document.getElementById('categories');
    container.innerHTML = categories.map(c => `
        <button class="category ${currentCategory === c.slug ? 'active' : ''}" data-cat="${c.slug}">${c.name}</button>
    `).join('');

    container.querySelectorAll('.category').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.category').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCategory = btn.dataset.cat;
            renderProducts();
        });
    });
}

// === СООБЩЕНИЕ МЕНЕДЖЕРУ ===
function buildOrderMessage(items, total, orderId) {
    if (!items || !items.length) return '';
    const lines = items.map(i => `• ${i.name} (${i.size}) × ${i.qty} — ${formatPrice(i.price * i.qty)}`);
    let userInfo = currentUser ? `\n\n👤 Клиент: ${currentUser.name}\n🔗 ${currentUser.username}\n🆔 ID: ${currentUser.id}` : '';
    return `Здравствуйте! Хочу сделать заказ в FastSHIP.\n\n🛒 Заказ: ${orderId}\n📦 Товары:\n${lines.join('\n')}\n\n💰 Итого: ${formatPrice(total)}${userInfo}`;
}

function openManagerChat(msg) {
    if (!msg || !msg.trim()) return;
    const uniqueMsg = msg + '\u200B'.repeat(Math.floor(Math.random() * 3) + 1);
    const url = `https://t.me/${MANAGER_USERNAME}?text=${encodeURIComponent(uniqueMsg)}`;
    if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank');
}

// === КУПИТЬ СЕЙЧАС ===
async function buyNow(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const size = selectedSizes[id] || p.sizes[0];
    const items = [{ name: p.name, size, qty: 1, price: p.price }];
    const total = p.price;
    const orderId = 'FS-' + Date.now().toString().slice(-6);
    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});

    await db.from('orders').insert([{
        order_code: orderId, items, total, status: 'new', date: dateStr,
        user_id: currentUser?.id, user_name: currentUser?.name, user_username: currentUser?.username
    }]);

    if (isAdmin()) await loadData();
    const msg = buildOrderMessage(items, total, orderId);
    if (tg) tg.HapticFeedback?.notificationOccurred('success');
    closeModal('productModal');
    openManagerChat(msg);
}

// === РЕНДЕР ТОВАРОВ ===
function renderProducts() {
    const grid = document.getElementById('productsGrid');

    let filtered = products.filter(p => {
        const matchCat = currentCategory === 'all' || p.category === currentCategory;
        const matchSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase());
        return matchCat && matchSearch;
    });

    if (sortMode === 'price-asc') filtered.sort((a, b) => a.price - b.price);
    else if (sortMode === 'price-desc') filtered.sort((a, b) => b.price - a.price);

    if (!filtered.length) {
        grid.innerHTML = `<p class="empty" style="grid-column:1/-1">Ничего не найдено 😕</p>`;
        return;
    }

    grid.innerHTML = filtered.map(p => {
        const isFav = favorites.includes(p.id);
        const pReviews = reviews.filter(r => r.productId === p.id);
        const avg = pReviews.length ? (pReviews.reduce((s, r) => s + r.stars, 0) / pReviews.length).toFixed(1) : null;
        const rating = avg ? `⭐ ${avg} (${pReviews.length})` : '⭐ Нет отзывов';
        const imgContent = p.image ? `<img src="${p.image}" alt="${p.name}">` : p.emoji;
        
        const inCartCount = cart.filter(c => c.id === p.id).reduce((sum, c) => sum + c.qty, 0);
        let cartActionHTML = inCartCount > 0 ? `
            <div style="display: flex; align-items: center; justify-content: space-between; background: var(--success); border-radius: 10px; padding: 4px;">
                <button data-main-dec="${p.id}" style="background: transparent; border: none; color: white; font-size: 20px; font-weight: bold; padding: 0 10px; cursor: pointer;">−</button>
                <span style="color: white; font-weight: bold; font-size: 14px;">${inCartCount}</span>
                <button data-main-inc="${p.id}" style="background: transparent; border: none; color: white; font-size: 20px; font-weight: bold; padding: 0 10px; cursor: pointer;">+</button>
            </div>` : `<button class="buy-btn" data-add-cart="${p.id}">В корзину</button>`;

        return `
        <div class="product-card">
            <div class="product-image" data-open-product="${p.id}">
                ${p.badge ? `<span class="product-badge">${p.badge}</span>` : ''}
                <button class="fav-btn" data-fav="${p.id}">${isFav ? '❤️' : '🤍'}</button>
                ${imgContent}
            </div>
            <div class="product-info">
                <div class="product-name" data-open-product="${p.id}">${p.name}</div>
                <div class="product-rating">${rating}</div>
                <div class="product-price">${formatPrice(p.price)}</div>
                ${p.oldPrice ? `<div class="product-old-price">${formatPrice(p.oldPrice)}</div>` : ''}
                <div class="product-actions">
                    ${cartActionHTML}
                    <button class="buy-now-btn" data-buy-now="${p.id}">⚡ Купить сейчас</button>
                </div>
            </div>
        </div>`;
    }).join('');

    bindProductEvents();
}

function bindProductEvents() {
    document.querySelectorAll('[data-open-product]').forEach(el => el.addEventListener('click', () => openProduct(+el.dataset.openProduct)));
    document.querySelectorAll('[data-fav]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(+el.dataset.fav); }));
    document.querySelectorAll('[data-add-cart]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); addToCart(+el.dataset.addCart); }));
    document.querySelectorAll('[data-buy-now]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); buyNow(+el.dataset.buyNow); }));
    document.querySelectorAll('[data-main-inc]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); changeQtyMain(+el.dataset.mainInc, 1); }));
    document.querySelectorAll('[data-main-dec]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); changeQtyMain(+el.dataset.mainDec, -1); }));
}

function changeQtyMain(productId, delta) {
    const idx = cart.findIndex(c => c.id === productId);
    if (idx >= 0) {
        cart[idx].qty += delta;
        if (cart[idx].qty <= 0) cart.splice(idx, 1);
        save('fs_cart', cart); updateCounts(); renderProducts();
    }
}

// === КАРТОЧКА ТОВАРА ===
function openProduct(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    selectedSizes[id] = selectedSizes[id] || p.sizes[0];
    const isFav = favorites.includes(p.id);
    const pReviews = reviews.filter(r => r.productId === id).reverse();
    const avg = pReviews.length ? (pReviews.reduce((s, r) => s + r.stars, 0) / pReviews.length).toFixed(1) : null;
    const imgContent = p.image ? `<img src="${p.image}" alt="${p.name}">` : p.emoji;

    const reviewsHTML = pReviews.length
        ? pReviews.map(r => `<div class="review-card"><div class="review-header"><span class="review-author">${r.author}</span><span class="review-stars">${'★'.repeat(r.stars)}</span></div><div class="review-text">${r.text}</div><div class="review-date">${r.date}</div></div>`).join('')
        : '<p class="empty" style="padding:20px 0">Пока нет отзывов</p>';

    document.getElementById('productModalBody').innerHTML = `
        <div class="product-detail">
            <div class="product-detail-image">${imgContent}</div>
            <h2>${p.name}</h2>
            <div class="price-row"><span class="price">${formatPrice(p.price)}</span>${p.oldPrice ? `<span class="old-price">${formatPrice(p.oldPrice)}</span>` : ''}</div>
            ${avg ? `<div style="color:#ffcc00;margin-bottom:12px">⭐ ${avg} · ${pReviews.length} отзывов</div>` : ''}
            ${p.description ? `<p style="font-size:14px;line-height:1.4;color:var(--text);margin-bottom:16px;padding:10px;background:rgba(0,0,0,0.03);border-radius:8px">${p.description}</p>` : ''}
            <p style="font-size:13px;color:var(--hint);margin-bottom:8px">Выберите размер:</p>
            <div class="sizes" id="sizesContainer">${p.sizes.map(s => `<button class="size-btn ${selectedSizes[id]===s?'selected':''}" data-size="${s}">${s}</button>`).join('')}</div>
            <div class="detail-actions">
                <button class="btn-secondary" id="detailFavBtn">${isFav?'❤️':'🤍'} Избранное</button>
                <button class="btn-primary" id="detailCartBtn">В корзину</button>
            </div>
            <button class="detail-buy-now" id="detailBuyNowBtn">⚡ Купить сейчас</button>
            <div class="reviews-section">
                <h3>⭐ Отзывы (${pReviews.length})</h3>
                <div class="review-form">
                    <input id="revName" placeholder="Ваше имя">
                    <select id="revStars"><option value="5">★★★★★</option><option value="4">★★★★☆</option><option value="3">★★★☆☆</option><option value="2">★★☆☆☆</option><option value="1">★☆☆☆☆</option></select>
                    <textarea id="revText" placeholder="Ваш отзыв" rows="2"></textarea>
                    <button id="submitReviewBtn">Оставить отзыв</button>
                </div>
                <div>${reviewsHTML}</div>
            </div>
        </div>`;

    document.querySelectorAll('#sizesContainer .size-btn').forEach(btn => btn.addEventListener('click', () => {
        selectedSizes[id] = btn.dataset.size;
        document.querySelectorAll('#sizesContainer .size-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
    }));
    document.getElementById('detailFavBtn').addEventListener('click', () => { toggleFavorite(id); openProduct(id); });
    document.getElementById('detailCartBtn').addEventListener('click', () => { addToCart(id); closeModal('productModal'); });
    document.getElementById('detailBuyNowBtn').addEventListener('click', () => buyNow(id));
    document.getElementById('submitReviewBtn').addEventListener('click', () => submitReview(id));
    openModal('productModal');
}

async function submitReview(productId) {
    const author = document.getElementById('revName').value.trim();
    const stars = +document.getElementById('revStars').value;
    const text = document.getElementById('revText').value.trim();
    if (!author || !text) { alert('Заполни имя и текст'); return; }
    
    await db.from('reviews').insert([{ product_id: productId, author, stars, text, date: new Date().toLocaleDateString('ru-RU') }]);
    await loadData();
    if (tg) tg.HapticFeedback?.notificationOccurred('success');
    openProduct(productId);
}

// === КОРЗИНА ===
function addToCart(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const size = selectedSizes[id] || p.sizes[0];
    const existing = cart.find(c => c.id === id && c.size === size);
    if (existing) existing.qty++;
    else cart.push({ id, size, qty: 1 });
    save('fs_cart', cart); updateCounts(); renderProducts();
    if (tg) tg.HapticFeedback?.impactOccurred('medium');
}

function changeQty(index, delta) {
    cart[index].qty += delta;
    if (cart[index].qty <= 0) cart.splice(index, 1);
    save('fs_cart', cart); updateCounts(); renderCart(); renderProducts();
}

function removeCartItem(index) {
    cart.splice(index, 1);
    save('fs_cart', cart); updateCounts(); renderCart(); renderProducts();
}

function openCart() { renderCart(); openModal('cartModal'); }

function renderCart() {
    const body = document.getElementById('cartBody');
    const footer = document.getElementById('cartFooter');
    if (!cart.length) { body.innerHTML = '<p class="empty">Корзина пуста 🛒</p>'; footer.innerHTML = ''; return; }
    let total = 0;
    body.innerHTML = cart.map((c, i) => {
        const p = products.find(x => x.id === c.id);
        if (!p) return '';
        total += p.price * c.qty;
        const imgContent = p.image ? `<img src="${p.image}" alt="">` : p.emoji;
        return `<div class="cart-item"><div class="cart-item-img">${imgContent}</div><div class="cart-item-info"><div class="cart-item-name">${p.name}</div><div style="font-size:11px;color:var(--hint)">Размер: ${c.size}</div><div class="cart-item-price">${formatPrice(p.price * c.qty)}</div><div class="qty-controls"><button data-qty-dec="${i}">−</button><span>${c.qty}</span><button data-qty-inc="${i}">+</button><button style="margin-left:auto;background:var(--danger);color:white" data-qty-del="${i}">🗑</button></div></div></div>`;
    }).join('');
    footer.innerHTML = `<div class="cart-total"><span>Итого:</span><span>${formatPrice(total)}</span></div><div class="cart-actions"><button class="btn-primary" id="checkoutBtn">📦 Оформить заказ</button><button class="btn-secondary" id="askManagerBtn">Задать вопрос</button></div>`;
    document.querySelectorAll('[data-qty-dec]').forEach(b => b.addEventListener('click', () => changeQty(+b.dataset.qtyDec, -1)));
    document.querySelectorAll('[data-qty-inc]').forEach(b => b.addEventListener('click', () => changeQty(+b.dataset.qtyInc, 1)));
    document.querySelectorAll('[data-qty-del]').forEach(b => b.addEventListener('click', () => removeCartItem(+b.dataset.qtyDel)));
    document.getElementById('checkoutBtn').addEventListener('click', checkout);
    document.getElementById('askManagerBtn').addEventListener('click', () => { if (tg) tg.HapticFeedback?.impactOccurred('light'); openManagerChat('Здравствуйте! Хочу сделать заказ в FastSHIP.'); });
}

async function checkout() {
    if (!cart.length) return;
    const total = cart.reduce((s, c) => { const p = products.find(x => x.id === c.id); return s + (p ? p.price * c.qty : 0); }, 0);
    const orderId = 'FS-' + Date.now().toString().slice(-6);
    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
    const items = cart.map(c => { const p = products.find(x => x.id === c.id); return { name: p.name, size: c.size, qty: c.qty, price: p.price }; });

    await db.from('orders').insert([{ order_code: orderId, items, total, status: 'new', date: dateStr, user_id: currentUser?.id, user_name: currentUser?.name, user_username: currentUser?.username }]);
    if (isAdmin()) await loadData();
    
    const msg = buildOrderMessage(items, total, orderId);
    cart = []; save('fs_cart', cart); updateCounts(); closeModal('cartModal'); renderProducts();
    if (tg) tg.HapticFeedback?.notificationOccurred('success');
    openManagerChat(msg);
}

// === ИЗБРАННОЕ ===
function toggleFavorite(id) {
    const i = favorites.indexOf(id);
    if (i >= 0) favorites.splice(i, 1); else favorites.push(id);
    save('fs_favorites', favorites); updateCounts(); renderProducts();
    if (tg) tg.HapticFeedback?.selectionChanged();
}

function openFavorites() {
    const body = document.getElementById('favoritesBody');
    if (!favorites.length) { body.innerHTML = '<p class="empty">В избранном пусто 🤍</p>'; }
    else {
        body.innerHTML = favorites.map(id => {
            const p = products.find(x => x.id === id);
            if (!p) return '';
            const imgContent = p.image ? `<img src="${p.image}" alt="">` : p.emoji;
            const inCartCount = cart.filter(c => c.id === p.id).reduce((sum, c) => sum + c.qty, 0);
            const btnText = inCartCount > 0 ? `В корзине (${inCartCount} шт)` : 'В корзину';
            const btnColor = inCartCount > 0 ? 'var(--success)' : 'var(--accent)';
            return `<div class="cart-item" style="flex-direction: column; align-items: stretch; gap: 10px;"><div style="display: flex; gap: 12px; align-items: center;"><div class="cart-item-img" data-open-product="${p.id}">${imgContent}</div><div class="cart-item-info" data-open-product="${p.id}"><div class="cart-item-name">${p.name}</div><div class="cart-item-price">${formatPrice(p.price)}</div></div></div><div style="display: flex; gap: 8px;"><button class="btn-primary" style="flex: 1; padding: 12px; font-size: 14px; background: ${btnColor};" data-add-from-fav="${p.id}">${btnText}</button><button class="btn-secondary" style="padding: 12px 16px; font-size: 14px; background: var(--danger); color: white;" data-unfav="${id}">✕</button></div></div>`;
        }).join('');
        document.querySelectorAll('#favoritesBody [data-open-product]').forEach(el => el.addEventListener('click', () => { closeModal('favoritesModal'); openProduct(+el.dataset.openProduct); }));
        document.querySelectorAll('#favoritesBody [data-add-from-fav]').forEach(el => el.addEventListener('click', () => {
            const pid = +el.dataset.addFromFav;
            addToCart(pid);
            const count = cart.filter(c => c.id === pid).reduce((s, c) => s + c.qty, 0);
            el.textContent = `В корзине (${count} шт)`; el.style.background = 'var(--success)';
        }));
        document.querySelectorAll('#favoritesBody [data-unfav]').forEach(el => el.addEventListener('click', () => { toggleFavorite(+el.dataset.unfav); openFavorites(); }));
    }
    openModal('favoritesModal');
}

// === ОТЗЫВЫ ===
function openReviews() {
    const body = document.getElementById('reviewsBody');
    body.innerHTML = reviews.length ? reviews.slice().reverse().map(r => {
        const p = products.find(x => x.id === r.productId);
        return `<div class="review-card"><div class="review-header"><span class="review-author">${r.author}</span><span class="review-stars">${'★'.repeat(r.stars)}</span></div>${p ? `<div style="font-size:11px;color:var(--hint);margin-bottom:4px">${p.name}</div>` : ''}<div class="review-text">${r.text}</div><div class="review-date">${r.date}</div></div>`;
    }).join('') : '<p class="empty">Отзывов пока нет</p>';
    openModal('reviewsModal');
}

// === ЗАКАЗЫ КЛИЕНТА ===
async function openOrders() {
    const body = document.getElementById('ordersBody');
    if (!currentUser) { body.innerHTML = '<p class="empty">Войдите в Telegram</p>'; openModal('ordersModal'); return; }
    const { data } = await db.from('orders').select('*').eq('user_id', currentUser.id).order('id', { ascending: false });
    const myOrders = data || [];
    body.innerHTML = myOrders.length ? myOrders.map(o => `
        <div class="order-card">
            <div class="order-header"><span class="order-id">${o.order_code}</span><span class="order-status">${statusLabel(o.status)}</span></div>
            <div class="order-items">${o.items.map(i => `${i.name} (${i.size}) × ${i.qty}`).join('<br>')}</div>
            <div class="order-total">${formatPrice(o.total)}</div>
            <div style="font-size:11px;color:var(--hint);margin-top:6px">${o.date}</div>
        </div>`).join('') : '<p class="empty">У вас пока нет заказов 📦</p>';
    openModal('ordersModal');
}

function statusLabel(s) { return { new: 'На проверке', processing: 'Принят в работу', shipped: 'В пути', delivered: 'Доставлен', rejected: 'Отклонен' }[s] || s; }

// === АДМИНКА ===
async function openAdmin() {
    if (!isAdmin()) { alert('Доступ только для администратора'); return; }
    await loadData();
    switchAdminTab('orders', document.querySelector('.admin-tab'));
    openModal('adminModal');
}

async function switchAdminTab(tab, btn) {
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
    btn?.classList.add('active');
    const body = document.getElementById('adminBody');

    if (tab === 'orders') {
        if (!orders.length) { body.innerHTML = '<p class="empty">Заказов нет</p>'; return; }
        body.innerHTML = orders.map(o => {
            const isNew = o.status === 'new';
            const userInfo = o.user ? `<div style="font-size:12px;color:var(--hint);margin-bottom:6px">👤 ${o.user.name} (${o.user.username})</div>` : '';
            return `<div class="order-card"><div class="order-header"><span class="order-id">${o.id}</span><span class="order-status">${statusLabel(o.status)}</span></div>${userInfo}<div class="order-items">${o.items.map(i => `${i.name} (${i.size}) × ${i.qty}`).join('<br>')}</div><div class="order-total">${formatPrice(o.total)}</div>${isNew ? `<div style="display:flex; gap:8px; margin-top:12px;"><button class="btn-primary" style="flex:1; padding:10px; font-size:13px;" data-accept-order="${o.id}">✅ Принять</button><button class="btn-secondary" style="flex:1; padding:10px; font-size:13px; background:var(--danger); color:white;" data-reject-order="${o.id}">❌ Отклонить</button></div>` : `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${['processing','shipped','delivered'].map(s => `<button class="size-btn ${o.status===s?'selected':''}" data-set-status="${o.id}|${s}">${statusLabel(s)}</button>`).join('')}</div>`}</div>`;
        }).join('');
        document.querySelectorAll('[data-accept-order]').forEach(b => b.addEventListener('click', () => setOrderStatus(b.dataset.acceptOrder, 'processing')));
        document.querySelectorAll('[data-reject-order]').forEach(b => b.addEventListener('click', () => { if(confirm('Отклонить заказ?')) setOrderStatus(b.dataset.rejectOrder, 'rejected'); }));
        document.querySelectorAll('[data-set-status]').forEach(b => b.addEventListener('click', () => { const [id, status] = b.dataset.setStatus.split('|'); setOrderStatus(id, status); }));
    }

    if (tab === 'products') {
        const catOptions = categories.filter(c => c.slug !== 'all').map(c => `<option value="${c.slug}">${c.name}</option>`).join('');
        body.innerHTML = `
            <div class="admin-form">
                <input id="newName" placeholder="Название товара">
                <input id="newPrice" type="number" placeholder="Цена (₽)">
                <input id="newOldPrice" type="number" placeholder="Старая цена">
                <select id="newCategory">${catOptions}</select>
                <input id="newEmoji" placeholder="Эмодзи 🧥" maxlength="4">
                <input id="newImage" placeholder="Ссылка на фото">
                <input id="newBadge" placeholder="Бейдж (NEW)">
                <textarea id="newDescription" placeholder="Описание товара" rows="2"></textarea>
                <button id="addProductBtn">➕ Добавить товар</button>
            </div>
            <div style="margin-bottom:16px; border-top:1px solid rgba(0,0,0,0.1); padding-top:16px;">
                <h4 style="margin-bottom:8px;">Добавить категорию</h4>
                <div style="display:flex; gap:8px;">
                    <input id="newCatName" placeholder="Название (напр. Сумки)" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(0,0,0,0.1); background:var(--bg); color:var(--text);">
                    <button id="addCatBtn" style="padding:10px; border:none; border-radius:10px; background:var(--success); color:white; font-weight:bold;">Добавить</button>
                </div>
            </div>
            <div>${products.map(p => `<div class="admin-item"><div class="admin-item-info"><b>${p.emoji} ${p.name}</b><span>${formatPrice(p.price)} · ${p.category}</span></div><button class="admin-del" data-del-product="${p.id}">🗑</button></div>`).join('')}</div>`;
        document.getElementById('addProductBtn').addEventListener('click', adminAddProduct);
        document.getElementById('addCatBtn').addEventListener('click', adminAddCategory);
        document.querySelectorAll('[data-del-product]').forEach(b => b.addEventListener('click', () => adminDeleteProduct(+b.dataset.delProduct)));
    }

    if (tab === 'reviews') {
        body.innerHTML = `<div class="admin-form"><select id="revProduct">${products.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select><input id="revAuthor" placeholder="Имя"><select id="revStars"><option value="5">★★★★★</option><option value="4">★★★★☆</option><option value="3">★★★☆☆</option></select><textarea id="revText" placeholder="Текст отзыва" rows="2"></textarea><button id="addReviewBtn">➕ Добавить отзыв</button></div><div>${reviews.slice().reverse().map(r => `<div class="admin-item"><div class="admin-item-info"><b>${r.author} ${'★'.repeat(r.stars)}</b><span>${r.text.slice(0, 50)}...</span></div><button class="admin-del" data-del-review="${r.id}">🗑</button></div>`).join('')}</div>`;
        document.getElementById('addReviewBtn').addEventListener('click', adminAddReview);
        document.querySelectorAll('[data-del-review]').forEach(b => b.addEventListener('click', () => adminDeleteReview(+b.dataset.delReview)));
    }
}

async function setOrderStatus(code, status) {
    await db.from('orders').update({ status }).eq('order_code', code);
    await loadData();
    switchAdminTab('orders', document.querySelector('.admin-tab'));
}

async function adminAddCategory() {
    const name = document.getElementById('newCatName').value.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-zа-я0-9]/g, '-');
    await db.from('categories').insert([{ name, slug }]);
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminAddProduct() {
    const name = document.getElementById('newName').value.trim();
    const price = +document.getElementById('newPrice').value;
    const oldPrice = +document.getElementById('newOldPrice').value || null;
    const category = document.getElementById('newCategory').value;
    const emoji = document.getElementById('newEmoji').value || '👕';
    const image = document.getElementById('newImage').value.trim();
    const badge = document.getElementById('newBadge').value || null;
    const description = document.getElementById('newDescription').value.trim() || null;

    if (!name || !price) { alert('Заполни название и цену'); return; }
    await db.from('products').insert([{ name, price, old_price: oldPrice, category, emoji, image: image || null, badge, sizes: ['S','M','L','XL'], description }]);
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminDeleteProduct(id) {
    if (!confirm('Удалить товар?')) return;
    await db.from('products').delete().eq('id', id);
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminAddReview() {
    const productId = +document.getElementById('revProduct').value;
    const author = document.getElementById('revAuthor').value.trim();
    const stars = +document.getElementById('revStars').value;
    const text = document.getElementById('revText').value.trim();
    if (!author || !text) { alert('Заполни имя и текст'); return; }
    await db.from('reviews').insert([{ product_id: productId, author, stars, text, date: new Date().toLocaleDateString('ru-RU') }]);
    await loadData();
    switchAdminTab('reviews', document.querySelectorAll('.admin-tab')[2]);
}

async function adminDeleteReview(id) {
    if (!confirm('Удалить отзыв?')) return;
    await db.from('reviews').delete().eq('id', id);
    await loadData();
    switchAdminTab('reviews', document.querySelectorAll('.admin-tab')[2]);
}

// === ОБЩЕЕ ===
function updateCounts() {
    const cartTotal = cart.reduce((s, c) => s + c.qty, 0);
    document.getElementById('cartCount').textContent = cartTotal || '';
    document.getElementById('favCount').textContent = favorites.length || '';
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// === СТАРТ ===
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('searchInput').addEventListener('input', (e) => { searchQuery = e.target.value; renderProducts(); });
    document.getElementById('sortSelect').addEventListener('change', (e) => { sortMode = e.target.value; renderProducts(); });
    document.getElementById('btnFav').addEventListener('click', openFavorites);
    document.getElementById('btnCart').addEventListener('click', openCart);
    document.getElementById('btnContact').addEventListener('click', () => openManagerChat('Здравствуйте! Хочу сделать заказ в FastSHIP.'));
    document.getElementById('navHome').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    document.getElementById('navOrders').addEventListener('click', openOrders);
    document.getElementById('navReviews').addEventListener('click', openReviews);
    document.getElementById('navAdmin').addEventListener('click', openAdmin);

    document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }));
    document.querySelectorAll('.admin-tab').forEach(btn => btn.addEventListener('click', () => switchAdminTab(btn.dataset.tab, btn)));

    if (isAdmin()) document.getElementById('navAdmin').style.display = 'flex';
    loadData();
    updateCounts();
});