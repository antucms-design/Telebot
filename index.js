const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
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

// ড্যাশবোর্ডে লগইন করার পাসওয়ার্ড (চাইলে Render Environment-এ ADMIN_PASSWORD যোগ করতে পারেন, না দিলে WEBHOOK_SECRET বা admin123 কাজ করবে)
const ADMIN_PASS = process.env.ADMIN_PASSWORD || process.env.WEBHOOK_SECRET || 'admin123';

bot.telegram.setMyCommands([
  { command: 'start', description: 'Start and open the menu' },
  { command: 'menu', description: 'Open the main menu' },
  { command: 'products', description: 'Show products catalog' },
  { command: 'wallet', description: 'Open wallet' },
  { command: 'api', description: 'Open API access' }
]).catch(console.error);

// ==========================================
// SMART EMOJI MAPPER & HELPERS
// ==========================================
function getProductEmoji(name = '') {
  const n = name.toLowerCase();
  if (/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(name.slice(0, 4))) return '';
  if (n.includes('gemini')) return '✨ ';
  if (n.includes('youtube') || n.includes('yt')) return '▶️ ';
  if (n.includes('spotify') || n.includes('deezer') || n.includes('music')) return '🎵 ';
  if (n.includes('capcut') || n.includes('alight')) return '🎬 ';
  if (n.includes('canva') || n.includes('figma') || n.includes('adobe') || n.includes('autodesk')) return '🎨 ';
  if (n.includes('vpn') || n.includes('nord') || n.includes('hma') || n.includes('surfshark') || n.includes('v2ray') || n.includes('proxy')) return '🛡️ ';
  if (n.includes('gmail') || n.includes('mail') || n.includes('outlook')) return '📧 ';
  if (n.includes('claude') || n.includes('gpt') || n.includes('openai') || n.includes('codex') || n.includes('muse') || n.includes('replit') || n.includes('lovable') || n.includes('notion')) return '🤖 ';
  if (n.includes('telegram')) return '✈️ ';
  if (n.includes('netflix') || n.includes('prime') || n.includes('apple tv') || n.includes('shahid')) return '🍿 ';
  if (n.includes('duolingo') || n.includes('coursera') || n.includes('udemy') || n.includes('scribd') || n.includes('edu')) return '🎓 ';
  if (n.includes('elevenlabs') || n.includes('suno') || n.includes('wispr')) return '🎙️ ';
  return '📦 ';
}

