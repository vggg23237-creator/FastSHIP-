console.log('SCRIPT LOADED', new Date().toISOString());

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const MANAGER_USERNAME = 'FastSHIPmanager';
const ADMIN_IDS = [7866142145, 9009257713];
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
let subcategories = [];
let reviewCategories = [];
let reviewSubcategories = [];
let cart = load('fs_cart', []);
let favorites = load('fs_favorites', []);
let orders = [];
let currentCategory = 'all';
let currentSubcategory = 'all';
let searchQuery = '';
let sortMode = 'default';
let selectedSizes = {};
let adminOrderFilter = 'active';
let uploadedImages = [];

function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function formatPrice(p) { return Number(p).toLocaleString('ru-RU') + ' ₽'; }
function isAdmin() { return currentUser && ADMIN_IDS.includes(currentUser.id); }

function stockStatus(p) {
    if (!p.isAvailable) return { label: 'Нет в наличии', cls: 'out', canBuy: false };
    if (p.stock > 0) return { label: `В наличии: ${p.stock} шт.`, cls: 'in', canBuy: true };
    if (p.onOrder) return { label: 'Под заказ', cls: 'order', canBuy: true };
    return { label: 'Нет в наличии', cls: 'out', canBuy: false };
}

function productImages(p) {
    if (Array.isArray(p.images) && p.images.length) return p.images.filter(Boolean);
    if (p.image) return [p.image];
    return [];
}

async function loadData() {
    document.getElementById('productsGrid').innerHTML = '<p class="empty" style="grid-column:1/-1">Загрузка...</p>';

    const { data: c, error: ce } = await db.from('categories').select('*').order('id');
    if (ce) console.error('categories error:', ce);
    categories = c || [{ name: 'Все', slug: 'all' }];
    if (!categories.some(x => x.slug === 'all')) categories.unshift({ id: 0, name: 'Все', slug: 'all' });
    renderCategories();

    const { data: sc, error: sce } = await db.from('subcategories').select('*').eq('is_active', true).order('id');
    if (sce) console.error('subcategories error:', sce);
    subcategories = sc || [];

    const { data: p, error: pe } = await db.from('products').select('*').order('id');
    if (pe) console.error('products error:', pe);
    if (p) products = p.map(x => {
        let imgs = [];
        if (Array.isArray(x.images)) imgs = x.images;
        else if (typeof x.images === 'string') { try { imgs = JSON.parse(x.images); } catch {} }
        if ((!imgs || !imgs.length) && x.image) imgs = [x.image];
        return {
            id: x.id, name: x.name, price: x.price, oldPrice: x.old_price,
            category: x.category, subcategory: x.subcategory,
            emoji: x.emoji, image: x.image, images: imgs, badge: x.badge,
            sizes: x.sizes || ['S','M','L','XL'], description: x.description || '',
            stock: x.stock ?? 0,
            isAvailable: x.is_available ?? true,
            onOrder: x.on_order ?? false,
            warehouse: x.warehouse || ''
        };
    });

    const { data: r, error: re } = await db.from('reviews').select('*').order('id', { ascending: false });
    if (re) console.error('reviews error:', re);
    if (r) reviews = r.map(x => ({
        id: x.id, productId: x.product_id, orderCode: x.order_code, userId: x.user_id,
        categoryId: x.category_id, subcategoryId: x.subcategory_id,
        author: x.author, stars: x.stars, text: x.text, date: x.date,
        status: x.status || 'pending'
    }));

    const { data: rc } = await db.from('review_categories').select('*').eq('is_active', true).order('id');
    reviewCategories = rc || [];
    const { data: rsc } = await db.from('review_subcategories').select('*').eq('is_active', true).order('id');
    reviewSubcategories = rsc || [];

    if (isAdmin()) {
        const { data: o } = await db.from('orders').select('*').order('id', { ascending: false });
        if (o) orders = o.map(x => ({
            id: x.order_code, items: x.items, total: x.total, status: x.status, date: x.date,
            address: x.address, phone: x.phone, tracking: x.tracking_number,
            user: { id: x.user_id, name: x.user_name, username: x.user_username }
        }));
    }
    renderProducts(); updateCounts();
}

function checkAbandonedCart() {
    if (cart.length > 0 && !sessionStorage.getItem('cart_notified')) {
        setTimeout(() => {
            if (confirm(`У вас в корзине ${cart.reduce((s,c)=>s+c.qty,0)} товар(ов). Перейти к оформлению?`)) openCart();
            sessionStorage.setItem('cart_notified', 'true');
        }, 1500);
    }
}

async function handleImagesSelect(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    if (tg) tg.showAlert('Загружаем фото...');
    for (const file of files) {
        try {
            const compressed = await imageCompression(file, { maxSizeMB: 0.5, maxWidthOrHeight: 800, useWebWorker: true });
            const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
            const { error } = await db.storage.from('images').upload(fileName, compressed, { contentType: 'image/jpeg' });
            if (error) throw error;
            const { data: urlData } = db.storage.from('images').getPublicUrl(fileName);
            uploadedImages.push(urlData.publicUrl);
        } catch (err) {
            console.error('Ошибка загрузки:', err);
        }
    }
    renderUploadedPhotos();
    event.target.value = '';
    if (tg) tg.HapticFeedback?.notificationOccurred('success');
}

function renderUploadedPhotos() {
    const box = document.getElementById('uploadedPhotos');
    if (!box) return;
    if (!uploadedImages.length) { box.innerHTML = ''; return; }
    box.innerHTML = uploadedImages.map((url, i) => `
        <div class="uploaded-photo">
            <img src="${url}" alt="">
            <button type="button" class="remove-photo" data-remove-photo="${i}">✕</button>
        </div>
    `).join('');
    box.querySelectorAll('[data-remove-photo]').forEach(b => b.addEventListener('click', () => {
        uploadedImages.splice(+b.dataset.removePhoto, 1);
        renderUploadedPhotos();
    }));
}

function renderCategories() {
    const container = document.getElementById('categories');
    container.innerHTML = categories.map(c =>
        `<button class="category ${currentCategory === c.slug ? 'active' : ''}" data-cat="${c.slug}">${c.name}</button>`
    ).join('');
    container.querySelectorAll('.category').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.category').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCategory = btn.dataset.cat;
            currentSubcategory = 'all';
            renderSubcategories();
            renderProducts();
        });
    });
    renderSubcategories();
}

