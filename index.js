const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const pendingCheckouts = new Map();

const ADMIN_PASS = process.env.ADMIN_PASSWORD || process.env.WEBHOOK_SECRET || 'admin123';

bot.telegram.setMyCommands([
  { command: 'start', description: 'Start and open the menu' },
  { command: 'menu', description: 'Open the main menu' },
  { command: 'products', description: 'Show products catalog' },
  { command: 'wallet', description: 'Open wallet' },
  { command: 'api', description: 'Open API access' }
]).catch(console.error);

// ==========================================
// NATIVE TELEGRAM COLORED BUTTON BUILDER
// styles: 'success' (Green), 'danger' (Red), 'primary' (Blue), null (Default Dark)
// ==========================================
function cBtn(text, callback_data, style = null, customEmojiId = null) {
  const btn = { text, callback_data };
  if (style) btn.style = style;
  if (customEmojiId && String(customEmojiId).trim() !== '') {
    btn.icon_custom_emoji_id = String(customEmojiId).trim();
  }
  return btn;
}

function uBtn(text, url, style = null, customEmojiId = null) {
  const btn = { text, url };
  if (style) btn.style = style;
  if (customEmojiId && String(customEmojiId).trim() !== '') {
    btn.icon_custom_emoji_id = String(customEmojiId).trim();
  }
  return btn;
}

function kbMarkup(inline_keyboard) {
  return { reply_markup: { inline_keyboard } };
}

// ==========================================
// SMART EMOJI & THEME HELPERS
// ==========================================
function getProductEmoji(productOrName = '', customEmoji = '') {
  if (customEmoji && customEmoji.trim() !== '') return customEmoji.trim() + ' ';
  const name = typeof productOrName === 'object' ? (productOrName.category || productOrName.name || '') : productOrName;
  if (typeof productOrName === 'object' && productOrName.emoji && productOrName.emoji.trim() !== '') {
    return productOrName.emoji.trim() + ' ';
  }

  const n = name.toLowerCase();
  if (/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(name.slice(0, 4))) return '';
  if (n.includes('gemini')) return '✨ ';
  if (n.includes('youtube') || n.includes('yt')) return '▶️ ';
  if (n.includes('spotify') || n.includes('deezer') || n.includes('music')) return '🎵 ';
  if (n.includes('capcut') || n.includes('alight')) return '🎬 ';
  if (n.includes('canva') || n.includes('figma') || n.includes('adobe') || n.includes('autodesk')) return '🎨 ';
  if (n.includes('vpn') || n.includes('nord') || n.includes('hma') || n.includes('surfshark') || n.includes('v2ray') || n.includes('proxy')) return '🛡️ ';
  if (n.includes('gmail') || n.includes('mail') || n.includes('outlook') || n.includes('microsoft')) return '📧 ';
  if (n.includes('claude') || n.includes('gpt') || n.includes('openai') || n.includes('codex') || n.includes('muse') || n.includes('replit') || n.includes('lovable') || n.includes('notion')) return '🤖 ';
  if (n.includes('telegram')) return '✈️ ';
  if (n.includes('netflix') || n.includes('prime') || n.includes('apple tv') || n.includes('shahid')) return '🍿 ';
  if (n.includes('duolingo') || n.includes('coursera') || n.includes('udemy') || n.includes('scribd') || n.includes('edu')) return '🎓 ';
  if (n.includes('elevenlabs') || n.includes('suno') || n.includes('wispr')) return '🎙️ ';
  return '💥 ';
}

async function renderScreen(ctx, text, keyboardObj, imageUrl = null, isEdit = true) {
  const extra = { parse_mode: 'HTML', ...keyboardObj };
  try {
    if (imageUrl && imageUrl.startsWith('http')) {
      if (isEdit && ctx.callbackQuery?.message) {
        await ctx.deleteMessage().catch(() => {});
      }
      return await ctx.replyWithPhoto(imageUrl, { caption: text, ...extra });
    } else {
      if (isEdit && ctx.callbackQuery?.message) {
        if (ctx.callbackQuery.message.photo) {
          await ctx.deleteMessage().catch(() => {});
          return await ctx.reply(text, extra);
        }
        return await ctx.editMessageText(text, extra);
      }
      return await ctx.reply(text, extra);
    }
  } catch (err) {
    // Fallback if Telegram client/API rejects custom button style or emoji id
    try {
      const strippedKb = keyboardObj?.reply_markup?.inline_keyboard?.map(row =>
        row.map(({ style, icon_custom_emoji_id, ...rest }) => rest)
      );
      const fallbackExtra = { parse_mode: 'HTML', ...(strippedKb ? kbMarkup(strippedKb) : {}) };
      if (isEdit && ctx.callbackQuery?.message && !ctx.callbackQuery.message.photo) {
        return await ctx.editMessageText(text, fallbackExtra);
      }
      return await ctx.reply(text, fallbackExtra);
    } catch (e2) {}
  }
}

async function getUser(ctx, startPayload = null) {
  const tgId = ctx.from.id;
  const name = ctx.from.first_name || 'User';

  let { data: user } = await supabase.from('users').select('*').eq('telegram_id', tgId).single();

  if (!user) {
    const apiKey = 'sk_' + crypto.randomBytes(16).toString('hex');
    const referredBy = startPayload && !isNaN(startPayload) && Number(startPayload) !== tgId ? Number(startPayload) : null;
    
    const newUser = { telegram_id: tgId, name: name, balance: 0.00, api_key: apiKey, referred_by: referredBy };
    await supabase.from('users').insert([newUser]);
    return newUser;
  }
  return user;
}

async function getSupplierConfig() {
  const { data } = await supabase.from('settings').select('*').eq('id', 1).single();
  return {
    supplier_base_url: data?.supplier_base_url || 'https://prodseller.com',
    supplier_api_key: data?.supplier_api_key || 'psk_701f79a0c971f198abbcdc3978e5804b2b8b587f239be728',
    profit_margin: data?.profit_margin ?? 20,
    store_name: data?.store_name || 'Nexas Cloud Store',
    usd_to_bdt_rate: Number(data?.usd_to_bdt_rate || process.env.USD_TO_BDT_RATE || 130),
    bkash_number: data?.bkash_number || process.env.MY_BKASH_NUMBER || '01708994003',
    binance_pay_id: data?.binance_pay_id || process.env.BINANCE_PAY_ID || '988336275',
    support_username: data?.support_username || process.env.SUPPORT_USERNAME || '@mehedihasanantu',
    theme_color: data?.theme_color || 'emerald',
    default_banner: data?.default_banner || ''
  };
}

async function getProductStock(product) {
  if (product.type === 'api') {
    return product.api_stock !== null && product.api_stock !== undefined ? Number(product.api_stock) : 0;
  }
  const { count } = await supabase
    .from('stock')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', product.id)
    .eq('is_sold', false);
  return count || 0;
}

// ==========================================
// SUPPLIER SYNC ENGINE
// ==========================================
async function runSupplierSync() {
  const sup = await getSupplierConfig();
  const baseUrl = sup.supplier_base_url.replace(/\/$/, '');
  
  let res;
  try {
    res = await axios.get(`${baseUrl}/v1/products`, {
      headers: { 'X-API-Key': sup.supplier_api_key, 'Authorization': `Bearer ${sup.supplier_api_key}` }
    });
  } catch (err1) {
    res = await axios.get(`${baseUrl}/api/v1/products`, {
      headers: { 'X-API-Key': sup.supplier_api_key, 'Authorization': `Bearer ${sup.supplier_api_key}` }
    });
  }

  const list = Array.isArray(res.data) ? res.data : (res.data.products || res.data.data || []);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Supplier theke kono product pawa jayni.');
  }

  const margin = parseFloat(sup.profit_margin || 0);
  const orderEndpoint = `${baseUrl}/v1/orders`;
  let added = 0;
  let updated = 0;

  for (const item of list) {
    const suppId = String(item.id ?? item.product_id ?? item._id);
    const rawName = (item.name || item.title || 'Digital Product').trim();
    const itemEmoji = item.emoji || item.icon || '';
    const itemImage = item.image || item.image_url || item.banner || '';
    
    let category = item.category || item.group || rawName;
    let planName = item.plan || item.variant || rawName;

    if (!item.category && rawName.includes(' - ')) {
      const parts = rawName.split(' - ');
      category = parts[0].trim();
      planName = parts.slice(1).join(' - ').trim();
    }

    const basePrice = parseFloat(item.price ?? item.cost ?? 1.0);
    const sellPrice = Number((basePrice * (1 + margin / 100)).toFixed(2));
    
    const rawStock = item.stock ?? item.in_stock ?? item.stock_count ?? item.available ?? item.quantity ?? item.count;
    let stock = rawStock !== undefined && rawStock !== null ? Number(rawStock) : 50;
    if (isNaN(stock) || stock < 0) stock = 0;

    const desc = item.description || item.details || 'Automatically fulfilled through Nexas Cloud Store.';

    const { data: existing } = await supabase
      .from('products')
      .select('*')
      .eq('type', 'api')
      .eq('supplier_product_id', suppId)
      .maybeSingle();

    if (existing) {
      await supabase.from('products').update({
        price: sellPrice,
        api_stock: stock,
        supplier_api_url: orderEndpoint,
        supplier_api_key: sup.supplier_api_key
      }).eq('id', existing.id);
      updated++;
    } else {
      await supabase.from('products').insert([{
        category,
        name: planName,
        price: sellPrice,
        description: desc,
        type: 'api',
        api_stock: stock,
        emoji: itemEmoji,
        image_url: itemImage,
        sold_count: 0,
        supplier_api_url: orderEndpoint,
        supplier_api_key: sup.supplier_api_key,
        supplier_product_id: suppId
      }]);
      added++;
    }
  }

  return { added, updated, margin };
}