function getStockStatusIcon(stock) {
  if (stock <= 0) return '🔴';
  if (stock <= 5) return '🟡';
  return '🟢';
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

// ডাটাবেস থেকে সব ডায়নামিক সেটিংস আনা
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
    support_username: data?.support_username || process.env.SUPPORT_USERNAME || '@mehedihasanantu'
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
// REUSABLE SUPPLIER SYNC ENGINE
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
    const emojiPrefix = item.emoji || item.icon ? `${item.emoji || item.icon} ` : '';
    
    let category = item.category || item.group || rawName;
    let planName = item.plan || item.variant || rawName;

    if (!item.category && rawName.includes(' - ')) {
      const parts = rawName.split(' - ');
      category = parts[0].trim();
      planName = parts.slice(1).join(' - ').trim();
    }

    if (emojiPrefix && !category.startsWith(emojiPrefix.trim())) {
      category = `${emojiPrefix}${category}`;
    }

    const basePrice = parseFloat(item.price ?? item.cost ?? 1.0);
    const sellPrice = Number((basePrice * (1 + margin / 100)).toFixed(2));
    
    const rawStock = item.stock ?? item.in_stock ?? item.stock_count ?? item.available ?? item.quantity ?? item.count;
    let stock = rawStock !== undefined && rawStock !== null ? Number(rawStock) : 50;
    if (isNaN(stock) || stock < 0) stock = 0;

    const desc = item.description || item.details || '• Instant Automated Delivery\n• Activate on your own account';

    const { data: existing } = await supabase
      .from('products')
      .select('id')
      .eq('type', 'api')
      .eq('supplier_product_id', suppId)
      .maybeSingle();

    if (existing) {
      await supabase.from('products').update({
        category, name: planName, price: sellPrice, description: desc,
        api_stock: stock, supplier_api_url: orderEndpoint, supplier_api_key: sup.supplier_api_key
      }).eq('id', existing.id);
      updated++;
    } else {
      await supabase.from('products').insert([{
        category, name: planName, price: sellPrice, description: desc,
        type: 'api', api_stock: stock, supplier_api_url: orderEndpoint,
        supplier_api_key: sup.supplier_api_key, supplier_product_id: suppId
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
// ORDER DELIVERY (LOCAL + PRODSELLER API)
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

      if (product.api_stock && product.api_stock >= qty) {
        await supabase.from('products').update({ api_stock: product.api_stock - qty }).eq('id', product.id);
      }
    } catch (err) {
      const errMsg = err.response?.data?.error || err.response?.data?.message || err.message || 'Supplier API Error';
      return {
        success: false,
        message: `❌ Supplier Error (${errMsg})! Apnar payment ($${totalUsd.toFixed(2)} USDT) apnar wallet balance-e joma kore dewa hoyeche.`
      };
    }
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

  const emoji = getProductEmoji(product.category || product.name);
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
    `${product.description || '• Activate on your own account'}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🛍️ Shop Again', 'menu_shop'),
      Markup.button.callback('👤 My Profile', 'menu_profile')
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
  const text = `Welcome to <b>${cfg.store_name}</b> ❗️\n👋🏻 Hello! ${user.name}\n\n📌 <b>Account Details</b>\n💳 Telegram ID: <code>${user.telegram_id}</code>\n💰 Balance: <b>$${Number(user.balance).toFixed(2)} USDT</b>\n\nChoose below ⬇️`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🛒 Cloud Store Catalog', 'menu_shop'), Markup.button.callback('💰 Wallet', 'menu_wallet')],
    [Markup.button.callback('🧾 Order History', 'menu_orders'), Markup.button.callback('🔄 Recover Order', 'menu_recover')],
    [Markup.button.callback('💰 Refer & Earn', 'menu_refer'), Markup.button.callback('🛡️ Profile', 'menu_profile')],
    [Markup.button.callback('🛟 Support', 'menu_support'), Markup.button.callback('🔑 API Access', 'menu_apikey')]
  ]);

  if (isEdit) return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

bot.start((ctx) => { getUser(ctx, ctx.startPayload); sendMainMenu(ctx, false); });
bot.command('menu', (ctx) => sendMainMenu(ctx, false));
bot.action('main_menu', (ctx) => { ctx.answerCbQuery(); sendMainMenu(ctx, true); });

// ==========================================
// 2. Cloud Store Catalog
// ==========================================
async function showCatalog(ctx, isEdit = true) {
  pendingCheckouts.delete(ctx.from.id);
  const { data: products } = await supabase.from('products').select('*').order('id', { ascending: true });

  if (!products || products.length === 0) {
    const emptyMsg = '🌈 <b>CLOUD STORE CATALOG</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 Currently kono product stock-e nei.\n\n<i>Admin hole /sync command diye supplier theke auto-import korun!</i>';
    const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'main_menu')]]);
    return isEdit ? ctx.editMessageText(emptyMsg, { parse_mode: 'HTML', ...kb }) : ctx.reply(emptyMsg, { parse_mode: 'HTML', ...kb });
  }

  const categories = {};
  for (const p of products) {
    const catName = p.category || p.name;
    const stock = await getProductStock(p);
    if (!categories[catName]) {
      categories[catName] = { name: catName, totalStock: 0, firstProdId: p.id };
    }
    categories[catName].totalStock += stock;
  }

  const catList = Object.values(categories);
  catList.sort((a, b) => (b.totalStock > 0 ? 1 : 0) - (a.totalStock > 0 ? 1 : 0));

  const buttons = [];
  for (let i = 0; i < catList.length; i += 2) {
    const row = [];
    const c1 = catList[i];
    const emoji1 = getProductEmoji(c1.name);
    const status1 = getStockStatusIcon(c1.totalStock);
    row.push(Markup.button.callback(`${emoji1}${c1.name} (${c1.totalStock}) ${status1}`, `cat_${c1.firstProdId}`));

    if (catList[i + 1]) {
      const c2 = catList[i + 1];
      const emoji2 = getProductEmoji(c2.name);
      const status2 = getStockStatusIcon(c2.totalStock);
      row.push(Markup.button.callback(`${emoji2}${c2.name} (${c2.totalStock}) ${status2}`, `cat_${c2.firstProdId}`));
    }
    buttons.push(row);
  }

  buttons.push([Markup.button.callback('⬅️ Back to Main Menu', 'main_menu')]);

  const text = `🌈 <b>CLOUD STORE CATALOG</b>\n━━━━━━━━━━━━━━━━━━━━\n🚀 Instant Delivery 24/7\n📦 Total Products: <b>${catList.length}</b>\n\n👇 Choose a product below :`;

  if (isEdit) return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
  return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

bot.action('menu_shop', (ctx) => { ctx.answerCbQuery(); showCatalog(ctx, true); });
bot.command('products', (ctx) => showCatalog(ctx, false));

// ==========================================
// 3. Category View & Variants
// ==========================================
bot.action(/cat_(\d+)/, async (ctx) => {
  ctx.answerCbQuery();
  pendingCheckouts.delete(ctx.from.id);
  const firstProdId = ctx.match[1];
  const { data: firstProd } = await supabase.from('products').select('*').eq('id', firstProdId).single();
  if (!firstProd) return;

  const catName = firstProd.category || firstProd.name;
  const { data: variants } = await supabase.from('products').select('*').eq('category', catName);
  const emoji = getProductEmoji(catName);

  const buttons = [];
  for (const v of (variants || [firstProd])) {
    const stock = await getProductStock(v);
    const btnIcon = getStockStatusIcon(stock);
    buttons.push([
      Markup.button.callback(`${btnIcon} ${v.name} - $${Number(v.price).toFixed(2)} USDT [Stock: ${stock}]`, `sel_${v.id}_1`)
    ]);
  }
  buttons.push([Markup.button.callback('🔙 Back to Catalog', 'menu_shop')]);

  const text = `🛒 <b>PRODUCT - ${emoji}${catName}</b>\n━━━━━━━━━━━━━━━━━━━━\n${firstProd.description || 'Instant Digital Delivery.'}\n\n⚠️ <b>Warning:</b> By purchasing, you confirm that you have read the product description and agree to our store policies. Please purchase at your own risk.\n\n👇 <b>Choose a plan/variant:</b>`;

  ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
});

// ==========================================
// 4. Quantity Selector & Payment Options
// ==========================================
bot.action(/sel_(\d+)_(\d+)/, async (ctx) => {
  ctx.answerCbQuery();
  pendingCheckouts.delete(ctx.from.id);
  const prodId = Number(ctx.match[1]);
  let qty = Number(ctx.match[2]);
  if (qty < 1) qty = 1;

  const user = await getUser(ctx);
  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).single();
  if (!product) return;

  const stock = await getProductStock(product);
  if (qty > stock && stock > 0) qty = stock;

  const totalPrice = (Number(product.price) * qty).toFixed(2);
  const minusQty = qty > 1 ? qty - 1 : 1;
  const plusQty = stock > qty ? qty + 1 : qty;
  const emoji = getProductEmoji(product.category || product.name);

  const text = `${emoji}<b>${product.category} - ${product.name}</b>\n━━━━━━━━━━━━━━━━━━━━\n💲 <b>Price:</b> $${Number(product.price).toFixed(2)} USDT per unit\n📦 <b>Stock:</b> ${stock} available\n👛 <b>Your Wallet Balance:</b> $${Number(user.balance).toFixed(2)} USDT\n\n📋 <b>Details:</b>\n${product.description}\n\n🧮 <b>Select Quantity:</b>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('5', `sel_${prodId}_5`),
      Markup.button.callback('10', `sel_${prodId}_10`),
      Markup.button.callback('50', `sel_${prodId}_50`),
      Markup.button.callback('100', `sel_${prodId}_100`)
    ],
    [
      Markup.button.callback('➖', `sel_${prodId}_${minusQty}`),
      Markup.button.callback(`Qty: ${qty}`, `noop`),
      Markup.button.callback('➕', `sel_${prodId}_${plusQty}`)
    ],
    [Markup.button.callback(`👛 Pay with Balance ($${totalPrice} USDT)`, `buy_${prodId}_${qty}`)],
    [Markup.button.callback(`🟡 Pay with Binance ($${totalPrice} USDT)`, `chk_bn_${prodId}_${qty}`)],
    [Markup.button.callback(`📱 Pay with bKash ($${totalPrice} USDT)`, `chk_bk_${prodId}_${qty}`)],
    [Markup.button.callback('⬅️ Back to Plans', `cat_${prodId}`)]
  ]);

  ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
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
  const emoji = getProductEmoji(product.category || product.name);

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
      `🎁 <b>Item:</b> ${emoji}${product.category}\n` +
      `🏅 <b>Plan:</b> ${product.name}\n` +
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

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❓ Where is my Order ID?', 'help_orderid')],
        [Markup.button.callback('❌ Cancel Order', `sel_${prodId}_${qty}`)]
      ])
    }).catch(() => {});
  } else {
    const text =
      `💳 <b>CHECKOUT & PAYMENT INSTRUCTIONS</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🎁 <b>Item:</b> ${emoji}${product.category}\n` +
      `🏅 <b>Plan:</b> ${product.name}\n` +
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

    ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel Order', `sel_${prodId}_${qty}`)]
      ])
    }).catch(() => {});
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

  ctx.editMessageText(result.message, {
    parse_mode: 'HTML',
    ...result.keyboard
  }).catch(() => {});
});