function renderSubcategories() {
    let container = document.getElementById('subcategories');
    if (!container) {
        container = document.createElement('div');
        container.id = 'subcategories';
        container.className = 'categories';
        container.style.marginTop = '-6px';
        document.getElementById('categories').insertAdjacentElement('afterend', container);
    }
    if (currentCategory === 'all') { container.innerHTML = ''; return; }
    const cat = categories.find(c => c.slug === currentCategory);
    const subs = subcategories.filter(s => Number(s.category_id) === Number(cat?.id));
    if (!subs.length) { container.innerHTML = ''; return; }
    container.innerHTML =
        `<button class="category ${currentSubcategory==='all'?'active':''}" data-sub="all">Все</button>` +
        subs.map(s => `<button class="category ${currentSubcategory===s.slug?'active':''}" data-sub="${s.slug}">${s.name}</button>`).join('');
    container.querySelectorAll('.category').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.category').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentSubcategory = btn.dataset.sub;
            renderProducts();
        });
    });
}

function renderProducts() {
    const grid = document.getElementById('productsGrid');
    let filtered = products.filter(p =>
        (currentCategory === 'all' || p.category === currentCategory) &&
        (currentSubcategory === 'all' || p.subcategory === currentSubcategory) &&
        p.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    if (sortMode === 'price-asc') filtered.sort((a, b) => a.price - b.price);
    else if (sortMode === 'price-desc') filtered.sort((a, b) => b.price - a.price);
    else if (sortMode === 'discount') filtered.sort((a, b) => {
        const da = a.oldPrice ? (a.oldPrice - a.price) : 0;
        const db_ = b.oldPrice ? (b.oldPrice - b.price) : 0;
        return db_ - da;
    });

    if (!filtered.length) { grid.innerHTML = `<p class="empty" style="grid-column:1/-1">Ничего не найдено 😕</p>`; return; }

    grid.innerHTML = filtered.map(p => {
        const isFav = favorites.includes(p.id);
        const st = stockStatus(p);
        const imgs = productImages(p);
        const pReviews = reviews.filter(r => r.productId === p.id && r.status === 'approved');
        const avg = pReviews.length ? (pReviews.reduce((s, r) => s + r.stars, 0) / pReviews.length).toFixed(1) : null;
        const rating = avg ? `⭐ ${avg} (${pReviews.length})` : '⭐ Нет отзывов';
        const imgContent = imgs.length ? `<img src="${imgs[0]}" alt="${p.name}" loading="lazy">` : p.emoji;
        const inCartCount = cart.filter(c => c.id === p.id).reduce((sum, c) => sum + c.qty, 0);
        const cartActionHTML = inCartCount > 0 ? `
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
                ${imgs.length > 1 ? `<span class="photos-count">📷 ${imgs.length}</span>` : ''}
                ${imgContent}
            </div>
            <div class="product-info">
                <div class="product-name" data-open-product="${p.id}">${p.name}</div>
                <div class="product-rating">${rating}</div>
                <div class="product-price">${formatPrice(p.price)}</div>
                <div class="stock-status ${st.cls}">${st.label}${p.warehouse?' · 📦 '+p.warehouse:''}</div>
                <div class="product-actions">
                    ${st.canBuy ? cartActionHTML : `<button class="buy-btn" disabled style="opacity:.5">Нет в наличии</button>`}
                    ${st.canBuy ? `<button class="buy-now-btn" data-buy-now="${p.id}">⚡ Купить</button>` : ''}
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
        const p = products.find(x => x.id === productId);
        const newQty = cart[idx].qty + delta;
        if (p && p.stock > 0 && newQty > p.stock) {
            if (tg) tg.showAlert('Больше нет на складе'); else alert('Больше нет на складе');
            return;
        }
        cart[idx].qty = newQty;
        if (cart[idx].qty <= 0) cart.splice(idx, 1);
        save('fs_cart', cart); updateCounts(); renderProducts();
    }
}

function openProduct(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    selectedSizes[id] = selectedSizes[id] || (p.sizes && p.sizes[0]) || 'One Size';
    const isFav = favorites.includes(p.id);
    const st = stockStatus(p);
    const imgs = productImages(p);
    const pReviews = reviews.filter(r => r.productId === id && r.status === 'approved');
    const avg = pReviews.length ? (pReviews.reduce((s, r) => s + r.stars, 0) / pReviews.length).toFixed(1) : null;

    // Галерея
    let galleryHTML = '';
    if (imgs.length > 0) {
        galleryHTML = `
        <div class="gallery" id="gallery">
            <div class="gallery-track" id="galleryTrack">
                ${imgs.map(u => `<div class="gallery-slide"><img src="${u}" alt="${p.name}"></div>`).join('')}
            </div>
            ${imgs.length > 1 ? `
                <button class="gallery-arrow prev" id="galleryPrev">‹</button>
                <button class="gallery-arrow next" id="galleryNext">›</button>
                <div class="gallery-dots" id="galleryDots">${imgs.map((_,i) => `<span class="gallery-dot ${i===0?'active':''}" data-dot="${i}"></span>`).join('')}</div>
            ` : ''}
        </div>`;
    } else {
        galleryHTML = `<div class="product-detail-image" style="display:flex; align-items:center; justify-content:center; font-size:100px;">${p.emoji || '📦'}</div>`;
    }

    // Описание
    const descHTML = (p.description && p.description.trim()) 
        ? `<p style="font-size:14px;line-height:1.4;color:var(--text);padding:10px;background:rgba(0,0,0,0.03);border-radius:8px;">${p.description}</p>` 
        : '';

    // Размеры (скрываем, если пусто)
    const sizesHTML = (p.sizes && p.sizes.length > 0)
        ? `<div>
            <p style="font-size:13px;color:var(--hint);margin-bottom:8px">Выберите размер:</p>
            <div class="sizes" id="sizesContainer">${p.sizes.map(s => `<button class="size-btn ${selectedSizes[id]===s?'selected':''}" data-size="${s}">${s}</button>`).join('')}</div>
           </div>`
        : '';

    // Блок действий
    let actionsHTML = '';
    if (st.canBuy) {
        actionsHTML = `
            <div class="detail-actions" style="display:flex; gap:8px; align-items:center; margin-top:4px;">
                <button class="btn-secondary" id="detailFavBtn" style="flex:0 0 auto; width:48px; height:48px; display:flex; align-items:center; justify-content:center; font-size:20px; padding:0;">${isFav?'❤️':'🤍'}</button>
                <button class="btn-secondary" id="shareBtn" style="flex:0 0 auto; width:48px; height:48px; display:flex; align-items:center; justify-content:center; font-size:18px; padding:0;">📤</button>
                <button class="btn-primary" id="detailCartBtn" style="flex:1; height:48px;">В корзину</button>
            </div>
            <button class="detail-buy-now" id="detailBuyNowBtn" style="margin-top:8px; height:50px;">⚡ Купить сейчас</button>`;
    } else {
        actionsHTML = `
            <div style="color:var(--danger); font-weight:600; text-align:center; padding:8px 0; font-size:15px;">Нет в наличии</div>
            <div class="detail-actions" style="display:flex; gap:8px; align-items:center; justify-content:center;">
                <button class="btn-secondary" id="detailFavBtn" style="flex:0 0 auto; padding:12px 20px; height:48px;">${isFav?'❤️ В избранном':'🤍 В избранное'}</button>
                <button class="btn-secondary" id="shareBtn" style="flex:0 0 auto; padding:12px 20px; height:48px;">📤 Поделиться</button>
            </div>`;
    }

    const similar = products.filter(x => x.category === p.category && x.id !== p.id).slice(0, 4);
    const similarHTML = similar.length ? `
        <div class="reviews-section">
            <h3>Похожие товары</h3>
            <div style="display: flex; gap: 8px; overflow-x: auto; padding-bottom: 10px;">
                ${similar.map(s => {
                    const sImg = productImages(s)[0];
                    return `<div style="min-width: 100px; width: 100px;" data-open-product="${s.id}">
                        <div style="width:100%; aspect-ratio:1; border-radius:10px; background:var(--card); display:flex; align-items:center; justify-content:center; overflow:hidden; margin-bottom:4px;">${sImg?`<img src="${sImg}" style="width:100%;height:100%;object-fit:cover;">`:s.emoji}</div>
                        <div style="font-size:11px; font-weight:600; line-height:1.2; height:26px; overflow:hidden;">${s.name}</div>
                        <div style="font-size:12px; color:var(--accent); font-weight:bold;">${formatPrice(s.price)}</div>
                    </div>`;
                }).join('')}
            </div>
        </div>` : '';

    const reviewsHTML = pReviews.length
        ? pReviews.map(r => `<div class="review-card"><div class="review-header"><span class="review-author">${r.author}</span><span class="review-stars">${'★'.repeat(r.stars)}</span></div><div class="review-text">${r.text}</div><div class="review-date">${r.date}</div></div>`).join('')
        : '<p class="empty" style="padding:10px 0">Пока нет отзывов</p>';

    document.getElementById('productModalBody').innerHTML = `
        <div class="product-detail" style="display:flex; flex-direction:column; gap:12px;">
            ${galleryHTML}
            <div>
                <h2 style="font-size:18px; font-weight:600; margin-bottom:4px;">${p.name}</h2>
                <div class="price-row" style="display:flex; align-items:baseline; gap:10px;">
                    <span class="price" style="font-size:22px; font-weight:bold; color:var(--accent);">${formatPrice(p.price)}</span>
                    ${p.oldPrice ? `<span class="old-price" style="font-size:14px; color:var(--hint); text-decoration:line-through;">${formatPrice(p.oldPrice)}</span>` : ''}
                </div>
                <div class="stock-status ${st.cls}" style="margin-top:6px; font-size:13px; font-weight:600;">${st.label}${p.warehouse ? ' · 📦 '+p.warehouse : ''}</div>
                ${avg ? `<div style="color:#ffcc00; margin-top:4px; font-size:13px;">⭐ ${avg} · ${pReviews.length} отзывов</div>` : ''}
            </div>
            
            ${descHTML}
            ${sizesHTML}
            ${actionsHTML}
            ${similarHTML}
            
            <div class="reviews-section" style="margin-top:16px;">
                <h3 style="font-size:15px; margin-bottom:10px;">⭐ Отзывы (${pReviews.length})</h3>
                <div>${reviewsHTML}</div>
            </div>
        </div>`;

    // Галерея логика
    const gallery = document.getElementById('gallery');
    const track = document.getElementById('galleryTrack');
    const dots = document.querySelectorAll('#galleryDots [data-dot]');
    let galleryIndex = 0;
    function updateGallery() {
        if (!track) return;
        track.style.transform = `translateX(-${galleryIndex * 100}%)`;
        dots.forEach((d, i) => d.classList.toggle('active', i === galleryIndex));
    }
    if (gallery && imgs.length > 1) {
        document.getElementById('galleryPrev').addEventListener('click', () => {
            galleryIndex = (galleryIndex - 1 + imgs.length) % imgs.length;
            updateGallery();
        });
        document.getElementById('galleryNext').addEventListener('click', () => {
            galleryIndex = (galleryIndex + 1) % imgs.length;
            updateGallery();
        });
        dots.forEach(d => d.addEventListener('click', () => {
            galleryIndex = +d.dataset.dot;
            updateGallery();
        }));
        let startX = 0;
        gallery.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
        gallery.addEventListener('touchend', e => {
            const dx = e.changedTouches[0].clientX - startX;
            if (Math.abs(dx) > 40) {
                galleryIndex = dx > 0
                    ? (galleryIndex - 1 + imgs.length) % imgs.length
                    : (galleryIndex + 1) % imgs.length;
                updateGallery();
            }
        }, { passive: true });
    }

    // Обработчики
    if (sizesHTML) {
        document.querySelectorAll('#sizesContainer .size-btn').forEach(btn => btn.addEventListener('click', () => {
            selectedSizes[id] = btn.dataset.size;
            document.querySelectorAll('#sizesContainer .size-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        }));
    }
    document.getElementById('shareBtn').addEventListener('click', () => {
        const shareUrl = `https://t.me/share/url?url=https://t.me/${MANAGER_USERNAME}&text=Смотри: ${p.name} за ${formatPrice(p.price)}!`;
        if (tg) tg.openTelegramLink(shareUrl); else window.open(shareUrl, '_blank');
    });
    document.getElementById('detailFavBtn').addEventListener('click', () => { toggleFavorite(id); openProduct(id); });
    
    if (st.canBuy) {
        document.getElementById('detailCartBtn').addEventListener('click', () => { addToCart(id); closeModal('productModal'); });
        document.getElementById('detailBuyNowBtn').addEventListener('click', () => buyNow(id));
    }
    
    document.querySelectorAll('.product-detail [data-open-product]').forEach(el => el.addEventListener('click', () => { closeModal('productModal'); openProduct(+el.dataset.openProduct); }));
    openModal('productModal');
}

function showCheckoutForm(items, total, orderId) {
    document.getElementById('productModalBody').innerHTML = `
        <div class="product-detail" style="display:flex; flex-direction:column; gap:12px;">
            <h2 style="font-size:18px; font-weight:600; margin-bottom:4px;">Оформление заказа</h2>
            <p style="color:var(--hint); margin-bottom:16px;">Заполните данные для доставки.</p>
            <div class="review-form">
                <input id="checkoutName" placeholder="Ваше Имя" value="${currentUser?.name || ''}">
                <input id="checkoutPhone" type="tel" placeholder="Номер телефона">
                <input id="checkoutAddress" placeholder="Город, адрес или Пункт выдачи">
            </div>
            <div class="cart-total" style="display:flex; justify-content:space-between; font-size:16px; font-weight:bold; padding:14px 0; border-top:1px solid rgba(0,0,0,0.06); margin-bottom:16px;">
                <span>К оплате:</span><span>${formatPrice(total)}</span>
            </div>
            <button class="btn-primary" id="confirmCheckoutBtn" style="width:100%; padding:16px; border-radius:12px; border:none; font-size:16px; font-weight:bold; margin-bottom:10px;">Подтвердить заказ</button>
            <button class="btn-secondary" id="cancelCheckoutBtn" style="width:100%; padding:14px; border-radius:12px; border:none;">Отмена</button>
        </div>`;
    openModal('productModal');

    document.getElementById('cancelCheckoutBtn').addEventListener('click', () => closeModal('productModal'));
    document.getElementById('confirmCheckoutBtn').addEventListener('click', async () => {
        const name = document.getElementById('checkoutName').value.trim();
        const phone = document.getElementById('checkoutPhone').value.trim();
        const address = document.getElementById('checkoutAddress').value.trim();
        if (!name || !phone || !address) { alert('Пожалуйста, заполните все поля!'); return; }

        await db.from('orders').insert([{
            order_code: orderId, items, total, status: 'new',
            date: new Date().toLocaleString('ru-RU'),
            user_id: currentUser?.id, user_name: name, user_username: currentUser?.username,
            phone, address
        }]);

        for (const it of items) {
            if (!it.id) continue;
            const prod = products.find(x => x.id === it.id);
            if (prod && prod.stock > 0) {
                await db.from('products').update({ stock: Math.max(0, prod.stock - it.qty) }).eq('id', it.id);
            }
        }

        if (isAdmin()) await loadData();
        const msg = `Здравствуйте! Хочу сделать заказ в FastSHIP.\n\n🛒 Заказ: ${orderId}\n📦 Товары:\n${items.map(i => `• ${i.name} (${i.size}) × ${i.qty} — ${formatPrice(i.price * i.qty)}`).join('\n')}\n\n💰 Итого: ${formatPrice(total)}\n\n👤 Клиент: ${name}\n📞 Тел: ${phone}\n🏠 Адрес: ${address}\n🔗 TG: ${currentUser?.username || '—'}`;
        cart = []; save('fs_cart', cart); updateCounts(); closeModal('productModal'); renderProducts();
        if (tg) tg.HapticFeedback?.notificationOccurred('success');
        openManagerChat(msg);
    });
}

async function buyNow(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const st = stockStatus(p);
    if (!st.canBuy) { alert('Товар недоступен'); return; }
    const items = [{ id: p.id, name: p.name, size: selectedSizes[id] || p.sizes[0], qty: 1, price: p.price }];
    showCheckoutForm(items, p.price, 'FS-' + Date.now().toString().slice(-6));
}

async function checkout() {
    if (!cart.length) return;
    const total = cart.reduce((s, c) => { const p = products.find(x => x.id === c.id); return s + (p ? p.price * c.qty : 0); }, 0);
    const items = cart.map(c => {
        const p = products.find(x => x.id === c.id);
        return { id: p.id, name: p.name, size: c.size, qty: c.qty, price: p.price };
    });
    closeModal('cartModal');
    showCheckoutForm(items, total, 'FS-' + Date.now().toString().slice(-6));
}

async function openAdmin() { if (!isAdmin()) return alert('Нет доступа'); await loadData(); switchAdminTab('orders', document.querySelector('.admin-tab')); openModal('adminModal'); }

async function switchAdminTab(tab, btn) {
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
    btn?.classList.add('active');
    const body = document.getElementById('adminBody');

    if (tab === 'orders') {
        const totalSum = orders.filter(o => o.status !== 'rejected').reduce((s, o) => s + o.total, 0);
        const avgCheck = orders.filter(o => o.status !== 'rejected').length ? Math.round(totalSum / orders.filter(o => o.status !== 'rejected').length) : 0;

        let filteredOrders = orders;
        if (adminOrderFilter === 'active') filteredOrders = orders.filter(o => o.status !== 'archived' && o.status !== 'rejected' && o.status !== 'delivered');
        else if (adminOrderFilter === 'archive') filteredOrders = orders.filter(o => o.status === 'archived' || o.status === 'rejected' || o.status === 'delivered');

        body.innerHTML = `
            <div style="background:var(--card); padding:12px; border-radius:12px; margin-bottom:16px; display:flex; justify-content:space-between; text-align:center;">
                <div><div style="font-size:11px;color:var(--hint)">Выручка</div><div style="font-weight:bold;color:var(--success)">${formatPrice(totalSum)}</div></div>
                <div><div style="font-size:11px;color:var(--hint)">Ср. чек</div><div style="font-weight:bold;">${formatPrice(avgCheck)}</div></div>
                <div><div style="font-size:11px;color:var(--hint)">Всего</div><div style="font-weight:bold;">${orders.length}</div></div>
            </div>
            <div style="display:flex; gap:8px; margin-bottom:12px;">
                <button class="size-btn ${adminOrderFilter==='active'?'selected':''}" data-filter="active" style="flex:1;font-size:11px;">Активные</button>
                <button class="size-btn ${adminOrderFilter==='archive'?'selected':''}" data-filter="archive" style="flex:1;font-size:11px;">Архив</button>
            </div>
            <div>${filteredOrders.map(o => {
                const isNew = o.status === 'new';
                const userInfo = o.user ? `<div style="font-size:12px;color:var(--hint);margin-bottom:6px">👤 ${o.user.name} (${o.user.username})<br>📞 ${o.phone || '—'}<br>🏠 ${o.address || '—'}</div>` : '';
                return `
                <div class="order-card">
                    <div class="order-header"><span class="order-id">${o.id}</span><span class="order-status">${statusLabel(o.status)}</span></div>
                    ${userInfo}
                    <div class="order-items">${o.items.map(i => `${i.name} (${i.size}) × ${i.qty}`).join('<br>')}</div>
                    <div class="order-total">${formatPrice(o.total)}</div>
                    ${isNew ? `
                    <div style="display:flex; gap:8px; margin-top:12px;">
                        <button class="btn-primary" style="flex:1; padding:10px; font-size:13px;" data-accept-order="${o.id}">✅ Принять</button>
                        <button class="btn-secondary" style="flex:1; padding:10px; font-size:13px; background:var(--danger); color:white;" data-reject-order="${o.id}">❌ Отклонить</button>
                    </div>` : `
                    <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
                        ${['processing','shipped','delivered'].map(s => `<button class="size-btn ${o.status===s?'selected':''}" data-set-status="${o.id}|${s}">${statusLabel(s)}</button>`).join('')}
                    </div>
                    <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                        <input type="text" id="track_${o.id}" placeholder="Трек-номер" value="${o.tracking || ''}" style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(0,0,0,0.1); font-size:12px;">
                        <button class="btn-secondary" style="padding:8px 12px; font-size:12px;" data-save-track="${o.id}">💾</button>
                        <button class="btn-secondary" style="padding:8px 12px; font-size:12px; background:#555; color:white;" data-archive-order="${o.id}">📦 В архив</button>
                    </div>
                    `}
                </div>`;
            }).join('')}</div>`;

        document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { adminOrderFilter = b.dataset.filter; switchAdminTab('orders', document.querySelector('.admin-tab')); }));
        document.querySelectorAll('[data-accept-order]').forEach(b => b.addEventListener('click', () => setOrderStatus(b.dataset.acceptOrder, 'processing')));
        document.querySelectorAll('[data-reject-order]').forEach(b => b.addEventListener('click', () => { if(confirm('Отклонить?')) setOrderStatus(b.dataset.rejectOrder, 'rejected'); }));
        document.querySelectorAll('[data-set-status]').forEach(b => b.addEventListener('click', () => { const [id, status] = b.dataset.setStatus.split('|'); setOrderStatus(id, status); }));
        document.querySelectorAll('[data-archive-order]').forEach(b => b.addEventListener('click', () => setOrderStatus(b.dataset.archiveOrder, 'archived')));
        document.querySelectorAll('[data-save-track]').forEach(b => b.addEventListener('click', () => {
            const id = b.dataset.saveTrack;
            const track = document.getElementById(`track_${id}`).value.trim();
            saveTracking(id, track);
        }));
    }

    if (tab === 'products') {
        uploadedImages = [];
        const catOptions = categories.filter(c => c.slug !== 'all').map(c => `<option value="${c.slug}">${c.name}</option>`).join('');
        body.innerHTML = `
            <div class="admin-form">
                <input id="newName" placeholder="Название товара">
                <input id="newPrice" type="number" placeholder="Цена (₽)">
                <input id="newOldPrice" type="number" placeholder="Старая цена (для скидки, необязательно)">
                <select id="newCategory">${catOptions}</select>
                <select id="newSubcategory"><option value="">— Без подкатегории —</option></select>
                <div style="display:flex;gap:8px;">
                    <input id="newStock" type="number" placeholder="Кол-во на складе" value="0" style="flex:1;">
                    <input id="newWarehouse" type="text" placeholder="Склад" style="flex:1;">
                </div>
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;">
                    <input id="newOnOrder" type="checkbox" style="width:auto;"> Под заказ
                </label>
                <div style="margin: 10px 0;">
                    <button type="button" id="uploadPhotoBtn" style="width:100%; padding:12px; border-radius:10px; border:1px dashed var(--accent); background:transparent; color:var(--accent); font-weight:bold;">📸 Загрузить фото (можно несколько)</button>
                    <div id="uploadedPhotos" class="uploaded-photos"></div>
                </div>
                <textarea id="newDescription" placeholder="Описание" rows="2"></textarea>
                <button id="addProductBtn">➕ Добавить товар</button>
            </div>

            <div style="margin-bottom:16px; border-top:1px solid rgba(0,0,0,0.1); padding-top:16px;">
                <div style="display:flex; gap:8px; margin-bottom:8px;">
                    <input id="newCatName" placeholder="Новая категория..." style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(0,0,0,0.1);">
                    <button id="addCatBtn" style="padding:10px; border:none; border-radius:10px; background:var(--success); color:white;">+</button>
                </div>
                <div style="display:flex; gap:8px; margin-bottom:12px;">
                    <select id="subCatParent" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(0,0,0,0.1);">${catOptions}</select>
                    <input id="newSubCatName" placeholder="Подкатегория..." style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(0,0,0,0.1);">
                    <button id="addSubCatBtn" style="padding:10px; border:none; border-radius:10px; background:var(--success); color:white;">+</button>
                </div>
                <h4 style="font-size:13px;margin-bottom:6px;">Категории и подкатегории:</h4>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    ${categories.filter(c => c.slug !== 'all').map(c => `
                        <div class="admin-item" style="flex-direction:column;align-items:stretch;">
                            <div style="display:flex;align-items:center;justify-content:space-between;">
                                <b style="font-size:13px;">${c.name}</b>
                                <button class="admin-del" data-del-cat="${c.id}">🗑</button>
                            </div>
                            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">
                                ${subcategories.filter(s => Number(s.category_id) === Number(c.id)).map(s => `
                                    <span style="display:inline-flex;align-items:center;gap:4px;background:var(--card);padding:4px 8px;border-radius:8px;font-size:11px;">
                                        ${s.name}
                                        <button data-del-subcat="${s.id}" style="background:transparent;border:none;color:var(--danger);font-size:14px;padding:0;line-height:1;">✕</button>
                                    </span>
                                `).join('') || '<span style="font-size:11px;color:var(--hint);">—</span>'}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div>${products.map(p => {
                const st = stockStatus(p);
                const imgs = productImages(p);
                const thumb = imgs[0] || null;
                return `<div class="admin-item" style="flex-direction:column;align-items:stretch;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                        <div style="display:flex;gap:8px;align-items:center;flex:1;min-width:0;">
                            <div style="width:40px;height:40px;border-radius:8px;background:var(--card);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:20px;">
                                ${thumb ? `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover;">` : p.emoji}
                            </div>
                            <div class="admin-item-info">
                                <b>${p.name}</b>
                                <span>${formatPrice(p.price)} · <span class="stock-status ${st.cls}">${st.label}</span>${p.warehouse?' · 📦 '+p.warehouse:''}${imgs.length>1?' · 📷'+imgs.length:''}</span>
                            </div>
                        </div>
                        <div style="display:flex;gap:4px;">
                            <button class="admin-del" style="background:var(--accent);" data-edit-product="${p.id}">✏️</button>
                            <button class="admin-del" data-del-product="${p.id}">🗑</button>
                        </div>
                    </div>
                    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;">
                        <input type="number" id="stock_${p.id}" value="${p.stock}" placeholder="Кол-во" style="width:70px;padding:8px;border-radius:8px;border:1px solid rgba(0,0,0,0.1);font-size:12px;">
                        <input type="text" id="wh_${p.id}" value="${p.warehouse || ''}" placeholder="Склад" style="flex:1;min-width:90px;padding:8px;border-radius:8px;border:1px solid rgba(0,0,0,0.1);font-size:12px;">
                        <label style="display:flex;align-items:center;gap:4px;font-size:12px;">
                            <input type="checkbox" id="avail_${p.id}" ${p.isAvailable?'checked':''}> В наличии
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:12px;">
                            <input type="checkbox" id="order_${p.id}" ${p.onOrder?'checked':''}> Под заказ
                        </label>
                        <button class="btn-primary" style="padding:8px 12px;font-size:12px;flex:0 0 auto;" data-save-stock="${p.id}">💾</button>
                    </div>
                </div>`;
            }).join('')}</div>`;

        document.getElementById('uploadPhotoBtn').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('addProductBtn').addEventListener('click', adminAddProduct);
        document.getElementById('addCatBtn').addEventListener('click', adminAddCategory);
        document.getElementById('addSubCatBtn').addEventListener('click', adminAddSubcategory);
        document.querySelectorAll('[data-del-product]').forEach(b => b.addEventListener('click', () => adminDeleteProduct(+b.dataset.delProduct)));
        document.querySelectorAll('[data-edit-product]').forEach(b => b.addEventListener('click', () => adminEditProduct(+b.dataset.editProduct)));
        document.querySelectorAll('[data-save-stock]').forEach(b => b.addEventListener('click', () => adminSaveStock(+b.dataset.saveStock)));
        document.querySelectorAll('[data-del-cat]').forEach(b => b.addEventListener('click', () => adminDeleteCategory(+b.dataset.delCat)));
        document.querySelectorAll('[data-del-subcat]').forEach(b => b.addEventListener('click', () => adminDeleteSubcategory(+b.dataset.delSubcat)));

        const newCatSel = document.getElementById('newCategory');
        const newSubSel = document.getElementById('newSubcategory');
        const fillSubs = () => {
            const cat = categories.find(c => c.slug === newCatSel.value);
            const subs = subcategories.filter(s => Number(s.category_id) === Number(cat?.id));
            newSubSel.innerHTML = '<option value="">— Без подкатегории —</option>' +
                subs.map(s => `<option value="${s.slug}">${s.name}</option>`).join('');
        };
        newCatSel.addEventListener('change', fillSubs);
        fillSubs();
    }

    if (tab === 'reviews') {
        const pending = reviews.filter(r => r.status === 'pending');
        const processed = reviews.filter(r => r.status !== 'pending');
        const renderCard = (r, withActions) => {
            const cat = reviewCategories.find(c => Number(c.id) === Number(r.categoryId))?.name || '—';
            const sub = reviewSubcategories.find(s => Number(s.id) === Number(r.subcategoryId))?.name || '—';
            const badge = r.status === 'approved' ? '✅ Одобрен' : r.status === 'rejected' ? '❌ Отклонён' : '⏳ На модерации';
            return `<div class="order-card">
                <div class="order-header"><span class="order-id">${r.author}</span><span class="order-status">${badge}</span></div>
                <div style="font-size:12px;color:var(--hint);margin-bottom:6px;">
                    📂 ${cat} / ${sub} · ⭐ ${'★'.repeat(r.stars)}<br>🧾 Заказ ${r.orderCode || '—'}
                </div>
                <div class="order-items">${r.text}</div>
                ${withActions ? `
                    <div style="display:flex;gap:8px;margin-top:10px;">
                        <button class="btn-primary" style="flex:1;padding:10px;font-size:13px;" data-approve="${r.id}">✅ Одобрить</button>
                        <button class="btn-secondary" style="flex:1;padding:10px;font-size:13px;background:var(--danger);color:white;" data-reject="${r.id}">❌ Отклонить</button>
                    </div>` : `<button class="admin-del" style="margin-top:8px;" data-del-review="${r.id}">🗑</button>`}
            </div>`;
        };
        body.innerHTML = `
            <h3 style="margin-bottom:8px;">На модерации (${pending.length})</h3>
            <div>${pending.length ? pending.map(r => renderCard(r, true)).join('') : '<p class="empty">Нет новых отзывов</p>'}</div>
            <h3 style="margin:16px 0 8px;">Обработанные</h3>
            <div>${processed.length ? processed.map(r => renderCard(r, false)).join('') : '<p class="empty">Пусто</p>'}</div>`;
        body.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => moderateReview(Number(b.dataset.approve), 'approved')));
        body.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => moderateReview(Number(b.dataset.reject), 'rejected')));
        body.querySelectorAll('[data-del-review]').forEach(b => b.addEventListener('click', () => adminDeleteReview(Number(b.dataset.delReview))));
    }
}

