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

// Helper: Get or Create User
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

// ==========================================
// 1. Main Menu UI
// ==========================================
async function sendMainMenu(ctx, isEdit = false) {
  const user = await getUser(ctx);
  const text = `Welcome to Nexas Shop 🚀\n👋🏻 Hello! ${user.name}\n\n📌 Account Details\n💳 Telegram ID: <code>${user.telegram_id}</code>\n💰 Balance: $${Number(user.balance).toFixed(2)}\n\nChoose below ⬇️`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🛒 Shop', 'menu_shop'), Markup.button.callback('💰 Wallet', 'menu_wallet')],
    [Markup.button.callback('🧾 Order History', 'menu_orders'), Markup.button.callback('🔄 Recover Order', 'menu_recover')],
    [Markup.button.callback('💰 Refer & Earn', 'menu_refer'), Markup.button.callback('🛡️ Profile', 'menu_profile')],
    [Markup.button.callback('🛟 Support', 'menu_support'), Markup.button.callback('🔑 API Key', 'menu_apikey')]
  ]);

  if (isEdit) return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

bot.start((ctx) => { getUser(ctx, ctx.startPayload); sendMainMenu(ctx, false); });
bot.action('main_menu', (ctx) => { ctx.answerCbQuery(); sendMainMenu(ctx, true); });

// ==========================================
// 2. Shop & Auto Delivery (Local + Supplier API)
// ==========================================
bot.action('menu_shop', async (ctx) => {
  ctx.answerCbQuery();
  const { data: products } = await supabase.from('products').select('*');

  if (!products || products.length === 0) {
    return ctx.editMessageText('🛒 বর্তমানে কোনো প্রোডাক্ট স্টকে নেই।', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]));
  }

  const buttons = [];
  for (const p of products) {
    let stockCount = '∞';
    if (p.type === 'local') {
      const { count } = await supabase.from('stock').select('*', { count: 'exact', head: true }).eq('product_id', p.id).eq('is_sold', false);
      stockCount = count || 0;
    }
    buttons.push([Markup.button.callback(`${p.name} — $${Number(p.price).toFixed(2)} [Stock: ${stockCount}]`, `view_prod_${p.id}`)]);
  }
  buttons.push([Markup.button.callback('⬅️ Back', 'main_menu')]);

  ctx.editMessageText('🛒 <b>Available Digital Products:</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/view_prod_(\d+)/, async (ctx) => {
  ctx.answerCbQuery();
  const prodId = ctx.match[1];
  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).single();
  if (!product) return ctx.reply('প্রোডাক্ট পাওয়া যায়নি।');

  let stockCount = 'Instant (API)';
  if (product.type === 'local') {
    const { count } = await supabase.from('stock').select('*', { count: 'exact', head: true }).eq('product_id', product.id).eq('is_sold', false);
    stockCount = count || 0;
  }

  ctx.editMessageText(`📦 <b>${product.name}</b>\n\n💵 <b>Price:</b> $${Number(product.price).toFixed(2)}\n📊 <b>Stock:</b> ${stockCount}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Buy Now', `buy_prod_${product.id}`)],
      [Markup.button.callback('⬅️ Back', 'menu_shop')]
    ])
  });
});

bot.action(/buy_prod_(\d+)/, async (ctx) => {
  const prodId = ctx.match[1];
  const user = await getUser(ctx);
  const { data: product } = await supabase.from('products').select('*').eq('id', prodId).single();

  if (!product) return ctx.answerCbQuery('Product not found!', { show_alert: true });
  if (Number(user.balance) < Number(product.price)) {
    return ctx.answerCbQuery(`❌ পর্যাপ্ত ব্যালেন্স নেই! প্রয়োজন $${Number(product.price).toFixed(2)}`, { show_alert: true });
  }

  let deliveredData = null;

  if (product.type === 'local') {
    const { data: stockItem } = await supabase.from('stock').select('*').eq('product_id', product.id).eq('is_sold', false).limit(1).single();
    if (!stockItem) return ctx.answerCbQuery('❌ দুঃখিত! প্রোডাক্টটি স্টক আউট হয়ে গেছে।', { show_alert: true });
    await supabase.from('stock').update({ is_sold: true }).eq('id', stockItem.id);
    deliveredData = stockItem.data;
  } else if (product.type === 'api') {
    try {
      ctx.answerCbQuery('⏳ প্রসেসিং হচ্ছে...');
      const response = await axios.post(product.supplier_api_url, { api_key: product.supplier_api_key, product_id: product.supplier_product_id, quantity: 1 });
      deliveredData = response.data.data || response.data.code || response.data.link;
      if (!deliveredData) throw new Error();
    } catch (err) {
      return ctx.reply('❌ সাপ্লায়ার এপিআই এরর! আপনার কোনো টাকা কাটা হয়নি।');
    }
  }

  const newBalance = Number(user.balance) - Number(product.price);
  const orderId = 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  await supabase.from('users').update({ balance: newBalance }).eq('telegram_id', user.telegram_id);
  await supabase.from('orders').insert([{ id: orderId, telegram_id: user.telegram_id, product_name: product.name, price: product.price, delivered_data: deliveredData }]);

  ctx.editMessageText(`🎉 <b>অর্ডার সফল হয়েছে!</b>\n\n🧾 <b>ID:</b> <code>${orderId}</code>\n🔐 <b>ডেলিভারি ডাটা:</b>\n<code>${deliveredData}</code>`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Main Menu', 'main_menu')]])
  });
});

// ==========================================
// 3. Wallet & Direct Payment (bKash & Binance)
// ==========================================
bot.action('menu_wallet', async (ctx) => {
  ctx.answerCbQuery();
  const user = await getUser(ctx);
  ctx.editMessageText(`💰 <b>আপনার ওয়ালেট</b>\n\n💳 ID: <code>${user.telegram_id}</code>\n💵 Balance: $${Number(user.balance).toFixed(2)}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📱 Personal bKash', 'dep_bkash'), Markup.button.callback('🪙 Binance Pay', 'dep_binance')],
      [Markup.button.callback('⬅️ Back', 'main_menu')]
    ])
  });
});

