require('dotenv').config();
const express = require('express');
const http = require('http');
const session = require('express-session');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { Order, PartyOrder, Customer, MenuItem } = require('./models');
const { sendOrderSMS } = require('./services/twilioSms');
const { createPayment, getPaymentStatus, isPhonePeConfigured } = require('./services/phonePe');

let outlets = [], menuItems = [];
try {
    const mock = require('./data/mockData');
    outlets = mock.outlets || [];
    menuItems = mock.menuItems || [];
} catch (e) {
    console.error('Failed to load sample menu data:', e.message);
}
const sampleMenuItems = menuItems.map(item => ({ ...item }));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

outlets = [
    { id: 'kondapur', name: 'Kondapur Outlet', radius: 'Within 5 km', fssai: '10020047001892', minPrepMinutes: 20 },
    { id: 'gachibowli', name: 'Gachibowli Cloud Kitchen', radius: 'Within 7 km', fssai: '10020047001893', minPrepMinutes: 25 },
    { id: 'kukatpally', name: 'Kukatpally Outlet', radius: 'Within 6 km', fssai: '10020047001894', minPrepMinutes: 22 }
];

const sessionMiddleware = session({
    secret: 'company-a-secret-key-2026',
    resave: false,
    saveUninitialized: false
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    if (req.session.user && req.session.user.role === 'customer') {
        if (!req.session.cart) req.session.cart = [];
        if (!req.session.selectedOutlet) req.session.selectedOutlet = req.session.user.preferredOutlet || outlets[0].id;
    }
    next();
});

let activeOrders = [];
let partyOrders = [];

function getOutlet(outletId) {
    return outlets.find(o => o.id === outletId) || outlets[0];
}

function getCustomerId(req) {
    return req.session.user && req.session.user.customerId ? req.session.user.customerId : 'CUST-GUEST';
}

function getCustomerEmail(req) {
    return req.session.user && req.session.user.email ? req.session.user.email.toLowerCase() : '';
}

async function persistCustomerProfile(req, updates = {}) {
    const email = getCustomerEmail(req);
    if (!email) throw new Error('Customer email is missing from the session.');
    await Customer.updateOne(
        { email },
        { $set: { ...updates, preferredOutlet: req.session.selectedOutlet || req.session.user.preferredOutlet || outlets[0].id, cart: req.session.cart || [] } }
    );
}

function normalizeIndianMobileNumber(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
    if (/^91[6-9]\d{9}$/.test(digits)) return digits;
    return null;
}

function getCustomerName(req) {
    return req.session.user && req.session.user.name ? req.session.user.name : 'Customer';
}

function getPreferredOutlet(req) {
    if (outlets.some(outlet => outlet.id === req.session.selectedOutlet)) return req.session.selectedOutlet;
    if (outlets.some(outlet => outlet.id === req.session.user.preferredOutlet)) return req.session.user.preferredOutlet;
    return outlets[0].id;
}

function buildAiSuggestions(customerId, outletId) {
    const suggestions = [];
    const customerHistory = activeOrders.filter(order => order.customerId === customerId && Array.isArray(order.items));
    const counted = {};

    if (customerHistory.length > 0) {
        customerHistory.forEach(order => {
            order.items.forEach(item => {
                const normalized = item.name.split('(')[0].trim();
                counted[normalized] = (counted[normalized] || 0) + (item.qty || 1);
            });
        });
    }

    const preferred = Object.entries(counted).sort((a, b) => b[1] - a[1]);
    const orderedNames = preferred.map(([name]) => name);

    [...orderedNames, ...menuItems.map(item => item.name)].forEach(name => {
        if (!name) return;
        const match = menuItems.find(item => item.name.toLowerCase() === name.toLowerCase() || item.name.toLowerCase().includes(name.toLowerCase()));
        if (match && suggestions.length < 3 && !suggestions.some(s => s.id === match.id)) {
            suggestions.push(match);
        }
    });

    if (suggestions.length < 3) {
        for (const item of menuItems) {
            if (suggestions.length >= 3) break;
            if (!suggestions.some(s => s.id === item.id)) suggestions.push(item);
        }
    }

    return suggestions.slice(0, 3).filter(item => item && item.inStock);
}

