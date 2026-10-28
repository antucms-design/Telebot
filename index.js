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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const pendingCheckouts = new Map();

bot.telegram.setMyCommands([
  { command: 'start', description: 'Start and open the menu' },
  { command: 'menu', description: 'Open the main menu' },
  { command: 'products', description: 'Show products catalog' },
  { command: 'wallet', description: 'Open wallet' },
  { command: 'api', description: 'Open API access' }
]).catch(console.error);

// ==========================================
// SMART EMOJI MAPPER & CATEGORY PARSER
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

async function getSupplierConfig() {
  const { data } = await supabase.from('settings').select('*').eq('id', 1).single();
  return data || {
    supplier_base_url: 'https://prodseller.com',
    supplier_api_key: 'psk_701f79a0c971f198abbcdc3978e5804b2b8b587f239be728',
    profit_margin: 20
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
// ORDER DELIVERY (LOCAL + PRODSELLER API FIXED)
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

      // ProdSeller ও অন্যান্য সব সাপ্লায়ারের জন্য productId এবং product_id দুটোই পাঠানো হচ্ছে
      const response = await axios.post(
        orderUrl,
        {
          productId: parsedProdId,
          product_id: parsedProdId,
          quantity: Number(qty),
          qty: Number(qty)
        },
        {
          headers: {
            'X-API-Key': apiKey,
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const resData = response.data;
      const rawItems =
        resData.data ||
        resData.items ||
        resData.keys ||
        resData.links ||
        resData.accounts ||
        resData.code ||
        resData.link ||
        resData.content ||
        resData.delivery ||
        resData.order?.items ||
        resData.order?.data ||
        resData.order?.keys ||
        resData.order?.content;
      
      if (!rawItems) throw new Error('Empty delivery from supplier');

      if (Array.isArray(rawItems)) {
        deliveredItems = rawItems.map(item =>
          typeof item === 'object'
            ? item.data || item.key || item.link || item.code || item.content || item.account || JSON.stringify(item)
            : item
        );
      } else if (typeof rawItems === 'object') {
        deliveredItems = [
          rawItems.data || rawItems.key || rawItems.link || rawItems.content || JSON.stringify(rawItems)
        ];
      } else {
        deliveredItems = [String(rawItems)];
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
  const text = `Welcome to <b>Nexas Cloud Store</b> ❗️\n👋🏻 Hello! ${user.name}\n\n📌 <b>Account Details</b>\n💳 Telegram ID: <code>${user.telegram_id}</code>\n💰 Balance: <b>$${Number(user.balance).toFixed(2)} USDT</b>\n\nChoose below ⬇️`;

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
// 2. Cloud Store Catalog (With Brand Emoji + Real Stock)
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
      categories[catName] = {
        name: catName,
        totalStock: 0,
        firstProdId: p.id,
        planCount: 0,
        minPrice: Number(p.price)
      };
    }
    categories[catName].totalStock += stock;
    categories[catName].planCount += 1;
    if (Number(p.price) < categories[catName].minPrice) {
      categories[catName].minPrice = Number(p.price);
    }
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
  const totalUsd = Number((Number(product.price) * qty).toFixed(2));
  const rate = parseFloat(process.env.USD_TO_BDT_RATE || 130);
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
      `3️⃣ Send to Binance ID: <code>${process.env.BINANCE_PAY_ID}</code> <i>(Tap to copy)</i>\n` +
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
      `3️⃣ Send to Personal Number: <code>${process.env.MY_BKASH_NUMBER}</code> <i>(Tap to copy)</i>\n` +
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

bot.action('dep_binance', (ctx) => {
  ctx.answerCbQuery();
  pendingCheckouts.set(ctx.from.id, { type: 'wallet', method: 'binance', expiresAt: Date.now() + 10 * 60 * 1000 });
  ctx.editMessageText(
    `🟡 <b>WALLET DEPOSIT - BINANCE PAY</b>\n━━━━━━━━━━━━━━━━━━━━\n1️⃣ Open Binance App ➔ <b>Pay ➔ Send</b>\n2️⃣ Send USDT to Binance ID: <code>${process.env.BINANCE_PAY_ID}</code>\n\n✅ <b>AFTER PAYING:</b>\nSend your <b>Transfer Order ID</b> directly in this chat!\n━━━━━━━━━━━━━━━━━━━━\n🕒 <b>Waiting for your Order ID •••</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'menu_wallet')]]) }
  );
});

bot.action('dep_bkash', (ctx) => {
  ctx.answerCbQuery();
  const rate = process.env.USD_TO_BDT_RATE || 130;
  pendingCheckouts.set(ctx.from.id, { type: 'wallet', method: 'bkash', expiresAt: Date.now() + 10 * 60 * 1000 });
  ctx.editMessageText(
    `📱 <b>WALLET DEPOSIT - PERSONAL BKASH</b>\n━━━━━━━━━━━━━━━━━━━━\n📞 <b>bKash Number:</b> <code>${process.env.MY_BKASH_NUMBER}</code>\n💱 <b>Rate:</b> $1 = ${rate} BDT\n\n✅ <b>AFTER PAYING:</b>\nSend your <b>bKash TrxID</b> directly in this chat!\n━━━━━━━━━━━━━━━━━━━━\n🕒 <b>Waiting for your TrxID •••</b>`,
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

bot.action('menu_support', (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(`🛟 Support: ${process.env.SUPPORT_USERNAME}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
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
// 9. ADMIN COMMANDS: SUPPLIER MANAGER & REAL STOCK SYNC
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

  ctx.reply(
    `⚙️ <b>CURRENT SUPPLIER SETTINGS</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `🌐 <b>Base URL:</b> <code>${sup.supplier_base_url}</code>\n` +
    `🔑 <b>API Key:</b> <code>${sup.supplier_api_key}</code>\n` +
    `📈 <b>Profit Margin:</b> <code>${sup.profit_margin}%</code>\n` +
    `💰 <b>Supplier Balance:</b> <b>${balText}</b>\n\n` +
    `📌 <b>Useful Admin Commands:</b>\n` +
    `• <code>/sync</code> — Auto-import/update all products\n` +
    `• <code>/setsupplier URL | API_KEY | PROFIT%</code> — Change supplier anytime\n` +
    `• <code>/clearapi</code> — Delete all API products`,
    { parse_mode: 'HTML' }
  );
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

  ctx.reply(`✅ <b>Supplier Updated Successfully!</b>\n\n🌐 URL: <code>${url}</code>\n📈 Profit Margin: <b>${margin}%</b>\n\nEkhon <code>/sync</code> command din!`, { parse_mode: 'HTML' });
});

bot.command('sync', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const wait = await ctx.reply('🔄 <b>Syncing products & real stock from supplier...</b>', { parse_mode: 'HTML' });

  try {
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
      return ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, null, '❌ Supplier theke kono product pawa jayni.');
    }

    const margin = parseFloat(sup.profit_margin || 0);
    const orderEndpoint = `${baseUrl}/v1/orders`;
    let added = 0;
    let updated = 0;
    let dbErrorMsg = null;

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
        const { error: upErr } = await supabase.from('products').update({
          category,
          name: planName,
          price: sellPrice,
          description: desc,
          api_stock: stock,
          supplier_api_url: orderEndpoint,
          supplier_api_key: sup.supplier_api_key
        }).eq('id', existing.id);
        if (upErr) dbErrorMsg = upErr.message;
        else updated++;
      } else {
        const { error: inErr } = await supabase.from('products').insert([{
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
        if (inErr) dbErrorMsg = inErr.message;
        else added++;
      }
    }

    if (added === 0 && updated === 0 && dbErrorMsg) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        wait.message_id,
        null,
        `❌ <b>Database Column Missing Error:</b>\n<code>${dbErrorMsg}</code>\n\nSupabase SQL Editor-e giye <code>category</code> ebong <code>api_stock</code> column add korun!`,
        { parse_mode: 'HTML' }
      );
    }

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

    const rate = parseFloat(process.env.USD_TO_BDT_RATE || 130);
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
// 11. Safe Server & Webhook Setup
// ==========================================
app.get('/', (req, res) => res.send('Nexas Cloud Store Bot is running 24/7!'));
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