bot.action('dep_bkash', (ctx) => {
  ctx.answerCbQuery();
  const rate = process.env.USD_TO_BDT_RATE || 130;
  ctx.editMessageText(
    `📱 <b>Personal bKash Send Money</b>\n\n` +
    `📞 Number: <code>${process.env.MY_BKASH_NUMBER}</code> (Personal)\n` +
    `💱 রেট: $1 = ${rate} BDT\n\n` +
    `<b>নিয়ম:</b>\n` +
    `১. উপরের নাম্বারে টাকা Send Money করুন।\n` +
    `২. TrxID কপি করে নিচের কমান্ড দিন:\n\n` +
    `👉 <code>/verify TrxID</code>\n` +
    `<i>(উদাহরণ: <code>/verify 9J76H54K</code>)</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_wallet')]]) }
  );
});

// bKash SMS Webhook
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

bot.command('verify', async (ctx) => {
  const trxId = (ctx.message.text.split(' ')[1] || '').trim().toUpperCase();
  if (!trxId) return ctx.reply('সঠিক নিয়মে দিন: <code>/verify TrxID</code>', { parse_mode: 'HTML' });

  const { data: payment } = await supabase.from('payments').select('*').eq('trx_id', trxId).single();

  if (!payment) return ctx.reply('⏳ এই TrxID-টি এখনো পাওয়া যায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।');
  if (payment.is_used) return ctx.reply('❌ এই TrxID-টি ইতিমধ্যে ব্যবহার করা হয়েছে!');

  const rate = parseFloat(process.env.USD_TO_BDT_RATE || 130);
  const usdAmount = parseFloat((payment.amount / rate).toFixed(2));

  await supabase.from('payments').update({ is_used: true }).eq('trx_id', trxId);
  const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', ctx.from.id).single();
  const newBal = Number(user.balance) + usdAmount;
  await supabase.from('users').update({ balance: newBal }).eq('telegram_id', ctx.from.id);

  ctx.reply(`🎉 <b>ডিপোজিট সফল হয়েছে!</b>\n\n💵 যুক্ত হয়েছে: $${usdAmount} (TrxID: <code>${trxId}</code>)`, { parse_mode: 'HTML' });
});

bot.action('dep_binance', (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(
    `🪙 <b>Direct Binance Pay</b>\n\n` +
    `🆔 Binance Pay ID: <code>${process.env.BINANCE_PAY_ID}</code>\n\n` +
    `USDT পাঠিয়ে Order ID দিয়ে কমান্ড দিন:\n👉 <code>/binance Order_ID</code>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_wallet')]]) }
  );
});