function calculateAiPrepMinutes(outletId, items = []) {
    const outlet = getOutlet(outletId);
    const queueLoad = activeOrders.filter(order =>
        order.outletId === outletId &&
        order.status !== 'Rider Handoff' &&
        isOrderPaid(order)
    ).length;
    const complexity = (items || []).reduce((sum, item) => {
        const match = menuItems.find(menuItem => item.name.toLowerCase().includes(menuItem.name.toLowerCase()) || menuItem.name.toLowerCase().includes(item.name.toLowerCase()));
        const itemWeight = match ? (match.isVeg ? 4 : 6) : 4;
        return sum + itemWeight * (item.qty || 1);
    }, 0);

    const estimate = Math.ceil((queueLoad * 5) + (complexity * 1.5) + outlet.minPrepMinutes * 0.7);
    return Math.max(outlet.minPrepMinutes || 15, estimate);
}

function isOrderPaid(order) {
    return order.paymentStatus === 'Paid' || order.paymentStatus === 'Test payment approved';
}

function formatPromise(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isSmsConfigured() {
    return Boolean(
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_SMS_FROM
    );
}

async function sendStatusNotification(order, message) {
    if (!order.smsOptIn) return;
    if (!order.phone) {
        console.warn(`SMS update skipped for order ${order.id}: no opted-in recipient.`);
        return;
    }

    try {
        const result = await sendOrderSMS({
            to: order.phone,
            orderId: order.id,
            message
        });
        if (!result.sent) {
            console.warn(`SMS update not sent for order ${order.id}; configure ${result.missingSettings.join(', ')}.`);
            return;
        }
        console.log(`SMS update accepted by Twilio for order ${order.id} (message ${result.messageId || 'accepted'}).`);
    } catch (error) {
        console.error(`SMS update failed for order ${order.id}:`, error.message);
    }
}

async function syncPhonePeOrderStatus(order, req) {
    const paymentStatus = await getPaymentStatus({ merchantOrderId: order.id });
    if (!paymentStatus.checked) {
        throw new Error(`Missing PhonePe settings: ${paymentStatus.missingSettings.join(', ')}`);
    }
    if (paymentStatus.amount !== undefined && paymentStatus.amount !== Math.round(order.total * 100)) {
        throw new Error(`PhonePe payment amount mismatch for order ${order.id}.`);
    }

    if (paymentStatus.state === 'COMPLETED' && order.paymentStatus !== 'Paid') {
        order.paymentStatus = 'Paid';
        order.status = 'In Progress';
        order.aiPrepMinutes = calculateAiPrepMinutes(
            order.outletId,
            order.items.map(item => ({ name: item.name, qty: item.qty }))
        );
        order.promisedMinutes = Math.max(
            order.aiPrepMinutes,
            getOutlet(order.outletId).minPrepMinutes || 15
        );
        order.promisedAt = new Date(Date.now() + order.promisedMinutes * 60000).toISOString();
        order.createdAtMs = Date.now();
        order.createdAt = new Date(order.createdAtMs).toLocaleTimeString();
        await order.save();

        const orderObject = order.toObject();
        activeOrders = [orderObject, ...activeOrders.filter(activeOrder => activeOrder.id !== order.id)];
        io.emit('new-order-received', orderObject);
        await sendStatusNotification(orderObject, `Order ${order.id} is confirmed at ${getOutlet(order.outletId).name}. Promised ready by ${formatPromise(order.promisedAt)}.`);

        req.session.cart = [];
        req.session.user.phone = order.phone || '';
        req.session.user.smsOptIn = order.smsOptIn;
        try {
            await persistCustomerProfile(req, {
                phone: order.phone || '',
                smsOptIn: order.smsOptIn
            });
        } catch (error) {
            console.error('Failed to save cleared customer cart after payment:', error.message);
        }
    } else if (paymentStatus.state === 'FAILED' && order.paymentStatus === 'Pending') {
        order.paymentStatus = 'Failed';
        order.status = 'Payment Failed';
        await order.save();
    }

    return paymentStatus.state;
}

async function fetchOrdersFromDb() {
    try {
        const orders = await Order.find({}).sort({ createdAtMs: -1 }).lean();
        activeOrders = orders;
        return orders;
    } catch (error) {
        console.error('Failed to load orders from MongoDB:', error.message);
        return activeOrders;
    }
}

async function fetchPartyOrdersFromDb() {
    try {
        const docs = await PartyOrder.find({}).sort({ createdAt: -1 }).lean();
        partyOrders = docs;
        return docs;
    } catch (error) {
        console.error('Failed to load party orders from MongoDB:', error.message);
        return partyOrders;
    }
}

async function connectMongo() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        throw new Error('MONGO_URI must be configured before starting the platform.');
    }

    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });
    console.log('MongoDB connected.');
    await fetchOrdersFromDb();
    await fetchPartyOrdersFromDb();
    await initializeMenuItems();
}

