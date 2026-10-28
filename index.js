const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // Render ETIMEDOUT এরর চিরতরে বন্ধ করবে!
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

async function getProductStock(product) {
  if (product.type === 'api') return 999;
  const { count } = await supabase
    .from('stock')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', product.id)
    .eq('is_sold', false);
  return count || 0;
}

// ==========================================
// PRODSELLER API ORDER FULFILLMENT INTEGRATION
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
        message: `❌ Stock out! Apnar payment ($${totalUsd.toFixed(2)} USDT) apnar wallet balance-e add kore dewa hoyeche.`
      };
    }

    const idsToMark = stockItems.map(s => s.id);
    await supabase.from('stock').update({ is_sold: true }).in('id', idsToMark);
    deliveredItems = stockItems.map(s => s.data);
  } else if (product.type === 'api') {
    try {
      // Prodseller API Header format (X-API-Key)
      const response = await axios.post(
        product.supplier_api_url, 
        {
          product_id: product.supplier_product_id,
          quantity: qty
        },
        {
          headers: {
            'X-API-Key': product.supplier_api_key,
            'Content-Type': 'application/json'
          }
        }
      );

      // Prodseller API response response data parsing
      const apiData = response.data.data || response.data.link || response.data.code || response.data.accounts;
      if (!apiData) throw new Error('Invalid supplier response');
      deliveredItems = Array.isArray(apiData) ? apiData : [apiData];
    } catch (err) {
      const errMsg = err.response?.data?.error || 'Supplier API Error';
      return {
        success: false,
        message: `❌ ${errMsg}! Apnar payment ($${totalUsd.toFixed(2)} USDT) apnar wallet balance-e add kore dewa hoyeche.`
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

  const msg =
    `🎉 <b>PAYMENT VERIFIED SUCCESSFULLY!</b> 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🛍️ <b>Product:</b> ${product.category} (${product.name})\n` +
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
// 2. 2-Column Cloud Store Catalog
// ==========================================
async function showCatalog(ctx, isEdit = true) {
  pendingCheckouts.delete(ctx.from.id);
  const { data: products } = await supabase.from('products').select('*').order('id', { ascending: true });

  if (!products || products.length === 0) {
    const emptyMsg = '🌈 <b>CLOUD STORE CATALOG</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 Currently kono product stock-e nei.';
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
    const icon1 = c1.totalStock > 0 ? '🟢' : '🔴';
    row.push(Markup.button.callback(`${icon1} ${c1.name} (${c1.totalStock})`, `cat_${c1.firstProdId}`));

    if (catList[i + 1]) {
      const c2 = catList[i + 1];
      const icon2 = c2.totalStock > 0 ? '🟢' : '🔴';
      row.push(Markup.button.callback(`${icon2} ${c2.name} (${c2.totalStock})`, `cat_${c2.firstProdId}`));
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

  const buttons = [];
  for (const v of (variants || [firstProd])) {
    const stock = await getProductStock(v);
    const btnIcon = stock > 0 ? '🟢' : '🔴';
    buttons.push([
      Markup.button.callback(`${btnIcon} ${v.name} - $${Number(v.price).toFixed(2)} USDT [Stock: ${stock}]`, `sel_${v.id}_1`)
    ]);
  }
  buttons.push([Markup.button.callback('🔙 Back to Catalog', 'menu_shop')]);

  const text = `🛒 <b>PRODUCT - ${catName}</b>\n━━━━━━━━━━━━━━━━━━━━\n${firstProd.description || 'Instant Digital Delivery.'}\n\n⚠️ <b>Warning:</b> By purchasing, you confirm that you have read the product description and agree to our store policies. Please purchase at your own risk.\n\n👇 <b>Choose a plan/variant:</b>`;

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

  const text = `✨ <b>${product.category} - ${product.name}</b>\n━━━━━━━━━━━━━━━━━━━━\n💲 <b>Price:</b> $${Number(product.price).toFixed(2)} USDT per unit\n📦 <b>Stock:</b> ${stock} available\n👛 <b>Your Wallet Balance:</b> $${Number(user.balance).toFixed(2)} USDT\n\n📋 <b>Details:</b>\n${product.description}\n\n🧮 <b>Select Quantity:</b>`;

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
      `🎁 <b>Item:</b> ${product.category}\n` +
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
      `🎁 <b>Item:</b> ${product.category}\n` +
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
// 8. Other Menus & Admin Commands
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

function isAdmin(ctx) { return String(ctx.from.id) === String(process.env.ADMIN_ID); }

// নতুন প্রোডাক্ট অ্যাড করার নিয়ম (Prodseller API Supported)
bot.command('addprod', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/addprod ', '').split('|').map(s => s.trim());
  if (args.length < 4) return ctx.reply('Format:\n/addprod Category | Plan Name | Price | Details | [local/api] | Supplier_Order_URL | Supplier_API_Key | Supplier_Product_ID');
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
  if (args.length < 2) return ctx.reply('Format: /addstock ProductID | Link_or_Account');
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
// 9. AUTO VERIFY & INSTANT LINK DELIVERY ON ID PASTE
// ==========================================
bot.on('text', async (ctx) => {
  const rawText = ctx.message.text.trim();
  if (rawText.startsWith('/')) return;

  const session = pendingCheckouts.get(ctx.from.id);
  if (!session) return;

  if (Date.now() > session.expiresAt) {
    pendingCheckouts.delete(ctx.from.id);
    return ctx.reply('⏰ Apnar 5 minutes checkout session expire hoye geche! Product-ti abar select korun.');
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
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          waitMsg.message_id,
          null,
          '❌ Ei Order ID-te kono payment pawa jayni! Payment korar 5-10 second por sothik Transfer Order ID-ti send korun.'
        );
      }

      const paidAmount = parseFloat(tx.amount);

      if (session.type === 'product') {
        if (paidAmount < session.totalUsd) {
          return ctx.telegram.editMessageText(
            ctx.chat.id,
            waitMsg.message_id,
            null,
            `❌ Apni kom amount pathiyechen! Dorkar ${session.totalUsd.toFixed(2)} USDT, pawa geche ${paidAmount.toFixed(2)} USDT.`
          );
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

    if (!payment) {
      return ctx.reply('⏳ Ei bKash TrxID-ti ekhono system-e asheni. Send Money korar 5-10 second por abar TrxID-ti send korun.');
    }
    if (payment.is_used) {
      return ctx.reply('❌ Ei bKash TrxID-ti already use kora hoyeche!');
    }

    const rate = parseFloat(process.env.USD_TO_BDT_RATE || 130);
    const paidUsd = parseFloat((payment.amount / rate).toFixed(2));

    if (session.type === 'product') {
      if (payment.amount < session.totalBdt) {
        return ctx.reply(`❌ Apni kom taka pathiyechen! Dorkar ${session.totalBdt} BDT, pawa geche ${payment.amount} BDT.`);
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

      return ctx.reply(result.message, {
        parse_mode: 'HTML',
        ...result.keyboard
      });
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
// 10. Server & Safe Webhook Setup (No ETIMEDOUT Crash)
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
    
    // Safe Webhook setup with Auto-Retry so Render deploy never fails
    const connectWebhook = async () => {
      try {
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`🤖 Webhook active at: ${webhookUrl}`);
      } catch (err) {
        console.error('⚠️ Webhook timeout, retrying in 5 seconds...', err.message);
        setTimeout(connectWebhook, 5000);
      }
    };
    connectWebhook();
  } else {
    bot.launch({ dropPendingUpdates: true }).catch(console.error);
  }
});