async function saveTracking(code, track) {
    await db.from('orders').update({ tracking_number: track }).eq('order_code', code);
    if (tg) tg.HapticFeedback?.notificationOccurred('success');
    alert('Трек-номер сохранен!');
}

async function adminAddProduct() {
    const name = document.getElementById('newName').value.trim();
    const price = +document.getElementById('newPrice').value;
    const oldPrice = +document.getElementById('newOldPrice').value || null;
    const category = document.getElementById('newCategory').value;
    const subcategory = document.getElementById('newSubcategory').value || null;
    const description = document.getElementById('newDescription').value.trim();
    const stock = +document.getElementById('newStock').value || 0;
    const warehouse = document.getElementById('newWarehouse').value.trim();
    const onOrder = document.getElementById('newOnOrder').checked;
    if (!name || !price) return alert('Заполни название и цену');
    await db.from('products').insert([{
        name, price, old_price: oldPrice, category, subcategory,
        images: uploadedImages,
        image: uploadedImages[0] || '',
        description, sizes: ['S','M','L','XL'],
        stock, warehouse, on_order: onOrder, is_available: true
    }]);
    uploadedImages = [];
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminSaveStock(id) {
    const stock = +document.getElementById(`stock_${id}`).value || 0;
    const warehouse = document.getElementById(`wh_${id}`).value.trim();
    const is_available = document.getElementById(`avail_${id}`).checked;
    const on_order = document.getElementById(`order_${id}`).checked;
    const { error } = await db.from('products').update({ stock, warehouse, is_available, on_order }).eq('id', id);
    if (error) return alert(error.message);
    tg?.HapticFeedback?.notificationOccurred('success');
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function setOrderStatus(code, status) {
    await db.from('orders').update({ status }).eq('order_code', code);
    await loadData();
    switchAdminTab('orders', document.querySelector('.admin-tab'));
}

async function adminAddCategory() {
    const name = document.getElementById('newCatName').value.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-zа-я0-9]/g, '-').replace(/-+/g, '-');
    const { error } = await db.from('categories').insert([{ name, slug }]);
    if (error) return alert('Ошибка: ' + error.message);
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminAddSubcategory() {
    const parentSlug = document.getElementById('subCatParent').value;
    const name = document.getElementById('newSubCatName').value.trim();
    if (!name) return;
    const cat = categories.find(c => c.slug === parentSlug);
    if (!cat) return alert('Выберите категорию');
    const slug = name.toLowerCase().replace(/[^a-zа-я0-9]/g, '-').replace(/-+/g, '-');
    const { error } = await db.from('subcategories').insert([{ category_id: cat.id, name, slug }]);
    if (error) return alert('Ошибка: ' + error.message);
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminDeleteCategory(id) {
    const cat = categories.find(c => Number(c.id) === Number(id));
    if (!cat) return;
    const cnt = products.filter(p => p.category === cat.slug).length;
    const msg = cnt > 0
        ? `Удалить категорию "${cat.name}"? В ней ${cnt} товар(ов) — они останутся без категории. Подкатегории удалятся.`
        : `Удалить категорию "${cat.name}" и её подкатегории?`;
    if (!confirm(msg)) return;
    const { error } = await db.from('categories').delete().eq('id', id);
    if (error) return alert('Ошибка: ' + error.message);
    tg?.HapticFeedback?.notificationOccurred('success');
    if (currentCategory === cat.slug) { currentCategory = 'all'; currentSubcategory = 'all'; }
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminDeleteSubcategory(id) {
    const sub = subcategories.find(s => Number(s.id) === Number(id));
    if (!sub) return;
    if (!confirm(`Удалить подкатегорию "${sub.name}"?`)) return;
    const { error } = await db.from('subcategories').delete().eq('id', id);
    if (error) return alert('Ошибка: ' + error.message);
    tg?.HapticFeedback?.notificationOccurred('success');
    if (currentSubcategory === sub.slug) currentSubcategory = 'all';
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminEditProduct(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const newName = prompt('Название:', p.name);
    if (newName === null) return;
    const newPrice = prompt('Цена:', p.price);
    if (newPrice === null) return;
    const newDesc = prompt('Описание:', p.description || '');
    if (newDesc === null) return;
    await db.from('products').update({ name: newName, price: +newPrice, description: newDesc }).eq('id', id);
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminDeleteProduct(id) {
    if (!confirm('Удалить?')) return;
    await db.from('products').delete().eq('id', id);
    await loadData();
    switchAdminTab('products', document.querySelectorAll('.admin-tab')[1]);
}

async function adminDeleteReview(id) {
    if (!confirm('Удалить?')) return;
    await db.from('reviews').delete().eq('id', id);
    await loadData();
    switchAdminTab('reviews', document.querySelectorAll('.admin-tab')[2]);
}

async function moderateReview(id, status) {
    const { error } = await db.from('reviews').update({ status }).eq('id', id);
    if (error) return alert(error.message);
    tg?.HapticFeedback?.notificationOccurred('success');
    await loadData();
    switchAdminTab('reviews', document.querySelectorAll('.admin-tab')[2]);
}

function addToCart(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const st = stockStatus(p);
    if (!st.canBuy) { if (tg) tg.showAlert('Товар недоступен'); else alert('Товар недоступен'); return; }
    if (p.stock > 0) {
        const inCart = cart.filter(c => c.id === id).reduce((s, c) => s + c.qty, 0);
        if (inCart >= p.stock) { if (tg) tg.showAlert('Больше нет на складе'); else alert('Больше нет на складе'); return; }
    }
    const size = selectedSizes[id] || (p.sizes && p.sizes[0]) || 'One Size';
    const existing = cart.find(c => c.id === id && c.size === size);
    if (existing) existing.qty++; else cart.push({ id, size, qty: 1 });
    save('fs_cart', cart); updateCounts(); renderProducts();
    if (tg) tg.HapticFeedback?.impactOccurred('medium');
}

function changeQty(index, delta) {
    const item = cart[index];
    const p = products.find(x => x.id === item.id);
    const newQty = item.qty + delta;
    if (p && p.stock > 0 && newQty > p.stock) {
        if (tg) tg.showAlert('Больше нет на складе'); else alert('Больше нет на складе');
        return;
    }
    item.qty = newQty;
    if (item.qty <= 0) cart.splice(index, 1);
    save('fs_cart', cart); updateCounts(); renderCart(); renderProducts();
}

function removeCartItem(index) { cart.splice(index, 1); save('fs_cart', cart); updateCounts(); renderCart(); renderProducts(); }
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
        const imgs = productImages(p);
        const imgContent = imgs.length ? `<img src="${imgs[0]}" alt="">` : p.emoji;
        return `<div class="cart-item"><div class="cart-item-img">${imgContent}</div><div class="cart-item-info"><div class="cart-item-name">${p.name}</div><div style="font-size:11px;color:var(--hint)">Размер: ${c.size}</div><div class="cart-item-price">${formatPrice(p.price * c.qty)}</div><div class="qty-controls"><button data-qty-dec="${i}">−</button><span>${c.qty}</span><button data-qty-inc="${i}">+</button><button style="margin-left:auto;background:var(--danger);color:white" data-qty-del="${i}">🗑</button></div></div></div>`;
    }).join('');
    footer.innerHTML = `<div class="cart-total"><span>Итого:</span><span>${formatPrice(total)}</span></div><div class="cart-actions"><button class="btn-primary" id="checkoutBtn">📦 Оформить заказ</button></div>`;
    document.querySelectorAll('[data-qty-dec]').forEach(b => b.addEventListener('click', () => changeQty(+b.dataset.qtyDec, -1)));
    document.querySelectorAll('[data-qty-inc]').forEach(b => b.addEventListener('click', () => changeQty(+b.dataset.qtyInc, 1)));
    document.querySelectorAll('[data-qty-del]').forEach(b => b.addEventListener('click', () => removeCartItem(+b.dataset.qtyDel)));
    document.getElementById('checkoutBtn').addEventListener('click', checkout);
}

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
            const imgs = productImages(p);
            const imgContent = imgs.length ? `<img src="${imgs[0]}" alt="">` : p.emoji;
            return `<div class="cart-item"><div class="cart-item-img" data-open-product="${p.id}">${imgContent}</div><div class="cart-item-info" data-open-product="${p.id}"><div class="cart-item-name">${p.name}</div><div class="cart-item-price">${formatPrice(p.price)}</div></div><button class="admin-del" data-unfav="${id}">✕</button></div>`;
        }).join('');
        document.querySelectorAll('#favoritesBody [data-open-product]').forEach(el => el.addEventListener('click', () => { closeModal('favoritesModal'); openProduct(+el.dataset.openProduct); }));
        document.querySelectorAll('#favoritesBody [data-unfav]').forEach(el => el.addEventListener('click', () => { toggleFavorite(+el.dataset.unfav); openFavorites(); }));
    }
    openModal('favoritesModal');
}