async function initializeMenuItems() {
    const menuCount = await MenuItem.countDocuments();
    if (menuCount === 0 && sampleMenuItems.length > 0) {
        await MenuItem.insertMany(sampleMenuItems);
        console.log(`Seeded MongoDB menu with ${sampleMenuItems.length} sample items.`);
    }
    menuItems = await MenuItem.find({}).sort({ id: 1 }).lean();
}

function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

function requireRole(role) {
    return (req, res, next) => {
        if (req.session.user && req.session.user.role === role) return next();
        res.status(403).send('<h1>403 Forbidden</h1><p>Access denied. Your role is not authorized to view this page.</p><a href="/login">Switch Account</a>');
    };
}

app.get('/login', (req, res) => {
    res.render('auth/login', { outlets, error: null });
});

app.post('/login', async (req, res) => {
    const { role, outletId } = req.body;

    if (role === 'customer') {
        const email = String(req.body.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@gmail\.com$/.test(email)) {
            return res.status(400).render('auth/login', { outlets, error: 'Enter a valid Gmail address to continue.' });
        }

        try {
            const customer = await Customer.findOneAndUpdate(
                { email },
                { $setOnInsert: { email, name: email.split('@')[0], preferredOutlet: outlets[0].id, cart: [] } },
                { returnDocument: 'after', upsert: true, runValidators: true }
            ).lean();

            req.session.user = {
                name: customer.name || email.split('@')[0],
                role: 'customer',
                customerId: String(customer._id),
                email: customer.email,
                phone: customer.phone || '',
                smsOptIn: customer.smsOptIn || false,
                preferredOutlet: customer.preferredOutlet || outlets[0].id
            };
            req.session.cart = customer.cart || [];
            req.session.selectedOutlet = customer.preferredOutlet || outlets[0].id;
            return res.redirect('/');
        } catch (error) {
            console.error('Failed to load customer profile from MongoDB:', error.message);
            return res.status(503).render('auth/login', { outlets, error: 'Could not load your saved profile. Please try again.' });
        }
    }

    if (role === 'kitchen') {
        const outlet = getOutlet(outletId || 'kondapur');
        req.session.user = { name: `Kitchen Staff (${outlet.name})`, role: 'kitchen', outletId: outlet.id };
        return res.redirect(`/kitchen/${outlet.id}`);
    }

    if (role === 'admin') {
        req.session.user = { name: 'Central Operations Manager', role: 'admin' };
        return res.redirect('/admin/dashboard');
    }

    res.redirect('/login');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

app.get('/select-outlet', isAuthenticated, requireRole('customer'), (req, res) => {
    res.render('customer/select-outlet', { outlets });
});

app.post('/select-outlet', isAuthenticated, requireRole('customer'), async (req, res) => {
    const { outletId } = req.body;
    const outlet = outlets.find(o => o.id === outletId);
    if (outlet) {
        req.session.selectedOutlet = outlet.id;
        req.session.user.preferredOutlet = outlet.id;
        try {
            await persistCustomerProfile(req);
        } catch (error) {
            console.error('Failed to save customer outlet preference:', error.message);
            return res.status(503).send('Could not save your outlet preference. Please try again.');
        }
    }
    res.redirect('/');
});

app.get('/', isAuthenticated, requireRole('customer'), async (req, res) => {
    try {
        menuItems = await MenuItem.find({}).sort({ id: 1 }).lean();
        const currentOutlet = getOutlet(req.session.selectedOutlet || req.session.user.preferredOutlet || outlets[0].id);
        const aiSuggestions = buildAiSuggestions(getCustomerId(req), currentOutlet.id);
        return res.render('customer/menu', {
            outlets,
            currentOutlet,
            menuItems,
            aiSuggestions,
            cartCount: (req.session.cart || []).reduce((acc, item) => acc + item.qty, 0)
        });
    } catch (error) {
        console.error('Failed to load menu from MongoDB:', error.message);
        return res.status(503).send('The menu is temporarily unavailable. Please try again.');
    }
});

app.post('/cart/add', isAuthenticated, requireRole('customer'), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'customer') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const { itemId, qty, portion, addon } = req.body;
    const quantity = Number.parseInt(qty, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        return res.status(400).json({ success: false, error: 'Quantity must be between 1 and 10.' });
    }

    let item;
    try {
        item = await MenuItem.findOne({ id: itemId }).lean();
    } catch (error) {
        console.error('Failed to check menu availability:', error.message);
        return res.status(503).json({ success: false, error: 'Menu availability could not be checked.' });
    }
    if (!item || !item.inStock) {
        return res.status(409).json({ success: false, error: 'This item is currently unavailable.', cartCount: (req.session.cart || []).reduce((acc, i) => acc + i.qty, 0) });
    }

    if (!req.session.cart) req.session.cart = [];

    let basePrice = item.price;
    let portionLabel = portion || 'Standard';
    if (portion === 'Family Pack') basePrice += 750;
    if (portion === 'Jumbo Feast') basePrice += 1400;

    const addonCost = addon ? 60 : 0;
    const finalUnitPrice = basePrice + addonCost;
    const cartKey = `${item.id}-${portionLabel}-${addon || 'none'}`;
    const existing = req.session.cart.find(cartItem => cartItem.cartKey === cartKey);

    if (existing) {
        existing.qty += quantity;
    } else {
        req.session.cart.push({
            cartKey,
            id: item.id,
            name: item.name,
            portion: portionLabel,
            addon: addon || 'None',
            price: finalUnitPrice,
            qty: quantity
        });
    }

    const totalCartCount = (req.session.cart || []).reduce((acc, i) => acc + i.qty, 0);
    try {
        await persistCustomerProfile(req);
        res.json({ success: true, cartCount: totalCartCount });
    } catch (error) {
        console.error('Failed to save customer cart:', error.message);
        res.status(503).json({ success: false, error: 'Could not save your cart. Please try again.' });
    }
});