// ==========================================
// SMART EXTRACTOR FOR PRODSELLER & ANY SUPPLIER API
// ==========================================
function extractRealDeliveryItems(obj) {
  const results = [];
  const ignoreKeys = [
    'id', 'orderid', 'order_id', 'productid', 'product_id', 'status', 'type',
    'currency', 'createdat', 'created_at', 'updatedat', 'updated_at',
    'message', 'productname', 'product_name', 'name', 'title', 'price',
    'total', 'amount', 'quantity', 'qty', 'userid', 'user_id'
  ];
  const ignoreValues = [
    'instant', 'completed', 'success', 'paid', 'delivered', 'ok',
    'true', 'false', 'active', 'usd', 'usdt', 'pending', 'processing'
  ];

  function scan(val, keyName = '') {
    if (val === null || val === undefined) return;
    const kLower = keyName.toLowerCase();

    if (typeof val === 'string') {
      const s = val.trim();
      if (!s || ignoreValues.includes(s.toLowerCase())) return;

      if (s.startsWith('http://') || s.startsWith('https://')) {
        results.push(s);
        return;
      }

      const targetKeys = [
        'key', 'keys', 'code', 'codes', 'link', 'links', 'account', 'accounts',
        'credential', 'credentials', 'item', 'items', 'data', 'value', 'secret',
        'token', 'content', 'delivered', 'stock', 'payload', 'text', 'redeem'
      ];
      if (targetKeys.includes(kLower) && !ignoreKeys.includes(kLower)) {
        results.push(s);
        return;
      }

      if (!ignoreKeys.includes(kLower) && (s.includes(':') || s.includes('@') || s.length > 18)) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
          results.push(s);
        }
      }
    } else if (Array.isArray(val)) {
      val.forEach(item => scan(item, keyName));
    } else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        if (k.toLowerCase() === 'delivery' && typeof v === 'object' && v !== null && v.type === 'instant' && Object.keys(v).length === 1) {
          continue;
        }
        if (!ignoreKeys.includes(k.toLowerCase())) {
          scan(v, k);
        }
      }
    }
  }

  scan(obj);
  return [...new Set(results)];
}

// ==========================================
// ORDER DELIVERY
// ==========================================
async function deliverProductToUser(user, product, qty, paidText, totalUsd) {
  let deliveredItems = [];

  if (product.type === 'local') {
    const { data: stockItems } = await supabase
      .from('stock')
      .select('*')
      .eq('product_id', product.id)
      .eq('is_sold', false)
      .limit(qty);

    if (!stockItems || stockItems.length < qty) {
      return {
        success: false,
        message: `❌ Stock out! Apnar payment ($${totalUsd.toFixed(2)} USDT) apnar wallet balance-e joma kore dewa hoyeche.`
      };
    }

    const idsToMark = stockItems.map(s => s.id);
    await supabase.from('stock').update({ is_sold: true }).in('id', idsToMark);
    deliveredItems = stockItems.map(s => s.data);
  } else if (product.type === 'api') {
    try {
      const supConfig = await getSupplierConfig();
      const baseUrl = supConfig.supplier_base_url.replace(/\/$/, '');
      const apiKey = product.supplier_api_key || supConfig.supplier_api_key;
      const orderUrl = product.supplier_api_url || `${baseUrl}/v1/orders`;

      const parsedProdId = isNaN(product.supplier_product_id)
        ? product.supplier_product_id
        : Number(product.supplier_product_id);

      const headers = {
        'X-API-Key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      };

      const response = await axios.post(
        orderUrl,
        {
          productId: parsedProdId,
          product_id: parsedProdId,
          quantity: Number(qty),
          qty: Number(qty)
        },
        { headers }
      );

      const resData = response.data;
      deliveredItems = extractRealDeliveryItems(resData);

      const supOrderId = resData.id || resData.orderId || resData.order_id || resData.order?.id || resData.data?.id;
      if (deliveredItems.length === 0 && supOrderId) {
        try {
          const statusRes = await axios.get(`${baseUrl}/v1/orders/${supOrderId}`, { headers });
          deliveredItems = extractRealDeliveryItems(statusRes.data);
        } catch (e) {}
      }

      if (deliveredItems.length === 0) {
        deliveredItems = [JSON.stringify(resData)];
      }
    } catch (err) {
      const errMsg = err.response?.data?.error || err.response?.data?.message || err.message || 'Supplier API Error';
      return {
        success: false,
        message: `❌ Supplier Error (${errMsg})! Apnar payment ($${totalUsd.toFixed(2)} USDT) apnar wallet balance-e joma kore dewa hoyeche.`
      };
    }
  }

  const newSold = Number(product.sold_count || 0) + Number(qty);
  const newApiStock = product.type === 'api' && product.api_stock >= qty ? product.api_stock - qty : product.api_stock;
  await supabase.from('products').update({ sold_count: newSold, api_stock: newApiStock }).eq('id', product.id);

  const orderId = 'ORD-' + Date.now() + Math.floor(10 + Math.random() * 90);
  const deliveredText = deliveredItems.join('\n\n');

  await supabase.from('orders').insert([{
    id: orderId,
    telegram_id: user.telegram_id,
    product_name: `${product.category} (${product.name}) x${qty}`,
    price: totalUsd,
    delivered_data: deliveredText
  }]);

  const emoji = getProductEmoji(product);
  const msg =
    `🎉 <b>PAYMENT VERIFIED SUCCESSFULLY!</b> 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🛍️ <b>Product:</b> ${emoji}${product.category} (${product.name})\n` +
    `🔢 <b>Quantity:</b> <code>${qty}</code>\n` +
    `💰 <b>Paid:</b> <code>${paidText}</code>\n` +
    `🧾 <b>Order Ref:</b> <code>${orderId}</code>\n\n` +
    `📋 <b>YOUR INVITATION / ACCESS LINK(S):</b>\n` +
    `<code>${deliveredText}</code>\n\n` +
    `📌 <b>Important Instructions:</b>\n` +
    `<blockquote>${product.description || '• Activate on your own account'}</blockquote>`;

  const keyboard = kbMarkup([
    [
      cBtn('🛍️ Shop Again', 'menu_shop', 'success'),
      cBtn('👤 My Profile', 'menu_profile', 'primary')
    ]
  ]);

  return { success: true, message: msg, keyboard };
}

// ==========================================
// 1. Main Menu UI
// ==========================================
async function sendMainMenu(ctx, isEdit = false) {
  pendingCheckouts.delete(ctx.from.id);
  const user = await getUser(ctx);
  const cfg = await getSupplierConfig();

  const text =
    `Welcome to <b>${cfg.store_name}</b> ⚡\n` +
    `👋🏻 Hello! <b>${user.name}</b>\n\n` +
    `📌 <b>Account Details</b>\n` +
    `💳 Telegram ID: <code>${user.telegram_id}</code>\n` +
    `💰 Balance: <b>$${Number(user.balance).toFixed(2)} USDT</b>\n\n` +
    `Choose below ⬇️`;

  const keyboard = kbMarkup([
    [cBtn('🛒 Cloud Store Catalog', 'menu_shop', 'success'), cBtn('💰 Wallet', 'menu_wallet', 'primary')],
    [cBtn('🧾 Order History', 'menu_orders'), cBtn('🔄 Recover Order', 'menu_recover')],
    [cBtn('💰 Refer & Earn', 'menu_refer'), cBtn('🛡️ Profile', 'menu_profile')],
    [cBtn('🛟 Support', 'menu_support'), cBtn('🔑 API Access', 'menu_apikey')]
  ]);

  return renderScreen(ctx, text, keyboard, cfg.default_banner, isEdit);
}

bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  await getUser(ctx, payload);
  if (payload && payload.startsWith('prod_')) {
    const prodId = Number(payload.replace('prod_', ''));
    if (prodId) return showProductView(ctx, prodId, 1, false);
  }
  return sendMainMenu(ctx, false);
});

bot.command('menu', (ctx) => sendMainMenu(ctx, false));
bot.action('main_menu', (ctx) => { ctx.answerCbQuery(); sendMainMenu(ctx, true); });

// ==========================================
// 2. Cloud Store Catalog (GREEN if In-Stock, RED if Out-of-Stock!)
// ==========================================
async function showCatalog(ctx, isEdit = true) {
  pendingCheckouts.delete(ctx.from.id);
  const cfg = await getSupplierConfig();
  const { data: products } = await supabase.from('products').select('*').order('id', { ascending: true });

  if (!products || products.length === 0) {
    const emptyMsg = '🌈 <b>CLOUD STORE CATALOG</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 Currently kono product stock-e nei.\n\n<i>Admin hole /sync command ba Web Dashboard theke import korun!</i>';
    const kb = kbMarkup([[cBtn('⬅️ Back to Main Menu', 'main_menu', 'primary')]]);
    return renderScreen(ctx, emptyMsg, kb, null, isEdit);
  }

  const categories = {};
  for (const p of products) {
    const catName = p.category || p.name;
    const stock = await getProductStock(p);
    if (!categories[catName]) {
      categories[catName] = { name: catName, totalStock: 0, firstProd: p };
    }
    categories[catName].totalStock += stock;
  }

  const catList = Object.values(categories);
  // In-stock (Green) upore thakbe, Out-of-stock (Red) niche thakbe
  catList.sort((a, b) => (b.totalStock > 0 ? 1 : 0) - (a.totalStock > 0 ? 1 : 0));

  const buttons = [];
  for (let i = 0; i < catList.length; i += 2) {
    const row = [];
    const c1 = catList[i];
    const hasCustomIcon1 = c1.firstProd.custom_emoji_id && String(c1.firstProd.custom_emoji_id).trim() !== '';
    const emoji1 = hasCustomIcon1 ? '' : getProductEmoji(c1.firstProd);
    const style1 = c1.totalStock > 0 ? 'success' : 'danger'; // GREEN if stock > 0, RED if 0!
    row.push(cBtn(`${emoji1}${c1.name} (${c1.totalStock})`, `cat_${c1.firstProd.id}`, style1, c1.firstProd.custom_emoji_id));

    if (catList[i + 1]) {
      const c2 = catList[i + 1];
      const hasCustomIcon2 = c2.firstProd.custom_emoji_id && String(c2.firstProd.custom_emoji_id).trim() !== '';
      const emoji2 = hasCustomIcon2 ? '' : getProductEmoji(c2.firstProd);
      const style2 = c2.totalStock > 0 ? 'success' : 'danger';
      row.push(cBtn(`${emoji2}${c2.name} (${c2.totalStock})`, `cat_${c2.firstProd.id}`, style2, c2.firstProd.custom_emoji_id));
    }
    buttons.push(row);
  }

  buttons.push([cBtn('⬅️ Back to Main Menu', 'main_menu', 'primary')]);

  const text =
    `🌈 <b>CLOUD STORE CATALOG</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ Instant Delivery 24/7\n` +
    `📦 Total Products: <b>${catList.length}</b>\n\n` +
    `👇 Choose a product below :`;

  return renderScreen(ctx, text, kbMarkup(buttons), cfg.default_banner, isEdit);
}