function openReviews() {
    const body = document.getElementById('reviewsBody');
    const approved = reviews.filter(r => r.status === 'approved');
    body.innerHTML = approved.length
        ? approved.map(r => `<div class="review-card"><div class="review-header"><span class="review-author">${r.author}</span><span class="review-stars">${'★'.repeat(r.stars)}</span></div><div class="review-text">${r.text}</div></div>`).join('')
        : '<p class="empty">Отзывов нет</p>';
    openModal('reviewsModal');
}

async function canLeaveReview(orderCode) {
    if (!currentUser) return { ok: false, reason: 'Откройте через Telegram' };
    const { data: order, error: oe } = await db.from('orders').select('*').eq('order_code', orderCode).maybeSingle();
    if (oe || !order) return { ok: false, reason: 'Заказ не найден' };
    if (Number(order.user_id) !== Number(currentUser.id)) return { ok: false, reason: 'Это не ваш заказ' };
    if (order.status !== 'delivered') return { ok: false, reason: 'Отзыв доступен только после получения заказа' };
    const { data: existing } = await db.from('reviews').select('id').eq('order_code', orderCode).limit(1);
    if (existing && existing.length) return { ok: false, reason: 'Вы уже оставили отзыв по этому заказу' };
    return { ok: true, order };
}