app.get('/cart/decrease/:cartKey', isAuthenticated, requireRole('customer'), async (req, res) => {
    const cartKey = req.params.cartKey;
    if (req.session.cart) {
        const item = req.session.cart.find(cartItem => cartItem.cartKey === cartKey);
        if (item) {
            item.qty -= 1;
            if (item.qty <= 0) {
                req.session.cart = req.session.cart.filter(cartItem => cartItem.cartKey !== cartKey);
            }
        }
    }
    try {
        await persistCustomerProfile(req);
    } catch (error) {
        console.error('Failed to save customer cart:', error.message);
        return res.status(503).send('Could not save your cart. Please try again.');
    }
    res.redirect('/cart');
});

app.get('/cart/increase/:cartKey', isAuthenticated, requireRole('customer'), async (req, res) => {
    const item = (req.session.cart || []).find(cartItem => cartItem.cartKey === req.params.cartKey);
    if (!item) return res.status(404).send('Cart item not found.');
    if (item.qty >= 10) return res.redirect('/cart');

    try {
        const menuItem = await MenuItem.findOne({ id: item.id }).lean();
        if (!menuItem || !menuItem.inStock) {
            return res.status(409).send('This item is currently unavailable.');
        }
        item.qty += 1;
        await persistCustomerProfile(req);
    } catch (error) {
        console.error('Failed to update customer cart:', error.message);
        return res.status(503).send('Could not update your cart. Please try again.');
    }
    res.redirect('/cart');
});

app.get('/cart/remove/:cartKey', isAuthenticated, requireRole('customer'), async (req, res) => {
    const cartKey = req.params.cartKey;
    if (req.session.cart) {
        req.session.cart = req.session.cart.filter(cartItem => cartItem.cartKey !== cartKey);
    }
    try {
        await persistCustomerProfile(req);
    } catch (error) {
        console.error('Failed to save customer cart:', error.message);
        return res.status(503).send('Could not save your cart. Please try again.');
    }
    res.redirect('/cart');
});

app.get('/cart', isAuthenticated, requireRole('customer'), (req, res) => {
    const cart = req.session.cart || [];
    const itemTotal = cart.reduce((acc, i) => acc + (i.price * i.qty), 0);
    const currentOutlet = getOutlet(req.session.selectedOutlet || req.session.user.preferredOutlet || outlets[0].id);
    res.render('customer/cart', {
        cart,
        itemTotal,
        currentOutlet,
        customerPhone: req.session.user.phone || '',
        customerSmsOptIn: req.session.user.smsOptIn || false,
        smsConfigured: isSmsConfigured(),
        phonePeConfigured: isPhonePeConfigured(),
        phonePeEnvironment: String(process.env.PHONEPAY_ENV || 'sandbox').toLowerCase()
    });
});

