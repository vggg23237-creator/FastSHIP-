console.log('SCRIPT LOADED', new Date().toISOString());

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

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
let adminOrderFilter = 'new';
let uploadedImageUrl = null; // Сюда сохраняем ссылку после загрузки фото

function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function formatPrice(p) { return p.toLocaleString('ru-RU') + ' ₽'; }
function isAdmin() { return currentUser && ADMIN_IDS.includes(currentUser.id); }

// === ЗАГРУЗКА ДАННЫХ ===
async function loadData() {
    document.getElementById('productsGrid').innerHTML = '<p class="empty" style="grid-column:1/-1">Загрузка...</p>';
    const { data: c } = await db.from('categories').select('*').order('id');
    categories = c || [{name: 'Все', slug: 'all'}];
    renderCategories();

    const { data: p } = await db.from('products').select('*').order('id');
    if (p) products = p.map(x => ({ id: x.id, name: x.name, price: x.price, oldPrice: x.old_price, category: x.category, emoji: x.emoji, image: x.image, badge: x.badge, sizes: x.sizes, description: x.description }));
    
    const { data: r } = await db.from('reviews').select('*');
    if (r) reviews = r.map(x => ({ id: x.id, productId: x.product_id, author: x.author, stars: x.stars, text: x.text, date: x.date }));

    if (isAdmin()) {
        const { data: o } = await db.from('orders').select('*').order('id', { ascending: false });
        if (o) orders = o.map(x => ({ id: x.order_code, items: x.items, total: x.total, status: x.status, date: x.date, address: x.address, phone: x.phone, user: { id: x.user_id, name: x.user_name, username: x.user_username } }));
    }
    renderProducts(); updateCounts();
}

// === УВЕДОМЛЕНИЕ О КОРЗИНЕ ===
function checkAbandonedCart() {
    if (cart.length > 0 && !sessionStorage.getItem('cart_notified')) {
        setTimeout(() => {
            if (confirm(`У вас в корзине ${cart.reduce((s,c)=>s+c.qty,0)} товар(ов). Перейти к оформлению?`)) openCart();
            sessionStorage.setItem('cart_notified', 'true');
        }, 1500);
    }
}

// === ЗАГРУЗКА ФОТО С ТЕЛЕФОНА ===
async function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        if (tg) tg.showAlert('Обработка фото...');
        
        // Сжимаем картинку (чтобы весила мало и сайт летал)
        const options = { maxSizeMB: 0.5, maxWidthOrHeight: 800, useWebWorker: true };
        const compressedFile = await imageCompression(file, options);
        
        // Генерируем уникальное имя файла
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;

        // Загружаем в Supabase Storage
        const { data, error } = await db.storage.from('images').upload(fileName, compressedFile, { contentType: 'image/jpeg' });
        if (error) throw error;

        // Получаем публичную ссылку
        const { data: urlData } = db.storage.from('images').getPublicUrl(fileName);
        uploadedImageUrl = urlData.publicUrl;

        // Показываем превью
        document.getElementById('photoPreview').innerHTML = `<img src="${uploadedImageUrl}" style="width:100%; height:100%; object-fit:cover; border-radius:8px;">`;
        document.getElementById('photoPreview').style.display = 'block';
        
        if (tg) tg.HapticFeedback?.notificationOccurred('success');
    } catch (err) {
        console.error('Ошибка загрузки фото:', err);
        if (tg) tg.showAlert('Ошибка загрузки фото. Попробуйте еще раз.');
        else alert('Ошибка загрузки фото.');
    }
}

// === РЕНДЕР КАТЕГОРИЙ ===
function renderCategories() {
    const container = document.getElementById('categories');
    container.innerHTML = categories.map(c => `<button class="category ${currentCategory === c.slug ? 'active' : ''}" data-cat="${c.slug}">${c.name}</button>`).join('');
    container.querySelectorAll('.category').forEach(btn => {
        btn.addEventListener('click', () => { container.querySelectorAll('.category').forEach(b => b.classList.remove('active')); btn.classList.add('active'); currentCategory = btn.dataset.cat; renderProducts(); });
    });
}

