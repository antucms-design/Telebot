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
// styles: 'success' (Green), 'danger' (Red), 'primary' (Blue)
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

// অ্যাডমিনকে তাৎক্ষণিক অ্যালার্ট পাঠানোর ফাংশন
async function notifyAdmin(htmlMessage) {
  const adminId = process.env.ADMIN_ID;
  if (!adminId) return;
  try {
    await bot.telegram.sendMessage(adminId, htmlMessage, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Admin Notify Error:', e.message);
  }
}

// নিরাপদে ইউজারের ওয়ালেটে ব্যালেন্স যোগ করার ফাংশন (Race-Condition & Bug Free)
async function creditUserBalance(telegramId, amountToAdd) {
  const addVal = Number(amountToAdd);
  if (Number.isNaN(addVal) || addVal === 0) return 0;
  const { data: freshUser } = await supabase
    .from('users')
    .select('balance')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  const currentBal = Number(freshUser?.balance || 0);
  const newBal = Number((currentBal + addVal).toFixed(2));
  await supabase.from('users').update({ balance: newBal }).eq('telegram_id', telegramId);
  return newBal;
}

// ==========================================
// SMART EMOJI & SCREEN RENDER HELPERS
// ==========================================
function getProductEmoji(productOrName = '', customEmoji = '') {
  if (customEmoji && customEmoji.trim() !== '') return customEmoji.trim() + ' ';
  const name = typeof productOrName === 'object' ? (productOrName.category || productOrName.name || '') : productOrName;
  if (typeof productOrName === 'object' && productOrName.emoji && productOrName.emoji.trim() !== '') {
    return productOrName.emoji.trim() + ' ';
  }

  const n = String(name).toLowerCase();
  if (/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(String(name).slice(0, 4))) return '';
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

  let { data: user } = await supabase.from('users').select('*').eq('telegram_id', tgId).maybeSingle();

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
  const { data } = await supabase.from('settings').select('*').eq('id', 1).maybeSingle();
  return {
    supplier_base_url: data?.supplier_base_url || 'https://prodseller.com',
    supplier_api_key: data?.supplier_api_key || 'psk_701f79a0c971f198abbcdc3978e5804b2b8b587f239be728',
    profit_margin: data?.profit_margin !== undefined && data?.profit_margin !== null ? Number(data.profit_margin) : 20,
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
  if (!product) return 0;
  if (product.type === 'api') {
    const s = Number(product.api_stock);
    return Number.isNaN(s) || s < 0 ? 0 : s;
  }
  const { count } = await supabase
    .from('stock')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', product.id)
    .eq('is_sold', false);
  if (count && count > 0) return count;
  const manualStock = Number(product.api_stock);
  return Number.isNaN(manualStock) || manualStock < 0 ? 0 : manualStock;
}

// ==========================================
// SUPPLIER SYNC ENGINE (SAFE & FAULT-TOLERANT)
// ==========================================
async function runSupplierSync() {
  const sup = await getSupplierConfig();
  const baseUrl = sup.supplier_base_url.replace(/\/$/, '');
  
  let res;
  try {
    res = await axios.get(`${baseUrl}/v1/products`, {
      headers: { 'X-API-Key': sup.supplier_api_key, 'Authorization': `Bearer ${sup.supplier_api_key}` },
      timeout: 15000
    });
  } catch (err1) {
    res = await axios.get(`${baseUrl}/api/v1/products`, {
      headers: { 'X-API-Key': sup.supplier_api_key, 'Authorization': `Bearer ${sup.supplier_api_key}` },
      timeout: 15000
    });
  }

  const list = Array.isArray(res.data) ? res.data : (res.data.products || res.data.data || []);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Supplier theke kono product pawa jayni.');
  }

  const margin = Number.isNaN(Number(sup.profit_margin)) ? 20 : Number(sup.profit_margin);
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
    let stock = rawStock !== undefined && rawStock !== null ? Number(rawStock) : 0;
    if (Number.isNaN(stock) || stock < 0) stock = 0;

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
      const fullInsert = {
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
      };
      const { error: inErr } = await supabase.from('products').insert([fullInsert]);
      if (inErr) {
        await supabase.from('products').insert([{
          category,
          name: planName,
          price: sellPrice,
          description: desc,
          type: 'api',
          api_stock: stock,
          supplier_api_url: orderEndpoint,
          supplier_api_key: sup.supplier_api_key,
          supplier_product_id: suppId
        }]);
      }
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
        errorReason: 'Local Stock Out',
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
        { headers, timeout: 20000 }
      );

      const resData = response.data;
      deliveredItems = extractRealDeliveryItems(resData);

      const supOrderId = resData.id || resData.orderId || resData.order_id || resData.order?.id || resData.data?.id;
      if (deliveredItems.length === 0 && supOrderId) {
        try {
          const statusRes = await axios.get(`${baseUrl}/v1/orders/${supOrderId}`, { headers, timeout: 15000 });
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
        errorReason: errMsg,
        message: `❌ Supplier Error (${errMsg})! Apnar payment ($${totalUsd.toFixed(2)} USDT) apnar wallet balance-e joma kore dewa hoyeche.`
      };
    }
  }

  const newSold = Number(product.sold_count || 0) + Number(qty);
  const currentStock = Number(product.api_stock || 0);
  const newApiStock = currentStock >= qty ? currentStock - qty : 0;
  const { error: upErr } = await supabase.from('products').update({ sold_count: newSold, api_stock: newApiStock }).eq('id', product.id);
  if (upErr) {
    await supabase.from('products').update({ api_stock: newApiStock }).eq('id', product.id);
  }

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

  return { success: true, orderId, deliveredText, message: msg, keyboard };
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
  catList.sort((a, b) => (b.totalStock > 0 ? 1 : 0) - (a.totalStock > 0 ? 1 : 0));

  const buttons = [];
  for (let i = 0; i < catList.length; i += 2) {
    const row = [];
    const c1 = catList[i];
    const hasCustomIcon1 = c1.firstProd.custom_emoji_id && String(c1.firstProd.custom_emoji_id).trim() !== '';
    const emoji1 = hasCustomIcon1 ? '' : getProductEmoji(c1.firstProd);
    const style1 = c1.totalStock > 0 ? 'success' : 'danger';
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
// 3. Category View & Variants
// ==========================================
bot.action(/cat_(\d+)/, async (ctx) => {
  ctx.answerCbQuery();
  pendingCheckouts.delete(ctx.from.id);
  const firstProdId = Number(ctx.match[1]);
  const { data: firstProd } = await supabase.from('products').select('*').eq('id', firstProdId).maybeSingle();
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
// 4. Excalibur-Style Product Card
// ==========================================
async function showProductView(ctx, prodId, qty = 1, isEdit = true, fromCatalog = false) {
  pendingCheckouts.delete(ctx.from.id);
  if (qty < 1) qty = 1;

  const cfg = await getSupplierConfig();
  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).maybeSingle();
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
  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).maybeSingle();
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
// 5. DIRECT CHECKOUT INSTRUCTIONS (30 Min Expiry)
// ==========================================
bot.action(/chk_(bn|bk)_(\d+)_(\d+)/, async (ctx) => {
  const method = ctx.match[1];
  const prodId = Number(ctx.match[2]);
  const qty = Number(ctx.match[3]);

  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).maybeSingle();
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

  // সেশন ৩০ মিনিট পর্যন্ত অ্যাক্টিভ থাকবে যাতে ইউজার দেরি করলেও সমস্যা না হয়
  pendingCheckouts.set(ctx.from.id, {
    type: 'product',
    method: method === 'bn' ? 'binance' : 'bkash',
    prodId,
    qty,
    totalUsd,
    totalBdt,
    expiresAt: Date.now() + 30 * 60 * 1000
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
      `🕒 <b>Waiting for your Transfer Order ID •••</b>`;

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
      `🕒 <b>Waiting for your bKash TrxID •••</b>`;

    return renderScreen(ctx, text, kbMarkup([
      [cBtn('❌ Cancel Order', `sel_${prodId}_${qty}`, 'danger')]
    ]), null, true);
  }
});

bot.action('help_orderid', (ctx) => {
  ctx.answerCbQuery('Binance App ➔ Pay ➔ Transaction History ➔ Tap on payment ➔ Copy the "Order ID" and send it directly in this chat!', { show_alert: true });
});

// ==========================================
// 6. Pay with Wallet Balance (100% Refund Protected + Admin Alert)
// ==========================================
bot.action(/buy_(\d+)_(\d+)/, async (ctx) => {
  const prodId = Number(ctx.match[1]);
  const qty = Number(ctx.match[2]);
  const user = await getUser(ctx);

  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).maybeSingle();
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
    await notifyAdmin(
      `⚠️ <b>WALLET ORDER FAILED (Balance Kept Safe)</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${user.name} (<code>${user.telegram_id}</code>)\n` +
      `🛍️ <b>Product:</b> ${product.name} x${qty}\n` +
      `💰 <b>Amount:</b> $${totalPrice.toFixed(2)} USDT\n` +
      `❌ <b>Reason:</b> ${result.errorReason || result.message}`
    );
    return ctx.reply(
      `❌ <b>Order Failed (${result.errorReason || 'Supplier Error'})!</b>\n` +
      `Apnar wallet balance ($${Number(user.balance).toFixed(2)} USDT) sompurno surakkhito ache (kono taka kata hoyni).`,
      { parse_mode: 'HTML' }
    );
  }

  // শুধুমাত্র ডেলিভারি সফল হলেই ওয়ালেট থেকে টাকা কাটবে
  await creditUserBalance(user.telegram_id, -totalPrice);

  await notifyAdmin(
    `✅ <b>NEW ORDER DELIVERED (Wallet)</b>\n` +
    `👤 <b>User:</b> ${user.name} (<code>${user.telegram_id}</code>)\n` +
    `🛍️ <b>Item:</b> ${product.name} x${qty}\n` +
    `💰 <b>Paid:</b> $${totalPrice.toFixed(2)} USDT`
  );

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
  pendingCheckouts.set(ctx.from.id, { type: 'wallet', method: 'binance', expiresAt: Date.now() + 30 * 60 * 1000 });
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
  pendingCheckouts.set(ctx.from.id, { type: 'wallet', method: 'bkash', expiresAt: Date.now() + 30 * 60 * 1000 });
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
  const amountMatch = String(message || '').match(/(?:Tk|BDT)\s*([0-9,.]+)/i);
  const trxMatch = String(message || '').match(/(?:TrxID|TxnID)[:\s]*([A-Z0-9]+)/i);
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
  orders.forEach(o => { text