bot.command('binance', async (ctx) => {
  const orderId = (ctx.message.text.split(' ')[1] || '').trim();
  if (!orderId) return ctx.reply('সঠিক নিয়মে দিন: <code>/binance Order_ID</code>', { parse_mode: 'HTML' });

  const trxKey = 'BN_' + orderId;
  const { data: existing } = await supabase.from('payments').select('*').eq('trx_id', trxKey).single();
  if (existing) return ctx.reply('❌ এই Order ID-টি ইতিমধ্যে ব্যবহার করা হয়েছে!');

  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', process.env.BINANCE_SECRET_KEY).update(queryString).digest('hex');

    const response = await axios.get(`https://api.binance.com/sapi/v1/pay/transactions?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY }
    });

    const tx = (response.data.data || []).find(t => String(t.orderId) === String(orderId) && parseFloat(t.amount) > 0 && t.currency === 'USDT');
    if (!tx) return ctx.reply('❌ এই Order ID-তে কোনো পেমেন্ট পাওয়া যায়নি!');

    const amount = parseFloat(tx.amount);
    await supabase.from('payments').insert([{ trx_id: trxKey, amount: amount, sender: 'Binance', is_used: true }]);
    
    const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', ctx.from.id).single();
    const newBal = Number(user.balance) + amount;
    await supabase.from('users').update({ balance: newBal }).eq('telegram_id', ctx.from.id);

    ctx.reply(`🎉 <b>Binance Deposit Successful!</b>\n\n💵 Added: $${amount} USDT`, { parse_mode: 'HTML' });
  } catch (err) {
    ctx.reply('❌ Binance API error! API Key চেক করুন।');
  }
});

// ==========================================
// 4. Other Menus & Admin Commands
// ==========================================
bot.action('menu_orders', async (ctx) => {
  ctx.answerCbQuery();
  const { data: orders } = await supabase.from('orders').select('*').eq('telegram_id', ctx.from.id).order('created_at', { ascending: false }).limit(5);
  if (!orders || orders.length === 0) return ctx.editMessageText('🧾 কোনো অর্ডার নেই।', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]));

  let text = '🧾 <b>Recent Orders:</b>\n\n';
  orders.forEach(o => { text += `🔹 <code>${o.id}</code> | ${o.product_name} ($${o.price})\n🔑 <code>${o.delivered_data}</code>\n\n`; });
  ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.action('menu_refer', async (ctx) => {
  ctx.answerCbQuery();
  const user = await getUser(ctx);
  const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', user.telegram_id);
  ctx.editMessageText(`💰 <b>Refer & Earn</b>\n\n👥 Total Referrals: ${count || 0}\n🔗 Link: <code>https://t.me/${process.env.BOT_USERNAME.replace('@','') }?start=${user.telegram_id}</code>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.action('menu_profile', async (ctx) => {
  ctx.answerCbQuery();
  const user = await getUser(ctx);
  ctx.editMessageText(`🛡️ <b>Profile</b>\n\n👤 Name: ${user.name}\n🆔 ID: <code>${user.telegram_id}</code>\n💰 Balance: $${Number(user.balance).toFixed(2)}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.action('menu_support', (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText(`🛟 Support: ${process.env.SUPPORT_USERNAME}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.action('menu_apikey', async (ctx) => {
  ctx.answerCbQuery();
  const user = await getUser(ctx);
  ctx.editMessageText(`🔑 <b>Reseller API Key</b>\n\n<code>${user.api_key}</code>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.action('menu_recover', (ctx) => {
  ctx.answerCbQuery();
  ctx.editMessageText('🔄 অর্ডার রিকভার করতে দিন: <code>/recover ORD-XXXX</code>', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'main_menu')]]) });
});

bot.command('recover', async (ctx) => {
  const orderId = ctx.message.text.split(' ')[1];
  if (!orderId) return ctx.reply('Order ID দিন।');
  const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).eq('telegram_id', ctx.from.id).single();
  if (!order) return ctx.reply('❌ কোনো অর্ডার পাওয়া যায়নি।');
  ctx.reply(`✅ <b>Order Found!</b>\n\n🔑 Data: <code>${order.delivered_data}</code>`, { parse_mode: 'HTML' });
});

function isAdmin(ctx) { return String(ctx.from.id) === String(process.env.ADMIN_ID); }

bot.command('addprod', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/addprod ', '').split('|').map(s => s.trim());
  if (args.length < 3) return ctx.reply('Format: /addprod Name | Price | Desc | [local/api] | URL | Key | ProdID');
  const [name, price, description, type = 'local', url = null, key = null, prodId = null] = args;
  
  const { data, error } = await supabase.from('products').insert([{ name, price: parseFloat(price), description, type, supplier_api_url: url, supplier_api_key: key, supplier_product_id: prodId }]).select();
  if (error) return ctx.reply('Error: ' + error.message);
  ctx.reply(`✅ Product added! ID: ${data[0].id}`);
});

bot.command('addstock', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/addstock ', '').split('|').map(s => s.trim());
  if (args.length < 2) return ctx.reply('Format: /addstock ProductID | Link_or_Code');
  await supabase.from('stock').insert([{ product_id: parseInt(args[0]), data: args[1] }]);
  ctx.reply(`✅ Stock added to Product ID ${args[0]}!`);
});

bot.command('addbal', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.replace('/addbal ', '').split('|').map(s => s.trim());
  if (args.length < 2) return ctx.reply('Format: /addbal TelegramID | Amount');
  const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', args[0]).single();
  if (!user) return ctx.reply('User not found.');
  const newBal = Number(user.balance) + parseFloat(args[1]);
  await supabase.from('users').update({ balance: newBal }).eq('telegram_id', args[0]);
  ctx.reply(`✅ Added $${args[1]} to user ${args[0]}`);
  bot.telegram.sendMessage(args[0], `💰 Your wallet credited with $${args[1]}!`).catch(() => {});
});

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => {
  res.send('Nexas Shop Bot is running 24/7!');
});
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
bot.launch().then(() => console.log('🤖 Bot is live!'));