async function openOrders() {
    const body = document.getElementById('ordersBody');
    const { data } = await db.from('orders').select('*').eq('user_id', currentUser.id).neq('status', 'archived').order('id', { ascending: false });
    body.innerHTML = data?.length ? data.map(o => `
        <div class="order-card">
            <div class="order-header"><span class="order-id">${o.order_code}</span><span class="order-status">${statusLabel(o.status)}</span></div>
            <div class="order-items">${o.items.map(i => `${i.name} (${i.size})`).join(', ')}</div>
            <div class="order-total">${formatPrice(o.total)}</div>
            ${o.tracking_number ? `<div style="margin-top:8px; padding:8px; background:rgba(42,171,238,0.1); border-radius:8px; font-size:13px;">📦 Трек-номер: <b>${o.tracking_number}</b></div>` : ''}
            ${o.status === 'delivered' ? `<button class="btn-primary" style="width:100%;margin-top:10px;padding:10px;font-size:13px;" data-review-order="${o.order_code}">⭐ Оставить отзыв</button>` : ''}
        </div>`).join('') : '<p class="empty">Нет заказов</p>';
    body.querySelectorAll('[data-review-order]').forEach(b => b.addEventListener('click', () => openReviewForm(b.dataset.reviewOrder)));
    openModal('ordersModal');
}