bot.action('menu_shop', (ctx) => { ctx.answerCbQuery(); showCatalog(ctx, true); });
bot.command('products', (ctx) => showCatalog(ctx, false));

// ==========================================
// 3. Category View & Variants (GREEN / RED Buttons)
// ==========================================
bot.action(/cat_(\d+)/, async (ctx) => {
  ctx.answerCbQuery();
  pendingCheckouts.delete(ctx.from.id);
  const firstProdId = Number(ctx.match[1]);
  const { data: firstProd } = await supabase.from('products').select('*').eq('id', firstProdId).single();
  if (!firstProd) return;

  const catName = firstProd.category || firstProd.name;
  const { data: variants } = await supabase.from('products').select('*').eq('category', catName).order('id', { ascending: true });

  if (variants && variants.length === 1) {
    return showProductView(ctx, variants[0].id, 1, true, true);
  }

  const cfg = await getSupplierConfig();
  const emoji = getProductEmoji(firstProd);
  const buttons = [];

  for (const v of (variants || [firstProd])) {
    const stock = await getProductStock(v);
    const btnStyle = stock > 0 ? 'success' : 'danger';
    const hasCustomIcon = v.custom_emoji_id && String(v.custom_emoji_id).trim() !== '';
    const vEmoji = hasCustomIcon ? '' : getProductEmoji(v);
    buttons.push([
      cBtn(`${vEmoji}${v.name} — $${Number(v.price).toFixed(2)} (${stock})`, `sel_${v.id}_1`, btnStyle, v.custom_emoji_id)
    ]);
  }
  buttons.push([cBtn('⬅️ Back to Catalog', 'menu_shop', 'primary')]);

  const text =
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${emoji}<b>${catName}</b> ✅\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏷️ <b>Category Description</b>\n` +
    `<blockquote>${firstProd.description || 'Automatically fulfilled through Nexas Cloud Store.'}</blockquote>\n\n` +
    `👇 <b>Select a plan below:</b>`;

  const banner = firstProd.image_url || cfg.default_banner;
  return renderScreen(ctx, text, kbMarkup(buttons), banner, true);
});

// ==========================================
// 4. Excalibur-Style Product Card (Colored Buttons!)
// ==========================================
async function showProductView(ctx, prodId, qty = 1, isEdit = true, fromCatalog = false) {
  pendingCheckouts.delete(ctx.from.id);
  if (qty < 1) qty = 1;

  const cfg = await getSupplierConfig();
  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).single();
  if (!product) return;

  const stock = await getProductStock(product);
  if (qty > stock && stock > 0) qty = stock;

  const unitPrice = Number(product.price).toFixed(2);
  const totalPrice = (Number(product.price) * qty).toFixed(2);
  const minusQty = qty > 1 ? qty - 1 : 1;
  const plusQty = stock > qty ? qty + 1 : qty;
  const emoji = getProductEmoji(product);
  const soldCount = Number(product.sold_count || 0);

  const botUsername = (process.env.BOT_USERNAME || 'nexas_shopbot').replace('@', '');
  const shareLink = `https://t.me/${botUsername}?start=prod_${prodId}`;
  const shareText = encodeURIComponent(`🔥 Check out ${product.name} ($${unitPrice}) on ${cfg.store_name}!`);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${shareText}`;

  const stockBadge = stock > 0 ? '✅ Instant delivery' : '❌ Out of Stock';

  const text =
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${emoji}<b>${product.name}</b> ${stock > 0 ? '✅' : '🔴'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Price: $${unitPrice}  🛒 Qty: ${qty}  💳 Total: $${totalPrice}\n` +
    `📦 Stock: ${stock}  📊 Sold: ${soldCount} accounts\n\n` +
    `${stockBadge}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏷️ <b>Product Description</b>\n` +
    `<blockquote>${product.description || 'Automatically fulfilled through Nexas Cloud Store.'}</blockquote>`;

  const backAction = fromCatalog ? 'menu_shop' : `cat_${prodId}`;

  // Buy button GREEN if stock > 0, RED if stock == 0!
  const buyButton = stock > 0
    ? cBtn(`✅ Buy (Total: $${totalPrice})`, `paymenu_${prodId}_${qty}`, 'success')
    : cBtn(`❌ Out of Stock ($${totalPrice})`, `noop_out`, 'danger');

  const keyboard = kbMarkup([
    [
      cBtn('-', `sel_${prodId}_${minusQty}`, 'primary'),
      cBtn(`✏️ Qty: ${qty}`, `noop`, 'danger'),
      cBtn('+', `sel_${prodId}_${plusQty}`, 'primary')
    ],
    [
      cBtn('5', `sel_${prodId}_5`),
      cBtn('10', `sel_${prodId}_10`),
      cBtn('50', `sel_${prodId}_50`),
      cBtn('100', `sel_${prodId}_100`)
    ],
    [buyButton],
    [uBtn('📤 Share Product', shareUrl)],
    [cBtn('Back', backAction, 'danger')]
  ]);

  const banner = product.image_url || cfg.default_banner;
  return renderScreen(ctx, text, keyboard, banner, isEdit);
}

bot.action('noop_out', (ctx) => ctx.answerCbQuery('❌ Sorry, this product is currently out of stock!', { show_alert: true }));

bot.action(/sel_(\d+)_(\d+)/, async (ctx) => {
  ctx.answerCbQuery();
  const prodId = Number(ctx.match[1]);
  const qty = Number(ctx.match[2]);
  return showProductView(ctx, prodId, qty, true);
});

bot.action(/paymenu_(\d+)_(\d+)/, async (ctx) => {
  const prodId = Number(ctx.match[1]);
  const qty = Number(ctx.match[2]);

  const user = await getUser(ctx);
  const cfg = await getSupplierConfig();
  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).single();
  if (!product) return ctx.answerCbQuery('Product not found!');

  const stock = await getProductStock(product);
  if (stock < qty) {
    return ctx.answerCbQuery(`❌ Out of stock! Available: ${stock}`, { show_alert: true });
  }

  ctx.answerCbQuery();
  const totalPrice = (Number(product.price) * qty).toFixed(2);
  const totalBdt = Math.ceil(Number(totalPrice) * cfg.usd_to_bdt_rate);
  const emoji = getProductEmoji(product);

  const text =
    `💳 <b>SELECT PAYMENT METHOD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🛍️ <b>Product:</b> ${emoji}${product.name}\n` +
    `🛒 <b>Quantity:</b> ${qty}\n` +
    `💵 <b>Total Payable:</b> <b>$${totalPrice} USDT</b> (or ${totalBdt} BDT)\n` +
    `👛 <b>Your Wallet Balance:</b> $${Number(user.balance).toFixed(2)} USDT\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👇 Choose how you want to pay:`;

  const keyboard = kbMarkup([
    [cBtn(`👛 Pay with Wallet Balance ($${totalPrice})`, `buy_${prodId}_${qty}`, 'success')],
    [cBtn(`🟡 Pay with Binance Pay ($${totalPrice})`, `chk_bn_${prodId}_${qty}`, 'primary')],
    [cBtn(`📱 Pay with Personal bKash (${totalBdt} BDT)`, `chk_bk_${prodId}_${qty}`, 'primary')],
    [cBtn('⬅️ Back to Product', `sel_${prodId}_${qty}`, 'danger')]
  ]);

  return renderScreen(ctx, text, keyboard, product.image_url || cfg.default_banner, true);
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

// ==========================================
// 5. DIRECT CHECKOUT INSTRUCTIONS
// ==========================================
bot.action(/chk_(bn|bk)_(\d+)_(\d+)/, async (ctx) => {
  const method = ctx.match[1];
  const prodId = Number(ctx.match[2]);
  const qty = Number(ctx.match[3]);

  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).single();
  if (!product) return ctx.answerCbQuery('Product not found!', { show_alert: true });

  const stock = await getProductStock(product);
  if (stock < qty) {
    return ctx.answerCbQuery(`❌ Out of stock! Available: ${stock}`, { show_alert: true });
  }

  ctx.answerCbQuery();
  const cfg = await getSupplierConfig();
  const totalUsd = Number((Number(product.price) * qty).toFixed(2));
  const rate = cfg.usd_to_bdt_rate;
  const totalBdt = Math.ceil(totalUsd * rate);
  const emoji = getProductEmoji(product);

  pendingCheckouts.set(ctx.from.id, {
    type: 'product',
    method: method === 'bn' ? 'binance' : 'bkash',
    prodId,
    qty,
    totalUsd,
    totalBdt,
    expiresAt: Date.now() + 5 * 60 * 1000
  });

  if (method === 'bn') {
    const text =
      `💳 <b>CHECKOUT & PAYMENT INSTRUCTIONS</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🎁 <b>Item:</b> ${emoji}${product.name}\n` +
      `🧮 <b>Quantity:</b> <code>${qty}</code>\n` +
      `💲 <b>Total Amount:</b> <code>${totalUsd.toFixed(2)} USDT</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🟡 <b>HOW TO PAY ON BINANCE:</b>\n` +
      `1️⃣ Open your <b>Binance App</b>\n` +
      `2️⃣ Go to <b>Pay ➔ Send</b>\n` +
      `3️⃣ Send to Binance ID: <code>${cfg.binance_pay_id}</code> <i>(Tap to copy)</i>\n` +
      `4️⃣ Send EXACT amount: <code>${totalUsd.toFixed(2)} USDT</code>\n\n` +
      `✅ <b>AFTER PAYING:</b>\n` +
      `Send your <b>Order ID</b> directly in this chat to receive your item instantly!\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🕒 <b>Waiting for your Transfer Order ID •••</b> <i>( Expires in 5 minutes )</i>`;

    return renderScreen(ctx, text, kbMarkup([
      [cBtn('❓ Where is my Order ID?', 'help_orderid', 'primary')],
      [cBtn('❌ Cancel Order', `sel_${prodId}_${qty}`, 'danger')]
    ]), null, true);
  } else {
    const text =
      `💳 <b>CHECKOUT & PAYMENT INSTRUCTIONS</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🎁 <b>Item:</b> ${emoji}${product.name}\n` +
      `🧮 <b>Quantity:</b> <code>${qty}</code>\n` +
      `💲 <b>Total Amount:</b> <code>${totalBdt} BDT</code> ($${totalUsd.toFixed(2)} USDT)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>HOW TO PAY ON BKASH:</b>\n` +
      `1️⃣ Open your <b>bKash App</b>\n` +
      `2️⃣ Go to <b>Send Money</b>\n` +
      `3️⃣ Send to Personal Number: <code>${cfg.bkash_number}</code> <i>(Tap to copy)</i>\n` +
      `4️⃣ Send EXACT amount: <code>${totalBdt} BDT</code>\n\n` +
      `✅ <b>AFTER PAYING:</b>\n` +
      `Send your <b>bKash TrxID</b> directly in this chat to receive your item instantly!\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🕒 <b>Waiting for your bKash TrxID •••</b> <i>( Expires in 5 minutes )</i>`;

    return renderScreen(ctx, text, kbMarkup([
      [cBtn('❌ Cancel Order', `sel_${prodId}_${qty}`, 'danger')]
    ]), null, true);
  }
});

bot.action('help_orderid', (ctx) => {
  ctx.answerCbQuery('Binance App ➔ Pay ➔ Transaction History ➔ Tap on payment ➔ Copy the "Order ID" and send it directly in this chat!', { show_alert: true });
});

// ==========================================
// 6. Pay with Wallet Balance
// ==========================================
bot.action(/buy_(\d+)_(\d+)/, async (ctx) => {
  const prodId = Number(ctx.match[1]);
  const qty = Number(ctx.match[2]);
  const user = await getUser(ctx);

  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).single();
  if (!product) return ctx.answerCbQuery('❌ Product not found!', { show_alert: true });

  const stock = await getProductStock(product);
  if (stock < qty) {
    return ctx.answerCbQuery(`❌ Out of stock! Available: ${stock}`, { show_alert: true });
  }

  const totalPrice = Number((Number(product.price) * qty).toFixed(2));
  if (Number(user.balance) < totalPrice) {
    return ctx.answerCbQuery(`❌ Insufficient Balance! Need $${totalPrice.toFixed(2)} USDT`, { show_alert: true });
  }

  ctx.answerCbQuery('⏳ Processing your order...');
  const paidText = `${totalPrice.toFixed(2)} USDT (Wallet Balance)`;
  const result = await deliverProductToUser(user, product, qty, paidText, totalPrice);

  if (!result.success) {
    return ctx.reply(result.message);
  }

  const newBalance = Number(user.balance) - totalPrice;
  await supabase.from('users').update({ balance: newBalance }).eq('telegram_id', user.telegram_id);

  return renderScreen(ctx, result.message, result.keyboard, null, true);
});