app.post('/place-order', isAuthenticated, requireRole('customer'), async (req, res) => {
    const cart = req.session.cart || [];
    if (cart.length === 0) return res.redirect('/cart');
    if (!isPhonePeConfigured()) {
        return res.status(503).send('PhonePe is not configured. Add PHONEPAY_CLIENT_ID and PHONEPAY_CLIENT_SECRET to .env and restart the app.');
    }
    const rawPhone = String(req.body.phone || '').trim();
    const customerPhone = normalizeIndianMobileNumber(rawPhone || req.session.user.phone);
    const smsOptIn = req.body.smsOptIn === 'yes';
    if ((rawPhone && !customerPhone) || (smsOptIn && !customerPhone)) {
        return res.status(400).send('Enter a valid Indian mobile number to receive SMS order updates.');
    }

    try {
        const itemIds = [...new Set(cart.map(item => item.id))];
        const availableItems = await MenuItem.find({ id: { $in: itemIds }, inStock: true }).select('id').lean();
        if (availableItems.length !== itemIds.length) {
            return res.status(409).send('One or more items in your cart are now unavailable. Please review your cart.');
        }
    } catch (error) {
        console.error('Failed to verify cart availability:', error.message);
        return res.status(503).send('Could not verify item availability. Please try again.');
    }

    const itemTotal = cart.reduce((acc, i) => acc + (i.price * i.qty), 0);
    const deliveryFee = 56;
    let discount = 0;

    if (req.body.coupon === 'HYDRA100') discount += 100;
    if (req.body.redeemed === 'true') discount += 24;

    const finalTotal = Math.max(0, itemTotal + deliveryFee - discount);
    const orderId = 'WEB-' + Math.floor(100000 + Math.random() * 900000);
    const outletId = getPreferredOutlet(req);
    const outlet = getOutlet(outletId);
    const aiPrepMinutes = calculateAiPrepMinutes(outletId, cart.map(item => ({ qty: item.qty, name: item.name })));
    const promisedMinutes = Math.max(aiPrepMinutes, outlet.minPrepMinutes || 15);
    const promisedAt = new Date(Date.now() + promisedMinutes * 60000).toISOString();
    const customerId = getCustomerId(req);

    const newOrder = {
        id: orderId,
        customerId,
        email: getCustomerEmail(req),
        customerName: getCustomerName(req),
        phone: customerPhone,
        smsOptIn,
        outletId,
        items: cart.map(item => ({ qty: item.qty, name: `${item.name} (${item.portion})${item.addon !== 'None' ? ' + ' + item.addon : ''}` })),
        total: finalTotal,
        payment: 'PhonePe',
        paymentStatus: 'Pending',
        status: 'Payment Pending',
        aiPrepMinutes,
        promisedMinutes,
        promisedAt,
        createdAtMs: Date.now(),
        createdAt: new Date().toLocaleTimeString()
    };

    let order;
    try {
        order = await Order.create(newOrder);
    } catch (error) {
        console.error('Failed to save order to MongoDB:', error.message);
        return res.status(503).send('Could not place your order. Your cart has been kept; please try again.');
    }

    let payment;
    try {
        const phonePeEnvironment = String(process.env.PHONEPAY_ENV || 'sandbox').toLowerCase();
        const appBaseUrl = (process.env.APP_BASE_URL || (
            phonePeEnvironment === 'sandbox' ? `http://localhost:${process.env.PORT || 3000}` : ''
        )).replace(/\/+$/, '');
        if (!appBaseUrl) {
            throw new Error('APP_BASE_URL is required for PhonePe production checkout.');
        }
        const appBase = new URL(appBaseUrl);
        if (phonePeEnvironment === 'production' && appBase.protocol !== 'https:') {
            throw new Error('APP_BASE_URL must use HTTPS for PhonePe production checkout.');
        }
        const redirectUrl = new URL('/payment/phonepe/return', appBaseUrl);
        redirectUrl.searchParams.set('merchantOrderId', orderId);
        payment = await createPayment({
            merchantOrderId: orderId,
            amountPaise: Math.round(finalTotal * 100),
            redirectUrl: redirectUrl.toString()
        });
        if (!payment.created) {
            throw new Error(`Missing PhonePe settings: ${payment.missingSettings.join(', ')}`);
        }
        order.paymentProviderOrderId = payment.providerOrderId;
    } catch (error) {
        order.paymentStatus = 'Initiation Failed';
        order.status = 'Payment Failed';
        try {
            await order.save();
        } catch (saveError) {
            console.error(`Failed to update order ${orderId} after PhonePe checkout error:`, saveError.message);
        }
        console.error(`PhonePe checkout could not be started for order ${orderId}:`, error.message);
        return res.status(502).send('PhonePe checkout could not be started. Your cart is unchanged; please try again.');
    }

    try {
        await order.save();
    } catch (error) {
        console.error(`Failed to save PhonePe provider reference for order ${orderId}:`, error.message);
    }
    res.redirect(payment.redirectUrl);
});