// === РЕНДЕР ТОВАРОВ ===
function renderProducts() {
    const grid = document.getElementById('productsGrid');
    let filtered = products.filter(p => (currentCategory === 'all' || p.category === currentCategory) && p.name.toLowerCase().includes(searchQuery.toLowerCase()));
    if (sortMode === 'price-asc') filtered.sort((a, b) => a.price - b.price);
    else if (sortMode === 'price-desc') filtered.sort((a, b) => b.price - a.price);

    if (!filtered.length) { grid.innerHTML = `<p class="empty" style="grid-column:1/-1">Ничего не найдено 😕</p>`; return; }

    grid.innerHTML = filtered.map(p => {
        const isFav = favorites.includes(p.id);
        const pReviews = reviews.filter(r => r.productId === p.id);
        const avg = pReviews.length ? (pReviews.reduce((s, r) => s + r.stars, 0) / pReviews.length).toFixed(1) : null;
        const rating = avg ? `⭐ ${avg} (${pReviews.length})` : '⭐ Нет отзывов';
        const imgContent = p.image ? `<img src="${p.image}" alt="${p.name}">` : p.emoji;
        const inCartCount = cart.filter(c => c.id === p.id).reduce((sum, c) => sum + c.qty, 0);
        let cartActionHTML = inCartCount > 0 ? `
            <div style="display: flex; align-items: center; justify-content: space-between; background: var(--success); border-radius: 10px; padding: 4px;">
                <button data-main-dec="${p.id}" style="background: transparent; border: none; color: white; font-size: 20px; font-weight: bold; padding: 0 10px;">−</button>
                <span style="color: white; font-weight: bold; font-size: 14px;">${inCartCount}</span>
                <button data-main-inc="${p.id}" style="background: transparent; border: none; color: white; font-size: 20px; font-weight: bold; padding: 0 10px;">+</button>
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
                <div class="product-actions">${cartActionHTML}<button class="buy-now-btn" data-buy-now="${p.id}">⚡ Купить</button></div>
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
    if (idx >= 0) { cart[idx].qty += delta; if (cart[idx].qty <= 0) cart.splice(idx, 1); save('fs_cart', cart); updateCounts(); renderProducts(); }
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

    const similar = products.filter(x => x.category === p.category && x.id !== p.id).slice(0, 4);
    const similarHTML = similar.length ? `
        <div class="reviews-section">
            <h3>Похожие товары</h3>
            <div style="display: flex; gap: 8px; overflow-x: auto; padding-bottom: 10px;">
                ${similar.map(s => `<div style="min-width: 100px; width: 100px;" data-open-product="${s.id}"><div style="width:100%; aspect-ratio:1; border-radius:10px; background:var(--card); display:flex; align-items:center; justify-content:center; overflow:hidden; margin-bottom:4px;">${s.image?`<img src="${s.image}" style="width:100%;height:100%;object-fit:cover;">`:s.emoji}</div><div style="font-size:11px; font-weight:600; line-height:1.2; height:26px; overflow:hidden;">${s.name}</div><div style="font-size:12px; color:var(--accent); font-weight:bold;">${formatPrice(s.price)}</div></div>`).join('')}
            </div>
        </div>` : '';

    const reviewsHTML = pReviews.length ? pReviews.map(r => `<div class="review-card"><div class="review-header"><span class="review-author">${r.author}</span><span class="review-stars">${'★'.repeat(r.stars)}</span></div><div class="review-text">${r.text}</div><div class="review-date">${r.date}</div></div>`).join('') : '<p class="empty" style="padding:10px 0">Пока нет отзывов</p>';

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
                <button class="btn-secondary" id="detailFavBtn">${isFav?'❤️':'🤍'}</button>
                <button class="btn-secondary" id="shareBtn">📤 Поделиться</button>
                <button class="btn-primary" id="detailCartBtn">В корзину</button>
            </div>
            <button class="detail-buy-now" id="detailBuyNowBtn">⚡ Купить сейчас</button>
            ${similarHTML}
            <div class="reviews-section">
                <h3>⭐ Отзывы (${pReviews.length})</h3>
                <div class="review-form">
                    <input id="revName" placeholder="Ваше имя">
                    <select id="revStars"><option value="5">★★★★★</option><option value="4">★★★★☆</option><option value="3">★★★☆☆</option></select>
                    <textarea id="revText" placeholder="Ваш отзыв" rows="2"></textarea>
                    <button id="submitReviewBtn">Оставить отзыв</button>
                </div>
                <div>${reviewsHTML}</div>
            </div>
        </div>`;

    document.querySelectorAll('#sizesContainer .size-btn').forEach(btn => btn.addEventListener('click', () => { selectedSizes[id] = btn.dataset.size; document.querySelectorAll('#sizesContainer .size-btn').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); }));
    document.getElementById('shareBtn').addEventListener('click', () => { const shareUrl = `https://t.me/share/url?url=https://t.me/${MANAGER_USERNAME}&text=Смотри: ${p.name} за ${formatPrice(p.price)}!`; if (tg) tg.openTelegramLink(shareUrl); else window.open(shareUrl, '_blank'); });
    document.getElementById('detailFavBtn').addEventListener('click', () => { toggleFavorite(id); openProduct(id); });
    document.getElementById('detailCartBtn').addEventListener('click', () => { addToCart(id); closeModal('productModal'); });
    document.getElementById('detailBuyNowBtn').addEventListener('click', () => buyNow(id));
    document.getElementById('submitReviewBtn').addEventListener('click', () => submitReview(id));
    document.querySelectorAll('.product-detail [data-open-product]').forEach(el => el.addEventListener('click', () => { closeModal('productModal'); openProduct(+el.dataset.openProduct); }));
    openModal('productModal');
}

// === ФОРМА ЗАКАЗА ===
function showCheckoutForm(items, total, orderId) {
    document.getElementById('productModalBody').innerHTML = `
        <div class="product-detail">
            <h2>Оформление заказа</h2>
            <p style="color:var(--hint); margin-bottom:16px;">Заполните данные для доставки.</p>
            <div class="review-form">
                <input id="checkoutName" placeholder="Ваше Имя" value="${currentUser?.name || ''}">
                <input id="checkoutPhone" type="tel" placeholder="Номер телефона">
                <input id="checkoutAddress" placeholder="Город, адрес или Пункт выдачи">
            </div>
            <div class="cart-total" style="margin-bottom:16px;"><span>К оплате:</span><span>${formatPrice(total)}</span></div>
            <button class="btn-primary" id="confirmCheckoutBtn" style="width:100%; padding:16px; border-radius:12px; border:none; font-size:16px; font-weight:bold; margin-bottom:10px;">Подтвердить заказ</button>
            <button class="btn-secondary" id="cancelCheckoutBtn" style="width:100%; padding:14px; border-radius:12px; border:none;">Отмена</button>
        </div>`;
    openModal('productModal');

    document.getElementById('cancelCheckoutBtn').addEventListener('click', () => closeModal('productModal'));
    document.getElementById('confirmCheckoutBtn').addEventListener('click', async () => {
        const name = document.getElementById('checkoutName').value.trim(); const phone = document.getElementById('checkoutPhone').value.trim(); const address = document.getElementById('checkoutAddress').value.trim();
        if (!name || !phone || !address) { alert('Пожалуйста, заполните все поля!'); return; }
        await db.from('orders').insert([{ order_code: orderId, items, total, status: 'new', date: new Date().toLocaleString('ru-RU'), user_id: currentUser?.id, user_name: name, user_username: currentUser?.username, phone: phone, address: address }]);
        if (isAdmin()) await loadData();
        const msg = `Здравствуйте! Хочу сделать заказ в FastSHIP.\n\n🛒 Заказ: ${orderId}\n📦 Товары:\n${items.map(i => `• ${i.name} (${i.size}) × ${i.qty} — ${formatPrice(i.price * i.qty)}`).join('\n')}\n\n💰 Итого: ${formatPrice(total)}\n\n👤 Клиент: ${name}\n📞 Тел: ${phone}\n🏠 Адрес: ${address}\n🔗 TG: ${currentUser?.username || '—'}`;
        cart = []; save('fs_cart', cart); updateCounts(); closeModal('productModal'); renderProducts();
        if (tg) tg.HapticFeedback?.notificationOccurred('success');
        openManagerChat(msg);
    });
}

async function buyNow(id) { const p = products.find(x => x.id === id); if (!p) return; const items = [{ name: p.name, size: selectedSizes[id] || p.sizes[0], qty: 1, price: p.price }]; showCheckoutForm(items, p.price, 'FS-' + Date.now().toString().slice(-6)); }
async function checkout() { if (!cart.length) return; const total = cart.reduce((s, c) => { const p = products.find(x => x.id === c.id); return s + (p ? p.price * c.qty : 0); }, 0); const items = cart.map(c => { const p = products.find(x => x.id === c.id); return { name: p.name, size: c.size, qty: c.qty, price: p.price }; }); closeModal('cartModal'); showCheckoutForm(items, total, 'FS-' + Date.now().toString().slice(-6)); }

// === АДМИНКА ===
async function openAdmin() { if (!isAdmin()) return alert('Нет доступа'); await loadData(); switchAdminTab('orders', document.querySelector('.admin-tab')); openModal('adminModal'); }

async function switchAdminTab(tab, btn) {
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active')); btn?.classList.add('active');
    const body = document.getElementById('adminBody');

    if (tab === 'orders') {
        const totalSum = orders.filter(o => o.status !== 'rejected').reduce((s, o) => s + o.total, 0);
        const avgCheck = orders.filter(o => o.status !== 'rejected').length ? Math.round(totalSum / orders.filter(o => o.status !== 'rejected').length) : 0;
        let filteredOrders = orders;
        if (adminOrderFilter === 'active') filteredOrders = orders.filter(o => o.status !== 'rejected' && o.status !== 'delivered');
        else if (adminOrderFilter === 'archive') filteredOrders = orders.filter(o => o.status === 'rejected' || o.status === 'delivered');

        body.innerHTML = `
            <div style="background:var(--card); padding:12px; border-radius:12px; margin-bottom:16px; display:flex; justify-content:space-between; text-align:center;">
                <div><div style="font-size:11px;color:var(--hint)">Выручка</div><div style="font-weight:bold;color:var(--success)">${formatPrice(totalSum)}</div></div>
                <div><div style="font-size:11px;color:var(--hint)">Ср. чек</div><div style="font-weight:bold;">${formatPrice(avgCheck)}</div></div>
                <div><div style="font-size:11px;color:var(--hint)">Всего</div><div style="font-weight:bold;">${orders.length}</div></div>
            </div>
            <div style="display:flex; gap:8px; margin-bottom:12px;">
                <button class="size-btn ${adminOrderFilter==='all'?'selected':''}" data-filter="all" style="flex:1;font-size:11px;">Все</button>
                <button class="size-btn ${adminOrderFilter==='active'?'selected':''}" data-filter="active" style="flex:1;font-size:11px;">Активные</button>
                <button class="size-btn ${adminOrderFilter==='archive'?'selected':''}" data-filter="archive" style="flex:1;font-size:11px;">Архив</button>
            </div>
            <div>${filteredOrders.map(o => {
                const isNew = o.status === 'new'; const userInfo = o.user ? `<div style="font-size:12px;color:var(--hint);margin-bottom:6px">👤 ${o.user.name} (${o.user.username})<br>📞 ${o.phone || '—'}<br>🏠 ${o.address || '—'}</div>` : '';
                return `<div class="order-card"><div class="order-header"><span class="order-id">${o.id}</span><span class="order-status">${statusLabel(o.status)}</span></div>${userInfo}<div class="order-items">${o.items.map(i => `${i.name} (${i.size}) × ${i.qty}`).join('<br>')}</div><div class="order-total">${formatPrice(o.total)}</div>${isNew ? `<div style="display:flex; gap:8px; margin-top:12px;"><button class="btn-primary" style="flex:1; padding:10px; font-size:13px;" data-accept-order="${o.id}">✅ Принять</button><button class="btn-secondary" style="flex:1; padding:10px; font-size:13px; background:var(--danger); color:white;" data-reject-order="${o.id}">❌ Отклонить</button></div>` : `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${['processing','shipped','delivered'].map(s => `<button class="size-btn ${o.status===s?'selected':''}" data-set-status="${o.id}|${s}">${statusLabel(s)}</button>`).join('')}</div>`}</div>`;
            }).join('')}</div>`;
        
        document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { adminOrderFilter = b.dataset.filter; switchAdminTab('orders', document.querySelector('.admin-tab')); }));
        document.querySelectorAll('[data-accept-order]').forEach(b => b.addEventListener('click', () => setOrderStatus(b.dataset.acceptOrder, 'processing')));
        document.querySelectorAll('[data-reject-order]').forEach(b => b.addEventListener('click', () => { if(confirm('Отклонить?')) setOrderStatus(b.dataset.rejectOrder, 'rejected'); }));
        document.querySelectorAll('[data-set-status]').forEach(b => b.addEventListener('click', () => { const [id, status] = b.dataset.setStatus.split('|'); setOrderStatus(id, status); }));
    }

    if (tab === 'products') {
        const catOptions = categories.filter(c => c.slug !== 'all').map(c => `<option value="${c.slug}">${c.name}</option>`).join('');
        body.innerHTML = `
            <div class="admin-form">
                <input id="newName" placeholder="Название товара">
                <input id="newPrice" type="number" placeholder="Цена (₽)">
                <select id="newCategory">${catOptions}</select>
                
                <!-- БЛОК ЗАГРУЗКИ ФОТО -->
                <div style="margin: 10px 0;">
                    <button type="button" id="uploadPhotoBtn" style="width:100%; padding:12px; border-radius:10px; border:1px dashed var(--accent); background:transparent; color:var(--accent); font-weight:bold;">📸 Выбрать фото с телефона</button>
                    <div id="photoPreview" style="display:none; width:100px; height:100px; margin-top:10px; border-radius:8px; overflow:hidden; background:var(--bg);"></div>
                </div>

                <textarea id="newDescription" placeholder="Описание" rows="2"></textarea>
                <button id="addProductBtn">➕ Добавить товар</button>
            </div>
            <div style="margin-bottom:16px; border-top:1px solid rgba(0,0,0,0.1); padding-top:16px;">
                <div style="display:flex; gap:8px;"><input id="newCatName" placeholder="Новая категория..." style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(0,0,0,0.1);"><button id="addCatBtn" style="padding:10px; border:none; border-radius:10px; background:var(--success); color:white;">+</button></div>
            </div>
            <div>${products.map(p => `<div class="admin-item"><div class="admin-item-info"><b>${p.name}</b><span>${formatPrice(p.price)}</span></div><button class="admin-del" style="background:var(--accent); margin-right:4px;" data-edit-product="${p.id}">✏️</button><button class="admin-del" data-del-product="${p.id}">🗑</button></div>`).join('')}</div>`;
        
        // Обработчик выбора фото
        document.getElementById('uploadPhotoBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        
        document.getElementById('addProductBtn').addEventListener('click', adminAddProduct);
        document.getElementById('addCatBtn').addEventListener('click', adminAddCategory);
        document.querySelectorAll('[data-del-product]').forEach(b => b.addEventListener('click', () => adminDeleteProduct(+b.dataset.delProduct)));
        document.querySelectorAll('[data-edit-product]').forEach(b => b.addEventListener('click', () => adminEditProduct(+b.dataset.editProduct)));
    }

    if (tab === 'reviews') {
        body.innerHTML = `<div>${reviews.map(r => `<div class="admin-item"><div class="admin-item-info"><b>${r.author}</b><span>${r.text}</span></div><button class="admin-del" data-del-review="${r.id}">🗑</button></div>`).join('')}</div>`;
        document.querySelectorAll('[data-del-review]').forEach(b => b.addEventListener('click', () => adminDeleteReview(+b.dataset.delReview)));
    }
}