// ==========================================
// 7. Wallet Deposit & SMS Webhook
// ==========================================
async function showWallet(ctx, isEdit = true) {
  pendingCheckouts.delete(ctx.from.id);
  const user = await getUser(ctx);
  const text = `💰 <b>YOUR WALLET</b>\n━━━━━━━━━━━━━━━━━━━━\n💳 <b>Telegram ID:</b> <code>${user.telegram_id}</code>\n💵 <b>Current Balance:</b> <b>$${Number(user.balance).toFixed(2)} USDT</b>\n\n👇 Choose deposit method:`;
  const kb = kbMarkup([
    [cBtn('🟡 Binance Pay (Auto)', 'dep_binance', 'success'), cBtn('📱 Personal bKash (Auto)', 'dep_bkash', 'primary')],
    [cBtn('⬅️ Back to Main Menu', 'main_menu', 'danger')]
  ]);
  return renderScreen(ctx, text, kb, null, isEdit);
}

bot.action('menu_wallet', (ctx) => { ctx.answerCbQuery(); showWallet(ctx, true); });
bot.command('wallet', (ctx) => showWallet(ctx, false));

bot.action('dep_binance', async (ctx) => {
  ctx.answerCbQuery();
  const cfg = await getSupplierConfig();
  pendingCheckouts.set(ctx.from.id, { type: 'wallet', method: 'binance', expiresAt: Date.now() + 10 * 60 * 1000 });
  return renderScreen(
    ctx,
    `🟡 <b>WALLET DEPOSIT - BINANCE PAY</b>\n━━━━━━━━━━━━━━━━━━━━\n1️⃣ Open Binance App ➔ <b>Pay ➔ Send</b>\n2️⃣ Send USDT to Binance ID: <code>${cfg.binance_pay_id}</code>\n\n✅ <b>AFTER PAYING:</b>\nSend your <b>Transfer Order ID</b> directly in this chat!\n━━━━━━━━━━━━━━━━━━━━\n🕒 <b>Waiting for your Order ID •••</b>`,
    kbMarkup([[cBtn('❌ Cancel', 'menu_wallet', 'danger')]]),
    null,
    true
  );
});

bot.action('dep_bkash', async (ctx) => {
  ctx.answerCbQuery();
  const cfg = await getSupplierConfig();
  pendingCheckouts.set(ctx.from.id, { type: 'wallet', method: 'bkash', expiresAt: Date.now() + 10 * 60 * 1000 });
  return renderScreen(
    ctx,
    `📱 <b>WALLET DEPOSIT - PERSONAL BKASH</b>\n━━━━━━━━━━━━━━━━━━━━\n📞 <b>bKash Number:</b> <code>${cfg.bkash_number}</code>\n💱 <b>Rate:</b> $1 = ${cfg.usd_to_bdt_rate} BDT\n\n✅ <b>AFTER PAYING:</b>\nSend your <b>bKash TrxID</b> directly in this chat!\n━━━━━━━━━━━━━━━━━━━━\n🕒 <b>Waiting for your TrxID •••</b>`,
    kbMarkup([[cBtn('❌ Cancel', 'menu_wallet', 'danger')]]),
    null,
    true
  );
});

app.post('/webhook/sms', async (req, res) => {
  const { secret, message } = req.body;
  if (secret !== process.env.WEBHOOK_SECRET) return res.status(403).send('Forbidden');
  const amountMatch = message.match(/(?:Tk|BDT)\s*([0-9,.]+)/i);
  const trxMatch = message.match(/(?:TrxID|TxnID)[:\s]*([A-Z0-9]+)/i);
  if (amountMatch && trxMatch) {
    const amountBdt = parseFloat(amountMatch[1].replace(/,/g, ''));
    const trxId = trxMatch[1].toUpperCase();
    await supabase.from('payments').upsert([{ trx_id: trxId, amount: amountBdt, sender: 'bKash', is_used: false }]);
  }
  res.json({ status: 'ok' });
});

// ==========================================
// 8. Other Menus
// ==========================================
bot.command('api', async (ctx) => {
  const user = await getUser(ctx);
  ctx.reply(`🔑 <b>Your Reseller API Key:</b>\n<code>${user.api_key}</code>`, { parse_mode: 'HTML' });
});

bot.action('menu_apikey', async (ctx) => {
  ctx.answerCbQuery();
  const user = await getUser(ctx);
  return renderScreen(ctx, `🔑 <b>Reseller API Key</b>\n\n<code>${user.api_key}</code>`, kbMarkup([[cBtn('⬅️ Back', 'main_menu', 'primary')]]), null, true);
});

