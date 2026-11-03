const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');

let outlets = [], menuItems = [];
try {
    const mock = require('./data/mockData');
    outlets = mock.outlets || [];
    menuItems = mock.menuItems || [];
} catch (e) {
    console.warn("Using fallback mock data.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Session Configuration
app.use(session({
    secret: 'company-a-secret-key-2026',
    resave: false,
    saveUninitialized: false
}));

// Global locals middleware for user sessions and defaults
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    if (req.session.user && req.session.user.role === 'customer') {
        if (!req.session.cart) req.session.cart = [];
        if (!req.session.selectedOutlet) req.session.selectedOutlet = outlets[0] ? outlets[0].id : 'kondapur';
    }
    next();
});

// Dynamic In-Memory Order Repositories
let activeOrders = [];
let partyOrders = [];

// Middleware: Authentication Guard
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

// Middleware: Role Access Control (RBAC) Guard
function requireRole(role) {
    return (req, res, next) => {
        if (req.session.user && req.session.user.role === role) return next();
        res.status(403).send(`<h1>403 Forbidden</h1><p>Access denied. Your role is not authorized to view this page.</p><a href="/login">Switch Account</a>`);
    };
}

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================
app.get('/login', (req, res) => {
    res.render('auth/login', { outlets });
});

app.post('/login', (req, res) => {
    const { role, outletId } = req.body;
    
    if (role === 'customer') {
        req.session.user = { name: 'Amit Pal (Customer)', role: 'customer' };
        req.session.cart = [];
        req.session.selectedOutlet = 'kondapur';
        return res.redirect('/select-outlet');
    } else if (role === 'kitchen') {
        const outlet = outlets.find(o => o.id === outletId) || outlets[0];
        req.session.user = { name: `Kitchen Staff (${outlet.name})`, role: 'kitchen', outletId: outlet.id };
        return res.redirect(`/kitchen/${outlet.id}`);
    } else if (role === 'admin') {
        req.session.user = { name: 'Central Operations Manager', role: 'admin' };
        return res.redirect('/admin/dashboard');
    }
    res.redirect('/login');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// ==========================================
// CUSTOMER & ORDERING ROUTES
// ==========================================
app.get('/select-outlet', isAuthenticated, requireRole('customer'), (req, res) => {
    res.render('customer/select-outlet', { outlets });
});

app.post('/select-outlet', isAuthenticated, requireRole('customer'), (req, res) => {
    const { outletId } = req.body;
    const outlet = outlets.find(o => o.id === outletId);
    if (outlet) {
        req.session.selectedOutlet = outlet.id;
    }
    res.redirect('/');
});

app.get('/', isAuthenticated, requireRole('customer'), (req, res) => {
    const currentOutlet = outlets.find(o => o.id === req.session.selectedOutlet) || outlets[0];
    res.render('customer/menu', { 
        outlets, 
        currentOutlet, 
        menuItems, 
        cartCount: (req.session.cart || []).reduce((acc, i) => acc + i.qty, 0) 
    });
});

app.post('/cart/add', isAuthenticated, requireRole('customer'), (req, res) => {
    const { itemId, qty, portion, addon } = req.body;
    const quantity = parseInt(qty) || 1;
    const item = menuItems.find(i => i.id === itemId);

    if (item && item.inStock) {
        if (!req.session.cart) req.session.cart = [];
        
        let basePrice = item.price;
        let portionLabel = portion || 'Standard';
        if (portion === 'Family Pack') basePrice += 750;
        if (portion === 'Jumbo Feast') basePrice += 1400;

        let addonCost = addon ? 60 : 0;
        let finalUnitPrice = basePrice + addonCost;

        const cartKey = `${item.id}-${portionLabel}-${addon || 'none'}`;
        const existing = req.session.cart.find(i => i.cartKey === cartKey);

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
    }
    res.redirect('/');
});

app.get('/cart/decrease/:cartKey', isAuthenticated, requireRole('customer'), (req, res) => {
    const cartKey = req.params.cartKey;
    if (req.session.cart) {
        const item = req.session.cart.find(i => i.cartKey === cartKey);
        if (item) {
            item.qty -= 1;
            if (item.qty <= 0) {
                req.session.cart = req.session.cart.filter(i => i.cartKey !== cartKey);
            }
        }
    }
    res.redirect('/cart');
});

app.get('/cart/remove/:cartKey', isAuthenticated, requireRole('customer'), (req, res) => {
    const cartKey = req.params.cartKey;
    if (req.session.cart) {
        req.session.cart = req.session.cart.filter(i => i.cartKey !== cartKey);
    }
    res.redirect('/cart');
});

app.get('/cart', isAuthenticated, requireRole('customer'), (req, res) => {
    const cart = req.session.cart || [];
    let itemTotal = cart.reduce((acc, i) => acc + (i.price * i.qty), 0);
    const currentOutlet = outlets.find(o => o.id === req.session.selectedOutlet) || outlets[0];
    res.render('customer/cart', { cart, itemTotal, currentOutlet });
});

app.post('/place-order', isAuthenticated, requireRole('customer'), (req, res) => {
    const cart = req.session.cart || [];
    if (cart.length === 0) return res.redirect('/cart');

    const itemTotal = cart.reduce((acc, i) => acc + (i.price * i.qty), 0);
    const deliveryFee = 56;
    let discount = 0;

    if (req.body.coupon === 'HYDRA100') discount += 100;
    if (req.body.redeemed === 'true') discount += 24;

    const finalTotal = Math.max(0, itemTotal + deliveryFee - discount);

    const newOrder = {
        id: 'WEB-' + Math.floor(100000 + Math.random() * 900000),
        outletId: req.session.selectedOutlet || 'kondapur',
        items: cart.map(i => ({ qty: i.qty, name: `${i.name} (${i.portion})${i.addon !== 'None' ? ' + ' + i.addon : ''}` })),
        total: finalTotal,
        payment: req.body.paymentMethod || 'UPI',
        status: 'Preparing',
        isLate: false,
        createdAt: new Date().toLocaleTimeString()
    };

    activeOrders.unshift(newOrder);
    io.emit('new-order-received', newOrder);

    req.session.cart = [];
    res.redirect(`/order/${newOrder.id}`);
});

app.get('/order/:id', isAuthenticated, requireRole('customer'), (req, res) => {
    const order = activeOrders.find(o => o.id === req.params.id) || {
        id: req.params.id,
        status: 'Preparing',
        items: []
    };
    res.render('customer/order-status', { order });
});

// Party Order / Catering Requests
app.get('/party-order', isAuthenticated, requireRole('customer'), (req, res) => {
    res.render('customer/party-order', { outlets });
});

app.post('/submit-party-order', isAuthenticated, requireRole('customer'), (req, res) => {
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
        customerName: name,
        phone,
        guests: parseInt(guests),
        deliveryDate,
        outletId,
        details,
        status: 'Pending Manager Confirmation',
        createdAt: new Date().toLocaleString()
    };

    partyOrders.unshift(newPartyOrder);
    io.emit('party-order-submitted', newPartyOrder);

    res.render('customer/party-success', { partyOrder: newPartyOrder });
});

// ==========================================
// KITCHEN TERMINAL ROUTES (KDS)
// ==========================================
app.get('/kitchen/:outletId', isAuthenticated, requireRole('kitchen'), (req, res) => {
    if (req.session.user.outletId !== req.params.outletId) {
        return res.status(403).send(`<h1>403 Forbidden</h1><p>Access denied.</p>`);
    }
    const outlet = outlets.find(o => o.id === req.params.outletId) || outlets[0];
    
    // Separate active tickets from rider handoff history log
    const outletActiveOrders = activeOrders.filter(o => o.outletId === outlet.id && o.status !== 'Rider Handoff');
    const outletHistoryOrders = activeOrders.filter(o => o.outletId === outlet.id && o.status === 'Rider Handoff');

    res.render('kitchen/kds', { outlet, outletActiveOrders, outletHistoryOrders });
});

// ==========================================
// ADMIN & MANAGER ROUTES
// ==========================================
app.get('/admin/dashboard', isAuthenticated, requireRole('admin'), (req, res) => {
    res.render('admin/dashboard', { outlets, activeOrders, partyOrders });
});

app.post('/admin/confirm-party-order', isAuthenticated, requireRole('admin'), (req, res) => {
    const { partyOrderId } = req.body;
    const pOrder = partyOrders.find(p => p.id === partyOrderId);
    if (pOrder) {
        pOrder.status = 'Confirmed by Catering Manager';
        io.emit('party-order-updated', pOrder);
    }
    res.redirect('/admin/dashboard');
});

app.get('/admin/cms', isAuthenticated, requireRole('admin'), (req, res) => {
    res.render('admin/cms', { menuItems, outlets });
});

// --- KITCHEN HISTORY ROUTE (NEW TAB) ---
app.get('/kitchen/:outletId/history', isAuthenticated, requireRole('kitchen'), (req, res) => {
    if (req.session.user.outletId !== req.params.outletId) {
        return res.status(403).send(`<h1>403 Forbidden</h1><p>Access denied.</p>`);
    }
    const outlet = outlets.find(o => o.id === req.params.outletId) || outlets[0];
    const outletHistoryOrders = activeOrders.filter(o => o.outletId === outlet.id && o.status === 'Rider Handoff');

    res.render('kitchen/history', { outlet, outletHistoryOrders });
});

// --- CUSTOMER PARTY ORDER HISTORY ROUTE ---
app.get('/party-history', isAuthenticated, requireRole('customer'), (req, res) => {
    // Filter party orders (in real production, match by user phone or ID)
    const myPartyOrders = partyOrders;
    res.render('customer/party-history', { partyOrders: myPartyOrders });
});

// --- CUSTOMER RECENT ORDERS HISTORY ROUTE ---
app.get('/order-history', isAuthenticated, requireRole('customer'), (req, res) => {
    // Retrieves active and past orders placed by the customer
    const myOrders = activeOrders;
    res.render('customer/order-history', { orders: myOrders });
});

// ==========================================
// REAL-TIME WEBSOCKET SYNCHRONIZATION
// ==========================================
io.on('connection', (socket) => {
    // Stage Transitions with Forward-Only Check
    socket.on('update-order-status', ({ orderId, status }) => {
        const order = activeOrders.find(o => o.id === orderId);
        if (order) {
            const stateRank = { 'Preparing': 1, 'Ready for pickup': 2, 'Rider Handoff': 3 };
            const currentRank = stateRank[order.status] || 1;
            const newRank = stateRank[status] || 1;

            if (newRank < currentRank) return; // Block backward transitions

            order.status = status;
            io.emit('order-updated', order);
        }
    });

    // CMS Real-time Stock Toggle
    socket.on('toggle-stock', ({ itemId }) => {
        const item = menuItems.find(i => i.id === itemId);
        if (item) {
            item.inStock = !item.inStock;
            io.emit('menu-stock-updated', menuItems);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Platform running with RBAC & WebSockets at http://localhost:${PORT}`);
});