async function adminAddProduct() {
    const name = document.getElementById('newName').value.trim(); const price = +document.getElementById('newPrice').value; const category = document.getElementById('newCategory').value; const description = document.getElementById('newDescription').value.trim();
    if (!name || !price) return alert('Заполни название и цену');
    
    // Используем загруженную ссылку (если она есть)
    await db.from('products').insert([{ name, price, category, image: uploadedImageUrl, description, sizes: ['S','M','L','XL'] }]);
    
    // Очищаем превью и ссылку после добавления
    uploadedImageUrl = null;
    document.getElementById('photoPreview').style.display = 'none';
    
    await loadData(); switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function setOrderStatus(code, status) { await db.from('orders').update({ status }).eq('order_code', code); await loadData(); switchAdminTab('orders', document.querySelector('.admin-tab')); }
async function adminAddCategory() { const name = document.getElementById('newCatName').value.trim(); if (!name) return; await db.from('categories').insert([{ name, slug: name.toLowerCase().replace(/[^a-zа-я0-9]/g, '-') }]); await loadData(); switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]); }
async function adminEditProduct(id) { const p = products.find(x => x.id === id); if (!p) return; const newName = prompt('Название:', p.name); if (newName === null) return; const newPrice = prompt('Цена:', p.price); if (newPrice === null) return; const newDesc = prompt('Описание:', p.description || ''); await db.from('products').update({ name: newName, price: +newPrice, description: newDesc }).eq('id', id); await loadData(); switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]); }
async function adminDeleteProduct(id) { if (!confirm('Удалить?')) return; await db.from('products').delete().eq('id', id); await loadData(); switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]); }
async function adminDeleteReview(id) { if (!confirm('Удалить?')) return; await db.from('reviews').delete().eq('id', id); await loadData(); switchAdminTab('reviews', document.querySelectorAll('.admin-tab')[2]); }