bot.action('menu_orders', async (ctx) => {
  ctx.answerCbQuery();
  const { data: orders } = await supabase.from('orders').select('*').eq('telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(5);
  if (!orders || orders.length === 0) return renderScreen(ctx, '🧾 Kono order pawa jayni.', kbMarkup([[cBtn('⬅️ Back', 'main_menu', 'primary')]]), null, true);
  let text = '🧾 <b>Recent Orders:</b>\n\n';
  orders.forEach(o => { text += `🔹 <code>${o.id}</code> | ${o.product_name} ($${o.price})\n🔑 <code>${o.delivered_data}</code>\n\n`; });
  return renderScreen(ctx, text, kbMarkup([[cBtn('⬅️ Back', 'main_menu', 'primary')]]), null, true);
});

bot.action('menu_refer', async (ctx) => {
  ctx.answerCbQuery();
  const user = await getUser(ctx);
  const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', user.telegram_id);
  return renderScreen(ctx, `💰 <b>Refer & Earn</b>\n\n👥 Total Referrals: ${count || 0}\n🔗 Link: <code>https://t.me/${(process.env.BOT_USERNAME||'').replace('@','')}?start=${user.telegram_id}</code>`, kbMarkup([[cBtn('⬅️ Back', 'main_menu', 'primary')]]), null, true);
});

bot.action('menu_profile', async (ctx) => {
  ctx.answerCbQuery();
  const user = await getUser(ctx);
  return renderScreen(
    ctx,
    `🛡️ <b>My Profile</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>Name:</b> ${user.name}\n🆔 <b>Telegram ID:</b> <code>${user.telegram_id}</code>\n💰 <b>Balance:</b> $${Number(user.balance).toFixed(2)} USDT`,
    kbMarkup([
      [cBtn('🛍️ Shop Catalog', 'menu_shop', 'success'), cBtn('💰 Deposit', 'menu_wallet', 'primary')],
      [cBtn('⬅️ Main Menu', 'main_menu', 'danger')]
    ]),
    null,
    true
  );
});

bot.action('menu_support', async (ctx) => {
  ctx.answerCbQuery();
  const cfg = await getSupplierConfig();
  return renderScreen(ctx, `🛟 Support: ${cfg.support_username}`, kbMarkup([[cBtn('⬅️ Back', 'main_menu', 'primary')]]), null, true);
});

bot.action('menu_recover', (ctx) => {
  ctx.answerCbQuery();
  return renderScreen(ctx, '🔄 Order recover korte din: <code>/recover ORD-XXXX</code>', kbMarkup([[cBtn('⬅️ Back', 'main_menu', 'primary')]]), null, true);
});

bot.command('recover', async (ctx) => {
  const orderId = ctx.message.text.split(' ')[1];
  if (!orderId) return ctx.reply('Order ID din.');
  const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).eq('telegram_id', ctx.from.id).single();
  if (!order) return ctx.reply('❌ Kono order pawa jayni.');
  ctx.reply(`✅ <b>Order Found!</b>\n\n🔑 Data:\n<code>${order.delivered_data}</code>`, { parse_mode: 'HTML' });
});

// ==========================================
// 9. ADMIN COMMANDS (TELEGRAM)
// ==========================================
function isAdmin(ctx) { return String(ctx.from.id) === String(process.env.ADMIN_ID); }

bot.command('supplier', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const sup = await getSupplierConfig();
  let balText = 'Checking...';
  try {
    const baseUrl = sup.supplier_base_url.replace(/\/$/, '');
    const res = await axios.get(`${baseUrl}/v1/balance`, {
      headers: { 'X-API-Key': sup.supplier_api_key, 'Authorization': `Bearer ${sup.supplier_api_key}` }
    });
    balText = `$${res.data.balance ?? res.data.data?.balance ?? JSON.stringify(res.data)} USDT`;
  } catch (e) {
    balText = 'Could not fetch balance';
  }

  const appUrl = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  ctx.reply(
    `⚙️ <b>CURRENT SUPPLIER & STORE SETTINGS</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `🏪 <b>Store Name:</b> ${sup.store_name}\n` +
    `🌐 <b>Base URL:</b> <code>${sup.supplier_base_url}</code>\n` +
    `📈 <b>Profit Margin:</b> <code>${sup.profit_margin}%</code>\n` +
    `💱 <b>USD Rate:</b> <code>${sup.usd_to_bdt_rate} BDT</code>\n` +
    `💰 <b>Supplier Balance:</b> <b>${balText}</b>\n\n` +
    `🖥️ <b>Web Admin Dashboard:</b>\n${appUrl ? `${appUrl}/admin` : '`/admin` route'}`,
    { parse_mode: 'HTML' }
  );
});

bot.command('lastorders', async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const sup = await getSupplierConfig();
    const baseUrl = sup.supplier_base_url.replace(/\/$/, '');
    const res = await axios.get(`${baseUrl}/v1/orders`, {
      headers: { 'X-API-Key': sup.supplier_api_key, 'Authorization': `Bearer ${sup.supplier_api_key}` }
    });
    const text = JSON.stringify(res.data, null, 2).slice(0, 3800);
    ctx.reply(`📦 <b>Supplier Last Orders Raw Data:</b>\n<pre>${text}</pre>`, { parse_mode: 'HTML' });
  } catch (err) {
    ctx.reply('Error: ' + (err.response?.data?.error || err.message));
  }
});

bot.command('sync', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const wait = await ctx.reply('🔄 <b>Syncing products & real stock from supplier...</b>', { parse_mode: 'HTML' });
  try {
    const { added, updated, margin } = await runSupplierSync();
    ctx.telegram.editMessageText(
      ctx.chat.id,
      wait.message_id,
      null,
      `✅ <b>Supplier Sync Completed!</b>\n━━━━━━━━━━━━━━━━━━━━\n🆕 <b>New Products Added:</b> ${added}\n🔄 <b>Products Updated:</b> ${updated}\n📈 <b>Profit Margin:</b> +${margin}%\n\nEkhon <code>/products</code> likhe catalog dekhun!`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, `❌ Sync Error: ${errMsg}`);
  }
});

bot.command('clearapi', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await supabase.from('products').delete().eq('type', 'api');
  ctx.reply('🗑️ Sob API products delete kora hoyeche! Notun kore sync korte `/sync` din.');
});

// ==========================================
// 10. AUTO VERIFY & INSTANT LINK DELIVERY ON ID PASTE
// ==========================================
bot.on('text', async (ctx) => {
  const rawText = ctx.message.text.trim();
  if (rawText.startsWith('/')) return;

  const session = pendingCheckouts.get(ctx.from.id);
  if (!session) return;

  if (Date.now() > session.expiresAt) {
    pendingCheckouts.delete(ctx.from.id);
    return ctx.reply('⏰ Checkout session expire hoye geche! Abar try korun.');
  }

  const user = await getUser(ctx);
  const cfg = await getSupplierConfig();

  if (session.method === 'binance') {
    const orderId = rawText.replace(/\s+/g, '');
    const trxKey = 'BN_' + orderId;

    const { data: existing } = await supabase.from('payments').select('*').eq('trx_id', trxKey).single();
    if (existing) return ctx.reply('❌ Ei Binance Order ID-ti already use kora hoyeche!');

    const waitMsg = await ctx.reply('🔍 Verifying your Binance Transfer Order ID...');

    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = crypto.createHmac('sha256', process.env.BINANCE_SECRET_KEY).update(queryString).digest('hex');

      const response = await axios.get(`https://api.binance.com/sapi/v1/pay/transactions?${queryString}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY }
      });

      const tx = (response.data.data || []).find(
        t => (String(t.orderId) === String(orderId) || String(t.transactionId) === String(orderId)) && parseFloat(t.amount) > 0 && t.currency === 'USDT'
      );

      if (!tx) {
        return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ Ei Order ID-te kono payment pawa jayni!');
      }

      const paidAmount = parseFloat(tx.amount);

      if (session.type === 'product') {
        if (paidAmount < session.totalUsd) {
          return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, `❌ Kom amount pathiyechen! Dorkar $${session.totalUsd.toFixed(2)} USDT.`);
        }

        await supabase.from('payments').insert([{ trx_id: trxKey, amount: paidAmount, sender: 'Binance', is_used: true }]);
        pendingCheckouts.delete(ctx.from.id);

        const extra = Number((paidAmount - session.totalUsd).toFixed(2));
        if (extra > 0) {
          await supabase.from('users').update({ balance: Number(user.balance) + extra }).eq('telegram_id', user.telegram_id);
        }

        const { data: product } = await supabase.from('products').select('*').eq('id', session.prodId).single();
        const paidText = `${paidAmount.toFixed(2)} USDT (Binance Pay)`;
        const result = await deliverProductToUser(user, product, session.qty, paidText, session.totalUsd);

        if (!result.success) {
          await supabase.from('users').update({ balance: Number(user.balance) + paidAmount }).eq('telegram_id', user.telegram_id);
          return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, result.message);
        }

        return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, result.message, {
          parse_mode: 'HTML',
          ...result.keyboard
        });
      } else {
        await supabase.from('payments').insert([{ trx_id: trxKey, amount: paidAmount, sender: 'Binance', is_used: true }]);
        pendingCheckouts.delete(ctx.from.id);
        await supabase.from('users').update({ balance: Number(user.balance) + paidAmount }).eq('telegram_id', user.telegram_id);
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          waitMsg.message_id,
          null,
          `🎉 <b>PAYMENT VERIFIED SUCCESSFULLY!</b> 🎉\n━━━━━━━━━━━━━━━━━━━━\n💰 <b>Added to Wallet:</b> <code>${paidAmount.toFixed(2)} USDT (Binance Pay)</code>`,
          { parse_mode: 'HTML', ...kbMarkup([[cBtn('🛍️ Shop Now', 'menu_shop', 'success'), cBtn('👤 My Profile', 'menu_profile', 'primary')]]) }
        );
      }
    } catch (err) {
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ Binance API verify korte somossa hoyeche.');
    }
  }

  if (session.method === 'bkash') {
    const trxId = rawText.replace(/\s+/g, '').toUpperCase();
    const { data: payment } = await supabase.from('payments').select('*').eq('trx_id', trxId).single();

    if (!payment) return ctx.reply('⏳ Ei bKash TrxID-ti ekhono system-e asheni.');
    if (payment.is_used) return ctx.reply('❌ Ei bKash TrxID-ti already use kora hoyeche!');

    const rate = cfg.usd_to_bdt_rate;
    const paidUsd = parseFloat((payment.amount / rate).toFixed(2));

    if (session.type === 'product') {
      if (payment.amount < session.totalBdt) {
        return ctx.reply(`❌ Kom taka pathiyechen! Dorkar ${session.totalBdt} BDT.`);
      }

      await supabase.from('payments').update({ is_used: true }).eq('trx_id', trxId);
      pendingCheckouts.delete(ctx.from.id);

      const extraBdt = payment.amount - session.totalBdt;
      if (extraBdt > 1) {
        const extraUsd = parseFloat((extraBdt / rate).toFixed(2));
        await supabase.from('users').update({ balance: Number(user.balance) + extraUsd }).eq('telegram_id', user.telegram_id);
      }

      const { data: product } = await supabase.from('products').select('*').eq('id', session.prodId).single();
      const paidText = `${payment.amount} BDT / $${session.totalUsd.toFixed(2)} (bKash)`;
      const result = await deliverProductToUser(user, product, session.qty, paidText, session.totalUsd);

      if (!result.success) {
        await supabase.from('users').update({ balance: Number(user.balance) + paidUsd }).eq('telegram_id', user.telegram_id);
        return ctx.reply(result.message);
      }

      return ctx.reply(result.message, { parse_mode: 'HTML', ...result.keyboard });
    } else {
      await supabase.from('payments').update({ is_used: true }).eq('trx_id', trxId);
      pendingCheckouts.delete(ctx.from.id);
      await supabase.from('users').update({ balance: Number(user.balance) + paidUsd }).eq('telegram_id', user.telegram_id);
      return ctx.reply(
        `🎉 <b>PAYMENT VERIFIED SUCCESSFULLY!</b> 🎉\n━━━━━━━━━━━━━━━━━━━━\n💰 <b>Added to Wallet:</b> <code>$${paidUsd.toFixed(2)} USDT (${payment.amount} BDT bKash)</code>`,
        { parse_mode: 'HTML', ...kbMarkup([[cBtn('🛍️ Shop Now', 'menu_shop', 'success'), cBtn('👤 My Profile', 'menu_profile', 'primary')]]) }
      );
    }
  }
});