async function openReviewForm(orderCode) {
    const check = await canLeaveReview(orderCode);
    if (!check.ok) return alert(check.reason);

    const catOptions = reviewCategories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    document.getElementById('productModalBody').innerHTML = `
        <div class="product-detail" style="display:flex; flex-direction:column; gap:12px;">
            <h2 style="font-size:18px; font-weight:600; margin-bottom:4px;">Отзыв по заказу ${orderCode}</h2>
            <p style="color:var(--hint);font-size:13px;margin-bottom:12px;">Отзыв появится в каталоге после проверки модератором.</p>
            <div class="review-form">
                <select id="revCategory"><option value="">— Категория —</option>${catOptions}</select>
                <select id="revSubcategory" disabled><option value="">— Подкатегория —</option></select>
                <select id="revStars">
                    <option value="5">★★★★★ Отлично</option>
                    <option value="4">★★★★☆ Хорошо</option>
                    <option value="3">★★★☆☆ Нормально</option>
                    <option value="2">★★☆☆☆ Плохо</option>
                    <option value="1">★☆☆☆☆ Ужасно</option>
                </select>
                <textarea id="revText" placeholder="Ваш отзыв" rows="4"></textarea>
            </div>
            <button class="btn-primary" id="submitReviewBtn" style="width:100%;padding:14px;border-radius:12px;border:none;font-weight:bold;margin-top:10px;">Отправить на модерацию</button>
        </div>`;
    closeModal('ordersModal');
    openModal('productModal');

    const catSel = document.getElementById('revCategory');
    const subSel = document.getElementById('revSubcategory');
    catSel.addEventListener('change', () => {
        const cid = Number(catSel.value);
        const subs = reviewSubcategories.filter(s => Number(s.category_id) === cid);
        subSel.innerHTML = '<option value="">— Подкатегория —</option>' + subs.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        subSel.disabled = !subs.length;
    });

    document.getElementById('submitReviewBtn').addEventListener('click', async () => {
        const categoryId = Number(catSel.value) || null;
        const subcategoryId = Number(subSel.value) || null;
        const stars = Number(document.getElementById('revStars').value);
        const text = document.getElementById('revText').value.trim();
        if (!categoryId) return alert('Выберите категорию');
        if (!text) return alert('Напишите текст отзыва');

        const productId = check.order.items?.[0]?.id || null;
        const { error } = await db.from('reviews').insert([{
            product_id: productId,
            order_code: orderCode,
            user_id: currentUser.id,
            category_id: categoryId,
            subcategory_id: subcategoryId,
            author: currentUser.name || 'Клиент',
            stars, text,
            status: 'pending',
            date: new Date().toLocaleDateString('ru-RU')
        }]);
        if (error) {
            if (error.code === '23505') alert('Вы уже оставили отзыв по этому заказу');
            else alert('Ошибка: ' + error.message);
            return;
        }
        tg?.HapticFeedback?.notificationOccurred('success');
        alert('Спасибо! Отзыв на модерации.');
        closeModal('productModal');
        await loadData();
    });
}

function statusLabel(s) { return { new: 'В обработке', processing: 'Собирается', shipped: 'В пути', delivered: 'Доставлен', rejected: 'Отменен', archived: 'Архив' }[s] || s; }
function updateCounts() { document.getElementById('cartCount').textContent = cart.reduce((s, c) => s + c.qty, 0) || ''; document.getElementById('favCount').textContent = favorites.length || ''; }
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openManagerChat(msg) { if (!msg || !msg.trim()) return; const url = `https://t.me/${MANAGER_USERNAME}?text=${encodeURIComponent(msg + '\u200B'.repeat(3))}`; if (tg && tg.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank'); }

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('fileInput').addEventListener('change', handleImagesSelect);
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