// === ВСПОМОГАТЕЛЬНЫЕ ===
function addToCart(id) { const p = products.find(x => x.id === id); if (!p) return; const size = selectedSizes[id] || p.sizes[0]; const existing = cart.find(c => c.id === id && c.size === size); if (existing) existing.qty++; else cart.push({ id, size, qty: 1 }); save('fs_cart', cart); updateCounts(); renderProducts(); if (tg) tg.HapticFeedback?.impactOccurred('medium'); }
function changeQty(index, delta) { cart[index].qty += delta; if (cart[index].qty <= 0) cart.splice(index, 1); save('fs_cart', cart); updateCounts(); renderCart(); renderProducts(); }
function removeCartItem(index) { cart.splice(index, 1); save('fs_cart', cart); updateCounts(); renderCart(); renderProducts(); }
function openCart() { renderCart(); openModal('cartModal'); }
function renderCart() {
    const body = document.getElementById('cartBody'); const footer = document.getElementById('cartFooter');
    if (!cart.length) { body.innerHTML = '<p class="empty">Корзина пуста 🛒</p>'; footer.innerHTML = ''; return; }
    let total = 0;
    body.innerHTML = cart.map((c, i) => {
        const p = products.find(x => x.id === c.id); if (!p) return '';
        total += p.price * c.qty;
        const imgContent = p.image ? `<img src="${p.image}" alt="">` : p.emoji;
        return `<div class="cart-item"><div class="cart-item-img">${imgContent}</div><div class="cart-item-info"><div class="cart-item-name">${p.name}</div><div style="font-size:11px;color:var(--hint)">Размер: ${c.size}</div><div class="cart-item-price">${formatPrice(p.price * c.qty)}</div><div class="qty-controls"><button data-qty-dec="${i}">−</button><span>${c.qty}</span><button data-qty-inc="${i}">+</button><button style="margin-left:auto;background:var(--danger);color:white" data-qty-del="${i}">🗑</button></div></div></div>`;
    }).join('');
    footer.innerHTML = `<div class="cart-total"><span>Итого:</span><span>${formatPrice(total)}</span></div><div class="cart-actions"><button class="btn-primary" id="checkoutBtn">📦 Оформить заказ</button></div>`;
    document.querySelectorAll('[data-qty-dec]').forEach(b => b.addEventListener('click', () => changeQty(+b.dataset.qtyDec, -1)));
    document.querySelectorAll('[data-qty-inc]').forEach(b => b.addEventListener('click', () => changeQty(+b.dataset.qtyInc, 1)));
    document.querySelectorAll('[data-qty-del]').forEach(b => b.addEventListener('click', () => removeCartItem(+b.dataset.qtyDel)));
    document.getElementById('checkoutBtn').addEventListener('click', checkout);
}
function toggleFavorite(id) { const i = favorites.indexOf(id); if (i >= 0) favorites.splice(i, 1); else favorites.push(id); save('fs_favorites', favorites); updateCounts(); renderProducts(); if (tg) tg.HapticFeedback?.selectionChanged(); }
function openFavorites() {
    const body = document.getElementById('favoritesBody');
    if (!favorites.length) { body.innerHTML = '<p class="empty">В избранном пусто 🤍</p>'; } else {
        body.innerHTML = favorites.map(id => { const p = products.find(x => x.id === id); if (!p) return ''; const imgContent = p.image ? `<img src="${p.image}" alt="">` : p.emoji; return `<div class="cart-item"><div class="cart-item-img" data-open-product="${p.id}">${imgContent}</div><div class="cart-item-info" data-open-product="${p.id}"><div class="cart-item-name">${p.name}</div><div class="cart-item-price">${formatPrice(p.price)}</div></div><button class="admin-del" data-unfav="${id}">✕</button></div>`; }).join('');
        document.querySelectorAll('#favoritesBody [data-open-product]').forEach(el => el.addEventListener('click', () => { closeModal('favoritesModal'); openProduct(+el.dataset.openProduct); }));
        document.querySelectorAll('#favoritesBody [data-unfav]').forEach(el => el.addEventListener('click', () => { toggleFavorite(+el.dataset.unfav); openFavorites(); }));
    }
    openModal('favoritesModal');
}
function openReviews() { const body = document.getElementById('reviewsBody'); body.innerHTML = reviews.length ? reviews.slice().reverse().map(r => `<div class="review-card"><div class="review-header"><span class="review-author">${r.author}</span><span class="review-stars">${'★'.repeat(r.stars)}</span></div><div class="review-text">${r.text}</div></div>`).join('') : '<p class="empty">Отзывов нет</p>'; openModal('reviewsModal'); }
async function submitReview(productId) { const author = document.getElementById('revName').value.trim(); const stars = +document.getElementById('revStars').value; const text = document.getElementById('revText').value.trim(); if (!author || !text) { alert('Заполни имя и текст'); return; } await db.from('reviews').insert([{ product_id: productId, author, stars, text, date: new Date().toLocaleDateString('ru-RU') }]); await loadData(); openProduct(productId); }
async function openOrders() { const body = document.getElementById('ordersBody'); const { data } = await db.from('orders').select('*').eq('user_id', currentUser.id).order('id', { ascending: false }); body.innerHTML = data?.length ? data.map(o => `<div class="order-card"><div class="order-header"><span class="order-id">${o.order_code}</span><span class="order-status">${statusLabel(o.status)}</span></div><div class="order-items">${o.items.map(i => `${i.name} (${i.size})`).join(', ')}</div><div class="order-total">${formatPrice(o.total)}</div></div>`).join('') : '<p class="empty">Нет заказов</p>'; openModal('ordersModal'); }
function statusLabel(s) { return { new: 'В обработке', processing: 'Собирается', shipped: 'В пути', delivered: 'Доставлен', rejected: 'Отменен' }[s] || s; }
function updateCounts() { document.getElementById('cartCount').textContent = cart.reduce((s, c) => s + c.qty, 0) || ''; document.getElementById('favCount').textContent = favorites.length || ''; }
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openManagerChat(msg) { if (!msg || !msg.trim()) return; const url = `https://t.me/${MANAGER_USERNAME}?text=${encodeURIComponent(msg + '\u200B'.repeat(3))}`; if (tg && tg.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank'); }

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('fileInput').addEventListener('change', handleImageUpload); // Слушаем выбор файла
    
    document.getElementById('searchInput').addEventListener('input', (e) => { searchQuery = e.target.value; renderProducts(); });
    document.getElementById('sortSelect').addEventListener('change', (e) => { sortMode = e.target.value; renderProducts(); });
    document.getElementById('btnFav').addEventListener('click', openFavorites);
    document.getElementById('btnCart').addEventListener('click', openCart);
    document.getElementById('btnContact').addEventListener('click', () => openManagerChat('Здравствуйте! Хочу задать вопрос.'));
    document.getElementById('navHome').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    document.getElementById('navOrders').addEventListener('click', openOrders);
    document.getElementById('navReviews').addEventListener('click', openReviews);
    document.getElementById('navAdmin').addEventListener('click', openAdmin);
    document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }));
    document.querySelectorAll('.admin-tab').forEach(btn => btn.addEventListener('click', () => switchAdminTab(btn.dataset.tab, btn)));
    if (isAdmin()) document.getElementById('navAdmin').style.display = 'flex';
    loadData(); updateCounts(); checkAbandonedCart();
});