// ==========================================
// 7. Wallet Deposit & SMS Webhook
// ==========================================
async function showWallet(ctx, isEdit = true) {
  pendingCheckouts.delete(ctx.from.id);
  const user = await getUser(ctx);
  const text = `💰 <b>YOUR WALLET</b>\n━━━━━━━━━━━━━━━━━━━━\n💳 <b>Telegram ID:</b> <code>${user.telegram_id}</code>\n💵 <b>Current Balance:</b> <b>$${Number(user.balance).toFixed(2)} USDT</b>\n\n👇 Choose deposit method:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🟡 Binance Pay (Auto)', 'dep_binance'), Markup.button.callback('📱 Personal bKash (Auto)', 'dep_bkash')],
    [Markup.button.callback('⬅️ Back to Main Menu', 'main_menu')]
  ]);
  return isEdit ? ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }) : ctx.reply(text, { parse_mode: 'HTML', ...kb });
}

bot.action('menu_wallet', (ctx) => { ctx.answerCbQuery(); showWallet(ctx, true); });
bot.command('wallet', (ctx) => showWallet(ctx, false));

bot.action('dep_binance', async (ctx) => {
  ctx.answerCbQuery();
  const cfg = await getSupplierConfig();
  pendingCheckouts.set(ctx.from.id, { type: 'wallet', method: 'binance', expiresAt: Date.now() + 10 * 60 * 1000 });
  ctx.editMessageText(
    `🟡 <b>WALLET DEPOSIT - BINANCE PAY</b>\n━━━━━━━━━━━━━━━━━━━━\n1️⃣ Open Binance App ➔ <b>Pay ➔ Send</b>\n2️⃣ Send USDT to Binance ID: <code>${cfg.binance_pay_id}</code>\n\n✅ <b>AFTER PAYING:</b>\nSend your <b>Transfer Order ID</b> directly in this chat!\n━━━━━━━━━━━━━━━━━━━━\n🕒 <b>Waiting for your Order ID •••</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'menu_wallet')]]) }
  );
});