app.get('/payment/phonepe/return', isAuthenticated, requireRole('customer'), async (req, res) => {
    const merchantOrderId = String(req.query.merchantOrderId || '');
    if (!/^WEB-\d{6}$/.test(merchantOrderId)) {
        return res.status(400).send('Invalid PhonePe order reference.');
    }

    try {
        const order = await Order.findOne({
            id: merchantOrderId,
            email: getCustomerEmail(req)
        });
        if (!order) return res.status(404).send('Order not found.');

        await syncPhonePeOrderStatus(order, req);
        return res.redirect(`/order/${order.id}`);
    } catch (error) {
        console.error('Failed to verify PhonePe payment:', error.message);
        return res.status(503).send('Could not verify your PhonePe payment. Please refresh this page to retry verification.');
    }
});

app.get('/order/:id', isAuthenticated, requireRole('customer'), async (req, res) => {
    try {
        const order = await Order.findOne({ id: req.params.id, email: getCustomerEmail(req) });
        if (!order) {
            return res.status(404).send('Order not found.');
        }
        if (order.paymentStatus === 'Pending') {
            await syncPhonePeOrderStatus(order, req);
        }
        return res.render('customer/order-status', { order: order.toObject() });
    } catch (error) {
        console.error('Failed to load customer order:', error.message);
        return res.status(503).send('Could not load your order. Please try again.');
    }
});

app.get('/party-order', isAuthenticated, requireRole('customer'), (req, res) => {
    res.render('customer/party-order', { outlets });
});

app.post('/submit-party-order', isAuthenticated, requireRole('customer'), async (req, res) => {
    const { name, phone, guests, deliveryDate, outletId, details } = req.body;

    const orderDate = new Date(deliveryDate);
    const minNoticeDate = new Date(Date.now() + 48 * 60 * 60 * 1000);

    if (isNaN(orderDate.getTime()) || orderDate < minNoticeDate) {
        return res.status(400).send(`
            <h1>Invalid Delivery Date</h1>
            <p>Party orders require a minimum of 48 hours advance notice for catering management preparation.</p>
            <a href="/party-order">Go Back & Adjust Date</a>
        `);
    }

    const newPartyOrder = {
        id: 'PARTY-' + Math.floor(100000 + Math.random() * 900000),
        customerId: getCustomerId(req),
        email: getCustomerEmail(req),
        customerName: name,
        phone,
        guests: parseInt(guests),
        deliveryDate,
        outletId,
        details,
        status: 'Pending Manager Confirmation',
        createdAt: new Date().toLocaleString()
    };

    try {
        const savedPartyOrder = await PartyOrder.create(newPartyOrder);
        try {
            await persistCustomerProfile(req, { name, phone });
        } catch (error) {
            console.error('Failed to update customer contact details:', error.message);
        }
        partyOrders = [savedPartyOrder.toObject(), ...partyOrders];
        io.emit('party-order-submitted', savedPartyOrder.toObject());
        return res.render('customer/party-success', { partyOrder: savedPartyOrder.toObject() });
    } catch (error) {
        console.error('Failed to save party order to MongoDB:', error.message);
        return res.status(503).send('Could not save your catering request. Please try again.');
    }
});

app.get('/kitchen/:outletId', isAuthenticated, requireRole('kitchen'), async (req, res) => {
    if (req.session.user.outletId !== req.params.outletId) {
        return res.status(403).send('<h1>403 Forbidden</h1><p>Access denied.</p>');
    }
    const outlet = getOutlet(req.params.outletId);
    const outletActiveOrders = await Order.find({
        outletId: outlet.id,
        status: { $ne: 'Rider Handoff' },
        paymentStatus: { $in: ['Paid', 'Test payment approved'] }
    }).sort({ createdAtMs: -1 }).lean();
    const outletHistoryOrders = await Order.find({ outletId: outlet.id, status: 'Rider Handoff' }).sort({ createdAtMs: -1 }).lean();

    res.render('kitchen/kds', { outlet, outletActiveOrders, outletHistoryOrders });
});