// ==========================================
// 11. UPGRADED WEB ADMIN DASHBOARD (/admin)
// ==========================================
function verifyAdminReq(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.query.pass || req.body?.password;
  if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized! Wrong Admin Password.' });
  next();
}

app.get('/api/admin/data', verifyAdminReq, async (req, res) => {
  const settings = await getSupplierConfig();
  const { data: products } = await supabase.from('products').select('*').order('id', { ascending: true });
  const { data: users } = await supabase.from('users').select('*').order('balance', { ascending: false }).limit(50);
  const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(20);
  res.json({ settings, products: products || [], users: users || [], orders: orders || [] });
});

app.post('/api/admin/settings', verifyAdminReq, async (req, res) => {
  const {
    store_name, supplier_base_url, supplier_api_key, profit_margin,
    usd_to_bdt_rate, bkash_number, binance_pay_id, support_username,
    theme_color, default_banner
  } = req.body;

  const { error } = await supabase.from('settings').upsert([{
    id: 1,
    store_name,
    supplier_base_url: (supplier_base_url || '').replace(/\/$/, ''),
    supplier_api_key,
    profit_margin: parseFloat(profit_margin || 20),
    usd_to_bdt_rate: parseFloat(usd_to_bdt_rate || 130),
    bkash_number,
    binance_pay_id,
    support_username,
    theme_color: theme_color || 'emerald',
    default_banner: default_banner || ''
  }]);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/admin/sync', verifyAdminReq, async (req, res) => {
  try {
    const result = await runSupplierSync();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/product/update', verifyAdminReq, async (req, res) => {
  const { id, emoji, custom_emoji_id, category, name, price, api_stock, sold_count, image_url, description } = req.body;
  const { error } = await supabase.from('products').update({
    emoji: emoji || '',
    custom_emoji_id: custom_emoji_id || '',
    category,
    name,
    price: parseFloat(price || 0),
    api_stock: parseInt(api_stock || 0),
    sold_count: parseInt(sold_count || 0),
    image_url: image_url || '',
    description: description || ''
  }).eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/admin/product/add', verifyAdminReq, async (req, res) => {
  const { emoji, custom_emoji_id, category, name, price, description, type, api_stock, image_url } = req.body;
  const { error } = await supabase.from('products').insert([{
    emoji: emoji || '💥',
    custom_emoji_id: custom_emoji_id || '',
    category,
    name,
    price: parseFloat(price || 1),
    description: description || 'Automatically fulfilled through Nexas Cloud Store.',
    type: type || 'local',
    api_stock: parseInt(api_stock || 10),
    image_url: image_url || '',
    sold_count: 0
  }]);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/admin/product/delete', verifyAdminReq, async (req, res) => {
  const { id } = req.body;
  await supabase.from('products').delete().eq('id', id);
  res.json({ success: true });
});

app.post('/api/admin/user/balance', verifyAdminReq, async (req, res) => {
  const { telegram_id, balance } = req.body;
  const { error } = await supabase.from('users').update({ balance: parseFloat(balance) }).eq('telegram_id', telegram_id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/admin/broadcast', verifyAdminReq, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message empty' });
  const { data: users } = await supabase.from('users').select('telegram_id');
  let sent = 0;
  for (const u of (users || [])) {
    try {
      await bot.telegram.sendMessage(u.telegram_id, message, { parse_mode: 'HTML' });
      sent++;
    } catch (e) {}
  }
  res.json({ success: true, sent });
});