bot.action('dep_bkash', async (ctx) => {
  ctx.answerCbQuery();
  const cfg = await getSupplierConfig();
  pendingCheckouts.set(ctx.from.id, { type: 'wallet', method: 'bkash', expiresAt: Date.now() + 10 * 60 * 1000 });
  ctx.editMessageText(
    `📱 <b>WALLET DEPOSIT - PERSONAL BKASH</b>\n━━━━━━━━━━━━━━━━━━━━\n📞 <b>bKash Number:</b> <code>${cfg.bkash_number}</code>\n💱 <b>Rate:</b> $1 = ${cfg.usd_to_bdt_rate} BDT\n\n✅ <b>AFTER PAYING:</b>\nSend your <b>bKash TrxID</b> directly in this chat!\n━━━━━━━━━━━━━━━━━━━━\n🕒 <b>Waiting for your TrxID •••</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'menu_wallet')]]) }
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
  ctx.editMessageText(`🔑 <b>Reseller API Key</b>\n\n<code>${user.api_key}</code>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.action('menu_orders', async (ctx) => {
  ctx.answerCbQuery();
  const { data: orders } = await supabase.from('orders').select('*').eq('telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(5);
  if (!orders || orders.length === 0) return ctx.editMessageText('🧾 Kono order pawa jayni.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]));
  let text = '🧾 <b>Recent Orders:</b>\n\n';
  orders.forEach(o => { text += `🔹 <code>${o.id}</code> | ${o.product_name} ($${o.price})\n🔑 <code>${o.delivered_data}</code>\n\n`; });
  ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.action('menu_refer', async (ctx) => {
  ctx.answerCbQuery();
  const user = await getUser(ctx);
  const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', user.telegram_id);
  ctx.editMessageText(`💰 <b>Refer & Earn</b>\n\n👥 Total Referrals: ${count || 0}\n🔗 Link: <code>https://t.me/${process.env.BOT_USERNAME.replace('@','')}?start=${user.telegram_id}</code>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.action('menu_profile', async (ctx) => {
  ctx.answerCbQuery();
  const user = await getUser(ctx);
  ctx.editMessageText(`🛡️ <b>My Profile</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>Name:</b> ${user.name}\n🆔 <b>Telegram ID:</b> <code>${user.telegram_id}</code>\n💰 <b>Balance:</b> $${Number(user.balance).toFixed(2)} USDT`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🛍️ Shop Catalog', 'menu_shop'), Markup.button.callback('💰 Deposit', 'menu_wallet')],
      [Markup.button.callback('⬅️ Main Menu', 'main_menu')]
    ])
  });
});

bot.action('menu_support', async (ctx) => {
  ctx.answerCbQuery();
  const cfg = await getSupplierConfig();
  ctx.editMessageText(`🛟 Support: ${cfg.support_username}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.action('menu_recover', (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText('🔄 Order recover korte din: <code>/recover ORD-XXXX</code>', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
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
    `🖥️ <b>Web Admin Dashboard:</b>\n${appUrl ? `${appUrl}/admin` : ' `/admin` route on your server'}`,
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

bot.command('setsupplier', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/setsupplier ', '').split('|').map(s => s.trim());
  if (args.length < 2) {
    return ctx.reply('Format:\n<code>/setsupplier https://prodseller.com | psk_your_key | 20</code>', { parse_mode: 'HTML' });
  }

  const [url, key, margin = '20'] = args;
  await supabase.from('settings').upsert([{
    id: 1,
    supplier_base_url: url.replace(/\/$/, ''),
    supplier_api_key: key,
    profit_margin: parseFloat(margin)
  }]);

  ctx.reply(`✅ <b>Supplier Updated!</b> Ekhon <code>/sync</code> command din!`, { parse_mode: 'HTML' });
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

bot.command('addprod', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/addprod ', '').split('|').map(s => s.trim());
  if (args.length < 4) return ctx.reply('Format:\n/addprod Category | Plan Name | Price | Details | [local/api]');
  const [category, name, price, description, type = 'local', url = null, key = null, prodId = null] = args;
  
  const { data, error } = await supabase.from('products').insert([{
    category, name, price: parseFloat(price), description, type, supplier_api_url: url, supplier_api_key: key, supplier_product_id: prodId
  }]).select();
  if (error) return ctx.reply('Error: ' + error.message);
  ctx.reply(`✅ Added! [${category} -> ${name}] | Product ID: ${data[0].id}`);
});

bot.command('addstock', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/addstock ', '').split('|').map(s => s.trim());
  if (args.length < 2) return ctx.reply('Format: /addstock ProductID | Link');
  await supabase.from('stock').insert([{ product_id: parseInt(args[0]), data: args[1] }]);
  ctx.reply(`✅ Stock added to Product ID ${args[0]}!`);
});

bot.command('bulkstock', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const lines = ctx.message.text.split('\n').map(l => l.trim()).filter(Boolean);
  const prodId = parseInt(lines[0].replace('/bulkstock', '').trim());
  if (!prodId || lines.length < 2) return ctx.reply('Format:\n/bulkstock ProductID\nlink1\nlink2');

  const items = lines.slice(1).map(data => ({ product_id: prodId, data }));
  await supabase.from('stock').insert(items);
  ctx.reply(`✅ ${items.length}ti stock Product ID ${prodId}-e add hoyeche!`);
});

bot.command('addbal', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/addbal ', '').split('|').map(s => s.trim());
  if (args.length < 2) return ctx.reply('Format: /addbal TelegramID | Amount');
  const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', args[0]).single();
  if (!user) return ctx.reply('User not found.');
  const newBal = Number(user.balance) + parseFloat(args[1]);
  await supabase.from('users').update({ balance: newBal }).eq('telegram_id', args[0]);
  ctx.reply(`✅ Added $${args[1]} to ${args[0]}`);
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
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🛍️ Shop Now', 'menu_shop'), Markup.button.callback('👤 My Profile', 'menu_profile')]]) }
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
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🛍️ Shop Now', 'menu_shop'), Markup.button.callback('👤 My Profile', 'menu_profile')]]) }
      );
    }
  }
});

// ==========================================
// 11. BUILT-IN WEB ADMIN DASHBOARD (/admin)
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
  const { store_name, supplier_base_url, supplier_api_key, profit_margin, usd_to_bdt_rate, bkash_number, binance_pay_id, support_username } = req.body;
  const { error } = await supabase.from('settings').upsert([{
    id: 1,
    store_name,
    supplier_base_url: supplier_base_url.replace(/\/$/, ''),
    supplier_api_key,
    profit_margin: parseFloat(profit_margin),
    usd_to_bdt_rate: parseFloat(usd_to_bdt_rate),
    bkash_number,
    binance_pay_id,
    support_username
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
  const { id, category, name, price, api_stock, description } = req.body;
  const { error } = await supabase.from('products').update({
    category, name, price: parseFloat(price), api_stock: parseInt(api_stock), description
  }).eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/admin/product/add', verifyAdminReq, async (req, res) => {
  const { category, name, price, description, type, api_stock } = req.body;
  const { error } = await supabase.from('products').insert([{
    category, name, price: parseFloat(price), description, type: type || 'local', api_stock: parseInt(api_stock || 0)
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
  <title>Nexas Store — Admin Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans">
  <!-- Login Modal -->
  <div id="loginScreen" class="fixed inset-0 bg-slate-950 flex items-center justify-center p-4 z-50">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
      <h1 class="text-xl font-bold text-center mb-2">🛡️ Nexas Admin Panel</h1>
      <p class="text-xs text-slate-400 text-center mb-5">Enter your ADMIN_PASSWORD or WEBHOOK_SECRET</p>
      <input id="passInput" type="password" placeholder="Admin Password" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 mb-4 text-sm focus:outline-none focus:border-indigo-500" />
      <button onclick="login()" class="w-full bg-indigo-600 hover:bg-indigo-500 font-semibold py-2.5 rounded-xl text-sm transition">Login to Dashboard</button>
    </div>
  </div>

  <!-- Main Dashboard -->
  <div id="appScreen" class="hidden max-w-7xl mx-auto p-4 md:p-6">
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-white">⚡ Nexas Bot Control Panel</h1>
        <p class="text-xs text-slate-400">Customize your Telegram Bot in real-time</p>
      </div>
      <div class="flex gap-2">
        <button onclick="syncNow()" id="syncBtn" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl text-xs font-semibold transition">🔄 1-Click Supplier Sync</button>
        <button onclick="loadData()" class="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-xs font-semibold transition">↻ Refresh</button>
        <button onclick="logout()" class="bg-rose-600/20 text-rose-400 hover:bg-rose-600/30 px-3 py-2 rounded-xl text-xs font-semibold">Logout</button>
      </div>
    </div>

    <!-- Stats Row -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
        <p class="text-xs text-slate-400">Total Products</p>
        <h2 id="statProducts" class="text-2xl font-bold mt-1">0</h2>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
        <p class="text-xs text-slate-400">Total Users</p>
        <h2 id="statUsers" class="text-2xl font-bold mt-1">0</h2>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
        <p class="text-xs text-slate-400">Recent Orders</p>
        <h2 id="statOrders" class="text-2xl font-bold mt-1">0</h2>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
        <p class="text-xs text-slate-400">Profit Margin</p>
        <h2 id="statMargin" class="text-2xl font-bold mt-1 text-emerald-400">0%</h2>
      </div>
    </div>

    <!-- Settings & Broadcast Grid -->
    <div class="grid md:grid-cols-3 gap-6 mb-8">
      <div class="md:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h3 class="font-bold text-base mb-4">⚙️ Store, Payment & Supplier Settings</h3>
        <div class="grid sm:grid-cols-2 gap-3 text-xs">
          <div>
            <label class="text-slate-400 block mb-1">Store Name</label>
            <input id="s_store_name" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-slate-400 block mb-1">Support Username</label>
            <input id="s_support" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
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
        <button onclick="saveSettings()" class="mt-4 bg-indigo-600 hover:bg-indigo-500 px-5 py-2.5 rounded-xl text-xs font-semibold">💾 Save All Settings</button>
      </div>

      <!-- Broadcast & Add Product -->
      <div class="space-y-6">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h3 class="font-bold text-base mb-2">📢 Broadcast to All Users</h3>
          <textarea id="bcText" rows="3" placeholder="Write announcement or offer (HTML supported)..." class="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-xs mb-3"></textarea>
          <button onclick="sendBroadcast()" class="w-full bg-amber-600 hover:bg-amber-500 py-2 rounded-xl text-xs font-semibold">🚀 Send Broadcast</button>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h3 class="font-bold text-base mb-3">➕ Add Custom Product</h3>
          <div class="space-y-2 text-xs">
            <input id="n_cat" placeholder="Category (e.g. Gemini Pro)" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            <input id="n_name" placeholder="Plan Name (e.g. 1 Year Link)" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            <div class="grid grid-cols-2 gap-2">
              <input id="n_price" type="number" step="0.01" placeholder="Price ($)" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
              <input id="n_stock" type="number" placeholder="Stock" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2" />
            </div>
            <button onclick="addProduct()" class="w-full bg-emerald-600 hover:bg-emerald-500 py-2 rounded-xl font-semibold">Add Product</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Products Manager Table -->
    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-8">
      <h3 class="font-bold text-base mb-4">🛍️ Products Manager (Edit Price, Name or Stock directly)</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="text-slate-400 border-b border-slate-800">
            <tr>
              <th class="pb-2">ID</th>
              <th class="pb-2">Category</th>
              <th class="pb-2">Plan Name</th>
              <th class="pb-2">Price ($ USDT)</th>
              <th class="pb-2">Stock</th>
              <th class="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody id="productsTable" class="divide-y divide-slate-800"></tbody>
        </table>
      </div>
    </div>

    <!-- Users & Recent Orders -->
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
      document.getElementById('s_support').value = s.support_username || '';
      document.getElementById('s_bkash').value = s.bkash_number || '';
      document.getElementById('s_binance').value = s.binance_pay_id || '';
      document.getElementById('s_rate').value = s.usd_to_bdt_rate || 130;
      document.getElementById('s_margin').value = s.profit_margin ?? 20;
      document.getElementById('s_url').value = s.supplier_base_url || '';
      document.getElementById('s_key').value = s.supplier_api_key || '';

      document.getElementById('statProducts').innerText = data.products.length;
      document.getElementById('statUsers').innerText = data.users.length;
      document.getElementById('statOrders').innerText = data.orders.length;
      document.getElementById('statMargin').innerText = (s.profit_margin ?? 20) + '%';

      const pBody = document.getElementById('productsTable');
      pBody.innerHTML = data.products.map(p => \`
        <tr class="hover:bg-slate-800/40">
          <td class="py-2 pr-2 font-mono">\${p.id}</td>
          <td class="py-2 pr-2"><input id="p_cat_\${p.id}" value="\${(p.category||'').replace(/"/g, '&quot;')}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-40" /></td>
          <td class="py-2 pr-2"><input id="p_name_\${p.id}" value="\${(p.name||'').replace(/"/g, '&quot;')}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-44" /></td>
          <td class="py-2 pr-2"><input id="p_price_\${p.id}" type="number" step="0.01" value="\${p.price}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-20" /></td>
          <td class="py-2 pr-2"><input id="p_stock_\${p.id}" type="number" value="\${p.api_stock ?? 0}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 w-20" /></td>
          <td class="py-2 space-x-1">
            <button onclick="saveProd(\${p.id})" class="bg-indigo-600 hover:bg-indigo-500 px-2.5 py-1 rounded font-semibold">Save</button>
            <button onclick="delProd(\${p.id})" class="bg-rose-600/30 text-rose-300 hover:bg-rose-600 px-2 py-1 rounded">Del</button>
          </td>
        </tr>
      \`).join('');

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

    async function saveSettings() {
      await api('/api/admin/settings', 'POST', {
        store_name: document.getElementById('s_store_name').value,
        support_username: document.getElementById('s_support').value,
        bkash_number: document.getElementById('s_bkash').value,
        binance_pay_id: document.getElementById('s_binance').value,
        usd_to_bdt_rate: document.getElementById('s_rate').value,
        profit_margin: document.getElementById('s_margin').value,
        supplier_base_url: document.getElementById('s_url').value,
        supplier_api_key: document.getElementById('s_key').value
      });
      alert('✅ Settings Saved Successfully!');
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

    async function saveProd(id) {
      await api('/api/admin/product/update', 'POST', {
        id,
        category: document.getElementById('p_cat_' + id).value,
        name: document.getElementById('p_name_' + id).value,
        price: document.getElementById('p_price_' + id).value,
        api_stock: document.getElementById('p_stock_' + id).value
      });
      alert('✅ Product Updated!');
    }

    async function delProd(id) {
      if (!confirm('Delete this product?')) return;
      await api('/api/admin/product/delete', 'POST', { id });
      loadData();
    }

    async function addProduct() {
      await api('/api/admin/product/add', 'POST', {
        category: document.getElementById('n_cat').value,
        name: document.getElementById('n_name').value,
        price: document.getElementById('n_price').value,
        api_stock: document.getElementById('n_stock').value,
        type: 'api',
        description: '• Instant Automated Delivery'
      });
      alert('✅ Product Added!');
      loadData();
    }

    async function saveBal(tgId) {
      const bal = document.getElementById('u_bal_' + tgId).value;
      await api('/api/admin/user/balance', 'POST', { telegram_id: tgId, balance: bal });
      alert('✅ User Balance Updated!');
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
app.get('/', (req, res) => res.send('Nexas Cloud Store Bot is running 24/7! Visit /admin for Control Panel.'));
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