app.get('/admin/dashboard', isAuthenticated, requireRole('admin'), async (req, res) => {
    const activeOrderDocuments = await fetchOrdersFromDb();
    const partyOrderDocuments = await fetchPartyOrdersFromDb();
    const paidOrders = activeOrderDocuments.filter(isOrderPaid);
    const estimatedOrders = paidOrders.filter(order => order.status !== 'Rider Handoff');
    res.render('admin/dashboard', { outlets, activeOrders: paidOrders, estimatedOrders, partyOrders: partyOrderDocuments });
});

app.post('/admin/confirm-party-order', isAuthenticated, requireRole('admin'), async (req, res) => {
    const { partyOrderId } = req.body;
    try {
        const pOrder = await PartyOrder.findOne({ id: partyOrderId });
        if (pOrder) {
            pOrder.status = 'Confirmed by Catering Manager';
            await pOrder.save();
            io.emit('party-order-updated', pOrder.toObject());
        }
    } catch (error) {
        console.error('Failed to confirm party order in MongoDB:', error.message);
        const fallback = partyOrders.find(p => p.id === partyOrderId);
        if (fallback) {
            fallback.status = 'Confirmed by Catering Manager';
            io.emit('party-order-updated', fallback);
        }
    }
    res.redirect('/admin/dashboard');
});

app.post('/admin/delete-party-order', isAuthenticated, requireRole('admin'), async (req, res) => {
    const partyOrderId = String(req.body.partyOrderId || '').trim();
    if (!partyOrderId) {
        return res.status(400).send('A party order ID is required.');
    }

    try {
        const deletedOrder = await PartyOrder.findOneAndDelete({ id: partyOrderId }).lean();
        if (!deletedOrder) {
            return res.status(404).send('Party order not found.');
        }

        partyOrders = partyOrders.filter(order => order.id !== partyOrderId);
        io.emit('party-order-deleted', { id: partyOrderId, email: deletedOrder.email });
        return res.redirect('/admin/dashboard');
    } catch (error) {
        console.error('Failed to delete party order from MongoDB:', error.message);
        return res.status(503).send('Could not delete the party order. Please try again.');
    }
});

app.post('/admin/override-estimate', isAuthenticated, requireRole('admin'), async (req, res) => {
    const { orderId, minutes } = req.body;
    const parsedMinutes = Number.parseInt(minutes, 10);
    if (!orderId || !Number.isInteger(parsedMinutes) || parsedMinutes < 10 || parsedMinutes > 240) {
        return res.status(400).send('Choose a promise time between 10 and 240 minutes.');
    }

    try {
        const order = await Order.findOne({ id: orderId });
        if (!order || !isOrderPaid(order) || order.status === 'Rider Handoff') {
            return res.status(404).send('Active paid order not found.');
        }

        const wasDelayed = order.status === 'Delayed / Manager Alert';
        const overrideMinutes = Math.max(
            parsedMinutes,
            getOutlet(order.outletId).minPrepMinutes || 15
        );
        order.promisedMinutes = overrideMinutes;
        order.promisedAt = new Date(Date.now() + overrideMinutes * 60000).toISOString();
        order.managerOverride = true;

        if (wasDelayed) {
            order.status = 'In Progress';
            order.prepStartedAt = null;
            order.alertSentAt = null;
        }

        await order.save();
        const orderObject = order.toObject();
        activeOrders = activeOrders.map(current =>
            current.id === order.id ? orderObject : current
        );
        io.emit(wasDelayed ? 'new-order-received' : 'order-updated', orderObject);
        await sendStatusNotification(orderObject, wasDelayed
            ? `The outlet manager reset preparation. Your order is back in the kitchen queue with a new promise time of ${formatPromise(order.promisedAt)}.`
            : `The outlet manager updated your promise time to ${formatPromise(order.promisedAt)}.`);
        return res.redirect('/admin/dashboard');
    } catch (error) {
        console.error('Failed to override order promise:', error.message);
        return res.status(503).send('Could not update the order promise. Please try again.');
    }
});

app.get('/admin/cms', isAuthenticated, requireRole('admin'), async (req, res) => {
    try {
        menuItems = await MenuItem.find({}).sort({ id: 1 }).lean();
        return res.render('admin/cms', { menuItems, outlets });
    } catch (error) {
        console.error('Failed to load menu CMS:', error.message);
        return res.status(503).send('Menu management is temporarily unavailable.');
    }
});