app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nexas Store — Visual Customizer Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans">
  <!-- Login Modal -->
  <div id="loginScreen" class="fixed inset-0 bg-slate-950 flex items-center justify-center p-4 z-50">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
      <h1 class="text-xl font-bold text-center mb-2">🎨 Nexas Visual Admin</h1>
      <p class="text-xs text-slate-400 text-center mb-5">Enter your ADMIN_PASSWORD or WEBHOOK_SECRET</p>
      <input id="passInput" type="password" placeholder="Admin Password" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 mb-4 text-sm focus:outline-none focus:border-emerald-500" />
      <button onclick="login()" class="w-full bg-emerald-600 hover:bg-emerald-500 font-semibold py-2.5 rounded-xl text-sm transition">Unlock Dashboard</button>
    </div>
  </div>

  <!-- Product Visual Editor Modal -->
  <div id="prodModal" class="hidden fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
      <div class="flex justify-between items-center mb-4 border-b border-slate-800 pb-3">
        <h3 class="font-bold text-lg">🎨 Customize Product Card & Live Preview</h3>
        <button onclick="closeModal()" class="text-slate-400 hover:text-white text-xl">&times;</button>
      </div>
      <div class="grid md:grid-cols-2 gap-6">
        <div class="space-y-3 text-xs">
          <input type="hidden" id="m_id" />
          <div class="grid grid-cols-3 gap-2">
            <div>
              <label class="text-slate-400 block mb-1">Emoji</label>
              <input id="m_emoji" oninput="updatePreview()" placeholder="💥 or ✨" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center text-base" />
            </div>
            <div class="col-span-2">
              <label class="text-slate-400 block mb-1">Category Name</label>
              <input id="m_cat" oninput="updatePreview()" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            </div>
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Telegram Custom Emoji ID (Optional App Logo ID)</label>
            <input id="m_custom_emoji" placeholder="e.g. 5368324170671202286" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 font-mono" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Product / Plan Name</label>
            <input id="m_name" oninput="updatePreview()" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div class="grid grid-cols-3 gap-2">
            <div>
              <label class="text-slate-400 block mb-1">Price ($)</label>
              <input id="m_price" type="number" step="0.01" oninput="updatePreview()" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            </div>
            <div>
              <label class="text-slate-400 block mb-1">Stock (0 = Red)</label>
              <input id="m_stock" type="number" oninput="updatePreview()" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            </div>
            <div>
              <label class="text-slate-400 block mb-1">Sold Count</label>
              <input id="m_sold" type="number" oninput="updatePreview()" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            </div>
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Banner Image URL (.jpg / .png)</label>
            <input id="m_img" oninput="updatePreview()" placeholder="https://i.imgur.com/example.png" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Product Description (Quote Box)</label>
            <textarea id="m_desc" rows="4" oninput="updatePreview()" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-3"></textarea>
          </div>
          <button onclick="saveModalProduct()" class="w-full bg-emerald-600 hover:bg-emerald-500 py-2.5 rounded-xl font-bold text-sm">💾 Save Product Changes</button>
        </div>

        <!-- Live Telegram Bot Preview -->
        <div>
          <p class="text-xs text-slate-400 mb-2">📱 Live Catalog Button & Card Preview:</p>
          <div class="mb-3">
            <div id="prev_cat_btn" class="w-full py-2 px-3 rounded-lg font-bold text-xs text-center text-white bg-[#3b7a3e] transition">
              <span id="prev_cat_label">💥 Category (10)</span>
            </div>
          </div>
          <div class="bg-[#182533] border border-slate-700 rounded-2xl overflow-hidden shadow-xl text-xs">
            <img id="prev_img" src="" class="w-full h-36 object-cover hidden" />
            <div class="p-4 space-y-2 text-slate-200 font-sans">
              <div class="text-slate-500">━━━━━━━━━━━━━━━━━━━━</div>
              <div class="font-bold text-white text-sm"><span id="prev_emoji">💥</span> <span id="prev_name">Product Name</span> ✅</div>
              <div class="text-slate-500">━━━━━━━━━━━━━━━━━━━━</div>
              <div>💵 Price: $<span id="prev_price">0.90</span>  🛒 Qty: 1  💳 Total: $<span id="prev_total">0.90</span></div>
              <div>📦 Stock: <span id="prev_stock">10</span>  📊 Sold: <span id="prev_sold">0</span> accounts</div>
              <div id="prev_status" class="pt-1">✅ Instant delivery</div>
              <div class="text-slate-500">━━━━━━━━━━━━━━━━━━━━</div>
              <div class="font-bold">🏷️ Product Description</div>
              <div id="prev_desc" class="border-l-4 border-sky-500 bg-sky-950/40 pl-3 py-1.5 rounded text-slate-300 whitespace-pre-line"></div>
            </div>
            <div class="p-3 pt-0 space-y-1.5">
              <div class="grid grid-cols-3 gap-1.5">
                <div class="bg-[#2b5278] text-center py-1.5 rounded font-bold">-</div>
                <div class="bg-[#8c4b43] text-center py-1.5 rounded font-bold">✏️ Qty: 1</div>
                <div class="bg-[#2b5278] text-center py-1.5 rounded font-bold">+</div>
              </div>
              <div id="prev_buy_btn" class="bg-[#3b7a3e] text-center py-2 rounded font-bold text-white">✅ Buy (Total: $<span id="prev_btn_total">0.90</span>)</div>
              <div class="bg-[#243447] text-center py-2 rounded font-bold">📤 Share Product</div>
              <div class="bg-[#8c4b43] text-center py-2 rounded font-bold">Back</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Main Dashboard -->
  <div id="appScreen" class="hidden max-w-7xl mx-auto p-4 md:p-6">
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-white">⚡ Nexas Store Visual Customizer</h1>
        <p class="text-xs text-slate-400"> Stock > 0 = 🟢 Green Button | Stock 0 = 🔴 Red Button in Telegram</p>
      </div>
      <div class="flex gap-2">
        <button onclick="syncNow()" id="syncBtn" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl text-xs font-semibold transition">🔄 1-Click Supplier Sync</button>
        <button onclick="loadData()" class="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-xs font-semibold transition">↻ Refresh</button>
        <button onclick="logout()" class="bg-rose-600/20 text-rose-400 hover:bg-rose-600/30 px-3 py-2 rounded-xl text-xs font-semibold">Logout</button>
      </div>
    </div>

    <!-- Settings & Theme Customizer -->
    <div class="grid md:grid-cols-3 gap-6 mb-8">
      <div class="md:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h3 class="font-bold text-base mb-4">🎨 Store Branding, Payment & Supplier</h3>
        <div class="grid sm:grid-cols-2 gap-3 text-xs">
          <div>
            <label class="text-slate-400 block mb-1">Store Name</label>
            <input id="s_store_name" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Support Username</label>
            <input id="s_support" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div class="sm:col-span-2">
            <label class="text-slate-400 block mb-1">Default Store Banner Image URL (Optional)</label>
            <input id="s_banner" placeholder="https://i.imgur.com/your-store-banner.png" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">bKash Personal Number</label>
            <input id="s_bkash" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Binance Pay ID</label>
            <input id="s_binance" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">USD to BDT Rate (1$ = ? BDT)</label>
            <input id="s_rate" type="number" step="0.5" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Supplier Profit Margin (%)</label>
            <input id="s_margin" type="number" step="1" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Supplier Base URL</label>
            <input id="s_url" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Supplier API Key</label>
            <input id="s_key" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
        </div>
        <button onclick="saveSettings()" class="mt-4 bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-xl text-xs font-semibold">💾 Save All Store Settings</button>
      </div>

      <!-- Add Product -->
      <div class="space-y-6">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h3 class="font-bold text-base mb-3">➕ Add New Custom Product</h3>
          <div class="space-y-2 text-xs">
            <div class="grid grid-cols-3 gap-2">
              <input id="n_emoji" placeholder="Emoji (💥)" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-center" />
              <input id="n_cat" placeholder="Category (Gemini)" class="col-span-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            </div>
            <input id="n_name" placeholder="Product Name (e.g. Gemini 18M premium)" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            <div class="grid grid-cols-2 gap-2">
              <input id="n_price" type="number" step="0.01" placeholder="Price ($0.90)" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
              <input id="n_stock" type="number" placeholder="Stock (11)" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            </div>
            <input id="n_img" placeholder="Banner Image URL (.jpg/.png)" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            <textarea id="n_desc" rows="2" placeholder="Product Description..." class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2"></textarea>
            <button onclick="addProduct()" class="w-full bg-emerald-600 hover:bg-emerald-500 py-2 rounded-xl font-semibold">➕ Create Product</button>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h3 class="font-bold text-base mb-2">📢 Broadcast to Users</h3>
          <textarea id="bcText" rows="2" placeholder="Write announcement..." class="w-full bg-slate-800 border border-slate-700 rounded-xl p-2.5 text-xs mb-2"></textarea>
          <button onclick="sendBroadcast()" class="w-full bg-amber-600 hover:bg-amber-500 py-2 rounded-xl text-xs font-semibold">🚀 Send Broadcast</button>
        </div>
      </div>
    </div>

    <!-- Products Visual Manager Table -->
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-8">
      <div class="flex flex-wrap justify-between items-center gap-2 mb-4">
        <h3 class="font-bold text-base">🛍️ Products Manager (In-Stock = 🟢 Green Button | Stock 0 = 🔴 Red Button)</h3>
        <input id="searchProd" oninput="renderProducts()" placeholder="🔍 Search product or category..." class="bg-slate-800 border border-slate-700 rounded-xl px-3 py-1.5 text-xs w-64" />
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="text-slate-400 border-b border-slate-800">
            <tr>
              <th class="pb-2">Status</th>
              <th class="pb-2">Banner</th>
              <th class="pb-2">Emoji</th>
              <th class="pb-2">Category</th>
              <th class="pb-2">Product Name</th>
              <th class="pb-2">Price ($)</th>
              <th class="pb-2">Stock</th>
              <th class="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody id="productsTable" class="divide-y divide-slate-800"></tbody>
        </table>
      </div>
    </div>

    <!-- Users & Orders -->
    <div class="grid md:grid-cols-2 gap-6">
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h3 class="font-bold text-base mb-4">👥 Users & Wallet Balance</h3>
        <div class="overflow-x-auto max-h-80">
          <table class="w-full text-left text-xs">
            <thead class="text-slate-400 border-b border-slate-800">
              <tr>
                <th class="pb-2">Name</th>
                <th class="pb-2">Telegram ID</th>
                <th class="pb-2">Balance ($)</th>
                <th class="pb-2">Action</th>
              </tr>
            </thead>
            <tbody id="usersTable" class="divide-y divide-slate-800"></tbody>
          </table>
        </div>
      </div>

      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h3 class="font-bold text-base mb-4">🧾 Recent Orders</h3>
        <div class="overflow-x-auto max-h-80">
          <table class="w-full text-left text-xs">
            <thead class="text-slate-400 border-b border-slate-800">
              <tr>
                <th class="pb-2">Order ID</th>
                <th class="pb-2">Product</th>
                <th class="pb-2">Price</th>
              </tr>
            </thead>
            <tbody id="ordersTable" class="divide-y divide-slate-800"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <script>
    let ADMIN_KEY = localStorage.getItem('nexas_admin_key') || '';
    let ALL_PRODUCTS = [];

    if (ADMIN_KEY) loadData();

    async function api(path, method = 'GET', body = null) {
      const opts = { method, headers: { 'Content-Type': 'application/json', 'x-admin-password': ADMIN_KEY } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    async function login() {
      ADMIN_KEY = document.getElementById('passInput').value.trim();
      try {
        await loadData();
        localStorage.setItem('nexas_admin_key', ADMIN_KEY);
      } catch (e) {
        alert(e.message);
      }
    }

    function logout() {
      localStorage.removeItem('nexas_admin_key');
      location.reload();
    }

    async function loadData() {
      const data = await api('/api/admin/data');
      document.getElementById('loginScreen').classList.add('hidden');
      document.getElementById('appScreen').classList.remove('hidden');

      const s = data.settings;
      document.getElementById('s_store_name').value = s.store_name || '';
      document.getElementById('s_banner').value = s.default_banner || '';
      document.getElementById('s_support').value = s.support_username || '';
      document.getElementById('s_bkash').value = s.bkash_number || '';
      document.getElementById('s_binance').value = s.binance_pay_id || '';
      document.getElementById('s_rate').value = s.usd_to_bdt_rate || 130;
      document.getElementById('s_margin').value = s.profit_margin ?? 20;
      document.getElementById('s_url').value = s.supplier_base_url || '';
      document.getElementById('s_key').value = s.supplier_api_key || '';

      ALL_PRODUCTS = data.products || [];
      renderProducts();

      const uBody = document.getElementById('usersTable');
      uBody.innerHTML = data.users.map(u => \`
        <tr>
          <td class="py-2">\${u.name || 'User'}</td>
          <td class="py-2 font-mono">\${u.telegram_id}</td>
          <td class="py-2"><input id="u_bal_\${u.telegram_id}" type="number" step="0.01" value="\${u.balance}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-20" /></td>
          <td class="py-2"><button onclick="saveBal('\${u.telegram_id}')" class="bg-emerald-600 px-2.5 py-1 rounded font-semibold">Update</button></td>
        </tr>
      \`).join('');

      const oBody = document.getElementById('ordersTable');
      oBody.innerHTML = data.orders.map(o => \`
        <tr>
          <td class="py-2 font-mono">\${o.id}</td>
          <td class="py-2">\${o.product_name}</td>
          <td class="py-2 text-emerald-400 font-semibold">$\${Number(o.price).toFixed(2)}</td>
        </tr>
      \`).join('');
    }

    function renderProducts() {
      const q = (document.getElementById('searchProd')?.value || '').toLowerCase();
      const filtered = ALL_PRODUCTS.filter(p =>
        (p.name || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)
      );

      const pBody = document.getElementById('productsTable');
      pBody.innerHTML = filtered.map(p => {
        const stock = Number(p.api_stock ?? 0);
        const badge = stock > 0
          ? '<span class="px-2 py-0.5 rounded bg-emerald-600 text-white font-bold">🟢 In Stock</span>'
          : '<span class="px-2 py-0.5 rounded bg-rose-700 text-white font-bold">🔴 Out (0)</span>';
        return \`
        <tr class="hover:bg-slate-800/40">
          <td class="py-2 pr-2">\${badge}</td>
          <td class="py-2 pr-2">
            \${p.image_url ? \`<img src="\${p.image_url}" class="w-10 h-7 object-cover rounded border border-slate-700" />\` : '<span class="text-slate-600">No Img</span>'}
          </td>
          <td class="py-2 pr-2"><input id="p_emoji_\${p.id}" value="\${(p.emoji||'💥').replace(/"/g, '&quot;')}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-12 text-center" /></td>
          <td class="py-2 pr-2"><input id="p_cat_\${p.id}" value="\${(p.category||'').replace(/"/g, '&quot;')}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-36" /></td>
          <td class="py-2 pr-2"><input id="p_name_\${p.id}" value="\${(p.name||'').replace(/"/g, '&quot;')}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-44" /></td>
          <td class="py-2 pr-2"><input id="p_price_\${p.id}" type="number" step="0.01" value="\${p.price}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-20" /></td>
          <td class="py-2 pr-2"><input id="p_stock_\${p.id}" type="number" value="\${stock}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-16" /></td>
          <td class="py-2 space-x-1 whitespace-nowrap">
            <button onclick="openModal(\${p.id})" class="bg-indigo-600 hover:bg-indigo-500 px-2.5 py-1 rounded font-semibold">🎨 Customize</button>
            <button onclick="quickSaveProd(\${p.id})" class="bg-emerald-600 hover:bg-emerald-500 px-2.5 py-1 rounded font-semibold">💾</button>
            <button onclick="delProd(\${p.id})" class="bg-rose-600/30 text-rose-300 hover:bg-rose-600 px-2 py-1 rounded">🗑️</button>
          </td>
        </tr>\`;
      }).join('');
    }

    function openModal(id) {
      const p = ALL_PRODUCTS.find(x => x.id === id);
      if (!p) return;
      document.getElementById('m_id').value = p.id;
      document.getElementById('m_emoji').value = p.emoji || '💥';
      document.getElementById('m_custom_emoji').value = p.custom_emoji_id || '';
      document.getElementById('m_cat').value = p.category || '';
      document.getElementById('m_name').value = p.name || '';
      document.getElementById('m_price').value = p.price || 0;
      document.getElementById('m_stock').value = p.api_stock ?? 0;
      document.getElementById('m_sold').value = p.sold_count ?? 0;
      document.getElementById('m_img').value = p.image_url || '';
      document.getElementById('m_desc').value = p.description || '';
      updatePreview();
      document.getElementById('prodModal').classList.remove('hidden');
    }

    function closeModal() {
      document.getElementById('prodModal').classList.add('hidden');
    }

    function updatePreview() {
      const emoji = document.getElementById('m_emoji').value || '💥';
      const cat = document.getElementById('m_cat').value || 'Category';
      const name = document.getElementById('m_name').value || 'Product Name';
      const price = Number(document.getElementById('m_price').value || 0).toFixed(2);
      const stock = Number(document.getElementById('m_stock').value || 0);
      const sold = document.getElementById('m_sold').value || 0;
      const img = document.getElementById('m_img').value.trim();
      const desc = document.getElementById('m_desc').value || 'Automatically fulfilled through Nexas Cloud Store.';

      document.getElementById('prev_emoji').innerText = emoji;
      document.getElementById('prev_name').innerText = name;
      document.getElementById('prev_price').innerText = price;
      document.getElementById('prev_total').innerText = price;
      document.getElementById('prev_stock').innerText = stock;
      document.getElementById('prev_sold').innerText = sold;
      document.getElementById('prev_desc').innerText = desc;

      const catBtn = document.getElementById('prev_cat_btn');
      const buyBtn = document.getElementById('prev_buy_btn');
      document.getElementById('prev_cat_label').innerText = \`\${emoji} \${cat} (\${stock})\`;

      if (stock > 0) {
        catBtn.className = 'w-full py-2 px-3 rounded-lg font-bold text-xs text-center text-white bg-[#3b7a3e]';
        buyBtn.className = 'bg-[#3b7a3e] text-center py-2 rounded font-bold text-white';
        buyBtn.innerHTML = \`✅ Buy (Total: $\${price})\`;
        document.getElementById('prev_status').innerText = '✅ Instant delivery';
      } else {
        catBtn.className = 'w-full py-2 px-3 rounded-lg font-bold text-xs text-center text-white bg-[#8c4b43]';
        buyBtn.className = 'bg-[#8c4b43] text-center py-2 rounded font-bold text-white';
        buyBtn.innerHTML = \`❌ Out of Stock ($\${price})\`;
        document.getElementById('prev_status').innerText = '❌ Out of Stock';
      }

      const imgEl = document.getElementById('prev_img');
      if (img && img.startsWith('http')) {
        imgEl.src = img;
        imgEl.classList.remove('hidden');
      } else {
        imgEl.classList.add('hidden');
      }
    }

    async function saveModalProduct() {
      const id = Number(document.getElementById('m_id').value);
      await api('/api/admin/product/update', 'POST', {
        id,
        emoji: document.getElementById('m_emoji').value,
        custom_emoji_id: document.getElementById('m_custom_emoji').value,
        category: document.getElementById('m_cat').value,
        name: document.getElementById('m_name').value,
        price: document.getElementById('m_price').value,
        api_stock: document.getElementById('m_stock').value,
        sold_count: document.getElementById('m_sold').value,
        image_url: document.getElementById('m_img').value,
        description: document.getElementById('m_desc').value
      });
      closeModal();
      loadData();
    }

    async function quickSaveProd(id) {
      const p = ALL_PRODUCTS.find(x => x.id === id);
      await api('/api/admin/product/update', 'POST', {
        id,
        emoji: document.getElementById('p_emoji_' + id).value,
        custom_emoji_id: p?.custom_emoji_id || '',
        category: document.getElementById('p_cat_' + id).value,
        name: document.getElementById('p_name_' + id).value,
        price: document.getElementById('p_price_' + id).value,
        api_stock: document.getElementById('p_stock_' + id).value,
        sold_count: p?.sold_count ?? 0,
        image_url: p?.image_url || '',
        description: p?.description || ''
      });
      alert('✅ Saved!');
      loadData();
    }

    async function saveSettings() {
      await api('/api/admin/settings', 'POST', {
        store_name: document.getElementById('s_store_name').value,
        default_banner: document.getElementById('s_banner').value,
        support_username: document.getElementById('s_support').value,
        bkash_number: document.getElementById('s_bkash').value,
        binance_pay_id: document.getElementById('s_binance').value,
        usd_to_bdt_rate: document.getElementById('s_rate').value,
        profit_margin: document.getElementById('s_margin').value,
        supplier_base_url: document.getElementById('s_url').value,
        supplier_api_key: document.getElementById('s_key').value
      });
      alert('✅ Store Settings Saved!');
      loadData();
    }

    async function syncNow() {
      const btn = document.getElementById('syncBtn');
      btn.innerText = '⏳ Syncing...';
      try {
        const res = await api('/api/admin/sync', 'POST');
        alert(\`✅ Sync Done! Added: \${res.added}, Updated: \${res.updated}\`);
        loadData();
      } catch (e) {
        alert('❌ Sync Error: ' + e.message);
      }
      btn.innerText = '🔄 1-Click Supplier Sync';
    }

    async function delProd(id) {
      if (!confirm('Delete this product?')) return;
      await api('/api/admin/product/delete', 'POST', { id });
      loadData();
    }

    async function addProduct() {
      await api('/api/admin/product/add', 'POST', {
        emoji: document.getElementById('n_emoji').value,
        category: document.getElementById('n_cat').value,
        name: document.getElementById('n_name').value,
        price: document.getElementById('n_price').value,
        api_stock: document.getElementById('n_stock').value,
        image_url: document.getElementById('n_img').value,
        description: document.getElementById('n_desc').value,
        type: 'api'
      });
      alert('✅ Product Created!');
      loadData();
    }

    async function saveBal(tgId) {
      const bal = document.getElementById('u_bal_' + tgId).value;
      await api('/api/admin/user/balance', 'POST', { telegram_id: tgId, balance: bal });
      alert('✅ Balance Updated!');
    }

    async function sendBroadcast() {
      const message = document.getElementById('bcText').value.trim();
      if (!message) return alert('Write a message first!');
      const res = await api('/api/admin/broadcast', 'POST', { message });
      alert(\`🚀 Broadcast sent to \${res.sent} users!\`);
      document.getElementById('bcText').value = '';
    }
  </script>
</body>
</html>`);
});

// ==========================================
// 12. Safe Server & Webhook Setup
// ==========================================
app.get('/', (req, res) => res.send('Nexas Cloud Store Bot is running 24/7! Visit /admin for Visual Customizer.'));
app.use(bot.webhookCallback('/telegram-webhook'));
bot.catch((err) => console.error('Bot Error:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  const appUrl = process.env.RENDER_EXTERNAL_URL || process.env.VPS_PUBLIC_URL;
  if (appUrl) {
    const webhookUrl = `${appUrl.replace(/\/$/, '')}/telegram-webhook`;
    const connectWebhook = async () => {
      try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`🤖 Webhook active at: ${webhookUrl}`);
      } catch (err) {
        console.error('⚠️ Webhook retry in 5s...', err.message);
        setTimeout(connectWebhook, 5000);
      }
    };
    connectWebhook();
  } else {
    bot.launch({ dropPendingUpdates: true }).catch(console.error);
  }
});