app.get('/kitchen/:outletId/history', isAuthenticated, requireRole('kitchen'), async (req, res) => {
    if (req.session.user.outletId !== req.params.outletId) {
        return res.status(403).send('<h1>403 Forbidden</h1><p>Access denied.</p>');
    }
    const outlet = getOutlet(req.params.outletId);
    const outletHistoryOrders = await Order.find({ outletId: outlet.id, status: 'Rider Handoff' }).sort({ createdAtMs: -1 }).lean();
    res.render('kitchen/history', { outlet, outletHistoryOrders });
});

app.get('/party-history', isAuthenticated, requireRole('customer'), async (req, res) => {
    let myPartyOrders;
    try {
        myPartyOrders = await PartyOrder.find({ email: getCustomerEmail(req) }).sort({ createdAt: -1 }).lean();
    } catch (error) {
        console.error('Failed to load customer party history:', error.message);
        return res.status(503).send('Could not load your party history. Please try again.');
    }
    res.render('customer/party-history', { partyOrders: myPartyOrders });
});

app.get('/order-history', isAuthenticated, requireRole('customer'), async (req, res) => {
    let myOrders;
    try {
        myOrders = await Order.find({ email: getCustomerEmail(req) }).sort({ createdAtMs: -1 }).lean();
    } catch (error) {
        console.error('Failed to load customer order history:', error.message);
        return res.status(503).send('Could not load your order history. Please try again.');
    }
    res.render('customer/order-history', { orders: myOrders });
});

io.on('connection', (socket) => {
    const user = socket.request.session && socket.request.session.user;

    socket.on('update-order-status', async ({ orderId, status } = {}) => {
        if (!user || user.role !== 'kitchen') return;
        if (!['Preparing', 'Ready for pickup', 'Rider Handoff'].includes(status)) return;

        const stateRank = { 'In Progress': 0, 'Preparing': 1, 'Ready for pickup': 2, 'Rider Handoff': 3 };

        try {
            const order = await Order.findOne({ id: orderId, outletId: user.outletId });
            if (!order || !isOrderPaid(order)) return;

            const currentRank = stateRank[order.status] ?? 0;
            const newRank = stateRank[status];
            if (newRank !== currentRank + 1) return;

            order.status = status;
            if (status === 'Preparing') order.prepStartedAt = Date.now();
            await order.save();
            const orderObject = order.toObject();
            activeOrders = activeOrders.map(current => current.id === order.id ? orderObject : current);
            await sendStatusNotification(orderObject, `Order status: ${status}.`);
            io.emit('order-updated', orderObject);
        } catch (error) {
            console.error('Failed to update order status in MongoDB:', error.message);
        }
    });

    socket.on('toggle-stock', async ({ itemId } = {}) => {
        if (!user || user.role !== 'admin') return;

        try {
            const item = await MenuItem.findOne({ id: itemId });
            if (!item) return;
            item.inStock = !item.inStock;
            await item.save();
            menuItems = await MenuItem.find({}).sort({ id: 1 }).lean();
            io.emit('menu-stock-updated', menuItems);
        } catch (error) {
            console.error('Failed to update menu stock in MongoDB:', error.message);
        }
    });
});

function startDelayedOrderMonitor() {
    setInterval(async () => {
        try {
            const dueOrders = await Order.find({
                status: { $ne: 'Rider Handoff' },
                promisedAt: { $ne: null },
                paymentStatus: { $in: ['Paid', 'Test payment approved'] }
            }).lean();
            for (const order of dueOrders) {
                const promisedAt = new Date(order.promisedAt).getTime();
                if (!Number.isFinite(promisedAt)) continue;
                if (Date.now() > promisedAt + 10 * 60 * 1000 && order.status !== 'Delayed / Manager Alert') {
                    const updatedOrder = await Order.findOneAndUpdate({ id: order.id }, {
                        $set: {
                            status: 'Delayed / Manager Alert',
                            alertSentAt: new Date().toISOString()
                        }
                    }, { new: true });

                    if (updatedOrder) {
                        const payload = updatedOrder.toObject();
                        await sendStatusNotification(payload, 'Your order is delayed. The outlet manager has been alerted.');
                        io.emit('manager-alert', payload);
                        io.emit('order-updated', payload);
                    }
                }
            }
        } catch (error) {
            console.error('Delayed order check failed:', error.message);
        }
    }, 60000);
}

const PORT = process.env.PORT || 3000;
async function startPlatform() {
    try {
        await connectMongo();
        startDelayedOrderMonitor();
        server.listen(PORT, () => {
            console.log(`Platform running with RBAC & WebSockets on port ${PORT}`);
        });
    } catch (error) {
        console.error('Platform startup failed:', error.message);
        process.exitCode = 1;
    }
}

startPlatform();